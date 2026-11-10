import crypto from 'node:crypto';

export const GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT = 'sonuvi.gate-c-bootstrap-kit-replacement.v1';
export const GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH = '/var/lib/sonuvi-bootstrap/bootstrap-admission.lock';
export const GATE_C_BOOTSTRAP_REPLACEMENT_JOURNAL_ROOT = '/var/lib/sonuvi-bootstrap/bootstrap-kit-replacements';
export const GATE_C_BOOTSTRAP_REPLACEMENT_CAPSULE_SHA256 = '30ced067ecc63bdf7d32c8968d108296fdc6ff10bbc54da1fa37cf2ee364f8e2';

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
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG = Object.freeze(__CONFIG__);
const JOURNAL_KEYS = Object.freeze([
  'contract', 'createdAt', 'expectedServerReleaseId', 'operationId', 'previousBootstrapKitSHA256',
  'replacementKitBytes', 'replacementKitSHA256', 'replacementReleaseId', 'signedEnvelopeSHA256', 'state', 'targetIdentity', 'updatedAt',
]);
const TERMINAL_STATES = new Set(['aborted_before_promotion', 'committed', 'rolled_back']);
const ALL_STATES = new Set(['aborted_before_promotion', 'committed', 'prepared', 'preparing', 'promoted', 'rollback_prepared', 'rolled_back']);
const operationIdPattern = /^bkr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releasePattern = /^sonuvi-[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const targetPattern = /^sonuvi-target-v1-[a-f0-9]{64}$/;

function failClosed() { throw new Error('bootstrap_recovery_required'); }
function modeOf(stat) { return stat.mode & 0o7777; }
function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
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
function validJournal(value, operationId) {
  return sameKeys(value, JOURNAL_KEYS)
    && value.contract === 'sonuvi.gate-c-bootstrap-kit-replacement.v1'
    && value.operationId === operationId && operationIdPattern.test(value.operationId)
    && targetPattern.test(value.targetIdentity) && releasePattern.test(value.expectedServerReleaseId)
    && digestPattern.test(value.previousBootstrapKitSHA256) && releasePattern.test(value.replacementReleaseId)
    && digestPattern.test(value.replacementKitSHA256) && digestPattern.test(value.signedEnvelopeSHA256)
    && Number.isSafeInteger(value.replacementKitBytes) && value.replacementKitBytes >= 1 && value.replacementKitBytes <= 16 * 1024 * 1024
    && ALL_STATES.has(value.state) && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}
async function journalAt(operationId) {
  const directory = path.join(CONFIG.replacements, operationId);
  await requiredEntry(directory, 'directory', 0o700);
  const journalPath = path.join(directory, 'journal.json');
  const stat = await requiredEntry(journalPath, 'file', 0o600);
  if (stat.size < 2 || stat.size > 32 * 1024) failClosed();
  let value;
  try { value = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch { failClosed(); }
  if (!validJournal(value, operationId)) failClosed();
  return { directory, value };
}
async function assertTerminalJournal(directory, journal) {
  const active = await marker(CONFIG.activeKit);
  if (journal.state === 'aborted_before_promotion') {
    if (active !== journal.previousBootstrapKitSHA256) failClosed();
    return;
  }
  const previous = await marker(path.join(directory, 'previous'));
  if (journal.state === 'committed') {
    if (active !== journal.replacementKitSHA256 || previous !== journal.previousBootstrapKitSHA256) failClosed();
    return;
  }
  if (journal.state === 'rolled_back') {
    if (active !== journal.previousBootstrapKitSHA256 || previous !== journal.replacementKitSHA256) failClosed();
    return;
  }
  failClosed();
}
async function assertAdmitted() {
  await requiredEntry(CONFIG.root, 'directory', 0o700);
  await marker(CONFIG.activeKit);
  const replacementRoot = await optionalEntry(CONFIG.replacements);
  if (!replacementRoot) return;
  if (!trusted(replacementRoot, 'directory', 0o700)) failClosed();
  let entries;
  try { entries = await fs.readdir(CONFIG.replacements, { withFileTypes: true }); } catch { failClosed(); }
  if (entries.length > 128) failClosed();
  const journals = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !operationIdPattern.test(entry.name)) failClosed();
    const current = await journalAt(entry.name);
    if (!TERMINAL_STATES.has(current.value.state)) failClosed();
    journals.push(current);
  }
  if (!journals.length) return;
  // Retained journals describe historical exchanges too. The newest terminal
  // journal alone must agree with the live pair; a timestamp tie is ambiguous
  // and therefore is not admitted.
  journals.sort((left, right) => Date.parse(right.value.updatedAt) - Date.parse(left.value.updatedAt));
  if (journals.length > 1 && Date.parse(journals[0].value.updatedAt) === Date.parse(journals[1].value.updatedAt)) failClosed();
  await assertTerminalJournal(journals[0].directory, journals[0].value);
  for (const current of journals) {
    if (Date.parse(current.value.updatedAt) < Date.parse(current.value.createdAt)) failClosed();
  }
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
  return ADMISSION_GUARD_TEMPLATE.replace('__CONFIG__', JSON.stringify(admissionGuardConfiguration(options)));
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
  if (value.state === 'no_recovery_required') {
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
