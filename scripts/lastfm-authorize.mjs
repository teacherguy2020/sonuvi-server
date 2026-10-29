#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { runtimeStatePaths } from '../src/lib/runtime-state-paths.mjs';

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_ENDPOINT = 'https://www.last.fm/api/auth/';

function text(value) {
  return String(value ?? '').trim();
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

export function lastfmApiSignature(params, apiSecret) {
  const body = Object.entries(params)
    .filter(([key]) => key !== 'format' && key !== 'api_sig')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + String(value ?? ''))
    .join('');
  return md5(body + text(apiSecret));
}

export function lastfmAuthorizationUrl(apiKey, token = '') {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('api_key', text(apiKey));
  if (text(token)) url.searchParams.set('token', text(token));
  return url.toString();
}

export async function requestLastfmToken({ apiKey, apiSecret, fetchImpl = globalThis.fetch } = {}) {
  const params = {
    api_key: text(apiKey),
    method: 'auth.getToken',
  };
  params.api_sig = lastfmApiSignature(params, apiSecret);
  params.format = 'json';
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error || !text(body?.token)) {
    throw new Error(text(body?.message) || 'Last.fm token request failed (HTTP ' + response.status + ')');
  }
  return text(body.token);
}

export async function exchangeLastfmToken({ apiKey, apiSecret, token, fetchImpl = globalThis.fetch } = {}) {
  const params = {
    api_key: text(apiKey),
    method: 'auth.getSession',
    token: text(token),
  };
  params.api_sig = lastfmApiSignature(params, apiSecret);
  params.format = 'json';
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error || !text(body?.session?.key)) {
    throw new Error(text(body?.message) || 'Last.fm authorization failed (HTTP ' + response.status + ')');
  }
  return {
    sessionKey: text(body.session.key),
    username: text(body.session.name),
  };
}

async function readEnvValue(envPath, key, env = process.env) {
  if (text(env?.[key])) return text(env[key]);
  const raw = await fs.readFile(envPath, 'utf8').catch(() => '');
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith(key + '='));
  return text(line ? line.slice(key.length + 1) : '');
}

export function resolveLastfmEnvPath({ envPath, cwd = process.cwd(), env = process.env } = {}) {
  const statePaths = runtimeStatePaths({ cwd, env });
  const explicit = text(envPath);
  if (explicit && !statePaths.sharedStateEnabled) return explicit;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('Last.fm authorization path must be an absolute path beneath SONUVI_SECRETS_ROOT');
    }
    const resolved = path.resolve(explicit);
    const relative = path.relative(statePaths.secretsRoot, resolved);
    if (relative === '..' || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
      throw new Error('Last.fm authorization path must remain beneath SONUVI_SECRETS_ROOT');
    }
    return resolved;
  }
  // runtime-state-paths preserves legacy checkout behavior when shared roots
  // are unset, while requiring immutable overrides to remain beneath the
  // external root-managed secrets root.
  return statePaths.lastfmEnvPath;
}

export async function resolveLastfmCredentials({ envPath, cwd, env = process.env } = {}) {
  const resolvedEnvPath = resolveLastfmEnvPath({ envPath, cwd, env });
  const apiKey = await readEnvValue(resolvedEnvPath, 'LASTFM_API_KEY', env);
  const apiSecret = await readEnvValue(resolvedEnvPath, 'LASTFM_API_SECRET', env);
  return { apiKey, apiSecret, envPath: resolvedEnvPath };
}

async function writeEnvValue(envPath, key, value) {
  const existing = await fs.readFile(envPath, 'utf8').catch(() => '');
  const line = key + '=' + value;
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : existing + (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n';
  const temporary = envPath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, envPath);
  await fs.chmod(envPath, 0o600);
}

async function main() {
  const credentials = await resolveLastfmCredentials();
  const { apiKey, apiSecret, envPath } = credentials;
  if (!apiKey || !apiSecret) {
    throw new Error('LASTFM_API_KEY and LASTFM_API_SECRET must be supplied in the server environment file; they are never read from Vibe config or command-line arguments');
  }

  const rl = readline.createInterface({ input, output });
  try {
    const token = await requestLastfmToken({ apiKey, apiSecret });
    output.write('Open this URL and authorize the existing Last.fm application, then return here.\n' + lastfmAuthorizationUrl(apiKey, token) + '\n');
    await rl.question('Press Enter after authorization: ');
    const session = await exchangeLastfmToken({ apiKey, apiSecret, token });
    await writeEnvValue(envPath, 'LASTFM_SESSION_KEY', session.sessionKey);
    console.log('Last.fm session key stored in ' + envPath + ' for ' + (session.username || 'the authorized account') + '.');
  } finally {
    rl.close();
  }
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
