import { createPibuzQobuzControlAdapter } from '../src/lib/pibuz-qobuz-control.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  createPibuzQobuzAdapter,
} from '../src/lib/pibuz-qobuz.mjs';

const status = ({ active = true, sessionActive = true } = {}) => ({
  version: '2.5.1',
  qconnect: {
    is_active: active,
    session_active: sessionActive,
    state: active ? 'connected' : 'disconnected',
    device_name: 'Sonuvi',
  },
  playback: {
    is_playing: active,
    position: 12,
    duration: 298,
    output_sample_rate: 96000,
    sample_rate: 96000,
    bit_depth: 24,
    bit_perfect_mode: true,
    queue_len: 30,
    repeat: 'off',
    shuffle: false,
  },
});

const track = (id = 37937812, artworkUrl = 'https://static.qobuz.com/images/covers/47/05/album.jpg?cache=1') => ({
  id,
  title: '25 or 6 to 4',
  artist: 'Chicago',
  album: 'Chicago II',
  album_id: '0603497870547',
  artist_id: 118769,
  duration_secs: 298,
  artwork_url: artworkUrl,
  sample_rate: 96,
  bit_depth: 24,
  hires: true,
  source: 'qobuz_connect_remote',
});

const nowPlaying = (item = track()) => ({
  playback: {
    is_playing: true,
    position: 12,
    duration: 298,
    output_sample_rate: 96000,
    sample_rate: 96000,
    bit_depth: 24,
    queue_len: 30,
    repeat: 'off',
    shuffle: false,
  },
  track: item,
});

function response(value, { contentType = 'application/json' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : '' },
    arrayBuffer: async () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

function jsonFetch({ statusBody = status(), nowBody = nowPlaying(), queueBody = null } = {}) {
  return async (url) => {
    if (url.endsWith('/api/status')) return response(statusBody);
    if (url.endsWith('/api/now-playing')) return response(nowBody);
    if (url.endsWith('/api/queue')) return response(queueBody || {
      current_index: 2,
      total_tracks: 30,
      repeat: 'off',
      shuffle: false,
      stop_after_track_id: null,
      current_track: track(),
      history: [track(1), track(1)],
      upcoming: [track(2), track(3)],
    });
    throw new Error(`unexpected URL: ${url}`);
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached in time');
    await delay(5);
  }
}

async function createSseFixture(onConnection, { deferHeaders = false } = {}) {
  const state = {
    requests: 0,
    active: 0,
    maxActive: 0,
    closed: 0,
    connectionTimes: [],
    connections: new Set(),
    timers: new Set(),
  };
  const server = createServer((req, res) => {
    if (req.url !== '/api/events') {
      res.writeHead(404);
      res.end();
      return;
    }
    const connection = {
      req,
      res,
      index: state.requests,
      closed: false,
      write(value) {
        if (!connection.closed) res.write(value);
      },
      end() {
        if (!connection.closed) res.end();
      },
      schedule(callback, ms) {
        const timer = setTimeout(() => {
          state.timers.delete(timer);
          callback();
        }, ms);
        state.timers.add(timer);
        return timer;
      },
      start() {
        if (connection.closed || connection.started) return;
        connection.started = true;
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
        });
      },
    };
    state.requests += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.connectionTimes.push(Date.now());
    state.connections.add(connection);
    const finish = () => {
      if (connection.closed) return;
      connection.closed = true;
      state.active -= 1;
      state.closed += 1;
      state.connections.delete(connection);
    };
    req.on('close', finish);
    res.on('close', finish);
    if (!deferHeaders) connection.start();
    onConnection?.(connection, state);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    port: address.port,
    get requests() { return state.requests; },
    get active() { return state.active; },
    get maxActive() { return state.maxActive; },
    get closed() { return state.closed; },
    connectionTimes: state.connectionTimes,
    closeConnections() {
      for (const connection of [...state.connections]) connection.end();
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
    },
  };
}

async function closeSseFixture(fixture) {
  fixture.closeConnections();
  await new Promise((resolve) => fixture.server.close(() => resolve()));
}

