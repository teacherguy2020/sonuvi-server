import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createListeningHistoryStore } from '../src/lib/listening-history.mjs';

async function withStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'now-playing-history-'));
  let clock = Date.parse('2026-09-26T12:00:00.000Z');
  const store = createListeningHistoryStore({
    eventPath: path.join(dir, 'history.jsonl'),
    statePath: path.join(dir, 'history.state.json'),
    now: () => clock,
  });
  try {
    await run(store, () => { clock += 1000; });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function song(overrides = {}) {
  return {
    file: 'USB/SamsungMoode/Jazz/Blue Album/01 - First.mp3',
    artist: 'Blue Artist',
    albumArtist: 'Blue Artist',
    album: 'Blue Album',
    title: 'First',
    track: '1',
    genre: 'Jazz',
    time: '180',
    ...overrides,
  };
}

function status(elapsedSec, overrides = {}) {
  return { state: 'play', songid: '11', elapsedSec, ...overrides };
}

test('local history records an eligible local play once and aggregates rows', async () => {
  await withStore(async (store, advance) => {
    const first = await store.observe({ status: status(20), song: song() });
    assert.equal(first.recorded, false);

    advance();
    const recorded = await store.observe({ status: status(90), song: song() });
    assert.equal(recorded.recorded, true);

    advance();
    const duplicate = await store.observe({ status: status(120), song: song() });
    assert.equal(duplicate.reason, 'already-recorded');

    const tracks = await store.getItems('top-tracks', { baseUrl: 'http://nowplaying.local:8101', trackKey: 'track-key' });
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].title, 'First');
    assert.equal(tracks[0].playcount, 1);
    assert.match(tracks[0].art, /track_640\.jpg/);

    const albums = await store.getItems('top-albums');
    assert.equal(albums[0].title, 'Blue Album');
    const artists = await store.getItems('top-artists');
    assert.equal(artists[0].title, 'Blue Artist');
    const recent = await store.getItems('recent-tracks');
    assert.equal(recent[0].title, 'First');
  });
});

