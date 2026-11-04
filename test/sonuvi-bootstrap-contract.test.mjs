import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SONUVI_BOOTSTRAP_PROTOCOL_VERSION,
  bootstrapEvent,
  normalizeBootstrapRequest,
} from '../src/lib/sonuvi-bootstrap-contract.mjs';

const requestId = 'boot_0123456789abcdef';
const releaseId = `sonuvi-${'a'.repeat(64)}`;

test('bootstrap request accepts only the versioned, non-secret installation envelope', () => {
  const request = normalizeBootstrapRequest({
    protocolVersion: SONUVI_BOOTSTRAP_PROTOCOL_VERSION,
    requestId,
    releaseId,
    manifestSha256: 'b'.repeat(64),
    options: { hostname: 'sonuvi-ios-setup-01', libraryPolicy: 'deferred' },
  });
  assert.equal(request.requestId, requestId);
  assert.equal(request.releaseId, releaseId);
  assert.throws(() => normalizeBootstrapRequest({ protocolVersion: 1, requestId, password: 'nope' }), /not allowed/);
  assert.throws(() => normalizeBootstrapRequest({ protocolVersion: 2, requestId }), /unsupported/);
});

test('bootstrap events carry stable stage/error semantics without fabricated progress', () => {
  const event = bootstrapEvent({
    requestId,
    stage: 'release_verification',
    state: 'failed',
    error: { code: 'manifest_invalid', recoverable: false },
    at: '2026-11-04T00:00:00.000Z',
  });
  assert.equal(event.progress, null);
  assert.equal(event.error.code, 'manifest_invalid');
  assert.throws(() => bootstrapEvent({ requestId, stage: 'activation', state: 'started', progress: 42.5 }), /integer percentage/);
});
