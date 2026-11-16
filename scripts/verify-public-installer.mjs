#!/usr/bin/env node
// Anonymous public-distribution proof. Never connects to an installation target.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadGateCLabDistribution } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

const releaseId = 'sonuvi-d43214c4bab3000d469b39fcb2d55cff4a2832c95a538a0f7c13d8288e6fde53';
const tag = 'server-installer-2026.11.15-d43214c4';
const base = `https://github.com/teacherguy2020/sonuvi-server/releases/download/${tag}/`;
const expected = {
  archive: 'b166f72982363ba43053c4d337b21244f282ce761b08ff89fa943b6efad996d1',
  archiveBytes: 54042112,
  bootstrap: '09dbd046a4a0d698b41f87fe7aca9ccbd103c5b3d9311fae7892fc6d81095c95',
  envelope: '5b0f32c043fdff1243ca7c9adbfcdd25f882b3f7ff5f1f7d84b8e71826d4bfdc',
  manifest: '44774849f3f0ff788ed0e1401a610a572d58e141df85561c1c6e1142a94640c4',
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
  const metadata = JSON.parse(await fs.readFile(path.join(releaseRoot, 'release-envelope.json'))).payload;
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
