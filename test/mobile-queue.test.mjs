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
    builtAt: '2026-09-26T00:00:00.000Z',
    tracks: [{
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
    }],
  };
}

function registerFixture(mpdQueryRaw, extra = {}) {
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

test('mobile queue append requires a bearer session and resolves opaque track IDs server-side', async () => {
  const commands = [];
  const app = registerFixture(async (command) => {
    commands.push(command);
    return 'Id: 77\nOK\n';
  });
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const trackId = catalog.tracks[0].id;

  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items')?.(request({
    body: { trackId, mode: 'append' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(commands, []);

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items')?.(request({
    headers: sessionHeaders(),
    body: { trackId, mode: 'append' },
  }), response);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(commands, ['addid "USB/SamsungMoode/Test Album/01 - First.mp3"']);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.trackId, trackId);
  assert.equal(response.body.mpdSongId, 77);
  assert.equal(response.body.track.title, 'First');
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3/);
});

test('Alexa mobile actions require a bearer session and reuse the server diagnostics route', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, json: { ok: true } };
    },
  });

  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/alexa/actions')?.(request({
    body: { action: 'pause' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/alexa/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'pause' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    target: 'alexa',
    action: 'pause',
    diagnosticsAction: 'pausealexa',
  });
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'pausealexa' } },
  }]);
});

test('mobile Shuffle physically reorders the queue through the server diagnostics route', async () => {
  const calls = [];
  const commands = [];
  const app = registerFixture(async (command) => {
    commands.push(command);
    if (command === 'status') {
      return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 1\nrandom: off\nrepeat: off\nOK\n';
    }
    if (command === 'playlistinfo') {
      return 'file: USB/SamsungMoode/Test Album/01 - First.mp3\nartist: Test Artist\nalbum: Test Album\ntitle: First\npos: 0\nid: 77\nOK\n';
    }
    return 'OK\n';
  }, {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, json: { ok: true, action: 'shufflequeue', randomOn: false } };
    },
  });

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'shuffle' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, 'shuffle');
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'shufflequeue' } },
  }]);
  assert.equal(commands.includes('shuffle'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|serverSongId|songid/i);
});

test('mobile physical queue shuffle delegates to the diagnostics queue reorder path', async () => {
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
      return { ok: true, status: 200, json: { ok: true, action: 'shufflequeue' } };
    },
  });

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'shufflequeue' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, 'shuffle');
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'shufflequeue' } },
  }]);
  assert.equal(commands.includes('shuffle'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|serverSongId|songid/i);
});

test('Alexa mobile Play action invokes the skill-start bridge', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, json: { ok: true } };
    },
  });

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/alexa/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'play' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    target: 'alexa',
    action: 'play',
    diagnosticsAction: 'routealexa',
  });
  assert.deepEqual(calls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'routealexa' } },
  }]);
});

test('Alexa mobile queue resolves opaque IDs, updates the server queue, and routes playback', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      if (pathname === '/config/queue-wizard/apply') {
        return { ok: true, status: 200, json: { ok: true, mode: 'replace', added: 1, playStarted: true } };
      }
      if (pathname === '/config/diagnostics/playback') {
        return { ok: true, status: 200, json: { ok: true, action: 'routealexa' } };
      }
      throw new Error(`unexpected request ${pathname}`);
    },
  });
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const trackId = catalog.tracks[0].id;

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/alexa/queue')?.(request({
    headers: sessionHeaders(),
    body: { trackIds: [trackId], mode: 'replace', play: true },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    target: 'alexa',
    mode: 'replace',
    requested: 1,
    added: 1,
    playStarted: true,
    alexaStarted: true,
  });
  assert.deepEqual(calls, [
    {
      pathname: '/config/queue-wizard/apply',
      options: {
        method: 'POST',
        body: {
          mode: 'replace',
          keepNowPlaying: false,
          tracks: ['USB/SamsungMoode/Test Album/01 - First.mp3'],
          shuffle: false,
          forceRandomOff: false,
          fastStart: true,
          play: true,
        },
      },
    },
    {
      pathname: '/config/diagnostics/playback',
      options: { method: 'POST', body: { action: 'routealexa' } },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|Track Key/i);
});

