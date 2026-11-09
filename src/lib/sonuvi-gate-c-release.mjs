import crypto from 'node:crypto';

import { canonicalJson } from './release-artifact.mjs';

export const GATE_C_RELEASE_METADATA_CONTRACT = 'sonuvi.gate-c-release-metadata.v1';
export const GATE_C_RELEASE_ENVELOPE_CONTRACT = 'sonuvi.gate-c-release-envelope.v1';
export const GATE_C_RELEASE_TRANSFER_FORMAT = 'sonuvi.release-tar.v1';

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;

function text(value) {
  return String(value ?? '').trim();
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function sha256(value, label) {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function releaseId(value) {
  const result = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(result)) throw new Error('release ID is invalid');
  return result;
}

function timestamp(value, label) {
  const result = text(value);
  if (!result || !Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid`);
  return result;
}

function byteCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARTIFACT_BYTES) {
    throw new Error('release artifact byte count is invalid');
  }
  return value;
}

/**
 * Normalize the signed, URL-free release descriptor. The iPad obtains an
 * envelope from its release distributor, verifies the same pinned signer, and
 * streams the indicated immutable bytes through the already pinned SSH
 * connection. A descriptor can never tell a target to fetch or execute a URL.
 */
export function normalizeGateCReleaseMetadata(input = {}) {
  sameKeys(input, ['artifact', 'bootstrap', 'contract', 'expiresAt', 'issuedAt', 'manifestSha256', 'releaseId', 'target'], 'release metadata');
  if (input.contract !== GATE_C_RELEASE_METADATA_CONTRACT) throw new Error('release metadata contract is unsupported');
  sameKeys(input.target, ['architecture', 'os'], 'release metadata target');
  sameKeys(input.artifact, ['bytes', 'format', 'sha256'], 'release metadata artifact');
  sameKeys(input.bootstrap, ['sha256', 'version'], 'release metadata bootstrap');
  const issuedAt = timestamp(input.issuedAt, 'release metadata issuedAt');
  const expiresAt = timestamp(input.expiresAt, 'release metadata expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('release metadata expiry is invalid');
  if (input.target.os !== 'linux' || input.target.architecture !== 'arm64') {
    throw new Error('release metadata target is unsupported');
  }
  if (input.artifact.format !== GATE_C_RELEASE_TRANSFER_FORMAT) throw new Error('release transfer format is unsupported');
  // Version 2 adds the fixed, separately invoked in-place upgrade adapter;
  // version 1 remains the supported first-install bootstrap kit.
  if (!Number.isInteger(input.bootstrap.version) || ![1, 2].includes(input.bootstrap.version)) {
    throw new Error('release bootstrap version is unsupported');
  }
  return Object.freeze({
    contract: GATE_C_RELEASE_METADATA_CONTRACT,
    releaseId: releaseId(input.releaseId),
    manifestSha256: sha256(input.manifestSha256, 'release manifest digest'),
    target: Object.freeze({ os: 'linux', architecture: 'arm64' }),
    artifact: Object.freeze({
      format: GATE_C_RELEASE_TRANSFER_FORMAT,
      sha256: sha256(input.artifact.sha256, 'release artifact digest'),
      bytes: byteCount(input.artifact.bytes),
    }),
    bootstrap: Object.freeze({ version: input.bootstrap.version, sha256: sha256(input.bootstrap.sha256, 'release bootstrap digest') }),
    issuedAt,
    expiresAt,
  });
}

function anchorFor(trustedAnchors, keyId) {
  if (!trustedAnchors || typeof trustedAnchors !== 'object') return null;
  const value = trustedAnchors instanceof Map ? trustedAnchors.get(keyId) : trustedAnchors[keyId];
  return value ? String(value) : null;
}

/**
 * Verify a release envelope against a caller-owned, preconfigured public-key
 * set. `trustedAnchors` is intentionally not part of the envelope or an SSH
 * request: callers must load it from the reviewed app/server distribution.
 */
export function verifySignedGateCReleaseMetadata({ envelope, trustedAnchors, now = Date.now() } = {}) {
  sameKeys(envelope, ['contract', 'keyId', 'payload', 'signature'], 'release envelope');
  if (envelope.contract !== GATE_C_RELEASE_ENVELOPE_CONTRACT) throw new Error('release envelope contract is unsupported');
  const keyId = text(envelope.keyId);
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(keyId)) throw new Error('release signing key ID is invalid');
  const publicKey = anchorFor(trustedAnchors, keyId);
  if (!publicKey) throw new Error('release trust anchor is unavailable');
  const metadata = normalizeGateCReleaseMetadata(envelope.payload);
  const signature = text(envelope.signature);
  if (!/^[A-Za-z0-9_-]{80,256}$/.test(signature)) throw new Error('release signature is invalid');
  let verified = false;
  try {
    verified = crypto.verify(null, Buffer.from(canonicalJson(metadata)), crypto.createPublicKey(publicKey), Buffer.from(signature, 'base64url'));
  } catch {
    throw new Error('release trust anchor is invalid');
  }
  if (!verified) throw new Error('release metadata signature is invalid');
  if (!Number.isFinite(now) || Date.parse(metadata.expiresAt) <= now) throw new Error('release metadata has expired');
  return Object.freeze({ keyId, metadata });
}

/** A digest/length gate for the streamed tarball, before extraction occurs. */
export function verifyGateCReleaseTransfer({ metadata, bytes, sha256: observedSha256 } = {}) {
  const normalized = normalizeGateCReleaseMetadata(metadata);
  if (!Number.isSafeInteger(bytes) || bytes !== normalized.artifact.bytes) {
    throw new Error('release artifact byte count does not match metadata');
  }
  if (sha256(observedSha256, 'observed release artifact digest') !== normalized.artifact.sha256) {
    throw new Error('release artifact digest does not match metadata');
  }
  return normalized;
}
