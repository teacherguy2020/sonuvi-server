import crypto from 'node:crypto';

export const GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT = 'sonuvi.gate-c-bootstrap-kit-replacement.v1';
export const GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH = '/var/lib/sonuvi-bootstrap/bootstrap-admission.lock';
export const GATE_C_BOOTSTRAP_REPLACEMENT_JOURNAL_ROOT = '/var/lib/sonuvi-bootstrap/bootstrap-kit-replacements';
export const GATE_C_BOOTSTRAP_REPLACEMENT_CAPSULE_SHA256 = '6535738585f8f14c4f0c8b43ee927c6a7195041c881ced9b5470693140bad88d';

export const GATE_C_BOOTSTRAP_ADMISSION_HELPERS = Object.freeze({
  stageRelease: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-release-stage.mjs',
  activateExisting: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-existing-install-upgrade.mjs',
  recoverExisting: '/var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-existing-install-upgrade.mjs',
});

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

/**
 * The client must acquire the shared lock before Node loads a root-owned helper
 * that is replaced atomically with the active bootstrap kit. SFTP uploads are
 * content-addressed and do not invoke a privileged helper.
 */
export function gateCBootstrapAdmissionCommand(operation, { requiresPassword = true } = {}) {
  const helper = GATE_C_BOOTSTRAP_ADMISSION_HELPERS[operation];
  if (!helper) throw new Error('bootstrap admission operation is unsupported');
  const sudo = requiresPassword ? "/usr/bin/sudo -S -k -p ''" : '/usr/bin/sudo -n';
  return `${sudo} -- /usr/bin/flock -n ${GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH} /usr/bin/node ${helper}`;
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