test('mobile queue append rejects unsupported modes and unknown opaque IDs', async () => {
  const app = registerFixture(async () => 'Id: 77\nOK\n');
  const headers = sessionHeaders();

  const modeResponse = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items')?.(request({
    headers,
    body: { trackId: 'trk_valid-looking', mode: 'replace' },
  }), modeResponse);
  assert.equal(modeResponse.statusCode, 400);

  const unknownResponse = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items')?.(request({
    headers,
    body: { trackId: 'trk_not-in-catalog', mode: 'append' },
  }), unknownResponse);
  assert.equal(unknownResponse.statusCode, 404);
});

test('mobile playlist writes require a bearer session and resolve opaque track IDs server-side', async () => {
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: { ok: true, playlistName: 'Favorites', added: 1 },
      };
    },
  });
  const catalog = buildMobileCatalog(fixtureIndex(), { trackIdSecret: 'track-secret-for-test' });
  const trackId = catalog.tracks[0].id;

  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/queue-wizard/add-to-playlist')?.(request({
    body: { trackIds: [trackId], playlistName: 'Favorites' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(calls, []);

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue-wizard/add-to-playlist')?.(request({
    headers: sessionHeaders(),
    body: { trackIds: [trackId], playlistName: 'Favorites' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, playlistName: 'Favorites', added: 1 });
  assert.deepEqual(calls, [{
    pathname: '/config/queue-wizard/add-to-playlist',
    options: {
      method: 'POST',
      body: {
        playlistName: 'Favorites',
        tracks: ['USB/SamsungMoode/Test Album/01 - First.mp3'],
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3/);
});

test('mobile queue includes canonical per-item ratings without exposing MPD identity', async () => {
  const fragileFile = 'USB/SamsungMoode/Fragile/01 - Fragile.flac';
  const unratedFile = 'USB/SamsungMoode/Test Album/01 - First.mp3';
  const podcastFile = 'USB/SamsungMoode/Podcasts/Example/episode.mp3';
  const unknownFile = 'USB/SamsungMoode/Unknown/99 - Missing.mp3';
  const streamFile = 'https://radio.example.test/live.mp3';
  const youtubeFile = 'https://www.youtube.com/watch?v=example';
  const ratingCalls = [];
  const favoriteCalls = [];
  const queueRows = [
    { file: fragileFile, artist: 'Sting', album: '...All This Time', title: 'Fragile', pos: '0', id: '77' },
    { file: unratedFile, artist: 'Test Artist', album: 'Test Album', title: 'First', pos: '1', id: '78' },
    { file: podcastFile, artist: 'Podcast', album: 'Example', title: 'Episode', name: 'Podcast Episode', pos: '2', id: '79' },
    { file: streamFile, artist: 'Example Radio', title: 'Live Song', name: 'Example Radio', pos: '3', id: '80' },
    { file: youtubeFile, artist: 'Example Channel', title: 'Video', name: 'YouTube', pos: '4', id: '81' },
    { file: unknownFile, artist: 'Unknown', album: 'Unknown', title: 'Missing', pos: '5', id: '82' },
  ];
  const mpdQueryRaw = async (command) => {
    if (command === 'playlistinfo') {
      return `OK MPD 0.23.15\n${queueRows
        .map((row) => Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('\n'))
        .join('\n')}\nOK\n`;
    }
    if (command === 'status') {
      return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 6\nrandom: 0\nrepeat: 0\nconsume: 0\ncrossfade: 0\nOK\n';
    }
    return 'OK\n';
  };
  const app = registerFixture(mpdQueryRaw, {
    getBrowseIndex: async () => ({
      ...fixtureIndex(),
      tracks: [
        ...fixtureIndex().tracks,
        {
          file: fragileFile,
          artist: 'Sting',
          albumArtist: 'Sting',
          album: '...All This Time',
          title: 'Fragile',
          track: '1',
          genre: 'Rock',
          durationSec: 240,
          mbTrackId: 'track-fragile',
          mbAlbumId: 'album-all-this-time',
          mbArtistId: 'artist-sting',
        },
        {
          file: podcastFile,
          artist: 'Podcast',
          albumArtist: 'Podcast',
          album: 'Example',
          title: 'Episode',
          track: '1',
          genre: 'Podcast',
          durationSec: 120,
          mbTrackId: 'track-podcast',
          mbAlbumId: 'album-podcast',
          mbArtistId: 'artist-podcast',
        },
      ],
    }),
    ratingsEnabled: async () => true,
    getRatingForFile: async (file) => {
      ratingCalls.push(file);
      return file === fragileFile ? 5 : 0;
    },
    getFavoriteForFile: async (file) => {
      favoriteCalls.push(file);
      return file === fragileFile;
    },
  });

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), response);

  assert.equal(response.statusCode, 200);
  const items = response.body.queue.items;
  assert.equal(items.length, queueRows.length);
  assert.equal(items[0].rating, 5);
  assert.equal(items[0].ratingDisabled, false);
  assert.equal(items[0].isFavorite, true);
  assert.equal(items[0].favoriteDisabled, false);
  assert.equal(items[1].rating, 0);
  assert.equal(items[1].ratingDisabled, false);
  assert.equal(items[1].isFavorite, false);
  assert.equal(items[1].favoriteDisabled, false);
  for (const item of items.slice(2)) {
    assert.equal(item.rating, 0);
    assert.equal(item.ratingDisabled, true);
    assert.equal(item.isFavorite, false);
    assert.equal(item.favoriteDisabled, true);
  }
  assert.equal(items[2].isPodcast, true);
  assert.equal(items[4].isYoutube, true);
  assert.deepEqual(ratingCalls, [fragileFile, unratedFile]);
  assert.deepEqual(favoriteCalls, [fragileFile, unratedFile]);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|Fragile\.flac|serverSongId|songid/i);
});

