import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { resolveHardwareCompatibility, createHardwareCompatibilityServer } from '../src/lib/hardware-compatibility.mjs';
import { registerSeeburgRoutes } from '../src/routes/seeburg.routes.mjs';
const secret = 'disposable-fixture-key';
const base = { apiHost: '127.0.0.1', apiPort: 3101, trackKey: secret, networkInterfaces: { lan: [{ address: '10.0.0.65', internal: false }] } };
const env = { SONUVI_HARDWARE_ENABLED: '1', SONUVI_HARDWARE_HOST: '10.0.0.65', SONUVI_HARDWARE_PORT: '3103', SONUVI_HARDWARE_CLIENTS: JSON.stringify({ '10.0.0.118': ['seeburg'] }) };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t, assigned = ['seeburg', 'mills', 'mabel'], handler) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (handler) return handler(req, res, calls.at(-1));
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'must-not-escape=1' });
    res.end(JSON.stringify({ ok: true, ...calls.at(-1), headers: undefined }));
  });
  const apiPort = await listen(backend);
  const runtime = createHardwareCompatibilityServer({ config: { enabled: true, apiPort, clients: { '127.0.0.1': assigned } }, trackKey: secret });
  const port = await listen(runtime.server);
  t.after(async () => { await runtime.close(); await close(backend); });
  const call = (path, { method = 'POST', body = {}, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === null ? '' : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'x-track-key': secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, res => {
      let text = '';res.on('data', c => text += c);res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    }); req.on('error', reject);req.end(payload);
  });
  return { calls, call, runtime, port };
}

