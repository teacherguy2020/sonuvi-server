import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { verifyReleaseArtifact } from '../../src/lib/release-artifact.mjs';
import { H4C4B_RUNTIME_IMAGE } from './h4c4b-execution-adapter.mjs';
import { inspectSyntheticRehearsalState } from './h4c4a-rehearsal.mjs';

export const H4C4_ARTIFACT_BROWSE_ISOLATION_CONTRACT = 'sonuvi.h4c4.artifact-browse-isolation.v1';
export const H4C4_ARTIFACT_BROWSE_PROBE_IMAGE = H4C4B_RUNTIME_IMAGE;

const CONTAINER_PATHS = Object.freeze({
  releaseRoot: '/opt/sonuvi/release',
  stateRoot: '/var/lib/sonuvi-rehearsal',
  probeRoot: '/probe',
});

function text(value) {
  return String(value ?? '').trim();
}

function immutable(value) {
  return Object.freeze(value);
}

function absolute(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(candidate);
}

function releaseId(value, label = 'release ID') {
  const candidate = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureRealDirectory(value, label) {
  const target = absolute(value, label);
  const stat = await lstatOrNull(target);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return await fs.realpath(target);
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function snapshotTree(root) {
  const base = await ensureRealDirectory(root, 'synthetic state root');
  const entries = [];
  async function visit(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error(`synthetic state contains a symlink: ${childRelative}`);
      if (stat.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory', mode: stat.mode & 0o777 });
        await visit(child, childRelative);
      } else if (stat.isFile()) {
        entries.push({ path: childRelative, type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: await sha256File(child) });
      } else {
        throw new Error(`synthetic state contains an unsupported entry: ${childRelative}`);
      }
    }
  }
  await visit(base);
  return immutable({ root: base, entries: immutable(entries), hash: sha256(JSON.stringify(entries)) });
}

function snapshotMatches(left, right) {
  return left?.hash === right?.hash;
}

async function defaultDocker(args, { timeoutMs = 60_000 } = {}) {
  if (!Array.isArray(args) || !args.length) throw new Error('Docker arguments are required');
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const limit = 256 * 1024;
    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > limit ? next.slice(0, limit) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`artifact browse-isolation Docker probe could not start: ${error?.message || error}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(`artifact browse-isolation Docker probe failed (${signal || code}): ${String(stderr || stdout).trim()}`));
    });
  });
}

function probeProgram() {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
import { createBrowseIndexAdapter } from '${CONTAINER_PATHS.releaseRoot}/src/lib/browse-index.mjs';
import { createRuntimeCapabilities } from '${CONTAINER_PATHS.releaseRoot}/src/lib/runtime-capabilities.mjs';

const stateRoot = '${CONTAINER_PATHS.stateRoot}';
const indexPath = path.join(stateRoot, 'data', 'library-browse-index.json');
const createAdapter = (candidate) => createBrowseIndexAdapter({
  statePaths: { browseIndexPath: candidate },
  capabilities: createRuntimeCapabilities({ env: process.env }),
  rehearsalStateRoot: stateRoot,
});

const valid = await createAdapter(indexPath).getBrowseIndex('127.0.0.1');
let missingFixtureFailsClosed = false;
try {
  await createAdapter(path.join(stateRoot, 'data', 'missing-index.json')).getBrowseIndex('127.0.0.1');
} catch (error) {
  missingFixtureFailsClosed = /fixture is unavailable or invalid/.test(String(error?.message || error));
}
let forceRefreshDenied = false;
try {
  await createAdapter(indexPath).getBrowseIndex('127.0.0.1', { force: true });
} catch (error) {
  forceRefreshDenied = error?.code === 'SONUVI_REHEARSAL_DENIED' && error?.capability === 'browse-index.mpd-refresh';
}
let rebuildDenied = false;
try {
  await createAdapter(indexPath).buildBrowseIndex('127.0.0.1');
} catch (error) {
  rebuildDenied = error?.code === 'SONUVI_REHEARSAL_DENIED' && error?.capability === 'browse-index.mpd-refresh';
}
const result = {
  validFixtureAccepted: valid?.schema === 'now-playing.browse-index.v2' && Array.isArray(valid?.tracks) && valid.tracks.length > 0,
  missingFixtureFailsClosed,
  forceRefreshDenied,
  rebuildDenied,
};
await fs.writeFile('${CONTAINER_PATHS.probeRoot}/result.json', JSON.stringify(result) + '\\n', { mode: 0o600 });
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
`;
}

function mpcShim() {
  return `#!/bin/sh
printf '%s\\n' invoked >> ${CONTAINER_PATHS.probeRoot}/mpc-invocations
exit 99
`;
}

function countLines(value) {
  return String(value || '').split(/\r?\n/).filter(Boolean).length;
}

async function writeExclusiveJson(filePath, value) {
  const target = absolute(filePath, 'artifact browse-isolation evidence path');
  const parent = await ensureRealDirectory(path.dirname(target), 'artifact browse-isolation evidence parent');
  if (!contains(parent, target)) throw new Error('artifact browse-isolation evidence path escapes its parent');
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

export function createArtifactBrowseIsolationDockerArgs({
  releaseRoot,
  stateRoot,
  probeRoot,
  releaseId: expectedReleaseId,
  runtimeImage = H4C4_ARTIFACT_BROWSE_PROBE_IMAGE,
} = {}) {
  const release = absolute(releaseRoot, 'release root');
  const state = absolute(stateRoot, 'synthetic state root');
  const probe = absolute(probeRoot, 'artifact browse-isolation probe root');
  const id = releaseId(expectedReleaseId);
  if (!text(runtimeImage)) throw new Error('artifact browse-isolation runtime image is required');
  return Object.freeze([
    'run', '--rm', '--pull', 'never', '--platform', 'linux/arm64', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '192m', '--cpus', '0.25',
    '--log-driver', 'local', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=2',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--env', 'HOME=/nonexistent', '--env', 'NODE_ENV=production', '--env', 'SONUVI_EXECUTION_MODE=rehearsal',
    '--env', `SONUVI_REHEARSAL_STATE_ROOT=${CONTAINER_PATHS.stateRoot}`,
    '--env', `SONUVI_STATE_ROOT=${CONTAINER_PATHS.stateRoot}`,
    '--env', `SONUVI_CONFIG_ROOT=${CONTAINER_PATHS.stateRoot}/config`,
    '--env', 'SONUVI_SECRETS_ROOT=/run/sonuvi-empty-secrets',
    '--env', `SONUVI_RELEASE_ID=${id}`,
    '--env', `SONUVI_RELEASE_MANIFEST=${CONTAINER_PATHS.releaseRoot}/release-manifest.json`,
    '--env', `PATH=${CONTAINER_PATHS.probeRoot}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    '--mount', `type=bind,src=${release},dst=${CONTAINER_PATHS.releaseRoot},readonly`,
    '--mount', `type=bind,src=${state},dst=${CONTAINER_PATHS.stateRoot},readonly`,
    '--mount', `type=bind,src=${probe},dst=${CONTAINER_PATHS.probeRoot}`,
    '--workdir', CONTAINER_PATHS.probeRoot,
    runtimeImage, 'node', `${CONTAINER_PATHS.probeRoot}/runner.mjs`,
  ]);
}

export function assertArtifactBrowseIsolationEvidence(value, { expectedReleaseId, expectedManifestSha256 } = {}) {
  if (!value || value.contract !== H4C4_ARTIFACT_BROWSE_ISOLATION_CONTRACT) {
    throw new Error('artifact browse-isolation evidence contract is invalid');
  }
  const id = releaseId(value.releaseId);
  if (expectedReleaseId && id !== releaseId(expectedReleaseId, 'expected release ID')) {
    throw new Error('artifact browse-isolation evidence release identity is not pinned');
  }
  const manifestHash = text(value.releaseManifestSha256);
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error('artifact browse-isolation evidence manifest hash is invalid');
  if (expectedManifestSha256 && manifestHash !== text(expectedManifestSha256)) {
    throw new Error('artifact browse-isolation evidence manifest hash does not match the verified release');
  }
  if (value.network?.mode !== 'none' || value.releaseReadOnly !== true) {
    throw new Error('artifact browse-isolation evidence does not prove an isolated read-only probe');
  }
  if (value.validFixture?.accepted !== true || value.missingFixture?.failsClosed !== true || value.forceRefresh?.denied !== true || value.rebuild?.denied !== true) {
    throw new Error('artifact browse-isolation evidence does not prove fixture fail-closed behavior');
  }
  if (Number(value.mpcInvocations) !== 0 || Number(value.mpdNetworkAttempts) !== 0 || Number(value.catalogWrites) !== 0 || value.stateUnchanged !== true) {
    throw new Error('artifact browse-isolation evidence observed an external or catalog side effect');
  }
  return immutable({
    contract: value.contract,
    releaseId: id,
    releaseManifestSha256: manifestHash,
    fixtureId: text(value.fixtureId),
    network: immutable({ mode: 'none', externalEgress: false, externalDns: false }),
    releaseReadOnly: true,
    validFixture: immutable({ accepted: true }),
    missingFixture: immutable({ failsClosed: true }),
    forceRefresh: immutable({ denied: true }),
    rebuild: immutable({ denied: true }),
    mpcInvocations: 0,
    mpdNetworkAttempts: 0,
    catalogWrites: 0,
    stateUnchanged: true,
  });
}

/**
 * Imports only the artifact's browse adapter in an isolated Docker process.
 * It never starts the Sonuvi API or web entrypoints.
 */
export async function runArtifactBrowseIsolationProbe({
  releaseRoot,
  stateRoot,
  expectedReleaseId,
  scratchParent,
  evidencePath = '',
  apiPort,
  webPort,
  runtimeImage = H4C4_ARTIFACT_BROWSE_PROBE_IMAGE,
  retainProbe = false,
  verifyArtifact = verifyReleaseArtifact,
  inspectSyntheticState = inspectSyntheticRehearsalState,
  runDocker = defaultDocker,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  const release = await ensureRealDirectory(releaseRoot, 'release root');
  const state = await ensureRealDirectory(stateRoot, 'synthetic state root');
  const parent = await ensureRealDirectory(scratchParent, 'artifact browse-isolation scratch parent');
  const expected = releaseId(expectedReleaseId, 'expected release ID');
  const fixture = await inspectSyntheticState({ stateRoot: state, apiPort, webPort });
  const verified = await verifyArtifact({ artifactRoot: release });
  if (!verified || absolute(verified.root, 'verified release root') !== release || !verified.manifest) {
    throw new Error('artifact verifier did not confirm the explicit release root');
  }
  if (releaseId(verified.releaseId || verified.manifest.releaseId) !== expected) {
    throw new Error('artifact browse-isolation probe release identity does not match the explicit expected release');
  }
  const manifestPath = path.join(release, 'release-manifest.json');
  const manifestSha256 = await sha256File(manifestPath);
  const token = text(randomUUID()).replace(/[^a-z0-9-]/gi, '');
  if (!token) throw new Error('artifact browse-isolation probe token is invalid');
  const probeRoot = path.join(parent, `sonuvi-h4c4-artifact-browse-${token}`);
  if (!contains(parent, probeRoot)) throw new Error('artifact browse-isolation probe root escapes the approved scratch parent');
  if (await lstatOrNull(probeRoot)) throw new Error('artifact browse-isolation probe root already exists');

  let created = false;
  let cleanupError = null;
  try {
    await fs.mkdir(path.join(probeRoot, 'bin'), { recursive: true, mode: 0o700 });
    await fs.chmod(probeRoot, 0o700);
    await fs.chmod(path.join(probeRoot, 'bin'), 0o700);
    await fs.writeFile(path.join(probeRoot, 'bin', 'mpc'), mpcShim(), { mode: 0o700 });
    await fs.writeFile(path.join(probeRoot, 'runner.mjs'), probeProgram(), { mode: 0o600 });
    created = true;
    const before = await snapshotTree(state);
    await runDocker(createArtifactBrowseIsolationDockerArgs({
      releaseRoot: release,
      stateRoot: state,
      probeRoot,
      releaseId: expected,
      runtimeImage,
    }), { timeoutMs: 60_000 });
    const runner = JSON.parse(await fs.readFile(path.join(probeRoot, 'result.json'), 'utf8'));
    const invocations = countLines(await fs.readFile(path.join(probeRoot, 'mpc-invocations'), 'utf8').catch(() => ''));
    const after = await snapshotTree(state);
    const evidence = {
      contract: H4C4_ARTIFACT_BROWSE_ISOLATION_CONTRACT,
      releaseId: expected,
      releaseManifestSha256: manifestSha256,
      fixtureId: fixture.fixtureId,
      runtimeImage,
      createdAt: now(),
      network: { mode: 'none', externalEgress: false, externalDns: false },
      releaseReadOnly: true,
      validFixture: { accepted: runner.validFixtureAccepted === true },
      missingFixture: { failsClosed: runner.missingFixtureFailsClosed === true },
      forceRefresh: { denied: runner.forceRefreshDenied === true },
      rebuild: { denied: runner.rebuildDenied === true },
      mpcInvocations: invocations,
      // The only MPD path in this adapter is the instrumented mpc child process;
      // Docker network=none independently prevents an accidental external route.
      mpdNetworkAttempts: invocations === 0 ? 0 : invocations,
      catalogWrites: snapshotMatches(before, after) ? 0 : 1,
      stateUnchanged: snapshotMatches(before, after),
    };
    assertArtifactBrowseIsolationEvidence(evidence, { expectedReleaseId: expected, expectedManifestSha256: manifestSha256 });
    const savedEvidencePath = evidencePath ? await writeExclusiveJson(evidencePath, evidence) : null;
    return immutable({ ...evidence, evidencePath: savedEvidencePath, probeRoot: retainProbe ? probeRoot : null });
  } finally {
    if (created && !retainProbe) {
      try {
        await fs.rm(probeRoot, { recursive: true, force: false });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw new Error(`artifact browse-isolation cleanup failed for its exact probe root: ${cleanupError.message || cleanupError}`);
  }
}
