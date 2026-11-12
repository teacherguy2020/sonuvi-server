import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { recoverOwnerFromPrivilegedHost, ownerRecoveryProofMessage, OWNER_RECOVERY_CONTRACT } from '../src/lib/sonuvi-owner-recovery.mjs';

function proof(targetIdentity, overrides = {}) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const request = { contract: OWNER_RECOVERY_CONTRACT, targetIdentity, administratorDeviceId: 'recovery-ipad-1234',
    administratorPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    nonce: crypto.randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides };
  request.administratorProof = crypto.sign('sha256', ownerRecoveryProofMessage(request), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return request;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-host-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { stateRoot: root, getuid: () => 0, targetIdentity: async () => 'sonuvi-target-v1-' + 'a'.repeat(64) };
}

test('host recovery requires actual root admission, bound target, fresh signed proof and single-use nonce', async t => {
  const options = await fixture(t);
  const request = proof(await options.targetIdentity());
  await assert.rejects(recoverOwnerFromPrivilegedHost({ ...options, request, getuid: () => 501 }), /root_authorization/);
  await assert.rejects(recoverOwnerFromPrivilegedHost({ ...options, request: { ...request, targetIdentity: 'wrong' } }), /target_mismatch/);
  await assert.rejects(recoverOwnerFromPrivilegedHost({ ...options, request: { ...request, administratorDeviceId: 'substituted-device' } }), /proof_invalid/);
  await assert.rejects(recoverOwnerFromPrivilegedHost({ ...options, request: { ...request, expiresAt: new Date(0).toISOString() } }), /expired/);
  const result = await recoverOwnerFromPrivilegedHost({ ...options, request });
  const authority = new AdministratorAuthority({ stateRoot: options.stateRoot });
  assert.ok(await authority.verifyRootAccessToken(result.administratorAccessToken));
  await assert.rejects(recoverOwnerFromPrivilegedHost({ ...options, request }), /replayed/);
  const privateState = await fs.readFile(path.join(options.stateRoot, 'protected', 'administrator-identity.json'), 'utf8');
  assert.equal(privateState.includes(result.administratorAccessToken), false);
  assert.equal(privateState.includes(request.administratorProof), false);
});

test('lost-device recovery rotates old root authority but preserves the Server and owner identity', async t => {
  const options = await fixture(t);
  const target = await options.targetIdentity();
  const first = await recoverOwnerFromPrivilegedHost({ ...options, request: proof(target) });
  const authority = new AdministratorAuthority({ stateRoot: options.stateRoot });
  const before = await authority.ownership();
  const second = await recoverOwnerFromPrivilegedHost({ ...options, request: proof(target, { administratorDeviceId: 'replacement-device' }) });
  const after = await authority.ownership();
  assert.equal(second.administratorId, first.administratorId);
  assert.equal(after.serverId, before.serverId);
  assert.notEqual(after.authorityGeneration, before.authorityGeneration);
  assert.equal(await authority.verifyRootAccessToken(first.administratorAccessToken), null);
  assert.ok(await authority.verifyRootAccessToken(second.administratorAccessToken));
  assert.equal((await authority.administratorRecord()).deviceId, 'replacement-device');
});
