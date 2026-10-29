import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNamedQobuzQueueService } from '../src/lib/named-qobuz-queue-service.mjs';
import {
  createSavedQobuzQueueStore,
  deserializeSavedQobuzQueueRecord,
} from '../src/lib/saved-qobuz-queues.mjs';

function track(id) {
  return {
    qobuzTrackId: String(id),
    title: `Track ${id}`,
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    qobuzAlbumId: null,
    qobuzArtistId: '123',
    version: '',
    durationSec: 180,
    artworkRef: null,
    sampleRateHz: 44100,
    bitDepth: 16,
    hires: false,
  };
}

function authoritativeSnapshot() {
  const current = track(100);
  return {
    active: true,
    ownershipState: 'confirmed-active',
    receiverActive: true,
    timingStable: true,
    state: 'play',
    qobuzTrackId: current.qobuzTrackId,
    elapsedSec: 12,
    durationSec: 180,
    queue: {
      available: true,
      currentIndex: 0,
      totalTracks: 2,
      queueFingerprint: 'qobuz-queue-fixture',
      repeat: 'off',
      shuffle: false,
      stopAfterTrackId: null,
      history: [],
      currentTrack: current,
      upcoming: [track(200)],
    },
  };
}

async function temporaryDirectory(t, prefix = 'sonuvi-saved-qobuz-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.chmod(directory, 0o700).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('named Qobuz queue service captures the authoritative queue and delegates identity operations', async () => {
  const calls = [];
  const record = { savedQueueId: 'sq_fixture', title: 'Fixture Queue' };
  const store = {
    captureAndSave: async (input) => { calls.push(['captureAndSave', input]); return record; },
    list: async () => { calls.push(['list']); return [record]; },
    load: async (savedQueueId) => { calls.push(['load', savedQueueId]); return record; },
    rename: async (input) => { calls.push(['rename', input]); return { ...record, title: input.title }; },
    remove: async (input) => { calls.push(['remove', input]); return { savedQueueId: input.savedQueueId, deleted: true }; },
  };
  const snapshots = [];
  const service = createNamedQobuzQueueService({
    store,
    getQobuzSnapshot: async (input) => { snapshots.push(input); return authoritativeSnapshot(); },
  });

  assert.equal(await service.capture({
    title: 'Fixture Queue',
    capturedAt: '2026-10-24T12:00:00.000Z',
    snapshotId: 'fixture-snapshot',
  }), record);
  assert.deepEqual(snapshots, [{ includeQueue: true }]);
  assert.equal(calls[0][0], 'captureAndSave');
  assert.equal(calls[0][1].title, 'Fixture Queue');
  assert.equal(calls[0][1].snapshotId, 'fixture-snapshot');
  assert.deepEqual(calls[0][1].adapterSnapshot, authoritativeSnapshot());

  assert.deepEqual(await service.list(), [record]);
  assert.equal(await service.load('sq_fixture'), record);
  assert.deepEqual(await service.rename({ savedQueueId: 'sq_fixture', title: 'Renamed' }), {
    ...record,
    title: 'Renamed',
  });
  assert.deepEqual(await service.delete({ savedQueueId: 'sq_fixture' }), {
    savedQueueId: 'sq_fixture',
    deleted: true,
  });
  assert.deepEqual(await service.remove({ savedQueueId: 'sq_fixture' }), {
    savedQueueId: 'sq_fixture',
    deleted: true,
  });
});

test('named Qobuz queue service requires explicit safe dependencies', () => {
  assert.throws(() => createNamedQobuzQueueService({ getQobuzSnapshot: async () => ({}) }), /persistence store/);
  assert.throws(() => createNamedQobuzQueueService({ store: { captureAndSave() {} } }), /snapshot reader/);
});

test('saved Qobuz queue store persists an atomic, identity-preserving record', async (t) => {
  const directory = await temporaryDirectory(t);
  let now = Date.parse('2026-10-24T12:00:00.000Z');
  const store = createSavedQobuzQueueStore({
    directory,
    now: () => now,
    idFactory: () => 'fixture',
  });
  const record = await store.captureAndSave({
    title: 'Fixture Queue',
    adapterSnapshot: authoritativeSnapshot(),
    capturedAt: '2026-10-24T12:00:00.000Z',
    snapshotId: 'fixture-snapshot',
  });
  const filePath = path.join(directory, 'sq_fixture.json');
  const serialized = await fs.readFile(filePath, 'utf8');

  assert.equal(record.savedQueueId, 'sq_fixture');
  assert.deepEqual(deserializeSavedQobuzQueueRecord(serialized), record);
  assert.deepEqual(await store.load('sq_fixture'), record);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.endsWith('.tmp')), false);
  assert.deepEqual((await store.list()).map((entry) => entry.savedQueueId), ['sq_fixture']);

  now = Date.parse('2026-10-24T12:01:00.000Z');
  const renamed = await store.rename({ savedQueueId: 'sq_fixture', title: 'Renamed Fixture Queue' });
  assert.equal(renamed.savedQueueId, record.savedQueueId);
  assert.equal(renamed.createdAt, record.createdAt);
  assert.notEqual(renamed.updatedAt, record.updatedAt);
  assert.deepEqual(renamed.snapshot, record.snapshot);
  assert.deepEqual(await store.remove({ savedQueueId: 'sq_fixture' }), {
    savedQueueId: 'sq_fixture',
    deleted: true,
  });
});

test('saved Qobuz queue store keeps missing and corrupt state fail-closed', async (t) => {
  const root = await temporaryDirectory(t);
  const missingDirectory = path.join(root, 'missing');
  const emptyStore = createSavedQobuzQueueStore({ directory: missingDirectory });
  assert.deepEqual(await emptyStore.list(), []);
  await assert.rejects(emptyStore.load('sq_missing'), { code: 'SAVED_QOBUZ_QUEUE_NOT_FOUND' });
  await assert.rejects(fs.access(missingDirectory));

  const corruptDirectory = path.join(root, 'corrupt');
  await fs.mkdir(corruptDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(corruptDirectory, 'sq_corrupt.json'), '{not json', { mode: 0o600 });
  const corruptStore = createSavedQobuzQueueStore({ directory: corruptDirectory });
  await assert.rejects(corruptStore.list(), /not valid JSON/);
});

test('saved Qobuz queue store does not silently use an unusable state path', async (t) => {
  const root = await temporaryDirectory(t);
  const blockedPath = path.join(root, 'not-a-directory');
  await fs.writeFile(blockedPath, 'fixture', { mode: 0o600 });
  const store = createSavedQobuzQueueStore({ directory: blockedPath, idFactory: () => 'fixture' });

  await assert.rejects(
    store.captureAndSave({
      title: 'Fixture Queue',
      adapterSnapshot: authoritativeSnapshot(),
      capturedAt: '2026-10-24T12:00:00.000Z',
      snapshotId: 'fixture-snapshot',
    }),
    (error) => ['EEXIST', 'ENOTDIR'].includes(error?.code),
  );
});

test('saved Qobuz queue store restores its owned state directory before an atomic write', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.chmod(directory, 0o500);
  const store = createSavedQobuzQueueStore({ directory, idFactory: () => 'fixture' });
  const record = await store.captureAndSave({
    title: 'Fixture Queue',
    adapterSnapshot: authoritativeSnapshot(),
    capturedAt: '2026-10-24T12:00:00.000Z',
    snapshotId: 'fixture-snapshot',
  });

  assert.equal(record.savedQueueId, 'sq_fixture');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});