test('mobile queue pages ordered windows and exposes a stable opaque revision', async () => {
  const file = fixtureIndex().tracks[0].file;
  const queueRows = Array.from({ length: 5 }, (_, index) => ({
    file,
    pos: String(index),
    id: String(100 + index),
  }));
  const commands = [];
  const app = registerFixture(async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') {
      return `OK MPD 0.23.15\n${queueRows
        .map((row) => Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('\n'))
        .join('\n')}\nOK\n`;
    }
    if (command === 'status') {
      return 'state: play\nsong: 2\nsongid: 102\nplaylistlength: 5\nrandom: 0\nrepeat: 0\nconsume: 0\ncrossfade: 0\nOK\n';
    }
    return 'OK\n';
  });

  const unauthorized = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    query: { offset: 1, limit: 2 },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(commands, []);

  const invalid = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    headers: sessionHeaders(),
    query: { offset: 0, limit: 101 },
  }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'MOBILE_QUEUE_PAGING_INVALID_REQUEST');
  assert.deepEqual(commands, []);

  const invalidOffset = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    headers: sessionHeaders(),
    query: { offset: -1, limit: 2 },
  }), invalidOffset);
  assert.equal(invalidOffset.statusCode, 400);
  assert.equal(invalidOffset.body.code, 'MOBILE_QUEUE_PAGING_INVALID_REQUEST');
  assert.deepEqual(commands, []);

  const firstPage = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    headers: sessionHeaders(),
    query: { offset: 1, limit: 2 },
  }), firstPage);
  assert.equal(firstPage.statusCode, 200);
  assert.deepEqual(firstPage.body.queue.items.map((item) => item.position), [2, 3]);
  assert.equal(firstPage.body.queue.count, 2);
  assert.equal(firstPage.body.queue.total, 5);
  assert.equal(firstPage.body.queue.offset, 1);
  assert.equal(firstPage.body.queue.limit, 2);
  assert.equal(firstPage.body.queue.headPos, 3);
  assert.equal(firstPage.body.queue.currentPosition, 3);
  assert.equal(firstPage.body.queue.items[1].isCurrent, true);
  assert.equal(firstPage.body.queue.hasMoreBefore, true);
  assert.equal(firstPage.body.queue.hasMoreAfter, true);
  assert.match(firstPage.body.queue.revision, /^qrev_[A-Za-z0-9_-]+$/);
  assert.equal(firstPage.body.queue.fingerprint, firstPage.body.queue.revision);
  assert.doesNotMatch(JSON.stringify(firstPage.body), /SamsungMoode|First\.mp3|serverSongId|songid/i);

  const full = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    headers: sessionHeaders(),
  }), full);
  assert.equal(full.statusCode, 200);
  assert.deepEqual(full.body.queue.items.map((item) => item.position), [3, 4, 5, 1, 2]);
  assert.equal(full.body.queue.count, 5);
  assert.equal(full.body.queue.total, 5);
  assert.equal(full.body.queue.hasMoreBefore, false);
  assert.equal(full.body.queue.hasMoreAfter, false);
  assert.equal(full.body.queue.revision, firstPage.body.queue.revision);

  queueRows.push({ file, pos: '5', id: '105' });
  const changed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({
    headers: sessionHeaders(),
    query: { offset: 0, limit: 2 },
  }), changed);
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body.queue.total, 6);
  assert.notEqual(changed.body.queue.revision, firstPage.body.queue.revision);
  assert.deepEqual(commands, [
    'playlistinfo', 'status',
    'playlistinfo', 'status',
    'playlistinfo', 'status',
  ]);
});

