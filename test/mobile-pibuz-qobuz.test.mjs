import assert from 'node:assert/strict';
import test from 'node:test';

import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
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
    type(value) { this.headers['content-type'] = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

const snapshot = {
  available: true,
  active: true,
  source: 'qobuz-connect',
  owner: 'pibuz',
  output: 'moode',
  sessionActive: true,
  receiverActive: true,
  connectionState: 'connected',
  state: 'play',
  timingStable: true,
  elapsedSec: 12,
  durationSec: 298,
  qobuzTrackId: '37937812',
  qobuzAlbumId: '0603497870547',
  qobuzArtistId: '118769',
  title: '25 or 6 to 4',
  artist: 'Chicago',
  album: 'Chicago II',
  artworkRef: 'qobuz-0123456789abcdef01234567',
  sampleRateHz: 96000,
  bitDepth: 24,
  version: 'Steven Wilson Remix',
  outputSampleRateHz: 96000,
  bitPerfectMode: true,
  queue: {
    available: true,
    currentIndex: 2,
    totalTracks: 30,
    repeat: 'off',
    shuffle: false,
    stopAfterTrackId: null,
    currentTrack: {
      qobuzTrackId: '37937812',
      title: '25 or 6 to 4',
      artist: 'Chicago',
      album: 'Chicago II',
      artworkRef: 'qobuz-0123456789abcdef01234567',
      durationSec: 298,
      sampleRateHz: 96000,
      bitDepth: 24,
    },
    history: [],
    upcoming: [],
  },
};

function registerFixture(overrides = {}, extra = {}) {
  const app = createApp();
  registerMobileRoutes(app, {
    enabled: true,
    apiSecret: 'mobile-secret',
    trackIdSecret: 'track-secret',
    getPibuzQobuzSnapshot: async () => ({ ...snapshot, ...overrides }),
    fetchPibuzQobuzArtwork: async () => ({ body: Buffer.from('jpeg'), contentType: 'image/jpeg' }),
    ...extra,
  });
  return app;
}

function request(token, params = {}) {
  return {
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body: {},
    params,
    protocol: 'https',
    get(name) { return name.toLowerCase() === 'host' ? 'sonuvi.example' : ''; },
  };
}

function token() {
  return createMobileSessionToken({
    secret: 'mobile-secret',
    deviceId: 'iphone-brian',
  });
}

test('authenticated PiBuZ Qobuz mobile snapshot exposes source ownership and mediated artwork only', async () => {
  const app = registerFixture();
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 'qobuz-connect.v1');
  assert.equal(res.body.active, true);
  assert.equal(res.body.ownershipState, 'confirmed-active');
  assert.equal(res.body.timingStable, true);
  assert.equal(res.body.owner, 'pibuz');
  assert.equal(res.body.currentTrack.qobuzTrackId, '37937812');
  assert.equal(res.body.currentTrack.artworkUrl, 'https://sonuvi.example/v1/mobile/qobuz-connect/artwork/qobuz-0123456789abcdef01234567');
  assert.equal(JSON.stringify(res.body).includes('static.qobuz.com'), false);
});

test('authenticated PiBuZ Qobuz queue preserves explicit availability and read-only capabilities', async () => {
  const app = registerFixture();
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect/queue')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.queue.availability, 'available');
  assert.equal(res.body.queue.currentIndex, 2);
  assert.equal(res.body.queue.totalTracks, 30);
  assert.equal(res.body.queue.currentTrack.artworkAvailable, true);
  assert.equal(res.body.queue.currentTrack.artworkUrl.includes('/v1/mobile/'), true);
});

test('inactive PiBuZ Qobuz session is not represented as an empty active queue', async () => {
  const app = registerFixture({ active: false, receiverActive: false, reason: 'inactive', queue: null });
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect/queue')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.ownershipState, 'confirmed-inactive');
  assert.equal(res.body.queue.availability, 'inactive');
});

