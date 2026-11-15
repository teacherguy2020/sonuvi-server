import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { isAuthorizedTrackKey } from './track-key-auth.mjs';

const roles = new Set(['seeburg', 'mills', 'mabel']);
const clean = value => String(value ?? '').trim();
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const privateV4 = value => net.isIP(value) === 4 && (value.startsWith('10.') || value.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(value));
const clientAddress = value => clean(value).replace(/^::ffff:/, '');
const rules = new Map();
function rule(method, path, role, required = {}, optional = {}, query = []) {
  rules.set(`${method} ${path}`, { role, required, optional, query });
}
rule('POST', '/integrations/seeburg/selection', 'seeburg', { number: v => integer(v, 1, 100) }, { dryRun: v => typeof v === 'boolean' });
rule('GET', '/integrations/seeburg/playlist', 'seeburg');
for (const operation of ['start', 'stop']) rule('POST', `/integrations/mills/${operation}`, 'mills');
rule('POST', '/integrations/mills/selection', 'mills', { slot: v => integer(v, 1, 20) });
rule('GET', '/integrations/mills/status', 'mills');
rule('POST', '/integrations/multiphone/selection', 'mabel', { number: v => integer(v, 1, 1000) }, { dryRun: v => typeof v === 'boolean', deferPlayback: v => typeof v === 'boolean' });
rule('GET', '/integrations/multiphone/playlist', 'mabel');
rule('GET', '/now-playing', 'mabel');
rule('GET', '/config/browse/artist-albums', 'mabel', {}, {}, ['artist']);
rule('GET', '/config/browse/album-tracks', 'mabel', {}, {}, ['artist', 'album']);
rule('POST', '/mpd/start-queue', 'mabel');
rule('POST', '/mpd/start-song', 'mabel', { songId: v => integer(v, 0, Number.MAX_SAFE_INTEGER) });
rule('POST', '/mpd/play-artist', 'mabel', { artist: text }, { includeHoliday: v => typeof v === 'boolean', shuffle: v => typeof v === 'boolean', maxTracks: v => integer(v, 1, 5000), excludeRating1: v => typeof v === 'boolean' });
rule('POST', '/mpd/play-album', 'mabel', { album: text }, { excludeRating1: v => typeof v === 'boolean' });
rule('POST', '/mpd/play-playlist', 'mabel', { playlist: text }, { excludeRating1: v => typeof v === 'boolean' });
rule('POST', '/queue/mix', 'mabel', { artists: v => Array.isArray(v) && v.length >= 1 && v.length <= 50 && v.every(text) }, {
  excludeRating1: v => typeof v === 'boolean', excludeHoliday: v => typeof v === 'boolean', clearFirst: v => typeof v === 'boolean', shuffle: v => typeof v === 'boolean',
  random: v => typeof v === 'boolean', startPlayback: v => typeof v === 'boolean', maxTracks: v => integer(v, 1, 5000),
});

/** No defaults may enable exposure, change the API bind, or choose a LAN interface. */
export function resolveHardwareCompatibility({ env = process.env, apiHost, apiPort, trackKey, networkInterfaces = os.networkInterfaces() } = {}) {
  const flag = clean(env.SONUVI_HARDWARE_ENABLED);
  if (!flag || flag === '0') return Object.freeze({ enabled: false });
  if (flag !== '1') throw new Error('SONUVI_HARDWARE_ENABLED must be 0 or 1');
  if (apiHost !== '127.0.0.1' || !integer(apiPort, 1, 65535)) throw new Error('Hardware compatibility requires a loopback-only API');
  const host = clean(env.SONUVI_HARDWARE_HOST);
  if (!privateV4(host) || !Object.values(networkInterfaces).flat().some(a => a.address === host && !a.internal)) throw new Error('Hardware host must be an assigned private LAN IPv4 address');
  const portText = clean(env.SONUVI_HARDWARE_PORT);
  const port = Number(portText);
  const reserved = new Set([apiPort, 22, 80, 443, 3101, 3102, 8101, 8443, ...['DLNA_PORT', 'SONUVI_WEB_PORT', 'SONUVI_WEB_TLS_PORT'].map(k => Number(env[k]))]);
  if (!/^\d+$/.test(portText) || !integer(port, 1024, 65535) || reserved.has(port)) throw new Error('Hardware port must be explicit, unprivileged, and separate from existing listeners');
  if (!clean(trackKey) || trackKey.length > 1024) throw new Error('Hardware compatibility requires a protected Track Key');
  try { http.validateHeaderValue('x-track-key', trackKey); } catch { throw new Error('Hardware Track Key cannot be represented in an HTTP header'); }
  let parsed;
  try { parsed = JSON.parse(env.SONUVI_HARDWARE_CLIENTS || ''); } catch { throw new Error('Hardware clients must be an explicit JSON address-to-role map'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 32) throw new Error('Hardware clients must contain 1 through 32 exact addresses');
  const clients = {};
  for (const [address, assigned] of Object.entries(parsed)) {
    if (!privateV4(address) || !Array.isArray(assigned) || !assigned.length || assigned.length > 3 || new Set(assigned).size !== assigned.length || assigned.some(r => !roles.has(r))) throw new Error('Invalid hardware client address or roles');
    clients[address] = Object.freeze([...assigned]);
  }
  if (Object.values(clients).some(list => list.includes('mills'))) {
    for (const key of ['HARMONY_HOST', 'HARMONY_HUB_ID', 'HARMONY_DENON_DEVICE_ID']) {
      if (!clean(env[key]) || /[\x00-\x1f\x7f]/.test(env[key])) throw new Error(`Mills requires ${key}`);
    }
  }
  return Object.freeze({ enabled: true, host, port, apiPort, clients: Object.freeze(clients) });
}

export function hardwareRequestRule(method, target) {
  if (typeof target !== 'string' || target.length > 4096 || !target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target)) return null;
  const rawPath = target.split('?')[0];
  // Match raw paths before URL normalization; encoded paths and dot segments never alias a route.
  const entry = rules.get(`${method} ${rawPath}`);
  if (!entry) return null;
  let url;
  try { url = new URL(target, 'http://hardware.invalid'); } catch { return null; }
  if (url.origin !== 'http://hardware.invalid' || url.pathname !== rawPath) return null;
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !entry.query.includes(key) || !text(value)) return null;
    seen.add(key);
  }
  if (entry.query.some(key => !seen.has(key))) return null;
  return entry;
}
export function validHardwareBody(entry, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = { ...entry.required, ...entry.optional };
  return Object.keys(body).every(k => Object.hasOwn(fields, k) && fields[k](body[k]))
    && Object.keys(entry.required).every(k => Object.hasOwn(body, k));
}

