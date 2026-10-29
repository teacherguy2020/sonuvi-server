#!/usr/bin/env node
import { verifyReleaseArtifact } from '../src/lib/release-artifact.mjs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const artifactRoot = value('--artifact-root');
if (!artifactRoot) throw new Error('--artifact-root is required');
const verified = await verifyReleaseArtifact({ artifactRoot });
process.stdout.write(`${JSON.stringify({ releaseId: verified.releaseId, verified: true }, null, 2)}\n`);
