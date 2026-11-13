import crypto from 'node:crypto';
import { GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES } from './sonuvi-gate-c-upgrade-bootstrap-kit.mjs';
import { validateBootstrapHistory } from './sonuvi-bootstrap-history.mjs';

export const GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT = 'sonuvi.gate-c-bootstrap-kit-replacement.v1';
export const GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH = '/var/lib/sonuvi-bootstrap/bootstrap-admission.lock';
export const GATE_C_BOOTSTRAP_REPLACEMENT_JOURNAL_ROOT = '/var/lib/sonuvi-bootstrap/bootstrap-kit-replacements';
export const GATE_C_BOOTSTRAP_REPLACEMENT_CAPSULE_SHA256 = 'e78fc5d346b261fdedf3df3204b1f29cba1e86cb2e3467bedc4e7f1d90624210';

export const GATE_C_BOOTSTRAP_ADMISSION_HELPERS = Object.freeze({
  stageRelease: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-release-stage.mjs',
  activateExisting: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-existing-install-upgrade.mjs',
  recoverExisting: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-existing-install-upgrade.mjs',
});

export const GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS = Object.freeze({
  stageRelease: 'stage_release',
  activateExisting: 'activate_existing_install',
  recoverExisting: 'recover_interrupted_upgrade',
});

export const GATE_C_BOOTSTRAP_ADMISSION_CONTRACT = 'sonuvi.gate-c-bootstrap-admission.v1';
export const GATE_C_BOOTSTRAP_ADMISSION_FAILURE_CODES = Object.freeze([
  'bootstrap_admission_helper_unavailable',
  'bootstrap_admission_invalid',
  'bootstrap_recovery_required',
]);

export const GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS = Object.freeze({
  inspect: 'inspect_bootstrap_kit',
  replace: 'replace_bootstrap_kit',
  recover: 'recover_bootstrap_kit_replacement',
  rollback: 'rollback_bootstrap_kit',
});

export const GATE_C_BOOTSTRAP_REPLACEMENT_FAILURE_CODES = Object.freeze([
  'atomic_exchange_unavailable',
  'bootstrap_admission_lock_invalid',
  'bootstrap_admission_lock_unavailable',
  'bootstrap_replacement_failed',
  'bootstrap_root_invalid',
  'bootstrap_root_permissions_invalid',
  'current_release_mismatch',
  'exclusive_maintenance_required',
  'invalid_arguments',
  'operation_busy',
  'previous_bootstrap_mismatch',
  'replacement_copy_failed',
  'replacement_envelope_invalid',
  'replacement_kit_archive_invalid',
  'replacement_kit_digest_invalid',
  'replacement_kit_inventory_invalid',
  'replacement_kit_size_invalid',
  'replacement_journal_failed',
  'replacement_operation_conflict',
  'replacement_promotion_failed',
  'replacement_recovery_required',
  'replacement_release_mismatch',
  'replacement_signature_invalid',
  'replacement_target_mismatch',
  'replacement_trust_anchor_mismatch',
  'root_authorization_required',
  'server_release_recovery_pending',
  'staging_directory_invalid',
  'staging_mode_invalid',
  'staging_owner_invalid',
  'staging_source_invalid',
  'staging_source_missing',
  'sudo_user_invalid',
]);

