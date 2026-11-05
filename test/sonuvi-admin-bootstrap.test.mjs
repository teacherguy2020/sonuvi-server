import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { runAdministratorBootstrap } from '../src/lib/sonuvi-admin-bootstrap.mjs';
import { FirstAdministratorEnrollment, firstAdministratorClaimMessage } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { FRESH_INSTALL_STATE_CONTRACT } from '../src/lib/sonuvi-fresh-install.mjs';
import { verifyMobileToken } from '../src/lib/mobile-auth.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-admin-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['config', 'data', 'protected', 'install']) await fs.mkdir(path.join(root, directory), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'install', 'state.json'), `${JSON.stringify({ contract: FRESH_INSTALL_STATE_CONTRACT, attemptId, targetIdentity, phase: 'awaiting-administrator-enrollment', releaseId: `sonuvi-${'a'.repeat(64)}` })}\n`, { mode: 0o600 });
  const authority = new AdministratorAuthority({ stateRoot: root });
  await authority.provisionSigningMaterial();
  return root;
}

function administratorClaim(token) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorDeviceId = 'lab-admin-device-0123456789';
  const administratorPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const administratorProof = crypto.sign('sha256', firstAdministratorClaimMessage({ attemptId, targetIdentity, enrollmentToken: token, administratorDeviceId }), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { operation: 'enrollment_claim', enrollmentToken: token, administratorDeviceId, administratorPublicKey, administratorProof };
}

function appFixture() {
  const routes = new Map();
  return { routes, get(route, handler) { routes.set(`GET ${route}`, handler); }, post(route, handler) { routes.set(`POST ${route}`, handler); }, delete(route, handler) { routes.set(`DELETE ${route}`, handler); } };
}

function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, set() {}, setHeader() {}, end() { return this; } }; }
function request(overrides = {}) { return { headers: {}, query: {}, params: {}, body: {}, protocol: 'https', get() { return 'sonuvi-lab.test'; }, ...overrides }; }

test('root enrollment bridge binds claims to the installed attempt and never journals raw credentials', async (t) => {
  const root = await fixture(t);
  const created = await runAdministratorBootstrap({ stateRoot: root, request: { operation: 'enrollment_create' } });
  assert.equal(created.state, 'administrator-enrollment-pending');
  await assert.rejects(runAdministratorBootstrap({ stateRoot: root, request: { operation: 'enrollment_create' } }), /pending/);
  await assert.rejects(runAdministratorBootstrap({ stateRoot: root, request: { ...administratorClaim(created.enrollmentToken), administratorProof: 'invalid' } }), /proof/);
  const claimed = await runAdministratorBootstrap({ stateRoot: root, request: administratorClaim(created.enrollmentToken) });
  assert.equal(claimed.state, 'administrator-enrolled');
  const journal = await fs.readFile(path.join(root, 'install', 'journal.jsonl'), 'utf8');
  const state = await fs.readFile(path.join(root, 'install', 'state.json'), 'utf8');
  assert.equal(journal.includes(created.enrollmentToken), false);
  assert.equal(journal.includes(claimed.administratorAccessToken), false);
  assert.equal(state.includes(created.enrollmentToken), false);
  assert.equal(state.includes(claimed.administratorAccessToken), false);
  const restartedAuthority = new AdministratorAuthority({ stateRoot: root });
  assert.equal((await restartedAuthority.verifyAccessToken(claimed.administratorAccessToken)).administratorId, claimed.administratorId);
  await assert.rejects(runAdministratorBootstrap({ stateRoot: root, request: { operation: 'enrollment_create' } }), /unavailable/);
});

test('a claim interrupted after its single-use record is durable resumes only with the same token and device proof', async (t) => {
  const root = await fixture(t);
  const created = await runAdministratorBootstrap({ stateRoot: root, request: { operation: 'enrollment_create' } });
  const claim = administratorClaim(created.enrollmentToken);
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: root });
  await enrollment.claim({ attemptId, targetIdentity, ...claim });
  await assert.rejects(enrollment.claim({ attemptId, targetIdentity, ...administratorClaim(created.enrollmentToken) }), /already_claimed/);
  const completed = await runAdministratorBootstrap({ stateRoot: root, request: claim });
  assert.equal(completed.state, 'administrator-enrolled');
  assert.equal((await new AdministratorAuthority({ stateRoot: root }).verifyAccessToken(completed.administratorAccessToken)).administratorId, completed.administratorId);
});

test('administrator authorizes exactly one controller through the existing API and both credentials survive a service restart', async (t) => {
  const root = await fixture(t);
  const created = await runAdministratorBootstrap({ stateRoot: root, request: { operation: 'enrollment_create' } });
  const claimed = await runAdministratorBootstrap({ stateRoot: root, request: administratorClaim(created.enrollmentToken) });
  const authority = new AdministratorAuthority({ stateRoot: root });
  const app = appFixture();
  registerMobileRoutes(app, {
    enabled: true,
    apiSecret: 'lab-mobile-api-secret',
    trackIdSecret: 'lab-mobile-track-secret',
    administratorAuthority: authority,
    administratorStateRoot: root,
    getBrowseIndex: async () => ({ builtAt: '2026-11-04T00:00:00.000Z', tracks: [] }),
  });
  const unauthorized = response();
  await app.routes.get('POST /v1/admin/bootstrap/first-controller')(request({ body: { deviceId: 'controller-0123456789' } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  const adminStatus = response();
  await app.routes.get('GET /v1/admin/bootstrap/status')(request({ headers: { authorization: `Bearer ${claimed.administratorAccessToken}` } }), adminStatus);
  assert.equal(adminStatus.statusCode, 200);
  const paired = response();
  await app.routes.get('POST /v1/admin/bootstrap/first-controller')(request({ headers: { authorization: `Bearer ${claimed.administratorAccessToken}` }, body: { deviceId: 'controller-0123456789' } }), paired);
  assert.equal(paired.statusCode, 201);
  assert.equal(verifyMobileToken(paired.body.accessToken, { secret: 'lab-mobile-api-secret', scope: 'mobile-api' }).deviceId, 'controller-0123456789');
  const controllerRoute = response();
  await app.routes.get('GET /v1/mobile/catalog/stats')(request({ headers: { authorization: `Bearer ${paired.body.accessToken}` } }), controllerRoute);
  assert.equal(controllerRoute.statusCode, 200);
  const controllerAdmin = response();
  await app.routes.get('GET /v1/admin/bootstrap/status')(request({ headers: { authorization: `Bearer ${paired.body.accessToken}` } }), controllerAdmin);
  assert.equal(controllerAdmin.statusCode, 401);
  const restartAuthority = new AdministratorAuthority({ stateRoot: root });
  assert.equal((await restartAuthority.verifyAccessToken(claimed.administratorAccessToken)).administratorId, claimed.administratorId);
  const refresh = response();
  await app.routes.get('POST /v1/mobile/session/refresh')(request({ headers: { 'x-mobile-refresh-token': paired.body.refreshToken } }), refresh);
  assert.equal(refresh.statusCode, 200);
  const secondController = response();
  await app.routes.get('POST /v1/admin/bootstrap/first-controller')(request({ headers: { authorization: `Bearer ${claimed.administratorAccessToken}` }, body: { deviceId: 'other-controller-0123456789' } }), secondController);
  assert.equal(secondController.statusCode, 400);
});
