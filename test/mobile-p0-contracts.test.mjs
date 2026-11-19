import assert from 'node:assert/strict';
import test from 'node:test';

import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';
import { buildMobileCatalog } from '../src/lib/mobile-track-identity.mjs';

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request(overrides = {}) {
  return {
    headers: {},
    query: {},
    params: {},
    body: {},
    protocol: 'https',
    get(name) { return name.toLowerCase() === 'host' ? 'now-playing.tailnet.test' : ''; },
    ...overrides,
  };
}

function fixtureIndex() {
  return {
    builtAt: '2026-10-20T00:00:00.000Z',
    tracks: [
      {
        file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
        artist: 'Test Artist',
        albumArtist: 'Test Artist',
        album: 'Test Album',
        title: 'First',
        track: '1',
        genre: 'Test',
        durationSec: 123,
        mbTrackId: 'track-one',
        mbAlbumId: 'album-one',
        mbArtistId: 'artist-one',
      },
      {
        file: 'USB/SamsungMoode/Test Album/02 - Second.mp3',
        artist: 'Test Artist',
        albumArtist: 'Test Artist',
        album: 'Test Album',
        title: 'Second',
        track: '2',
        genre: 'Test',
        durationSec: 124,
        mbTrackId: 'track-two',
        mbAlbumId: 'album-one',
        mbArtistId: 'artist-one',
      },
    ],
  };
}

function registerFixture(mpdQueryRaw = async () => 'OK\n', extra = {}) {
  const app = createApp();
  registerMobileRoutes(app, {
    enabled: true,
    apiSecret: 'api-secret-for-test',
    trackIdSecret: 'track-secret-for-test',
    enrollmentCode: 'one-time-code',
    getBrowseIndex: async () => fixtureIndex(),
    getMobilePlaylists: async () => [],
    mpdQueryRaw,
    mpdFileToLocalPath: (file) => `/tmp/${file.split('/').at(-1)}`,
    safeIsFile: () => true,
    serveArtworkForTrack: async () => {},
    ...extra,
  });
  return app;
}

function sessionHeaders() {
  const token = createMobileSessionToken({
    secret: 'api-secret-for-test',
    deviceId: 'ipad-brian',
  });
  return { authorization: `Bearer ${token}` };
}

