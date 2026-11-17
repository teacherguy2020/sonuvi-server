#!/usr/bin/env node
// Anonymous public-distribution proof. Never connects to an installation target.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifySignedGateCReleaseMetadata } from '../src/lib/sonuvi-gate-c-release.mjs';
import { loadGateCLabDistribution } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

const releaseId = 'sonuvi-8f9324e7adb529e6c7c31bef03e687e7f35754cdc7608be29414dbb60f79229b';
const tag = 'server-installer-2026.11.17-no-deadline-8f9324e7';
const base = `https://github.com/teacherguy2020/sonuvi-server/releases/download/${tag}/`;
const expected = {
  archive: '7321b2bf97f1056f00a7af83fbc76e800b7fda3ba4e46baedebbdeef8df0687a',
  archiveBytes: 54049280,
  bootstrap: 'bbd774b4ba3cb64cbcf3c12cf2035d895a2bdbcfc89979c1d68f2040b4e65b27',
  envelope: '5ecfe42cef50f6aa87f7069c1f0ee13f3dd075dc19968a82c97e1df84471bdad',
  manifest: 'f727357f239884689eacc10dfae0c0770bebef09ba1e6ed441f53a15de8e7648',
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