const failureCodes = new Set(GATE_C_BOOTSTRAP_REPLACEMENT_FAILURE_CODES);
const releasePattern = /^sonuvi-[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const targetPattern = /^sonuvi-target-v1-[a-f0-9]{64}$/;
const operationIdPattern = /^bkr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? '').trim();
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} is invalid`);
  }
}

function validReleaseId(value, label) {
  const result = text(value);
  if (!releasePattern.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function validDigest(value, label) {
  const result = text(value);
  if (!digestPattern.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function validOperationId(value) {
  const result = text(value);
  if (!operationIdPattern.test(result)) throw new Error('bootstrap replacement operation ID is invalid');
  return result;
}

function validTarget(value) {
  const result = text(value);
  if (!targetPattern.test(result)) throw new Error('bootstrap replacement target identity is invalid');
  return result;
}

function validByteCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
    throw new Error('bootstrap replacement kit size is invalid');
  }
  return value;
}

function envelopeBytes(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('bootstrap replacement signed envelope is invalid');
  }
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.length < 1 || bytes.length > 64 * 1024) throw new Error('bootstrap replacement signed envelope is invalid');
  return bytes;
}

function envelopeArgument(envelope) {
  return envelopeBytes(envelope).toString('base64url');
}

const admissionFailureCodes = new Set(GATE_C_BOOTSTRAP_ADMISSION_FAILURE_CODES);
const admissionOperationNames = new Set(Object.values(GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS));
const admissionGuardHelpers = Object.freeze({
  [GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS.stageRelease]: GATE_C_BOOTSTRAP_ADMISSION_HELPERS.stageRelease,
  [GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS.activateExisting]: GATE_C_BOOTSTRAP_ADMISSION_HELPERS.activateExisting,
  [GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS.recoverExisting]: GATE_C_BOOTSTRAP_ADMISSION_HELPERS.recoverExisting,
});

function absoluteGuardPath(value, label) {
  const result = text(value);
  if (!result.startsWith('/') || result.includes('\0') || result.includes('\\') || result.includes('//')) {
    throw new Error(`${label} is invalid`);
  }
  return result.length > 1 && result.endsWith('/') ? result.slice(0, -1) : result;
}

function guardIdentity(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function admissionGuardConfiguration({
  bootstrapRoot = '/var/lib/sonuvi-bootstrap',
  expectedGID = 0,
  expectedUID = 0,
  helpers = admissionGuardHelpers,
  nodePath = '/usr/bin/node',
} = {}) {
  const root = absoluteGuardPath(bootstrapRoot, 'bootstrap admission root');
  const normalizedHelpers = {};
  for (const operation of admissionOperationNames) {
    normalizedHelpers[operation] = absoluteGuardPath(helpers?.[operation], 'bootstrap admission helper');
  }
  return Object.freeze({
    activeKit: `${root}/bootstrap-kit-v2`,
    activeKitFiles: GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES,
    contract: GATE_C_BOOTSTRAP_ADMISSION_CONTRACT,
    expectedGID: guardIdentity(expectedGID, 'bootstrap admission group'),
    expectedUID: guardIdentity(expectedUID, 'bootstrap admission owner'),
    helpers: normalizedHelpers,
    nodePath: absoluteGuardPath(nodePath, 'bootstrap admission Node path'),
    replacements: `${root}/bootstrap-kit-replacements`,
    root,
  });
}

// This module is encoded into the client command, rather than loaded from the
// atomically replaceable kit. It uses only Node built-ins until it has inspected
// a root-owned replacement journal while flock still holds the admission lock.
const ADMISSION_GUARD_TEMPLATE = String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG = Object.freeze(__CONFIG__);
__HISTORY_VALIDATOR__
const JOURNAL_KEYS = Object.freeze([
  'contract', 'createdAt', 'expectedServerReleaseId', 'operationId', 'previousBootstrapKitSHA256',
  'replacementKitBytes', 'replacementKitSHA256', 'replacementReleaseId', 'signedEnvelopeSHA256', 'state', 'targetIdentity', 'updatedAt',
]);
const INITIAL_INTENT_KEYS = Object.freeze([
  'contract', 'createdAt', 'expectedServerReleaseId', 'operationId', 'previousBootstrapKitSHA256', 'targetIdentity',
]);
const INITIAL_RECOVERY_KEYS = Object.freeze([
  'activeBootstrapKitSHA256', 'activeBootstrapReleaseId', 'contract', 'initialJournalIntentBytes', 'initialJournalIntentSHA256',
  'operationId', 'recoveredAt', 'state', 'targetIdentity', 'temporaryJournalBytes', 'temporaryJournalKind', 'temporaryJournalSHA256',
]);
const INITIAL_INTENT_CONTRACT = 'sonuvi.gate-c-bootstrap-initial-journal-intent.v1';
const INITIAL_INTENT_PREFIX = '.initial-journal-intent-';
const INITIAL_INTENT_SUFFIX = '.json';
const INITIAL_RECOVERY_CONTRACT = 'sonuvi.gate-c-bootstrap-initial-journal-recovery.v1';
const INITIAL_RECOVERY_PREFIX = '.initial-journal-recovery-';
const INITIAL_RECOVERY_SUFFIX = '.json';
const INITIAL_JOURNAL_MAX_BYTES = 32 * 1024;
const TERMINAL_STATES = new Set(['aborted_before_promotion', 'committed', 'rolled_back']);
const ALL_STATES = new Set(['aborted_before_promotion', 'committed', 'prepared', 'preparing', 'promoted', 'rollback_prepared', 'rolled_back']);
const operationIdPattern = /^bkr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releasePattern = /^sonuvi-[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const targetPattern = /^sonuvi-target-v1-[a-f0-9]{64}$/;
const ACTIVE_KIT_FILES = Object.freeze([...CONFIG.activeKitFiles]);
const ACTIVE_KIT_FILE_SET = new Set(ACTIVE_KIT_FILES);

function failClosed() { throw new Error('bootstrap_recovery_required'); }
function modeOf(stat) { return stat.mode & 0o7777; }
function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function trusted(stat, kind, mode) {
  return Boolean(stat) && !stat.isSymbolicLink() && stat.uid === CONFIG.expectedUID && stat.gid === CONFIG.expectedGID
    && modeOf(stat) === mode && ((kind === 'directory' && stat.isDirectory()) || (kind === 'file' && stat.isFile()));
}
async function requiredEntry(candidate, kind, mode) {
  let stat;
  try { stat = await fs.lstat(candidate); } catch { failClosed(); }
  if (!trusted(stat, kind, mode)) failClosed();
  return stat;
}
async function optionalEntry(candidate) {
  try { return await fs.lstat(candidate); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    failClosed();
  }
}
async function marker(directory) {
  await requiredEntry(directory, 'directory', 0o700);
  const file = path.join(directory, '.sonuvi-bootstrap-kit-v2.sha256');
  const stat = await requiredEntry(file, 'file', 0o600);
  if (stat.size < 1 || stat.size > 128) failClosed();
  let source;
  try { source = await fs.readFile(file, 'utf8'); } catch { failClosed(); }
  const value = source.trim();
  if (!digestPattern.test(value)) failClosed();
  return value;
}
function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory && directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}
function validActiveKitManifest(value) {
  return sameKeys(value, ['contract', 'files', 'keyId', 'releaseId', 'target', 'version'])
    && value.contract === 'sonuvi.gate-c-bootstrap-kit.v2' && value.version === 2
    && releasePattern.test(value.releaseId) && typeof value.keyId === 'string'
    && /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(value.keyId)
    && sameKeys(value.target, ['architecture', 'os'])
    && value.target.os === 'linux' && value.target.architecture === 'arm64'
    && Array.isArray(value.files) && value.files.length === ACTIVE_KIT_FILES.length;
}
async function assertActiveKitTree(directory = CONFIG.activeKit) {
  if (ACTIVE_KIT_FILES.length === 0 || ACTIVE_KIT_FILE_SET.size !== ACTIVE_KIT_FILES.length) failClosed();
  const activeMarker = await marker(directory);
  const manifestPath = path.join(directory, 'bootstrap-kit-manifest.json');
  await requiredEntry(manifestPath, 'file', 0o600);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { failClosed(); }
  if (!validActiveKitManifest(manifest)) failClosed();
  const actual = [];
  const visited = [];
  async function walk(directory, relative = '') {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { failClosed(); }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      let stat;
      try { stat = await fs.lstat(candidate); } catch { failClosed(); }
      if (stat.isSymbolicLink() || stat.uid !== CONFIG.expectedUID || stat.gid !== CONFIG.expectedGID) failClosed();
      if (stat.isDirectory()) {
        if (modeOf(stat) !== 0o700) failClosed();
        visited.push(child);
        await walk(candidate, child);
      } else if (stat.isFile()) {
        if (modeOf(stat) !== 0o600 || stat.nlink !== 1) failClosed();
        visited.push(child);
        if (child === '.sonuvi-bootstrap-kit-v2.sha256' || child === 'bootstrap-kit-manifest.json') continue;
        let contents;
        try { contents = await fs.readFile(candidate); } catch { failClosed(); }
        actual.push({ path: child, bytes: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') });
      } else failClosed();
    }
  }
  await walk(directory);
  actual.sort((left, right) => left.path.localeCompare(right.path));
  const expectedTree = [...ACTIVE_KIT_FILES, 'bootstrap-kit-manifest.json', '.sonuvi-bootstrap-kit-v2.sha256', ...expectedDirectories(ACTIVE_KIT_FILES)].sort();
  if (JSON.stringify(visited.sort()) !== JSON.stringify(expectedTree)) failClosed();
  const manifestFiles = manifest.files.map((file) => {
    if (!sameKeys(file, ['bytes', 'path', 'sha256']) || !ACTIVE_KIT_FILE_SET.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digestPattern.test(file.sha256)) failClosed();
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(manifestFiles) !== JSON.stringify(actual)
    || JSON.stringify(actual.map((file) => file.path)) !== JSON.stringify(ACTIVE_KIT_FILES)) failClosed();
  return { marker: activeMarker, manifest };
}
function validJournal(value, operationId) {
  return sameKeys(value, JOURNAL_KEYS)
    && value.contract === 'sonuvi.gate-c-bootstrap-kit-replacement.v1'
    && value.operationId === operationId && operationIdPattern.test(value.operationId)
    && targetPattern.test(value.targetIdentity) && releasePattern.test(value.expectedServerReleaseId)
    && digestPattern.test(value.previousBootstrapKitSHA256) && releasePattern.test(value.replacementReleaseId)
    && digestPattern.test(value.replacementKitSHA256) && digestPattern.test(value.signedEnvelopeSHA256)
    && Number.isSafeInteger(value.replacementKitBytes) && value.replacementKitBytes >= 1 && value.replacementKitBytes <= 16 * 1024 * 1024
    && ALL_STATES.has(value.state) && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt);
}
function initialTemporaryName(operationId) { return '.journal-' + operationId + '.tmp'; }
function initialIntentName(operationId) { return INITIAL_INTENT_PREFIX + operationId + INITIAL_INTENT_SUFFIX; }
function initialRecoveryName(operationId) { return INITIAL_RECOVERY_PREFIX + operationId + INITIAL_RECOVERY_SUFFIX; }
function operationIdForInitialTemporary(name) {
  if (!name.startsWith('.journal-') || !name.endsWith('.tmp')) return null;
  const operationId = name.slice('.journal-'.length, -'.tmp'.length);
  return operationIdPattern.test(operationId) ? operationId : null;
}
function operationIdForInitialRecovery(name) {
  if (!name.startsWith(INITIAL_RECOVERY_PREFIX) || !name.endsWith(INITIAL_RECOVERY_SUFFIX)) return null;
  const operationId = name.slice(INITIAL_RECOVERY_PREFIX.length, -INITIAL_RECOVERY_SUFFIX.length);
  return operationIdPattern.test(operationId) ? operationId : null;
}
function operationIdForInitialIntent(name) {
  if (!name.startsWith(INITIAL_INTENT_PREFIX) || !name.endsWith(INITIAL_INTENT_SUFFIX)) return null;
  const operationId = name.slice(INITIAL_INTENT_PREFIX.length, -INITIAL_INTENT_SUFFIX.length);
  return operationIdPattern.test(operationId) ? operationId : null;
}
function knownPrefix(value, prefix, suffixLength) {
  if (value.length > prefix.length + suffixLength) return false;
  if (value.length <= prefix.length) return prefix.startsWith(value);
  return value.startsWith(prefix) && /^[a-f0-9]*$/.test(value.slice(prefix.length));
}
function timestampPrefix(value) {
  const layout = 'NNNN-NN-NNTNN:NN:NN.NNNZ';
  if (value.length > layout.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (layout[index] === 'N') {
      if (!/[0-9]/.test(value[index])) return false;
    } else if (value[index] !== layout[index]) return false;
  }
  return true;
}
function initialByteCountPrefix(value) {
  return value === '' || (/^[1-9][0-9]{0,7}$/.test(value) && Number(value) <= 16 * 1024 * 1024);
}
function validInitialByteCount(value) {
  return /^[1-9][0-9]{0,7}$/.test(value) && Number(value) <= 16 * 1024 * 1024;
}
function isInitialJournalPrefix(contents, operationId) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(contents); } catch { return false; }
  let cursor = 0;
  const consumeLiteral = (literal) => {
    const observed = source.slice(cursor, cursor + literal.length);
    if (observed.length < literal.length) return literal.startsWith(observed) ? 'incomplete' : 'invalid';
    if (observed !== literal) return 'invalid';
    cursor += literal.length;
    return 'complete';
  };
  const consumeQuoted = (prefix, complete) => {
    const closing = source.indexOf('"', cursor);
    if (closing === -1) return prefix(source.slice(cursor)) ? 'incomplete' : 'invalid';
    const value = source.slice(cursor, closing);
    if (!complete(value)) return 'invalid';
    cursor = closing + 1;
    return 'complete';
  };
  const consumeDelimited = (delimiter, prefix, complete) => {
    const closing = source.indexOf(delimiter, cursor);
    if (closing === -1) return prefix(source.slice(cursor)) ? 'incomplete' : 'invalid';
    const value = source.slice(cursor, closing);
    if (!complete(value)) return 'invalid';
    cursor = closing;
    return 'complete';
  };
  const steps = [
    ['literal', '{"contract":"sonuvi.gate-c-bootstrap-kit-replacement.v1","operationId":"'],
    ['quoted', (value) => operationId.startsWith(value), (value) => value === operationId],
    ['literal', ',"targetIdentity":"'],
    ['quoted', (value) => knownPrefix(value, 'sonuvi-target-v1-', 64), (value) => targetPattern.test(value)],
    ['literal', ',"expectedServerReleaseId":"'],
    ['quoted', (value) => knownPrefix(value, 'sonuvi-', 64), (value) => releasePattern.test(value)],
    ['literal', ',"previousBootstrapKitSHA256":"'],
    ['quoted', (value) => /^[a-f0-9]{0,64}$/.test(value), (value) => digestPattern.test(value)],
    ['literal', ',"replacementReleaseId":"'],
    ['quoted', (value) => knownPrefix(value, 'sonuvi-', 64), (value) => releasePattern.test(value)],
    ['literal', ',"replacementKitSHA256":"'],
    ['quoted', (value) => /^[a-f0-9]{0,64}$/.test(value), (value) => digestPattern.test(value)],
    ['literal', ',"replacementKitBytes":'],
    ['delimited', ',', initialByteCountPrefix, validInitialByteCount],
    ['literal', ',"signedEnvelopeSHA256":"'],
    ['quoted', (value) => /^[a-f0-9]{0,64}$/.test(value), (value) => digestPattern.test(value)],
    ['literal', ',"state":"'],
    ['quoted', (value) => 'preparing'.startsWith(value), (value) => value === 'preparing'],
    ['literal', ',"createdAt":"'],
    ['quoted', timestampPrefix, validTimestamp],
    ['literal', ',"updatedAt":"'],
    ['quoted', timestampPrefix, validTimestamp],
    ['literal', '}\n'],
  ];
  for (const [kind, ...values] of steps) {
    const result = kind === 'literal' ? consumeLiteral(values[0])
      : kind === 'quoted' ? consumeQuoted(values[0], values[1])
        : consumeDelimited(values[0], values[1], values[2]);
    if (result === 'incomplete') return true;
    if (result === 'invalid') return false;
  }
  return cursor === source.length;
}
async function journalAt(operationId) {
  const directory = path.join(CONFIG.replacements, operationId);
  await requiredEntry(directory, 'directory', 0o700);
  const journalPath = path.join(directory, 'journal.json');
  const stat = await requiredEntry(journalPath, 'file', 0o600);
  if (stat.nlink !== 1 || stat.size < 2 || stat.size > 32 * 1024) failClosed();
  let value;
  try { value = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch { failClosed(); }
  if (!validJournal(value, operationId)) failClosed();
  return { directory, value };
}
function validInitialJournalIntent(value, operationId) {
  return sameKeys(value, INITIAL_INTENT_KEYS)
    && value.contract === INITIAL_INTENT_CONTRACT && value.operationId === operationId && operationIdPattern.test(value.operationId)
    && targetPattern.test(value.targetIdentity) && releasePattern.test(value.expectedServerReleaseId)
    && digestPattern.test(value.previousBootstrapKitSHA256) && validTimestamp(value.createdAt);
}
async function initialJournalIntentAt(operationId) {
  const intentPath = path.join(CONFIG.replacements, initialIntentName(operationId));
  const stat = await requiredEntry(intentPath, 'file', 0o600);
  if (stat.nlink !== 1 || stat.size < 2 || stat.size > 8 * 1024) failClosed();
  let contents;
  let value;
  try {
    contents = await fs.readFile(intentPath);
    value = JSON.parse(contents.toString('utf8'));
  } catch { failClosed(); }
  if (!validInitialJournalIntent(value, operationId)) failClosed();
  const canonical = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  if (!contents.equals(canonical)) failClosed();
  return {
    value,
    size: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
  };
}
function validInitialRecovery(value, operationId) {
  return sameKeys(value, INITIAL_RECOVERY_KEYS)
    && value.contract === INITIAL_RECOVERY_CONTRACT && value.operationId === operationId && operationIdPattern.test(value.operationId)
    && targetPattern.test(value.targetIdentity) && digestPattern.test(value.activeBootstrapKitSHA256)
    && releasePattern.test(value.activeBootstrapReleaseId) && Number.isSafeInteger(value.initialJournalIntentBytes)
    && value.initialJournalIntentBytes >= 2 && value.initialJournalIntentBytes <= 8 * 1024
    && digestPattern.test(value.initialJournalIntentSHA256) && Number.isSafeInteger(value.temporaryJournalBytes)
    && value.temporaryJournalBytes >= 0 && value.temporaryJournalBytes <= INITIAL_JOURNAL_MAX_BYTES
    && (value.temporaryJournalKind === 'empty' || value.temporaryJournalKind === 'truncated')
    && digestPattern.test(value.temporaryJournalSHA256) && value.state === 'aborted_before_promotion'
    && validTimestamp(value.recoveredAt);
}
async function assertInitialJournalRecovery(operationId, active) {
  if (!active || !digestPattern.test(active.marker) || !releasePattern.test(active.manifest?.releaseId)) failClosed();
  const transaction = await optionalEntry(path.join(CONFIG.replacements, operationId));
  if (transaction) failClosed();
  const intent = await initialJournalIntentAt(operationId);
  const temporaryPath = path.join(CONFIG.replacements, initialTemporaryName(operationId));
  const temporary = await requiredEntry(temporaryPath, 'file', 0o600);
  if (temporary.nlink !== 1 || temporary.size > INITIAL_JOURNAL_MAX_BYTES) failClosed();
  let contents;
  try { contents = await fs.readFile(temporaryPath); } catch { failClosed(); }
  if (contents.length !== temporary.size) failClosed();
  let parsed = null;
  try { parsed = JSON.parse(contents.toString('utf8')); } catch {}
  if (parsed && validJournal(parsed, operationId)) failClosed();
  if (!isInitialJournalPrefix(contents, operationId)) failClosed();
  const recoveryPath = path.join(CONFIG.replacements, initialRecoveryName(operationId));
  const recoveryStat = await requiredEntry(recoveryPath, 'file', 0o600);
  if (recoveryStat.nlink !== 1 || recoveryStat.size < 2 || recoveryStat.size > 8 * 1024) failClosed();
  let recovery;
  try { recovery = JSON.parse(await fs.readFile(recoveryPath, 'utf8')); } catch { failClosed(); }
  if (!validInitialRecovery(recovery, operationId)) failClosed();
  const kind = contents.length === 0 ? 'empty' : 'truncated';
  if (recovery.targetIdentity !== intent.value.targetIdentity
    || recovery.activeBootstrapKitSHA256 !== intent.value.previousBootstrapKitSHA256
    || recovery.initialJournalIntentBytes !== intent.size || recovery.initialJournalIntentSHA256 !== intent.sha256
    || recovery.activeBootstrapKitSHA256 !== active.marker || recovery.activeBootstrapReleaseId !== active.manifest.releaseId
    || recovery.temporaryJournalBytes !== contents.length || recovery.temporaryJournalKind !== kind
    || recovery.temporaryJournalSHA256 !== crypto.createHash('sha256').update(contents).digest('hex')
    || Date.parse(recovery.recoveredAt) < Date.parse(intent.value.createdAt)) failClosed();
  return { ...recovery, createdAt: intent.value.createdAt };
}
async function assertAdmitted() {
  await requiredEntry(CONFIG.root, 'directory', 0o700);
  const active = await assertActiveKitTree();
  const replacementRoot = await optionalEntry(CONFIG.replacements);
  if (!replacementRoot) return;
  if (!trusted(replacementRoot, 'directory', 0o700)) failClosed();
  let entries;
  try { entries = await fs.readdir(CONFIG.replacements, { withFileTypes: true }); } catch { failClosed(); }
  if (entries.length > 128) failClosed();
  const directories = new Set();
  const temporaries = new Set();
  const recoveries = new Set();
  const intents = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) failClosed();
    if (entry.isDirectory()) {
      if (!operationIdPattern.test(entry.name)) failClosed();
      directories.add(entry.name);
      continue;
    }
    if (!entry.isFile()) failClosed();
    const temporaryId = operationIdForInitialTemporary(entry.name);
    if (temporaryId) {
      temporaries.add(temporaryId);
      continue;
    }
    const recoveryId = operationIdForInitialRecovery(entry.name);
    if (recoveryId) {
      recoveries.add(recoveryId);
      continue;
    }
    const intentId = operationIdForInitialIntent(entry.name);
    if (intentId) {
      intents.add(intentId);
      continue;
    }
    failClosed();
  }
  const records = [];
  const journals = [];
  const kits = new Map([[active.marker, active]]);
  for (const operationId of directories) {
    if (temporaries.has(operationId) || recoveries.has(operationId) || intents.has(operationId)) failClosed();
    const current = await journalAt(operationId);
    if (!TERMINAL_STATES.has(current.value.state) || Date.parse(current.value.updatedAt) < Date.parse(current.value.createdAt)) failClosed();
    journals.push(current);
    if (current.value.state !== 'aborted_before_promotion') {
      const preserved = await assertActiveKitTree(path.join(current.directory, 'previous'));
      const expected = current.value.state === 'committed' ? current.value.previousBootstrapKitSHA256 : current.value.replacementKitSHA256;
      if (preserved.marker !== expected || (kits.has(expected)
        && kits.get(expected).manifest.releaseId !== preserved.manifest.releaseId)) failClosed();
      kits.set(expected, preserved);
    } else if (await optionalEntry(path.join(current.directory, 'previous'))) failClosed();
  }
  for (const { value: journal } of journals) {
    const before = kits.get(journal.previousBootstrapKitSHA256);
    const replacement = kits.get(journal.replacementKitSHA256);
    if (!before || (journal.state !== 'aborted_before_promotion'
      && (!replacement || replacement.manifest.releaseId !== journal.replacementReleaseId))) failClosed();
    records.push({ ...journal, before, after: journal.state === 'committed' ? replacement : before });
  }
  for (const operationId of temporaries) {
    if (directories.has(operationId) || !intents.has(operationId) || !recoveries.has(operationId)) failClosed();
    const intent = await initialJournalIntentAt(operationId);
    const original = kits.get(intent.value.previousBootstrapKitSHA256);
    const recovery = await assertInitialJournalRecovery(operationId, original);
    records.push({ ...recovery, updatedAt: recovery.recoveredAt, before: original, after: original });
  }
  for (const operationId of intents) {
    if (!temporaries.has(operationId) || !recoveries.has(operationId)) failClosed();
  }
  for (const operationId of recoveries) {
    if (!temporaries.has(operationId) || !intents.has(operationId)) failClosed();
  }
  validateBootstrapHistory(records, active);
}
function response(operation, code) {
  return {
    contract: CONFIG.contract,
    operation: Object.hasOwn(CONFIG.helpers, operation) ? operation : 'invalid',
    ok: false,
    code,
  };
}
function emit(operation, code) {
  process.stdout.write(JSON.stringify(response(operation, code)) + '\n');
}
async function executeHelper(helper) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(CONFIG.nodePath, [helper], { env: process.env, stdio: 'inherit' });
    } catch {
      resolve({ spawned: false, status: 1 });
      return;
    }
    child.once('error', () => resolve({ spawned: false, status: 1 }));
    child.once('exit', (status) => resolve({ spawned: true, status: Number.isInteger(status) ? status : 1 }));
  });
}
async function main() {
  const operation = process.argv.length === 2 ? process.argv[1] : '';
  const helper = CONFIG.helpers[operation];
  if (typeof helper !== 'string') {
    emit(operation, 'bootstrap_admission_invalid');
    return 1;
  }
  try {
    await assertAdmitted();
  } catch {
    emit(operation, 'bootstrap_recovery_required');
    return 1;
  }
  const result = await executeHelper(helper);
  if (!result.spawned) {
    emit(operation, 'bootstrap_admission_helper_unavailable');
    return 1;
  }
  return result.status;
}

process.exitCode = await main();
`;