function localEventAdapter(port, options = {}) {
  return createPibuzQobuzAdapter({
    host: '127.0.0.1',
    port,
    timeoutMs: 100,
    eventJitterRatio: 0,
    ...options,
  });
}

test('PiBuZ adapter normalizes active Qobuz ownership and quality without inventing output bit depth', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl: jsonFetch(),
  });

  const snapshot = await adapter.getNowPlaying();
  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.sessionActive, true);
  assert.equal(snapshot.receiverActive, true);
  assert.equal(snapshot.state, 'play');
  assert.equal(snapshot.timingStable, true);
  assert.equal(snapshot.qobuzTrackId, '37937812');
  assert.equal(snapshot.qobuzAlbumId, '0603497870547');
  assert.equal(snapshot.elapsedSec, 12);
  assert.equal(snapshot.sourceFormat, 'Qobuz 24-bit / 96 kHz');
  assert.equal(snapshot.outputFormat, 'PCM / 96 kHz');
  assert.equal(snapshot.outputFormatDetails.bitDepth, null);
  assert.match(snapshot.artworkUrl, /^https:\/\/static\.qobuz\.com\//);
  assert.equal(snapshot.artworkUrl.includes('?'), false);
});

test('PiBuZ inactive ownership is authoritative and distinguishes an authenticated session', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl: jsonFetch({ statusBody: status({ active: false, sessionActive: true }) }),
  });

  const snapshot = await adapter.getNowPlaying();
  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.sessionActive, true);
  assert.equal(snapshot.receiverActive, false);
  assert.equal(snapshot.reason, 'inactive');
});

test('PiBuZ queue preserves ordering and duplicate occurrences', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl: jsonFetch(),
  });

  const snapshot = await adapter.getQueue();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.queue.available, true);
  assert.equal(snapshot.queue.currentIndex, 2);
  assert.equal(snapshot.queue.totalTracks, 30);
  assert.deepEqual(snapshot.queue.history.map((item) => item.qobuzTrackId), ['1', '1']);
  assert.deepEqual(snapshot.queue.upcoming.map((item) => item.qobuzTrackId), ['2', '3']);
  assert.match(snapshot.queue.history[0].artworkRef, /^qobuz-[a-f0-9]{24}$/);
});

test('PiBuZ malformed queue is explicitly unavailable rather than an empty queue', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl: jsonFetch({ queueBody: [] }),
  });

  const snapshot = await adapter.getQueue();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.queue.available, false);
  assert.equal(snapshot.queue.reason, 'malformed');
});

test('PiBuZ transport failures are bounded and do not fall back to stale ownership forever', async () => {
  let currentTime = 1000;
  let fail = false;
  let receiverActive = true;
  const fetchImpl = async (url) => {
    if (fail) throw new Error('receiver unavailable');
    return jsonFetch({ statusBody: status({ active: receiverActive }) })(url);
  };
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl,
    staleMs: 8000,
    now: () => currentTime,
  });

  assert.equal((await adapter.getNowPlaying()).active, true);
  fail = true;
  currentTime = 5000;
  const stale = await adapter.getNowPlaying();
  assert.equal(stale.active, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.suppressMpdHistory, true);

  currentTime = 10001;
  const expired = await adapter.getNowPlaying();
  assert.equal(expired.active, false);
  assert.equal(expired.authoritative, true);
  assert.equal(expired.available, false);
  assert.equal(expired.ownershipState, 'unknown');
  assert.equal(expired.reason, 'ownership-unknown');
  assert.equal(expired.suppressMpdHistory, true);
  assert.equal(expired.title, '');

  fail = false;
  receiverActive = false;
  const recovered = await adapter.getNowPlaying();
  assert.equal(recovered.active, false);
  assert.equal(recovered.ownershipState, 'confirmed-inactive');
  assert.equal(Boolean(recovered.stale), false);
});

