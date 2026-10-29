#!/usr/bin/env node
import { stageReleaseArtifact } from '../src/lib/release-artifact.mjs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const artifactRoot = value('--artifact-root');
const layoutRoot = value('--layout-root');
if (!artifactRoot || !layoutRoot) throw new Error('--artifact-root and --layout-root are required');
const staged = await stageReleaseArtifact({ artifactRoot, layoutRoot });
process.stdout.write(`${JSON.stringify({ releaseId: staged.releaseId, releaseRoot: staged.releaseRoot, staged: true }, null, 2)}\n`);
