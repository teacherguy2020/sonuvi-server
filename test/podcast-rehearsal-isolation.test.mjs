import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeCapabilities } from '../src/lib/runtime-capabilities.mjs';
import { registerPodcastRefreshRoutes } from '../src/routes/podcasts-refresh.routes.mjs';

function appFixture() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function responseFixture() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('legacy GET podcast refresh paths cannot write or fetch during rehearsal', async () => {
  const app = appFixture();
  const capabilities = createRuntimeCapabilities({
    env: {
      SONUVI_EXECUTION_MODE: 'rehearsal',
      SONUVI_REHEARSAL_STATE_ROOT: '/synthetic/rehearsal-state',
    },
  });
  let mapCalls = 0;
  let writeCalls = 0;
  registerPodcastRefreshRoutes(app, {
    capabilities,
    readSubs: () => [{ rss: 'https://example.invalid/feed.xml', outM3u: '/synthetic/rehearsal-state/maps/feed.m3u' }],
    normUrl: (value) => String(value || '').trim(),
    buildPodcastMap: async () => {
      mapCalls += 1;
      return {};
    },
    writeSubs: () => { writeCalls += 1; },
  });

  for (const [route, request] of [
    ['GET /podcasts/refresh', { query: {} }],
    ['GET /podcasts/refresh-one', { query: { outM3u: '/synthetic/rehearsal-state/maps/feed.m3u' } }],
  ]) {
    const response = responseFixture();
    await app.routes.get(route)(request, response);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'This operation is disabled in Sonuvi rehearsal mode');
  }
  assert.equal(mapCalls, 0);
  assert.equal(writeCalls, 0);
});
