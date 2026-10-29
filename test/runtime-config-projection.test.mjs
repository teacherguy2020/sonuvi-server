import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mergeRuntimeConfig,
  projectRuntimeAdminConfig,
  projectRuntimePublicConfig,
  sanitizeRuntimeConfigUpdate,
} from '../src/lib/runtime-config-projection.mjs';
import { registerConfigRuntimeAdminRoutes } from '../src/routes/config.runtime-admin.routes.mjs';

const SENTINELS = Object.freeze({
  trackKey: 'TRACK_KEY_SENTINEL',
  pushoverToken: 'PUSHOVER_TOKEN_SENTINEL',
  pushoverUser: 'PUSHOVER_USER_SENTINEL',
  lastfm: 'LASTFM_API_KEY_SENTINEL',
  privatePath: '/private/sonuvi/sentinel',
  privateUrl: 'https://private.example.invalid/route',
});

const MEDIA_PATHS = Object.freeze({ musicLibraryRoot:'/media-fixture/music', moodeUsbMount:'/media-fixture/drive', piMountBase:'/mount-fixture/drive', podcastRoot:'/mount-fixture/podcasts' });

function configFixture() {
  return {
    projectName: 'Sonuvi',
    ports: { api: 3101, ui: 8101 },
    trackKey: SENTINELS.trackKey,
    unknownTopLevel: SENTINELS.privatePath,
    paths: { ...MEDIA_PATHS, subscriptionsJson: SENTINELS.privatePath },
    runtime: { trackCacheDir: SENTINELS.privatePath, publicBaseUrl: 'https://sonuvi.example' },
    mpd: { host: 'moode.local', port: 6600 },
    moode: { sshHost: 'moode.local', sshUser: 'moode', baseUrl: 'http://moode.local' },
    nodes: [{ name: 'main', ip: '192.0.2.4', role: 'both', sshUser: 'fixture-operator', secret: SENTINELS.trackKey }],
    alexa: {
      enabled: true,
      publicDomain: 'sonuvi.example',
      skillId: SENTINELS.trackKey,
      routeWebhookUrl: SENTINELS.privateUrl,
      artistAliases: { 'The Example': 'Example' },
    },
    notifications: {
      trackNotify: { enabled: true, pollMs: 3000, dedupeMs: 15000, alexaMaxAgeMs: 21600000 },
      pushover: { token: SENTINELS.pushoverToken, userKey: SENTINELS.pushoverUser },
    },
    lastfm: { apiKey: SENTINELS.lastfm, username: 'listener', recentsMode: 'toptracks' },
    display: { idleBrandLine: 'Sonuvi', idleMessageLine: 'Quiet' },
    features: { podcasts: true, ratings: true, radio: true, albumPersonnel: true },
  };
}

function appFixture() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

test('public projection hides paths; authenticated projection permits only four media folders and never credentials', () => {
  const cfg = configFixture();
  const publicProjection = projectRuntimePublicConfig(cfg, { environment: {} });
  const adminProjection = projectRuntimeAdminConfig(cfg, { environment: {} });

  for (const projection of [publicProjection, adminProjection]) {
    const serialized = JSON.stringify(projection);
    for (const sentinel of Object.values(SENTINELS)) assert.equal(serialized.includes(sentinel), false);
    assert.equal('configPath' in projection, false);
    assert.equal('fullConfig' in projection, false);
  }
  assert.equal(publicProjection.contract, 'sonuvi.runtime-public-config.v1');
  assert.deepEqual(publicProjection.alexa, { enabled: true });
  assert.equal('mpd' in publicProjection, false);
  assert.equal(adminProjection.contract, 'sonuvi.runtime-admin-config.v1');
  assert.equal(adminProjection.storage.musicLibraryRootConfigured, true);
  assert.deepEqual(adminProjection.paths, MEDIA_PATHS);
  assert.equal('paths' in publicProjection, false);
  for (const value of Object.values(MEDIA_PATHS)) assert.equal(JSON.stringify(publicProjection).includes(value), false);
  assert.equal(adminProjection.notifications.pushover.configured, true);
  assert.equal('token' in adminProjection.notifications.pushover, false);
});

test('runtime update sanitizer fails closed and preserves redacted values when omitted', () => {
  const current = configFixture();
  const update = sanitizeRuntimeConfigUpdate({
    display: { idleBrandLine: 'Updated' },
    paths: { musicLibraryRoot: '' },
    arbitraryFutureConfig: { shouldNot: 'persist' },
  });
  const next = mergeRuntimeConfig(current, update);

  assert.equal(next.display.idleBrandLine, 'Updated');
  assert.equal(next.paths.musicLibraryRoot, MEDIA_PATHS.musicLibraryRoot);
  assert.equal(next.notifications.pushover.token, SENTINELS.pushoverToken);
  assert.equal(next.lastfm.apiKey, SENTINELS.lastfm);
  assert.equal(next.trackKey, SENTINELS.trackKey);
  assert.equal('arbitraryFutureConfig' in next, false);
});

test('runtime update rejects secret-bearing keys instead of persisting them', () => {
  assert.throws(
    () => sanitizeRuntimeConfigUpdate({ trackKey: SENTINELS.trackKey }),
    /secret-bearing fields: trackKey/,
  );
  assert.throws(
    () => sanitizeRuntimeConfigUpdate({
      lastfm: { apiKey: SENTINELS.lastfm },
      notifications: { pushover: { token: SENTINELS.pushoverToken } },
    }),
    /lastfm\.apiKey.*notifications\.pushover\.token/,
  );
});

