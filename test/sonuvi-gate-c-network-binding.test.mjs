import assert from 'node:assert/strict';
import test from 'node:test';

// Keep the policy pure so tests do not need to load a deployment config.
import { resolveApiListenHost } from '../src/config.mjs';

test('fresh installs bind authenticated API traffic to SSH-tunnel-only loopback', () => {
  assert.equal(resolveApiListenHost({ freshInstall: true, override: '' }), '127.0.0.1');
  assert.equal(resolveApiListenHost({ freshInstall: false, override: '' }), '0.0.0.0');
  assert.throws(() => resolveApiListenHost({ freshInstall: true, override: '0.0.0.0' }), /fresh Sonuvi/);
  assert.throws(() => resolveApiListenHost({ freshInstall: true, override: '192.168.1.10' }), /fresh Sonuvi/);
});