test('Home mobile controls require bearer auth and use the typed diagnostics bridge', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: {
          ok: true,
          repeatOn: options.body?.action === 'repeat' || options.body?.mode === 'all' || options.body?.mode === 'one',
          singleOn: options.body?.mode === 'one',
          repeatMode: options.body?.action === 'repeat-mode' ? options.body.mode : null,
        },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/now-playing/control');

  const unauthorized = createResponse();
  await route(request({
    headers: { 'x-track-key': 'legacy-track-key' },
    body: { action: 'play' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  const malformed = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { action: 'play', rendererUrl: 'http://renderer.invalid' },
  }), malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.code, 'MOBILE_CONTROL_INVALID_REQUEST');
  assert.deepEqual(calls, []);

  const actions = [
    [{ action: 'play' }, { action: 'play' }],
    [{ action: 'pause' }, { action: 'pause' }],
    [{ action: 'stop' }, { action: 'stop' }],
    [{ action: 'next' }, { action: 'next' }],
    [{ action: 'previous' }, { action: 'prev' }],
    [{ action: 'repeat' }, { action: 'repeat' }],
    [{ action: 'repeatMode', mode: 'all' }, { action: 'repeat-mode', mode: 'all' }],
    [{ action: 'seekRelative', seconds: -30 }, { action: 'seekrel', seconds: -30 }],
    [{ action: 'seekPercent', percent: 37.5 }, { action: 'seekpct', percent: 38 }],
  ];

  for (const [body, expectedInternal] of actions) {
    const response = createResponse();
    await route(request({ headers: sessionHeaders(), body }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.action, body.action);
    if (body.action === 'repeat') assert.equal(response.body.repeatOn, true);
    if (body.action === 'repeatMode') {
      assert.equal(response.body.mode, body.mode);
      assert.equal(response.body.repeatMode, body.mode);
      assert.equal(response.body.singleOn, false);
    }
    if (body.action === 'seekRelative') assert.equal(response.body.seconds, -30);
    if (body.action === 'seekPercent') assert.equal(response.body.percent, 38);
    assert.deepEqual(calls.at(-1), {
      pathname: '/config/diagnostics/playback',
      options: { method: 'POST', body: expectedInternal },
    });
    assert.doesNotMatch(JSON.stringify(response.body), /renderer|command|status|path|Track Key/i);
  }
});

test('Home mobile Consume preserves the legacy toggle and supports typed authoritative state', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      const setTo = options.body?.setTo;
      return {
        ok: true,
        status: 200,
        json: {
          ok: true,
          consumeOn: setTo ? setTo === 'on' : true,
        },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/now-playing/control');

  const unauthorized = createResponse();
  await route(request({
    headers: { 'x-track-key': 'legacy-track-key' },
    body: { action: 'consume', state: 'on' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  for (const [state, consumeOn] of [['on', true], ['off', false]]) {
    const response = createResponse();
    await route(request({
      headers: sessionHeaders(),
      body: { action: 'consume', state },
    }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      action: 'consume',
      state,
      consumeOn,
    });
    assert.deepEqual(calls.at(-1), {
      pathname: '/config/diagnostics/playback',
      options: { method: 'POST', body: { action: 'consume', setTo: state } },
    });
  }

  const toggle = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { action: 'consume' },
  }), toggle);
  assert.equal(toggle.statusCode, 200);
  assert.deepEqual(toggle.body, {
    ok: true,
    action: 'consume',
    state: 'on',
    consumeOn: true,
  });
  assert.deepEqual(calls.at(-1), {
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'consume' } },
  });

  const callCountBeforeInvalid = calls.length;
  for (const body of [
    { action: 'consume', state: 'toggle' },
    { action: 'consume', state: 1 },
    { action: 'consume', state: null },
    { action: 'consume', state: 'on', setTo: 'on' },
  ]) {
    const response = createResponse();
    await route(request({ headers: sessionHeaders(), body }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, body.setTo
      ? 'MOBILE_CONTROL_INVALID_REQUEST'
      : 'MOBILE_CONSUME_STATE_INVALID_REQUEST');
  }
  assert.equal(calls.length, callCountBeforeInvalid);

  const mismatchApp = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, consumeOn: false },
    }),
  });
  const mismatch = createResponse();
  await mismatchApp.routes.get('POST /v1/mobile/now-playing/control')?.(request({
    headers: sessionHeaders(),
    body: { action: 'consume', state: 'on' },
  }), mismatch);
  assert.equal(mismatch.statusCode, 502);
  assert.equal(mismatch.body.code, 'MOBILE_CONSUME_READBACK_MISMATCH');
});

test('Home mobile seek bounds and Qobuz ownership fail closed without releasing Qobuz', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: false,
        status: 409,
        json: {
          ok: false,
          source: 'qobuz-connect',
          error: 'private internal ownership detail',
        },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/now-playing/control');

  for (const body of [
    { action: 'seekRelative', seconds: 0 },
    { action: 'seekRelative', seconds: 601 },
    { action: 'seekRelative', seconds: -601 },
    { action: 'seekPercent', percent: -0.1 },
    { action: 'seekPercent', percent: 100.1 },
    { action: 'seekPercent', percent: '50' },
  ]) {
    const response = createResponse();
    await route(request({ headers: sessionHeaders(), body }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, 'MOBILE_SEEK_OUT_OF_BOUNDS');
  }
  assert.deepEqual(calls, []);

  const conflict = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { action: 'pause' },
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.body, {
    ok: false,
    error: 'Home playback is owned by Qobuz Connect; release Qobuz before controlling Home playback',
    code: 'HOME_PLAYBACK_OWNERSHIP_CONFLICT',
    source: 'qobuz-connect',
  });
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'pause' } },
  }]);
  assert.equal(calls.some(({ pathname }) => pathname.includes('release')), false);

  const repeatConflict = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { action: 'repeatMode', mode: 'one' },
  }), repeatConflict);
  assert.equal(repeatConflict.statusCode, 409);
  assert.deepEqual(repeatConflict.body, {
    ok: false,
    error: 'Home playback is owned by Qobuz Connect; release Qobuz before controlling Home playback',
    code: 'HOME_PLAYBACK_OWNERSHIP_CONFLICT',
    source: 'qobuz-connect',
  });
  assert.deepEqual(calls.at(-1), {
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'repeat-mode', mode: 'one' } },
  });

  const consumeConflict = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { action: 'consume', state: 'on' },
  }), consumeConflict);
  assert.equal(consumeConflict.statusCode, 409);
  assert.deepEqual(consumeConflict.body, {
    ok: false,
    error: 'Home playback is owned by Qobuz Connect; release Qobuz before controlling Home playback',
    code: 'HOME_PLAYBACK_OWNERSHIP_CONFLICT',
    source: 'qobuz-connect',
  });
  assert.deepEqual(calls.at(-1), {
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'consume', setTo: 'on' } },
  });
  assert.equal(calls.some(({ pathname }) => pathname.includes('release')), false);
});

