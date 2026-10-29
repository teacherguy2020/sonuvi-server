#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { verifyReleaseArtifact } from '../src/lib/release-artifact.mjs';

const artifactRoot = String(process.env.SONUVI_RELEASE_ROOT || process.cwd()).trim();
if (!path.isAbsolute(artifactRoot)) throw new Error('SONUVI_RELEASE_ROOT must be an absolute path when set');
const verified = await verifyReleaseArtifact({ artifactRoot });
const expected = String(process.env.SONUVI_RELEASE_ID || '').trim();
if (expected && expected !== verified.releaseId) throw new Error('current release manifest does not match SONUVI_RELEASE_ID');
const activationStatePath = String(process.env.SONUVI_ACTIVATION_STATE || '').trim();
if (activationStatePath) {
  if (!path.isAbsolute(activationStatePath)) throw new Error('SONUVI_ACTIVATION_STATE must be an absolute path when set');
  let state;
  try {
    state = JSON.parse(await fs.readFile(activationStatePath, 'utf8'));
  } catch {
    throw new Error('configured activation state is unavailable or invalid');
  }
  const permitted = new Set(['pointer-switched', 'services-restarted', 'services-verified', 'health-passed', 'committed']);
  if (!permitted.has(String(state?.phase || '')) || state?.candidateReleaseId !== verified.releaseId) {
    throw new Error('activation state does not permit this release service to start');
  }
}
process.stdout.write(`verified ${verified.releaseId}\n`);