test('mobile queue disables ratings when the ratings feature is disabled', async () => {
  const ratingCalls = [];
  const app = registerFixture(async (command) => {
    if (command === 'playlistinfo') {
      return 'file: USB/SamsungMoode/Test Album/01 - First.mp3\ntitle: First\npos: 0\nid: 77\nOK\n';
    }
    if (command === 'status') return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 1\nOK\n';
    return 'OK\n';
  }, {
    ratingsEnabled: async () => false,
    getRatingForFile: async (file) => {
      ratingCalls.push(file);
      return 5;
    },
  });

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.queue.items[0].rating, 0);
  assert.equal(response.body.queue.items[0].ratingDisabled, true);
  assert.deepEqual(ratingCalls, []);
});

test('mobile queue fills silent radio rows from the web diagnostics metadata', async () => {
  const streamFile = 'https://live.amperwave.net/manifest/audacy-wscramaac-hlsc.m3u8';
  const app = registerFixture(async (command) => {
    if (command === 'playlistinfo') {
      return `file: ${streamFile}\nname: Radio\npos: 0\nid: 44\nOK\n`;
    }
    if (command === 'status') {
      return 'state: play\nsong: 0\nsongid: 44\nplaylistlength: 1\nOK\n';
    }
    return 'OK\n';
  }, {
    fetchInternalJson: async (pathname) => {
      assert.equal(pathname, '/config/diagnostics/queue');
      return {
        ok: true,
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

  const response = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), response);

  assert.equal(response.statusCode, 200);
  const item = response.body.queue.items[0];
  assert.equal(item.title, '670 The Score');
  assert.equal(item.artist, '');
  assert.equal(item.album, '');
  assert.equal(item.stationName, '670 The Score');
  assert.equal(item.isStream, true);
  assert.match(item.artworkUrl, /\/v1\/mobile\/home\/artwork\/har_/);
  assert.doesNotMatch(JSON.stringify(response.body), /amperwave|audacy-wscr|serverSongId|songid/i);
});

test('mobile Live Queue is bearer-authorized and mutates by opaque queue ID', async () => {
  const commands = [];
  let queueRows = [
    {
      file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
      artist: 'Test Artist',
      album: 'Test Album',
      title: 'First',
      pos: '0',
      id: '77',
    },
    {
      file: 'USB/SamsungMoode/Test Album/01 - First.mp3',
      artist: 'Test Artist',
      album: 'Test Album',
      title: 'First',
      pos: '1',
      id: '78',
    },
  ];
  const mpdQueryRaw = async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') {
      return `OK MPD 0.23.15\n${queueRows.map((row) => Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('\n')).join('\n')}\nOK\n`;
    }
    if (command === 'status') {
      return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 2\nrandom: 0\nrepeat: 0\nconsume: 0\ncrossfade: 0\nOK\n';
    }
    if (command === 'moveid 77 1') {
      queueRows.reverse().forEach((row, index) => { row.pos = String(index); });
      return 'OK\n';
    }
    if (command === 'deleteid 78') {
      queueRows = queueRows.filter((row) => row.id !== '78');
      return 'OK\n';
    }
    return 'OK\n';
  };
  const app = registerFixture(mpdQueryRaw);

  const unauthorized = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request(), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(commands, []);

  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.queue.count, 2);
  assert.match(listed.body.queue.items[0].id, /^que_[A-Za-z0-9_-]+$/);
  assert.match(listed.body.queue.items[0].artworkUrl, /\/v1\/mobile\/artwork\/trk_/);
  assert.doesNotMatch(JSON.stringify(listed.body), /SamsungMoode|First\.mp3/);

  const moved = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/move')?.(request({
    headers: sessionHeaders(),
    params: { queueItemId: listed.body.queue.items[0].id },
    body: { toPosition: 2 },
  }), moved);
  assert.equal(moved.statusCode, 200);
  assert.equal(commands.at(-3), 'moveid 77 1');

  const secondID = moved.body.queue.items.find((item) => item.position === 1).id;
  const removed = createResponse();
  await app.routes.get('DELETE /v1/mobile/queue/items/:queueItemId')?.(request({
    headers: sessionHeaders(),
    params: { queueItemId: secondID },
  }), removed);
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.queue.count, 1);
  assert.equal(commands.at(-3), 'deleteid 78');
});