test('Home mobile repeat mode validates exact modes and preserves authoritative readback', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: {
          ok: true,
          repeatMode: options.body?.mode,
          repeatOn: options.body?.mode !== 'off',
          singleOn: options.body?.mode === 'one',
        },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/now-playing/control');

  for (const mode of ['off', 'all', 'one']) {
    const response = createResponse();
    await route(request({
      headers: sessionHeaders(),
      body: { action: 'repeatMode', mode },
    }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.mode, mode);
    assert.equal(response.body.repeatMode, mode);
    assert.equal(response.body.repeatOn, mode !== 'off');
    assert.equal(response.body.singleOn, mode === 'one');
    assert.deepEqual(calls.at(-1), {
      pathname: '/config/diagnostics/playback',
      options: { method: 'POST', body: { action: 'repeat-mode', mode } },
    });
  }

  for (const body of [
    { action: 'repeatMode', mode: 'toggle' },
    { action: 'repeatMode', mode: 1 },
    { action: 'repeatMode' },
    { action: 'repeatMode', mode: 'all', rendererUrl: 'http://renderer.invalid' },
  ]) {
    const response = createResponse();
    await route(request({ headers: sessionHeaders(), body }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, body.rendererUrl
      ? 'MOBILE_CONTROL_INVALID_REQUEST'
      : 'MOBILE_REPEAT_MODE_INVALID_REQUEST');
  }

  const mismatchApp = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async () => ({
      ok: false,
      status: 502,
      json: { ok: false, code: 'REPEAT_MODE_READBACK_MISMATCH' },
    }),
  });
  const mismatch = createResponse();
  await mismatchApp.routes.get('POST /v1/mobile/now-playing/control')?.(request({
    headers: sessionHeaders(),
    body: { action: 'repeatMode', mode: 'all' },
  }), mismatch);
  assert.equal(mismatch.statusCode, 502);
  assert.equal(mismatch.body.code, 'MOBILE_REPEAT_MODE_READBACK_MISMATCH');
});

test('Home mobile UPnP ownership blocks repeat mutations without exposing internal details', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: false,
        status: 409,
        json: {
          ok: false,
          source: 'upnp-sonuvi',
          error: 'private UPnP ownership detail',
        },
      };
    },
  });
  const response = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/control')?.(request({
    headers: sessionHeaders(),
    body: { action: 'repeatMode', mode: 'one' },
  }), response);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'Home playback is owned by Sonuvi UPnP; use the UPnP mobile contract before controlling Home playback',
    code: 'HOME_PLAYBACK_OWNERSHIP_CONFLICT',
    source: 'upnp-sonuvi',
  });
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'repeat-mode', mode: 'one' } },
  }]);

  const consumeResponse = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/control')?.(request({
    headers: sessionHeaders(),
    body: { action: 'consume' },
  }), consumeResponse);
  assert.equal(consumeResponse.statusCode, 409);
  assert.deepEqual(consumeResponse.body, {
    ok: false,
    error: 'Home playback is owned by Sonuvi UPnP; use the UPnP mobile contract before controlling Home playback',
    code: 'HOME_PLAYBACK_OWNERSHIP_CONFLICT',
    source: 'upnp-sonuvi',
  });
  assert.deepEqual(calls.at(-1), {
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'consume' } },
  });
});

