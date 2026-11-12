import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { FirstAdministratorEnrollment, firstAdministratorClaimMessage } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { DeviceSessionRegistry } from '../src/lib/sonuvi-device-sessions.mjs';
import { SonuviLogin, registerLoginRoutes } from '../src/lib/sonuvi-login.mjs';
import { createMobileSessionToken, verifyMobileToken } from '../src/lib/mobile-auth.mjs';

const password = 'test-only-long-passphrase';
const apiSecret = 'isolated-login-test-secret';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sonuvi-login-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new DeviceSessionRegistry({ directory: path.join(root, 'sessions') });
  let login;
  const authority = new AdministratorAuthority({ stateRoot: root, verifyLoginSession: token => login.verifyAdministratorSession(token) });
  await authority.provisionSigningMaterial();
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: root });
  const binding = { attemptId: 'attempt_0123456789abcdef', targetIdentity: 'target_0123456789abcdef' };
  const pending = await enrollment.create(binding);
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorDeviceId = 'installing-ipad-1234';
  const administratorPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const administratorProof = crypto.sign('sha256', firstAdministratorClaimMessage({ ...binding, enrollmentToken: pending.enrollmentToken, administratorDeviceId }), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const owner = await authority.initializeFromClaim({ ...binding, enrollment, enrollmentToken: pending.enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof });
  const rootToken = await authority.issueAccessToken({ administratorId: owner.administratorId });
  login = new SonuviLogin({ directory: path.join(root, 'login'), authority, sessionRegistry: registry, apiSecret });
  return { root, registry, authority, login, rootToken, owner };
}

test('only existing root ownership can establish login; password and root proof are never persisted', async t => {
  const { login, rootToken, registry } = await fixture(t);
  await assert.rejects(login.configure({ username: 'owner', password }), /ownership_proof_required/);
  const sid = registry.authorize('paired-phone');
  const controller = createMobileSessionToken({ secret: apiSecret, deviceId: 'paired-phone', sessionId: sid });
  await assert.rejects(login.configure({ administratorToken: controller, username: 'owner', password }), /ownership_proof_required/);
  await login.configure({ administratorToken: rootToken, username: 'Owner', password });
  assert.equal((await login.status()).loginConfigured, true);
  const persisted = fs.readFileSync(login.file, 'utf8');
  assert.equal(persisted.includes(password), false);
  assert.equal(persisted.includes(rootToken), false);
  assert.equal(fs.statSync(login.file).mode & 0o777, 0o600);
  await assert.rejects(login.configure({ administratorToken: rootToken, username: 'owner', password }), /already_configured/);
});

test('direct login creates distinct revocable sessions; controller-only TV login never grants admin', async t => {
  const { login, rootToken, authority, registry, owner } = await fixture(t);
  await login.configure({ administratorToken: rootToken, username: 'owner', password });
  const ipad = await login.login({ username: 'owner', password, deviceName: 'iPad' });
  const phone = await login.login({ username: 'owner', password, deviceName: 'iPhone' });
  const tv = await login.login({ username: 'owner', password, deviceName: 'TV', controllerOnly: true });
  assert.notEqual(ipad.deviceId, phone.deviceId);
  assert.equal((await authority.verifyAccessToken(ipad.accessToken)).administratorId, owner.administratorId);
  assert.equal(await authority.verifyAccessToken(tv.accessToken), null);
  assert.ok(verifyMobileToken(tv.accessToken, { secret: apiSecret, scope: 'mobile-api', sessionRegistry: registry }));
  registry.revoke(ipad.deviceId);
  assert.equal(await authority.verifyAccessToken(ipad.accessToken), null);
  assert.ok(await authority.verifyAccessToken(phone.accessToken));
  await assert.rejects(login.configure({ administratorToken: phone.accessToken, username: 'owner', password, replace: true }), /ownership_proof_required/);
});

test('wrong username/password are indistinguishable and password attempts are bounded', async t => {
  const { login, rootToken } = await fixture(t);
  await login.configure({ administratorToken: rootToken, username: 'owner', password });
  await assert.rejects(login.login({ username: 'unknown', password }), { code: 'login_failed', status: 401 });
  await assert.rejects(login.login({ username: 'owner', password: 'wrong-long-passphrase' }), { code: 'login_failed', status: 401 });
  for (let index = 0; index < 8; index++) await assert.rejects(login.login({ username: 'owner', password: 'wrong-long-passphrase' }), /login_failed/);
  await assert.rejects(login.login({ username: 'owner', password }), { code: 'login_temporarily_limited', status: 429 });
});

test('root-authorized credential recovery invalidates older administrator sessions and survives restart', async t => {
  const { root, login, rootToken, registry, authority } = await fixture(t);
  await login.configure({ administratorToken: rootToken, username: 'owner', password });
  const grant = await login.login({ username: 'owner', password });
  const replacement = 'replacement-fixture-passphrase';
  await login.configure({ administratorToken: rootToken, username: 'owner', password: replacement, replace: true });
  assert.equal(await authority.verifyAccessToken(grant.accessToken), null);
  assert.equal(verifyMobileToken(grant.refreshToken, { secret: apiSecret, scope: 'mobile-refresh', sessionRegistry: registry }), null);
  const restarted = new SonuviLogin({ directory: path.join(root, 'login'), authority, sessionRegistry: registry, apiSecret });
  await assert.rejects(restarted.login({ username: 'owner', password }), /login_failed/);
  assert.equal((await restarted.login({ username: 'owner', password: replacement })).role, 'administrator');
});

test('a password change racing an in-flight login cannot issue a stale administrator grant', async t => {
  const { login, rootToken } = await fixture(t);
  await login.configure({ administratorToken: rootToken, username: 'owner', password });
  const derive = login.derive.bind(login);
  let started, release;
  const reached = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let hold = true;
  login.derive = async (...args) => {
    const result = await derive(...args);
    if (hold) { hold = false; started(); await gate; }
    return result;
  };
  const pending = login.login({ username: 'owner', password });
  const rejected = assert.rejects(pending, /login_failed/);
  await reached;
  await login.configure({ administratorToken: rootToken, username: 'owner', password: 'new-fixture-passphrase', replace: true });
  release();
  await rejected;
});

test('root authority revocation invalidates delegated administrator authorization', async t => {
  const { login, rootToken, authority } = await fixture(t);
  await login.configure({ administratorToken: rootToken, username: 'owner', password });
  const grant = await login.login({ username: 'owner', password });
  await authority.revoke();
  assert.equal(await authority.verifyAccessToken(grant.accessToken), null);
  await assert.rejects(login.login({ username: 'owner', password }), /login_failed/);
});

test('login routes reject plaintext LAN and hostile Origin before credential processing', async t => {
  const { login } = await fixture(t);
  const routes = new Map();
  const app = { get: (url, handler) => routes.set(`GET ${url}`, handler), post: (url, handler) => routes.set(`POST ${url}`, handler) };
  registerLoginRoutes(app, { login, canonicalOrigin: 'https://sonuvi.test' });
  const call = async req => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('POST /v1/auth/login')({ headers: {}, body: {}, ...req }, res);
    return res;
  };
  assert.equal((await call({ socket: { remoteAddress: '10.0.0.20' }, headers: { 'x-forwarded-proto': 'https' } })).statusCode, 403);
  assert.equal((await call({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'https://attacker.test' } })).statusCode, 403);
  assert.equal((await call({ socket: { remoteAddress: '127.0.0.1' }, body: { username: 'owner', password, role: 'administrator' } })).statusCode, 400);
  assert.equal(login.attempts.size, 0);
});
