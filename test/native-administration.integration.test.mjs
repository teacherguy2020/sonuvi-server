import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';
import {
  ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
  administratorSessionProofMessage,
  runAdministratorSession,
} from '../src/lib/sonuvi-admin-session.mjs';
import { FirstAdministratorEnrollment, firstAdministratorClaimMessage } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { registerNativeAdministratorConfigurationRoutes } from '../src/routes/admin-native-configuration.routes.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';
const administratorDeviceId = 'native-admin-device-0123456789';
const fixedNow = Date.parse('2026-11-08T12:00:00.000Z');

function publicSpki(pair) {
  return pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function sign(pair, message) {
  return crypto.sign('sha256', message, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    patch(route, handler) { routes.set(`PATCH ${route}`, handler); },
    put(route, handler) { routes.set(`PUT ${route}`, handler); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function invoke(app, route, headers = {}) {
  const res = response();
  await app.routes.get(`GET ${route}`)({ headers }, res);
  return res;
}

async function enrolledFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-native-admin-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let currentNow = fixedNow;
  const now = () => currentNow;
  const authority = new AdministratorAuthority({ stateRoot: root, now });
  await authority.provisionSigningMaterial();
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: root, now });
  const created = await enrollment.create({ attemptId, targetIdentity });
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorPublicKey = publicSpki(pair);
  const administratorProof = sign(pair, firstAdministratorClaimMessage({
    attemptId,
    targetIdentity,
    enrollmentToken: created.enrollmentToken,
    administratorDeviceId,
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
  const request = (operation = 'issue_session', overrides = {}) => {
    const value = {
      contract: ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
      operation,
      targetIdentity,
      administratorDeviceId,
      nonce: crypto.randomBytes(24).toString('base64url'),
      expiresAt: new Date(currentNow + 60_000).toISOString(),
      ...overrides,
    };
    if (operation === 'rebind_administrator') value.administratorPublicKey = overrides.administratorPublicKey || administratorPublicKey;
    if (!Object.hasOwn(overrides, 'administratorProof')) value.administratorProof = sign(pair, administratorSessionProofMessage(value));
    return value;
  };
  return {
    root,
    authority,
    pair,
    administrator,
    now,
    request,
    advance(milliseconds) { currentNow += milliseconds; },
  };
}

function registerRoutes(authority) {
  const app = createApp();
  registerNativeAdministratorConfigurationRoutes(app, {
    administratorAuthority: authority,
    readConfig: async () => ({
      projectName: 'Sonuvi',
      environment: 'home',
      timezone: 'America/Chicago',
      ports: { api: 3101, ui: 8101 },
      mpd: { host: 'moode.local', port: 6600 },
      moode: { sshHost: 'moode.local', sshUser: 'moode', baseUrl: 'http://moode.local' },
      paths: { musicLibraryRoot: '/media/music', moodeUsbMount: '/media/usb', piMountBase: '/mnt/music', podcastRoot: '/mnt/podcasts' },
      features: { podcasts: true, ratings: true, radio: true, albumPersonnel: true, lastfm: false },
      trackKey: 'legacy-track-key-must-not-leak',
    }),
    getServerIdentity: async () => ({ mode: 'immutable-release', releaseId: `sonuvi-${'a'.repeat(64)}` }),
    getBrowseIndexStatus: async () => ({
      available: true,
      source: 'persisted',
      builtAt: '2026-11-08T11:55:00.000Z',
      dbUpdateAt: '2026-11-08T11:54:00.000Z',
      counts: { artists: 12, albums: 34, tracks: 56 },
      refresh: { running: false },
    }),
    getLibraryHealthStatus: async () => ({
      available: true,
      lastSuccessfulAt: '2026-11-08T11:55:00.000Z',
      counts: { albums: 34, tracks: 56 },
      refresh: { running: false },
    }),
  });
  return app;
}

test('enrolled P-256 proof issues a short-lived session that authorizes all native read APIs only', async (t) => {
  const fixture = await enrolledFixture(t);
  const session = await runAdministratorSession({
    request: fixture.request(),
    stateRoot: fixture.root,
    authority: fixture.authority,
    now: fixture.now,
  });
  assert.equal(session.contract, 'sonuvi.administrator-session.v1');
  assert.equal(session.state, 'issued');
  assert.equal(session.administratorId, fixture.administrator.administratorId);
  assert.equal(Date.parse(session.expiresAt) - fixedNow, 15 * 60 * 1000);

  const app = registerRoutes(fixture.authority);
  const headers = { authorization: `Bearer ${session.administratorAccessToken}` };
  const configuration = await invoke(app, '/v1/admin/configuration', headers);
  assert.equal(configuration.statusCode, 200);
  assert.equal(configuration.body.contract, 'sonuvi.admin.configuration.v1');
  assert.equal(configuration.body.server.release.releaseId, `sonuvi-${'a'.repeat(64)}`);
  assert.equal(configuration.body.editability.mutationsAvailable, false);
  assert.equal(JSON.stringify(configuration.body).includes('legacy-track-key-must-not-leak'), false);

  const library = await invoke(app, '/v1/admin/library/status', headers);
  assert.equal(library.statusCode, 200);
  assert.equal(library.body.contract, 'sonuvi.admin.library-status.v1');
  assert.deepEqual(library.body.counts, { artists: 12, albums: 34, tracks: 56 });

  const dlna = await invoke(app, '/v1/admin/dlna', headers);
  assert.equal(dlna.statusCode, 200);
  assert.deepEqual(dlna.body, {
    ok: true,
    contract: 'sonuvi.admin.dlna.v1',
    status: 'disabled',
    installed: true,
    enabled: false,
    reason: 'operator_configuration_required',
  });

  const controllerToken = createMobileSessionToken({ secret: 'ordinary-controller-secret', deviceId: 'controller-device-0123456789' });
  for (const route of ['/v1/admin/configuration', '/v1/admin/library/status', '/v1/admin/dlna']) {
    for (const rejectedHeaders of [
      { authorization: `Bearer ${controllerToken}` },
      { 'x-track-key': 'legacy-browser-track-key' },
    ]) {
      const rejected = await invoke(app, route, rejectedHeaders);
      assert.equal(rejected.statusCode, 401);
      assert.deepEqual(rejected.body, { ok: false, code: 'administrator_authorization_required' });
    }
  }

  fixture.advance((15 * 60 * 1000) + 1_000);
  const expired = await invoke(app, '/v1/admin/configuration', headers);
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(expired.body, { ok: false, code: 'administrator_authorization_required' });
  await assert.rejects(
    runAdministratorSession({
      request: fixture.request('issue_session', { expiresAt: new Date(fixedNow).toISOString() }),
      stateRoot: fixture.root,
      authority: fixture.authority,
      now: fixture.now,
    }),
    /proof is expired/,
  );
});

test('legacy-v1 record fails closed until explicit proof-checked rebind, then permits a new session', async (t) => {
  const fixture = await enrolledFixture(t);
  const identityPath = path.join(fixture.root, 'protected', 'administrator-identity.json');
  const legacy = JSON.parse(await fs.readFile(identityPath, 'utf8'));
  delete legacy.administratorPublicKey;
  legacy.version = 1;
  await fs.writeFile(identityPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  await assert.rejects(
    runAdministratorSession({ request: fixture.request(), stateRoot: fixture.root, authority: fixture.authority, now: fixture.now }),
    /administrator_rebind_required/,
  );
  const replacement = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const wrongRebind = fixture.request('rebind_administrator', { administratorPublicKey: publicSpki(replacement) });
  wrongRebind.administratorProof = sign(replacement, administratorSessionProofMessage(wrongRebind));
  await assert.rejects(
    runAdministratorSession({ request: wrongRebind, stateRoot: fixture.root, authority: fixture.authority, now: fixture.now }),
    /administrator_rebind_key_mismatch/,
  );

  const rebound = await runAdministratorSession({
    request: fixture.request('rebind_administrator'),
    stateRoot: fixture.root,
    authority: fixture.authority,
    now: fixture.now,
  });
  assert.equal(rebound.state, 'administrator-rebound');
  const session = await runAdministratorSession({ request: fixture.request(), stateRoot: fixture.root, authority: fixture.authority, now: fixture.now });
  assert.equal(session.state, 'issued');
  assert.equal((await fixture.authority.administratorRecord()).legacy, false);
});
