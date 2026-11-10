import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH,
  GATE_C_BOOTSTRAP_ADMISSION_HELPERS,
  GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT,
  GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS,
  bootstrapReplacementOperationId,
  gateCBootstrapAdmissionCommand,
  gateCBootstrapKitReplacementCommand,
  normalizeGateCBootstrapKitReplacementRequest,
  normalizeGateCBootstrapKitReplacementResponse,
} from '../src/lib/sonuvi-gate-c-bootstrap-replacement-contract.mjs';

const request = Object.freeze({
  operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace,
  operationId: 'bkr_11111111-1111-4111-8111-111111111111',
  targetIdentity: `sonuvi-target-v1-${'a'.repeat(64)}`,
  expectedServerReleaseId: `sonuvi-${'b'.repeat(64)}`,
  expectedPreviousBootstrapKitSHA256: 'c'.repeat(64),
  replacementReleaseId: `sonuvi-${'d'.repeat(64)}`,
  replacementKitSHA256: 'e'.repeat(64),
  replacementKitBytes: 238_592,
  envelope: { contract: 'sonuvi.gate-c-release-envelope.v1', keyId: 'fixture-key', payload: {}, signature: 'signature' },
});

test('bootstrap replacement request requires durable target, current release, prior kit, approved release, signed envelope, digest, and size bindings', () => {
  const normalized = normalizeGateCBootstrapKitReplacementRequest(request);
  assert.deepEqual({ ...normalized, signedEnvelopeSHA256: undefined }, { ...request, signedEnvelopeSHA256: undefined });
  assert.match(normalized.signedEnvelopeSHA256, /^[a-f0-9]{64}$/);
  assert.match(bootstrapReplacementOperationId(), /^bkr_[0-9a-f-]{36}$/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementRequest({ ...request, expectedPreviousBootstrapKitSHA256: 'x'.repeat(64) }), /digest/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementRequest({ ...request, replacementKitBytes: 0 }), /size/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementRequest({ ...request, targetIdentity: 'sonuvi-target-v1-invalid' }), /target identity/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementRequest({ ...request, operation: 'arbitrary_shell' }), /unsupported/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementRequest({ ...request, extra: true }), /request is invalid/);
});

test('replacement command is fixed, password-authorized by default, and does not interpolate paths or shell syntax', () => {
  const command = gateCBootstrapKitReplacementCommand(request);
  assert.ok(command.startsWith("/usr/bin/sudo -S -k -p '' -- /bin/sh -s -- replace_bootstrap_kit "));
  assert.ok(command.includes(request.operationId));
  assert.ok(command.includes(request.targetIdentity));
  assert.ok(command.includes(request.expectedServerReleaseId));
  assert.ok(command.includes(request.expectedPreviousBootstrapKitSHA256));
  assert.ok(command.includes(request.replacementReleaseId));
  assert.ok(command.endsWith(Buffer.from(JSON.stringify(request.envelope)).toString('base64url')));
  assert.equal(gateCBootstrapKitReplacementCommand(request, { requiresPassword: false }).startsWith('/usr/bin/sudo -n -- /bin/sh -s --'), true);
  assert.equal(GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH, '/var/lib/sonuvi-bootstrap/bootstrap-admission.lock');
});

test('updated release staging and activation commands acquire the common lock before loading fixed helpers', () => {
  for (const [operation, helper] of Object.entries(GATE_C_BOOTSTRAP_ADMISSION_HELPERS)) {
    assert.equal(
      gateCBootstrapAdmissionCommand(operation),
      `/usr/bin/sudo -S -k -p '' -- /usr/bin/flock -n ${GATE_C_BOOTSTRAP_ADMISSION_LOCK_PATH} /usr/bin/node ${helper}`,
    );
  }
  assert.throws(() => gateCBootstrapAdmissionCommand('first_install_or_arbitrary_command'), /unsupported/);
});

test('replacement response distinguishes no-recovery from bound transaction outcomes', () => {
  const noRecovery = {
    contract: GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT,
    operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover,
    ok: true,
    state: 'no_recovery_required',
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
  };
  assert.deepEqual(normalizeGateCBootstrapKitReplacementResponse(noRecovery, {
    operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover,
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
  }), noRecovery);
  assert.throws(() => normalizeGateCBootstrapKitReplacementResponse({
    ...noRecovery,
    operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace,
  }, { operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace }), /state/);

  const replaced = {
    contract: GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT,
    operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.replace,
    ok: true,
    state: 'replaced',
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
    expectedServerReleaseId: request.expectedServerReleaseId,
    previousBootstrapKitSHA256: request.expectedPreviousBootstrapKitSHA256,
    replacementReleaseId: request.replacementReleaseId,
    replacementKitSHA256: request.replacementKitSHA256,
  };
  assert.deepEqual(normalizeGateCBootstrapKitReplacementResponse(replaced, {
    operation: request.operation,
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
    expectedServerReleaseId: request.expectedServerReleaseId,
    expectedPreviousBootstrapKitSHA256: request.expectedPreviousBootstrapKitSHA256,
    replacementReleaseId: request.replacementReleaseId,
    replacementKitSHA256: request.replacementKitSHA256,
  }), replaced);
  assert.throws(() => normalizeGateCBootstrapKitReplacementResponse({ ...replaced, replacementKitSHA256: 'f'.repeat(64) }, {
    operation: request.operation,
    replacementKitSHA256: request.replacementKitSHA256,
  }), /digest binding/);
});

test('replacement response rejects unknown typed errors and unbound operation identities', () => {
  const failure = {
    contract: GATE_C_BOOTSTRAP_KIT_REPLACEMENT_CONTRACT,
    operation: request.operation,
    ok: false,
    code: 'replacement_signature_invalid',
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
  };
  assert.equal(normalizeGateCBootstrapKitReplacementResponse(failure, {
    operation: request.operation,
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
  }).code, 'replacement_signature_invalid');
  assert.throws(() => normalizeGateCBootstrapKitReplacementResponse({ ...failure, code: 'raw-exception-text' }, {
    operation: request.operation,
  }), /code/);
  assert.throws(() => normalizeGateCBootstrapKitReplacementResponse(failure, {
    operation: request.operation,
    operationId: 'bkr_22222222-2222-4222-8222-222222222222',
  }), /binding/);
});
