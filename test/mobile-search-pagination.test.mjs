import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';

function matchingTracks(count) {
  return Array.from({ length: count }, (_, index) => ({
    file: `USB/Pagination/Match ${String(index + 1).padStart(3, '0')}.flac`,
    artist: 'Pagination Artist',
    albumArtist: 'Pagination Artist',
    album: 'Pagination Album',
    title: `Match ${index + 1}`,
    track: String(index + 1),
    durationSec: 180,
  }));
}

test('mobile search enriches only the requested page over HTTP', async (t) => {
  const tracks = matchingTracks(64);
  const probedFiles = [];
  const app = express();
  registerMobileRoutes(app, {
    enabled: true,
    apiSecret: 'api-secret-for-test',
    trackIdSecret: 'track-secret-for-test',
    getBrowseIndex: async () => ({ builtAt: '2026-11-10T00:00:00.000Z', tracks }),
    getSourceAudio: async (file) => {
      probedFiles.push(file);
      return { sampleRateHz: 96000, bitDepth: 24, channels: 2 };
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const get = (pathname, token = '') => fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const token = createMobileSessionToken({
    secret: 'api-secret-for-test',
    deviceId: 'pagination-device',
  });

  const unauthorized = await get('/v1/mobile/search?q=match&limit=3');
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(probedFiles, []);

  const first = await get('/v1/mobile/search?q=match&limit=3&offset=5', token);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.total, 64);
  assert.equal(firstBody.count, 3);
  assert.equal(firstBody.offset, 5);
  assert.equal(firstBody.limit, 3);
  assert.equal(firstBody.nextCursor, '8');
  assert.deepEqual(firstBody.items.map((item) => item.title), ['Match 6', 'Match 7', 'Match 8']);
  assert.deepEqual(probedFiles, tracks.slice(5, 8).map((track) => track.file));

  const second = await get('/v1/mobile/search?q=match&limit=2&offset=10', token);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.total, 64);
  assert.equal(secondBody.count, 2);
  assert.equal(secondBody.offset, 10);
  assert.equal(secondBody.limit, 2);
  assert.equal(secondBody.nextCursor, '12');
  assert.deepEqual(secondBody.items.map((item) => item.title), ['Match 11', 'Match 12']);
  assert.deepEqual(probedFiles, tracks.slice(5, 8).concat(tracks.slice(10, 12)).map((track) => track.file));

  const noMatch = await get('/v1/mobile/search?q=absent&limit=3', token);
  assert.equal(noMatch.status, 200);
  assert.deepEqual(await noMatch.json(), {
    ok: true,
    offset: 0,
    limit: 3,
    total: 0,
    count: 0,
    nextCursor: null,
    items: [],
  });

  const outOfRange = await get('/v1/mobile/search?q=match&limit=3&offset=100', token);
  assert.equal(outOfRange.status, 200);
  const outOfRangeBody = await outOfRange.json();
  assert.equal(outOfRangeBody.total, 64);
  assert.equal(outOfRangeBody.count, 0);
  assert.equal(outOfRangeBody.offset, 100);
  assert.equal(outOfRangeBody.limit, 3);
  assert.equal(outOfRangeBody.nextCursor, null);
  assert.deepEqual(outOfRangeBody.items, []);
  assert.deepEqual(probedFiles, tracks.slice(5, 8).concat(tracks.slice(10, 12)).map((track) => track.file));
});