/**
 * Return the reviewed, self-contained program run by the admission command.
 * Alternate roots are intentionally useful only for isolated executable tests;
 * production command construction always uses the fixed defaults above.
 */
export function gateCBootstrapAdmissionGuardProgram(options = {}) {
  return ADMISSION_GUARD_TEMPLATE.replace('__CONFIG__', JSON.stringify(admissionGuardConfiguration(options)))
    .replace('__HISTORY_VALIDATOR__', validateBootstrapHistory.toString());
}

function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function admissionGuardLoader() {
  const source = gateCBootstrapAdmissionGuardProgram();
  const uri = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return `await import(${JSON.stringify(uri)});`;
}

/**
 * The fixed, client-supplied guard runs under the shared flock before it loads
 * a root-owned helper from the atomically replaceable kit. It only reads the
 * bootstrap replacement journal and markers; it never reconciles or mutates
 * them. SFTP uploads are content-addressed and do not invoke a privileged
 * helper.
 */
export function gateCBootstrapAdmissionCommand(operation, { requiresPassword = true } = {}) {
  const helper = GATE_C_BOOTSTRAP_ADMISSION_HELPERS[operation];
  const admissionOperation = GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS[operation];
  if (!helper || !admissionOperation) throw new Error('bootstrap admission operation is unsupported');
  const sudo = requiresPassword ? "/usr/bin/sudo -S -k -p ''" : '/usr/bin/sudo -n';
  return `${sudo} -- /usr/bin/flock -n ${GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH} /usr/bin/node --input-type=module --eval ${shellArgument(admissionGuardLoader())} ${admissionOperation}`;
}

