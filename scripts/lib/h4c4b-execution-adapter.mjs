import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { verifyReleaseArtifact } from '../../src/lib/release-artifact.mjs';
import {
  H4C4A_REHEARSAL_PLAN_CONTRACT,
  H4C4A_RUNTIME_IMAGE,
  assertContainerIsolationPlan,
} from './h4c4a-rehearsal.mjs';

export const H4C4B_EXECUTION_CONTRACT = 'sonuvi.h4c4b.execution-adapter.v1';
export const H4C4B_ONE_SHOT_AUTHORIZATION_CONTRACT = 'sonuvi.h4c4b.one-shot-authorization.v1';
export const H4C4B_MAX_RUNTIME_MS = 15 * 60 * 1000;
export const H4C4B_RUNTIME_IMAGE = 'node@sha256:17281e8d1dc4d671976c6b89a12f47a44c2f390b63a989e2e327631041f544fd';

const RESOURCE_LABEL = 'com.sonuvi.h4c4b.run-id';
const MANAGED_LABEL = 'com.sonuvi.h4c4b.managed';
const RELEASE_LABEL = 'com.sonuvi.h4c4b.release-id';
const EXECUTABLE_CLASSES = Object.freeze({
  startupRequired: Object.freeze(['node']),
  buildOnly: Object.freeze(['npm']),
  disabledIntegration: Object.freeze(['python3', 'mpc', 'ffmpeg', 'ffprobe', 'metaflac', 'curl', 'ssh', 'scp']),
});
const SENSITIVE_ENVIRONMENT = /(?:token|secret|credential|password|passphrase|private.?key|api.?key|track.?key|authorization|session|ssh_auth_sock)/i;
export const H4C4B_PEER_CONTAINER_SPEC = Object.freeze({
  name: 'peer',
  command: Object.freeze(['node', '--input-type=module', '-']),
  environment: Object.freeze({}),
  mounts: Object.freeze([]),
  tmpfs: Object.freeze([
    Object.freeze({ target: '/tmp', sizeBytes: 16 * 1024 * 1024, options: Object.freeze(['rw', 'noexec', 'nosuid']) }),
  ]),
  resources: Object.freeze({ cpus: 0.25, memoryBytes: 128 * 1024 * 1024, pids: 32, nofile: 256, logMaxBytes: 2 * 1024 * 1024, logFiles: 2 }),
  user: '1000:1000',
  workingDirectory: '/tmp',
  networkMode: 'share-web-network-namespace',
  openStdin: true,
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

function stableId(value, label) {
  const candidate = text(value);
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/i.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function releaseId(value, label = 'release ID') {
  const candidate = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function integerInRange(value, label, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return numeric;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function environmentObject(entries) {
  const result = {};
  for (const entry of entries || []) {
    const index = String(entry).indexOf('=');
    if (index <= 0) continue;
    result[String(entry).slice(0, index)] = String(entry).slice(index + 1);
  }
  return result;
}

function noSensitiveEnvironment(environment, { allowedNames = [] } = {}) {
  const allowed = new Set(allowedNames);
  for (const [name, value] of Object.entries(environment || {})) {
    if (SENSITIVE_ENVIRONMENT.test(name) && text(value) && !allowed.has(name)) {
      throw new Error(`execution container includes a prohibited sensitive environment variable: ${name}`);
    }
  }
}

function safeDiagnostic(value, maximum = 6000) {
  const raw = String(value ?? '')
    .replace(/((?:token|secret|credential|password|passphrase|private.?key|api.?key|track.?key|authorization|session)\s*[=:]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]');
  return raw.length > maximum ? `${raw.slice(0, maximum)}…[truncated]` : raw;
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function lstatRegular(pathname, label) {
  let stat;
  try {
    stat = await fs.lstat(pathname);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return stat;
}

async function lstatDirectory(pathname, label) {
  let stat;
  try {
    stat = await fs.lstat(pathname);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return stat;
}

async function snapshotTree(root) {
  const resolved = absolute(root, 'snapshot root');
  await lstatDirectory(resolved, 'snapshot root');
  const entries = [];
  async function visit(directory, relative = '') {
    const names = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error(`rehearsal state snapshot refuses symlink: ${childRelative}`);
      if (stat.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory', mode: stat.mode & 0o777 });
        await visit(child, childRelative);
      } else if (stat.isFile()) {
        entries.push({ path: childRelative, type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: await sha256File(child) });
      } else {
        throw new Error(`rehearsal state snapshot refuses unsupported entry: ${childRelative}`);
      }
    }
  }
  await visit(resolved);
  return immutable({ root: resolved, entries: immutable(entries) });
}

function snapshotsMatch(left, right) {
  return JSON.stringify(left?.entries || []) === JSON.stringify(right?.entries || []);
}

async function defaultDocker(args, { input = '', timeoutMs = 60_000 } = {}) {
  if (!Array.isArray(args) || !args.length) throw new Error('Docker command is required');
  const timeout = integerInRange(timeoutMs, 'Docker command timeout', 1000, H4C4B_MAX_RUNTIME_MS);
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const cap = 4 * 1024 * 1024;
    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > cap ? next.slice(0, cap) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Docker command could not start: ${safeDiagnostic(error?.message || error)}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(`Docker ${args[0]} failed (${signal || code}): ${safeDiagnostic(stderr || stdout)}`));
    });
    if (input) child.stdin.end(input);
  });
}

async function dockerJson(runDocker, args, options) {
  const result = await runDocker(args, options);
  try {
    return JSON.parse(String(result?.stdout || ''));
  } catch {
    throw new Error(`Docker ${args[0]} did not return JSON`);
  }
}

function labelsFor(execution) {
  return immutable({
    [MANAGED_LABEL]: 'true',
    [RESOURCE_LABEL]: execution.runId,
    [RELEASE_LABEL]: execution.releaseId,
  });
}

function labelArgs(labels) {
  return Object.entries(labels).flatMap(([name, value]) => ['--label', `${name}=${value}`]);
}

export function oneShotAuthorizationForRelease(value) {
  const id = releaseId(value);
  return `${H4C4B_ONE_SHOT_AUTHORIZATION_CONTRACT}:${id}`;
}

function assertOneShotAuthorization({ release, authorization }) {
  const expected = oneShotAuthorizationForRelease(release);
  if (text(authorization) !== expected) {
    throw new Error('H4C.4B execution requires the exact explicit one-shot authorization for this release');
  }
}

export function createH4c4bExecutionPlan({ rehearsalPlan, expectedReleaseId, authorization, runId, timeoutMs = H4C4B_MAX_RUNTIME_MS } = {}) {
  if (!rehearsalPlan || rehearsalPlan.contract !== H4C4A_REHEARSAL_PLAN_CONTRACT) {
    throw new Error('H4C.4B accepts only a verified H4C.4A rehearsal plan');
  }
  assertContainerIsolationPlan(rehearsalPlan);
  if (rehearsalPlan.action !== 'preflight-only' || rehearsalPlan.startAuthorized !== false) {
    throw new Error('H4C.4B requires the original fail-closed preflight plan');
  }
  if (rehearsalPlan.runtimeImage !== H4C4A_RUNTIME_IMAGE) {
    throw new Error('H4C.4B refuses an unexpected runtime image declaration');
  }
  const release = releaseId(rehearsalPlan.releaseId);
  if (release !== releaseId(expectedReleaseId, 'expected release ID') || release !== rehearsalPlan.expectedReleaseId) {
    throw new Error('H4C.4B release identity is not explicitly pinned');
  }
  assertOneShotAuthorization({ release, authorization });
  const id = stableId(runId, 'H4C.4B run ID');
  const runtimeMs = integerInRange(timeoutMs, 'H4C.4B runtime timeout', 10_000, H4C4B_MAX_RUNTIME_MS);
  const names = immutable({
    network: `sonuvi-h4c4b-${id}`,
    api: `sonuvi-h4c4b-${id}-api`,
    web: `sonuvi-h4c4b-${id}-web`,
    peer: `sonuvi-h4c4b-${id}-peer`,
  });
  return immutable({
    contract: H4C4B_EXECUTION_CONTRACT,
    action: 'execute-once',
    releaseId: release,
    expectedReleaseId: release,
    runId: id,
    timeoutMs: runtimeMs,
    runtimeImage: H4C4B_RUNTIME_IMAGE,
    preflightPlan: rehearsalPlan,
    names,
  });
}

export function assertH4c4bExecutionPlan(execution) {
  if (!execution || execution.contract !== H4C4B_EXECUTION_CONTRACT || execution.action !== 'execute-once') {
    throw new Error('H4C.4B execution plan is invalid');
  }
  const release = releaseId(execution.releaseId);
  if (release !== execution.expectedReleaseId) throw new Error('H4C.4B execution plan release ID is not pinned');
  stableId(execution.runId, 'H4C.4B run ID');
  integerInRange(execution.timeoutMs, 'H4C.4B runtime timeout', 10_000, H4C4B_MAX_RUNTIME_MS);
  if (execution.runtimeImage !== H4C4B_RUNTIME_IMAGE) throw new Error('H4C.4B runtime image is not pinned');
  const expectedNames = {
    network: `sonuvi-h4c4b-${execution.runId}`,
    api: `sonuvi-h4c4b-${execution.runId}-api`,
    web: `sonuvi-h4c4b-${execution.runId}-web`,
    peer: `sonuvi-h4c4b-${execution.runId}-peer`,
  };
  if (JSON.stringify(execution.names) !== JSON.stringify(expectedNames)) throw new Error('H4C.4B resource names are invalid');
  if (!execution.preflightPlan || execution.preflightPlan.contract !== H4C4A_REHEARSAL_PLAN_CONTRACT) {
    throw new Error('H4C.4B execution plan lacks its verified preflight plan');
  }
  assertContainerIsolationPlan(execution.preflightPlan);
  if (execution.preflightPlan.releaseId !== release || execution.preflightPlan.expectedReleaseId !== release) {
    throw new Error('H4C.4B preflight plan does not match its release identity');
  }
  return true;
}

function expectedExecutableClasses(manifest) {
  const declared = uniqueStrings(manifest?.externalRuntimeDependencies?.executables || []);
  const known = new Set(Object.values(EXECUTABLE_CLASSES).flat());
  if (!declared.length || declared.some((value) => !known.has(value))) {
    throw new Error('release declares an unexpected executable dependency that has no H4C.4B classification');
  }
  const expected = uniqueStrings(Object.values(EXECUTABLE_CLASSES).flat());
  if (declared.length !== expected.length || declared.some((value) => !expected.includes(value))) {
    throw new Error('release executable dependency declaration does not match the reviewed H4C.4B inventory');
  }
  return immutable({ declared, ...EXECUTABLE_CLASSES });
}

export async function inspectH4c4bRuntimeDependencies({ manifest, runDocker = defaultDocker } = {}) {
  const classes = expectedExecutableClasses(manifest);
  const script = `for x in ${classes.declared.join(' ')}; do if command -v "$x" >/dev/null 2>&1; then printf '%s=present\\n' "$x"; else printf '%s=absent\\n' "$x"; fi; done`;
  const result = await runDocker([
    'run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
    H4C4B_RUNTIME_IMAGE, 'sh', '-ceu', script,
  ], { timeoutMs: 60_000 });
  const availability = {};
  for (const line of String(result?.stdout || '').split(/\r?\n/)) {
    const match = line.match(/^([a-z0-9-]+)=(present|absent)$/i);
    if (match) availability[match[1]] = match[2] === 'present';
  }
  if (classes.declared.some((name) => typeof availability[name] !== 'boolean')) {
    throw new Error('runtime executable inventory is incomplete');
  }
  if (classes.startupRequired.some((name) => availability[name] !== true)) {
    throw new Error('required API startup executable is unavailable');
  }
  if (classes.disabledIntegration.some((name) => availability[name] === true)) {
    throw new Error('H4C.4B runtime image unexpectedly exposes an integration executable');
  }
  return immutable({
    image: H4C4B_RUNTIME_IMAGE,
    availability: immutable(availability),
    startupRequired: classes.startupRequired,
    buildOnly: classes.buildOnly,
    disabledIntegration: classes.disabledIntegration,
  });
}

function tmpfsArgument(entry) {
  const target = text(entry?.target);
  const size = Number(entry?.sizeBytes);
  const options = Array.isArray(entry?.options) ? entry.options.map(text).filter(Boolean) : [];
  if (!target.startsWith('/') || !Number.isInteger(size) || size <= 0 || !options.length) {
    throw new Error('rehearsal tmpfs declaration is invalid');
  }
  return `${target}:${[...options, `size=${size}`].join(',')}`;
}

function logSize(value) {
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes % (1024 * 1024) !== 0) throw new Error('rehearsal log size is invalid');
  return `${bytes / (1024 * 1024)}m`;
}

export function dockerCreateArgsForH4c4bContainer({ execution, container }) {
  assertH4c4bExecutionPlan(execution);
  const spec = container;
  if (!spec || !['api', 'web', 'peer'].includes(spec.name)) throw new Error('H4C.4B container declaration is invalid');
  const labels = labelsFor(execution);
  const peer = spec.name === 'peer';
  const networkMode = peer ? `container:${execution.names.web}` : execution.names.network;
  const args = ['create', '--name', execution.names[spec.name], ...labelArgs(labels), '--platform', 'linux/arm64', '--network', networkMode];
  if (!peer) args.push('--network-alias', spec.name);
  if (spec.openStdin === true) args.push('--interactive');
  args.push('--read-only', '--user', spec.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true');
  args.push('--pids-limit', String(spec.resources.pids), '--memory', String(spec.resources.memoryBytes), '--cpus', String(spec.resources.cpus));
  args.push('--ulimit', `nofile=${spec.resources.nofile}:${spec.resources.nofile}`);
  args.push('--log-driver', 'local', '--log-opt', `max-size=${logSize(spec.resources.logMaxBytes)}`, '--log-opt', `max-file=${spec.resources.logFiles}`);
  args.push('--workdir', spec.workingDirectory || '/opt/sonuvi/release');
  for (const mount of spec.mounts) {
    const mode = mount.readOnly ? ',readonly' : '';
    args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${mode}`);
  }
  for (const entry of spec.tmpfs) args.push('--tmpfs', tmpfsArgument(entry));
  for (const [name, value] of Object.entries(spec.environment)) args.push('--env', `${name}=${value}`);
  args.push(execution.runtimeImage, ...spec.command);
  return immutable(args);
}

export function assertH4c4bContainerInspection({ execution, container, inspection, networkTargetInspection = null }) {
  assertH4c4bExecutionPlan(execution);
  const spec = container;
  if (!spec || !['api', 'web', 'peer'].includes(spec.name)) throw new Error('H4C.4B container declaration is invalid');
  const actual = inspection || {};
  const host = actual.HostConfig || {};
  const config = actual.Config || {};
  const peer = spec.name === 'peer';
  if (text(actual.Name).replace(/^\//, '') !== execution.names[spec.name]) throw new Error('Docker container name does not match the reviewed plan');
  const expectedNetworkModes = peer
    ? new Set([`container:${execution.names.web}`, `container:${text(networkTargetInspection?.Id)}`].filter((value) => !value.endsWith(':')))
    : new Set([execution.names.network]);
  if (host.Privileged === true || host.ReadonlyRootfs !== true || !expectedNetworkModes.has(text(host.NetworkMode)) || text(host.PidMode) === 'host' || text(host.IpcMode) === 'host') {
    throw new Error('Docker container isolation settings do not match the reviewed plan');
  }
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== 'no') throw new Error('Docker container restart policy is not disabled');
  if ((host.Dns || []).length || (host.DnsSearch || []).length || (host.ExtraHosts || []).length) throw new Error('Docker container has an unapproved host or DNS override');
  if (host.PublishAllPorts === true || Object.keys(host.PortBindings || {}).length || Object.keys(config.ExposedPorts || {}).length) {
    throw new Error('Docker container has an unapproved published or exposed port');
  }
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL') || (host.CapAdd || []).length) {
    throw new Error('Docker container Linux capabilities are not restricted');
  }
  if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true')) {
    throw new Error('Docker container is missing no-new-privileges');
  }
  if (Number(host.PidsLimit) !== Number(spec.resources.pids) || Number(host.Memory) !== Number(spec.resources.memoryBytes) || Number(host.NanoCpus) !== Math.round(Number(spec.resources.cpus) * 1_000_000_000)) {
    throw new Error('Docker container resource limits do not match the reviewed plan');
  }
  if (text(host.LogConfig?.Type) !== 'local' || text(host.LogConfig?.Config?.['max-size']) !== logSize(spec.resources.logMaxBytes) || text(host.LogConfig?.Config?.['max-file']) !== String(spec.resources.logFiles)) {
    throw new Error('Docker container log limits do not match the reviewed plan');
  }
  if (text(config.User) !== spec.user || text(config.WorkingDir) !== (spec.workingDirectory || '/opt/sonuvi/release') || text(config.Image) !== execution.runtimeImage) {
    throw new Error('Docker container runtime identity does not match the reviewed plan');
  }
  if (JSON.stringify(config.Cmd || []) !== JSON.stringify(spec.command || [])) throw new Error('Docker container entrypoint command does not match the reviewed plan');
  if (Boolean(config.OpenStdin) !== Boolean(spec.openStdin)) throw new Error('Docker container stdin policy does not match the reviewed plan');
  const labels = labelsFor(execution);
  for (const [name, value] of Object.entries(labels)) {
    if (actual.Config?.Labels?.[name] !== value) throw new Error('Docker container ownership labels are invalid');
  }
  const actualEnvironment = environmentObject(config.Env);
  for (const [name, value] of Object.entries(spec.environment)) {
    if (actualEnvironment[name] !== value) throw new Error(`Docker container environment differs for ${name}`);
  }
  noSensitiveEnvironment(actualEnvironment, { allowedNames: Object.keys(spec.environment) });
  if (Object.keys(actualEnvironment).some((name) => /^(FFMPEG|CURL|SSH_AUTH_SOCK|GIT_SSH_COMMAND)$/i.test(name))) {
    throw new Error('Docker container includes an unapproved executable or SSH fallback environment override');
  }
  const bindMounts = (actual.Mounts || []).filter((entry) => entry.Type === 'bind');
  if (bindMounts.length !== spec.mounts.length) throw new Error('Docker container bind-mount inventory is invalid');
  for (const expected of spec.mounts) {
    const found = bindMounts.find((entry) => path.resolve(entry.Source || '') === path.resolve(expected.source) && entry.Destination === expected.target);
    if (!found || Boolean(found.RW) === Boolean(expected.readOnly)) throw new Error('Docker container mount mode does not match the reviewed plan');
    if (/docker\.sock$/i.test(String(found.Source || '')) || /^\/(?:Users|home)\//.test(String(found.Source || ''))) {
      throw new Error('Docker container includes a prohibited host or Docker-socket mount');
    }
  }
  const tmpfs = host.Tmpfs || {};
  const expectedTmpfs = spec.tmpfs.map((entry) => entry.target).sort();
  if (JSON.stringify(Object.keys(tmpfs).sort()) !== JSON.stringify(expectedTmpfs)) throw new Error('Docker container tmpfs inventory is invalid');
  return true;
}

export function assertH4c4bNetworkInspection({ execution, inspection }) {
  assertH4c4bExecutionPlan(execution);
  const network = inspection || {};
  if (text(network.Name) !== execution.names.network || network.Driver !== 'bridge' || network.Internal !== true || network.EnableIPv6 === true) {
    throw new Error('Docker network isolation does not match the reviewed plan');
  }
  const labels = labelsFor(execution);
  for (const [name, value] of Object.entries(labels)) {
    if (network.Labels?.[name] !== value) throw new Error('Docker network ownership labels are invalid');
  }
  return true;
}

async function validateArtifactForExecution(execution, verifyArtifact) {
  const plan = execution.preflightPlan;
  const artifact = await verifyArtifact({ artifactRoot: plan.releaseRoot });
  if (!artifact || path.resolve(artifact.root || '') !== path.resolve(plan.releaseRoot) || artifact.releaseId !== execution.releaseId) {
    throw new Error('execution adapter could not independently verify the exact release artifact');
  }
  const manifest = artifact.manifest || {};
  if (manifest?.source?.dirty !== false || manifest?.source?.snapshotStatus !== 'clean-git-worktree-snapshot' || manifest?.target?.os !== 'linux' || manifest?.target?.architecture !== 'arm64') {
    throw new Error('execution adapter rejects a dirty or non-Linux-ARM64 release artifact');
  }
  await lstatRegular(path.join(plan.releaseRoot, 'release-manifest.json'), 'release manifest');
  return immutable({ artifact, manifestSha256: await sha256File(path.join(plan.releaseRoot, 'release-manifest.json')) });
}

async function createOneShotRecord({ evidencePath, execution, artifact }) {
  const target = absolute(evidencePath, 'H4C.4B one-shot evidence path');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const record = {
    contract: H4C4B_ONE_SHOT_AUTHORIZATION_CONTRACT,
    status: 'reserved-before-startup',
    runId: execution.runId,
    releaseId: execution.releaseId,
    releaseManifestSha256: artifact.manifestSha256,
    createdAt: new Date().toISOString(),
    result: null,
  };
  try {
    await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('H4C.4B one-shot evidence already exists; a second execution is refused');
    throw error;
  }
  return immutable({ path: target, record });
}

async function updateOneShotRecord(record, body) {
  await fs.writeFile(record.path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(record.path, 0o600);
}

function peerProgram({ releaseId: expectedReleaseId, apiPort, webPort }) {
  const expected = JSON.stringify({ releaseId: expectedReleaseId, apiPort, webPort });
  return `
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';

const expected = ${expected};
const sensitive = /(?:token|secret|credential|password|passphrase|private.?key|api.?key|track.?key|authorization|session)/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { throw new Error(message); };
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch {}
    return { status: response.status, json, raw };
  } finally { clearTimeout(timer); }
}
async function waitFor(url, label) {
  let last = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await request(url);
      if (result.status === 200) return result;
      last = result;
    } catch (error) { last = { error: error?.message || String(error) }; }
    await wait(500);
  }
  fail(label + ' did not become ready: ' + JSON.stringify(last));
}
function assertNoSensitiveKeys(value, path = '') {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoSensitiveKeys(entry, path + '[' + index + ']'));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const name = path ? path + '.' + key : key;
    if (sensitive.test(key)) fail('public response exposed a sensitive-looking key: ' + name);
    assertNoSensitiveKeys(child, name);
  }
}
const apiBase = 'http://api:' + expected.apiPort;
const webBase = 'http://127.0.0.1:' + expected.webPort;
const apiHealth = await waitFor(apiBase + '/health', 'API');
const webRelease = await waitFor(webBase + '/release.json', 'web');
if (apiHealth.json?.release?.releaseId !== expected.releaseId) fail('API release identity mismatch');
if (webRelease.json?.releaseId !== expected.releaseId) fail('web release identity mismatch');
const mainPage = await request(webBase + '/');
if (mainPage.status !== 200 || !/html/i.test(mainPage.raw)) fail('web main page is unavailable');
const manifest = await request(webBase + '/manifest.webmanifest');
if (manifest.status !== 200 || !manifest.json) fail('PWA manifest is unavailable');
const privateData = await request(webBase + '/data/library-browse-index.json');
if (![403, 404].includes(privateData.status)) fail('web exposed non-public runtime state');
const serviceWorker = await request(webBase + '/service-worker.js');
if (![403, 404].includes(serviceWorker.status)) fail('unexpected service-worker asset was exposed by the immutable public root');
const profile = await request(apiBase + '/config/controller-profile');
if (profile.status !== 200 || profile.json?.ok !== true || !profile.json?.profile) fail('public controller configuration is unavailable');
assertNoSensitiveKeys(profile.json);
const protectedBrowse = await request(apiBase + '/config/browse/stats');
if (protectedBrowse.status !== 503) fail('protected configuration did not fail closed without a Track Key');
const albums = await request(apiBase + '/recent/albums?limit=5');
if (albums.status !== 200 || albums.json?.ok !== true || !Array.isArray(albums.json?.items)) fail('synthetic catalog response is unavailable');
const syntheticAlbum = albums.json.items.find((item) => item?.artist === 'Synthetic Ensemble' && item?.album === 'Fixture Album' && String(item?.file || '').startsWith('Synthetic/'));
if (!syntheticAlbum) fail('API did not serve the synthetic browse-index album/artist/track reference');
const mutations = {};
for (const pathname of ['/mpd/start-song', '/v1/mobile/qobuz-connect/play', '/upnp/media-servers/synthetic/play', '/config/lastfm/authorize/start', '/config/moode/browser-url', '/v1/mobile/alexa/actions', '/v1/mobile/queue/actions', '/ws']) {
  const result = await request(apiBase + pathname, { method: 'POST', body: '{}' });
  if (result.status !== 503 || result.json?.code !== 'SONUVI_REHEARSAL_READ_ONLY') fail('rehearsal mutation was not denied for ' + pathname);
  mutations[pathname] = result.status;
}
const routes = String(await fs.readFile('/proc/net/route', 'utf8'));
const defaultRoute = routes.split(/\\r?\\n/).some((line) => { const fields = line.trim().split(/\\s+/); return fields[1] === '00000000'; });
if (defaultRoute) fail('peer network namespace has an external default route');
const dnsResults = {};
for (const hostname of ['example.invalid', 'sonuvi.local']) {
  try { await dns.lookup(hostname); dnsResults[hostname] = 'resolved'; } catch { dnsResults[hostname] = 'blocked'; }
  if (dnsResults[hostname] !== 'blocked') fail('external or production-style DNS name unexpectedly resolved: ' + hostname);
}
process.stdout.write(JSON.stringify({
  contract: 'sonuvi.h4c4b.peer-acceptance.v1',
  releaseId: expected.releaseId,
  apiHealth: apiHealth.status,
  webRelease: webRelease.status,
  syntheticCatalog: { artist: syntheticAlbum.artist, album: syntheticAlbum.album, trackReference: syntheticAlbum.file, source: albums.json.source || null },
  publicConfiguration: profile.status,
  protectedConfiguration: protectedBrowse.status,
  pwaManifest: manifest.status,
  serviceWorker: { status: serviceWorker.status, required: false, expectedAbsent: true },
  privateState: privateData.status,
  mutations,
  dnsResults,
  defaultRoute: false,
}) + '\\n');
`;
}

function parsePeerEvidence(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (parsed?.contract !== 'sonuvi.h4c4b.peer-acceptance.v1') throw new Error('contract mismatch');
    return immutable(parsed);
  } catch {
    throw new Error('synthetic acceptance peer did not return valid evidence');
  }
}

async function collectContainerFacts({ runDocker, execution, names, timeoutMs }) {
  const inspections = {};
  for (const [kind, name] of Object.entries(names)) {
    if (!name) continue;
    const response = await dockerJson(runDocker, ['inspect', name], { timeoutMs });
    inspections[kind] = Array.isArray(response) ? response[0] : response;
  }
  return inspections;
}

async function cleanupOwnedResources({ runDocker, execution, created }) {
  const errors = [];
  const stopped = [];
  const verifiedStopped = [];
  const run = async (args) => {
    try { await runDocker(args, { timeoutMs: 30_000 }); } catch (error) { errors.push(safeDiagnostic(error?.message || error)); }
  };
  for (const name of [execution.names.web, execution.names.api]) {
    if (!created.has(name)) continue;
    try {
      await runDocker(['stop', '--time', '10', name], { timeoutMs: 30_000 });
      stopped.push(name);
      const inspected = await dockerJson(runDocker, ['inspect', name], { timeoutMs: 30_000 });
      const state = Array.isArray(inspected) ? inspected[0]?.State : inspected?.State;
      if (state?.Running === false) verifiedStopped.push(name);
      else errors.push(`candidate container did not stop cleanly: ${name}`);
    } catch (error) {
      errors.push(safeDiagnostic(error?.message || error));
    }
  }
  if (created.has(execution.names.peer)) {
    try {
      const inspected = await dockerJson(runDocker, ['inspect', execution.names.peer], { timeoutMs: 30_000 });
      const state = Array.isArray(inspected) ? inspected[0]?.State : inspected?.State;
      if (state?.Running) {
        await runDocker(['stop', '--time', '10', execution.names.peer], { timeoutMs: 30_000 });
        stopped.push(execution.names.peer);
      }
      verifiedStopped.push(execution.names.peer);
    } catch (error) {
      errors.push(safeDiagnostic(error?.message || error));
    }
  }
  for (const name of [execution.names.peer, execution.names.web, execution.names.api]) {
    if (created.has(name)) await run(['rm', '-f', name]);
  }
  if (created.has(execution.names.network)) await run(['network', 'rm', execution.names.network]);
  return immutable({
    stopped: immutable(stopped),
    verifiedStopped: immutable(verifiedStopped),
    removed: immutable([...created]),
    errors: immutable(errors),
  });
}

async function containerLogs(runDocker, name) {
  try {
    const result = await runDocker(['logs', '--tail', '200', name], { timeoutMs: 30_000 });
    return safeDiagnostic(`${result?.stdout || ''}${result?.stderr || ''}`);
  } catch (error) {
    return safeDiagnostic(error?.message || error);
  }
}

async function containerStats(runDocker, names) {
  try {
    const result = await runDocker(['stats', '--no-stream', '--format', '{{json .}}', ...names], { timeoutMs: 30_000 });
    return immutable(String(result?.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: safeDiagnostic(line, 500) }; }
    }));
  } catch (error) {
    return immutable([{ error: safeDiagnostic(error?.message || error, 500) }]);
  }
}

export async function executeH4c4bRehearsal({
  execution,
  authorization,
  evidencePath,
  runDocker = defaultDocker,
  verifyArtifact = verifyReleaseArtifact,
} = {}) {
  assertH4c4bExecutionPlan(execution);
  assertOneShotAuthorization({ release: execution.releaseId, authorization });
  const startedAt = Date.now();
  const deadline = startedAt + execution.timeoutMs;
  const remaining = (maximum = 60_000) => {
    const value = Math.min(maximum, deadline - Date.now());
    if (value < 1000) throw new Error('H4C.4B rehearsal exceeded its bounded execution window');
    return value;
  };
  const artifact = await validateArtifactForExecution(execution, verifyArtifact);
  const dependencies = await inspectH4c4bRuntimeDependencies({ manifest: artifact.artifact.manifest, runDocker });
  const stateBefore = await snapshotTree(execution.preflightPlan.stateRoot);
  let record = null;
  const created = new Set();
  const evidence = {
    contract: H4C4B_EXECUTION_CONTRACT,
    releaseId: execution.releaseId,
    runId: execution.runId,
    startedAt: new Date(startedAt).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    artifact: { manifestSha256: artifact.manifestSha256, source: artifact.artifact.manifest?.source || {}, target: artifact.artifact.manifest?.target || {} },
    dependencies,
    status: 'failed',
    peer: null,
    startup: null,
    logs: {},
    cleanup: null,
    releaseIntegrity: null,
    state: null,
    error: null,
    limitations: [],
  };
  try {
    const labels = labelsFor(execution);
    await runDocker(['network', 'create', '--driver', 'bridge', '--internal', ...labelArgs(labels), execution.names.network], { timeoutMs: remaining() });
    created.add(execution.names.network);
    const networkInspection = await dockerJson(runDocker, ['network', 'inspect', execution.names.network], { timeoutMs: remaining() });
    assertH4c4bNetworkInspection({ execution, inspection: Array.isArray(networkInspection) ? networkInspection[0] : networkInspection });

    const specs = Object.fromEntries(execution.preflightPlan.containers.map((container) => [container.name, container]));
    for (const kind of ['api', 'web']) {
      await runDocker(dockerCreateArgsForH4c4bContainer({ execution, container: specs[kind] }), { timeoutMs: remaining() });
      created.add(execution.names[kind]);
    }
    await runDocker(dockerCreateArgsForH4c4bContainer({ execution, container: H4C4B_PEER_CONTAINER_SPEC }), { timeoutMs: remaining() });
    created.add(execution.names.peer);
    const createdInspections = await collectContainerFacts({
      runDocker,
      execution,
      names: { api: execution.names.api, web: execution.names.web, peer: execution.names.peer },
      timeoutMs: remaining(),
    });
    assertH4c4bContainerInspection({ execution, container: specs.api, inspection: createdInspections.api });
    assertH4c4bContainerInspection({ execution, container: specs.web, inspection: createdInspections.web });
    assertH4c4bContainerInspection({ execution, container: H4C4B_PEER_CONTAINER_SPEC, inspection: createdInspections.peer, networkTargetInspection: createdInspections.web });

    // The record is deliberately created only after every non-start preflight
    // succeeds. A rejected Docker configuration must not consume this one
    // authorized candidate start, while the record still exists before any
    // Sonuvi process can run.
    record = await createOneShotRecord({ evidencePath, execution, artifact });
    await runDocker(['start', execution.names.api], { timeoutMs: remaining() });
    await runDocker(['start', execution.names.web], { timeoutMs: remaining() });
    const running = await collectContainerFacts({
      runDocker,
      execution,
      names: { api: execution.names.api, web: execution.names.web },
      timeoutMs: remaining(),
    });
    if (!running.api?.State?.Running || !running.web?.State?.Running) throw new Error('candidate API or web process did not remain running after startup');
    evidence.startup = {
      api: { startedAt: running.api?.State?.StartedAt || null, pid: running.api?.State?.Pid || null },
      web: { startedAt: running.web?.State?.StartedAt || null, pid: running.web?.State?.Pid || null },
      stats: await containerStats(runDocker, [execution.names.api, execution.names.web]),
    };

    const peerResult = await runDocker(['start', '--attach', '--interactive', execution.names.peer], {
      input: peerProgram({ releaseId: execution.releaseId, apiPort: execution.preflightPlan.ports.api, webPort: execution.preflightPlan.ports.web }),
      timeoutMs: remaining(Math.min(90_000, execution.timeoutMs)),
    });
    evidence.peer = parsePeerEvidence(peerResult.stdout);
    evidence.logs.api = await containerLogs(runDocker, execution.names.api);
    evidence.logs.web = await containerLogs(runDocker, execution.names.web);
    evidence.status = 'passed';
  } catch (error) {
    evidence.error = safeDiagnostic(error?.message || error);
    evidence.logs.api = evidence.logs.api || await containerLogs(runDocker, execution.names.api);
    evidence.logs.web = evidence.logs.web || await containerLogs(runDocker, execution.names.web);
  } finally {
    evidence.cleanup = await cleanupOwnedResources({ runDocker, execution, created });
    try {
      const after = await validateArtifactForExecution(execution, verifyArtifact);
      evidence.releaseIntegrity = { unchanged: after.manifestSha256 === artifact.manifestSha256, manifestSha256: after.manifestSha256 };
    } catch (error) {
      evidence.releaseIntegrity = { unchanged: false, error: safeDiagnostic(error?.message || error) };
    }
    try {
      const stateAfter = await snapshotTree(execution.preflightPlan.stateRoot);
      evidence.state = { unchanged: snapshotsMatch(stateBefore, stateAfter), beforeEntries: stateBefore.entries.length, afterEntries: stateAfter.entries.length };
    } catch (error) {
      evidence.state = { unchanged: false, error: safeDiagnostic(error?.message || error) };
    }
    if (evidence.status === 'passed' && (!evidence.releaseIntegrity?.unchanged || !evidence.state?.unchanged || evidence.cleanup.errors.length)) {
      evidence.status = 'failed';
      evidence.error = evidence.error || 'post-run integrity or cleanup verification failed';
    }
    if (evidence.status === 'passed-with-specific-limitations' && (!evidence.releaseIntegrity?.unchanged || !evidence.state?.unchanged || evidence.cleanup.errors.length)) {
      evidence.status = 'failed';
      evidence.error = evidence.error || 'post-run integrity or cleanup verification failed';
    }
    evidence.finishedAt = new Date().toISOString();
    if (record) {
      await updateOneShotRecord(record, {
        ...record.record,
        status: evidence.status,
        finishedAt: evidence.finishedAt,
        result: evidence,
      });
    }
  }
  return immutable({ ...evidence, evidencePath: record?.path || null });
}
