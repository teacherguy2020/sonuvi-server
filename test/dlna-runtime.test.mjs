import assert from 'node:assert/strict';
import test from 'node:test';

import { createDlnaRuntime } from '../src/lib/dlna-runtime.mjs';

test('DLNA runtime stays disabled without an explicit private-LAN opt-in', async () => {
  let listened = false;
  const runtime = createDlnaRuntime({ enabled: false, listen: async () => { listened = true; } });
  assert.deepEqual(runtime.status(), { enabled: false, status: 'disabled' });
  assert.equal(await runtime.start(), false);
  assert.equal(listened, false);
});

test('DLNA runtime does not report running on bind failure', async () => {
  const warnings = [];
  const runtime = createDlnaRuntime({
    enabled: true,
    listen: async () => { throw new Error('address in use'); },
    initialize: async () => 'uuid:fixture',
    startSsdp: async () => ({ close() {} }),
    log: { warn: (...entry) => warnings.push(entry) },
  });
  assert.equal(runtime.status().status, 'starting');
  assert.equal(await runtime.start(), false);
  assert.deepEqual(runtime.status(), { enabled: true, status: 'error', reason: 'address in use' });
  assert.equal(warnings.length, 1);
});

test('DLNA runtime cleans a bound listener when SSDP setup partially fails', async () => {
  let listenerClosed = 0;
  const runtime = createDlnaRuntime({
    enabled: true,
    listen: async () => ({ close: (done) => { listenerClosed += 1; done(); } }),
    initialize: async () => 'uuid:fixture',
    startSsdp: async () => { throw new Error('multicast unavailable'); },
    log: { warn() {} },
  });
  assert.equal(await runtime.start(), false);
  assert.equal(listenerClosed, 1);
  assert.equal(runtime.status().status, 'error');
});

test('DLNA runtime tracks listener and SSDP resources through shutdown', async () => {
  const closed = [];
  const runtime = createDlnaRuntime({
    enabled: true,
    listen: async () => ({ close: (done) => { closed.push('listener'); done(); } }),
    initialize: async () => 'uuid:fixture',
    startSsdp: async (udn) => {
      assert.equal(udn, 'uuid:fixture');
      return { close: (done) => { closed.push('ssdp'); done(); } };
    },
  });
  assert.equal(await runtime.start(), true);
  assert.deepEqual(runtime.status(), { enabled: true, status: 'running' });
  await runtime.stop();
  assert.deepEqual(closed, ['ssdp', 'listener']);
  assert.deepEqual(runtime.status(), { enabled: true, status: 'disabled' });
});
