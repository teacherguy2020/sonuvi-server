import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configModuleUrl = pathToFileURL(path.join(repositoryRoot, 'src/config.mjs')).href;

async function loadConfigInChild(env, { cwd = repositoryRoot } = {}) {
  const program = [
    'const config = await import(process.argv[1]);',
    'process.stdout.write(JSON.stringify({',
    '  trackCache: config.TRACK_CACHE_DIR,',
    '  mobileTrackCache: config.MOBILE_TRACK_CACHE_DIR,',
    '  artCache: config.ART_CACHE_DIR,',
    '  mobileVideoCatalog: config.MOBILE_VIDEO_CATALOG_PATH,',
    '  podcastLog: config.PODCAST_DL_LOG,',
    '  mobilePushTokens: config.MOBILE_PUSH_TOKENS_PATH,',
    '}));',
  ].join('\n');
  return execFile(process.execPath, ['--input-type=module', '-e', program, configModuleUrl], {
    cwd,
    env: { ...process.env, ...env },
  });
}

function configFixture(overrides = {}) {
  return {
    nodes: [{ name: 'api', ip: '127.0.0.1', role: 'api' }],
    ports: { api: 3101, ui: 8101 },
    alexa: { enabled: false },
    runtime: { trackCacheDir: 'runtime-tracks', artCacheDir: 'runtime-art' },
    notifications: { apns: { tokensPath: 'tokens/mobile.json' } },
    ...overrides,
  };
}

test('immutable config redirects legacy-relative writable overrides into shared state', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-state-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const releaseRoot = path.join(temporary, 'release');
  const sharedRoot = path.join(temporary, 'shared');
  const configPath = path.join(temporary, 'config.json');
  await fs.mkdir(releaseRoot);
  await fs.writeFile(configPath, JSON.stringify(configFixture()), 'utf8');

  const { stdout } = await loadConfigInChild({
    NOW_PLAYING_CONFIG_PATH: configPath,
    SONUVI_STATE_ROOT: sharedRoot,
    MOBILE_TRACK_CACHE_DIR: 'mobile-track-cache',
    MOBILE_VIDEO_CATALOG_PATH: 'catalog/mobile.json',
    PODCAST_DL_LOG: 'podcasts/download-log.ndjson',
  }, { cwd: releaseRoot });
  const paths = JSON.parse(stdout);
  assert.equal(paths.trackCache, path.join(sharedRoot, 'cache', 'runtime-tracks'));
  assert.equal(paths.mobileTrackCache, path.join(sharedRoot, 'cache', 'mobile-track-cache'));
  assert.equal(paths.artCache, path.join(sharedRoot, 'cache', 'runtime-art'));
  assert.equal(paths.mobileVideoCatalog, path.join(sharedRoot, 'data', 'catalog', 'mobile.json'));
  assert.equal(paths.podcastLog, path.join(sharedRoot, 'cache', 'podcasts', 'download-log.ndjson'));
  assert.equal(paths.mobilePushTokens, path.join(sharedRoot, 'protected', 'tokens', 'mobile.json'));
  for (const value of Object.values(paths)) {
    assert.equal(value === releaseRoot || value.startsWith(`${releaseRoot}${path.sep}`), false);
  }
});

test('immutable config rejects relative writable overrides that escape shared state', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-escape-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const configPath = path.join(temporary, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(configFixture({ runtime: { trackCacheDir: '../escape' } })), 'utf8');

  await assert.rejects(
    loadConfigInChild({
      NOW_PLAYING_CONFIG_PATH: configPath,
      SONUVI_STATE_ROOT: path.join(temporary, 'shared'),
    }),
    /runtime\.trackCacheDir escapes its approved root/,
  );
});
