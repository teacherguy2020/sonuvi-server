#!/usr/bin/env node
import path from 'node:path';

import { buildReleaseArtifact, resolveSourceWorktree } from '../src/lib/release-artifact.mjs';

function values(name) {
  const result = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) result.push(String(process.argv[index + 1] || '').trim());
  }
  return result;
}

function value(name) {
  return values(name).at(-1) || '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const sourceWorktree = required('--source-worktree');
const outputRoot = required('--output-root');
const dependencyRoot = required('--dependency-root');
const allowDirtySnapshot = process.argv.includes('--allow-dirty-snapshot');
const production = process.argv.includes('--production');
if (production && allowDirtySnapshot) throw new Error('production releases cannot use development-only dirty snapshots');

const source = await resolveSourceWorktree({ sourceWorktree });
if (production && source.dirty) {
  throw new Error('production release policy requires a reviewed clean Git revision or separately approved signed snapshot');
}

const result = await buildReleaseArtifact({
  sourceWorktree,
  outputRoot,
  dependencyRoot,
  allowDirtySnapshot,
  approvedUntracked: values('--approved-untracked'),
  buildTimestamp: value('--build-timestamp') || new Date().toISOString(),
  builderVersion: value('--builder-version') || 'sonuvi-h3-release-builder',
});
process.stdout.write(`${JSON.stringify({
  releaseId: result.releaseId,
  artifactRoot: path.resolve(result.artifactRoot),
  source: {
    branch: result.manifest.source.branch,
    gitHead: result.manifest.source.gitHead,
    gitTree: result.manifest.source.gitTree,
    dirty: result.manifest.source.dirty,
    snapshotStatus: result.manifest.source.snapshotStatus,
    snapshotContentHash: result.manifest.source.snapshotContentHash,
  },
}, null, 2)}\n`);
