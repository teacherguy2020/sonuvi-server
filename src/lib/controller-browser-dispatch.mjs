import crypto from 'node:crypto';
import { readBearerToken, verifyMobileToken } from './mobile-auth.mjs';

const MAX_AGE_MS = 30_000;
const reads = new Map(Object.entries({
  '/now-playing': ['_','t'], '/next-up': ['_','t'],
  '/config/runtime': [], '/config/controller-profile': [], '/config/browse/stats': [],
  '/config/browse/artists': ['q','limit','offset'], '/config/browse/albums': ['q','artist','limit'],
  '/config/browse/artist-albums': ['artist'], '/config/browse/album-tracks': ['artist','album'],
  '/config/queue-wizard/options': [], '/config/queue-wizard/playlists': [],
  '/config/queue-wizard/radio-favorites': [], '/config/queue-wizard/radio-options': [],
  '/recent/albums': ['limit'], '/recent/playlists': ['limit'], '/recent/podcasts': ['limit'],
  '/recent/radio-favorites': ['limit'], '/podcasts': [],
  '/art/current.jpg': ['v','_','t'], '/art/current_bg_640_blur.jpg': ['v','_','t'],
  '/art/track_640.jpg': ['file','v','_','t'], '/art/radio-logo.jpg': ['name','file','v','_','t'],
}));
export const isLoopbackAddress = (value) => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(String(value));
export function isControllerDispatchable({ method = 'GET', pathname = '' } = {}) {
  return method.toUpperCase() === 'GET' && reads.has(pathname);
}
export function validControllerTarget(target) {
  try {
    const url = new URL(target, 'http://controller.invalid');
    if (!target.startsWith('/') || target.startsWith('//') || url.origin !== 'http://controller.invalid' || url.hash || !reads.has(url.pathname)) return false;
    const seen = new Set();
    for (const [key,value] of url.searchParams) {
      if (seen.has(key) || !reads.get(url.pathname).includes(key) || value.length > 2048 || /[\x00-\x1f\\]/.test(value)) return false;
      seen.add(key);
      if (['limit','offset'].includes(key) && (!/^\d+$/.test(value) || Number(value) > 10000)) return false;
      if (key === 'file' && (value.startsWith('/') || value.split('/').some(v => v === '..' || v === '.'))) return false;
      if (url.pathname === '/art/track_640.jpg' && key === 'file' && /^[a-z][\w+.-]*:/i.test(value)) return false;
    }
    return true;
  } catch { return false; }
}
const material = (method, target, timestamp, nonce) => `${method.toUpperCase()}\n${target}\n${timestamp}\n${nonce}`;
export function controllerDispatchHeader({ secret, method = 'GET', pathname, target = pathname, now = Date.now(), nonce = crypto.randomBytes(18).toString('base64url') } = {}) {
  if (!secret) return '';
  const timestamp = String(Math.floor(now));
  const mac = crypto.createHmac('sha256', secret).update(material(method,target,timestamp,nonce)).digest('base64url');
  return `${timestamp}.${nonce}.${mac}`;
}
export function verifyControllerDispatch({ secret, header = '', method = 'GET', pathname, target = pathname, now = Date.now() } = {}) {
  const [timestamp,nonce,mac,...extra] = String(header).split('.');
  if (!secret || extra.length || !/^\d{10,14}$/.test(timestamp) || !/^[\w-]{24}$/.test(nonce || '') || !/^[\w-]{43}$/.test(mac || '') || Math.abs(now-Number(timestamp)) > MAX_AGE_MS) return false;
  const expected = controllerDispatchHeader({secret,method,target,now:Number(timestamp),nonce}).split('.')[2];
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
/** Per-process bounded replay protection, plus actual socket and query validation. */
export function createControllerDispatchAuthorizer({ secret, apiSecret } = {}) {
  const used = new Map();
  return (req) => {
    const target = req.originalUrl || req.url || req.path;
    const now = Date.now();
    for (const [key,expires] of used) if (expires < now) used.delete(key);
    const header = String(req.headers?.['x-sonuvi-controller-dispatch'] || '');
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isControllerDispatchable({method:req.method,pathname:req.path || target?.split('?')[0]}) || !validControllerTarget(target)) return false;
    // Fresh installations reuse the existing paired-controller grant; no additional
    // shared secret or administrator credential has to be provisioned to the web service.
    if (header === 'mobile-session') return Boolean(verifyMobileToken(readBearerToken(req), { secret: apiSecret, scope: 'mobile-api', now }));
    if (used.has(header) || used.size >= 10000 || !verifyControllerDispatch({secret,header,method:req.method,target,now})) return false;
    used.set(header, now+MAX_AGE_MS); return true;
  };
}