test('PiBuZ reports unknown when it has never established receiver state', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    fetchImpl: async () => { throw new Error('receiver unavailable'); },
  });

  const snapshot = await adapter.getNowPlaying();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.ownershipState, 'unknown');
  assert.equal(snapshot.authoritative, false);
});

test('PiBuZ rejects oversized JSON responses', async () => {
  const adapter = createPibuzQobuzAdapter({
    host: '10.0.0.254',
    maxJsonBytes: 1024,
    fetchImpl: async () => response('x'.repeat(2048)),
  });

  const snapshot = await adapter.getNowPlaying();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.authoritative, false);
  assert.equal(snapshot.reason, 'unavailable');
});

test('PiBuZ event stream records bounded status without retaining event payloads', async () => {
  const encoder = new TextEncoder();
  let eventCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/events')) {
      eventCalls += 1;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            let read = false;
            return {
              async read() {
                if (read) return { done: true, value: undefined };
                read = true;
                return { done: false, value: encoder.encode('event: track\ndata: {"secret":"never-return"}\n\n') };
              },
            };
          },
        },
      };
    }
    return jsonFetch()(url);
  };
  const adapter = createPibuzQobuzAdapter({ host: '10.0.0.254', fetchImpl });
  adapter.startEvents();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const state = adapter.getEventState();
  await adapter.stopEvents();
  assert.ok(eventCalls >= 1);
  assert.ok(state.revision >= 1);
  assert.equal(state.lastEventType, 'track');
  assert.equal(JSON.stringify(state).includes('never-return'), false);
});

