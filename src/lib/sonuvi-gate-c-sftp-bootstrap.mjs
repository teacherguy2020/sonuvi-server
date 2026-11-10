import path from 'node:path';

import { gateCBootstrapKitReplacementCommand } from './sonuvi-gate-c-bootstrap-replacement-contract.mjs';

export const GATE_C_SFTP_BOOTSTRAP_CONTRACT = 'sonuvi.gate-c-sftp-bootstrap.v1';
export const GATE_C_SFTP_BOOTSTRAP_MAX_BYTES = 16 * 1024 * 1024;
export const GATE_C_SFTP_STAGING_RELATIVE_DIRECTORY = '.local/share/sonuvi-bootstrap-v1';
export const GATE_C_SFTP_BOOTSTRAP_PARTIAL_NAME = 'sonuvi-bootstrap-kit-v1.tar.partial';
export const GATE_C_SFTP_BOOTSTRAP_FINAL_NAME = 'sonuvi-bootstrap-kit-v1.tar';
export const GATE_C_SFTP_BOOTSTRAP_ACTIVATOR = 'sonuvi_sftp_bootstrap_activate_v1';
export const GATE_C_SFTP_BOOTSTRAP_ACTIVATOR_SHA256 = '42d68708c61c9d451a0e4285be2217c2f8f6ec2ef3518f308f154c5175de7a7a';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_CONTRACT = 'sonuvi.gate-c-sftp-bootstrap.v2';
export const GATE_C_SFTP_UPGRADE_STAGING_RELATIVE_DIRECTORY = '.local/share/sonuvi-bootstrap-v2';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_FILE_PREFIX = 'sonuvi-bootstrap-kit-v2-';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_PARTIAL_SUFFIX = '.tar.partial';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_FINAL_SUFFIX = '.tar';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_ACTIVATOR = 'sonuvi_bootstrap_kit_replacement_v1';
export const GATE_C_SFTP_UPGRADE_BOOTSTRAP_ACTIVATOR_SHA256 = '6535738585f8f14c4f0c8b43ee927c6a7195041c881ced9b5470693140bad88d';

const STAGING_SEGMENTS = Object.freeze(GATE_C_SFTP_STAGING_RELATIVE_DIRECTORY.split('/'));
const UPGRADE_STAGING_SEGMENTS = Object.freeze(GATE_C_SFTP_UPGRADE_STAGING_RELATIVE_DIRECTORY.split('/'));

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

function joined(home, segments, name = '') {
  return name ? path.posix.join(home, ...segments, name) : path.posix.join(home, ...segments);
}

function normalizeTransfer(input, { contract, segments, partialName, finalName, label }) {
  sameKeys(input, ['bytes', 'contract', 'homeDirectory', 'sha256'], label);
  if (input.contract !== contract) throw new Error(`${label} contract is unsupported`);
  const homeDirectory = normalizeGateCSftpHomeDirectory(input.homeDirectory);
  const bytes = byteCount(input.bytes);
  const digest = sha256(input.sha256, 'bootstrap kit digest');
  const resolvedPartialName = typeof partialName === 'function' ? partialName(digest) : partialName;
  const resolvedFinalName = typeof finalName === 'function' ? finalName(digest) : finalName;
  return Object.freeze({
    contract,
    homeDirectory,
    directory: joined(homeDirectory, segments),
    partialPath: joined(homeDirectory, segments, resolvedPartialName),
    finalPath: joined(homeDirectory, segments, resolvedFinalName),
    bytes,
    sha256: digest,
  });
}

/**
 * Produce the only two artifact paths the native transport may ever pass to
 * SFTP. All recovery restarts from zero: there is no offset/resume protocol.
 */
export function normalizeGateCSftpBootstrapTransfer(input = {}) {
  return normalizeTransfer(input, {
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT,
    segments: STAGING_SEGMENTS,
    partialName: GATE_C_SFTP_BOOTSTRAP_PARTIAL_NAME,
    finalName: GATE_C_SFTP_BOOTSTRAP_FINAL_NAME,
    label: 'SFTP bootstrap transfer',
  });
}

