#!/usr/bin/env node
// Anonymous public-distribution proof. Never connects to an installation target.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifySignedGateCReleaseMetadata } from '../src/lib/sonuvi-gate-c-release.mjs';
import { loadGateCLabDistribution } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

const releaseId = 'sonuvi-e321c4aa2b620eb75b4a61d3b5d5aee2fb5b578c8000fb99f01d5e90fff54ec5';
const tag = 'server-installer-2026.11.20-no-deadline-e321c4aa';
const base = `https://github.com/teacherguy2020/sonuvi-server/releases/download/${tag}/`;
const expected = {
  archive: 'a69048f35d9d1b9ede77259f05143da227aa14393d251e6e7aba9e3919053ace',
  archiveBytes: 54076928,
  bootstrap: '7d57ff9308303ed1612f38a9c2335bae2ed051d73c4d53491aef8294c2f6e92d',
  envelope: '0a9469be39ba490460673be14d47ba1f2685c3867d4852fed8822f42da858290',
  manifest: '2285b4f11591d5e9cdb489e8b23361a94b094b9fe37c3c8147fa0ef3543f9653',
  signer: 'w7kQBpYG5LGnoJvbAdiN1O7pde8QZkdEoJU0sIFjYkg',
};
const expectedSource = '9781e2a65b34f34a54fb1a7780a4dfed8581682a';
const expectedRuntimeFiles = {
  "src/routes/mobile.routes.mjs": "8b7666571b66d6eeac7a13987e319adcae2da3e452c656eb1b86b37a3ed70d07",
  "src/lib/sonuvi-device-sessions.mjs": "706507937f71cd58a65cd6cfe8d5ff692d356431c360348303b5cb08ab5df7a9",
  "src/lib/device-connection-details.mjs": "a4f23e2ad575217d892a6d932716cf01ef5a9900a9818cd46946eddb9737ec17",
  "src/lib/sonuvi-remote-access.mjs": "832b8f001f22da1932754e346710baf08439638c8ca7b28483863c3afb4a09e6",
  "src/routes/config.queue-wizard-vibe.routes.mjs": "6a2cc6524d923c92f2a61b80780ddd5e1c009b8bade7d11d1b9f9d82c0aa756c",
  "vibe_planner.py": "93757a4cae91394ae9903b36e66b587f2127ff8cd865228f341e18989624771d"
};
const archive = `${releaseId}-linux-arm64.tar`;
const names = ['CHECKSUMS.sha256', 'LAB-README.md', 'ios-integration-handoff.json',
  'release-envelope.json', 'release-trust-anchors.json', 'sonuvi-bootstrap-kit-v1.tar',
  archive, 'sonuvi-lab-gate-c-20261105-public.pem'];
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-public-installer-'));
const releaseRoot = path.join(scratch, releaseId);
await fs.mkdir(releaseRoot);
try {
  for (const name of names) {
    const initial = new URL(name, base);
    let url = initial;
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
        || !(url.href === initial.href || (url.hostname === 'release-assets.githubusercontent.com'
          && url.pathname.startsWith('/github-production-release-asset/')))) throw new Error('Unexpected download origin');
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Missing redirect location');
        url = new URL(location, url);
        continue;
      }
      break;
    }
    if (response?.status !== 200) throw new Error(`Public asset unavailable: ${name}`);
    const limit = name === archive ? expected.archiveBytes : 16 * 1024 * 1024;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error(`Public asset too large: ${name}`);
      chunks.push(chunk);
    }
    await fs.writeFile(path.join(releaseRoot, name), Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  }
  const publicKey = await fs.readFile(path.join(releaseRoot, names.at(-1)));
  const signer = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey)
    .export({ type: 'spki', format: 'der' })).digest('base64url');
  if (signer !== expected.signer) throw new Error('Untrusted signer');
  const verified = await loadGateCLabDistribution({ releaseRoot });
  const envelope = JSON.parse(await fs.readFile(path.join(releaseRoot, 'release-envelope.json')));
  const metadata = envelope.payload;
  if (metadata.expiresAt !== null) throw new Error('Public installer must have no deadline');
  const trustedAnchors = { [envelope.keyId]: publicKey.toString('utf8') };
  for (const date of ['2026-12-16', '2100-01-01', '2500-01-01']) {
    verifySignedGateCReleaseMetadata({ envelope, trustedAnchors, now: Date.parse(date) });
  }
  if (verified.releaseId !== releaseId || metadata.manifestSha256 !== expected.manifest
    || verified.assets.get(archive).sha256 !== expected.archive
    || verified.assets.get(archive).bytes !== expected.archiveBytes
    || verified.assets.get('sonuvi-bootstrap-kit-v1.tar').sha256 !== expected.bootstrap
    || verified.assets.get('release-envelope.json').sha256 !== expected.envelope) throw new Error('Compiled package identity mismatch');
  // Inspect only authenticated archive members through stdout; never install or
  // extract arbitrary paths. Prove this installer contains the reviewed fixes.
  const member = name => execFileSync('tar', ['-xOf', path.join(releaseRoot, archive), './' + name], { maxBuffer: 16 * 1024 * 1024 });
  const installedManifest = JSON.parse(member('release-manifest.json'));
  if (installedManifest.releaseId !== releaseId || installedManifest.source.gitHead !== expectedSource || installedManifest.source.dirty) throw new Error('Installer source identity mismatch');
  for (const [name, hash] of Object.entries(expectedRuntimeFiles)) {
    if (crypto.createHash('sha256').update(member(name)).digest('hex') !== hash) throw new Error('Installer fix missing: ' + name);
  }
  console.log(JSON.stringify({ sourceCommit: expectedSource, runtimeFilesVerified: Object.keys(expectedRuntimeFiles), verified: true, authenticated: false, tag, releaseId,
    expiresAt: verified.expiresAt, assets: [...verified.assets.values()].map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }, null, 2));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