export function normalizeGateCBootstrapAdmissionResponse(value, { operation } = {}) {
  const expectedOperation = GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS[operation] || operation;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.contract !== GATE_C_BOOTSTRAP_ADMISSION_CONTRACT
    || value.ok !== false || !admissionOperationNames.has(value.operation) || !admissionFailureCodes.has(value.code)) {
    throw new Error('bootstrap admission response is invalid');
  }
  sameKeys(value, ['code', 'contract', 'ok', 'operation'], 'bootstrap admission response');
  if (expectedOperation && value.operation !== expectedOperation) throw new Error('bootstrap admission response binding is invalid');
  return Object.freeze(value);
}

export function normalizeGateCBootstrapKitReplacementRequest(input = {}) {
  sameKeys(input, [
    'envelope', 'expectedPreviousBootstrapKitSHA256', 'expectedServerReleaseId', 'operation', 'operationId',
    'replacementKitBytes', 'replacementKitSHA256', 'replacementReleaseId', 'targetIdentity',
  ], 'bootstrap replacement request');
  if (input.operation !== GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace) {
    throw new Error('bootstrap replacement operation is unsupported');
  }
  return Object.freeze({
    operation: input.operation,
    operationId: validOperationId(input.operationId),
    targetIdentity: validTarget(input.targetIdentity),
    expectedServerReleaseId: validReleaseId(input.expectedServerReleaseId, 'expected installed Server release ID'),
    expectedPreviousBootstrapKitSHA256: validDigest(input.expectedPreviousBootstrapKitSHA256, 'previous bootstrap-kit digest'),
    replacementReleaseId: validReleaseId(input.replacementReleaseId, 'replacement release ID'),
    replacementKitSHA256: validDigest(input.replacementKitSHA256, 'replacement bootstrap-kit digest'),
    replacementKitBytes: validByteCount(input.replacementKitBytes),
    signedEnvelopeSHA256: crypto.createHash('sha256').update(envelopeBytes(input.envelope)).digest('hex'),
    envelope: input.envelope,
  });
}

