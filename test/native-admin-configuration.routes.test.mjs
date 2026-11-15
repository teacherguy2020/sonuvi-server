import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';
import { firstAdministratorClaimMessage, FirstAdministratorEnrollment } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { registerNativeAdministratorConfigurationRoutes } from '../src/routes/admin-native-configuration.routes.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';
const administratorDeviceId = 'native-admin-device-0123456789';
const sentinels = Object.freeze({
  trackKey: 'native-admin-track-key-secret',
  lastfmKey: 'native-admin-lastfm-secret',
  pushover: 'native-admin-pushover-secret',
});

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

function request(overrides = {}) {
  return { headers: {}, ...overrides };
}

function publicSpki(pair) {
  return pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function sampleConfig() {
  return {
    projectName: 'Sonuvi',
    environment: 'home',
    timezone: 'America/Chicago',
    ports: { api: 3101, ui: 8101 },
    trackKey: sentinels.trackKey,
    mpd: { host: 'moode.local', port: 6600 },
    moode: { sshHost: 'moode.local', sshUser: 'moode', baseUrl: 'http://moode.local' },
    paths: { musicLibraryRoot: '/media/music', moodeUsbMount: '/media/usb', piMountBase: '/mnt/music', podcastRoot: '/mnt/podcasts' },
    features: { podcasts: true, ratings: true, radio: true, albumPersonnel: true, lastfm: false },
    notifications: { pushover: { token: sentinels.pushover, userKey: 'native-admin-pushover-user-secret' } },
    lastfm: { apiKey: sentinels.lastfmKey, username: 'listener' },
  };
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-native-admin-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new AdministratorAuthority({ stateRoot: root });
  await authority.provisionSigningMaterial();
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: root });
  const created = await enrollment.create({ attemptId, targetIdentity });
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const administratorPublicKey = publicSpki(pair);
  const administratorProof = crypto.sign('sha256', firstAdministratorClaimMessage({
    attemptId,
    targetIdentity,
    enrollmentToken: created.enrollmentToken,
    administratorDeviceId,
  }), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const administrator = await authority.initializeFromClaim({
    enrollment,
    attemptId,
    targetIdentity,
    enrollmentToken: created.enrollmentToken,
    administratorDeviceId,
    administratorPublicKey,
    administratorProof,
  });
  const administratorToken = await authority.issueAccessToken({ administratorId: administrator.administratorId });
  const app = createApp();
  registerNativeAdministratorConfigurationRoutes(app, {
    administratorAuthority: authority,
    readConfig: async () => sampleConfig(),
    runtimeProjectionOptions: {
      environment: {
        MPD_HOST: 'environment-mpd.local',
        MOODE_SSH_HOST: 'environment-moode.local',
        TRACK_KEY: sentinels.trackKey,
      },
    },
    getServerIdentity: async () => ({ mode: 'immutable-release', releaseId: `sonuvi-${'a'.repeat(64)}` }),
    getBrowseIndexStatus: async () => ({
      available: true,
      source: 'persisted',
      builtAt: '2026-11-08T12:00:00.000Z',
      dbUpdateAt: '2026-11-08T11:59:00.000Z',
      counts: { artists: 12, albums: 34, tracks: 56 },
      refresh: { running: false },
    }),
    getLibraryHealthStatus: async () => ({
      available: true,
      lastSuccessfulAt: '2026-11-08T11:58:00.000Z',
      cache: { ageMs: 1000, ttlMs: 900000 },
      counts: { albums: 34, tracks: 56 },
      refresh: { running: true, startedAt: '2026-11-08T12:01:00.000Z' },
    }),
    ...overrides,
  });
  return { app, administratorToken };
}

async function invoke(app, route, req = request()) {
  const res = response();
  await app.routes.get(`GET ${route}`)(req, res);
  return res;
}

async function invokePatch(app, route, req = request()) {
  const res = response();
  await app.routes.get(`PATCH ${route}`)(req, res);
  return res;
}

function administratorRequest(token, overrides = {}) {
  return request({ headers: { authorization: `Bearer ${token}` }, ...overrides });
}

test('administrator configuration is a sanitized projection with explicit editability', async (t) => {
  const { app, administratorToken } = await fixture(t);
  const res = await invoke(app, '/v1/admin/configuration', administratorRequest(administratorToken));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contract, 'sonuvi.admin.configuration.v1');
  assert.equal(res.body.server.release.mode, 'immutable-release');
  assert.equal(res.body.server.version, `sonuvi-${'a'.repeat(64)}`);
  assert.deepEqual(res.body.configuration.mpd, { host: 'environment-mpd.local', port: 6600 });
  assert.equal(res.body.configuration.moode.sshHost, 'environment-moode.local');
  assert.equal(res.body.editability.configuration, 'read-only');
  assert.equal(res.body.editability.mutationsAvailable, false);
  assert.deepEqual(res.body.editability.environmentManaged, [
    { id: 'mpdHost', editable: false, source: 'environment' },
    { id: 'moodeSshHost', editable: false, source: 'environment' },
  ]);
  assert.deepEqual(res.body.capabilities.configuration, { read: true, write: false });
  assert.equal(res.body.capabilities.dlna.installed, true);
  const serialized = JSON.stringify(res.body);
  for (const secret of Object.values(sentinels)) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('native-admin-pushover-user-secret'), false);
});