test('unreachable PiBuZ is distinguished from an explicitly inactive receiver', async () => {
  const app = registerFixture({ available: false, active: false, reason: 'unavailable', queue: null });
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect/queue')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.ownershipState, 'unknown');
  assert.equal(res.body.queue.availability, 'unavailable');
  assert.equal(res.body.queue.reason, 'unavailable');
});

test('PiBuZ Qobuz routes require the existing mobile bearer session', async () => {
  const app = registerFixture();
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect')?.({ headers: {}, params: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('PiBuZ Qobuz artwork route returns bounded mediated bytes', async () => {
  const app = registerFixture();
  const res = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect/artwork/:artworkRef')?.(
    request(token(), { artworkRef: snapshot.artworkRef }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.body, Buffer.from('jpeg'));
});

test('saved Qobuz queue routes retain their bearer contract and public response shape', async () => {
  const savedQueue = {
    schemaVersion: 1,
    kind: 'sonuvi.named-qobuz-queue',
    savedQueueId: 'sq_fixture',
    title: 'Fixture Queue',
    provider: 'qobuz',
    sourceSnapshotId: 'fixture-snapshot',
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    snapshot: { schemaVersion: 1, snapshotId: 'fixture-snapshot' },
  };
  const calls = [];
  const savedQobuzQueueService = {
    capture: async (input) => { calls.push(['capture', input]); return savedQueue; },
    list: async () => { calls.push(['list']); return [savedQueue]; },
    load: async (savedQueueId) => { calls.push(['load', savedQueueId]); return savedQueue; },
    rename: async (input) => { calls.push(['rename', input]); return { ...savedQueue, title: input.title }; },
    delete: async (input) => { calls.push(['delete', input]); return { savedQueueId: input.savedQueueId, deleted: true }; },
  };
  const app = registerFixture({}, { savedQobuzQueueService });

  const unauthorized = createResponse();
  await app.routes.get('POST /v1/mobile/qobuz-connect/saved-queues')?.({ headers: {}, body: { title: 'Fixture Queue' } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const created = createResponse();
  const createRequest = request(token());
  createRequest.body = { title: 'Fixture Queue' };
  await app.routes.get('POST /v1/mobile/qobuz-connect/saved-queues')?.(createRequest, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.savedQueue.savedQueueId, 'sq_fixture');
  assert.equal(created.body.savedQueue.capabilities.capture, true);
  assert.equal(created.body.savedQueue.restoration.available, true);
  assert.deepEqual(calls[0], ['capture', { title: 'Fixture Queue' }]);

  const listed = createResponse();
  await app.routes.get('GET /v1/mobile/qobuz-connect/saved-queues')?.(request(token()), listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.savedQueues[0].savedQueueId, 'sq_fixture');
  assert.equal(listed.body.capabilities.rename, true);

  const renamed = createResponse();
  const renameRequest = request(token(), { savedQueueId: 'sq_fixture' });
  renameRequest.body = { title: 'Renamed Fixture Queue' };
  await app.routes.get('PATCH /v1/mobile/qobuz-connect/saved-queues/:savedQueueId')?.(renameRequest, renamed);
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.savedQueue.title, 'Renamed Fixture Queue');

  const deleted = createResponse();
  await app.routes.get('DELETE /v1/mobile/qobuz-connect/saved-queues/:savedQueueId')?.(request(token(), { savedQueueId: 'sq_fixture' }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.body, {
    ok: true,
    savedQueueId: 'sq_fixture',
    deleted: true,
    capabilities: {
      capture: true,
      list: true,
      open: true,
      rename: true,
      delete: true,
      restore: true,
      play: true,
    },
    restoration: {
      available: true,
      reason: 'requires an active Qobuz Connect session on the PiBuZ receiver',
    },
  });
});

test('Qobuz control route is wired and forwards the guarded current-track evidence', async () => {
  let call = null;
  const app = registerFixture({}, {
    controlPibuzQobuz: async (action, options) => {
      call = { action, options };
      return {
        ok: true,
        status: 200,
        action,
        accepted: true,
        confirmed: true,
        verification: 'confirmed',
        snapshot: {
          ...snapshot,
          capabilities: {
            readOnly: false,
            play: true,
            pause: true,
            seek: true,
            next: true,
            previous: true,
            queueEdit: false,
            repeat: false,
            shuffle: false,
            control: true,
            verification: 'read-after-write',
          },
          queue: {
            ...snapshot.queue,
            queueFingerprint: 'qobuz-queue-0123456789abcdef0123456789abcdef',
          },
        },
      };
    },
  });
  const res = createResponse();
  const req = request(token());
  req.body = { qobuzTrackId: '37937812', currentIndex: 2 };
  await app.routes.get('POST /v1/mobile/qobuz-connect/pause')?.(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(call, {
    action: 'pause',
    options: { expectedQobuzTrackId: '37937812', expectedCurrentIndex: 2 },
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.confirmed, true);
  assert.equal(res.body.snapshot.capabilities.readOnly, false);
  assert.equal(res.body.snapshot.capabilities.control, true);
  assert.equal(res.body.snapshot.queue.queueFingerprint, 'qobuz-queue-0123456789abcdef0123456789abcdef');
});

test('Qobuz control route preserves the fail-closed 503 when the control dependency is absent', async () => {
  const app = registerFixture();
  const res = createResponse();
  const req = request(token());
  req.body = { qobuzTrackId: '37937812' };
  await app.routes.get('POST /v1/mobile/qobuz-connect/pause')?.(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'PiBuZ Qobuz Connect control is not configured');
});

test('Qobuz release route uses the mobile bearer session and confirms inactive ownership', async () => {
  let releaseCalls = 0;
  let stateReads = 0;
  const app = registerFixture({}, {
    releaseQobuzConnect: async () => {
      releaseCalls += 1;
      return { accepted: true };
    },
    getQobuzNowPlaying: async () => {
      stateReads += 1;
      return stateReads === 1
        ? { active: true, suppressMpdHistory: true }
        : { active: false, suppressMpdHistory: false };
    },
    qobuzReleasePollMs: 25,
    qobuzReleaseTimeoutMs: 500,
  });
  const res = createResponse();

  await app.routes.get('POST /v1/mobile/qobuz-connect/release')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, state: 'released', mutationExecuted: true });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(releaseCalls, 1);
  assert.equal(stateReads, 2);
});

test('Qobuz release route accepts explicit backend process-stop confirmation', async () => {
  let stateReads = 0;
  const app = registerFixture({}, {
    releaseQobuzConnect: async () => ({ accepted: true, confirmed: true }),
    getQobuzNowPlaying: async () => {
      stateReads += 1;
      throw new Error('PiBuZ is stopped');
    },
  });
  const res = createResponse();

  await app.routes.get('POST /v1/mobile/qobuz-connect/release')?.(request(token()), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, state: 'released', mutationExecuted: true });
  assert.equal(stateReads, 0);
});

test('Qobuz release route fails closed when inactive ownership cannot be confirmed', async () => {
  const app = registerFixture({}, {
    releaseQobuzConnect: async () => ({ accepted: true }),
    getQobuzNowPlaying: async () => ({ active: true, suppressMpdHistory: true }),
    qobuzReleasePollMs: 25,
    qobuzReleaseTimeoutMs: 50,
  });
  const res = createResponse();

  await app.routes.get('POST /v1/mobile/qobuz-connect/release')?.(request(token()), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'QOBUZ_RELEASE_UNCONFIRMED');
});

test('Qobuz release route requires its configured release dependencies', async () => {
  const app = registerFixture();
  const res = createResponse();

  await app.routes.get('POST /v1/mobile/qobuz-connect/release')?.(request(token()), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'QOBUZ_RELEASE_UNAVAILABLE');
});
