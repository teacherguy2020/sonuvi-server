import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePublicWebListenHost } from '../src/lib/public-web-server.mjs';

test('public web listener defaults to loopback and allows only the reviewed direct-port compatibility host', () => {
  assert.equal(resolvePublicWebListenHost(), '127.0.0.1');
  assert.equal(resolvePublicWebListenHost('0.0.0.0'), '0.0.0.0');
  assert.throws(() => resolvePublicWebListenHost('192.0.2.4'), /127\.0\.0\.1 or 0\.0\.0\.0/);
});
