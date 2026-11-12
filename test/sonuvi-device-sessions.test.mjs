import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceSessionRegistry } from '../src/lib/sonuvi-device-sessions.mjs';
import { createMobileSessionToken, createMobileMediaTicket, createMobileRadioTicket, createMobileAnimationTicket, createPersistentMobileRefreshToken, createPersistentControllerRefreshToken, verifyMobileToken } from '../src/lib/mobile-auth.mjs';
import { createControllerDispatchAuthorizer } from '../src/lib/controller-browser-dispatch.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sonuvi-device-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'sessions');
  return { directory, registry: new DeviceSessionRegistry({ directory, ...options }) };
}

test('each device is independently revoked across process instances and restarts', t => {
  const { directory, registry } = fixture(t);
  const first = { deviceId: 'ipad', sid: registry.authorize('ipad') };
  const second = { deviceId: 'tv', sid: registry.authorize('tv') };
  const otherProcess = new DeviceSessionRegistry({ directory });
  assert.ok(otherProcess.accepts(first));
  registry.revoke('ipad');
  assert.equal(otherProcess.accepts(first), false);
  assert.ok(otherProcess.accepts(second));
  assert.equal(new DeviceSessionRegistry({ directory }).accepts(first), false);
  assert.throws(() => otherProcess.renew(first), /rejected/);
});

test('legacy refresh migrates once without invalidating its existing access or renewal credential', t => {
  const { registry } = fixture(t);
  const legacy = { deviceId: 'existing-phone' };
  assert.ok(registry.accepts(legacy));
  const sid = registry.renew(legacy);
  assert.equal(registry.renew(legacy), sid);
  assert.ok(registry.accepts(legacy));
  assert.ok(registry.accepts({ ...legacy, sid }));
  registry.revoke(legacy.deviceId);
  assert.equal(registry.accepts(legacy), false);
  assert.equal(registry.accepts({ ...legacy, sid }), false);
  assert.throws(() => registry.renew(legacy), /rejected/);
});

test('revoking an unmigrated device creates a durable tombstone; re-pairing cannot revive old tokens', t => {
  const { registry } = fixture(t);
  registry.revoke('legacy-tv');
  assert.equal(registry.accepts({ deviceId: 'legacy-tv' }), false);
  const sid = registry.authorize('legacy-tv');
  assert.ok(registry.accepts({ deviceId: 'legacy-tv', sid }));
  assert.equal(registry.accepts({ deviceId: 'legacy-tv' }), false);
  const nextSid = registry.authorize('legacy-tv');
  assert.notEqual(nextSid, sid);
  assert.equal(registry.accepts({ deviceId: 'legacy-tv', sid }), false);
});

test('all bearer, renewal, media and browser-dispatch boundaries reject a revoked device', t => {
  const { registry } = fixture(t);
  const secret = 'isolated-fixture-signing-secret';
  const deviceId = 'test-phone';
  const sessionId = registry.authorize(deviceId);
  const common = { secret, deviceId, sessionId };
  const tokens = [
    ['mobile-api', createMobileSessionToken(common)],
    ['mobile-refresh', createPersistentMobileRefreshToken(common)],
    ['controller-web-refresh', createPersistentControllerRefreshToken(common)],
    ['mobile-media', createMobileMediaTicket({ ...common, trackId: 'track' })],
    ['mobile-radio', createMobileRadioTicket({ ...common, stationId: 'station' })],
    ['mobile-animation', createMobileAnimationTicket({ ...common, name: `${'a'.repeat(40)}.mp4` })],
  ];
  const authorize = createControllerDispatchAuthorizer({ apiSecret: secret, sessionRegistry: registry });
  const request = { method: 'GET', path: '/now-playing', url: '/now-playing', socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${tokens[0][1]}`, 'x-sonuvi-controller-dispatch': 'mobile-session' } };
  assert.ok(authorize(request));
  for (const [scope, token] of tokens) assert.ok(verifyMobileToken(token, { secret, scope, sessionRegistry: registry }));
  registry.revoke(deviceId);
  for (const [scope, token] of tokens) assert.equal(verifyMobileToken(token, { secret, scope, sessionRegistry: registry }), null);
  assert.equal(authorize(request), false);
  const state = fs.readFileSync(registry.file, 'utf8');
  for (const [, token] of tokens) assert.equal(state.includes(token), false);
});

test('unknown session generations and disabled legacy migration fail closed', t => {
  const { registry } = fixture(t, { allowLegacy: false });
  assert.equal(registry.accepts({ deviceId: 'unknown' }), false);
  assert.throws(() => registry.renew({ deviceId: 'unknown' }), /rejected/);
  assert.equal(registry.accepts({ deviceId: 'unknown', sid: 'a'.repeat(43) }), false);
});

test('missing, corrupt, permissive and substituted state fail closed without automatic reset', t => {
  const { registry, directory } = fixture(t);
  const claims = { deviceId: 'ipad', sid: registry.authorize('ipad') };
  fs.chmodSync(registry.file, 0o644);
  assert.equal(registry.accepts(claims), false);
  assert.throws(() => registry.renew(claims), /unsafe/);
  fs.chmodSync(registry.file, 0o600);
  fs.writeFileSync(registry.file, 'not-json');
  assert.equal(registry.accepts(claims), false);
  assert.throws(() => new DeviceSessionRegistry({ directory }));
  fs.unlinkSync(registry.file);
  assert.equal(registry.accepts({ deviceId: 'legacy' }), false);
  assert.throws(() => new DeviceSessionRegistry({ directory }), /unavailable/);
});

test('symlink directories and files are not followed', t => {
  const { registry, directory } = fixture(t);
  const link = `${directory}-link`;
  fs.symlinkSync(directory, link);
  assert.throws(() => new DeviceSessionRegistry({ directory: link }), /unsafe/);
  const preserved = path.join(directory, 'preserved.json');
  fs.renameSync(registry.file, preserved);
  fs.symlinkSync(preserved, registry.file);
  assert.equal(registry.accepts({ deviceId: 'legacy' }), false);
  assert.throws(() => registry.revoke('legacy'), /unavailable/);
});

test('concurrent or interrupted writers do not overwrite state or steal a lock', t => {
  const { registry } = fixture(t);
  registry.authorize('ipad');
  const previous = fs.readFileSync(registry.file, 'utf8');
  fs.writeFileSync(registry.lock, '', { flag: 'wx', mode: 0o600 });
  assert.throws(() => registry.revoke('ipad'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(registry.file, 'utf8'), previous);
  assert.ok(fs.existsSync(registry.lock));
});
