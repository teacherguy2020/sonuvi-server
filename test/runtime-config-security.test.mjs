import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, loadConfigOrNull } from '../src/config/load-config.mjs';
import { loadProtectedLastfmEnvironment } from '../src/lib/protected-runtime-secrets.mjs';
import { createRuntimeStatePaths } from '../src/lib/runtime-state-paths.mjs';

function baseConfig(extra = {}) {
  return {
    nodes: [{ name: 'api', ip: '127.0.0.1', role: 'api' }],
    ports: { api: 3101, ui: 8101 },
    alexa: { enabled: false },
    ...extra,
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('immutable state resolves Last.fm only beneath the root-managed secrets root', () => {
  const release = '/opt/sonuvi/releases/candidate';
  const shared = '/opt/sonuvi/shared';
  const paths = createRuntimeStatePaths({ cwd: release, env: { SONUVI_STATE_ROOT: shared } });
  assert.equal(paths.lastfmEnvPath, '/etc/sonuvi/lastfm.env');

  const custom = createRuntimeStatePaths({
    cwd: release,
    env: {
      SONUVI_STATE_ROOT: shared,
      SONUVI_SECRETS_ROOT: '/private/sonuvi',
      LASTFM_ENV_FILE: '/private/sonuvi/lastfm.env',
    },
  });
  assert.equal(custom.lastfmEnvPath, '/private/sonuvi/lastfm.env');

  assert.throws(
    () => createRuntimeStatePaths({
      cwd: release,
      env: { SONUVI_STATE_ROOT: shared, LASTFM_ENV_FILE: 'lastfm.env' },
    }),
    /LASTFM_ENV_FILE must be an absolute path/,
  );
  assert.throws(
    () => createRuntimeStatePaths({
      cwd: release,
      env: { SONUVI_STATE_ROOT: shared, LASTFM_ENV_FILE: '/tmp/lastfm.env' },
    }),
    /LASTFM_ENV_FILE must remain beneath SONUVI_SECRETS_ROOT/,
  );
});

test('immutable config rejects secret-bearing fields without disclosing values', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-security-'));
  const configPath = path.join(directory, 'now-playing.config.json');
  await fs.writeFile(configPath, JSON.stringify(baseConfig({
    lastfm: { apiKey: 'test-only-value' },
    notifications: { pushover: { token: 'test-only-value' } },
  })), 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  process.env.SONUVI_STATE_ROOT = path.join(directory, 'shared');
  try {
    assert.throws(
      () => loadConfig(configPath),
      (error) => {
        assert.match(String(error?.message || ''), /lastfm\.apiKey/);
        assert.match(String(error?.message || ''), /notifications\.pushover\.token/);
        assert.equal(String(error?.message || '').includes('test-only-value'), false);
        return true;
      },
    );
  } finally {
    restoreEnvironment('SONUVI_STATE_ROOT', previousStateRoot);
  }
});

test('immutable startup fails closed for a secret-bearing mutable config while legacy loading stays compatible', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-startup-'));
  const configPath = path.join(directory, 'now-playing.config.json');
  const config = baseConfig({ lastfm: { sessionKey: 'test-only-session' } });
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  process.env.SONUVI_STATE_ROOT = path.join(directory, 'shared');
  try {
    assert.throws(
      () => loadConfigOrNull(configPath),
      (error) => {
        assert.equal(error?.name, 'SecretConfigFieldError');
        assert.match(String(error?.message || ''), /lastfm\.sessionKey/);
        assert.equal(String(error?.message || '').includes('test-only-session'), false);
        return true;
      },
    );
  } finally {
    restoreEnvironment('SONUVI_STATE_ROOT', previousStateRoot);
  }

  assert.deepEqual(loadConfigOrNull(configPath), config);
});

test('immutable config accepts only the explicit non-secret allowlist', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-schema-'));
  const configPath = path.join(directory, 'now-playing.config.json');
  const allowed = baseConfig({
    deployment: { sourceOfTruthNode: 'api', syncMethod: 'scp' },
    features: { mpdscribbleControl: true },
    alexa: {
      enabled: false,
      heardAlbums: [{ album: 'Example Album', key: 'example album', source: 'alexa', status: 'resolved', resolvedTo: 'Example Album', at: '2026-10-28T00:00:00.000Z' }],
      heardPlaylists: [{ playlist: 'Example Playlist', key: 'example playlist', source: 'alexa', status: 'resolved', resolvedTo: 'Example Playlist', at: '2026-10-28T00:00:00.000Z' }],
    },
    paths: { musicLibraryRoot: '/music', podcastRoot: '/music/Podcasts' },
    runtime: { trackCacheDir: 'tracks', artCacheDir: 'art', artCacheLimit: 100 },
    notifications: { trackNotify: { enabled: false }, pushover: {}, apns: { topic: 'com.example.sonuvi' } },
    lastfm: { username: 'listener', recentsMode: 'toptracks', period: '1month' },
  });
  await fs.writeFile(configPath, JSON.stringify(allowed), 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const previousStateRoot = process.env.SONUVI_STATE_ROOT;
  process.env.SONUVI_STATE_ROOT = path.join(directory, 'shared');
  try {
    assert.deepEqual(loadConfig(configPath), allowed);
    const sentinel = 'must-not-appear';
    await fs.writeFile(configPath, JSON.stringify({
      ...allowed,
      runtime: { ...allowed.runtime, unexpectedSetting: sentinel },
      nodes: [{ ...allowed.nodes[0], unexpectedNodeSetting: sentinel }],
    }), 'utf8');
    assert.throws(
      () => loadConfig(configPath),
      (error) => {
        assert.equal(error?.name, 'ImmutableConfigSchemaError');
        assert.match(String(error?.message || ''), /runtime\.unexpectedSetting/);
        assert.match(String(error?.message || ''), /nodes\[0\]\.unexpectedNodeSetting/);
        assert.equal(String(error?.message || '').includes(sentinel), false);
        return true;
      },
    );
  } finally {
    restoreEnvironment('SONUVI_STATE_ROOT', previousStateRoot);
  }
});

test('protected Last.fm loader honors environment precedence and never reads mutable config', () => {
  let readPath = '';
  const values = loadProtectedLastfmEnvironment({
    statePaths: {
      sharedStateEnabled: true,
      lastfmEnvPath: '/etc/sonuvi/lastfm.env',
    },
    env: { LASTFM_API_KEY: 'environment-value' },
    readFileSync(filePath) {
      readPath = filePath;
      return 'LASTFM_API_KEY=file-value\nLASTFM_API_SECRET=secret-value\nLASTFM_SESSION_KEY=session-value\n';
    },
  });

  assert.equal(readPath, '/etc/sonuvi/lastfm.env');
  assert.equal(values.LASTFM_API_KEY, 'environment-value');
  assert.equal(values.LASTFM_API_SECRET, 'secret-value');
  assert.equal(values.LASTFM_SESSION_KEY, 'session-value');
});
