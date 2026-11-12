import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CapabilityDeniedError } from '../src/lib/runtime-capabilities.mjs';
import { createBrowseIndexAdapter, createEmptyBrowseIndex, parseMpdDuration } from '../src/lib/browse-index.mjs';

test('browse index parses MPD colon-formatted durations', () => {
  assert.equal(parseMpdDuration('7:21'), 441);
  assert.equal(parseMpdDuration('1:02:03'), 3723);
  assert.equal(parseMpdDuration('180'), 180);
  assert.equal(parseMpdDuration(''), 0);
});

test('empty browse index is a complete v2 catalog with no MPD dependency', () => {
  const index = createEmptyBrowseIndex({ builtAt: '2026-11-05T00:00:00.000Z' });
  assert.equal(index.schema, 'now-playing.browse-index.v2');
  assert.equal(index.builtAt, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(index.counts, { artists: 0, albums: 0, tracks: 0 });
  assert.deepEqual(index.artists, []);
  assert.deepEqual(index.albums, []);
  assert.deepEqual(index.tracks, []);
});

async function temporaryFixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-browse-index-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  return root;
}

function syntheticBrowseIndex() {
  return {
    schema: 'now-playing.browse-index.v2',
    builtAt: '2026-10-25T00:00:00.000Z',
    dbUpdateAt: '',
    mpdHost: '127.0.0.1',
    counts: { artists: 1, albums: 1, tracks: 1 },
    artists: [{ key: 'synthetic ensemble', name: 'Synthetic Ensemble', albumCount: 1, trackCount: 1, sampleFile: 'Synthetic/Fixture.flac' }],
    albums: [{ key: 'synthetic ensemble|fixture album', artist: 'Synthetic Ensemble', album: 'Fixture Album', sampleFile: 'Synthetic/Fixture.flac', trackCount: 1, durationSec: 120, genre: 'Synthetic' }],
    tracks: [{ id: 1, file: 'Synthetic/Fixture.flac', artist: 'Synthetic Ensemble', albumArtist: 'Synthetic Ensemble', album: 'Fixture Album', title: 'Fixture', track: '1', trackNo: 1, genre: 'Synthetic', durationSec: 120, albumKey: 'synthetic ensemble|fixture album', artistKey: 'synthetic ensemble', mbTrackId: '', mbAlbumId: '', mbArtistId: '', rating: 0 }],
  };
}

test('rehearsal browse adapter accepts only its synthetic v2 fixture without spawning mpc', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  await fs.writeFile(indexPath, JSON.stringify(syntheticBrowseIndex()), 'utf8');
  let processCalls = 0;
  const adapter = createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: true },
    rehearsalStateRoot: root,
    // This executable intentionally appears available. The adapter must still
    // not invoke it, so no MPD network operation can begin.
    runExecFile: async () => {
      processCalls += 1;
      return { stdout: 'unexpected mpc result' };
    },
  });

  const index = await adapter.getBrowseIndex('not-used-in-rehearsal');
  assert.equal(index.schema, 'now-playing.browse-index.v2');
  assert.equal(index.tracks[0].file, 'Synthetic/Fixture.flac');
  assert.equal(processCalls, 0);
  await assert.rejects(
    adapter.getBrowseIndex('not-used-in-rehearsal', { force: true }),
    (error) => error instanceof CapabilityDeniedError && error.capability === 'browse-index.mpd-refresh',
  );
  await assert.rejects(
    adapter.buildBrowseIndex('not-used-in-rehearsal'),
    (error) => error instanceof CapabilityDeniedError && error.capability === 'browse-index.mpd-refresh',
  );
  assert.equal(processCalls, 0);
});

test('rehearsal browse adapter fails closed for missing or invalid synthetic inventory', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  let processCalls = 0;
  const createAdapter = () => createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: true },
    rehearsalStateRoot: root,
    runExecFile: async () => {
      processCalls += 1;
      return { stdout: '' };
    },
  });

  await assert.rejects(createAdapter().getBrowseIndex(), /fixture is unavailable or invalid/);
  await fs.writeFile(indexPath, JSON.stringify({ schema: 'now-playing.browse-index.v1', tracks: [] }), 'utf8');
  await assert.rejects(createAdapter().getBrowseIndex(), /fixture is unavailable or invalid/);
  assert.equal(processCalls, 0);
});

test('production browse adapter retains MPD freshness and index-build behavior', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  const calls = [];
  const adapter = createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: false },
    runExecFile: async (command, args) => {
      calls.push({ command, args });
      if (args.includes('stats')) return { stdout: '' };
      return { stdout: 'Synthetic/Fixture.flac\tSynthetic Ensemble\tSynthetic Ensemble\tFixture Album\tFixture\t1\tSynthetic\t2:00\t\t\t\n' };
    },
  });

  const index = await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(index.schema, 'now-playing.browse-index.v3');
  assert.equal(index.tracks.length, 1);
  assert.deepEqual(calls.map((entry) => entry.command), ['mpc', 'mpc']);
  assert.equal(calls[0].args.includes('stats'), true);
  assert.equal(calls[1].args.includes('listall'), true);
  assert.equal(JSON.parse(await fs.readFile(indexPath, 'utf8')).schema, 'now-playing.browse-index.v3');
});

test('browse index status observes a persisted index without contacting MPD or rebuilding it', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  await fs.writeFile(indexPath, JSON.stringify(syntheticBrowseIndex()), 'utf8');
  let processCalls = 0;
  const adapter = createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: false },
    runExecFile: async () => {
      processCalls += 1;
      throw new Error('status must not invoke mpc');
    },
  });
  const status = await adapter.getBrowseIndexStatus('production-mpd.example');
  assert.deepEqual(status, {
    available: true,
    source: 'persisted',
    builtAt: '2026-10-25T00:00:00.000Z',
    dbUpdateAt: null,
    counts: { artists: 1, albums: 1, tracks: 1 },
    refresh: { running: false },
  });
  assert.equal(processCalls, 0);
});


test('status counts music only without rewriting the full persisted catalog', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  const index = syntheticBrowseIndex();
  index.tracks.push({...index.tracks[0], id:2, file:'Podcasts/Fixture/episode.mp3', artist:'Podcast Host', albumArtist:'Podcast Host', album:'Podcast Show'});
  index.counts.tracks = 2;
  const original = JSON.stringify(index);
  await fs.writeFile(indexPath, original);
  const adapter = createBrowseIndexAdapter({statePaths:{browseIndexPath:indexPath}, capabilities:{rehearsal:false},
    runExecFile:async () => { throw new Error('must not contact MPD'); }});
  const status = await adapter.getBrowseIndexStatus('unused');
  assert.deepEqual(status.counts, {artists:1, albums:1, tracks:1});
  assert.equal(await fs.readFile(indexPath, 'utf8'), original);
});
