import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, makeTreeWritableForCleanup } from '../src/lib/release-artifact.mjs';
import { GATE_C_RELEASE_ENVELOPE_CONTRACT, GATE_C_RELEASE_METADATA_CONTRACT, GATE_C_RELEASE_TRANSFER_FORMAT } from '../src/lib/sonuvi-gate-c-release.mjs';
import { normalizeGateCStageRequest, stageGateCReleaseArchive } from '../src/lib/sonuvi-gate-c-staging.mjs';

const releaseId = `sonuvi-${'a'.repeat(64)}`;
const artifact = Buffer.from('immutable release transfer bytes');
const manifest = Buffer.from('{"contract":"sonuvi.release-manifest.v1"}\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-gate-c-stage-'));
  t.after(async () => {
    const finalRoot = path.join(root, 'releases', releaseId);
    await makeTreeWritableForCleanup(finalRoot).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function signedRequest({ artifactSha256 = crypto.createHash('sha256').update(artifact).digest('hex') } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const payload = {
    contract: GATE_C_RELEASE_METADATA_CONTRACT,
    releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { format: GATE_C_RELEASE_TRANSFER_FORMAT, sha256: artifactSha256, bytes: artifact.length },
    bootstrap: { version: 1, sha256: 'b'.repeat(64) },
    issuedAt: '2026-11-05T00:00:00.000Z',
    expiresAt: '2026-11-12T00:00:00.000Z',
  };
  return {
    request: {
      operation: 'stage_release',
      envelope: {
        contract: GATE_C_RELEASE_ENVELOPE_CONTRACT,
        keyId: 'sonuvi-release-2026',
        payload,
        signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64url'),
      },
    },
    anchors: { 'sonuvi-release-2026': pair.publicKey.export({ format: 'pem', type: 'spki' }) },
  };
}

function stream(bytes = artifact) {
  return (async function* values() {
    yield bytes.subarray(0, 7);
    yield bytes.subarray(7);
  }());
}

test('staging accepts one signed fixed archive stream and promotes an immutable release', async (t) => {
  const root = await fixture(t);
  const { request, anchors } = signedRequest();
  const paths = { uploadRoot: path.join(root, 'uploads'), releaseRoot: path.join(root, 'releases') };
  let extracts = 0;
  const extractArchive = async ({ archivePath, outputRoot }) => {
    extracts += 1;
    assert.equal(await fs.readFile(archivePath, 'utf8'), artifact.toString('utf8'));
    await fs.writeFile(path.join(outputRoot, 'release-manifest.json'), manifest);
    await fs.writeFile(path.join(outputRoot, 'payload.txt'), 'verified');
  };
  const verifyArtifact = async ({ artifactRoot }) => {
    assert.equal(await fs.readFile(path.join(artifactRoot, 'release-manifest.json'), 'utf8'), manifest.toString('utf8'));
    return { releaseId };
  };
  const result = await stageGateCReleaseArchive({ request, archive: stream(), trustedAnchors: anchors, paths, extractArchive, verifyArtifact });
  assert.equal(result.state, 'staged');
  assert.equal(extracts, 1);
  assert.equal((await fs.stat(result.releaseRoot)).mode & 0o777, 0o555);
  const retry = await stageGateCReleaseArchive({ request, archive: stream(), trustedAnchors: anchors, paths, extractArchive, verifyArtifact });
  assert.equal(retry.state, 'already_staged');
  assert.equal(extracts, 1);
});

test('staging fails before extraction for a digest mismatch or unapproved request field', async (t) => {
  const root = await fixture(t);
  const { request, anchors } = signedRequest({ artifactSha256: 'c'.repeat(64) });
  const paths = { uploadRoot: path.join(root, 'uploads'), releaseRoot: path.join(root, 'releases') };
  let extracted = false;
  await assert.rejects(stageGateCReleaseArchive({ request, archive: stream(), trustedAnchors: anchors, paths, extractArchive: async () => { extracted = true; } }), /digest/);
  assert.equal(extracted, false);
  assert.throws(() => normalizeGateCStageRequest({ ...request, path: '/tmp/evil' }), /unsupported/);
});