function commandArguments(request) {
  if (request.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.inspect) {
    sameKeys(request, ['operation', 'operationId', 'targetIdentity', 'expectedServerReleaseId'], 'bootstrap inspection request');
    return [request.operation, validOperationId(request.operationId), validTarget(request.targetIdentity),
      validReleaseId(request.expectedServerReleaseId, 'expected installed Server release ID')];
  }
  if (request.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace) {
    const normalized = normalizeGateCBootstrapKitReplacementRequest(request);
    return [
      normalized.operation,
      normalized.operationId,
      normalized.targetIdentity,
      normalized.expectedServerReleaseId,
      normalized.expectedPreviousBootstrapKitSHA256,
      normalized.replacementReleaseId,
      normalized.replacementKitSHA256,
      String(normalized.replacementKitBytes),
      envelopeArgument(normalized.envelope),
    ];
  }
  sameKeys(request, ['operation', 'operationId', 'targetIdentity', ...(request.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.rollback
    ? ['expectedPreviousBootstrapKitSHA256', 'expectedReplacementKitSHA256'] : [])], 'bootstrap replacement request');
  const operationId = validOperationId(request.operationId);
  const targetIdentity = validTarget(request.targetIdentity);
  if (request.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover) {
    return [request.operation, operationId, targetIdentity];
  }
  if (request.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.rollback) {
    return [
      request.operation,
      operationId,
      targetIdentity,
      validDigest(request.expectedReplacementKitSHA256, 'replacement bootstrap-kit digest'),
      validDigest(request.expectedPreviousBootstrapKitSHA256, 'previous bootstrap-kit digest'),
    ];
  }
  throw new Error('bootstrap replacement operation is unsupported');
}

