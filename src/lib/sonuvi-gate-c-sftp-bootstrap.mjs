import path from 'node:path';

export const GATE_C_SFTP_BOOTSTRAP_CONTRACT = 'sonuvi.gate-c-sftp-bootstrap.v1';
export const GATE_C_SFTP_BOOTSTRAP_MAX_BYTES = 16 * 1024 * 1024;
export const GATE_C_SFTP_STAGING_RELATIVE_DIRECTORY = '.local/share/sonuvi-bootstrap-v1';
export const GATE_C_SFTP_BOOTSTRAP_PARTIAL_NAME = 'sonuvi-bootstrap-kit-v1.tar.partial';
export const GATE_C_SFTP_BOOTSTRAP_FINAL_NAME = 'sonuvi-bootstrap-kit-v1.tar';
export const GATE_C_SFTP_BOOTSTRAP_ACTIVATOR = 'sonuvi_sftp_bootstrap_activate_v1';
export const GATE_C_SFTP_BOOTSTRAP_ACTIVATOR_SHA256 = '5a12aeea3a5ae0dda1fbc8ceb599ee27e0da93055603effff5fd7b559a50f3df';

const STAGING_SEGMENTS = Object.freeze(GATE_C_SFTP_STAGING_RELATIVE_DIRECTORY.split('/'));

function text(value) {
  return String(value ?? '').trim();
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unsupported fields`);
}

function sha256(value, label) {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function byteCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > GATE_C_SFTP_BOOTSTRAP_MAX_BYTES) {
    throw new Error('bootstrap kit byte count is invalid');
  }
  return value;
}

/**
 * The path returned by SFTP REALPATH(".") is the only account location the
 * client may use. User names, home directories, and caller-provided paths are
 * never interpolated into the staging operation.
 */
export function normalizeGateCSftpHomeDirectory(value) {
  const home = text(value);
  if (!home || home.includes('\0') || home.includes('\\') || !home.startsWith('/')) {
    throw new Error('SFTP home directory is invalid');
  }
  if (home === '/' || path.posix.normalize(home) !== home || home.includes('//') || home.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('SFTP home directory is not canonical');
  }
  return home;
}

function joined(home, name = '') {
  return name ? path.posix.join(home, ...STAGING_SEGMENTS, name) : path.posix.join(home, ...STAGING_SEGMENTS);
}

/**
 * Produce the only two artifact paths the native transport may ever pass to
 * SFTP. All recovery restarts from zero: there is no offset/resume protocol.
 */
export function normalizeGateCSftpBootstrapTransfer(input = {}) {
  sameKeys(input, ['bytes', 'contract', 'homeDirectory', 'sha256'], 'SFTP bootstrap transfer');
  if (input.contract !== GATE_C_SFTP_BOOTSTRAP_CONTRACT) throw new Error('SFTP bootstrap contract is unsupported');
  const homeDirectory = normalizeGateCSftpHomeDirectory(input.homeDirectory);
  const bytes = byteCount(input.bytes);
  const digest = sha256(input.sha256, 'bootstrap kit digest');
  return Object.freeze({
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT,
    homeDirectory,
    directory: joined(homeDirectory),
    partialPath: joined(homeDirectory, GATE_C_SFTP_BOOTSTRAP_PARTIAL_NAME),
    finalPath: joined(homeDirectory, GATE_C_SFTP_BOOTSTRAP_FINAL_NAME),
    bytes,
    sha256: digest,
  });
}

function mode(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) throw new Error(`${label} is invalid`);
  return value;
}

function uid(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('SFTP owner UID is invalid');
  return value;
}

function directories(plan) {
  const values = [];
  let current = plan.homeDirectory;
  for (const segment of STAGING_SEGMENTS) {
    current = path.posix.join(current, segment);
    values.push(current);
  }
  return values;
}

/**
 * Validate normalized SFTP LSTAT attributes. The native client maps protocol
 * ATTRS into this small model and rejects a missing type, owner, or mode.
 */
export function assertGateCSftpBootstrapEntry({ plan, expectedUID, path: candidate, kind, mode: permission, uid: ownerUID, bytes = null } = {}) {
  const normalized = normalizeGateCSftpBootstrapTransfer({
    contract: plan?.contract,
    homeDirectory: plan?.homeDirectory,
    bytes: plan?.bytes,
    sha256: plan?.sha256,
  });
  const file = text(candidate);
  const isDirectory = directories(normalized).includes(file);
  const isFinal = file === normalized.finalPath;
  const isPartial = file === normalized.partialPath;
  if (!isDirectory && !isFinal && !isPartial) throw new Error('SFTP path is not allowlisted');
  if (text(kind) === 'symlink') throw new Error('SFTP symlinks are not permitted');
  const expectedOwner = uid(expectedUID);
  const observedOwner = uid(ownerUID);
  if (observedOwner !== expectedOwner) throw new Error('SFTP staging owner does not match authenticated account');
  if (isDirectory) {
    if (text(kind) !== 'directory' || mode(permission, 'SFTP directory mode') !== 0o700) throw new Error('SFTP staging directory is invalid');
    return Object.freeze({ path: file, kind: 'directory', mode: 0o700, uid: observedOwner, bytes: null });
  }
  if (text(kind) !== 'regular' || mode(permission, 'SFTP file mode') !== 0o600) throw new Error('SFTP bootstrap file is invalid');
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > normalized.bytes) throw new Error('SFTP bootstrap file size is invalid');
  if (isFinal && bytes !== normalized.bytes) throw new Error('SFTP bootstrap final size does not match expected bytes');
  return Object.freeze({ path: file, kind: 'regular', mode: 0o600, uid: observedOwner, bytes });
}

/**
 * This is the sole privileged command template. The two interpolated values
 * have already passed strict digest/size validation; no remote path, package,
 * URL, service, or shell fragment is caller-controlled.
 */
export function gateCSftpBootstrapActivationCommand({ sha256: digest, bytes } = {}, { requiresPassword = false } = {}) {
  const transfer = normalizeGateCSftpBootstrapTransfer({
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT,
    homeDirectory: '/home/bootstrap-contract-only',
    sha256: digest,
    bytes,
  });
  const sudo = requiresPassword ? "/usr/bin/sudo -S -k -p ''" : '/usr/bin/sudo -n';
  return `${sudo} /bin/sh -s -- ${transfer.sha256} ${transfer.bytes}`;
}
