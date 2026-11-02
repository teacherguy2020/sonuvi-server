import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CapabilityDeniedError } from '../src/lib/runtime-capabilities.mjs';
import { createBrowseIndexAdapter, parseMpdDuration } from '../src/lib/browse-index.mjs';

test('browse index parses MPD colon-formatted durations', () => {
  assert.equal(parseMpdDuration('7:21'), 441);
  assert.equal(parseMpdDuration('1:02:03'), 3723);
  assert.equal(parseMpdDuration('180'), 180);
  assert.equal(parseMpdDuration(''), 0);
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
    readMpdRaw: async () => '',
  });

  const index = await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(index.schema, 'now-playing.browse-index.v3');
  assert.equal(index.tracks.length, 1);
  assert.equal(index.tracks[0].audioQuality.verificationStatus, 'pending');
  assert.equal(index.albums[0].audioQuality.pendingTrackCount, 1);
  assert.deepEqual(calls.map((entry) => entry.command), ['mpc', 'mpc']);
  assert.equal(calls[0].args.includes('stats'), true);
  assert.equal(calls[1].args.includes('listall'), true);
  assert.equal(JSON.parse(await fs.readFile(indexPath, 'utf8')).schema, 'now-playing.browse-index.v3');
});

test('v3 enriches incrementally, resumes persisted work, and only reprobes a changed source revision', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  let listing = [
    'Artist/Album/01.flac\tArtist\tArtist\tAlbum\tOne\t1\tJazz\t2:00\t\t\t\t2026-01-01T00:00:00.000Z',
    'Artist/Album/02.flac\tArtist\tArtist\tAlbum\tTwo\t2\tJazz\t2:00\t\t\t\t2026-01-01T00:00:00.000Z',
  ].join('\n');
  const probes = [];
  const runExecFile = async (command, args) => {
    if (args.includes('stats')) return { stdout: '' };
    return { stdout: `${listing}\n` };
  };
  const readMpdRaw = async () => listing.split('\n').map((line) => {
    const [file = '', , , , , , , , , , , modified = ''] = line.split('\t');
    return `file: ${file}\nLast-Modified: ${modified}\n`;
  }).join('');
  const getAudioQualityRecord = async (file) => {
    probes.push(file);
    return {
      status: 'verified',
      sourceAudio: file.endsWith('01.flac')
        ? { codec: 'FLAC', codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100, channels: 2 }
        : { codec: 'FLAC', codecKind: 'lossless', bitDepth: 24, sampleRateHz: 96_000, channels: 2 },
      sourceRevision: { sizeBytes: file.endsWith('01.flac') ? 101 : 102, modifiedMs: 10, probeVersion: 2 },
    };
  };
  const options = {
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: false },
    runExecFile,
    readMpdRaw,
    getAudioQualityRecord,
    qualityBatchSize: 1,
    schedule: () => null,
    now: () => Date.parse('2026-11-01T00:00:00.000Z'),
  };
  const adapter = createBrowseIndexAdapter(options);

  let index = await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(index.audioQuality.pendingTracks, 2);
  assert.deepEqual(probes, []);

  await adapter.runQualityBatch('production-mpd.example');
  index = await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(index.audioQuality.verifiedTracks, 1);
  assert.equal(index.audioQuality.pendingTracks, 1);
  assert.deepEqual(probes, ['Artist/Album/01.flac']);

  const resumed = createBrowseIndexAdapter(options);
  await resumed.runQualityBatch('production-mpd.example');
  index = await resumed.getBrowseIndex('production-mpd.example');
  assert.equal(index.audioQuality.verifiedTracks, 2);
  assert.equal(index.albums[0].audioQuality.badgeEligibility, 'none');
  assert.deepEqual(probes, ['Artist/Album/01.flac', 'Artist/Album/02.flac']);

  await resumed.runQualityBatch('production-mpd.example');
  assert.equal(probes.length, 2);

  listing = listing.replace('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  await resumed.getBrowseIndex('production-mpd.example', { force: true });
  index = await resumed.getBrowseIndex('production-mpd.example');
  assert.equal(index.tracks[0].audioQuality.verificationStatus, 'pending');
  assert.equal(index.tracks[1].audioQuality.verificationStatus, 'verified');
  await resumed.runQualityBatch('production-mpd.example');
  assert.deepEqual(probes, ['Artist/Album/01.flac', 'Artist/Album/02.flac', 'Artist/Album/01.flac']);
});

test('v3 returns a 9,000-track pending index before any quality probe starts', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  const listing = Array.from({ length: 9_000 }, (_, index) => (
    `Artist/Album/${String(index + 1).padStart(5, '0')}.flac\tArtist\tArtist\tAlbum\tTrack ${index + 1}\t${index + 1}\tJazz\t2:00\t\t\t\t2026-01-01T00:00:00.000Z`
  )).join('\n');
  let probeCalls = 0;
  const adapter = createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: false },
    qualityBatchSize: 2,
    schedule: () => null,
    runExecFile: async (command, args) => args.includes('stats') ? { stdout: '' } : { stdout: `${listing}\n` },
    readMpdRaw: async () => '',
    getAudioQualityRecord: async () => {
      probeCalls += 1;
      return {
        status: 'verified',
        sourceAudio: { codec: 'FLAC', codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100, channels: 2 },
        sourceRevision: { sizeBytes: 100, modifiedMs: 10, probeVersion: 2 },
      };
    },
  });

  const index = await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(index.tracks.length, 9_000);
  assert.equal(index.audioQuality.pendingTracks, 9_000);
  assert.equal(probeCalls, 0);
  await adapter.runQualityBatch('production-mpd.example');
  assert.equal(probeCalls, 2);
});

test('background enrichment schedules the next bounded batch after the current batch completes', async (t) => {
  const root = await temporaryFixtureRoot(t);
  const indexPath = path.join(root, 'data', 'library-browse-index.json');
  const scheduled = [];
  let probes = 0;
  const adapter = createBrowseIndexAdapter({
    statePaths: { browseIndexPath: indexPath },
    capabilities: { rehearsal: false },
    qualityBatchSize: 1,
    qualityBatchDelayMs: 1,
    schedule: (task) => {
      scheduled.push(task);
      return { unref() {} };
    },
    runExecFile: async (command, args) => args.includes('stats')
      ? { stdout: '' }
      : { stdout: 'Artist/Album/01.flac\tArtist\tArtist\tAlbum\tOne\t1\tJazz\t2:00\t\t\t\nArtist/Album/02.flac\tArtist\tArtist\tAlbum\tTwo\t2\tJazz\t2:00\t\t\t\n' },
    readMpdRaw: async () => '',
    getAudioQualityRecord: async () => {
      probes += 1;
      return {
        status: 'verified',
        sourceAudio: { codec: 'FLAC', codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100, channels: 2 },
        sourceRevision: { sizeBytes: 100, modifiedMs: 10, probeVersion: 2 },
      };
    },
  });

  await adapter.getBrowseIndex('production-mpd.example');
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(probes, 1);
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(probes, 2);
  assert.equal(scheduled.length, 0);
});
