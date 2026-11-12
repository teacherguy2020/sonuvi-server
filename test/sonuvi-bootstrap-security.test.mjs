import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { firstAdministratorClaimMessage, FirstAdministratorEnrollment, normalizeBootstrapOperation, verifyBootstrapHostKey } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { PrivilegedProvisioningAdapter, markAttemptOwnedRoot } from '../src/lib/sonuvi-privileged-provisioning.mjs';
import { renderFreshSystemdUnits } from '../src/lib/sonuvi-fresh-install.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';
const releaseId = `sonuvi-${'b'.repeat(64)}`;
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-bootstrap-security-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
function claimPayload(token, target = targetIdentity) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorDeviceId = 'device_0123456789abcdef';
  const administratorPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const administratorProof = crypto.sign('sha256', firstAdministratorClaimMessage({ attemptId, targetIdentity: target, enrollmentToken: token, administratorDeviceId }), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { administratorDeviceId, administratorPublicKey, administratorProof };
}

test('host-key policy pins known keys and requires an explicit first trust', () => {
  const fingerprint = 'SHA256:AbCdEf1234567890+/=';
  assert.equal(verifyBootstrapHostKey({ presentedFingerprint: fingerprint }).code, 'host_key_unknown');
  assert.equal(verifyBootstrapHostKey({ presentedFingerprint: fingerprint, trustUnknown: true }).accepted, true);
  assert.equal(verifyBootstrapHostKey({ knownFingerprint: fingerprint, presentedFingerprint: fingerprint }).code, 'host_key_pinned');
  assert.equal(verifyBootstrapHostKey({ knownFingerprint: fingerprint, presentedFingerprint: 'SHA256:Other1234567890+/=' }).code, 'host_key_changed');
});

test('bootstrap protocol permits only fixed operations and redacts command-like payloads', () => {
  const valid = normalizeBootstrapOperation({ version: 1, operation: 'status', attemptId, targetIdentity, payload: {} });
  assert.equal(valid.operation, 'status');
  assert.throws(() => normalizeBootstrapOperation({ version: 1, operation: 'shell', attemptId, targetIdentity }), /unsupported/);
  assert.throws(() => normalizeBootstrapOperation({ version: 1, operation: 'install', attemptId, targetIdentity, payload: { command: 'id' } }), /forbidden/);
});

test('first-administrator enrollment is attempt-bound, expiring, single-use, and stores no raw token', async (t) => {
  const root = await fixture(t); let clock = Date.parse('2026-11-04T12:00:00.000Z'); const enrollment = new FirstAdministratorEnrollment({ stateRoot: root, now: () => clock, ttlMs: 1000 });
  const created = await enrollment.create({ attemptId, targetIdentity });
  const raw = await fs.readFile(path.join(root, 'protected', 'first-administrator-enrollment.json'), 'utf8');
  assert.equal(raw.includes(created.enrollmentToken), false);
  await assert.rejects(enrollment.create({ attemptId, targetIdentity }), /pending/);
  await assert.rejects(enrollment.claim({ attemptId, targetIdentity: 'machine_wrong_0123456789', enrollmentToken: created.enrollmentToken, ...claimPayload(created.enrollmentToken, 'machine_wrong_0123456789') }), /mismatch/);
  const claim = claimPayload(created.enrollmentToken);
  const claimed = await enrollment.claim({ attemptId, targetIdentity, enrollmentToken: created.enrollmentToken, ...claim });
  assert.equal(claimed.status, 'claimed');
  assert.equal((await enrollment.claim({ attemptId, targetIdentity, enrollmentToken: created.enrollmentToken, ...claim })).administratorPublicKeyHash, claimed.administratorPublicKeyHash);
  await assert.rejects(enrollment.claim({ attemptId, targetIdentity, enrollmentToken: created.enrollmentToken, ...claimPayload(created.enrollmentToken) }), /already_claimed/);
  const later = new FirstAdministratorEnrollment({ stateRoot: path.join(root, 'later'), now: () => clock, ttlMs: 1 }); const expiring = await later.create({ attemptId, targetIdentity }); clock += 2;
  await assert.rejects(later.claim({ attemptId, targetIdentity, enrollmentToken: expiring.enrollmentToken, ...claimPayload(expiring.enrollmentToken) }), /expired/);
});

test('privileged adapter accepts only fixed units and attempt-owned cleanup', async (t) => {
  const root = await fixture(t); const calls = []; const systemd = { async daemonReload() { calls.push('reload'); }, async enableAndStart(unit) { calls.push(`start:${unit}`); }, async isHealthy(unit) { calls.push(`health:${unit}`); return true; } };
  const ownedRoot = path.join(root, 'owned'); const adapter = new PrivilegedProvisioningAdapter({ targetIdentity, attemptId, unitRoot: path.join(root, 'units'), ownedRoot, systemd }); const units = renderFreshSystemdUnits({ apiTemplate: 'api=@RELEASE_ID@', webTemplate: 'web=@RELEASE_ID@', releaseId });
  await adapter.execute({ operation: 'write_units', targetIdentity, attemptId, units }); await adapter.execute({ operation: 'daemon_reload', targetIdentity, attemptId }); await adapter.execute({ operation: 'enable_start', targetIdentity, attemptId }); await adapter.execute({ operation: 'verify_health', targetIdentity, attemptId });
  assert.deepEqual(calls, ['reload', 'start:sonuvi-api.service', 'start:sonuvi-web.service', 'health:sonuvi-api.service', 'health:sonuvi-web.service']);
  await assert.rejects(adapter.execute({ operation: 'shell', targetIdentity, attemptId }), /rejected/);
  await assert.rejects(adapter.execute({ operation: 'daemon_reload', targetIdentity: 'machine_wrong_0123456789', attemptId }), /mismatch/);
  await markAttemptOwnedRoot({ ownedRoot, attemptId }); await adapter.execute({ operation: 'cleanup_attempt', targetIdentity, attemptId }); await assert.rejects(fs.lstat(ownedRoot), { code: 'ENOENT' });
});
