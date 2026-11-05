import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { activateFirstRelease } from './sonuvi-first-release.mjs';
import { FreshInstallClassification, classifyFreshInstallHost, initializeFreshHostLayout, provisionFreshSystemdUnits, renderFreshSystemdUnits } from './sonuvi-fresh-install.mjs';
import { makeTreeReadOnly, verifyReleaseArtifact } from './release-artifact.mjs';

const execFile = promisify(execFileCallback);
export const TARGET_INSTALLER_VERSION = '1.0.0';
export const TARGET_PATHS = Object.freeze({ layoutRoot: '/opt/sonuvi', stateRoot: '/var/lib/sonuvi', unitRoot: '/etc/systemd/system', bootstrapReleaseRoot: '/var/lib/sonuvi-bootstrap/releases' });
export const TARGET_UNITS = Object.freeze(['sonuvi-api.service', 'sonuvi-web.service']);
export const TARGET_SERVICE_ACCOUNT = 'sonuvi';
// These are the only application-writable state locations. Nested podcast
// storage is listed explicitly rather than relying on a recursive ownership
// change, so protected siblings under the shared state root remain root-only.
export const TARGET_WRITABLE_STATE_DIRECTORIES = Object.freeze(['data', 'cache', 'logs', 'empty-library', 'empty-library/podcasts']);

