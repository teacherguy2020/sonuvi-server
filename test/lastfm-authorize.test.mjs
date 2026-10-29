import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exchangeLastfmToken,
  lastfmApiSignature,
  lastfmAuthorizationUrl,
  requestLastfmToken,
  resolveLastfmCredentials,
  resolveLastfmEnvPath,
} from '../scripts/lastfm-authorize.mjs';

test('authorization URL uses the existing API key without including the secret', () => {
  const url = lastfmAuthorizationUrl('existing-api-key');
  assert.equal(new URL(url).searchParams.get('api_key'), 'existing-api-key');
  assert.equal(url.includes('api-secret'), false);
  assert.equal(lastfmAuthorizationUrl('existing-api-key', 'one-time-token').includes('token=one-time-token'), true);
});

test('Last.fm signature uses sorted raw parameter names and values, then the secret', () => {
  const params = {
    token: 'fixture-token',
    format: 'json',
    api_key: 'fixture-api-key',
    method: 'auth.getSession',
    api_sig: 'ignored-existing-signature',
  };

  assert.equal(
    lastfmApiSignature(params, 'fixture-secret'),
    '8238af5c9c431cb6381d749efc90ee0f',
  );
});

test('auth.getToken succeeds before the authorization URL is generated', async () => {
  const token = await requestLastfmToken({
    apiKey: 'api-key',
    apiSecret: 'api-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'one-time-token' }),
    }),
  });
  assert.equal(token, 'one-time-token');
});

test('clean authorization resolution loads Sonuvi credentials from .env without Vibe config fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lastfm-auth-'));
  const envPath = path.join(directory, '.env');
  await fs.writeFile(envPath, 'LASTFM_API_KEY=sonuvi-api-key\nLASTFM_API_SECRET=sonuvi-api-secret\n', { mode: 0o600 });
  const previousKey = process.env.LASTFM_API_KEY;
  const previousSecret = process.env.LASTFM_API_SECRET;
  delete process.env.LASTFM_API_KEY;
  delete process.env.LASTFM_API_SECRET;
  try {
    const credentials = await resolveLastfmCredentials({ envPath });
    assert.deepEqual(credentials, {
      apiKey: 'sonuvi-api-key',
      apiSecret: 'sonuvi-api-secret',
      envPath,
    });
    assert.notEqual(credentials.apiKey, 'vibe-config-api-key');
  } finally {
    if (previousKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.LASTFM_API_SECRET;
    else process.env.LASTFM_API_SECRET = previousSecret;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Last.fm authorization follows the root-managed secret boundary in immutable mode', () => {
  const env = {
    SONUVI_STATE_ROOT: '/srv/sonuvi/shared',
    SONUVI_CONFIG_ROOT: '/srv/sonuvi/shared/config',
  };
  assert.equal(
    resolveLastfmEnvPath({ cwd: '/opt/sonuvi/releases/candidate', env }),
    '/etc/sonuvi/lastfm.env',
  );
  assert.equal(
    resolveLastfmEnvPath({
      cwd: '/opt/sonuvi/releases/candidate',
      env: {
        ...env,
        SONUVI_SECRETS_ROOT: '/srv/sonuvi/secrets',
        LASTFM_ENV_FILE: '/srv/sonuvi/secrets/credentials.env',
      },
    }),
    '/srv/sonuvi/secrets/credentials.env',
  );
  assert.throws(
    () => resolveLastfmEnvPath({ cwd: '/opt/sonuvi/releases/candidate', env: { ...env, LASTFM_ENV_FILE: 'credentials.env' } }),
    /LASTFM_ENV_FILE must be an absolute path/,
  );
  assert.throws(
    () => resolveLastfmEnvPath({ cwd: '/opt/sonuvi/releases/candidate', env: { ...env, LASTFM_ENV_FILE: '/tmp/outside.env' } }),
    /LASTFM_ENV_FILE must remain beneath SONUVI_SECRETS_ROOT/,
  );
  assert.equal(
    resolveLastfmEnvPath({
      cwd: '/opt/sonuvi/releases/candidate',
      env: { ...env, SONUVI_SECRETS_ROOT: '/srv/sonuvi/secrets' },
      envPath: '/srv/sonuvi/secrets/alternate-lastfm.env',
    }),
    '/srv/sonuvi/secrets/alternate-lastfm.env',
  );
  assert.throws(
    () => resolveLastfmEnvPath({
      cwd: '/opt/sonuvi/releases/candidate',
      env,
      envPath: '/tmp/outside.env',
    }),
    /Last.fm authorization path must remain beneath SONUVI_SECRETS_ROOT/,
  );
});

test('Last.fm auth signature and token exchange return only the session identity', async () => {
  let request;
  const result = await exchangeLastfmToken({
    apiKey: 'api-key',
    apiSecret: 'api-secret',
    token: 'token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ session: { name: 'brian', key: 'session-key' } }) };
    },
  });
  assert.deepEqual(result, { username: 'brian', sessionKey: 'session-key' });
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('method'), 'auth.getSession');
  assert.equal(body.get('format'), 'json');
  assert.ok(body.get('api_sig'));
  assert.equal(body.get('api_key'), 'api-key');
  assert.equal(body.get('token'), 'token');
  assert.equal(JSON.stringify(request).includes('api-secret'), false);
});