test('PiBuZ SSE start/stop is idempotent and never overlaps subscriptions', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.write(': heartbeat\n\n');
  });
  const adapter = localEventAdapter(fixture.port);
  try {
    const firstTask = adapter.startEvents();
    assert.strictEqual(adapter.startEvents(), firstTask);
    await eventually(() => adapter.getEventState().connected);
    assert.equal(adapter.getEventState().activeConnections, 1);
    assert.equal(adapter.getEventState().connectionAttempts, 1);

    await adapter.stopEvents();
    await adapter.stopEvents();
    await eventually(() => fixture.active === 0);
    assert.equal(fixture.active, 0);

    const secondTask = adapter.startEvents();
    assert.notStrictEqual(secondTask, firstTask);
    await eventually(() => fixture.requests === 2 && adapter.getEventState().connected);
    assert.equal(fixture.maxActive, 1);

    await adapter.stopEvents();
    assert.equal(adapter.getEventState().activeConnections, 0);
    assert.equal(adapter.getEventState().backoffMs, 0);
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ keeps a healthy stalled SSE stream open without reconnecting', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.write(': heartbeat\n\n');
  });
  const adapter = localEventAdapter(fixture.port, {
    eventRetryBaseMs: 10,
    eventRetryMaxMs: 20,
  });
  try {
    adapter.startEvents();
    await eventually(() => adapter.getEventState().connected);
    await delay(120);
    const state = adapter.getEventState();
    assert.equal(state.connectionAttempts, 1);
    assert.equal(state.reconnects, 0);
    assert.equal(state.activeConnections, 1);
    assert.ok(state.connectionAgeMs >= 80);
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ parses SSE events while exposing only bounded diagnostics', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.write('event: track\ndata: {"secret":"never-return"}\n\n');
    connection.write(': heartbeat\n\n');
  });
  const adapter = localEventAdapter(fixture.port);
  try {
    adapter.startEvents();
    await eventually(() => adapter.getEventState().revision >= 1);
    const state = adapter.getEventState();
    assert.equal(state.lastEventType, 'track');
    assert.equal(state.activeConnections, 1);
    assert.equal(JSON.stringify(state).includes('never-return'), false);
    assert.equal(typeof state.connectionAgeMs, 'number');
    assert.equal(typeof state.connectionAttempts, 'number');
    assert.equal(typeof state.lastDisconnectReason, 'string');
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ applies bounded exponential backoff when the receiver ends SSE streams', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.schedule(() => connection.end(), 0);
  });
  const adapter = localEventAdapter(fixture.port, {
    eventRetryBaseMs: 30,
    eventRetryMaxMs: 60,
    eventStableMs: 1000,
  });
  try {
    adapter.startEvents();
    await eventually(() => fixture.requests >= 3, 1000);
    const [first, second, third] = fixture.connectionTimes;
    assert.ok(second - first >= 20);
    assert.ok(third - second >= 45);
    assert.equal(fixture.maxActive, 1);
    assert.ok(adapter.getEventState().reconnects >= 2);
    assert.equal(adapter.getEventState().lastDisconnectReason, 'eof');
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ cancellation closes a stalled reader and stops reconnect work', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.write(': stalled\n\n');
  });
  const adapter = localEventAdapter(fixture.port, {
    eventRetryBaseMs: 10,
    eventRetryMaxMs: 20,
  });
  try {
    adapter.startEvents();
    await eventually(() => adapter.getEventState().connected);
    await Promise.race([
      adapter.stopEvents(),
      delay(500).then(() => { throw new Error('stopEvents did not resolve'); }),
    ]);
    await eventually(() => fixture.active === 0);
    assert.equal(fixture.active, 0);
    assert.equal(adapter.getEventState().activeConnections, 0);
    const attemptsAfterStop = adapter.getEventState().connectionAttempts;
    await delay(50);
    assert.equal(adapter.getEventState().connectionAttempts, attemptsAfterStop);
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ classifies an initial SSE connection timeout and can abort it cleanly', async () => {
  const fixture = await createSseFixture((connection) => {
    connection.schedule(() => {
      connection.start();
      connection.end();
    }, 500);
  }, { deferHeaders: true });
  const adapter = localEventAdapter(fixture.port, {
    timeoutMs: 100,
    eventRetryBaseMs: 200,
    eventRetryMaxMs: 200,
  });
  try {
    adapter.startEvents();
    await eventually(() => adapter.getEventState().lastDisconnectReason === 'request-timeout', 700);
    assert.equal(adapter.getEventState().activeConnections, 0);
    await adapter.stopEvents();
    assert.equal(fixture.requests, 1);
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

test('PiBuZ stop aborts a pending SSE connection attempt without retrying', async () => {
  const fixture = await createSseFixture(() => {}, { deferHeaders: true });
  const adapter = localEventAdapter(fixture.port, {
    timeoutMs: 500,
    eventRetryBaseMs: 10,
    eventRetryMaxMs: 20,
  });
  try {
    adapter.startEvents();
    await eventually(() => fixture.requests === 1);
    await Promise.race([
      adapter.stopEvents(),
      delay(500).then(() => { throw new Error('stopEvents did not abort pending request'); }),
    ]);
    await eventually(() => fixture.active === 0);
    assert.equal(adapter.getEventState().lastDisconnectReason, 'stopped');
    await delay(50);
    assert.equal(fixture.requests, 1);
  } finally {
    await adapter.stopEvents();
    await closeSseFixture(fixture);
  }
});

// A clean installation has no receiver yet: startup must remain available
// for Guided Setup, without probing a fabricated/default network target.
test('unconfigured receiver is unavailable without network calls or event retries', async () => {
  let calls = 0;
  const adapter = createPibuzQobuzAdapter({ host: '', fetchImpl: async () => { calls++; throw new Error('unexpected network call'); } });
  assert.equal(adapter.endpoint, '');
  await adapter.startEvents();
  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.available, false);
  assert.equal(adapter.getEventState().connectionAttempts, 0);
  assert.equal(calls, 0);
  await adapter.stopEvents();
});

test('unconfigured receiver exposes unavailable controls without a fabricated endpoint', async () => {
  const read = createPibuzQobuzAdapter({host: ''});
  const control = createPibuzQobuzControlAdapter({adapter: read, fetchImpl: async () => { throw Error('must not request'); }});
  assert.equal((await control.getSnapshot()).available, false);
  assert.equal((await control.control('play')).errorCode, 'QOBUZ_OWNERSHIP_UNKNOWN');
});