test('mobile Vibe resolves an explicit canonical trackId and preserves Queue Wizard seed options', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 202,
        json: { ok: true, accepted: true, jobId: 'vibe-p0-job' },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/queue-wizard/vibe');
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const trackId = catalog.tracks[0].id;

  const unauthorized = createResponse();
  await route(request({ body: { trackId } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  const invalid = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { trackId, file: '/private/path/song.mp3' },
  }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'MOBILE_VIBE_INVALID_REQUEST');
  assert.deepEqual(calls, []);

  const unknown = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { trackId: 'trk_not-in-catalog' },
  }), unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.code, 'MOBILE_TRACK_NOT_FOUND');

  const response = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: {
      trackId,
      targetQueue: 12,
      playNow: true,
      keepPlaying: true,
    },
  }), response);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, {
    ok: true,
    accepted: true,
    jobId: 'vibe-p0-job',
    trackId,
    targetQueue: 12,
  });
  assert.deepEqual(calls, [{
    pathname: '/config/queue-wizard/vibe-seed-start',
    options: {
      method: 'POST',
      body: {
        targetQueue: 12,
        playNow: true,
        keepPlaying: true,
        seedArtist: 'Test Artist',
        seedTitle: 'First',
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|Track Key/i);
});

test('native Vibe preview is bearer-only, canonical, and non-mutating', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: {
          tracks: [
            { file: fixtureIndex().tracks[1].file, artist: 'Private', title: 'Raw title' },
            { file: 'USB/SamsungMoode/Not-in-catalog.mp3', artist: 'Unknown', title: 'Unknown' },
          ],
        },
      };
    },
  });
  const route = app.routes.get('POST /v1/mobile/vibe/preview');
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const seedTrackId = catalog.tracks[0].id;

  const unauthorized = createResponse();
  await route(request({ body: { trackId: seedTrackId } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  const invalid = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { trackId: seedTrackId, playNow: true },
  }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'MOBILE_VIBE_PREVIEW_INVALID_REQUEST');

  const unknown = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { trackId: 'trk_not-in-catalog' },
  }), unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.code, 'MOBILE_TRACK_NOT_FOUND');

  const response = createResponse();
  await route(request({
    headers: sessionHeaders(),
    body: { trackId: seedTrackId, targetQueue: 12 },
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.kind, 'native-device-vibe-preview');
  assert.equal(response.body.trackId, seedTrackId);
  assert.equal(response.body.targetQueue, 12);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.unresolvedCount, 1);
  assert.equal(response.body.tracks[0].id, catalog.tracks[1].id);
  assert.equal(Object.hasOwn(response.body.tracks[0], 'file'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|Second\.mp3|Raw title|Track Key/i);
  assert.deepEqual(calls, [{
    pathname: '/config/queue-wizard/vibe-seed',
    options: {
      method: 'POST',
      body: {
        targetQueue: 12,
        seedArtist: 'Test Artist',
        seedTitle: 'First',
      },
    },
  }]);
  assert.equal(calls.some(({ pathname }) => /apply|diagnostics\/playback|control|release|shuffle/.test(pathname)), false);
});

test('native Vibe preview fails safely for unresolved candidates and timeouts', async () => {
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const seedTrackId = catalog.tracks[0].id;
  const unresolvedApp = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async () => ({ ok: true, status: 200, json: { tracks: [{ file: 'missing.mp3' }] } }),
  });
  const unresolved = createResponse();
  await unresolvedApp.routes.get('POST /v1/mobile/vibe/preview')?.(request({
    headers: sessionHeaders(),
    body: { trackId: seedTrackId },
  }), unresolved);
  assert.equal(unresolved.statusCode, 422);
  assert.equal(unresolved.body.code, 'MOBILE_VIBE_PREVIEW_UNRESOLVED');

  const timeoutApp = registerFixture(async () => 'OK\n', {
    vibePreviewTimeoutMs: 5,
    fetchInternalRequest: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200, json: { tracks: [] } }), 25);
    }),
  });
  const timeout = createResponse();
  await timeoutApp.routes.get('POST /v1/mobile/vibe/preview')?.(request({
    headers: sessionHeaders(),
    body: { trackId: seedTrackId },
  }), timeout);
  assert.equal(timeout.statusCode, 504);
  assert.equal(timeout.body.code, 'MOBILE_VIBE_PREVIEW_TIMEOUT');
});

