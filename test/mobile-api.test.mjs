import assert from 'node:assert/strict';
import test from 'node:test';

import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createMobileRefreshToken, createMobileSessionToken, verifyMobileToken } from '../src/lib/mobile-auth.mjs';

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
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end() { return this; },
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
    builtAt: '2026-09-25T00:00:00.000Z',
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
        file: 'USB/SamsungMoode/Test Album/02 - Second.flac',
        artist: 'Test Artist',
        albumArtist: 'Test Artist',
        album: 'Test Album',
        title: 'Second',
        track: '2',
        genre: 'Test',
        durationSec: 234,
        mbTrackId: 'track-two',
        mbAlbumId: 'album-one',
        mbArtistId: 'artist-one',
      },
    ],
  };
}

function registerFixture(extra = {}) {
  const app = createApp();
  registerMobileRoutes(app, {
    enabled: true,
    apiSecret: 'api-secret-for-test',
    trackIdSecret: 'track-secret-for-test',
    enrollmentCode: 'one-time-code',
    getBrowseIndex: async () => fixtureIndex(),
    getMobilePlaylists: async () => [
      {
        name: 'Road Trip',
        files: [
          'USB/SamsungMoode/Test Album/01 - First.mp3',
          'USB/SamsungMoode/Test Album/01 - First.mp3',
          'USB/SamsungMoode/Missing/99 - Unavailable.mp3',
        ],
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
      {
        name: 'Podcasts - Recent Episodes',
        files: ['USB/SamsungMoode/Podcasts/Example/episode.mp3'],
      },
      {
        name: 'Downloaded Audio',
        files: ['USB/SamsungMoode/Podcasts/Example/episode-2.mp3'],
      },
    ],
    mpdFileToLocalPath: (file) => `/tmp/${file.split('/').at(-1)}`,
    safeIsFile: (file) => file.endsWith('.mp3'),
    serveArtworkForTrack: async () => {},
    servePlaylistArtwork: async (res, name) => res.json({ ok: true, name }),
    ...extra,
  });
  return app;
}

test('mobile session enrollment uses its own credential and issues a scoped token', async () => {
  const app = registerFixture();
  const res = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request(), res);
  assert.equal(res.statusCode, 403);

  const authorized = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), authorized);
  // The fake app stores routes under the method-qualified key.
  assert.equal(authorized.statusCode, 200);
  assert.ok(authorized.body.accessToken);
  assert.ok(authorized.body.refreshToken);
  assert.equal(verifyMobileToken(authorized.body.refreshToken, {
    secret: 'api-secret-for-test',
    scope: 'mobile-refresh',
  }).deviceId, 'iphone-brian');
});

test('mobile session refresh silently replaces an expired access token', async () => {
  const app = registerFixture();
  const enrolled = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), enrolled);

  const refreshed = createResponse();
  await app.routes.get('POST /v1/mobile/session/refresh')?.(request({
    headers: { 'x-mobile-refresh-token': enrolled.body.refreshToken },
  }), refreshed);

  assert.equal(refreshed.statusCode, 200);
  assert.ok(refreshed.body.accessToken);
  assert.equal(refreshed.body.refreshToken, enrolled.body.refreshToken);
  assert.equal(verifyMobileToken(refreshed.body.accessToken, {
    secret: 'api-secret-for-test',
    scope: 'mobile-api',
  }).deviceId, 'ipad-brian');

  const invalid = createResponse();
  await app.routes.get('POST /v1/mobile/session/refresh')?.(request({
    headers: { 'x-mobile-refresh-token': 'not-a-refresh-token' },
  }), invalid);
  assert.equal(invalid.statusCode, 401);
});

test('mobile session refresh rejects expired refresh tokens and ordinary routes reject expired access tokens', async () => {
  const app = registerFixture();
  const issuedAt = Date.now() - (2 * 365 * 24 * 60 * 60 * 1_000);
  const expiredRefreshToken = createMobileRefreshToken({
    secret: 'api-secret-for-test',
    deviceId: 'ipad-brian',
    ttlMs: 365 * 24 * 60 * 60 * 1_000,
    now: issuedAt,
  });
  const refreshResponse = createResponse();
  await app.routes.get('POST /v1/mobile/session/refresh')?.(request({
    headers: { 'x-mobile-refresh-token': expiredRefreshToken },
  }), refreshResponse);
  assert.equal(refreshResponse.statusCode, 401);

  const expiredAccessToken = createMobileSessionToken({
    secret: 'api-secret-for-test',
    deviceId: 'ipad-brian',
    ttlMs: 12 * 60 * 60 * 1_000,
    now: issuedAt,
  });
  const ordinaryResponse = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/stats')?.(request({
    headers: { authorization: `Bearer ${expiredAccessToken}` },
  }), ordinaryResponse);
  assert.equal(ordinaryResponse.statusCode, 401);
});

test('mobile session refresh migrates a legacy expired access token once', async () => {
  const app = registerFixture();
  const legacyToken = createMobileSessionToken({
    secret: 'api-secret-for-test',
    deviceId: 'legacy-iphone',
    ttlMs: 1_000,
    now: Date.now() - (24 * 60 * 60 * 1_000),
  });
  const migrated = createResponse();
  const withoutMigrationHeader = createResponse();
  await app.routes.get('POST /v1/mobile/session/refresh')?.(request({
    headers: { authorization: `Bearer ${legacyToken}` },
  }), withoutMigrationHeader);
  assert.equal(withoutMigrationHeader.statusCode, 401);

  await app.routes.get('POST /v1/mobile/session/refresh')?.(request({
    headers: {
      authorization: `Bearer ${legacyToken}`,
      'x-mobile-session-migration': '1',
    },
  }), migrated);

  assert.equal(migrated.statusCode, 200);
  assert.ok(migrated.body.refreshToken);
  assert.equal(verifyMobileToken(migrated.body.refreshToken, {
    secret: 'api-secret-for-test',
    scope: 'mobile-refresh',
  }).deviceId, 'legacy-iphone');
});