test('mobile delete-below keeps the selected current item and emits the exact MPD range delete', async () => {
  const commands = [];
  let rows = ['seed', ...Array.from({ length: 17 }, (_, index) => `new-${index + 1}`), ...Array.from({ length: 8 }, (_, index) => `old-tail-${index + 1}`)].map((title, position) => ({
    file: `USB/Test/${position}.mp3`, artist: 'Test Artist', album: 'Test Album',
    title, pos: String(position), id: String(100 + position),
  }));
  const mpdQueryRaw = async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') return `${rows.map((row) => Object.entries(row)
      .map(([key, value]) => `${key}: ${value}`).join('\n')).join('\n')}\nOK\n`;
    if (command === 'status') return `state: play\nsong: 0\nsongid: 100\nplaylistlength: ${rows.length}\nOK\n`;
    const rangeDelete = command.match(/^delete (\d+):$/);
    if (rangeDelete) { rows = rows.slice(0, Number(rangeDelete[1])); return 'OK\n'; }
    const singleDelete = command.match(/^delete (\d+)$/);
    if (singleDelete) { rows.splice(Number(singleDelete[1]), 1); return 'OK\n'; }
    return 'OK\n';
  };
  const app = registerFixture(mpdQueryRaw);
  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  const selected = listed.body.queue.items.find((item) => item.isCurrent === true);
  assert.ok(selected);
  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: selected.id },
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.action, 'delete-below');
  assert.deepEqual(commands.filter((command) => command.startsWith('delete ')), ['delete 1:']);
  assert.deepEqual(rows.map((row) => row.id), ['100']);
  assert.equal(response.body.queue.items.some((item) => item.isCurrent === true), true);

  const last = response.body.queue.items.find((item) => item.position === 1);
  const noOp = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: last.id },
  }), noOp);
  assert.equal(noOp.statusCode, 200);
  assert.deepEqual(commands.filter((command) => command.startsWith('delete ')), ['delete 1:']);
});

test('mobile delete-below rejects unauthorized, stale, current-removing, Alexa, and empty-queue requests', async () => {
  const commands = [];
  let rows = [0, 1, 2].map((position) => ({
    file: `USB/Test/${position}.mp3`, artist: 'Test Artist', album: 'Test Album',
    title: `Track ${position}`, pos: String(position), id: String(200 + position),
  }));
  let currentSongId = '200';
  const mpdQueryRaw = async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') return `${rows.map((row) => Object.entries(row)
      .map(([key, value]) => `${key}: ${value}`).join('\n')).join('\n')}\nOK\n`;
    if (command === 'status') return `state: play\nsong: ${rows.findIndex((row) => row.id === currentSongId)}\nsongid: ${currentSongId}\nOK\n`;
    return 'OK\n';
  };
  const app = registerFixture(mpdQueryRaw);
  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  const selected = listed.body.queue.items.find((item) => item.position === 1);

  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({ params: { queueItemId: selected.id } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  rows.reverse().forEach((row, index) => { row.pos = String(index); });
  const stale = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: selected.id },
  }), stale);
  assert.equal(stale.statusCode, 404);

  const fresh = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), fresh);
  const beforeCurrent = fresh.body.queue.items.find((item) => item.position === 1);
  currentSongId = '201';
  const conflict = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: beforeCurrent.id },
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  const alexa = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: beforeCurrent.id }, body: { target: 'alexa' },
  }), alexa);
  assert.equal(alexa.statusCode, 409);
  assert.equal(commands.some((command) => command.startsWith('delete ')), false);

  rows = [];
  const empty = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-below')?.(request({
    headers: sessionHeaders(), params: { queueItemId: 'que_unknown' },
  }), empty);
  assert.equal(empty.statusCode, 404);
});

test('mobile delete-above removes stable preceding MPD IDs without removing the current item', async () => {
  const commands = [];
  let rows = [0, 1, 2, 3].map((position) => ({
    file: `USB/Test/${position}.mp3`, artist: 'Test Artist', album: 'Test Album',
    title: `Track ${position}`, pos: String(position), id: String(300 + position),
  }));
  const mpdQueryRaw = async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') return `${rows.map((row) => Object.entries(row)
      .map(([key, value]) => `${key}: ${value}`).join('\n')).join('\n')}\nOK\n`;
    if (command === 'status') return `state: play\nsong: 2\nsongid: 302\nplaylistlength: ${rows.length}\nOK\n`;
    if (command.startsWith('deleteid ')) {
      const id = command.slice('deleteid '.length);
      rows = rows.filter((row) => row.id !== id);
      rows.forEach((row, index) => { row.pos = String(index); });
    }
    return 'OK\n';
  };
  const app = registerFixture(mpdQueryRaw);
  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  const selected = listed.body.queue.items.find((item) => item.position === 3);
  assert.ok(selected);

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/delete-above')?.(request({
    headers: sessionHeaders(), params: { queueItemId: selected.id },
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.action, 'delete-above');
  assert.deepEqual(commands.filter((command) => command.startsWith('deleteid ')), ['deleteid 300', 'deleteid 301']);
  assert.deepEqual(rows.map((row) => row.id), ['302', '303']);
  assert.equal(response.body.queue.items[0].isCurrent, true);
});

test('mobile Crop reuses the reliable web crop path instead of raw MPD crop', async () => {
  const commands = [];
  const internalCalls = [];
  const app = registerFixture(async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') {
      return 'file: USB/SamsungMoode/Test Album/01 - First.mp3\nartist: Test Artist\ntitle: First\npos: 0\nid: 77\nOK\n';
    }
    if (command === 'status') return 'state: stop\nplaylistlength: 1\nOK\n';
    if (command === 'crop') throw new Error('raw MPD crop should not be called');
    return 'OK\n';
  }, {
    fetchInternalRequest: async (pathname, options = {}) => {
      internalCalls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        json: { ok: true, action: 'crop', cropFallback: 'queue-head' },
      };
    },
  });

  const response = createResponse();
  await app.routes.get('POST /v1/mobile/queue/actions')?.(request({
    headers: sessionHeaders(),
    body: { action: 'crop' },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.action, 'crop');
  assert.deepEqual(internalCalls, [{
    pathname: '/config/diagnostics/playback',
    options: { method: 'POST', body: { action: 'crop' } },
  }]);
  assert.equal(commands.includes('crop'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /SamsungMoode|First\.mp3|serverSongId|songid/i);
});

test('mobile per-row Vibe resolves an opaque queue ID and reuses the seeded Vibe route', async () => {
  const localFile = 'USB/SamsungMoode/Test Album/01 - First.mp3';
  const calls = [];
  const app = registerFixture(async (command) => {
    if (command === 'playlistinfo') {
      return `OK MPD 0.23.15\nfile: ${localFile}\nartist: Test Artist\ntitle: First\npos: 0\nid: 77\nOK\n`;
    }
    if (command === 'status') return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 1\nOK\n';
    return 'OK\n';
  }, {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 202,
        json: { ok: true, accepted: true, jobId: 'vibe-test-job' },
      };
    },
  });

  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  const queueItemId = listed.body.queue.items[0].id;

  const started = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/vibe')?.(request({
    headers: sessionHeaders(),
    params: { queueItemId },
    body: { targetQueue: 25, playNow: true },
  }), started);

  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.body, {
    ok: true,
    accepted: true,
    jobId: 'vibe-test-job',
    queueCount: 1,
    targetQueue: 25,
  });
  assert.deepEqual(calls, [{
    pathname: '/config/queue-wizard/vibe-seed-start',
    options: {
      method: 'POST',
      body: {
        targetQueue: 25,
        playNow: true,
        seedArtist: 'Test Artist',
        seedTitle: 'First',
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(started.body), /SamsungMoode|First\.mp3|serverSongId|Track Key/i);

  const unknown = createResponse();
  await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/vibe')?.(request({
    headers: sessionHeaders(),
    params: { queueItemId: 'que_not-in-this-snapshot' },
    body: { targetQueue: 25, playNow: true },
  }), unknown);
  assert.equal(unknown.statusCode, 404);
});

test('mobile per-row Vibe rejects streams, YouTube, podcasts, and unsupported rows', async () => {
  const rows = [
    { file: 'USB/SamsungMoode/Test Album/01 - First.mp3', artist: 'Test Artist', title: 'First', pos: '0', id: '77' },
    { file: 'https://radio.example.test/live.mp3', artist: 'Example Radio', title: 'Live Song', pos: '1', id: '78' },
    { file: 'https://www.youtube.com/watch?v=example', artist: 'Example Channel', title: 'Video', pos: '2', id: '79' },
    { file: 'USB/SamsungMoode/Podcasts/Example/episode.mp3', artist: 'Podcast', title: 'Episode', pos: '3', id: '80' },
    { file: 'USB/SamsungMoode/Unknown/99 - Missing.mp3', artist: 'Unknown', title: 'Missing', pos: '4', id: '81' },
  ];
  const calls = [];
  const app = registerFixture(async (command) => {
    if (command === 'playlistinfo') {
      return `OK MPD 0.23.15\n${rows
        .map((row) => Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('\n'))
        .join('\n')}\nOK\n`;
    }
    if (command === 'status') return 'state: play\nsong: 0\nsongid: 77\nplaylistlength: 5\nOK\n';
    return 'OK\n';
  }, {
    fetchInternalRequest: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return { ok: true, status: 202, json: { ok: true, jobId: 'unexpected-job' } };
    },
  });

  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/queue')?.(request({ headers: sessionHeaders() }), listed);
  const items = listed.body.queue.items;
  assert.equal(items.length, rows.length);

  for (const item of items.slice(1)) {
    const response = createResponse();
    await app.routes.get('POST /v1/mobile/queue/items/:queueItemId/vibe')?.(request({
      headers: sessionHeaders(),
      params: { queueItemId: item.id },
      body: { targetQueue: 25, playNow: true },
    }), response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { ok: false, error: 'queue item is not eligible for Vibe' });
  }
  assert.deepEqual(calls, []);
});

test('mobile Vibe job status is bearer-authorized and returns sanitized progress', async () => {
  let payload = {
    ok: true,
    jobId: 'vibe-test-job',
    status: 'running',
    done: false,
    phase: 'adding tracks',
    targetQueue: 25,
    builtCount: 4,
    seedArtist: 'Private Artist',
    seedTitle: 'Private Seed',
    added: [{ artist: 'Latest Artist', title: 'Latest Title', file: '/private/library/song.flac' }],
    logs: ['/private/library/song.flac'],
    debug: { indexPath: '/private/index.json' },
    tracks: [{ file: '/private/library/song.flac' }],
  };
  const calls = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalRequest: async (pathname) => {
      calls.push(pathname);
      return { ok: true, status: 200, json: payload };
    },
  });

  const unauthorized = createResponse();
  await app.routes.get('GET /v1/mobile/vibe/jobs/:jobId')?.(request({
    params: { jobId: 'vibe-test-job' },
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const running = createResponse();
  await app.routes.get('GET /v1/mobile/vibe/jobs/:jobId')?.(request({
    headers: sessionHeaders(),
    params: { jobId: 'vibe-test-job' },
  }), running);
  assert.equal(running.statusCode, 200);
  assert.deepEqual(running.body, {
    ok: true,
    jobId: 'vibe-test-job',
    status: 'running',
    done: false,
    phase: 'adding tracks',
    targetQueue: 25,
    builtCount: 4,
    latest: { artist: 'Latest Artist', title: 'Latest Title' },
  });
  assert.doesNotMatch(JSON.stringify(running.body), /Private Artist|Private Seed|private\/library|index\.json|"logs"|"debug"|"tracks":/i);

  payload = {
    ...payload,
    status: 'done',
    done: true,
    phase: 'complete',
  };
  const done = createResponse();
  await app.routes.get('GET /v1/mobile/vibe/jobs/:jobId')?.(request({
    headers: sessionHeaders(),
    params: { jobId: 'vibe-test-job' },
  }), done);
  assert.equal(done.body.done, true);
  assert.equal(done.body.status, 'done');
  assert.deepEqual(calls, [
    '/config/queue-wizard/vibe-status/vibe-test-job',
    '/config/queue-wizard/vibe-status/vibe-test-job',
  ]);
});

test('mobile Endless Vibe uses the shared server setting and returns only safe job status', async () => {
  let enabled = false;
  const writes = [];
  const app = registerFixture(async () => 'OK\n', {
    fetchInternalJson: async (pathname) => {
      if (pathname === '/config/endless-vibe') return { ok: true, json: { enabled } };
      if (pathname === '/config/queue-wizard/endless-vibe-status') {
        return {
          ok: true,
          json: enabled
            ? {
              ok: true,
              active: true,
              jobId: 'vibe-endless-test',
              status: 'running',
              phase: 'adding tracks',
              targetQueue: 25,
              builtCount: 4,
              updatedAt: 123456789,
              seedArtist: 'Private Artist',
              lastLine: '/private/path/should-not-leak.flac',
            }
            : { ok: true, active: false, done: false },
        };
      }
      throw new Error(`unexpected GET ${pathname}`);
    },
    fetchInternalRequest: async (pathname, options = {}) => {
      if (!options.method || options.method === 'GET') {
        if (pathname === '/config/endless-vibe') return { ok: true, json: { enabled } };
        if (pathname === '/config/queue-wizard/endless-vibe-status') {
          return {
            ok: true,
            json: enabled
              ? {
                ok: true,
                active: true,
                jobId: 'vibe-endless-test',
                status: 'running',
                phase: 'adding tracks',
                targetQueue: 25,
                builtCount: 4,
                updatedAt: 123456789,
                seedArtist: 'Private Artist',
                lastLine: '/private/path/should-not-leak.flac',
              }
              : { ok: true, active: false, done: false },
          };
        }
      }
      writes.push({ pathname, options });
      if (pathname === '/config/endless-vibe' && options.method === 'POST') {
        enabled = options.body.enabled;
        return { ok: true, status: 200, json: { ok: true, enabled, configured: true } };
      }
      throw new Error(`unexpected request ${pathname}`);
    },
  });
  const headers = sessionHeaders();

  const unauthorized = createResponse();
  await app.routes.get('GET /v1/mobile/endless-vibe')?.(request(), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const initial = createResponse();
  await app.routes.get('GET /v1/mobile/endless-vibe')?.(request({ headers }), initial);
  assert.deepEqual(initial.body, { ok: true, enabled: false, active: false });

  const invalid = createResponse();
  await app.routes.get('POST /v1/mobile/endless-vibe')?.(request({
    headers,
    body: { enabled: 'true' },
  }), invalid);
  assert.equal(invalid.statusCode, 400);

  const saved = createResponse();
  await app.routes.get('POST /v1/mobile/endless-vibe')?.(request({
    headers,
    body: { enabled: true },
  }), saved);
  assert.deepEqual(saved.body, {
    ok: true,
    enabled: true,
    active: true,
    job: {
      jobId: 'vibe-endless-test',
      active: true,
      status: 'running',
      phase: 'adding tracks',
      targetQueue: 25,
      builtCount: 4,
      updatedAt: 123456789,
    },
  });
  assert.deepEqual(writes, [{
    pathname: '/config/endless-vibe',
    options: { method: 'POST', body: { enabled: true } },
  }]);
  assert.doesNotMatch(JSON.stringify(saved.body), /Private Artist|should-not-leak|\.flac|file|Track Key/i);
});
