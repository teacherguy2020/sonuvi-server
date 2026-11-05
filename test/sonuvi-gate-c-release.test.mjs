import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/lib/release-artifact.mjs';
import {
  GATE_C_RELEASE_ENVELOPE_CONTRACT,
  GATE_C_RELEASE_METADATA_CONTRACT,
  GATE_C_RELEASE_TRANSFER_FORMAT,
  verifyGateCReleaseTransfer,
  verifySignedGateCReleaseMetadata,
} from '../src/lib/sonuvi-gate-c-release.mjs';

const releaseId = `sonuvi-${'a'.repeat(64)}`;
const artifactSha256 = 'b'.repeat(64);
const manifestSha256 = 'c'.repeat(64);

function signedEnvelope({ mutate = (value) => value } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const payload = mutate({
    contract: GATE_C_RELEASE_METADATA_CONTRACT,
    releaseId,
    manifestSha256,
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { format: GATE_C_RELEASE_TRANSFER_FORMAT, sha256: artifactSha256, bytes: 1024 },
    bootstrap: { version: 1, sha256: 'd'.repeat(64) },
    issuedAt: '2026-11-05T00:00:00.000Z',
    expiresAt: '2026-11-12T00:00:00.000Z',
  });
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64url');
  return {
    envelope: { contract: GATE_C_RELEASE_ENVELOPE_CONTRACT, keyId: 'sonuvi-release-2026', payload, signature },
    anchors: { 'sonuvi-release-2026': pair.publicKey.export({ type: 'spki', format: 'pem' }) },
  };
}

test('signed Gate C metadata permits only an immutable linux/arm64 tar release', () => {
  const { envelope, anchors } = signedEnvelope();
  const verified = verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: anchors, now: Date.parse('2026-11-06T00:00:00.000Z') });
  assert.equal(verified.keyId, 'sonuvi-release-2026');
  assert.equal(verified.metadata.releaseId, releaseId);
  assert.equal(verified.metadata.artifact.bytes, 1024);
  assert.equal(verified.metadata.target.architecture, 'arm64');
});

test('release metadata fails closed for unknown anchors, tampering, URLs, and expiry', () => {
  const { envelope, anchors } = signedEnvelope();
  assert.throws(() => verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: {} }), /trust anchor/);
  assert.throws(() => verifySignedGateCReleaseMetadata({ envelope: { ...envelope, payload: { ...envelope.payload, releaseId: `sonuvi-${'d'.repeat(64)}` } }, trustedAnchors: anchors }), /signature/);
  assert.throws(() => verifySignedGateCReleaseMetadata({ envelope: { ...envelope, payload: { ...envelope.payload, url: 'https://example.invalid/release' } }, trustedAnchors: anchors }), /unsupported fields/);
  assert.throws(() => verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: anchors, now: Date.parse('2026-12-01T00:00:00.000Z') }), /expired/);
});

test('release transfer cannot continue if its exact signed byte length or digest differs', () => {
  const { envelope, anchors } = signedEnvelope();
  const { metadata } = verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: anchors, now: Date.parse('2026-11-06T00:00:00.000Z') });
  assert.equal(verifyGateCReleaseTransfer({ metadata, bytes: 1024, sha256: artifactSha256 }).releaseId, releaseId);
  assert.throws(() => verifyGateCReleaseTransfer({ metadata, bytes: 1023, sha256: artifactSha256 }), /byte count/);
  assert.throws(() => verifyGateCReleaseTransfer({ metadata, bytes: 1024, sha256: 'd'.repeat(64) }), /digest/);
});
