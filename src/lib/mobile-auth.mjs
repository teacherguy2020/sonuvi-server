import crypto from 'node:crypto';

const TOKEN_VERSION = 1;
const TOKEN_TYPE = 'now-playing-mobile';

function base64urlEncode(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return input.toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function sign(input, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(input)).digest('base64url');
}

export function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSignedToken({ secret, scope, claims = {}, ttlMs, now = Date.now(), persistent = false }) {
  const key = String(secret || '');
  if (!key) throw new Error('mobile token secret is not configured');

  const issuedAt = Math.floor(Number(now) / 1000);
  const expiresAt = persistent ? null : issuedAt + Math.max(1, Math.floor(Number(ttlMs || 0) / 1000));
  const header = { typ: TOKEN_TYPE, v: TOKEN_VERSION, alg: 'HS256' };
  const payload = {
    ...claims,
    scope: String(scope || ''),
    iat: issuedAt,
    ...(persistent ? { persistent: true } : { exp: expiresAt }),
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signed = `${encodedHeader}.${encodedPayload}`;
  return `${signed}.${sign(signed, key)}`;
}

export function createMobileSessionToken({ secret, deviceId, ttlMs = 12 * 60 * 60 * 1000, now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) throw new Error('deviceId is required');
  return createSignedToken({
    secret,
    scope: 'mobile-api',
    claims: { deviceId: normalizedDeviceId },
    ttlMs,
    now,
  });
}

export function createMobileRefreshToken({ secret, deviceId, ttlMs = 365 * 24 * 60 * 60 * 1000, now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) throw new Error('deviceId is required');
  return createSignedToken({
    secret,
    scope: 'mobile-refresh',
    claims: { deviceId: normalizedDeviceId },
    ttlMs,
    now,
  });
}

/** A durable renewal-only replacement for the legacy expiring mobile refresh token. */
export function createPersistentMobileRefreshToken({ secret, deviceId, now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) throw new Error('deviceId is required');
  return createSignedToken({
    secret,
    scope: 'mobile-refresh',
    claims: { deviceId: normalizedDeviceId },
    now,
    persistent: true,
  });
}

/**
 * A durable credential identifies the browser-controller renewal pathway. It
 * is never directly accepted as an API bearer, media ticket, or administrator
 * credential. Like the durable mobile-refresh credential, it can be exchanged
 * at the renewal endpoint for the same short-lived mobile API bearer.
 */
export function createPersistentControllerRefreshToken({ secret, deviceId, now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) throw new Error('deviceId is required');
  return createSignedToken({
    secret,
    scope: 'controller-web-refresh',
    claims: { deviceId: normalizedDeviceId },
    now,
    persistent: true,
  });
}

export function createMobileMediaTicket({ secret, deviceId, trackId, ttlMs = 5 * 60 * 1000, format = 'mp3', now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  const normalizedTrackId = String(trackId || '').trim();
  if (!normalizedDeviceId || !normalizedTrackId) throw new Error('deviceId and trackId are required');
  return createSignedToken({
    secret,
    scope: 'mobile-media',
    claims: {
      deviceId: normalizedDeviceId,
      trackId: normalizedTrackId,
      format: String(format || 'mp3'),
    },
    ttlMs,
    now,
  });
}

export function createMobileRadioTicket({ secret, deviceId, stationId, ttlMs = 30 * 60 * 1000, now } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  const normalizedStationId = String(stationId || '').trim();
  if (!normalizedDeviceId || !normalizedStationId) throw new Error('deviceId and stationId are required');
  return createSignedToken({
    secret,
    scope: 'mobile-radio',
    claims: {
      deviceId: normalizedDeviceId,
      stationId: normalizedStationId,
    },
    ttlMs,
    now,
  });
}

export function readBearerToken(req) {
  const header = String(req?.headers?.authorization || '').trim();
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return String(match?.[1] || '').trim();
}

export function verifyMobileToken(token, { secret, scope, now = Date.now(), allowExpired = false } = {}) {
  const key = String(secret || '');
  const raw = String(token || '').trim();
  if (!key || !raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;

  const signed = `${parts[0]}.${parts[1]}`;
  const expected = sign(signed, key);
  if (!timingSafeEqualText(parts[2], expected)) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]));
    payload = JSON.parse(base64urlDecode(parts[1]));
  } catch {
    return null;
  }

  if (header?.typ !== TOKEN_TYPE || Number(header?.v) !== TOKEN_VERSION || header?.alg !== 'HS256') return null;
  if (scope && payload?.scope !== scope) return null;

  const nowSec = Math.floor(Number(now) / 1000);
  const persistentRefresh = ['mobile-refresh', 'controller-web-refresh'].includes(scope)
    && payload?.scope === scope
    && payload?.persistent === true
    && payload?.exp === undefined;
  const exp = Number(payload?.exp || 0);
  const iat = Number(payload?.iat || 0);
  if (!Number.isFinite(iat) || iat > nowSec + 60) return null;
  if (!persistentRefresh && (!Number.isFinite(exp) || exp <= 0 || (!allowExpired && exp <= nowSec))) return null;

  return payload;
}

export function createMobileTrackId({ secret, trackIdentity } = {}) {
  const key = String(secret || '');
  const identity = String(trackIdentity || '');
  if (!key || !identity) throw new Error('track ID secret and identity are required');
  const digest = crypto.createHmac('sha256', key).update(identity).digest('base64url').slice(0, 32);
  return `trk_${digest}`;
}

/** A short-lived capability for one immutable cached animation, never general API access. */
export function createMobileAnimationTicket({ secret, deviceId, name, ttlMs = 60 * 60 * 1000, now } = {}) {
  if (!deviceId || !/^[a-f0-9]{40}\.mp4$/.test(String(name))) throw new Error('invalid animation ticket');
  return createSignedToken({ secret, scope: 'mobile-animation', claims: { deviceId, name }, ttlMs, now });
}
