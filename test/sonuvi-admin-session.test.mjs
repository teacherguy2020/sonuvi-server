import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import {
  ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
  administratorSessionProofMessage,
  runAdministratorSession,
} from '../src/lib/sonuvi-admin-session.mjs';
import { FirstAdministratorEnrollment, firstAdministratorClaimMessage } from '../src/lib/sonuvi-bootstrap-security.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';
const administratorDeviceId = 'native-admin-device-0123456789';
const fixedNow = Date.parse('2026-11-08T12:00:00.000Z');

function now() { return fixedNow; }

function publicSpki(pair) {
  return pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function sign(pair, message) {
  return crypto.sign('sha256', message, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-admin-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new AdministratorAuthority({ stateRoot: root, now });
  await authority.provisionSigningMaterial();
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: root, now });
  const created = await enrollment.create({ attemptId, targetIdentity });
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorPublicKey = publicSpki(pair);
  const administratorProof = sign(pair, firstAdministratorClaimMessage({
    attemptId, targetIdentity, enrollmentToken: created.enrollmentToken, administratorDeviceId,
  }));
  const administrator = await authority.initializeFromClaim({
    enrollment,
    attemptId,
    targetIdentity,
    enrollmentToken: created.enrollmentToken,
    administratorDeviceId,
    administratorPublicKey,
    administratorProof,
  });
  return { root, authority, pair, administrator };
}

function issueRequest(pair, overrides = {}) {
  const request = {
    contract: ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
    operation: 'issue_session',
    targetIdentity,
    administratorDeviceId,
    nonce: crypto.randomBytes(24).toString('base64url'),
    expiresAt: new Date(fixedNow + 60_000).toISOString(),
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'administratorProof')) request.administratorProof = sign(pair, administratorSessionProofMessage(request));
  return request;
}

function rebindRequest(pair, overrides = {}) {
  const request = {
    contract: ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
    operation: 'rebind_administrator',
    targetIdentity,
    administratorDeviceId,
    administratorPublicKey: publicSpki(pair),
    nonce: crypto.randomBytes(24).toString('base64url'),
    expiresAt: new Date(fixedNow + 60_000).toISOString(),
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'administratorProof')) request.administratorProof = sign(pair, administratorSessionProofMessage(request));
  return request;
}

test('issues a short-lived administrator session from a fresh bound P-256 proof without retaining proof material', async (t) => {
  const { root, authority, pair, administrator } = await fixture(t);
  const request = issueRequest(pair);
  const result = await runAdministratorSession({ request, stateRoot: root, authority, now });
  assert.equal(result.contract, 'sonuvi.administrator-session.v1');
  assert.equal(result.state, 'issued');
  assert.equal(result.role, 'administrator');
  assert.equal(result.administratorId, administrator.administratorId);
  assert.equal((await authority.verifyAccessToken(result.administratorAccessToken)).administratorId, administrator.administratorId);
  assert.equal(Date.parse(result.expiresAt) - fixedNow, 15 * 60 * 1000);
  const ledger = await fs.readFile(path.join(root, 'protected', 'administrator-session-nonces.json'), 'utf8');
  assert.equal(ledger.includes(request.nonce), false);
  assert.equal(ledger.includes(result.administratorAccessToken), false);
});

test('rejects invalid proofs, expired proofs, target mismatches, and replayed nonces', async (t) => {
  const { root, authority, pair } = await fixture(t);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const invalid = issueRequest(pair);
  invalid.administratorProof = sign(other, administratorSessionProofMessage(invalid));
  await assert.rejects(runAdministratorSession({ request: invalid, stateRoot: root, authority, now }), /proof is invalid/);

  const expired = issueRequest(pair, { expiresAt: new Date(fixedNow - 1).toISOString() });
  await assert.rejects(runAdministratorSession({ request: expired, stateRoot: root, authority, now }), /proof is expired/);

  const wrongTarget = issueRequest(pair, { targetIdentity: 'machine_abcdef0123456789' });
  await assert.rejects(runAdministratorSession({ request: wrongTarget, stateRoot: root, authority, now }), /identity_mismatch/);

  const valid = issueRequest(pair);
  await runAdministratorSession({ request: valid, stateRoot: root, authority, now });
  await assert.rejects(runAdministratorSession({ request: valid, stateRoot: root, authority, now }), /replayed/);
});

test('rejects controller and legacy Track-Key material rather than treating either as administrator authority', async (t) => {
  const { root, authority, pair } = await fixture(t);
  const controller = { ...issueRequest(pair), controllerToken: 'ordinary-mobile-bearer' };
  await assert.rejects(runAdministratorSession({ request: controller, stateRoot: root, authority, now }), /unsupported fields/);
  const trackKey = { ...issueRequest(pair), trackKey: 'legacy-browser-track-key' };
  await assert.rejects(runAdministratorSession({ request: trackKey, stateRoot: root, authority, now }), /unsupported fields/);
  const controllerAsProof = issueRequest(pair, { administratorProof: 'ordinary-mobile-bearer' });
  await assert.rejects(runAdministratorSession({ request: controllerAsProof, stateRoot: root, authority, now }), /proof is invalid/);
});

test('legacy enrolled records fail closed until an explicit root-side proof-checked rebind rotates outstanding tokens', async (t) => {
  const { root, authority, pair, administrator } = await fixture(t);
  const oldToken = await authority.issueAccessToken({ administratorId: administrator.administratorId });
  const identityPath = path.join(root, 'protected', 'administrator-identity.json');
  const legacy = JSON.parse(await fs.readFile(identityPath, 'utf8'));
  delete legacy.administratorPublicKey;
  legacy.version = 1;
  await fs.writeFile(identityPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  await assert.rejects(runAdministratorSession({ request: issueRequest(pair), stateRoot: root, authority, now }), /administrator_rebind_required/);
  const replacement = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await assert.rejects(runAdministratorSession({ request: rebindRequest(replacement), stateRoot: root, authority, now }), /administrator_rebind_key_mismatch/);
  const rebound = await runAdministratorSession({ request: rebindRequest(pair), stateRoot: root, authority, now });
  assert.equal(rebound.state, 'administrator-rebound');
  assert.equal((await authority.verifyAccessToken(oldToken)), null);
  const record = await authority.administratorRecord();
  assert.equal(record.legacy, false);
  assert.equal(record.administratorPublicKey, publicSpki(pair));
  const session = await runAdministratorSession({ request: issueRequest(pair), stateRoot: root, authority, now });
  assert.equal((await authority.verifyAccessToken(session.administratorAccessToken)).administratorId, administrator.administratorId);
});

test('enrollment records and durable identity preserve the verified administrator SPKI', async (t) => {
  const { root, authority, pair } = await fixture(t);
  const identity = await authority.administratorRecord();
  assert.equal(identity.version, 2);
  assert.equal(identity.administratorPublicKey, publicSpki(pair));
  const enrollment = JSON.parse(await fs.readFile(path.join(root, 'protected', 'first-administrator-enrollment.json'), 'utf8'));
  assert.equal(enrollment.version, 2);
  assert.equal(enrollment.administratorPublicKey, publicSpki(pair));
});
