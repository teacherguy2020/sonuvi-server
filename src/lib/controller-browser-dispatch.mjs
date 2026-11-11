import crypto from 'node:crypto';

const MAX_AGE_MS = 30_000;
function text(value) { return String(value || '').trim(); }
function material({ method, pathname, timestamp }) { return `${String(method || 'GET').toUpperCase()}\n${String(pathname || '')}\n${String(timestamp || '')}`; }

export function controllerDispatchHeader({ secret, method, pathname, now = Date.now() } = {}) {
  const key = text(secret);
  if (!key) return '';
  const timestamp = String(Math.floor(Number(now)));
  const mac = crypto.createHmac('sha256', key).update(material({ method, pathname, timestamp })).digest('base64url');
  return `${timestamp}.${mac}`;
}

/** A loopback-only capability. It is never a browser credential or a Track Key. */
export function verifyControllerDispatch({ secret, header, method, pathname, now = Date.now() } = {}) {
  const key = text(secret);
  const [timestamp, supplied] = text(header).split('.', 2);
  if (!key || !/^\d{10,14}$/.test(timestamp) || !/^[A-Za-z0-9_-]{40,}$/.test(supplied || '')) return false;
  if (Math.abs(Number(now) - Number(timestamp)) > MAX_AGE_MS) return false;
  const expected = controllerDispatchHeader({ secret: key, method, pathname, now: Number(timestamp) });
  const expectedMac = expected.split('.', 2)[1];
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedMac);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isControllerDispatchable({ method, pathname } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  const path = String(pathname || '');
  if (verb !== 'GET') return false;
  return new Set([
    '/now-playing', '/next-up',
    '/config/browse/artists', '/config/browse/albums', '/config/browse/artist-albums', '/config/browse/album-tracks',
    '/config/library-health/albums', '/config/queue-wizard/playlists', '/config/queue-wizard/radio-favorites',
    '/recent/albums', '/recent/playlists', '/recent/podcasts', '/recent/radio-favorites', '/podcasts',
  ]).has(path) || /^\/art\/(?:current(?:_bg_640_blur)?\.jpg|track_640\.jpg|radio-logo\.jpg)$/.test(path);
}
