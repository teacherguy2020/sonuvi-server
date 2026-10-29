import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichQueueSourceAudio, registerConfigDiagnosticsRoutes } from '../src/routes/config.diagnostics.routes.mjs';

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader() {},
    set() {},
    end() {},
  };
}

test('queue source audio enrichment exposes only verified local source metadata', async () => {
  const localHiRes = 'USB/SamsungMoode/Music/hi-res.flac';
  const localLowRes = 'USB/SamsungMoode/Music/cd-quality.flac';
  const stream = 'https://radio.example.test/live';
  const calls = [];
  const items = [
    { file: localHiRes, isStream: false },
    { file: localLowRes, isStream: false },
    { file: stream, isStream: true },
    { file: 'USB/SamsungMoode/Music/missing.flac', isStream: false },
  ];

  const enriched = await enrichQueueSourceAudio(items, async (file) => {
    calls.push(file);
    if (file === localHiRes) return { sampleRateHz: 48000, bitDepth: 24, channels: 2 };
    if (file === localLowRes) return { sampleRateHz: 96000, bitDepth: 16, channels: 2 };
    return null;
  });

  assert.deepEqual(calls, [localHiRes, localLowRes, 'USB/SamsungMoode/Music/missing.flac']);
  assert.deepEqual(enriched[0].sourceAudio, { sampleRateHz: 48000, bitDepth: 24, channels: 2 });
  assert.deepEqual(enriched[1].sourceAudio, { sampleRateHz: 96000, bitDepth: 16, channels: 2 });
  assert.equal(Object.hasOwn(enriched[2], 'sourceAudio'), false);
  assert.equal(Object.hasOwn(enriched[3], 'sourceAudio'), false);
});

test('diagnostics playback sends moOde toggle_play_pause and rejects hidden command errors', async () => {
  const app = createApp();
  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    setRatingForFile: async () => {},
    getAlexaWasPlaying: () => null,
    clearAlexaWasPlayingState: async () => {},
    setAlexaModeState: async () => null,
    getYoutubeNowPlayingHint: () => null,
    getYoutubeQueueHint: () => null,
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{"state":"play"}', { status: 200 });
  };

  try {
    const response = createResponse();
    await app.routes.get('POST /config/diagnostics/playback')?.({
      headers: {},
      body: { action: 'toggle' },
      query: {},
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.command, 'toggle_play_pause');
    assert.match(calls[0], /cmd=toggle_play_pause$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('diagnostics playback rejects MPD controls while Qobuz owns the renderer', async () => {
  const app = createApp();
  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    setRatingForFile: async () => {},
    getAlexaWasPlaying: () => null,
    clearAlexaWasPlayingState: async () => {},
    setAlexaModeState: async () => null,
    getYoutubeNowPlayingHint: () => null,
    getYoutubeQueueHint: () => null,
    getQobuzNowPlaying: async () => ({ active: true, source: 'qobuz-connect', state: 'play' }),
  });

  const response = createResponse();
  await app.routes.get('POST /config/diagnostics/playback')?.({
    headers: {},
    body: { action: 'repeat-mode', mode: 'all' },
    query: {},
  }, response);

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.unavailable, true);
  assert.equal(response.body.source, 'qobuz-connect');
  assert.match(response.body.error, /Qobuz Connect/);
});

test('diagnostics playback selects exact MPD repeat modes and reads them back', async () => {
  const app = createApp();
  const state = { random: 'off', repeat: 'off', single: 'off' };
  const calls = [];
  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    setRatingForFile: async () => {},
    getAlexaWasPlaying: () => null,
    clearAlexaWasPlayingState: async () => {},
    setAlexaModeState: async () => null,
    getYoutubeNowPlayingHint: () => null,
    getYoutubeQueueHint: () => null,
    runMpc: async (args) => {
      calls.push(args);
      const command = args[2];
      if (command === 'single' || command === 'repeat') state[command] = args[3];
      if (command === 'status') {
        return {
          stdout: `random: ${state.random}\nrepeat: ${state.repeat}\nsingle: ${state.single}\n`,
        };
      }
      return { stdout: '' };
    },
  });
  const route = app.routes.get('POST /config/diagnostics/playback');

  for (const [mode, expectedCommands] of [
    ['off', [['single', 'off'], ['repeat', 'off'], ['status']]],
    ['all', [['single', 'off'], ['repeat', 'on'], ['status']]],
    ['one', [['repeat', 'on'], ['single', 'on'], ['status']]],
  ]) {
    const response = createResponse();
    await route({ headers: {}, body: { action: 'repeat-mode', mode }, query: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      action: 'repeat-mode',
      mode,
      repeatMode: mode,
      randomOn: false,
      repeatOn: mode !== 'off',
      singleOn: mode === 'one',
      status: `random: off\nrepeat: ${mode === 'off' ? 'off' : 'on'}\nsingle: ${mode === 'one' ? 'on' : 'off'}\n`,
    });
    assert.deepEqual(calls.slice(-3).map((args) => args.slice(2)), expectedCommands);
  }

  const beforeInvalid = calls.length;
  const invalid = createResponse();
  await route({ headers: {}, body: { action: 'repeat-mode', mode: 'toggle' }, query: {} }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'REPEAT_MODE_INVALID');
  assert.equal(calls.length, beforeInvalid);
});

