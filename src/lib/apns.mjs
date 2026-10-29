import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const PRODUCTION_AUTHORITY = 'https://api.push.apple.com';
const DEVELOPMENT_AUTHORITY = 'https://api.sandbox.push.apple.com';
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;

function text(value) {
  return String(value || '').trim();
}

function normalizeEnvironment(value) {
  const environment = text(value).toLowerCase();
  return environment === 'development' || environment === 'production' || environment === 'auto'
    ? environment
    : 'auto';
}

function encodeJSON(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createApnsJwt({ keyId, teamId, privateKey, nowMs = Date.now() } = {}) {
  const normalizedKeyId = text(keyId);
  const normalizedTeamId = text(teamId);
  const key = text(privateKey).replace(/\\n/g, '\n');
  if (!normalizedKeyId || !normalizedTeamId || !key) {
    throw new Error('APNs provider credentials are incomplete');
  }

  const header = encodeJSON({ alg: 'ES256', kid: normalizedKeyId });
  const payload = encodeJSON({ iss: normalizedTeamId, iat: Math.floor(Number(nowMs) / 1000) });
  const signed = `${header}.${payload}`;
  const signer = crypto.createSign('SHA256');
  signer.update(signed);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${signed}.${signature}`;
}

function parseApnsReason(body) {
  try {
    const parsed = JSON.parse(String(body || '{}'));
    return text(parsed?.reason) || '';
  } catch {
    return '';
  }
}

function defaultEnvironmentFor(configuredEnvironment, requestedEnvironment) {
  const requested = normalizeEnvironment(requestedEnvironment);
  if (requested !== 'auto') return requested;
  return configuredEnvironment === 'auto' ? 'production' : configuredEnvironment;
}

function apnsAuthority(environment) {
  return environment === 'development'
    ? DEVELOPMENT_AUTHORITY
    : PRODUCTION_AUTHORITY;
}

function requestOverHttp2({ authority, requestPath, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let client;
    let request;
    let status = 0;
    let responseHeaders = {};
    let responseBody = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { client?.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      try { client?.destroy(); } catch {}
      finish(new Error('APNs request timed out'));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    try {
      client = http2.connect(authority);
      client.once('error', (error) => finish(error));
      request = client.request({
        ':method': 'POST',
        ':path': requestPath,
        ...headers,
      });
      request.setEncoding('utf8');
      request.on('response', (headers) => {
        status = Number(headers[':status'] || 0);
        responseHeaders = { ...headers };
      });
      request.on('data', (chunk) => {
        responseBody += String(chunk || '');
      });
      request.once('error', (error) => finish(error));
      request.once('end', () => finish(null, { status, body: responseBody, headers: responseHeaders }));
      request.end(body);
    } catch (error) {
      finish(error);
    }
  });
}

export function createApnsProvider({
  keyId = '',
  teamId = '',
  privateKey = '',
  privateKeyPath = '',
  topic = '',
  environment = 'auto',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request = requestOverHttp2,
  capabilities = runtimeCapabilities(),
} = {}) {
  const normalizedKeyId = text(keyId);
  const normalizedTeamId = text(teamId);
  const normalizedTopic = text(topic);
  const configuredEnvironment = normalizeEnvironment(environment);
  let privateKeyPromise;
  let cachedJwt = '';
  let cachedJwtAt = 0;

  const loadPrivateKey = async () => {
    if (privateKeyPromise) return privateKeyPromise;
    privateKeyPromise = (async () => {
      const inline = text(privateKey).replace(/\\n/g, '\n');
      if (inline) return inline;
      const filePath = text(privateKeyPath);
      if (!filePath) return '';
      return String(await fs.readFile(filePath, 'utf8')).trim();
    })();
    return privateKeyPromise;
  };

  const isConfigured = () => Boolean(
    normalizedKeyId
    && normalizedTeamId
    && normalizedTopic
    && (text(privateKey) || text(privateKeyPath))
  );

  const authorizationToken = async () => {
    const now = Date.now();
    if (cachedJwt && now - cachedJwtAt < JWT_TTL_MS) return cachedJwt;
    const key = await loadPrivateKey();
    cachedJwt = createApnsJwt({
      keyId: normalizedKeyId,
      teamId: normalizedTeamId,
      privateKey: key,
      nowMs: now,
    });
    cachedJwtAt = now;
    return cachedJwt;
  };

  return {
    topic: normalizedTopic,
    environment: configuredEnvironment,
    isConfigured,

    async send({ deviceToken, payload, environment: requestedEnvironment, collapseId = 'sonuvi-current-track' } = {}) {
      if (!isConfigured()) {
        return { ok: false, status: 0, reason: 'provider-not-configured', invalidToken: false };
      }
      const token = text(deviceToken).toLowerCase();
      if (!/^[a-f0-9]{32,512}$/.test(token)) {
        return { ok: false, status: 400, reason: 'BadDeviceToken', invalidToken: true };
      }

      capabilities.assertExternalMutation('push.apns');
      const targetEnvironment = defaultEnvironmentFor(configuredEnvironment, requestedEnvironment);
      const jwt = await authorizationToken();
      const result = await request({
        authority: apnsAuthority(targetEnvironment),
        requestPath: `/3/device/${encodeURIComponent(token)}`,
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': normalizedTopic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': text(collapseId) || 'sonuvi-current-track',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload || {}),
        timeoutMs,
      });
      const reason = parseApnsReason(result?.body);
      const status = Number(result?.status || 0);
      const invalidToken = status === 410
        || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
      return {
        ok: status === 200,
        status,
        reason,
        apnsId: text(result?.headers?.['apns-id']),
        invalidToken,
      };
    },
  };
}
