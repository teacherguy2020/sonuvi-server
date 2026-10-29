import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_PREFLIGHT_CONTRACT = 'sonuvi.release-runtime-preflight.v1';

function text(value) {
  return String(value ?? '').trim();
}

function parseNodeVersion(value, label) {
  const match = text(value).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`${label} is not a semantic Node version`);
  return Object.freeze({
    raw: text(value),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

function requiredAbsolutePath(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

/**
 * A release is built against a Node major, but native dependency loading is
 * still probed separately by the CLI. Patch releases of that major are allowed
 * when platform/architecture also agree; a major or ABI change fails closed.
 */
export function inspectReleaseTargetRuntime({ manifest, runtime = process } = {}) {
  const target = manifest?.target || {};
  const expectedNode = parseNodeVersion(target.nodeVersion, 'release target Node version');
  const actualNode = parseNodeVersion(runtime?.version, 'runtime Node version');
  const expectedPlatform = text(target.os || target.platform);
  const expectedArchitecture = text(target.architecture || target.arch);
  const actualPlatform = text(runtime?.platform);
  const actualArchitecture = text(runtime?.arch);
  const errors = [];
  if (!expectedPlatform || expectedPlatform !== actualPlatform) {
    errors.push(`release requires ${expectedPlatform || 'a declared platform'}, found ${actualPlatform || 'none'}`);
  }
  if (!expectedArchitecture || expectedArchitecture !== actualArchitecture) {
    errors.push(`release requires ${expectedArchitecture || 'a declared architecture'}, found ${actualArchitecture || 'none'}`);
  }
  if (expectedNode.major !== actualNode.major) {
    errors.push(`release requires Node ${expectedNode.major}.x, found ${actualNode.raw}`);
  }
  const expectedAbi = text(target.nodeModuleAbi);
  const actualAbi = text(runtime?.versions?.modules);
  if (expectedAbi && expectedAbi !== actualAbi) {
    errors.push(`release requires Node module ABI ${expectedAbi}, found ${actualAbi || 'none'}`);
  }
  const expectedNapi = text(target.napiVersion);
  const actualNapi = text(runtime?.versions?.napi);
  if (expectedNapi && expectedNapi !== actualNapi) {
    errors.push(`release requires N-API ${expectedNapi}, found ${actualNapi || 'none'}`);
  }
  return Object.freeze({
    contract: RUNTIME_PREFLIGHT_CONTRACT,
    ok: errors.length === 0,
    errors,
    expected: Object.freeze({
      platform: expectedPlatform,
      architecture: expectedArchitecture,
      nodeVersion: expectedNode.raw,
      nodeMajor: expectedNode.major,
      nodeModuleAbi: expectedAbi || null,
      napiVersion: expectedNapi || null,
    }),
    actual: Object.freeze({
      platform: actualPlatform,
      architecture: actualArchitecture,
      nodeVersion: actualNode.raw,
      nodeMajor: actualNode.major,
      nodeModuleAbi: actualAbi || null,
      napiVersion: actualNapi || null,
    }),
  });
}

export function assertReleaseTargetRuntime(options) {
  const result = inspectReleaseTargetRuntime(options);
  if (!result.ok) throw new Error(`release target runtime is incompatible: ${result.errors.join('; ')}`);
  return result;
}

export async function findExecutable(command, {
  pathValue = process.env.PATH,
  access = fs.access,
} = {}) {
  const name = text(command);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) throw new Error('executable name is invalid');
  for (const directory of text(pathValue).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

export async function inspectExternalExecutables({ manifest, find = findExecutable } = {}) {
  const required = [...new Set((manifest?.externalRuntimeDependencies?.executables || [])
    .map((entry) => text(entry))
    .filter(Boolean))].sort();
  const resolved = {};
  const missing = [];
  for (const executable of required) {
    const resolvedPath = await find(executable);
    if (resolvedPath) resolved[executable] = resolvedPath;
    else missing.push(executable);
  }
  return Object.freeze({
    contract: RUNTIME_PREFLIGHT_CONTRACT,
    ok: missing.length === 0,
    required,
    missing,
    resolved: Object.freeze(resolved),
  });
}

function localHost(value) {
  const host = text(value).toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Sonuvi on the Pi5 controls the remote moOde/MPD host. This is deliberately
 * configuration-only: deployment preflight must not issue any playback or
 * transport request merely to establish that a hostname was supplied.
 */
export function inspectRemotePlaybackTopology({ mpdHost, moodeSshHost } = {}) {
  const mpd = text(mpdHost);
  const ssh = text(moodeSshHost);
  const errors = [];
  if (!mpd) errors.push('remote MPD host is required');
  else if (localHost(mpd)) errors.push('remote MPD host must not be loopback');
  if (!ssh) errors.push('remote moOde SSH host is required');
  else if (localHost(ssh)) errors.push('remote moOde SSH host must not be loopback');
  return Object.freeze({
    contract: RUNTIME_PREFLIGHT_CONTRACT,
    ok: errors.length === 0,
    errors,
    mpdHost: mpd || null,
    moodeSshHost: ssh || null,
  });
}

async function inspectDirectory(label, value, { writable = false, access = fs.access, lstat = fs.lstat } = {}) {
  const target = requiredAbsolutePath(value, label);
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return `${label} is not a real directory`;
    await access(target, fsConstants.constants.R_OK | (writable ? fsConstants.constants.W_OK : 0));
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return `${label} is missing`;
    return `${label} is not accessible`;
  }
}

async function inspectProtectedFile({ label, filePath, maxMode = 0o640 }, { access = fs.access, lstat = fs.lstat } = {}) {
  const target = requiredAbsolutePath(filePath, label);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return `${label} is not a regular file`;
    if (((stat.mode & 0o777) & ~maxMode) !== 0) return `${label} permissions exceed ${maxMode.toString(8)}`;
    await access(target, fsConstants.constants.R_OK);
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return `${label} is missing`;
    return `${label} is not readable`;
  }
}

/**
 * Checks only metadata and access permissions. It never writes state, opens a
 * network connection, or reads credential values. The caller decides which
 * optional credential files are required for its enabled integrations.
 */
export async function inspectReleaseRuntimeState({
  stateRoot,
  configRoot,
  musicRoot = '',
  sshIdentityPath = '',
  requiredFiles = [],
  access,
  lstat,
} = {}) {
  const root = requiredAbsolutePath(stateRoot, 'SONUVI_STATE_ROOT');
  const config = configRoot
    ? requiredAbsolutePath(configRoot, 'SONUVI_CONFIG_ROOT')
    : path.join(root, 'config');
  const errors = [];
  const directoryOptions = { access, lstat };
  for (const [label, target] of [
    ['shared configuration root', config],
    ['shared data root', path.join(root, 'data')],
    ['shared cache root', path.join(root, 'cache')],
    ['shared protected root', path.join(root, 'protected')],
    ['shared logs root', path.join(root, 'logs')],
    ['shared checkpoints root', path.join(root, 'checkpoints')],
  ]) {
    const error = await inspectDirectory(label, target, { ...directoryOptions, writable: true });
    if (error) errors.push(error);
  }
  const configError = await inspectProtectedFile({
    label: 'shared runtime configuration',
    filePath: path.join(config, 'now-playing.config.json'),
    maxMode: 0o640,
  }, directoryOptions);
  if (configError) errors.push(configError);

  if (musicRoot) {
    const musicError = await inspectDirectory('music library root', musicRoot, directoryOptions);
    if (musicError) errors.push(musicError);
  }
  if (sshIdentityPath) {
    const sshError = await inspectProtectedFile({
      label: 'moOde SSH identity', filePath: sshIdentityPath, maxMode: 0o600,
    }, directoryOptions);
    if (sshError) errors.push(sshError);
  }
  for (const item of requiredFiles) {
    const required = typeof item === 'string'
      ? { label: 'required protected file', filePath: item }
      : item;
    const fileError = await inspectProtectedFile(required, directoryOptions);
    if (fileError) errors.push(fileError);
  }
  return Object.freeze({
    contract: RUNTIME_PREFLIGHT_CONTRACT,
    ok: errors.length === 0,
    errors,
    stateRoot: root,
    configRoot: config,
    musicRoot: text(musicRoot) ? path.resolve(musicRoot) : null,
  });
}