function text(value) { return String(value ?? '').trim(); }
function releaseId(value) { const id = text(value); if (!/^sonuvi-[a-f0-9]{64}$/.test(id)) throw new Error('release ID is invalid'); return id; }
function identity(value) { const id = text(value); if (!/^[A-Za-z0-9_-]{16,160}$/.test(id)) throw new Error('target identity is invalid'); return id; }
// The durable installation journal accepts only the versioned bootstrap request
// identifier. Validate it before any host preflight or mutation so an invalid
// caller request cannot leave a fresh host partially provisioned.
function bootstrapAttemptId(value) { const id = text(value); if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error('bootstrap request ID is invalid'); return id; }
function serverIdentity(value) { const id = text(value); if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) throw new Error('server identity is invalid'); return id; }
function nodeCompatible(version = process.versions.node) { const [major, minor] = text(version).replace(/^v/, '').split('.').map(Number); return major > 20 || (major === 20 && minor >= 9); }
function absolute(value, label) { const result = path.resolve(text(value)); if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`); return result; }
async function availableBytes(root) {
  let candidate = root;
  while (true) {
    try { const result = await fs.statfs(candidate); return Number(result.bavail) * Number(result.bsize); } catch (error) {
      if (error?.code !== 'ENOENT' || candidate === path.dirname(candidate)) throw error;
      candidate = path.dirname(candidate);
    }
  }
}
async function exists(file) { return fs.lstat(file).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)); }

/** Fixed systemd boundary: only reviewed unit names and systemctl verbs can cross it. */
export function createFixedSystemd({
  run = (args) => execFile('/usr/bin/systemctl', args, {
    timeout: 30_000,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
  }),
} = {}) {
  const invoke = async (args) => { await run(args); };
  return Object.freeze({
    async daemonReload() { await invoke(['daemon-reload']); },
    async enableAndStart(unit) { if (!TARGET_UNITS.includes(unit)) throw new Error('unapproved_service'); await invoke(['enable', '--now', unit]); },
    async disableAndStop(unit) { if (!TARGET_UNITS.includes(unit)) throw new Error('unapproved_service'); await invoke(['disable', '--now', unit]); },
    async isHealthy(unit) { if (!TARGET_UNITS.includes(unit)) throw new Error('unapproved_service'); try { await invoke(['is-active', '--quiet', unit]); return true; } catch { return false; } },
  });
}

export function createFixedServiceAccount({ run = (file, args) => execFile(file, args, { timeout: 30_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }), lookup = async () => {
  const query = async (database) => { try { return (await run('/usr/bin/getent', [database, TARGET_SERVICE_ACCOUNT])).stdout.trim(); } catch (error) { if (error?.code === 2) return ''; throw new Error('service_account_lookup_failed'); } };
  const [passwd, group] = await Promise.all([query('passwd'), query('group')]);
  if (!passwd && !group) return null;
  if (!group) throw new Error('service_account_group_missing');
  if (!passwd) return { groupOnly: true, group: TARGET_SERVICE_ACCOUNT };
  const fields = passwd.split(':'); if (fields.length < 7) throw new Error('service_account_invalid');
  return { group: fields[3] && group.split(':')[2] === fields[3] ? TARGET_SERVICE_ACCOUNT : '', shell: fields[6] };
} } = {}) {
  return Object.freeze({ async ensure() {
    const existing = await lookup(TARGET_SERVICE_ACCOUNT);
    if (existing?.groupOnly) { await run('/usr/sbin/useradd', ['--system', '--gid', TARGET_SERVICE_ACCOUNT, '--home-dir', '/var/lib/sonuvi', '--shell', '/usr/sbin/nologin', '--no-create-home', TARGET_SERVICE_ACCOUNT]); return 'user_created'; }
    if (existing && (existing.group !== TARGET_SERVICE_ACCOUNT || existing.shell !== '/usr/sbin/nologin')) throw new Error('service_account_conflict');
    if (existing) return 'existing';
    await run('/usr/sbin/groupadd', ['--system', TARGET_SERVICE_ACCOUNT]);
    await run('/usr/sbin/useradd', ['--system', '--gid', TARGET_SERVICE_ACCOUNT, '--home-dir', '/var/lib/sonuvi', '--shell', '/usr/sbin/nologin', '--no-create-home', TARGET_SERVICE_ACCOUNT]);
    return 'created';
  }});
}

export async function provisionWritableStateOwnership({ stateRoot, run = (file, args) => execFile(file, args, { timeout: 30_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }) } = {}) {
  const root = absolute(stateRoot, 'state root');
  for (const name of TARGET_WRITABLE_STATE_DIRECTORIES) {
    const target = path.join(root, name); const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('writable_state_path_invalid');
    await run('/usr/bin/chown', ['sonuvi:sonuvi', target]); await fs.chmod(target, 0o700);
  }
}

// The service must read the initial, root-controlled configuration on first
// start. Grant group read/traverse access only; configuration remains owned by
// root and is never part of the application's writable state.
export async function provisionServiceReadableConfiguration({ stateRoot, run = (file, args) => execFile(file, args, { timeout: 30_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }) } = {}) {
  const root = absolute(stateRoot, 'state root');
  const configRoot = path.join(root, 'config');
  const configFile = path.join(configRoot, 'now-playing.config.json');
  const checkpointsRoot = path.join(root, 'checkpoints');
  const [state, directory, file, checkpoints] = await Promise.all([fs.lstat(root), fs.lstat(configRoot), fs.lstat(configFile), fs.lstat(checkpointsRoot)]);
  if (!state.isDirectory() || state.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || !checkpoints.isDirectory() || checkpoints.isSymbolicLink()) throw new Error('configuration_path_invalid');
  await run('/usr/bin/chown', ['root:sonuvi', root]);
  await run('/usr/bin/chown', ['root:sonuvi', configRoot]);
  await run('/usr/bin/chown', ['root:sonuvi', configFile]);
  await run('/usr/bin/chown', ['root:sonuvi', checkpointsRoot]);
  await fs.chmod(root, 0o710);
  await fs.chmod(configRoot, 0o750);
  await fs.chmod(configFile, 0o640);
  await fs.chmod(checkpointsRoot, 0o750);
}

export async function provisionServiceReadableActivationState({ stateRoot, run = (file, args) => execFile(file, args, { timeout: 30_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }) } = {}) {
  const root = absolute(stateRoot, 'state root');
  const activationState = path.join(root, 'checkpoints', 'release-activation-state.json');
  const stat = await fs.lstat(activationState);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('activation_state_path_invalid');
  await run('/usr/bin/chown', ['root:sonuvi', activationState]);
  await fs.chmod(activationState, 0o640);
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('installer request is invalid');
  const keys = Object.keys(request).sort(); const allowed = ['attemptId', 'releaseId', 'serverIdentity', 'targetIdentity'];
  if (keys.join(',') !== allowed.join(',')) throw new Error('installer request has unsupported fields');
  return Object.freeze({ attemptId: bootstrapAttemptId(request.attemptId), targetIdentity: identity(request.targetIdentity), releaseId: releaseId(request.releaseId), serverIdentity: serverIdentity(request.serverIdentity) });
}

/**
 * Root-only, local first-install transaction. Its request contains identities
 * only: release source, service names, paths, commands, and environment are
 * fixed by this module. It is deliberately not a network service.
 */
export async function runFixedTargetInstallation({ request, paths = TARGET_PATHS, platform = process.platform, architecture = process.arch, uid = typeof process.getuid === 'function' ? process.getuid() : null, systemd = createFixedSystemd(), serviceAccount = createFixedServiceAccount(), ownership = provisionWritableStateOwnership, configurationAccess = provisionServiceReadableConfiguration, activationStateAccess = provisionServiceReadableActivationState, verifyArtifact = verifyReleaseArtifact, health = null } = {}) {
  const input = validateRequest(request);
  if (!nodeCompatible()) throw new Error('node_runtime_unsupported');
  const roots = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, absolute(value, key)]));
  const source = path.join(roots.bootstrapReleaseRoot, input.releaseId);
  if (!await exists(source)) throw new Error('verified_release_not_staged');
  const preflight = await classifyFreshInstallHost({ layoutRoot: roots.layoutRoot, stateRoot: roots.stateRoot, platform, architecture, hasSystemd: true, uid, availableBytes: await availableBytes(path.dirname(roots.stateRoot)) });
  if (preflight.classification !== FreshInstallClassification.FRESH_ELIGIBLE) throw new Error(`fresh_host_refused:${preflight.classification}`);
  const sourceManifest = await verifyArtifact({ artifactRoot: source });
  if (sourceManifest.releaseId !== input.releaseId) throw new Error('staged_release_identity_mismatch');
  await serviceAccount.ensure();
  const initialized = await initializeFreshHostLayout({ layoutRoot: roots.layoutRoot, stateRoot: roots.stateRoot, serverIdentity: input.serverIdentity });
  await ownership({ stateRoot: roots.stateRoot });
  await configurationAccess({ stateRoot: roots.stateRoot });
  const destination = path.join(roots.layoutRoot, 'releases', input.releaseId);
  try {
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, mode: fsConstants.COPYFILE_FICLONE });
    // Candidate staging is intentionally private to the bootstrap user. The
    // installed immutable release must instead be readable and traversable by
    // the unprivileged service account before its systemd units can start.
    await makeTreeReadOnly(destination);
    await verifyArtifact({ artifactRoot: destination });
    const [apiTemplate, webTemplate] = await Promise.all([fs.readFile(path.join(destination, 'ops/systemd/sonuvi-api.service.in'), 'utf8'), fs.readFile(path.join(destination, 'ops/systemd/sonuvi-web.service.in'), 'utf8')]);
    const units = renderFreshSystemdUnits({ apiTemplate, webTemplate, releaseId: input.releaseId });
    const adapter = {
      prepare: async () => { await provisionFreshSystemdUnits({ unitRoot: roots.unitRoot, units }); await systemd.daemonReload(); },
      restart: async () => { await activationStateAccess({ stateRoot: roots.stateRoot }); for (const unit of TARGET_UNITS) await systemd.enableAndStart(unit); },
      verify: async ({ service, expectedReleaseId }) => ({ releaseId: (await systemd.isHealthy(`sonuvi-${service}.service`)) ? expectedReleaseId : null }),
      health: async ({ service }) => health ? health({ service }) : systemd.isHealthy(`sonuvi-${service}.service`),
      rollback: async () => { for (const unit of [...TARGET_UNITS].reverse()) await systemd.disableAndStop(unit); },
      makeActivationStateReadable: async () => activationStateAccess({ stateRoot: roots.stateRoot }),
    };
    const activation = await activateFirstRelease({ layoutRoot: roots.layoutRoot, stateRoot: roots.stateRoot, releaseId: input.releaseId, attemptId: input.attemptId, targetIdentity: input.targetIdentity, adapter, verifyArtifact });
    return Object.freeze({ state: 'awaiting-administrator-enrollment', releaseId: activation.releaseId, layoutRoot: initialized.layoutRoot, stateRoot: initialized.stateRoot });
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
