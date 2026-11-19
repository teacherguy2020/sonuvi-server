import assert from 'node:assert/strict';
import test from 'node:test';

import { registerConfigQueueWizardVibeRoutes } from '../src/routes/config.queue-wizard-vibe.routes.mjs';

function appFixture() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function registerPreview({ data, execError } = {}) {
  const app = appFixture();
  const calls = { exec: [], unlink: [] };
  registerConfigQueueWizardVibeRoutes(app, {
    requireTrackKey: () => true,
    getRatingForFile: async () => 0,
    mpdQueryRaw: async () => '',
    mpdHasACK: () => false,
    parseMpdKeyVals: () => ({}),
    parseMpdFirstBlock: () => ({}),
    log: {},
    resolveLastfmApiKey: async () => 'test-key-not-forwarded',
    resolveVibeIndexPath: async () => '/tmp/index.json',
    createVibeTemporaryJson: async () => '/tmp/vibe-preview.json',
    execFile: async (...args) => {
      calls.exec.push(args);
      if (execError) throw execError;
      return { stdout: '', stderr: '' };
    },
    fs: {
      async readFile() { return JSON.stringify(data); },
      async unlink(file) { calls.unlink.push(file); },
    },
  });
  return { app, calls };
}

test('seed preview forwards an allowlisted partial warning without subprocess fields', async () => {
  const { app, calls } = registerPreview({
    data: {
      planner: 'v2', tracks: [{ file: 'USB/private.flac' }], partial: true,
      warning_code: 'LASTFM_UNAVAILABLE', warning: 'raw upstream secret',
      recommendation_count: 12, local_match_count: 1, api_key: 'do-not-forward',
    },
  });
  const res = response();
  await app.routes.get('POST /config/queue-wizard/vibe-seed')({
    body: { seedArtist: 'Artist', seedTitle: 'Song', targetQueue: 12 }, headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.partial, true);
  assert.equal(res.body.summary.warningCode, 'LASTFM_UNAVAILABLE');
  assert.equal(res.body.summary.warning, 'Vibe recommendations are temporarily unavailable');
  assert.doesNotMatch(JSON.stringify(res.body.summary), /secret|api_key|do-not-forward/i);
  assert.equal(calls.exec[0][2].timeout, 21000);
  assert.deepEqual(calls.unlink, ['/tmp/vibe-preview.json']);
});

test('seed preview rejects unknown warning text and maps process timeout to 504 after cleanup', async () => {
  const unknown = registerPreview({
    data: { tracks: [{ file: 'USB/private.flac' }], partial: true, warning_code: 'UPSTREAM=secret' },
  });
  const unknownRes = response();
  await unknown.app.routes.get('POST /config/queue-wizard/vibe-seed')({
    body: { seedArtist: 'Artist', seedTitle: 'Song' }, headers: {},
  }, unknownRes);
  assert.equal(unknownRes.statusCode, 200);
  assert.equal(unknownRes.body.summary.partial, false);
  assert.doesNotMatch(JSON.stringify(unknownRes.body), /UPSTREAM|secret/);

  const timedOut = registerPreview({ execError: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true }) });
  const timeoutRes = response();
  await timedOut.app.routes.get('POST /config/queue-wizard/vibe-seed')({
    body: { seedArtist: 'Artist', seedTitle: 'Song' }, headers: {},
  }, timeoutRes);
  assert.equal(timeoutRes.statusCode, 504);
  assert.equal(timeoutRes.body.code, 'VIBE_DEADLINE_EXCEEDED');
  assert.deepEqual(timedOut.calls.unlink, ['/tmp/vibe-preview.json']);
});

test('seed preview returns controlled no-local-match failure', async () => {
  const { app } = registerPreview({ data: { tracks: [], failure_code: 'VIBE_NO_LOCAL_MATCHES' } });
  const res = response();
  await app.routes.get('POST /config/queue-wizard/vibe-seed')({
    body: { seedArtist: 'Artist', seedTitle: 'Song' }, headers: {},
  }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'VIBE_NO_LOCAL_MATCHES');
});
