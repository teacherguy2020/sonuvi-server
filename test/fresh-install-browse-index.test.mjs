import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeBrowseIndexProvider } from '../src/lib/fresh-install-browse-index.mjs';

test('fresh-install catalog provider returns a stable empty index without invoking MPD', async () => {
  let mpdCalls = 0;
  const provider = createRuntimeBrowseIndexProvider({
    freshInstall: true,
    getMpdBrowseIndex: async () => {
      mpdCalls += 1;
      throw new Error('MPD must not be contacted by a fresh Server');
    },
  });

  const first = await provider.getBrowseIndex('moode.local');
  const second = await provider.getBrowseIndex('127.0.0.1', { force: true });
  assert.equal(provider.freshInstall, true);
  assert.equal(first, second);
  assert.deepEqual(first.counts, { artists: 0, albums: 0, tracks: 0 });
  assert.deepEqual(await provider.getBrowseIndexStatus(), {
    available: true,
    source: 'fresh-install-empty',
    builtAt: first.builtAt,
    dbUpdateAt: null,
    counts: { artists: 0, albums: 0, tracks: 0 },
    refresh: { running: false },
  });
  assert.equal(mpdCalls, 0);
});

test('established Server catalog provider delegates unchanged to MPD', async () => {
  const calls = [];
  const statusCalls = [];
  const provider = createRuntimeBrowseIndexProvider({
    getMpdBrowseIndex: async (...args) => {
      calls.push(args);
      return { tracks: ['normal-index'] };
    },
    getMpdBrowseIndexStatus: async (...args) => {
      statusCalls.push(args);
      return {
        available: true,
        source: 'persisted',
        builtAt: '2026-11-08T12:00:00.000Z',
        dbUpdateAt: null,
        counts: { artists: 1, albums: 2, tracks: 3 },
        refresh: { running: false },
      };
    },
  });

  assert.deepEqual(await provider.getBrowseIndex('production-mpd.example', { force: true }), { tracks: ['normal-index'] });
  assert.deepEqual(await provider.getBrowseIndexStatus('production-mpd.example'), {
    available: true,
    source: 'persisted',
    builtAt: '2026-11-08T12:00:00.000Z',
    dbUpdateAt: null,
    counts: { artists: 1, albums: 2, tracks: 3 },
    refresh: { running: false },
  });
  assert.deepEqual(calls, [['production-mpd.example', { force: true }]]);
  assert.deepEqual(statusCalls, [['production-mpd.example']]);
  assert.equal(provider.freshInstall, false);
});
