import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  verifyReleaseArtifact,
  verifyReleaseRuntimeImportClosure,
} from '../src/lib/release-artifact.mjs';

const execFile = promisify(execFileCallback);
const historicalArchive = process.env.SONUVI_HISTORICAL_RELEASE_ARCHIVE
  || '/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912/sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912-linux-arm64.tar';
const currentArchive = process.env.SONUVI_V2_RELEASE_ARCHIVE
  || '/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66/sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66-linux-arm64.tar';

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function extractArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  await execFile('/usr/bin/tar', ['-xf', archive, '-C', destination], { maxBuffer: 1024 * 1024 });
}

test('real historical release and v2 release use distinct runtime closure contracts', async (t) => {
  if (!await exists(historicalArchive) || !await exists(currentArchive)) {
    t.skip(`real release archives unavailable: ${historicalArchive} and ${currentArchive}`);
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-historical-compatibility-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const historicalRoot = path.join(root, 'historical');
  const currentRoot = path.join(root, 'current');
  await extractArchive(historicalArchive, historicalRoot);
  await extractArchive(currentArchive, currentRoot);

  const historicalManifest = JSON.parse(await fs.readFile(path.join(historicalRoot, 'release-manifest.json'), 'utf8'));
  assert.equal(historicalManifest.releaseId, 'sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912');
  assert.equal(historicalManifest.verifier.runtimeContract, undefined);
  assert.equal(await exists(path.join(historicalRoot, 'scripts/sonuvi-admin-session.mjs')), false);
  const historicalClosure = await verifyReleaseRuntimeImportClosure({ artifactRoot: historicalRoot });
  assert.equal(historicalClosure.files.includes('scripts/sonuvi-admin-session.mjs'), false);
  assert.equal((await verifyReleaseArtifact({ artifactRoot: historicalRoot })).releaseId, historicalManifest.releaseId);

  const currentManifest = JSON.parse(await fs.readFile(path.join(currentRoot, 'release-manifest.json'), 'utf8'));
  assert.equal(currentManifest.releaseId, 'sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66');
  assert.equal(await exists(path.join(currentRoot, 'scripts/sonuvi-admin-session.mjs')), true);
  const currentClosure = await verifyReleaseRuntimeImportClosure({ artifactRoot: currentRoot });
  assert.equal(currentClosure.files.includes('scripts/sonuvi-admin-session.mjs'), true);
  assert.equal((await verifyReleaseArtifact({ artifactRoot: currentRoot })).releaseId, currentManifest.releaseId);

  // A recorded historical entrypoint remains mandatory and tamper-evident.
  const historicalBootstrap = path.join(historicalRoot, 'scripts/sonuvi-admin-bootstrap.mjs');
  const historicalBootstrapBytes = await fs.readFile(historicalBootstrap);
  await fs.unlink(historicalBootstrap);
  await assert.rejects(verifyReleaseArtifact({ artifactRoot: historicalRoot }), /file inventory/);
  await fs.writeFile(historicalBootstrap, historicalBootstrapBytes);

  // New v2 releases must retain the administrator-session entrypoint.
  const adminSession = path.join(currentRoot, 'scripts/sonuvi-admin-session.mjs');
  const adminSessionBytes = await fs.readFile(adminSession);
  await fs.unlink(adminSession);
  await assert.rejects(verifyReleaseArtifact({ artifactRoot: currentRoot }), /file inventory/);
  await fs.writeFile(adminSession, adminSessionBytes);

  // A byte change is rejected even when the path remains present.
  await fs.writeFile(adminSession, Buffer.concat([adminSessionBytes, Buffer.from('\n// tampered\n')]));
  await assert.rejects(verifyReleaseArtifact({ artifactRoot: currentRoot }), /file inventory|identity/);
  await fs.writeFile(adminSession, adminSessionBytes);

  // A v2 manifest cannot downgrade its required entrypoint set.
  currentManifest.verifier = {
    ...currentManifest.verifier,
    runtimeContract: 'sonuvi.release-runtime.v2',
    requiredRuntimeEntrypoints: currentManifest.verifier.requiredRuntimeEntrypoints
      ? currentManifest.verifier.requiredRuntimeEntrypoints.filter((entry) => entry !== 'scripts/sonuvi-admin-session.mjs')
      : ['moode-nowplaying-api.mjs'],
  };
  await fs.chmod(path.join(currentRoot, 'release-manifest.json'), 0o644);
  await fs.writeFile(path.join(currentRoot, 'release-manifest.json'), `${JSON.stringify(currentManifest)}\n`);
  await assert.rejects(verifyReleaseArtifact({ artifactRoot: currentRoot }), /runtime contract|runtime entrypoints/);
});