test('runtime routes expose a safe public compatibility response and a protected admin projection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-runtime-projection-'));
  const configPath = path.join(directory, 'now-playing.config.json');
  const previous = process.env.NOW_PLAYING_CONFIG_PATH;
  await fs.writeFile(configPath, `${JSON.stringify(configFixture())}\n`, 'utf8');
  process.env.NOW_PLAYING_CONFIG_PATH = configPath;

  try {
    const app = appFixture();
    let authCalls = 0;
    registerConfigRuntimeAdminRoutes(app, {
      requireTrackKey: (_req, res) => {
        authCalls += 1;
        res.status(403).send('Forbidden');
        return false;
      },
      trackKey: 'test-track-key',
      log: { debug() {} },
    });

    const publicRes = response();
    await app.routes.get('GET /config/runtime')({}, publicRes);
    assert.equal(publicRes.statusCode, 200);
    assert.equal(authCalls, 0);
    const publicBody = JSON.stringify(publicRes.body);
    for (const sentinel of Object.values(SENTINELS)) assert.equal(publicBody.includes(sentinel), false);
    assert.equal('fullConfig' in publicRes.body, false);
    assert.equal('configPath' in publicRes.body, false);

    const blockedRes = response();
    await app.routes.get('GET /config/runtime/admin')({}, blockedRes);
    assert.equal(blockedRes.statusCode, 403);

    const acceptedApp = appFixture();
    registerConfigRuntimeAdminRoutes(acceptedApp, {
      requireTrackKey: () => true,
      trackKey: 'test-track-key',
      log: { debug() {} },
    });
    const adminRes = response();
    await acceptedApp.routes.get('GET /config/runtime/admin')({}, adminRes);
    assert.equal(adminRes.statusCode, 200);
    assert.deepEqual(adminRes.body.config.paths, MEDIA_PATHS);
    const adminBody = JSON.stringify(adminRes.body);
    for (const sentinel of Object.values(SENTINELS)) assert.equal(adminBody.includes(sentinel), false);

    const rejectedFullConfig = response();
    await acceptedApp.routes.get('POST /config/runtime')({ body: { fullConfig: configFixture() } }, rejectedFullConfig);
    assert.equal(rejectedFullConfig.statusCode, 400);
  } finally {
    if (previous === undefined) delete process.env.NOW_PLAYING_CONFIG_PATH;
    else process.env.NOW_PLAYING_CONFIG_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('runtime administration fails closed without an operator key and public config errors do not leak paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-runtime-error-'));
  const missingConfigPath = path.join(directory, 'private-config-path.json');
  const previous = process.env.NOW_PLAYING_CONFIG_PATH;
  process.env.NOW_PLAYING_CONFIG_PATH = missingConfigPath;

  try {
    const app = appFixture();
    registerConfigRuntimeAdminRoutes(app, {
      requireTrackKey: () => true,
      log: { debug() {} },
    });

    const publicRes = response();
    await app.routes.get('GET /config/runtime')({}, publicRes);
    assert.equal(publicRes.statusCode, 500);
    assert.equal(publicRes.body.error, 'Runtime configuration is unavailable');
    assert.equal(JSON.stringify(publicRes.body).includes(missingConfigPath), false);

    const adminRes = response();
    await app.routes.get('GET /config/runtime/admin')({}, adminRes);
    assert.equal(adminRes.statusCode, 503);
    assert.equal(adminRes.body.error, 'Runtime administration is unavailable');

    const updateRes = response();
    await app.routes.get('POST /config/runtime')({ body: { config: {} } }, updateRes);
    assert.equal(updateRes.statusCode, 503);
    assert.equal(updateRes.body.error, 'Runtime administration is unavailable');
  } finally {
    if (previous === undefined) delete process.env.NOW_PLAYING_CONFIG_PATH;
    else process.env.NOW_PLAYING_CONFIG_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('immutable runtime administration rejects Last.fm credential writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-runtime-credentials-'));
  const configPath = path.join(directory, 'now-playing.config.json');
  await fs.writeFile(configPath, JSON.stringify({
    nodes: [{ name: 'api', ip: '127.0.0.1', role: 'api' }],
    ports: { api: 3101, ui: 8101 },
    alexa: { enabled: false },
  }), 'utf8');
  const previousConfigPath = process.env.NOW_PLAYING_CONFIG_PATH;
  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  process.env.NOW_PLAYING_CONFIG_PATH = configPath;
  process.env.SONUVI_STATE_ROOT = path.join(directory, 'shared');

  try {
    const app = appFixture();
    registerConfigRuntimeAdminRoutes(app, {
      requireTrackKey: () => true,
      trackKey: 'test-track-key',
      log: { debug() {} },
    });
    const res = response();
    await app.routes.get('POST /config/lastfm/credentials')({
      body: { apiKey: SENTINELS.lastfm, apiSecret: SENTINELS.trackKey },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'SONUVI_PROTECTED_CREDENTIALS');
    assert.equal(JSON.stringify(res.body).includes(SENTINELS.lastfm), false);
    assert.equal(JSON.stringify(res.body).includes(SENTINELS.trackKey), false);
  } finally {
    if (previousConfigPath === undefined) delete process.env.NOW_PLAYING_CONFIG_PATH;
    else process.env.NOW_PLAYING_CONFIG_PATH = previousConfigPath;
    if (previousStateRoot === undefined) delete process.env.SONUVI_STATE_ROOT;
    else process.env.SONUVI_STATE_ROOT = previousStateRoot;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
