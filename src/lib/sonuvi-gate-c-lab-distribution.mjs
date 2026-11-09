import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { verifySignedGateCReleaseMetadata } from './sonuvi-gate-c-release.mjs';

export const GATE_C_LAB_DISTRIBUTION_CONTRACT = 'sonuvi.gate-c-lab-distribution.v1';
export const GATE_C_LAB_DISTRIBUTION_PREFIX = '/v1/gate-c/releases';
export const GATE_C_LAB_MAX_RELEASE_BYTES = 8 * 1024 * 1024 * 1024;
export const GATE_C_LAB_MAX_BOOTSTRAP_BYTES = 16 * 1024 * 1024;
export const GATE_C_LAB_TRUSTED_LAN_CIDR = '10.0.0.0/16';

const STATIC_HEADERS = Object.freeze({
  'accept-ranges': 'none',
  'cache-control': 'public, max-age=31536000, immutable',
  'content-security-policy': "default-src 'none'",
  'cross-origin-resource-policy': 'same-site',
  'x-content-type-options': 'nosniff',
});

function text(value) {
  return String(value ?? '').trim();
}

/**
 * The lab listener is bound to an IPv4 address on the trusted 10.0.0.0/16
 * network. Keep the source check separate from TLS: it narrows who can reach
 * the fixed read-only endpoint but is not an authentication substitute.
 */