/** Separate HTTP server, never a second listen() on the general Express app. */
export function createHardwareCompatibilityServer({ config, trackKey, request = http.request } = {}) {
  if (!config?.enabled || !isAuthorizedTrackKey(trackKey, trackKey)) throw new Error('Hardware listener requires enabled configuration and authentication');
  const counts = new Map();
  const sockets = new Set();
  const upstreams = new Set();
  const send = (res, status, error) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    res.end(JSON.stringify({ ok: false, error }));
  };
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const address = clientAddress(req.socket.remoteAddress);
    const assigned = config.clients[address];
    if (!assigned) return send(res, 403, 'Client not allowed');
    const minute = Math.floor(Date.now() / 60000);
    const previous = counts.get(address);
    const count = previous?.minute === minute ? previous.count + 1 : 1;
    counts.set(address, { minute, count });
    if (count > 120) return send(res, 429, 'Request limit exceeded');
    // Never trust Forwarded, cookies, browser dispatch, bearer tokens or query-string keys.
    const keyHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'x-track-key');
    if (keyHeaders.length !== 1 || !isAuthorizedTrackKey(trackKey, req.headers['x-track-key'])) return send(res, 403, 'Forbidden');
    const entry = hardwareRequestRule(req.method, req.url);
    if (!entry || !assigned.includes(entry.role)) return send(res, 404, 'Operation not allowed');
    if (req.headers['content-encoding'] || req.headers['transfer-encoding'] || req.headers.expect) return send(res, 400, 'Unsupported framing');
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 16384)) return send(res, 413, 'Request too large');
    let chunks = [], size = 0;
    const bodyDeadline = setTimeout(() => { send(res, 408, 'Request deadline exceeded'); req.destroy(); }, 15000);
    bodyDeadline.unref();
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { send(res, 413, 'Request too large'); return; }
        chunks.push(chunk);
      }
    } catch { return send(res, 400, 'Invalid request'); } finally { clearTimeout(bodyDeadline); }
    let body;
    if (req.method === 'GET') {
      if (size) return send(res, 400, 'GET body not allowed');
    } else {
      if (size && !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(res, 415, 'JSON required');
      try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(res, 400, 'Invalid JSON'); }
      if (!validHardwareBody(entry, body)) return send(res, 400, 'Invalid operation body');
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Fixed local target and fresh headers; never forward incoming auth/Host/dispatch/proxy headers.
    const upstream = request({ hostname: '127.0.0.1', port: config.apiPort, path: req.url, method: req.method,
      headers: { 'x-track-key': trackKey, connection: 'close', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return send(res, 502, 'Upstream redirect rejected'); }
      const contentType = String(response.headers['content-type'] || '');
      if (!/^application\/json(?:;|$)/i.test(contentType)) { response.resume(); return send(res, 502, 'Invalid upstream response'); }
      let received = 0;
      const parts = [];
      response.on('data', chunk => {
        received += chunk.length;
        if (received > 4 * 1024 * 1024) { response.destroy(); send(res, 502, 'Upstream response too large'); }
        else parts.push(chunk);
      });
      response.on('error', () => send(res, 502, 'Upstream unavailable'));
      response.on('end', () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(response.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
        res.end(Buffer.concat(parts));
      });
    });
    upstreams.add(upstream);
    const deadline = setTimeout(() => { upstream.destroy(); send(res, 504, 'Upstream deadline exceeded'); }, 90000);
    deadline.unref();
    upstream.on('error', () => send(res, 502, 'Upstream unavailable'));
    upstream.on('close', () => { clearTimeout(deadline); upstreams.delete(upstream); });
    res.on('close', () => upstream.destroy());
    upstream.end(payload);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 32;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('checkContinue', (_req, res) => send(res, 417, 'Expect not supported'));
  server.on('checkExpectation', (_req, res) => send(res, 417, 'Expect not supported'));
  return { server, close: () => new Promise(resolve => {
    server.close(resolve);
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
  }) };
}
