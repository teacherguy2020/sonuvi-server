import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/lib/release-artifact.mjs';
import { loadGateCLabDistribution, resolveGateCLabDistributionRequest } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

const releaseId = `sonuvi-${'a'.repeat(64)}`;
const keyId = 'sonuvi-lab-test';

async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function fixture(t, { expiresAt = new Date(Date.now() + 60_000).toISOString() } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-gate-c-lab-distribution-'));
  const root = path.join(parent, releaseId);
  await fs.mkdir(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const archiveName = `${releaseId}-linux-arm64.tar`;
  const bootstrapName = 'sonuvi-bootstrap-kit-v1.tar';
  await fs.writeFile(path.join(root, archiveName), 'arm64 release bytes');
  await fs.writeFile(path.join(root, bootstrapName), 'bootstrap bytes');
  const payload = {
    contract: 'sonuvi.gate-c-release-metadata.v1',
    releaseId,
    manifestSha256: 'b'.repeat(64),
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { format: 'sonuvi.release-tar.v1', sha256: await sha256(path.join(root, archiveName)), bytes: (await fs.stat(path.join(root, archiveName))).size },
    bootstrap: { version: 1, sha256: await sha256(path.join(root, bootstrapName)) },
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
  };
  const envelope = { contract: 'sonuvi.gate-c-release-envelope.v1', keyId, payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url') };
  const spkiSha256 = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
  await fs.writeFile(path.join(root, 'release-envelope.json'), `${JSON.stringify(envelope)}\n`);
  await fs.writeFile(path.join(root, 'release-trust-anchors.json'), `${JSON.stringify({ [keyId]: publicPem })}\n`);
  await fs.writeFile(path.join(root, `${keyId}-public.pem`), publicPem);
  await fs.writeFile(path.join(root, 'ios-integration-handoff.json'), `${JSON.stringify({ contract: 'sonuvi.gate-c-lab-install-kit.v1', labOnly: true, keyId, spkiSha256, release: { releaseId, archive: archiveName }, bootstrap: { archive: bootstrapName, sha256: payload.bootstrap.sha256 }, expiresAt: payload.expiresAt, status: {}, transport: {} })}\n`);
  await fs.writeFile(path.join(root, 'LAB-README.md'), 'lab only\n');
  const checksumNames = [archiveName, bootstrapName, 'release-envelope.json', 'release-trust-anchors.json', `${keyId}-public.pem`, 'ios-integration-handoff.json', 'LAB-README.md'];
  await fs.writeFile(path.join(root, 'CHECKSUMS.sha256'), `${(await Promise.all(checksumNames.map(async (name) => `${await sha256(path.join(root, name))}  ${name}`))).join('\n')}\n`);
  return root;
}

test('lab distribution exposes only fixed immutable release artifacts and refuses Range', async (t) => {
  const root = await fixture(t);
  const distribution = await loadGateCLabDistribution({ releaseRoot: root });
  const prefix = `/v1/gate-c/releases/${releaseId}/`;
  const valid = resolveGateCLabDistributionRequest({ method: 'GET', url: `${prefix}release-envelope.json` }, distribution);
  assert.equal(valid.status, 200);
  assert.equal(valid.asset.name, 'release-envelope.json');
  assert.equal(valid.headers['accept-ranges'], 'none');
  assert.equal(resolveGateCLabDistributionRequest({ method: 'GET', url: `${prefix}LAB-README.md` }, distribution).headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(resolveGateCLabDistributionRequest({ method: 'HEAD', url: `${prefix}${releaseId}-linux-arm64.tar` }, distribution).status, 200);
  assert.equal(resolveGateCLabDistributionRequest({ method: 'GET', url: `${prefix}release-envelope.json`, headers: { range: 'bytes=1-' } }, distribution).status, 416);
  assert.equal(resolveGateCLabDistributionRequest({ method: 'POST', url: `${prefix}release-envelope.json` }, distribution).status, 405);
  assert.equal(resolveGateCLabDistributionRequest({ method: 'GET', url: `${prefix}../../etc/passwd` }, distribution).status, 404);
  assert.equal(resolveGateCLabDistributionRequest({ method: 'GET', url: `${prefix}release-envelope.json?redirect=https://elsewhere` }, distribution).status, 404);
  await assert.rejects(loadGateCLabDistribution({ releaseRoot: '' }), /release root must be absolute/);
});

test('lab distribution rejects checksum tampering and expired signed metadata before listening', async (t) => {
  const root = await fixture(t);
  await fs.appendFile(path.join(root, `${releaseId}-linux-arm64.tar`), 'tampered');
  await assert.rejects(loadGateCLabDistribution({ releaseRoot: root }), /checksum mismatch/);
  const expired = await fixture(t, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
  await assert.rejects(loadGateCLabDistribution({ releaseRoot: expired }), /expired/);
});