test('mobile APNs registration is bearer-scoped and stores only the session device identity', async () => {
  const registrations = [];
  const removals = [];
  const app = registerFixture({
    pushTokenStore: {
      async upsert(record) {
        registrations.push(record);
      },
      async remove(record) {
        removals.push(record);
        return { removed: 1 };
      },
    },
    apnsConfigured: true,
    apnsTopic: 'com.brianwis.sonuvi',
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: {
      'x-mobile-enrollment-code': 'one-time-code',
    },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const token = sessionRes.body.accessToken;
  const authHeaders = { authorization: `Bearer ${token}` };
  const deviceToken = 'ab'.repeat(32);

  const invalidRes = createResponse();
  await app.routes.get('POST /v1/mobile/push-tokens')?.(request({
    headers: authHeaders,
    body: { token: 'not-a-device-token', environment: 'development' },
  }), invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const registerRes = createResponse();
  await app.routes.get('POST /v1/mobile/push-tokens')?.(request({
    headers: authHeaders,
    body: {
      token: deviceToken,
      environment: 'development',
      topic: 'com.brianwis.sonuvi',
      deviceId: 'attacker-device-id',
    },
  }), registerRes);
  assert.equal(registerRes.statusCode, 200);
  assert.deepEqual(registrations, [{
    token: deviceToken,
    deviceId: 'ipad-brian',
    environment: 'development',
    topic: 'com.brianwis.sonuvi',
  }]);

  const deleteRes = createResponse();
  await app.routes.get('DELETE /v1/mobile/push-tokens')?.(request({
    headers: authHeaders,
    body: {},
  }), deleteRes);
  assert.equal(deleteRes.statusCode, 200);
  assert.deepEqual(removals, [{ token: '', deviceId: 'ipad-brian' }]);
});

test('mobile catalog returns opaque IDs and never returns the MPD file path', async () => {
  const app = registerFixture();
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const token = sessionRes.body.accessToken;

  const res = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/albums')?.(request({
    headers: { authorization: `Bearer ${token}` },
    query: { limit: 10 },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.match(res.body.items[0].id, /^alb_/);
  assert.doesNotMatch(JSON.stringify(res.body), /SamsungMoode|01 - First|\.flac/);
});

test('mobile catalog includes verified source audio properties when available', async () => {
  const app = registerFixture({
    getSourceAudio: async (file) => file.endsWith('First.mp3')
      ? { sampleRateHz: 96000, bitDepth: 24, channels: 2 }
      : null,
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    query: { q: 'First' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items[0].sourceAudio, {
    sampleRateHz: 96000,
    bitDepth: 24,
    channels: 2,
  });

  const nowPlayingApp = registerFixture({
    getSourceAudio: async () => ({ sampleRateHz: 96000, bitDepth: 24, channels: 2 }),
    mpdQueryRaw: async (command) => command === 'status'
      ? 'state: play\nsong: 0\nsongid: 1\n'
      : 'file: USB/SamsungMoode/Test Album/01 - First.mp3\nPos: 0\nId: 1\n',
    fetchInternalJson: async () => ({
      ok: true,
      status: 200,
      json: { state: 'play', title: 'First', file: 'USB/SamsungMoode/Test Album/01 - First.mp3' },
    }),
  });
  const nowSession = createResponse();
  await nowPlayingApp.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), nowSession);
  const nowResponse = createResponse();
  await nowPlayingApp.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${nowSession.body.accessToken}` },
  }), nowResponse);
  assert.deepEqual(nowResponse.body.track.sourceAudio, {
    sampleRateHz: 96000,
    bitDepth: 24,
    channels: 2,
  });
});

test('mobile album catalog exposes safe added timestamps from the existing library metadata', async () => {
  const app = registerFixture({
    fetchInternalJson: async (pathname) => pathname === '/config/library-health/albums'
      ? {
        ok: true,
        json: {
          albums: [{ artist: 'Test Artist', album: 'Test Album', addedTs: 1234567890 }],
        },
      }
      : null,
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);

  const res = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/albums')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    query: { limit: 10 },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].addedAt, 1234567890);
  assert.doesNotMatch(JSON.stringify(res.body), /sampleFile|folder|SamsungMoode/);
});

test('mobile media authorization binds the ticket to the requested track', async () => {
  const app = registerFixture();
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const catalogRes = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/tracks/:trackId')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    params: { trackId: 'trk_invalid' },
  }), catalogRes);
  assert.equal(catalogRes.statusCode, 404);

  const searchRes = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    query: { q: 'First' },
  }), searchRes);
  const trackId = searchRes.body.items[0].id;

  const authRes = createResponse();
  await app.routes.get('POST /v1/mobile/media-authorizations')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { trackId, format: 'mp3' },
  }), authRes);

  assert.equal(authRes.statusCode, 200);
  assert.doesNotMatch(authRes.body.url, /SamsungMoode|First\.mp3/);
  const ticket = new URL(authRes.body.url).searchParams.get('ticket');
  const claims = verifyMobileToken(ticket, { secret: 'api-secret-for-test', scope: 'mobile-media' });
  assert.equal(claims.trackId, trackId);
  assert.equal(claims.deviceId, 'iphone-brian');
});

test('mobile canonical track rating is bearer-scoped and never exposes the source file', async () => {
  const calls = [];
  const app = registerFixture({
    getRatingForFile: async (file) => file.endsWith('First.mp3') ? 4 : 0,
    ratingsEnabled: async () => true,
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: { ok: true, rating: options.body?.rating, disabled: false },
      };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const authHeaders = { authorization: `Bearer ${sessionRes.body.accessToken}` };

  const searchRes = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: authHeaders,
    query: { q: 'First' },
  }), searchRes);
  const trackId = searchRes.body.items[0].id;

  const readRes = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/tracks/:trackId/rating')?.(request({
    headers: authHeaders,
    params: { trackId },
  }), readRes);
  assert.deepEqual(readRes.body, { ok: true, rating: 4, ratingDisabled: false, disabled: false });

  const writeRes = createResponse();
  await app.routes.get('POST /v1/mobile/catalog/tracks/:trackId/rating')?.(request({
    headers: authHeaders,
    params: { trackId },
    body: { rating: 5 },
  }), writeRes);
  assert.deepEqual(writeRes.body, { ok: true, rating: 5, ratingDisabled: false, disabled: false });
  assert.deepEqual(calls.map((call) => call.pathname), ['/rating']);
  assert.deepEqual(calls[0].options.body, {
    file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
    rating: 5,
  });
  assert.doesNotMatch(JSON.stringify(readRes.body), /SamsungMoode|First\.mp3/);
  assert.doesNotMatch(JSON.stringify(writeRes.body), /SamsungMoode|First\.mp3/);
});

test('mobile canonical track favorite is bearer-scoped and never exposes the source file', async () => {
  const calls = [];
  const app = registerFixture({
    getFavoriteForFile: async (file) => file.endsWith('First.mp3'),
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: { ok: true, isFavorite: Boolean(options.body?.favorite), disabled: false },
      };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const authHeaders = { authorization: `Bearer ${sessionRes.body.accessToken}` };

  const searchRes = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: authHeaders,
    query: { q: 'First' },
  }), searchRes);
  const trackId = searchRes.body.items[0].id;

  const readRes = createResponse();
  await app.routes.get('GET /v1/mobile/catalog/tracks/:trackId/favorite')?.(request({
    headers: authHeaders,
    params: { trackId },
  }), readRes);
  assert.deepEqual(readRes.body, { ok: true, isFavorite: true, disabled: false });

  const writeRes = createResponse();
  await app.routes.get('POST /v1/mobile/catalog/tracks/:trackId/favorite')?.(request({
    headers: authHeaders,
    params: { trackId },
    body: { favorite: false },
  }), writeRes);
  assert.deepEqual(writeRes.body, { ok: true, isFavorite: false, disabled: false });
  assert.deepEqual(calls.map((call) => call.pathname), ['/favorites/toggle']);
  assert.deepEqual(calls[0].options.body, {
    file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
    favorite: false,
  });
  assert.doesNotMatch(JSON.stringify(readRes.body), /SamsungMoode|First\.mp3/);
  assert.doesNotMatch(JSON.stringify(writeRes.body), /SamsungMoode|First\.mp3/);
});

test('local-source manifest maps canonical track IDs without exposing absolute server paths', async () => {
  const manifestIndex = fixtureIndex();
  manifestIndex.tracks = manifestIndex.tracks.map((track) => ({
    ...track,
    file: track.file.replace(
      'USB/SamsungMoode/',
      'USB/SamsungMoode/Ondesoft/'
    ),
  }));
  const app = registerFixture({
    getBrowseIndex: async () => manifestIndex,
    musicLibraryRoot: '/tmp/music',
    mpdFileToLocalPath: (file) => `/tmp/music/${file.replace('USB/SamsungMoode/', '')}`,
    safeIsFile: () => true,
    statLocalFile: async () => ({ size: 1234 }),
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);

  const res = createResponse();
  await app.routes.get('GET /v1/mobile/local-source/manifest')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schema, 'now-playing.mobile-local-source-manifest.v1');
  assert.equal(res.body.entries.length, 2);
  assert.ok(res.body.entries.every((entry) => entry.trackId.startsWith('trk_')));
  assert.ok(res.body.entries.every((entry) => !entry.relativePath.startsWith('/')));
  assert.ok(res.body.entries.every((entry) => !JSON.stringify(entry).includes('/tmp/')));
  assert.ok(res.body.entries.every((entry) => entry.sizeBytes === 1234));
  assert.equal(res.body.entries[0].relativePath, 'Ondesoft/Test Album/01 - First.mp3');
  assert.equal(res.body.entries[0].contentPath, 'Test Album/01 - First.mp3');
});

test('native playback events resolve the canonical track and feed shared history', async () => {
  let observed = null;
  const app = registerFixture({
    listeningHistory: {
      observe: async (event) => {
        observed = event;
        return { recorded: true, reason: 'recorded' };
      },
    },
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const searchRes = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    query: { q: 'First' },
  }), searchRes);
  const trackId = searchRes.body.items[0].id;

  const res = createResponse();
  await app.routes.get('POST /v1/mobile/playback/events')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    body: {
      trackId,
      sessionId: 'device-session-1',
      state: 'progress',
      elapsedSec: 78,
      durationSec: 123,
      startedAtMs: Date.now() - 60_000,
      file: '/client/should-not-be-used.mp3',
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.trackId, trackId);
  assert.equal(res.body.recorded, true);
  assert.equal(observed.source, 'ios-device');
  assert.equal(observed.sessionId, 'mobile:device-session-1');
  assert.equal(observed.song.file, 'USB/SamsungMoode/Test Album/01 - First.mp3');
  assert.equal(observed.song.title, 'First');
  assert.equal(observed.status.elapsedSec, 78);
});

test('native playback events reject unknown canonical IDs instead of creating local identities', async () => {
  const app = registerFixture({
    listeningHistory: { observe: async () => ({ recorded: false }) },
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);

  const res = createResponse();
  await app.routes.get('POST /v1/mobile/playback/events')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    body: {
      trackId: 'portable-ssd:track:missing.flac',
      sessionId: 'device-session-2',
      state: 'start',
    },
  }), res);

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /track not found/);
});

test('native playback start invokes the APNs bridge with the canonical track', async () => {
  let notified = null;
  const app = registerFixture({
    listeningHistory: { observe: async () => ({ recorded: true, reason: 'recorded' }) },
    notifyNativePlayback: async (event) => {
      notified = event;
    },
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const searchRes = createResponse();
  await app.routes.get('GET /v1/mobile/search')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    query: { q: 'First' },
  }), searchRes);
  const trackId = searchRes.body.items[0].id;

  const res = createResponse();
  await app.routes.get('POST /v1/mobile/playback/events')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    body: {
      trackId,
      sessionId: 'device-session-apns',
      state: 'start',
      elapsedSec: 0,
      durationSec: 123,
    },
  }), res);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 200);
  assert.equal(notified.track.id, trackId);
  assert.equal(notified.track.file, 'USB/SamsungMoode/Test Album/01 - First.mp3');
  assert.equal(notified.sessionId, 'device-session-apns');
  assert.equal(notified.deviceId, 'ipad-brian');
});

test('native podcast playback resolves its opaque episode ID for the APNs bridge', async () => {
  const notifications = [];
  const rss = 'https://feeds.example.test/show.rss';
  const app = registerFixture({
    fetchInternalRequest: async (pathname) => {
      if (pathname === '/podcasts') {
        return {
          ok: true,
          json: {
            items: [{
              title: 'Example Show',
              rss,
              dir: '/tmp/Example Show',
              mpdPrefix: 'USB/SamsungMoode/Podcasts/Example Show',
            }],
          },
        };
      }
      if (pathname === '/podcasts/episodes/list') {
        return {
          ok: true,
          json: {
            episodes: [{
              id: 'episode-1',
              title: 'Episode One',
              downloaded: true,
              filename: 'episode-1.mp3',
              mpdPath: 'USB/SamsungMoode/Podcasts/Example Show/episode-1.mp3',
              imageUrl: 'https://images.example.test/episode-one.jpg',
            }],
          },
        };
      }
      throw new Error(`unexpected internal route: ${pathname}`);
    },
    listeningHistory: { observe: async () => ({ recorded: true, reason: 'recorded' }) },
    notifyNativePlayback: async (event) => {
      notifications.push(event);
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const authHeaders = { authorization: `Bearer ${sessionRes.body.accessToken}` };

  const podcastsRes = createResponse();
  await app.routes.get('GET /v1/mobile/podcasts')?.(request({ headers: authHeaders }), podcastsRes);
  const podcastId = podcastsRes.body.items[0].id;
  const trackId = `podcast-${podcastId}-episode-1`;

  const playbackRes = createResponse();
  await app.routes.get('POST /v1/mobile/playback/events')?.(request({
    headers: authHeaders,
    body: {
      trackId,
      sessionId: 'device-session-podcast',
      state: 'start',
      elapsedSec: 0,
      durationSec: 0,
    },
  }), playbackRes);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(playbackRes.statusCode, 200);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].track.id, trackId);
  assert.equal(notifications[0].track.file, 'USB/SamsungMoode/Podcasts/Example Show/episode-1.mp3');
  assert.equal(notifications[0].track.title, 'Episode One');
  assert.equal(notifications[0].track.artist, 'Example Show');
  assert.equal(notifications[0].track.artworkUrl, 'https://images.example.test/episode-one.jpg');
  assert.equal(notifications[0].deviceId, 'ipad-brian');
});

test('native radio playback defers APNs until enriched metadata is available', async () => {
  const notifications = [];
  const streamFile = 'https://radio.example.test/live.mp3';
  const app = registerFixture({
    listeningHistory: { observe: async () => ({ recorded: true, reason: 'recorded' }) },
    fetchInternalRequest: async (pathname) => pathname === '/config/queue-wizard/radio-preview'
      ? {
        ok: true,
        json: {
          tracks: [{
            file: streamFile,
            stationName: 'Example Radio',
            logoName: 'Example Radio',
            genre: 'Jazz',
            format: 'mp3',
            bitrate: '128',
          }],
        },
      }
      : { ok: true, json: {} },
    enrichRadioMetadata: async ({ artist, title }) => ({
      matched: true,
      artist: 'Miles Davis',
      title: 'Blue in Green',
      album: 'Kind of Blue',
      year: '1959',
      artworkUrl: 'https://images.example.test/kind-of-blue.jpg',
      trackUrl: 'https://music.apple.com/us/song/blue-in-green/268443106',
      reason: 'matched',
    }),
    notifyNativePlayback: async (event) => {
      notifications.push(event);
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;
  const authHeaders = { authorization: `Bearer ${sessionToken}` };

  const stationsRes = createResponse();
  await app.routes.get('GET /v1/mobile/radio')?.(request({ headers: authHeaders }), stationsRes);
  const stationId = stationsRes.body.items[0].id;
  const radioTrackId = `radio-${stationId}`;

  const playbackRes = createResponse();
  await app.routes.get('POST /v1/mobile/playback/events')?.(request({
    headers: authHeaders,
    body: {
      trackId: radioTrackId,
      sessionId: 'device-session-radio',
      state: 'start',
    },
  }), playbackRes);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playbackRes.statusCode, 200);
  assert.equal(notifications.length, 0);

  const metadataRes = createResponse();
  await app.routes.get('POST /v1/mobile/radio/metadata')?.(request({
    headers: authHeaders,
    body: {
      stationId,
      artist: 'Miles Davis',
      title: 'Blue in Green',
    },
  }), metadataRes);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(metadataRes.statusCode, 200);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].track.id, radioTrackId);
  assert.equal(notifications[0].track.file, streamFile);
  assert.equal(notifications[0].track.title, 'Blue in Green');
  assert.equal(notifications[0].track.artist, 'Miles Davis');
  assert.equal(notifications[0].track.album, 'Kind of Blue');
  assert.equal(notifications[0].track.artworkMatched, true);
  assert.equal(notifications[0].track.artworkUrl, 'https://images.example.test/kind-of-blue.jpg');
  assert.doesNotMatch(notifications[0].track.artworkUrl, /\/v1\/mobile\/home\/artwork\//);
  assert.equal(notifications[0].track.appleMusicUrl, 'https://music.apple.com/us/song/blue-in-green/268443106');
  assert.equal(notifications[0].sessionId, 'ipad-brian');
  assert.equal(notifications[0].deviceId, 'ipad-brian');
});

test('mobile radio stream authorization keeps the station URL behind a scoped ticket', async () => {
  const app = registerFixture({
    fetchInternalRequest: async (pathname) => {
      if (pathname === '/config/queue-wizard/radio-preview') {
        return {
          ok: true,
          json: {
            tracks: [{
              file: 'https://radio.example.test/live.mp3',
              stationName: 'Example Radio',
              genre: 'Jazz',
              format: 'mp3',
              bitrate: '128',
            }],
          },
        };
      }
      return { ok: true, json: {} };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const stationsRes = createResponse();
  await app.routes.get('GET /v1/mobile/radio')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
  }), stationsRes);
  assert.equal(stationsRes.statusCode, 200);
  const stationId = stationsRes.body.items[0].id;

  const authRes = createResponse();
  await app.routes.get('POST /v1/mobile/radio/stream-authorizations')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { stationId },
  }), authRes);

  assert.equal(authRes.statusCode, 200);
  assert.doesNotMatch(authRes.body.url, /radio\.example\.test/);
  const ticket = new URL(authRes.body.url).searchParams.get('ticket');
  const claims = verifyMobileToken(ticket, { secret: 'api-secret-for-test', scope: 'mobile-radio' });
  assert.equal(claims.stationId, stationId);
  assert.equal(claims.deviceId, 'iphone-brian');
});

test('mobile radio station artwork uses the catalog logo name behind an opaque URL', async () => {
  let artworkDescriptor = null;
  const streamFile = 'https://stream.revma.ihrhls.com/zc6784';
  const app = registerFixture({
    fetchInternalRequest: async (pathname) => pathname === '/config/queue-wizard/radio-preview'
      ? {
        ok: true,
        json: {
          tracks: [{
            file: streamFile,
            stationName: 'Rat Pack Radio',
            logoName: 'iHeart Rat Pack Radio',
            genre: 'Jazz',
            format: 'aac',
            bitrate: '128',
          }],
        },
      }
      : { ok: true, json: {} },
    serveHomeArtwork: async (res, descriptor) => {
      artworkDescriptor = descriptor;
      return res.json({ ok: true, descriptor });
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const stationsRes = createResponse();
  await app.routes.get('GET /v1/mobile/radio')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), stationsRes);

  assert.equal(stationsRes.statusCode, 200);
  const artworkURL = stationsRes.body.items[0].artworkUrl;
  assert.match(artworkURL, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.doesNotMatch(artworkURL, /zc6784|Rat%20Pack/);

  const artworkId = artworkURL.split('/').at(-1);
  const artworkRes = createResponse();
  await app.routes.get('GET /v1/mobile/home/artwork/:artworkId')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    params: { artworkId },
  }), artworkRes);

  assert.equal(artworkRes.statusCode, 200);
  assert.deepEqual(artworkDescriptor, { kind: 'radio', reference: 'iHeart Rat Pack Radio' });
});

test('mobile direct radio metadata returns enriched art and a safe Apple Music link', async () => {
  const app = registerFixture({
    fetchInternalJson: async (pathname) => pathname === '/now-playing'
      ? {
        ok: true,
        json: {
          isRadio: true,
          isStream: true,
          artist: 'Miles Davis',
          title: 'Blue in Green',
          album: 'Kind of Blue',
          radioTrackUrl: 'https://music.apple.com/us/song/blue-in-green/268443106',
          about: {
            type: 'album',
            text: 'The canonical album editorial note.',
            source: 'apple',
            sourceId: 'album-268443106',
          },
          aboutStatus: 'available',
          aboutProvider: 'apple',
        },
      }
      : { ok: true, json: {} },
    fetchInternalRequest: async (pathname) => pathname === '/config/queue-wizard/radio-preview'
      ? {
        ok: true,
        json: {
          tracks: [{
            file: 'https://radio.example.test/live.mp3',
            stationName: 'Example Radio',
            genre: 'Jazz',
            format: 'mp3',
            bitrate: '128',
          }],
        },
      }
      : { ok: true, json: {} },
    enrichRadioMetadata: async ({ artist, title }) => ({
      matched: true,
      artist,
      title,
      album: 'Kind of Blue',
      year: '1959',
      artworkUrl: 'https://images.example.test/kind-of-blue.jpg',
      trackUrl: 'https://music.apple.com/us/song/blue-in-green/268443106',
      reason: 'matched',
    }),
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const stationsRes = createResponse();
  await app.routes.get('GET /v1/mobile/radio')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
  }), stationsRes);
  const stationId = stationsRes.body.items[0].id;

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/radio/metadata')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    body: {
      stationId,
      artist: 'Miles Davis',
      title: 'Blue in Green',
    },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.matched, true);
  assert.equal(response.body.album, 'Kind of Blue');
  assert.equal(response.body.year, '1959');
  assert.equal(response.body.appleMusicUrl, 'https://music.apple.com/us/song/blue-in-green/268443106');
  assert.equal(response.body.about?.type, 'album');
  assert.equal(response.body.about?.text, 'The canonical album editorial note.');
  assert.equal(response.body.aboutStatus, 'available');
  assert.equal(response.body.aboutProvider, 'apple');
  assert.match(response.body.artworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
});

test('mobile direct radio metadata reuses canonical About when enrichment is partial', async () => {
  const app = registerFixture({
    fetchInternalJson: async (pathname) => pathname === '/now-playing'
      ? {
        ok: true,
        json: {
          isStream: true,
          displayArtist: 'Tom Petty',
          displayTitle: 'American Girl',
          displayLine3: 'Tom Petty and the Heartbreakers',
          about: {
            type: 'album',
            text: 'The canonical moOde editorial note.',
            source: 'apple',
          },
          aboutStatus: 'available',
          aboutProvider: 'apple',
        },
      }
      : { ok: true, json: {} },
    fetchInternalRequest: async (pathname) => pathname === '/config/queue-wizard/radio-preview'
      ? {
        ok: true,
        json: {
          tracks: [{
            file: 'https://radio.example.test/live.mp3',
            stationName: 'Example Radio',
            genre: 'Rock',
            format: 'mp3',
            bitrate: '128',
          }],
        },
      }
      : { ok: true, json: {} },
    enrichRadioMetadata: async () => ({
      matched: false,
      reason: 'metadata arrived between Apple lookups',
    }),
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const stationsRes = createResponse();
  await app.routes.get('GET /v1/mobile/radio')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
  }), stationsRes);
  const stationId = stationsRes.body.items[0].id;

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/radio/metadata')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    body: {
      stationId,
      artist: 'Tom Petty',
      title: 'American Girl',
      album: 'Tom Petty and the Heartbreakers',
    },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.matched, false);
  assert.equal(response.body.about?.type, 'album');
  assert.equal(response.body.about?.text, 'The canonical moOde editorial note.');
  assert.equal(response.body.aboutStatus, 'available');
  assert.equal(response.body.aboutProvider, 'apple');
});

test('mobile animated-art lookup reuses the server cache without exposing admin paths', async () => {
  const lookupPaths = [];
  const app = registerFixture({
    fetchInternalJson: async (pathname) => {
      lookupPaths.push(pathname);
      return {
        ok: true,
        json: {
          ok: true,
          hit: {
            mp4: 'http://127.0.0.1:3101/config/library-health/animated-art/media/0123456789abcdef0123456789abcdef01234567.mp4',
          },
        },
      };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const unauthorized = createResponse();
  await app.routes.get('GET /v1/mobile/animated-art')?.(request({
    query: { artist: 'Test Artist', album: 'Test Album' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const local = createResponse();
  await app.routes.get('GET /v1/mobile/animated-art')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    query: { artist: 'Test Artist', album: 'Test Album' },
  }), local);
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.ok, true);
  assert.equal(local.body.hasMotion, true);
  assert.match(local.body.mediaUrl, /^https:\/\/now-playing\.tailnet\.test\/config\/library-health\/animated-art\/media\//);
  assert.doesNotMatch(local.body.mediaUrl, /127\.0\.0\.1|track-key|SamsungMoode|\.flac/);
  assert.match(lookupPaths[0], /^\/config\/library-health\/animated-art\/lookup\?/);

  const radio = createResponse();
  await app.routes.get('GET /v1/mobile/animated-art')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    query: { appleMusicUrl: 'https://music.apple.com/us/album/sob-rock/1568819304' },
  }), radio);
  assert.equal(radio.statusCode, 200);
  assert.equal(radio.body.hasMotion, true);
  assert.match(lookupPaths[1], /^\/config\/library-health\/animated-art\/radio-lookup\?/);

  const malformed = createResponse();
  await app.routes.get('GET /v1/mobile/animated-art')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
    query: { artist: 'Test Artist' },
  }), malformed);
  assert.equal(malformed.statusCode, 400);
});

test('mobile playlists require a bearer session and preserve opaque ordered entries', async () => {
  const app = registerFixture();

  const unauthenticated = createResponse();
  await app.routes.get('GET /v1/mobile/playlists')?.(request(), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const trackKeyOnly = createResponse();
  await app.routes.get('GET /v1/mobile/playlists')?.(request({
    headers: { 'x-track-key': 'admin-track-key' },
  }), trackKeyOnly);
  assert.equal(trackKeyOnly.statusCode, 401);

  const invalidBearer = createResponse();
  await app.routes.get('GET /v1/mobile/playlists')?.(request({
    headers: { authorization: 'Bearer not-a-valid-mobile-token' },
  }), invalidBearer);
  assert.equal(invalidBearer.statusCode, 401);

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const token = sessionRes.body.accessToken;

  const listRes = createResponse();
  await app.routes.get('GET /v1/mobile/playlists')?.(request({
    headers: { authorization: `Bearer ${token}` },
  }), listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.total, 1);
  const summary = listRes.body.items[0];
  assert.match(summary.id, /^pl_[A-Za-z0-9_-]+$/);
  assert.match(summary.revision, /^rev_[A-Za-z0-9_-]+$/);
  assert.equal(summary.name, 'Road Trip');
  assert.equal(summary.trackCount, 3);
  assert.equal(summary.updatedAt, '2026-09-25T00:00:00.000Z');
  assert.match(summary.artworkUrl, /^https:\/\/now-playing\.tailnet\.test\/v1\/mobile\/playlists\/pl_[A-Za-z0-9_-]+\/artwork$/);
  assert.doesNotMatch(JSON.stringify(listRes.body), /SamsungMoode|Unavailable/);

  const rawName = createResponse();
  await app.routes.get('GET /v1/mobile/playlists/:playlistId')?.(request({
    headers: { authorization: `Bearer ${token}` },
    params: { playlistId: 'Road Trip' },
  }), rawName);
  assert.equal(rawName.statusCode, 404);

  const detailRes = createResponse();
  await app.routes.get('GET /v1/mobile/playlists/:playlistId')?.(request({
    headers: { authorization: `Bearer ${token}` },
    params: { playlistId: summary.id },
  }), detailRes);
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.body.playlist.id, summary.id);
  assert.deepEqual(detailRes.body.entries.map((entry) => entry.position), [1, 2, 3]);
  assert.equal(detailRes.body.entries[0].track.id, detailRes.body.entries[1].track.id);
  assert.equal(detailRes.body.entries[0].available, true);
  assert.equal(detailRes.body.entries[2].available, false);
  assert.equal(detailRes.body.entries[2].track, null);
  assert.equal(detailRes.body.entries[2].unavailableReason, 'track is unavailable in the mobile catalog');
  assert.doesNotMatch(JSON.stringify(detailRes.body), /SamsungMoode|First\.mp3|Unavailable/);

  const artworkRes = createResponse();
  await app.routes.get('GET /v1/mobile/playlists/:playlistId/artwork')?.(request({
    headers: { authorization: `Bearer ${token}` },
    params: { playlistId: summary.id },
  }), artworkRes);
  assert.equal(artworkRes.statusCode, 200);
  assert.deepEqual(artworkRes.body, { ok: true, name: 'Road Trip' });
});

test('mobile home discovery rows require a bearer session, not a Track Key', async () => {
  const app = registerFixture();

  const unauthenticated = createResponse();
  await app.routes.get('GET /v1/mobile/home/rows')?.(request(), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const trackKeyOnly = createResponse();
  await app.routes.get('GET /v1/mobile/home/rows')?.(request({
    headers: { 'x-track-key': 'admin-track-key' },
  }), trackKeyOnly);
  assert.equal(trackKeyOnly.statusCode, 401);
});

test('mobile home exposes local recent history without displaying its shelf', async () => {
  const profile = {
    recentRows: ['albums', 'playlists', 'podcasts', 'radio'],
    recentCount: 18,
  };
  const calls = [];
  const app = registerFixture({
    fetchInternalJson: async (pathname) => {
      calls.push(pathname);
      if (pathname === '/config/controller-profile') {
        return { ok: true, json: { profile } };
      }
      if (pathname === '/config/listening-history/recent-tracks?limit=18') {
        return {
          ok: true,
          json: {
            items: [{
              title: 'First', artist: 'Test Artist', album: 'Test Album',
              file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
            }],
          },
        };
      }
      return { ok: true, json: { items: [] } };
    },
  });
  const session = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), session);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/home/rows')?.(request({
    headers: { authorization: `Bearer ${session.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.rows.map((row) => row.id), profile.recentRows);
  assert.equal(response.body.localRecentHistory.id, 'local-recenttracks');
  assert.equal(response.body.localRecentHistory.items[0].track.genre, 'Test');
  assert.ok(calls.includes('/config/listening-history/recent-tracks?limit=18'));
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode/);
});

test('mobile home shelf settings save ordered row sources through the bearer boundary', async () => {
  const calls = [];
  const currentProfile = {
    devicePreset: 'tablet',
    theme: 'auto',
    layout: 'home-rail',
    showRecent: true,
    recentSource: 'albums',
    recentRows: ['albums', 'playlists', 'podcasts', 'radio'],
    colorPreset: 'violet',
    recentCount: 18,
    customColors: {
      primaryThemeColor: '#123456',
      secondaryThemeColor: '#234567',
      primaryTextColor: '#fefefe',
      secondaryTextColor: '#ababab',
    },
  };
  const app = registerFixture({
    fetchInternalJson: async (pathname) => {
      assert.equal(pathname, '/config/controller-profile');
      return { ok: true, status: 200, json: { ok: true, profile: currentProfile } };
    },
    fetchInternalRequest: async (pathname, options) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, json: { ok: true, profile: options.body.profile } };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/home/profile')?.(request({
    headers: { authorization: "Bearer " + sessionRes.body.accessToken },
    body: { recentRows: ['queue', 'lastfm-topartists', 'albums', 'radio'] },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.profile.recentRows, [
    'queue',
    'lastfm-topartists',
    'albums',
    'radio',
  ]);
  assert.equal(response.body.profile.colorPreset, 'violet');
  assert.deepEqual(calls.map((call) => call.pathname), ['/config/controller-profile']);
  assert.deepEqual(calls[0].options.body.profile.customColors, currentProfile.customColors);
});

test('mobile now-playing returns safe metadata and proxies raw artwork behind bearer auth', async () => {
  const app = registerFixture({
    fetchInternalJson: async (pathname) => {
      assert.equal(pathname, '/now-playing');
      return {
        ok: true,
        status: 200,
        json: {
          state: 'play',
          title: 'First',
          artist: 'Test Artist',
          album: 'Test Album',
          displayTitle: 'First',
          displayArtist: 'Test Artist',
          displayLine3: 'Test Album',
          duration: 123,
          elapsed: 12,
          queueTrack: 3,
          queueTotal: 9,
          albumArtUrl: 'http://moode.local/coverart.php/secret-file.jpg',
          isStream: false,
          isPodcast: false,
          isRadio: false,
          personnel: ['Test Musician (piano)', 'Test Ensemble'],
          about: {
            type: 'album',
            text: 'Canonical About text survives the mobile projection.',
            source: 'apple',
          },
          aboutStatus: 'available',
          aboutProvider: 'apple',
        },
      };
    },
  });

  const unauthenticated = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request(), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.available, true);
  assert.equal(response.body.title, 'First');
  assert.equal(response.body.artist, 'Test Artist');
  assert.equal(response.body.isPlaying, true);
  assert.equal(response.body.queueTrack, 3);
  assert.equal(response.body.queueTotal, 9);
  assert.deepEqual(response.body.personnel, ['Test Musician (piano)', 'Test Ensemble']);
  assert.equal(response.body.about?.type, 'album');
  assert.equal(response.body.about?.text, 'Canonical About text survives the mobile projection.');
  assert.equal(response.body.aboutStatus, 'available');
  assert.equal(response.body.aboutProvider, 'apple');
  assert.equal(response.body.appleMusicUrl, null);
  assert.equal(response.body.radioYear, null);
  assert.match(response.body.artworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.match(response.body.backgroundArtworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.doesNotMatch(JSON.stringify(response.body), /coverart|secret-file|SamsungMoode/);
});

test('mobile now-playing keeps managed UPnP as a track source and exposes animated-art context', async () => {
  const app = registerFixture({
    fetchInternalJson: async () => ({
      ok: true,
      status: 200,
      json: {
        source: 'upnp-sonuvi',
        controller: 'sonuvi',
        state: 'play',
        title: 'Remote Track',
        artist: 'Remote Artist',
        album: 'Remote Album',
        file: 'upnp-sonuvi',
        albumArtUrl: 'http://10.0.0.254:8200/art/album.jpg',
        isStream: true,
        isUpnp: true,
        animatedArt: {
          version: 'now-playing-animated-art.v1',
          source: 'upnp-sonuvi',
          eligible: true,
          identity: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef',
          artist: 'Remote Artist',
          album: 'Remote Album',
          title: 'Remote Track',
        },
      },
    }),
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'upnp-iphone' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.isUpnp, true);
  assert.equal(response.body.isRadio, false);
  assert.equal(response.body.source, 'upnp-sonuvi');
  assert.equal(response.body.animatedArt.source, 'upnp-sonuvi');
  assert.equal(response.body.animatedArt.eligible, true);
  assert.match(response.body.animatedArt.identity, /^sha256:[a-f0-9]{24}$/);
  assert.match(response.body.artworkUrl, /\/v1\/mobile\/home\/artwork\//);
  assert.doesNotMatch(JSON.stringify(response.body), /10\.0\.0\.254|album\.jpg/);
});

test('mobile now-playing reports MPD repeat, single, random, and consume state', async () => {
  const app = registerFixture({
    mpdQueryRaw: async (command) => command === 'status'
      ? 'state: play\nrepeat: on\nsingle: on\nrandom: off\nconsume: on\nsong: 0\nsongid: 1\n'
      : 'file: USB/SamsungMoode/Test Album/01 - First.mp3\nPos: 0\nId: 1\n',
    fetchInternalJson: async () => ({
      ok: true,
      status: 200,
      json: { state: 'play', title: 'First', file: 'USB/SamsungMoode/Test Album/01 - First.mp3' },
    }),
  });
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.randomOn, false);
  assert.equal(response.body.repeatOn, true);
  assert.equal(response.body.singleOn, true);
  assert.equal(response.body.consumeOn, true);
});

test('mobile now-playing follows the fresh Alexa current-track authority', async () => {
  const app = registerFixture({
    mpdQueryRaw: async (command) => {
      if (command === 'playlistinfo') {
        return [
          'file: USB/SamsungMoode/Test Album/01 - First.mp3',
          'pos: 0',
          'id: 41',
          '',
          'file: USB/SamsungMoode/Test Album/02 - Second.flac',
          'pos: 1',
          'id: 42',
          '',
          'file: USB/SamsungMoode/Test Album/01 - First.mp3',
          'pos: 2',
          'id: 43',
          'OK',
        ].join(String.fromCharCode(10));
      }
      if (command === 'status') {
        return [
          'state: play',
          'song: 0',
          'songid: 41',
          'playlistlength: 3',
          'random: 0',
          'OK',
        ].join(String.fromCharCode(10));
      }
      return 'OK' + String.fromCharCode(10);
    },
    fetchInternalJson: async (pathname) => {
      if (pathname === '/now-playing') {
        return {
          ok: true,
          status: 200,
          json: {
            state: 'pause',
            title: 'Slow Hot Wind',
            artist: 'Pat Metheny',
            album: "What's It All About",
            file: 'USB/SamsungMoode/Test Album/01 - Slow Hot Wind.flac',
          },
        };
      }
      if (pathname === '/alexa/was-playing') {
        return {
          ok: true,
          status: 200,
          json: {
            fresh: true,
            wasPlaying: {
              active: true,
              modeActive: false,
              playbackTarget: 'echo',
              playbackMode: 'alexa',
            },
            nowPlaying: {
              state: 'play',
              active: true,
              modeActive: false,
              alexaMode: false,
              playbackTarget: 'echo',
              playbackMode: 'alexa',
              title: 'Alfie',
              artist: 'Pat Metheny',
              album: "What's It All About",
              file: 'USB/SamsungMoode/Test Album/02 - Second.flac',
              albumArtUrl: 'http://moode.local/coverart.php/secret-alexa.jpg',
              rating: 4,
              ratingDisabled: false,
              queuedNextToken: 'successor-token',
              queuedNextForToken: 'current-token',
            },
          },
        };
      }
      throw new Error(`unexpected internal route ${pathname}`);
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.title, 'Alfie');
  assert.equal(response.body.artist, 'Pat Metheny');
  assert.equal(response.body.album, "What's It All About");
  assert.equal(response.body.state, 'play');
  assert.equal(response.body.isPlaying, true);
  assert.equal(response.body.queueTrack, null);
  assert.equal(response.body.queueTotal, 3);
  assert.equal(response.body.rating, 4);
  assert.match(response.body.artworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.doesNotMatch(JSON.stringify(response.body), /secret-alexa|SamsungMoode/);
});

test('mobile audio info requires bearer auth and strips internal source metadata', async () => {
  const app = registerFixture({
    fetchInternalJson: async (pathname) => {
      assert.equal(pathname, '/config/moode/audio-info?view=rows&diagnostics=1');
      return {
        ok: true,
        status: 200,
        json: {
          sourceUrl: 'http://moode.local/audioinfo.php',
          fetchedAt: '2026-09-30T12:00:00.000Z',
          rows: [
            { section: 'Input / Output', key: 'Source', value: 'USB/SamsungMoode/Album/01 - Track.flac' },
            { section: 'Input / Output', key: 'Playable URL', value: 'https://stream.example.org/live?private=never-forward' },
            { section: 'Input / Output', key: 'Decoded to', value: 'PCM 24 bit 44.1 kHz, Stereo' },
            { section: 'Audio Device', key: 'Device', value: 'Test DAC' },
            { section: 'Audio Device', key: 'Sample rate', value: '192 kHz' },
            { section: '', key: '', value: 'discarded' },
          ],
          diagnostics: {
            version: 'audio-info.v1',
            capturedAt: '2026-09-30T12:00:00.000Z',
            freshness: {
              mode: 'on-demand',
              capturedAt: '2026-09-30T12:00:00.000Z',
              hardwareMeasuredAt: '2026-09-30T12:00:00.000Z',
            },
            renderer: 'mpd',
            sourceFormat: {
              format: 'FLAC 24 bit 96 kHz, Stereo',
              codec: 'FLAC',
              bitDepth: 24,
              sampleRateHz: 96000,
              channels: 2,
              provenance: 'moode-audioinfo.php',
              valueType: 'source-reported',
              live: true,
              measured: false,
            },
            decodedPcm: {
              format: 'PCM 24 bit 96 kHz, Stereo',
              codec: 'PCM',
              bitDepth: 24,
              sampleRateHz: 96000,
              channels: 2,
              provenance: 'moode-audioinfo.php',
              valueType: 'decoded-reported',
              live: true,
              measured: false,
            },
            sourceFile: {
              format: 'M4A 44.1 kHz, Stereo',
              container: 'M4A',
              codec: 'AAC-LC',
              codecStatus: 'verified',
              codecKind: 'lossy',
              bitDepth: null,
              bitDepthStatus: 'not-applicable',
              bitDepthKind: null,
              sampleRateHz: 44100,
              channels: 2,
              encodedBitrateBps: 270000,
              encodedBitrateKbps: 270,
              encodedBitrateStatus: 'reported',
              encodedBitrateProvenance: 'ffprobe.stream',
              provenance: 'ffprobe.source-file',
              valueType: 'source-file',
              live: true,
              measured: false,
              verified: true,
              streamUrl: 'https://stream.example.org/live?private=never-forward',
              probeError: 'upstream probe failed: private diagnostic detail',
            },
            decodedAudio: {
              format: 'PCM',
              codec: 'PCM',
              bitDepth: 24,
              bitDepthKind: 'integer',
              sampleRateHz: 44100,
              channels: 2,
              pcmBitrateBps: 2116800,
              pcmBitrateStatus: 'calculated',
              provenance: 'moode-audioinfo.php',
              valueType: 'decoded-reported',
              live: true,
              measured: false,
              configured: false,
            },
            configuredOutput: {
              alsaMode: 'plughw',
              audioChain: 'MPD → plughw → Device',
              provenance: 'moode-audioinfo.php',
              valueType: 'configured',
              live: false,
              measured: false,
              configured: true,
            },
            hardwareOutput: {
              value: 'PCM S32_LE 96 kHz 2ch',
              state: 'running',
              device: 'DAC / USB Audio',
              interface: 'USB Audio',
              card: 'DAC',
              format: 'S32_LE',
              bitDepth: 32,
              sampleRateHz: 96000,
              channels: 2,
              provenance: 'alsa-procfs',
              valueType: 'hardware-measured',
              live: true,
              measured: true,
              configured: false,
              measuredAt: '2026-09-30T12:00:00.000Z',
              reason: 'Read from the active ALSA playback hw_params/status files',
            },
            output: {
              value: 'PCM S32_LE 96 kHz 2ch',
              state: 'running',
              device: 'DAC / USB Audio',
              interface: 'USB Audio',
              card: 'DAC',
              format: 'S32_LE',
              bitDepth: 32,
              sampleRateHz: 96000,
              channels: 2,
              provenance: 'alsa-procfs',
              valueType: 'hardware-measured',
              live: true,
              measured: true,
              configured: false,
              measuredAt: '2026-09-30T12:00:00.000Z',
              reason: 'Read from the active ALSA playback hw_params/status files',
            },
            processing: {
              resampling: 'Off',
              quality: 'Off',
              selective: 'Off',
              polarityInversion: 'Off',
              crossfade: 'Off',
              crossfeed: 'Off',
              parametricEq: 'Off',
              graphicEq: 'Off',
              camillaDsp: 'Off',
              replayGain: 'off',
              normalization: 'off',
              chipOptions: 'None',
              provenance: 'moode-audioinfo.php',
              valueType: 'configured',
              live: false,
              measured: false,
              configured: true,
            },
            volume: {
              type: 'Fixed (0dB output)',
              levels: 'Knob 0, ALSA none, CDSP 0dB',
              provenance: 'moode-audioinfo.php',
              valueType: 'configured',
              live: false,
              measured: false,
              configured: true,
            },
            conversion: {
              status: 'unknown',
              reason: 'Read-only ALSA hw_params reports the negotiated endpoint format, not every transformation before it',
              provenance: 'alsa-procfs+moode-audioinfo.php',
              valueType: 'not-measured',
              live: false,
              measured: false,
              configured: false,
            },
            collection: {
              session: { status: 'available', code: null, provenance: 'sonuvi-moode-readonly-v1', capturedAt: '2026-09-30T12:00:00.000Z', live: true },
              rendererReport: { status: 'unavailable', code: 'SONUVI_MOODE_SESSION_UNAVAILABLE', provenance: 'sonuvi-moode-readonly-v1', capturedAt: '2026-09-30T12:00:00.000Z', live: false },
              mpd: { status: 'available', code: null, provenance: 'mpd-status', capturedAt: '2026-09-30T12:00:00.000Z', live: true },
              alsa: { status: 'unavailable', code: 'private_session_value', provenance: 'alsa-procfs', capturedAt: '2026-09-30T12:00:00.000Z', live: false },
            },
          },
        },
      };
    },
  });

  const unauthenticated = createResponse();
  await app.routes.get('GET /v1/mobile/audio-info')?.(request(), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/audio-info')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.rows, [
    { section: 'Input / Output', key: 'Source', value: 'Local file' },
    { section: 'Input / Output', key: 'Playable URL', value: 'Network stream' },
    { section: 'Input / Output', key: 'Decoded to', value: 'PCM 24 bit 44.1 kHz, Stereo' },
    { section: 'Audio Device', key: 'Device', value: 'Test DAC' },
    { section: 'Audio Device', key: 'Sample rate', value: '192 kHz' },
  ]);
  assert.equal(response.body.fetchedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(response.body.sourceUrl, undefined);
  assert.equal(response.body.diagnostics.version, 'audio-info.v1');
  assert.equal(response.body.diagnostics.sourceFormat.bitDepth, 24);
  assert.equal(response.body.diagnostics.sourceFile.codec, 'AAC-LC');
  assert.equal(response.body.diagnostics.sourceFile.codecStatus, 'verified');
  assert.equal(response.body.diagnostics.sourceFile.bitDepth, null);
  assert.equal(response.body.diagnostics.sourceFile.encodedBitrateBps, 270000);
  assert.equal(response.body.diagnostics.decodedAudio.pcmBitrateBps, 2116800);
  assert.equal(response.body.diagnostics.output.format, 'S32_LE');
  assert.equal(response.body.diagnostics.hardwareOutput.format, 'S32_LE');
  assert.equal(response.body.diagnostics.collection.session.status, 'available');
  assert.equal(response.body.diagnostics.collection.rendererReport.code, 'SONUVI_MOODE_SESSION_UNAVAILABLE');
  assert.equal(response.body.diagnostics.collection.alsa.code, null);
  assert.doesNotMatch(JSON.stringify(response.body), /USB\/SamsungMoode|moode\.local|PHPSESSID|stored-moode-session|stream\.example\.org|private diagnostic detail/);
});

test('mobile now-playing replaces a generic radio fallback with the resolved queue station', async () => {
  const streamFile = 'https://live.amperwave.net/manifest/audacy-wscramaac-hlsc.m3u8';
  const app = registerFixture({
    mpdQueryRaw: async (command) => {
      if (command === 'playlistinfo') {
        return `file: ${streamFile}\npos: 0\nid: 44\nOK\n`;
      }
      if (command === 'status') {
        return 'state: play\nsong: 0\nsongid: 44\nplaylistlength: 1\nOK\n';
      }
      return 'OK\n';
    },
    fetchInternalJson: async (pathname) => {
      if (pathname === '/now-playing') {
        return {
          ok: true,
          status: 200,
          json: {
            state: 'play',
            displayTitle: 'Live Radio',
            displayArtist: 'Radio',
            displayConfidence: 'fallback',
            isStream: true,
            isRadio: true,
          },
        };
      }
      assert.equal(pathname, '/config/diagnostics/queue');
      return {
        ok: true,
        status: 200,
        json: {
          items: [{
            position: 1,
            file: streamFile,
            stationName: '670 The Score',
            title: '',
            artist: '',
            album: '',
            thumbUrl: '/art/radio-logo.jpg?name=670%20The%20Score',
          }],
        },
      };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.title, 'Live Radio');
  assert.equal(response.body.stationName, '670 The Score');
  assert.equal(response.body.artist, '670 The Score');
  assert.match(response.body.artworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.equal(response.body.stationLogoUrl, response.body.artworkUrl);
  assert.doesNotMatch(JSON.stringify(response.body), /amperwave|audacy-wscr|serverSongId|songid/i);
});

test('mobile now-playing prefers canonical matched radio artwork over the queue station logo', async () => {
  const streamFile = 'https://radio.example.test/670-score.mp3';
  const matchedArtwork = 'https://images.example.test/fragile.jpg';
  const app = registerFixture({
    mpdQueryRaw: async (command) => {
      if (command === 'playlistinfo') {
        return `file: ${streamFile}\npos: 0\nid: 44\nOK\n`;
      }
      if (command === 'status') {
        return 'state: play\nsong: 0\nsongid: 44\nplaylistlength: 1\nOK\n';
      }
      return 'OK\n';
    },
    fetchInternalJson: async (pathname) => {
      if (pathname === '/now-playing') {
        return {
          ok: true,
          status: 200,
          json: {
            state: 'play',
            displayTitle: 'Fragile',
            displayArtist: 'Sting',
            displayLine3: '...Nothing Like the Sun',
            radioStationName: '670 The Score',
            displayArtUrl: matchedArtwork,
            radioTrackUrl: 'https://music.apple.com/us/song/fragile/123456',
            isStream: true,
            isRadio: true,
          },
        };
      }
      assert.equal(pathname, '/config/diagnostics/queue');
      return {
        ok: true,
        status: 200,
        json: {
          items: [{
            position: 1,
            file: streamFile,
            thumbUrl: 'https://images.example.test/670-score-logo.jpg',
          }],
        },
      };
    },
    serveHomeArtwork: async (res, descriptor) => res.json({ ok: true, descriptor }),
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.appleMusicUrl, 'https://music.apple.com/us/song/fragile/123456');
  assert.match(response.body.stationLogoUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.notEqual(response.body.stationLogoUrl, response.body.artworkUrl);
  const artworkId = response.body.artworkUrl.split('/').at(-1);
  const artworkResponse = createResponse();
  await app.routes.get('GET /v1/mobile/home/artwork/:artworkId')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    params: { artworkId },
  }), artworkResponse);
  assert.equal(artworkResponse.statusCode, 200);
  assert.equal(artworkResponse.body.descriptor.reference, matchedArtwork);
});

test('mobile now-playing preserves an aliased station when iTunes payload has no station name', async () => {
  const streamFile = 'https://knkx-live-a.edge.audiocdn.com/6285_256k';
  const app = registerFixture({
    mpdQueryRaw: async (command) => {
      if (command === 'playlistinfo') {
        return `file: ${streamFile}\npos: 0\nid: 44\nOK\n`;
      }
      if (command === 'status') {
        return 'state: play\nsong: 0\nsongid: 44\nplaylistlength: 1\nOK\n';
      }
      return 'OK\n';
    },
    fetchInternalJson: async (pathname) => {
      if (pathname === '/now-playing') {
        return {
          ok: true,
          status: 200,
          json: {
            state: 'play',
            displayTitle: 'Fiddler On the Roof (1991 Remaster)',
            displayArtist: 'Cannonball Adderley',
            displayLine3: 'Fiddler On the Roof',
            displayArtUrl: 'https://images.example.test/matched.jpg',
            radioItunesUrl: 'https://music.apple.com/us/song/fiddler-on-the-roof/123456',
            isStream: true,
            isRadio: true,
            file: streamFile,
          },
        };
      }
      assert.equal(pathname, '/config/diagnostics/queue');
      return {
        ok: true,
        status: 200,
        json: {
          items: [{ position: 1, file: streamFile }],
        },
      };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);

  const sessionToken = sessionRes.body.accessToken;
  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: 'Bearer ' + sessionToken },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.stationName, 'Jazz24');
  assert.equal(response.body.isRadio, true);
});

test('mobile now-playing exposes only safe Apple Music radio matches', async () => {
  const app = registerFixture({
    fetchInternalJson: async () => ({
      ok: true,
      status: 200,
      json: {
        state: 'play',
        displayTitle: 'Blue in Green',
        displayArtist: 'Miles Davis',
        displayLine3: 'Kind of Blue',
        radioYear: '1959',
        radioItunesUrl: 'https://music.apple.com/us/album/kind-of-blue/268443094',
        radioTrackUrl: 'https://music.apple.com/us/song/blue-in-green/268443106',
        isStream: true,
        isRadio: true,
        albumArtUrl: 'https://images.example.test/station.jpg',
      },
    }),
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${sessionToken}` },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.title, 'Blue in Green');
  assert.equal(response.body.artist, 'Miles Davis');
  assert.equal(response.body.album, 'Kind of Blue');
  assert.equal(response.body.radioYear, '1959');
  assert.equal(response.body.appleMusicUrl, 'https://music.apple.com/us/song/blue-in-green/268443106');

  const unsafeApp = registerFixture({
    fetchInternalJson: async () => ({
      ok: true,
      status: 200,
      json: {
        state: 'play',
        title: 'Talk',
        artist: 'Station',
        isStream: true,
        isRadio: true,
        radioTrackUrl: 'https://evil.example.test/redirect',
      },
    }),
  });
  const unsafeSession = createResponse();
  await unsafeApp.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'ipad-brian' },
  }), unsafeSession);
  const unsafeResponse = createResponse();
  await unsafeApp.routes.get('GET /v1/mobile/now-playing')?.(request({
    headers: { authorization: `Bearer ${unsafeSession.body.accessToken}` },
  }), unsafeResponse);
  assert.equal(unsafeResponse.body.appleMusicUrl, null);
});

test('mobile playlist detail rejects an unknown opaque ID after bearer authentication', async () => {
  const app = registerFixture();
  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);

  const res = createResponse();
  await app.routes.get('GET /v1/mobile/playlists/:playlistId')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    params: { playlistId: 'pl_not-a-real-playlist' },
  }), res);
  assert.equal(res.statusCode, 404);
});

test('mobile now-playing uses canonical metadata for controls and mutations', async () => {
  const fragileFile = 'USB/SamsungMoode/Fragile/01 - Fragile.flac';
  const calls = [];
  const app = registerFixture({
    getBrowseIndex: async () => ({
      ...fixtureIndex(),
      tracks: [
        ...fixtureIndex().tracks,
        {
          file: fragileFile,
          artist: 'Test Artist',
          albumArtist: 'Test Artist',
          album: 'Fragile',
          title: 'Fragile',
          track: '1',
          genre: 'Test',
          durationSec: 321,
          mbTrackId: 'track-fragile',
          mbAlbumId: 'album-fragile',
          mbArtistId: 'artist-one',
        },
      ],
    }),
    fetchInternalJson: async (pathname) => {
      assert.equal(pathname, '/now-playing');
      return {
        ok: true,
        json: {
          state: 'play',
          title: 'Fragile',
          artist: 'Test Artist',
          album: 'Fragile',
          file: fragileFile,
          isStream: false,
          isAirplay: false,
          isFavorite: true,
          rating: 5,
          ratingDisabled: false,
        },
      };
    },
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      if (pathname === '/rating/current') {
        return {
          ok: true,
          status: 200,
          json: { ok: true, file: 'https://radio.example.test/stale', rating: 0, disabled: true },
        };
      }
      if (pathname === '/favorites/toggle') {
        return {
          ok: true,
          status: 200,
          json: { ok: true, file: fragileFile, isFavorite: !!options.body?.favorite },
        };
      }
      if (pathname === '/rating' && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: { ok: true, file: fragileFile, rating: options.body?.rating, disabled: false },
        };
      }
      throw new Error(`unexpected internal route: ${pathname}`);
    },
  });

  for (const [method, route, body] of [
    ['get', 'GET /v1/mobile/now-playing', undefined],
    ['post', 'POST /v1/mobile/now-playing/favorite', { favorite: true }],
    ['post', 'POST /v1/mobile/now-playing/rating', { rating: 5 }],
  ]) {
    const unauthorized = createResponse();
    await app.routes.get(route)?.(request({ headers: { 'x-track-key': 'admin-track-key' }, body }), unauthorized);
    assert.equal(unauthorized.statusCode, 401);
  }

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const sessionToken = sessionRes.body.accessToken;
  const authHeaders = { authorization: `Bearer ${sessionToken}` };

  const current = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({ headers: authHeaders }), current);
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.isFavorite, true);
  assert.equal(current.body.rating, 5);
  assert.equal(current.body.ratingDisabled, false);
  assert.doesNotMatch(JSON.stringify(current.body), /SamsungMoode|Fragile\.flac/);

  const favorite = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/favorite')?.(request({
    headers: authHeaders,
    body: { favorite: true },
  }), favorite);
  assert.equal(favorite.statusCode, 200);
  assert.deepEqual(favorite.body, { ok: true, isFavorite: true, disabled: false });

  const rating = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/rating')?.(request({
    headers: authHeaders,
    body: { rating: 5 },
  }), rating);
  assert.equal(rating.statusCode, 200);
  assert.deepEqual(rating.body, { ok: true, rating: 5, ratingDisabled: false, disabled: false });
  assert.doesNotMatch(JSON.stringify(favorite.body), /SamsungMoode|Fragile\.flac/);
  assert.doesNotMatch(JSON.stringify(rating.body), /SamsungMoode|Fragile\.flac/);

  assert.deepEqual(calls.map((call) => call.pathname), [
    '/favorites/toggle',
    '/rating',
  ]);
  assert.deepEqual(calls[0].options.body, { file: fragileFile, favorite: true });
  assert.deepEqual(calls[1].options.body, { file: fragileFile, rating: 5 });
});

test('mobile now-playing controls are disabled no-ops for streams', async () => {
  let internalCalls = 0;
  const app = registerFixture({
    getCurrentFile: async () => 'https://radio.example.test/live.mp3',
    fetchInternalJson: async () => ({
      ok: true,
      json: {
        state: 'play',
        file: 'https://radio.example.test/live.mp3',
        title: 'Live Song',
        artist: 'Example Radio',
        isStream: true,
        isRadio: true,
      },
    }),
    fetchInternalRequest: async () => {
      internalCalls += 1;
      return { ok: true, json: {} };
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const authHeaders = { authorization: `Bearer ${sessionRes.body.accessToken}` };

  const current = createResponse();
  await app.routes.get('GET /v1/mobile/now-playing')?.(request({ headers: authHeaders }), current);
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.isFavorite, false);
  assert.equal(current.body.rating, 0);
  assert.equal(current.body.ratingDisabled, true);

  const favorite = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/favorite')?.(request({
    headers: authHeaders,
    body: { favorite: true },
  }), favorite);
  assert.deepEqual(favorite.body, { ok: true, isFavorite: false, disabled: true });

  const rating = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/rating')?.(request({
    headers: authHeaders,
    body: { rating: 5 },
  }), rating);
  assert.deepEqual(rating.body, { ok: true, rating: 0, ratingDisabled: true, disabled: true });
  assert.equal(internalCalls, 0);
});

test('mobile now-playing controls are disabled for an unsupported local item', async () => {
  const unsupportedFile = 'USB/SamsungMoode/Unknown Album/01 - Unknown.mp3';
  const app = registerFixture({
    getCurrentFile: async () => unsupportedFile,
    fetchInternalJson: async () => ({
      ok: true,
      json: { state: 'play', title: 'Unknown', file: unsupportedFile, isStream: false, isAirplay: false },
    }),
    fetchInternalRequest: async () => {
      throw new Error('unsupported item must not reach a mutation route');
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const res = createResponse();
  await app.routes.get('POST /v1/mobile/now-playing/favorite')?.(request({
    headers: { authorization: `Bearer ${sessionRes.body.accessToken}` },
    body: { favorite: true },
  }), res);
  assert.deepEqual(res.body, { ok: true, isFavorite: false, disabled: true });
});

test('mobile podcast playback falls back to the subscription MPD prefix', async () => {
  const calls = [];
  const rss = 'https://feeds.example.test/show.rss';
  const app = registerFixture({
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      if (pathname === '/podcasts') {
        return {
          ok: true,
          json: {
            items: [{
              title: 'Example Show',
              rss,
              dir: '/mnt/SamsungMoode/Podcasts/Example Show',
              mpdPrefix: 'USB/SamsungMoode/Podcasts/Example Show',
            }],
          },
        };
      }
      if (pathname === '/podcasts/episodes/list') {
        return {
          ok: true,
          json: {
            episodes: [{
              id: 'episode-1',
              title: 'Episode One',
              date: '2026-10-02',
              downloaded: true,
              filename: 'episode-1.mp3',
            }],
          },
        };
      }
      if (pathname === '/config/diagnostics/playback') {
        return { ok: true, json: { ok: true } };
      }
      throw new Error(`unexpected internal route: ${pathname}`);
    },
  });

  const sessionRes = createResponse();
  await app.routes.get('POST /v1/mobile/session')?.(request({
    headers: { 'x-mobile-enrollment-code': 'one-time-code' },
    body: { deviceId: 'iphone-brian' },
  }), sessionRes);
  const authHeaders = { authorization: `Bearer ${sessionRes.body.accessToken}` };

  const podcastsRes = createResponse();
  await app.routes.get('GET /v1/mobile/podcasts')?.(request({ headers: authHeaders }), podcastsRes);
  const podcastId = podcastsRes.body.items[0].id;

  const playRes = createResponse();
  await app.routes.get('POST /v1/mobile/podcasts/:podcastId/episodes/:episodeId/play')?.(request({
    headers: authHeaders,
    params: { podcastId, episodeId: 'episode-1' },
  }), playRes);

  assert.equal(playRes.statusCode, 200);
  const playbackCall = calls.find((call) => call.pathname === '/config/diagnostics/playback');
  assert.equal(playbackCall?.options?.body?.file, 'USB/SamsungMoode/Podcasts/Example Show/episode-1.mp3');
});

test('mobile radio catalog failures propagate explicitly while valid empty catalogs remain empty', async () => {
  const token=createMobileSessionToken({secret:'api-secret-for-test',deviceId:'radio-read-test'});
  const headers={authorization:`Bearer ${token}`};
  for(const failure of [{ok:false,status:503,json:{ok:false,error:'private upstream detail'}},{ok:true,json:{ok:false}},{ok:true,json:{}},null]){
    const app=registerFixture({fetchInternalRequest:async()=>{if(failure===null)throw new Error('network');return failure}});
    for(const endpoint of ['/v1/mobile/radio','/v1/mobile/radio/options']){
      const res=createResponse();await app.routes.get('GET '+endpoint)(request({headers}),res);
      assert.equal(res.statusCode,503);assert.equal(res.body.code,'RADIO_CATALOG_UNAVAILABLE');assert.equal(res.body.ok,false);assert(!('items' in res.body));assert(!JSON.stringify(res.body).includes('private'));
    }
    const denied=createResponse();await app.routes.get('GET /v1/mobile/radio')(request(),denied);assert.equal(denied.statusCode,401);
  }
  const app=registerFixture({fetchInternalRequest:async()=>({ok:true,json:{ok:true,tracks:[]}})});
  const empty=createResponse();await app.routes.get('GET /v1/mobile/radio')(request({headers}),empty);assert.equal(empty.statusCode,200);assert.deepEqual(empty.body.items,[]);
});
