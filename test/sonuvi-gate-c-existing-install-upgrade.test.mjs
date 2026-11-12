import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION,
  GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
  GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
  normalizeGateCExistingInstallUpgradeResponse,
  runGateCExistingInstallUpgrade,
} from '../src/lib/sonuvi-gate-c-existing-install-upgrade.mjs';

const targetIdentity = `sonuvi-target-v1-${'a'.repeat(64)}`;
const otherTargetIdentity = `sonuvi-target-v1-${'b'.repeat(64)}`;
const releaseId = `sonuvi-${'c'.repeat(64)}`;
const previousReleaseId = `sonuvi-${'d'.repeat(64)}`;

test('fixed interrupted-upgrade recovery is bound to the verified target and returns a typed result', async () => {
  const adapter = Object.freeze({});
  let recoveryInput;
  const result = await runGateCExistingInstallUpgrade({
    request: { operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION, targetIdentity },
    uid: 0,
    architecture: 'arm64',
    platform: 'linux',
    readTarget: async () => targetIdentity,
    verifyTargetCompatibility: async () => ({ supported: true }),
    adapterFactory: () => adapter,
    recover: async (input) => {
      recoveryInput = input;
      return { recovered: true, previousReleaseId };
    },
  });

  assert.deepEqual(recoveryInput, {
    layoutRoot: '/opt/sonuvi',
    stateRoot: '/var/lib/sonuvi',
    ownerUID: 0,
    targetIdentity,
    adapter,
  });
  assert.deepEqual(result, {
    contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
    operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION,
    ok: true,
    state: 'recovered',
    previousReleaseId,
  });
  assert.deepEqual(normalizeGateCExistingInstallUpgradeResponse(result, { operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION }), result);
});

test('fixed interrupted-upgrade recovery refuses a changed target before touching recovery state', async () => {
  let recoveryCalled = false;
  const result = await runGateCExistingInstallUpgrade({
    request: { operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION, targetIdentity },
    uid: 0,
    architecture: 'arm64',
    platform: 'linux',
    readTarget: async () => otherTargetIdentity,
    verifyTargetCompatibility: async () => ({ supported: true }),
    recover: async () => { recoveryCalled = true; return { recovered: true, previousReleaseId }; },
  });
  assert.equal(recoveryCalled, false);
  assert.deepEqual(result, {
    contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
    operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION,
    ok: false,
    code: 'upgrade_target_mismatch',
  });
  assert.deepEqual(normalizeGateCExistingInstallUpgradeResponse(result, { operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION }), result);
});

test('upgrade responses accept only exact operation-specific fields and typed failure codes', () => {
  const success = {
    contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    ok: true,
    state: 'committed',
    releaseId,
    previousReleaseId,
    attemptId: 'boot_upgrade_response_fixture_20261109',
    targetIdentity,
    transactionId: '3ac46134-94f7-45ea-862b-345fdf598ed0',
  };
  assert.deepEqual(normalizeGateCExistingInstallUpgradeResponse(success, {
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    attemptId: success.attemptId,
    targetIdentity,
  }), success);
  assert.throws(() => normalizeGateCExistingInstallUpgradeResponse({ ...success, diagnostic: 'unbounded text' }, {
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    attemptId: success.attemptId,
    targetIdentity,
  }), /upgrade_response_invalid/);
  assert.throws(() => normalizeGateCExistingInstallUpgradeResponse({ ...success, transactionId: 'not-a-uuid' }, {
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    attemptId: success.attemptId,
    targetIdentity,
  }), /upgrade_response_invalid/);
  assert.throws(() => normalizeGateCExistingInstallUpgradeResponse({
    contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    ok: false,
    code: 'upgrade_activation_failed',
    message: 'do not accept exception text',
  }, { operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION }), /upgrade_response_invalid/);
  assert.throws(() => normalizeGateCExistingInstallUpgradeResponse({
    contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT,
    operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
    ok: false,
    code: 'arbitrary_exception',
  }, { operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION }), /upgrade_response_invalid/);
});
