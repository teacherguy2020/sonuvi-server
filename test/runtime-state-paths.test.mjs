import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import { createRuntimeStatePaths, resolveWithin } from '../src/lib/runtime-state-paths.mjs';
import { writeJsonAtomically } from '../src/lib/atomic-file.mjs';

test('runtime state paths preserve legacy checkout locations by default', () => {
  const cwd = path.join(path.sep, 'opt', 'now-playing');
  const paths = createRuntimeStatePaths({ cwd, env: {} });

  assert.equal(paths.sharedStateEnabled, false);
  assert.equal(paths.configPath, path.join(cwd, 'config', 'now-playing.config.json'));
  assert.equal(paths.browseIndexPath, path.join(cwd, 'data', 'library-browse-index.json'));
  assert.equal(paths.sourceAudioCachePath, path.join(cwd, 'var', 'mobile-source-audio.json'));
  assert.equal(paths.mobileVideoCatalogPath, path.join(cwd, 'var', 'mobile-video-catalog.json'));
  assert.equal(paths.mobilePushTokensPath, path.join(cwd, 'var', 'mobile-push-tokens.json'));
  assert.equal(paths.listeningHistoryPath, path.join(cwd, 'data', 'listening-history.jsonl'));
  assert.equal(paths.controllerProfilePath, path.join(cwd, 'data', 'controller-profile.json'));
  assert.equal(paths.libraryThumbsDir, path.join(cwd, '.cache', 'library-thumbs'));
  assert.equal(paths.lastfmEnvPath, path.join(cwd, '.env'));
  assert.equal(paths.savedQobuzQueueDir, '/var/lib/sonuvi/saved-qobuz-queues');
});

test('shared state roots isolate defaults from immutable releases', () => {
  const release = path.join(path.sep, 'opt', 'sonuvi', 'releases', 'candidate');
  const shared = path.join(path.sep, 'opt', 'sonuvi', 'shared');
  const paths = createRuntimeStatePaths({
    cwd: release,
    env: { SONUVI_STATE_ROOT: shared },
  });

  assert.equal(paths.sharedStateEnabled, true);
  assert.equal(paths.configPath, path.join(shared, 'config', 'now-playing.config.json'));
  assert.equal(paths.secretsRoot, '/etc/sonuvi');
  assert.equal(paths.lastfmEnvPath, '/etc/sonuvi/lastfm.env');
  assert.equal(paths.browseIndexPath, path.join(shared, 'data', 'library-browse-index.json'));
  assert.equal(paths.sourceAudioCachePath, path.join(shared, 'data', 'source-audio-cache.json'));
  assert.equal(paths.audioQualityCheckpointPath, path.join(shared, 'data', 'audio-quality-checkpoint.json'));
  assert.equal(paths.vibeLibraryIndexPath, path.join(shared, 'data', 'moode-library-index.json'));
  assert.equal(paths.artCacheDir, path.join(shared, 'cache', 'art'));
  assert.equal(paths.radioLogoCacheDir, path.join(shared, 'cache', 'radio-logo-cache'));
  assert.equal(paths.peppyExportDir, path.join(shared, 'cache', 'exports', 'peppymeter', '1280x400'));
  assert.equal(paths.podcastMapDir, path.join(shared, 'cache', 'podcasts', 'maps'));
  assert.equal(paths.mobilePushTokensPath, path.join(shared, 'protected', 'mobile-push-tokens.json'));
  assert.equal(paths.savedQobuzQueueDir, path.join(shared, 'protected', 'saved-qobuz-queues'));
  assert.equal(paths.vibeLogDir, path.join(shared, 'logs', 'vibe'));
  assert.equal(paths.vibePythonLogPath, path.join(shared, 'logs', 'vibe', 'lastfm-vibe-radio.log'));

  const writableStatePaths = [
    'configPath', 'lastfmEnvPath',
    'browseIndexPath', 'sourceAudioCachePath', 'audioQualityCatalogPath', 'audioQualityCheckpointPath',
    'listeningHistoryPath', 'listeningHistoryStatePath', 'controllerProfilePath', 'playlistIndexPath',
    'radioQueuePresetsPath', 'radioQueueMapPath', 'endlessVibePath', 'vibeLibraryIndexPath',
    'jukeboxStatePath', 'peppyLastPushPath', 'animatedArtCachePath', 'animatedArtDiscoveryPath',
    'animatedArtH264Dir', 'trackCacheDir', 'mobileTrackCacheDir', 'artCacheDir', 'libraryThumbsDir',
    'radioLogoCacheDir', 'peppyExportDir', 'mobileVideoCatalogPath', 'podcastDownloadLogPath',
    'podcastMapDir', 'podcastsNightlyStatePath', 'youtubeHintsPath', 'temporaryDir',
    'mobilePushTokensPath', 'savedQobuzQueueDir', 'vibeLogDir', 'vibePythonLogPath',
  ];
  for (const name of writableStatePaths) {
    const candidate = paths[name];
    assert.equal(typeof candidate, 'string', `${name} must resolve to a path`);
    assert.equal(candidate === release || candidate.startsWith(`${release}${path.sep}`), false, `${name} must not write inside a release`);
  }
});

test('shared state rejects relative traversal while retaining explicit absolute overrides', () => {
  const shared = path.join(path.sep, 'var', 'lib', 'sonuvi');
  assert.throws(
    () => createRuntimeStatePaths({
      cwd: '/opt/sonuvi/releases/candidate',
      env: { SONUVI_STATE_ROOT: shared, BROWSE_INDEX_PATH: '../../escape.json' },
    }),
    /escapes its approved root/,
  );

  const paths = createRuntimeStatePaths({
    cwd: '/opt/sonuvi/releases/candidate',
    env: { SONUVI_STATE_ROOT: shared, BROWSE_INDEX_PATH: '/mnt/catalog/browse.json' },
  });
  assert.equal(paths.browseIndexPath, '/mnt/catalog/browse.json');
  assert.equal(resolveWithin(shared, 'cache/art'), path.join(shared, 'cache', 'art'));
  assert.throws(() => resolveWithin(shared, '../outside'), /escapes its approved root/);
});

test('atomic runtime writes replace a complete record and leave no temporary artifact', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-atomic-state-'));
  const target = path.join(directory, 'state.json');
  try {
    await fs.writeFile(target, '{"version":"old"}\n', 'utf8');
    await writeJsonAtomically(target, { version: 'new', stable: true });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 'new', stable: true });
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes('.tmp')), []);
    await assert.rejects(writeJsonAtomically(directory, { invalid: true }));
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes('.tmp')), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
