#!/usr/bin/env node
import path from 'node:path';

import { promoteStagedHostRelease } from '../src/lib/release-artifact.mjs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const layoutRoot = value('--layout-root');
const stagingRoot = value('--staging-root');
if (!layoutRoot || !stagingRoot) throw new Error('--layout-root and --staging-root are required');
if (path.resolve(layoutRoot) !== '/opt/sonuvi') {
  throw new Error('host release promotion is restricted to /opt/sonuvi');
}
const promoted = await promoteStagedHostRelease({ layoutRoot, stagingRoot });
process.stdout.write(`${JSON.stringify({
  releaseId: promoted.releaseId,
  releaseRoot: promoted.releaseRoot,
  promoted: true,
  currentChanged: false,
}, null, 2)}\n`);