export function isGateCLabTrustedLanAddress(value) {
  let address = text(value).toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  return numbers[0] === 10 && numbers[1] === 0;
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unsupported fields`);
}

function releaseRootPath(value) {
  const input = text(value);
  if (!input || !path.isAbsolute(input)) throw new Error('lab distribution release root must be absolute');
  const result = path.resolve(input);
  return result;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function regularFile(root, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('lab distribution artifact name is invalid');
  const file = path.resolve(root, name);
  if (!contained(root, file)) throw new Error('lab distribution artifact escapes release root');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`lab distribution artifact is not a regular file: ${name}`);
  return Object.freeze({ name, file, bytes: stat.size });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fsSync.createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return Object.freeze({ bytes, sha256: hash.digest('hex') });
}

function parseChecksums(input, expectedNames) {
  const values = new Map();
  for (const line of String(input || '').split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || values.has(match[2])) throw new Error('lab distribution checksum manifest is invalid');
    values.set(match[2], match[1]);
  }
  if (values.size !== expectedNames.length || expectedNames.some((name) => !values.has(name))) {
    throw new Error('lab distribution checksum manifest does not cover the fixed artifact set');
  }
  return values;
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.tar')) return 'application/x-tar';
  if (name.endsWith('.pem')) return 'application/x-pem-file';
  if (name.endsWith('.sha256')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.md')) return 'text/markdown; charset=utf-8';
  throw new Error(`lab distribution content type is not allowlisted: ${name}`);
}

function spkiSha256(publicKey) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('base64url');
}

/**
 * Load one already-published, immutable lab kit. This validates its exact
 * allowlist and bytes before any TLS listener can start; request paths never
 * participate in filesystem resolution.
 */
export async function loadGateCLabDistribution({ releaseRoot } = {}) {
  const requestedRoot = releaseRootPath(releaseRoot);
  const rootStat = await fs.lstat(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('lab distribution release root is invalid');
  const root = await fs.realpath(requestedRoot);

  const envelopeFile = await regularFile(root, 'release-envelope.json');
  const anchorFile = await regularFile(root, 'release-trust-anchors.json');
  const [envelope, anchors] = await Promise.all([
    fs.readFile(envelopeFile.file, 'utf8').then(JSON.parse),
    fs.readFile(anchorFile.file, 'utf8').then(JSON.parse),
  ]);
  const verified = verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: anchors });
  const { metadata, keyId } = verified;
  if (path.basename(root) !== metadata.releaseId) throw new Error('lab distribution release root identity mismatch');

  const releaseArchiveName = `${metadata.releaseId}-linux-arm64.tar`;
  // Preserve the v1 immutable first-install kit while exposing the separately
  // signed v2 host-upgrade kit through the same fixed, read-only endpoint.
  const bootstrapName = `sonuvi-bootstrap-kit-v${metadata.bootstrap.version}.tar`;
  const publicKeyName = `${keyId}-public.pem`;
  const handoffName = 'ios-integration-handoff.json';
  const checksumName = 'CHECKSUMS.sha256';
  const readmeName = 'LAB-README.md';
  const checksumNames = [releaseArchiveName, bootstrapName, 'release-envelope.json', 'release-trust-anchors.json', publicKeyName, handoffName, readmeName];
  const [releaseArchive, bootstrap, publicKey, handoff, checksums, readme] = await Promise.all([
    regularFile(root, releaseArchiveName),
    regularFile(root, bootstrapName),
    regularFile(root, publicKeyName),
    regularFile(root, handoffName),
    regularFile(root, checksumName),
    regularFile(root, readmeName),
  ]);
  if (releaseArchive.bytes > GATE_C_LAB_MAX_RELEASE_BYTES || bootstrap.bytes > GATE_C_LAB_MAX_BOOTSTRAP_BYTES) {
    throw new Error('lab distribution artifact exceeds fixed transfer limit');
  }
  const expectedChecksums = parseChecksums(await fs.readFile(checksums.file, 'utf8'), checksumNames);
  const files = [envelopeFile, anchorFile, releaseArchive, bootstrap, publicKey, handoff, readme];
  const observed = new Map();
  for (const item of files) {
    const value = await sha256File(item.file);
    if (value.bytes !== item.bytes || value.sha256 !== expectedChecksums.get(item.name)) {
      throw new Error(`lab distribution checksum mismatch: ${item.name}`);
    }
    observed.set(item.name, Object.freeze({ ...item, ...value }));
  }
  const release = observed.get(releaseArchiveName);
  const bootstrapArtifact = observed.get(bootstrapName);
  if (release.bytes !== metadata.artifact.bytes || release.sha256 !== metadata.artifact.sha256) {
    throw new Error('lab distribution release archive does not match signed metadata');
  }
  if (bootstrapArtifact.sha256 !== metadata.bootstrap.sha256) throw new Error('lab distribution bootstrap kit does not match signed metadata');

  const handoffBody = JSON.parse(await fs.readFile(handoff.file, 'utf8'));
  sameKeys(handoffBody, ['bootstrap', 'contract', 'expiresAt', 'keyId', 'labOnly', 'release', 'spkiSha256', 'status', 'transport'], 'lab distribution iOS handoff');
  if (handoffBody.contract !== 'sonuvi.gate-c-lab-install-kit.v1' || handoffBody.labOnly !== true
    || handoffBody.keyId !== keyId || handoffBody.release?.releaseId !== metadata.releaseId
    || handoffBody.release?.archive !== releaseArchiveName || handoffBody.bootstrap?.archive !== bootstrapName
    || handoffBody.bootstrap?.sha256 !== metadata.bootstrap.sha256 || handoffBody.expiresAt !== metadata.expiresAt) {
    throw new Error('lab distribution iOS handoff does not match signed metadata');
  }
  const publicPem = await fs.readFile(publicKey.file, 'utf8');
  if (anchors[keyId] !== publicPem || handoffBody.spkiSha256 !== spkiSha256(publicPem)) {
    throw new Error('lab distribution public trust material does not match its handoff');
  }

  const assets = new Map();
  for (const name of ['release-envelope.json', releaseArchiveName, bootstrapName, 'release-trust-anchors.json', publicKeyName, checksumName, handoffName, readmeName]) {
    const asset = name === checksumName ? checksums : observed.get(name);
    assets.set(name, Object.freeze({ name, file: asset.file, bytes: asset.bytes, sha256: name === checksumName ? await sha256File(asset.file).then((value) => value.sha256) : asset.sha256, contentType: contentType(name) }));
  }
  return Object.freeze({
    contract: GATE_C_LAB_DISTRIBUTION_CONTRACT,
    root,
    releaseId: metadata.releaseId,
    expiresAt: metadata.expiresAt,
    assets,
  });
}

export function resolveGateCLabDistributionRequest({ method, url, headers = {} } = {}, distribution) {
  const requestMethod = text(method).toUpperCase();
  if (requestMethod !== 'GET' && requestMethod !== 'HEAD') return Object.freeze({ status: 405, headers: { allow: 'GET, HEAD' } });
  const rawUrl = String(url || '');
  const prefix = `${GATE_C_LAB_DISTRIBUTION_PREFIX}/${distribution.releaseId}/`;
  if (!rawUrl.startsWith(prefix) || rawUrl.includes('?') || rawUrl.includes('#')) return Object.freeze({ status: 404, headers: {} });
  const name = rawUrl.slice(prefix.length);
  const asset = distribution.assets.get(name);
  if (!asset) return Object.freeze({ status: 404, headers: {} });
  if (headers.range) return Object.freeze({ status: 416, headers: { 'accept-ranges': 'none', 'content-range': `bytes */${asset.bytes}` } });
  return Object.freeze({ status: 200, asset, headers: { ...STATIC_HEADERS, 'content-length': String(asset.bytes), 'content-type': asset.contentType, etag: `"sha256-${asset.sha256}"` } });
}

export function createGateCLabDistributionHandler(distribution, { isTrustedRemoteAddress = () => true } = {}) {
  if (typeof isTrustedRemoteAddress !== 'function') throw new Error('lab distribution remote-address policy is invalid');
  return (request, response) => {
    request.resume();
    if (!isTrustedRemoteAddress(request.socket?.remoteAddress)) {
      response.writeHead(403, {
        'cache-control': 'no-store',
        'content-length': '0',
        'content-security-policy': "default-src 'none'",
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return;
    }
    const result = resolveGateCLabDistributionRequest(request, distribution);
    if (result.status !== 200) {
      response.writeHead(result.status, result.headers);
      response.end();
      return;
    }
    response.writeHead(200, result.headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fsSync.createReadStream(result.asset.file, { flags: 'r' });
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  };
}

export async function createGateCLabDistributionServer({ releaseRoot, tls, isTrustedRemoteAddress } = {}) {
  if (!tls?.key || !tls?.cert) throw new Error('lab distribution TLS key and certificate are required');
  const distribution = await loadGateCLabDistribution({ releaseRoot });
  const server = https.createServer(
    { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' },
    createGateCLabDistributionHandler(distribution, { isTrustedRemoteAddress }),
  );
  return Object.freeze({ distribution, server });
}