test('administrator configuration mutation reuses the sanitized atomic write surface', async (t) => {
  let current = sampleConfig();
  const { app, administratorToken } = await fixture(t, {
    readConfig: async () => current,
    writeConfig: async (next) => { current = structuredClone(next); },
  });
  const res = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, {
    body: {
      configuration: {
        mpd: { port: 6601 },
        paths: { musicLibraryRoot: '/srv/music-vm' },
      },
    },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contract, 'sonuvi.admin.configuration-update.v1');
  assert.equal(res.body.changed, true);
  assert.equal(res.body.restartRequired, true);
  assert.equal(current.mpd.port, 6601);
  assert.equal(current.paths.musicLibraryRoot, '/srv/music-vm');
  const serialized = JSON.stringify(res.body);
  for (const secret of Object.values(sentinels)) assert.equal(serialized.includes(secret), false);
});

test('administrator mutation rejects unsupported fields, secrets, and environment-managed values', async (t) => {
  const { app, administratorToken } = await fixture(t, {
    writeConfig: async () => {},
    runtimeProjectionOptions: {
      environment: { MPD_HOST: 'environment-mpd.local', TRACK_KEY: sentinels.trackKey },
    },
  });
  const unsupported = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, {
    body: { configuration: { features: { radio: false } } },
  }));
  assert.equal(unsupported.statusCode, 400);
  assert.deepEqual(unsupported.body, { ok: false, code: 'administrator_configuration_field_not_editable' });
  const secret = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, {
    body: { configuration: { lastfm: { apiKey: 'do-not-echo' } } },
  }));
  assert.equal(secret.statusCode, 400);
  assert.deepEqual(secret.body, { ok: false, code: 'administrator_configuration_field_not_editable' });
  const managed = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, {
    body: { configuration: { mpd: { host: 'not-allowed' } } },
  }));
  assert.equal(managed.statusCode, 409);
  assert.deepEqual(managed.body, { ok: false, code: 'administrator_configuration_field_managed' });
});

test('administrator mutation rejects malformed envelopes and field values without writing', async (t) => {
  let writes = 0;
  const { app, administratorToken } = await fixture(t, {
    writeConfig: async () => { writes += 1; },
  });
  for (const body of [
    { configuration: { mpd: { port: 0 } } },
    { configuration: { mpd: { port: '6601' } } },
    { configuration: { mpd: { host: 42 } } },
    { configuration: {} },
  ]) {
    const res = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, { body }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'administrator_configuration_update_invalid');
  }
  const extra = await invokePatch(app, '/v1/admin/configuration', administratorRequest(administratorToken, {
    body: { configuration: { mpd: { port: 6601 } }, secret: 'must-not-be-accepted' },
  }));
  assert.equal(extra.statusCode, 400);
  assert.equal(extra.body.code, 'administrator_configuration_field_not_editable');
  assert.equal(writes, 0);
});

test('administrator library and DLNA endpoints return bounded current status', async (t) => {
  const { app, administratorToken } = await fixture(t);
  const library = await invoke(app, '/v1/admin/library/status', administratorRequest(administratorToken));
  assert.equal(library.statusCode, 200);
  assert.equal(library.body.contract, 'sonuvi.admin.library-status.v1');
  assert.equal(library.body.available, true);
  assert.deepEqual(library.body.counts, { artists: 12, albums: 34, tracks: 56 });
  assert.equal(library.body.indexing.running, true);
  assert.equal(library.body.indexing.lastSuccessfulAt, '2026-11-08T12:00:00.000Z');
  assert.equal(library.body.libraryHealth.cache.ttlMs, 900000);

  const dlna = await invoke(app, '/v1/admin/dlna', administratorRequest(administratorToken));
  assert.equal(dlna.statusCode, 200);
  assert.deepEqual(dlna.body, {
    ok: true,
    contract: 'sonuvi.admin.dlna.v1',
    status: 'disabled',
    installed: true,
    enabled: false,
    reason: 'operator_configuration_required',
  });
});

test('native administrator routes reject ordinary controller credentials and the legacy Track Key', async (t) => {
  const { app } = await fixture(t, { writeConfig: async () => {} });
  const controllerToken = createMobileSessionToken({ secret: 'ordinary-controller-secret', deviceId: 'controller-device-0123456789' });
  const requests = [
    request(),
    request({ headers: { authorization: `Bearer ${controllerToken}` } }),
    request({ headers: { 'x-track-key': sentinels.trackKey } }),
  ];
  for (const route of ['/v1/admin/configuration', '/v1/admin/library/status', '/v1/admin/dlna']) {
    for (const candidate of requests) {
      const res = await invoke(app, route, candidate);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { ok: false, code: 'administrator_authorization_required' });
    }
  }
  for (const candidate of requests) {
    const rejected = await invokePatch(app, '/v1/admin/configuration', {
      ...candidate,
      body: { configuration: { mpd: { port: 6601 } } },
    });
    assert.equal(rejected.statusCode, 401);
    assert.deepEqual(rejected.body, { ok: false, code: 'administrator_authorization_required' });
  }
});

test('configuration and status failures expose fixed error types without provider details', async (t) => {
  const { app, administratorToken } = await fixture(t, {
    readConfig: async () => { throw new Error('/private/config-path'); },
    getBrowseIndexStatus: async () => { throw new Error('mpd password leaked'); },
  });
  const configuration = await invoke(app, '/v1/admin/configuration', administratorRequest(administratorToken));
  assert.deepEqual(configuration.body, { ok: false, code: 'administrator_configuration_unavailable' });
  assert.equal(configuration.statusCode, 503);
  const library = await invoke(app, '/v1/admin/library/status', administratorRequest(administratorToken));
  assert.deepEqual(library.body, { ok: false, code: 'administrator_library_status_unavailable' });
  assert.equal(library.statusCode, 503);
});