export function normalizeGateCSftpUpgradeBootstrapTransfer(input = {}) {
  return normalizeTransfer(input, {
    contract: GATE_C_SFTP_UPGRADE_BOOTSTRAP_CONTRACT,
    segments: UPGRADE_STAGING_SEGMENTS,
    partialName: (digest) => `${GATE_C_SFTP_UPGRADE_BOOTSTRAP_FILE_PREFIX}${digest}${GATE_C_SFTP_UPGRADE_BOOTSTRAP_PARTIAL_SUFFIX}`,
    finalName: (digest) => `${GATE_C_SFTP_UPGRADE_BOOTSTRAP_FILE_PREFIX}${digest}${GATE_C_SFTP_UPGRADE_BOOTSTRAP_FINAL_SUFFIX}`,
    label: 'SFTP upgrade bootstrap transfer',
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
  const segments = plan?.contract === GATE_C_SFTP_BOOTSTRAP_CONTRACT ? STAGING_SEGMENTS
    : plan?.contract === GATE_C_SFTP_UPGRADE_BOOTSTRAP_CONTRACT ? UPGRADE_STAGING_SEGMENTS
      : null;
  if (!segments) throw new Error('SFTP bootstrap plan is unsupported');
  const values = [];
  let current = plan.homeDirectory;
  for (const segment of segments) {
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
  const normalized = normalizeTransfer({
    contract: plan?.contract,
    homeDirectory: plan?.homeDirectory,
    bytes: plan?.bytes,
    sha256: plan?.sha256,
  }, {
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT,
    segments: STAGING_SEGMENTS,
    partialName: GATE_C_SFTP_BOOTSTRAP_PARTIAL_NAME,
    finalName: GATE_C_SFTP_BOOTSTRAP_FINAL_NAME,
    label: 'SFTP bootstrap transfer',
  });
  return assertSftpEntry({ plan: normalized, expectedUID, path: candidate, kind, mode: permission, uid: ownerUID, bytes });
}

export function assertGateCSftpUpgradeBootstrapEntry({ plan, expectedUID, path: candidate, kind, mode: permission, uid: ownerUID, bytes = null } = {}) {
  const normalized = normalizeGateCSftpUpgradeBootstrapTransfer({
    contract: plan?.contract,
    homeDirectory: plan?.homeDirectory,
    bytes: plan?.bytes,
    sha256: plan?.sha256,
  });
  return assertSftpEntry({ plan: normalized, expectedUID, path: candidate, kind, mode: permission, uid: ownerUID, bytes });
}

function assertSftpEntry({ plan, expectedUID, path: candidate, kind, mode: permission, uid: ownerUID, bytes = null }) {
  const file = text(candidate);
  const isDirectory = directories(plan).includes(file);
  const isFinal = file === plan.finalPath;
  const isPartial = file === plan.partialPath;
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
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > plan.bytes) throw new Error('SFTP bootstrap file size is invalid');
  if (isFinal && bytes !== plan.bytes) throw new Error('SFTP bootstrap final size does not match expected bytes');
  return Object.freeze({ path: file, kind: 'regular', mode: 0o600, uid: observedOwner, bytes });
}

/**
 * The fixed v1 privileged command template. The two interpolated values have
 * already passed strict digest/size validation; no remote path, package, URL,
 * service, or shell fragment is caller-controlled.
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

/**
 * Existing-install bootstrap replacement uses the fixed application-owned
 * v2 capsule and the signed, target/release-bound operation request. The
 * capsule bytes must match the reviewed digest before send.
 */
export function gateCSftpUpgradeBootstrapActivationCommand(request, { requiresPassword = true } = {}) {
  return gateCBootstrapKitReplacementCommand(request, { requiresPassword });
}