/** Build the only client-approved interactive-sudo invocation for this capsule. */
export function gateCBootstrapKitReplacementCommand(request, { requiresPassword = true } = {}) {
  const args = commandArguments(request);
  const sudo = requiresPassword ? "/usr/bin/sudo -S -k -p ''" : '/usr/bin/sudo -n';
  return `${sudo} -- /bin/sh -s -- ${args.join(' ')}`;
}

export function normalizeGateCBootstrapKitReplacementResponse(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT
    || value.operation !== expected.operation || typeof value.ok !== 'boolean') {
    throw new Error('bootstrap replacement response is invalid');
  }
  const operationId = validOperationId(value.operationId);
  const targetIdentity = validTarget(value.targetIdentity);
  if ((expected.operationId && operationId !== expected.operationId)
    || (expected.targetIdentity && targetIdentity !== expected.targetIdentity)) {
    throw new Error('bootstrap replacement response binding is invalid');
  }
  if (!value.ok) {
    sameKeys(value, ['code', 'contract', 'ok', 'operation', 'operationId', 'targetIdentity'], 'bootstrap replacement failure response');
    if (!failureCodes.has(value.code)) throw new Error('bootstrap replacement response code is invalid');
    return Object.freeze(value);
  }
  if (value.operation === GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.inspect) {
    sameKeys(value, ['contract', 'operation', 'ok', 'state', 'operationId', 'targetIdentity',
      'expectedServerReleaseId', 'activeBootstrapKitSHA256', 'activeBootstrapReleaseId'], 'bootstrap inspection response');
    if (value.state !== 'inspected' || value.expectedServerReleaseId !== expected.expectedServerReleaseId) {
      throw new Error('bootstrap inspection response binding is invalid');
    }
    validReleaseId(value.expectedServerReleaseId, 'inspected Server release');
    validReleaseId(value.activeBootstrapReleaseId, 'inspected bootstrap release');
    validDigest(value.activeBootstrapKitSHA256, 'inspected bootstrap digest');
    return Object.freeze(value);
  }
  const boundedInitialJournalOutcome = value.state === 'aborted_before_promotion'
    && Object.keys(value).sort().join(',') === ['contract', 'operation', 'ok', 'operationId', 'state', 'targetIdentity'].sort().join(',');
  if (value.state === 'no_recovery_required' || boundedInitialJournalOutcome) {
    sameKeys(value, ['contract', 'operation', 'ok', 'operationId', 'state', 'targetIdentity'], 'bootstrap replacement recovery response');
    if (value.operation !== GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover) {
      throw new Error('bootstrap replacement response state is invalid for this operation');
    }
    return Object.freeze(value);
  }
  sameKeys(value, [
    'contract', 'operation', 'ok', 'operationId', 'state', 'targetIdentity',
    'expectedServerReleaseId', 'previousBootstrapKitSHA256', 'replacementReleaseId', 'replacementKitSHA256',
  ], 'bootstrap replacement success response');
  const states = new Set([
    'aborted_before_promotion', 'already_replaced', 'already_rolled_back', 'committed_after_interruption',
    'no_recovery_required', 'replaced', 'rolled_back',
  ]);
  if (!states.has(value.state)) throw new Error('bootstrap replacement response state is invalid');
  const allowedStates = {
    [GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace]: new Set(['aborted_before_promotion', 'already_replaced', 'already_rolled_back', 'replaced']),
    [GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover]: new Set(['aborted_before_promotion', 'already_replaced', 'already_rolled_back', 'committed_after_interruption', 'rolled_back']),
    [GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.rollback]: new Set(['already_rolled_back', 'rolled_back']),
  }[value.operation];
  if (!allowedStates?.has(value.state)) throw new Error('bootstrap replacement response state is invalid for this operation');
  const response = {
    ...value,
    expectedServerReleaseId: validReleaseId(value.expectedServerReleaseId, 'response Server release ID'),
    previousBootstrapKitSHA256: validDigest(value.previousBootstrapKitSHA256, 'response previous bootstrap-kit digest'),
    replacementReleaseId: validReleaseId(value.replacementReleaseId, 'response replacement release ID'),
    replacementKitSHA256: validDigest(value.replacementKitSHA256, 'response replacement bootstrap-kit digest'),
  };
  if (expected.replacementReleaseId && response.replacementReleaseId !== expected.replacementReleaseId) {
    throw new Error('bootstrap replacement response release binding is invalid');
  }
  if (expected.replacementKitSHA256 && response.replacementKitSHA256 !== expected.replacementKitSHA256) {
    throw new Error('bootstrap replacement response digest binding is invalid');
  }
  if (expected.expectedServerReleaseId && response.expectedServerReleaseId !== expected.expectedServerReleaseId) {
    throw new Error('bootstrap replacement response installed-release binding is invalid');
  }
  if (expected.expectedPreviousBootstrapKitSHA256
    && response.previousBootstrapKitSHA256 !== expected.expectedPreviousBootstrapKitSHA256) {
    throw new Error('bootstrap replacement response previous-kit binding is invalid');
  }
  return Object.freeze(response);
}

export function bootstrapReplacementEnvelopeArgument(envelope) {
  return envelopeArgument(envelope);
}

export function bootstrapReplacementOperationId() {
  return `bkr_${crypto.randomUUID()}`;
}
