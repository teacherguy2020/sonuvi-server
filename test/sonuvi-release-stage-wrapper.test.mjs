import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_C_STAGE_FAILURE_CODES,
  GATE_C_STAGE_RESPONSE_CONTRACT,
  gateCStageFailureCode,
  gateCStageFailureResponse,
  gateCStageSuccessResponse,
  runGateCStageRelease,
} from '../scripts/sonuvi-release-stage.mjs';

test('stage wrapper exposes only the reviewed failure vocabulary', () => {
  assert.deepEqual(GATE_C_STAGE_FAILURE_CODES, [
    'stage_input_invalid',
    'stage_release_identity_mismatch',
    'stage_release_digest_mismatch',
    'stage_target_mismatch',
    'stage_attempt_mismatch',
    'stage_conflict',
    'stage_permission_denied',
    'stage_helper_unavailable',
    'stage_internal_error',
  ]);
  for (const [message, expected] of [
    ['release stage header is missing', 'stage_input_invalid'],
    ['release metadata signature is invalid', 'stage_release_identity_mismatch'],
    ['release signing key ID is invalid', 'stage_release_identity_mismatch'],
    ['release artifact digest does not match metadata', 'stage_release_digest_mismatch'],
    ['release_stage_target_identity_mismatch', 'stage_target_mismatch'],
    ['release_stage_attempt_binding_mismatch', 'stage_attempt_mismatch'],
    ['existing staged release manifest mismatch', 'stage_conflict'],
    ['permission denied', 'stage_permission_denied'],
    ['Cannot find module fixed helper', 'stage_helper_unavailable'],
    ['/private/secret/stack text', 'stage_internal_error'],
  ]) {
    assert.equal(gateCStageFailureCode(new Error(message)), expected);
  }
});

test('stage wrapper failure and success responses are structured and path-free', async () => {
  const failed = gateCStageFailureResponse(new Error('/var/lib/sonuvi-bootstrap/releases/secret'));
  assert.deepEqual(failed, {
    ok: false,
    contract: GATE_C_STAGE_RESPONSE_CONTRACT,
    operation: 'stage_release',
    code: 'stage_internal_error',
  });
  const success = gateCStageSuccessResponse({
    state: 'staged',
    releaseId: `sonuvi-${'a'.repeat(64)}`,
    keyId: 'sonuvi-release-2026',
    attemptId: 'boot_stage_wrapper_20261107',
    targetIdentity: `sonuvi-target-v1-${'b'.repeat(64)}`,
    releaseRoot: '/var/lib/sonuvi-bootstrap/releases/secret',
  });
  assert.equal('releaseRoot' in success, false);
  assert.equal(success.contract, GATE_C_STAGE_RESPONSE_CONTRACT);

  const denied = await runGateCStageRelease({ uid: 501 });
  assert.equal(denied.exitCode, 77);
  assert.deepEqual(denied.response, {
    ok: false,
    contract: GATE_C_STAGE_RESPONSE_CONTRACT,
    operation: 'stage_release',
    code: 'stage_permission_denied',
  });
});

test('unexpected production-wrapper failure is fail-closed and never echoes exception text', async () => {
  const result = await runGateCStageRelease({
    uid: 0,
    execute: async () => { throw new Error('unexpected /private/path credential=secret'); },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.response, {
    ok: false,
    contract: GATE_C_STAGE_RESPONSE_CONTRACT,
    operation: 'stage_release',
    code: 'stage_internal_error',
  });
});