test('disabled by default; explicit enable requires assigned LAN interface, loopback API and protected key', () => {
  assert.deepEqual(resolveHardwareCompatibility({ env: {} }), { enabled: false });
  assert.equal(resolveHardwareCompatibility({ ...base, env }).port, 3103);
  for (const patch of [{ apiHost: '0.0.0.0' }, { trackKey: '' }, { networkInterfaces: {} }]) assert.throws(() => resolveHardwareCompatibility({ ...base, ...patch, env }));
  for (const host of ['', '0.0.0.0', '127.0.0.1', '100.123.254.86', '8.8.8.8', 'sonuvi.local', '::']) assert.throws(() => resolveHardwareCompatibility({ ...base, env: { ...env, SONUVI_HARDWARE_HOST: host } }));
  for (const port of ['', '3101', '3102', '8101', '8443', '22', '65536', '1e4']) assert.throws(() => resolveHardwareCompatibility({ ...base, env: { ...env, SONUVI_HARDWARE_PORT: port } }));
});
test('clients are exact private addresses; roles explicit; Mills cannot enable without amplifier configuration', () => {
  for (const clients of [{}, { '*': ['mabel'] }, { '10.0.0.0/16': ['mabel'] }, { '10.0.0.9': ['admin'] }, { '10.0.0.9': [] }, { '10.0.0.9': ['mills'] }]) assert.throws(() => resolveHardwareCompatibility({ ...base, env: { ...env, SONUVI_HARDWARE_CLIENTS: JSON.stringify(clients) } }));
  const mills = { ...env, SONUVI_HARDWARE_CLIENTS: '{"10.0.0.9":["mills"]}', HARMONY_HOST: 'harmony.test', HARMONY_HUB_ID: 'fixture-hub', HARMONY_DENON_DEVICE_ID: 'fixture-device' };
  assert.equal(resolveHardwareCompatibility({ ...base, env: mills }).enabled, true);
});
test('missing or incorrect Track Key, bearer/cookie/dispatch substitutes and query keys never reach upstream', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'x-track-key': '' }, { 'x-track-key': 'wrong' }, { 'x-track-key': '', authorization: 'Bearer fake', cookie: 'sonuvi_controller=fake', 'x-sonuvi-controller-dispatch': 'mobile-session' }]) assert.equal((await f.call('/integrations/seeburg/selection', { body: { number: 1 }, headers })).status, 403);
  assert.equal((await f.call('/integrations/seeburg/selection?k=anything', { body: { number: 1 } })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('socket source and role are enforced independently of spoofed forwarding headers', async t => {
  const f = await fixture(t, ['seeburg']);
  assert.equal((await f.call('/mpd/start-queue', { headers: { 'x-forwarded-for': '10.0.0.210', forwarded: 'for=10.0.0.210' } })).status, 404);
  assert.equal((await f.call('/integrations/mills/start')).status, 404);
  assert.equal(f.calls.length, 0);
  const runtime = createHardwareCompatibilityServer({ config: { enabled: true, apiPort: 1, clients: { '10.0.0.210': ['mabel'] } }, trackKey: secret });
  const port = await listen(runtime.server);t.after(() => runtime.close());
  const result = await fetch(`http://127.0.0.1:${port}/now-playing`, { headers: { 'x-track-key': secret, 'x-forwarded-for': '10.0.0.210' } });assert.equal(result.status, 403);
});
test('native admin, enrollment, installer, maintenance and unrelated API routes never reach upstream', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/admin/configuration', '/v1/admin/configuration/operation', '/v1/admin/library/status', '/v1/mobile/pairing/presentations', '/v1/bootstrap/enroll', '/install', '/config/runtime/admin', '/config/services/mpdscribble/action', '/config/runtime/ensure-podcast-root', '/mpd/command', '/queue/clear', '/__controller/pairings', '/health']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await f.call(path, { method, body: null })).status, 404, `${method} ${path}`);
  }
  assert.equal(f.calls.length, 0);
});
test('encoded/dot/absolute paths and duplicate, unknown or missing query fields cannot bypass the allowlist', async t => {
  const f = await fixture(t);
  for (const path of ['/integrations/seeburg/%73election', '/x/../integrations/seeburg/selection', '//integrations/seeburg/selection', 'http://127.0.0.1/integrations/seeburg/selection', '/integrations/seeburg/selection#fragment']) assert.equal((await f.call(path, { body: { number: 1 } })).status, 404);
  for (const path of ['/config/browse/artist-albums', '/config/browse/artist-albums?artist=A&artist=B', '/config/browse/artist-albums?artist=A&k=B', '/config/browse/artist-albums?artist=%0a']) assert.equal((await f.call(path, { method: 'GET', body: null })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('selection validation, unexpected fields and body/framing limits reject before dispatch', async t => {
  const f = await fixture(t);
  for (const body of [{ number: 0 }, { number: 101 }, { number: '1' }, { number: 1, command: 'play' }, [], null]) assert.equal((await f.call('/integrations/seeburg/selection', { body })).status, 400);
  assert.equal((await f.call('/integrations/mills/selection', { body: { slot: 21 } })).status, 400);
  assert.equal((await f.call('/integrations/mills/start', { body: { command: 'anything' } })).status, 400);
  assert.equal((await f.call('/integrations/seeburg/selection', { raw: '{' })).status, 400);
  assert.equal((await f.call('/integrations/seeburg/selection', { raw: 'x'.repeat(16385) })).status, 413);
  assert.equal((await f.call('/integrations/seeburg/selection', { body: { number: 1 }, headers: { 'content-encoding': 'gzip' } })).status, 400);
  assert.equal((await f.call('/integrations/seeburg/selection', { body: { number: 1 }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});
test('firmware empty Mills transitions and numbered selections retain exact method/path/body', async t => {
  const f = await fixture(t);
  for (const path of ['/integrations/mills/start', '/integrations/mills/stop']) assert.equal((await f.call(path, { body: null })).status, 200);
  assert.equal((await f.call('/integrations/mills/selection', { body: { slot: 20 } })).status, 200);
  assert.equal((await f.call('/integrations/seeburg/selection', { body: { number: 100 } })).status, 200);
  assert.deepEqual(f.calls.map(c => c.body), [{}, {}, { slot: 20 }, { number: 100 }]);
});
test('complete current Mabel operation schemas are accepted without broadening config or MPD access', async t => {
  const f = await fixture(t, ['mabel']);
  for (const [path, body] of [
    ['/integrations/multiphone/selection', { number: 170, dryRun: false, deferPlayback: true }],
    ['/mpd/start-song', { songId: 42 }], ['/mpd/start-queue', {}],
    ['/mpd/play-album', { album: 'Album', excludeRating1: true }],
    ['/mpd/play-artist', { artist: 'Artist', shuffle: true, maxTracks: 50, excludeRating1: true }],
    ['/mpd/play-playlist', { playlist: 'List', excludeRating1: true }],
    ['/queue/mix', { artists: ['A', 'B'], excludeHoliday: true, clearFirst: true, random: false, shuffle: true, startPlayback: true, maxTracks: 300, excludeRating1: true }],
  ]) assert.equal((await f.call(path, { body })).status, 200, path);
  for (const path of ['/now-playing', '/integrations/multiphone/playlist', '/config/browse/artist-albums?artist=A%20B', '/config/browse/album-tracks?artist=A&album=B']) assert.equal((await f.call(path, { method: 'GET', body: null })).status, 200, path);
});
test('client headers cannot carry administrator/browser identity to upstream; response cookies are stripped', async t => {
  const f = await fixture(t);
  const result = await f.call('/integrations/seeburg/selection', { body: { number: 1 }, headers: { authorization: 'Bearer bad', cookie: 'admin=fake', 'x-sonuvi-controller-dispatch': 'mobile-session', 'x-forwarded-for': '1.2.3.4', origin: 'https://evil.test' } });
  assert.equal(result.status, 200);assert.equal(result.headers['set-cookie'], undefined);
  for (const name of ['authorization', 'cookie', 'x-sonuvi-controller-dispatch', 'x-forwarded-for', 'origin']) assert.equal(f.calls[0].headers[name], undefined);
  assert.match(f.calls[0].headers.host, /^127\.0\.0\.1:/);
});
test('upstream redirects are not followed or exposed', async t => {
  const f = await fixture(t, ['mabel'], (_req, res) => { res.writeHead(302, { location: 'http://external.invalid/credential' });res.end(); });
  const result = await f.call('/now-playing', { method: 'GET', body: null });assert.equal(result.status, 502);assert.equal(result.headers.location, undefined);assert.equal(f.calls.length, 1);
});
test('real Seeburg route resolves dry-run through gateway with no playback or queue calls', async t => {
  const routes = new Map(), commands = [];
  registerSeeburgRoutes({ post: (p, h) => routes.set(p, h), get: (p, h) => routes.set(p, h) }, {
    requireTrackKey: req => req.headers['x-track-key'] === secret,
    mpdEscapeValue: JSON.stringify, mpdHasACK: () => false, parseMpdFirstBlock: () => ({}), jukeboxStatePath: null,
    mpdQueryRaw: async command => { commands.push(command);assert.equal(command, 'listplaylist "Seeburg Playlist"');return 'file: fixture.flac\nOK\n'; },
  });
  const f = await fixture(t, ['seeburg'], async (req, res, call) => {
    req.body = call.body;req.query = {};
    res.status = code => { res.statusCode = code;return res; };
    res.json = body => { res.setHeader('content-type', 'application/json');res.end(JSON.stringify(body)); };
    await routes.get(req.url)(req, res);
  });
  const result = await f.call('/integrations/seeburg/selection', { body: { number: 1, dryRun: true } });
  assert.equal(result.status, 200);assert.equal(result.json().file, 'fixture.flac');assert.equal(result.json().dryRun, true);assert.equal(commands.length, 1);
});
test('shutdown releases incomplete client sockets promptly', async t => {
  const f = await fixture(t);
  const socket = net.connect(f.port, '127.0.0.1');await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /integrations/seeburg/selection HTTP/1.1\r\nHost: fixture\r\n');
  const start = Date.now();await f.runtime.close();assert.ok(Date.now() - start < 1000);socket.destroy();
});