test('immutable Alexa diagnostics uses the protected environment without serializing its webhook', async (t) => {
  const app = createApp();
  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  const previousWebhook = process.env.ALEXA_ROUTE_WEBHOOK_URL;
  const protectedWebhook = 'https://private.example.invalid/alexa-start';
  process.env.SONUVI_STATE_ROOT = '/synthetic/sonuvi/shared';
  process.env.ALEXA_ROUTE_WEBHOOK_URL = protectedWebhook;
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.SONUVI_STATE_ROOT;
    else process.env.SONUVI_STATE_ROOT = previousStateRoot;
    if (previousWebhook === undefined) delete process.env.ALEXA_ROUTE_WEBHOOK_URL;
    else process.env.ALEXA_ROUTE_WEBHOOK_URL = previousWebhook;
  });

  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    setRatingForFile: async () => {},
    getAlexaWasPlaying: () => null,
    clearAlexaWasPlayingState: async () => {},
    setAlexaModeState: async () => null,
    getYoutubeNowPlayingHint: () => null,
    getYoutubeQueueHint: () => null,
  });

  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response('ok', { status: 200 });
  };
  try {
    const response = createResponse();
    await app.routes.get('POST /config/diagnostics/playback')?.({
      headers: {}, body: { action: 'routealexa' }, query: {},
    }, response);
    assert.equal(requestedUrl, protectedWebhook);
    assert.equal(response.body.webhookConfigured, true);
    assert.equal(JSON.stringify(response.body).includes(protectedWebhook), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('diagnostics adapter denies a protected Alexa write in rehearsal before fetch', async (t) => {
  const app = createApp();
  const previousMode = process.env.SONUVI_EXECUTION_MODE;
  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  const previousWebhook = process.env.ALEXA_ROUTE_WEBHOOK_URL;
  process.env.SONUVI_EXECUTION_MODE = 'rehearsal';
  process.env.SONUVI_STATE_ROOT = '/synthetic/sonuvi/shared';
  process.env.ALEXA_ROUTE_WEBHOOK_URL = 'https://private.example.invalid/alexa-start';
  t.after(() => {
    if (previousMode === undefined) delete process.env.SONUVI_EXECUTION_MODE;
    else process.env.SONUVI_EXECUTION_MODE = previousMode;
    if (previousStateRoot === undefined) delete process.env.SONUVI_STATE_ROOT;
    else process.env.SONUVI_STATE_ROOT = previousStateRoot;
    if (previousWebhook === undefined) delete process.env.ALEXA_ROUTE_WEBHOOK_URL;
    else process.env.ALEXA_ROUTE_WEBHOOK_URL = previousWebhook;
  });

  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    setRatingForFile: async () => {},
    getAlexaWasPlaying: () => null,
    clearAlexaWasPlayingState: async () => {},
    setAlexaModeState: async () => null,
    getYoutubeNowPlayingHint: () => null,
    getYoutubeQueueHint: () => null,
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('unexpected', { status: 200 });
  };
  try {
    const response = createResponse();
    await app.routes.get('POST /config/diagnostics/playback')?.({
      headers: {}, body: { action: 'routealexa' }, query: {},
    }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(fetchCalls, 0);
    assert.equal(response.body.error, 'This operation is disabled in Sonuvi rehearsal mode');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
