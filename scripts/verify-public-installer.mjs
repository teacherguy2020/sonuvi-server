#!/usr/bin/env node
// Anonymous public-distribution proof. Never connects to an installation target.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifySignedGateCReleaseMetadata } from '../src/lib/sonuvi-gate-c-release.mjs';
import { loadGateCLabDistribution } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

const releaseId = 'sonuvi-2f5fe4d12b5d6a28145ec7c037b07d5f87b9dfd1df7ae09f67308053bfb2374c';
const tag = 'server-installer-2026.11.15-no-deadline-2f5fe4d1';
const base = `https://github.com/teacherguy2020/sonuvi-server/releases/download/${tag}/`;
const expected = {
  archive: 'a11707593c4b515bc0832a0483ee8bb31de34444d34092c2a43a61fb277da946',
  archiveBytes: 54042112,
  bootstrap: '25f19c773ef12330a7435094bf2514e3e03ee82363b130e0e10cf90cd6ddd9ab',
  envelope: 'fb27dca9b8289cbd7be952acaee653bf2f3ec728b9d9bc4b8dcf38f524c182e8',
  manifest: 'de8e58e5b75ecaba65cfd78559391dd951420b7bfd0c326cabe080a7b014158a',
  signer: 'w7kQBpYG5LGnoJvbAdiN1O7pde8QZkdEoJU0sIFjYkg',
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
  console.log(JSON.stringify({ verified: true, authenticated: false, tag, releaseId,
    expiresAt: verified.expiresAt, assets: [...verified.assets.values()].map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }, null, 2));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