test('native Vibe preview and job preserve only allowlisted partial warning codes', async () => {
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const seedTrackId = catalog.tracks[0].id;
  const partialApp = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname) => {
      if (pathname === '/config/queue-wizard/vibe-seed') {
        return {
          ok: true, status: 200,
          json: {
            tracks: [{ file: fixtureIndex().tracks[1].file }],
            summary: { partial: true, warningCode: 'LASTFM_UNAVAILABLE', warning: 'safe server message' },
          },
        };
      }
      return {
        ok: true, status: 200,
        json: { jobId: 'job-1', status: 'done', done: true, partial: true, warningCode: 'SECRET=raw', warning: 'SECRET=raw' },
      };
    },
  });
  const preview = createResponse();
  await partialApp.routes.get('POST /v1/mobile/vibe/preview')?.(request({
    headers: sessionHeaders(), body: { trackId: seedTrackId },
  }), preview);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.warningCode, 'LASTFM_UNAVAILABLE');
  assert.equal(preview.body.warning, 'Vibe recommendations are temporarily unavailable');

  const job = createResponse();
  await partialApp.routes.get('GET /v1/mobile/vibe/jobs/:jobId')?.(request({
    headers: sessionHeaders(), params: { jobId: 'job-1' },
  }), job);
  assert.equal(job.statusCode, 200);
  assert.equal(Object.hasOwn(job.body, 'warningCode'), false);
  assert.equal(job.body.warning, 'Vibe recommendations are unavailable');
  assert.doesNotMatch(JSON.stringify(job.body), /SECRET=raw/);
});

test('the pre-existing current-track mobile Vibe adapter remains compatible', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    startMobileVibe: async (body) => {
      calls.push(body);
      return { accepted: true, jobId: 'legacy-mobile-vibe-job', targetQueue: body.targetQueue };
    },
  });
  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue-wizard/vibe')?.(request({
    headers: sessionHeaders(),
    body: { targetQueue: 10, minRating: 2, keepPlaying: true },
  }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    accepted: true,
    jobId: 'legacy-mobile-vibe-job',
    targetQueue: 10,
  });
  assert.deepEqual(calls, [{ targetQueue: 10, minRating: 2, keepPlaying: true }]);
});

test('mobile queue actions expose physical shuffle undo through the existing guarded path', async () => {
  const calls = [];
  const commands = [];
  const app = registerFixture(async (command) => {
    commands.push(command);
    if (command === 'status') {
      return 'state: stop\nsong: -1\nplaylistlength: 2\nrandom: off\nrepeat: off\nOK\n';
    }
    if (command === 'playlistinfo') {
      return [
        'file: USB/SamsungMoode/Test Album/01 - First.mp3',
        'artist: Test Artist',
        'album: Test Album',
        'title: First',
        'pos: 0',
        'id: 77',
        'file: USB/SamsungMoode/Test Album/02 - Second.mp3',
        'artist: Test Artist',
        'album: Test Album',
        'title: Second',
        'pos: 1',
        'id: 78',
        'OK',
      ].join('\n');
    }
    return 'OK\n';
  }, {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: { ok: true, action: 'undoshuffle', undoAvailable: false },
      };
    },
  });

  const response = createResponse();
  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    body: { action: 'undoshuffle' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const malformed = createResponse();
  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'undoshuffle', file: '/private/path/song.mp3' },
  }), malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.code, 'MOBILE_SHUFFLE_UNDO_INVALID_REQUEST');

  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'undoshuffle' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, 'undoshuffle');
  assert.equal(response.body.undoAvailable, false);
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'undoshuffle' } },
  }]);
  assert.equal(commands.includes('undoshuffle'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|serverSongId|songid/i);
});