test('local history excludes short/ineligible playback and survives reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'now-playing-history-reload-'));
  let clock = Date.parse('2026-09-26T12:00:00.000Z');
  const options = {
    eventPath: path.join(dir, 'history.jsonl'),
    statePath: path.join(dir, 'history.state.json'),
    now: () => clock,
  };
  try {
    const store = createListeningHistoryStore(options);
    const short = await store.observe({
      status: status(40),
      song: song({ time: '20', title: 'Too Short' }),
    });
    assert.equal(short.recorded, false);

    clock += 1000;
    await store.observe({
      status: status(90, { songid: '12' }),
      song: song({ title: 'Persisted' }),
    });

    const reloaded = createListeningHistoryStore(options);
    const rows = await reloaded.getItems('recent-tracks');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Persisted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('native playback sessions use the client session for shared history idempotency', async () => {
  await withStore(async (store, advance) => {
    const startedAtMs = Date.parse('2026-09-26T11:59:00.000Z');
    const first = await store.observe({
      status: { state: 'start', songid: 'mobile:device-session-1', elapsedSec: 0 },
      song: song(),
      sessionId: 'mobile:device-session-1',
      startedAtMs,
      source: 'ios-device',
    });
    assert.equal(first.recorded, false);

    advance();
    const recorded = await store.observe({
      status: { state: 'progress', songid: 'mobile:device-session-1', elapsedSec: 90 },
      song: song(),
      sessionId: 'mobile:device-session-1',
      startedAtMs,
      source: 'ios-device',
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.event.sessionId, 'mobile:device-session-1');
    assert.equal(recorded.event.startedAtMs, startedAtMs);
    assert.equal(recorded.event.source, 'ios-device');

    const duplicate = await store.observe({
      status: { state: 'progress', songid: 'mobile:device-session-1', elapsedSec: 120 },
      song: song(),
      sessionId: 'mobile:device-session-1',
      startedAtMs,
      source: 'ios-device',
    });
    assert.equal(duplicate.reason, 'already-recorded');
  });
});

test('native playback retains canonical track key and duration across sparse progress events', async () => {
  await withStore(async (store) => {
    const startedAtMs = Date.parse('2026-09-26T11:59:00.000Z');
    const first = await store.observe({
      status: { state: 'start', songid: 'mobile:device-session-retain', elapsedSec: 0 },
      song: song({ trackKey: 'trk_canonical_1', durationSec: 180 }),
      sessionId: 'mobile:device-session-retain',
      startedAtMs,
      source: 'ios-device',
    });
    assert.equal(first.recorded, false);

    const recorded = await store.observe({
      status: { state: 'progress', songid: 'mobile:device-session-retain', elapsedSec: 90 },
      song: song({ durationSec: 0 }),
      sessionId: 'mobile:device-session-retain',
      startedAtMs,
      source: 'ios-device',
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.event.trackKey, 'trk_canonical_1');
    assert.equal(recorded.event.durationSec, 180);
  });
});

test('qualified non-MPD history invokes the asynchronous hook once and persists status updates', async () => {
  await withStore(async (store) => {
    let hookCalls = 0;
    const hookStore = createListeningHistoryStore({
      eventPath: store.eventPath,
      statePath: store.statePath,
      onQualified: async (event, { updateEvent }) => {
        hookCalls += 1;
        await updateEvent(event.sessionId, {
          lastfmScrobbleState: 'submitted',
          lastfmEligible: true,
        });
      },
    });
    const result = await hookStore.observe({
      status: { state: 'progress', songid: 'mobile:hook-1', elapsedSec: 90 },
      song: song({ trackKey: 'trk_canonical_1' }),
      sessionId: 'mobile:hook-1',
      source: 'ios-device',
    });
    assert.equal(result.recorded, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hookCalls, 1);
    const raw = await fs.readFile(hookStore.eventPath, 'utf8');
    assert.match(raw, /"trackKey":"trk_canonical_1"/);
    assert.match(raw, /"lastfmScrobbleState":"submitted"/);
  });
});

test('MPD history remains mpdscribble-authoritative and does not invoke non-MPD hooks', async () => {
  let hookCalls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'now-playing-history-mpd-hook-'));
  try {
    const store = createListeningHistoryStore({
      eventPath: path.join(dir, 'history.jsonl'),
      statePath: path.join(dir, 'history.state.json'),
      onQualified: async () => { hookCalls += 1; },
    });
    const result = await store.observe({
      status: status(90),
      song: song(),
      source: 'mpd',
    });
    assert.equal(result.recorded, true);
    assert.equal(result.event.lastfmScrobbleState, 'mpdscribble-authoritative');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hookCalls, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MPD shadow mode records centralized qualification without submitting Last.fm', { timeout: 5000 }, async () => {
  let hookCalls = 0;
  let qualified;
  const qualification = new Promise(resolve => { qualified = resolve; });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'now-playing-history-mpd-shadow-'));
  try {
    const store = createListeningHistoryStore({
      eventPath: path.join(dir, 'history.jsonl'),
      statePath: path.join(dir, 'history.state.json'),
      onQualified: async (event, { updateEvent }) => {
        hookCalls += 1;
        assert.equal(event.source, 'mpd');
        assert.equal(event.lastfmEligible, true);
        await updateEvent(event.sessionId, { lastfmScrobbleState: 'mpd-shadow-qualified' });
        qualified();
      },
    });
    const result = await store.observe({
      status: status(90),
      song: song({ trackKey: 'trk_mpd_shadow', durationSec: 180 }),
      source: 'mpd',
      lastfmMode: 'shadow',
    });
    assert.equal(result.recorded, true);
    assert.equal(result.event.trackKey, 'trk_mpd_shadow');
    assert.equal(result.event.lastfmScrobbleState, 'mpd-shadow-pending');
    await qualification;
    assert.equal(hookCalls, 1);
    const raw = await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8');
    assert.match(raw, /"lastfmScrobbleState":"mpd-shadow-qualified"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
