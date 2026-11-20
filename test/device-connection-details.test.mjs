import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceSessionRegistry } from '../src/lib/sonuvi-device-sessions.mjs';
import { directDeviceAddress, observedDeviceDetails, reportedDeviceDetails, publicDeviceDetails } from '../src/lib/device-connection-details.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sonuvi-observed-device-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = 1000000;
  const registry = new DeviceSessionRegistry({ directory: path.join(root, 'devices'), now: () => time });
  const sid = registry.authorize('phone', { label: 'iPhone' });
  return { registry, claims: { deviceId: 'phone', sid }, advance: ms => { time += ms; } };
}

test('address display accepts literal peers, normalizes mapped IPv4, never loopback or injected endpoints', () => {
  assert.equal(directDeviceAddress('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(directDeviceAddress('2001:db8::7'), '2001:db8::7');
  for (const address of ['127.0.0.1', '127.22.4.1', '::1', '::', '0.0.0.0', 'https://192.0.2.7', '192.0.2.7, 10.0.0.1', '<script>', '192.0.2.7:443']) assert.equal(directDeviceAddress(address), null);
});

test('direct observations persist across restart; proxied traffic retains last address with its original time', t => {
  const { registry, claims, advance } = fixture(t);
  assert.equal(registry.observe(claims, { address: '192.0.2.7', userAgent: 'Mozilla/5.0 (iPad) Version/18 Safari/605.1.15' }), true);
  let row = registry.list()[0];
  assert.equal(row.lastSeenAt, 1000000);assert.equal(row.lastSeenAddress, '192.0.2.7');assert.equal(row.lastAddressSeenAt, 1000000);
  assert.equal(row.platform, 'iPadOS');assert.equal(row.browser, 'Safari');
  advance(61000);registry.observe(claims, { address: '127.0.0.1' });
  row = new DeviceSessionRegistry({ directory: registry.directory }).list()[0];
  assert.equal(row.lastSeenAt, 1061000);assert.equal(row.connectionKind, 'proxied');
  assert.equal(row.lastSeenAddress, '192.0.2.7');assert.equal(row.lastAddressSeenAt, 1000000);
  assert.equal(row.status, 'active');assert.equal(row.role, 'controller');
  assert.equal(JSON.stringify(row).includes(claims.sid), false);
});

test('same-peer observations are rate limited; address changes are recorded immediately', t => {
  const { registry, claims, advance } = fixture(t);
  registry.observe(claims, { address: '192.0.2.7' });advance(1000);
  registry.observe(claims, { address: '192.0.2.7' });assert.equal(registry.list()[0].lastSeenAt, 1000000);
  registry.observe(claims, { address: '192.0.2.8' });assert.equal(registry.list()[0].lastSeenAt, 1001000);
  assert.equal(registry.list()[0].lastSeenAddress, '192.0.2.8');
});

test('observations never authorize unknown, revoked, replaced or wrong-session devices', t => {
  const { registry, claims } = fixture(t);
  assert.equal(registry.observe({ deviceId: 'unknown' }, { address: '192.0.2.7' }), false);
  assert.equal(registry.observe({ ...claims, sid: 'x'.repeat(43) }, { address: '192.0.2.7' }), false);
  registry.observe(claims, { address: '192.0.2.7' });registry.revoke(claims.deviceId);
  assert.equal(registry.observe(claims, { address: '192.0.2.8' }), false);
  assert.equal(registry.list().length, 1);assert.equal(registry.list()[0].status, 'revoked');
  registry.authorize('phone');assert.equal(registry.observe(claims, { address: '192.0.2.8' }), false);
});

test('reported hints are bounded display-only metadata and cannot set address, role or credentials', t => {
  const { registry, claims } = fixture(t);
  registry.describe(claims, 'My phone', { deviceType: 'iPhone', platform: 'iOS', osVersion: '27.3', appVersion: '0.1.1 (457)', role: 'administrator', lastSeenAddress: '203.0.113.99' });
  const row = registry.list()[0];assert.equal(row.role, 'controller');assert.equal(row.deviceType, 'iPhone');assert.equal(row.osVersion, '27.3');assert.equal(row.lastSeenAddress, undefined);
  for (const bad of [{ platform: 'javascript:evil' }, { osVersion: 'bad\nvalue' }, { appVersion: 'x'.repeat(81) }]) assert.throws(() => reportedDeviceDetails(bad));
  assert.deepEqual(publicDeviceDetails({ sessionId: claims.sid, administratorId: 'private', lastSeenAddress: '<script>', lastSeenAt: NaN }), {});
  assert.deepEqual(observedDeviceDetails('very-private-token-no-browser'), {});
});
