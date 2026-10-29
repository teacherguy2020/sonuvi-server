#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import {
  resolveSourceWorktree,
  writeTargetDependencyMetadata,
} from '../src/lib/release-artifact.mjs';

const execFile = promisify(execFileCallback);

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

async function command(binary, args) {
  const { stdout } = await execFile(binary, args, { maxBuffer: 8 * 1024 * 1024 });
  return String(stdout || '').trim();
}

const sourceWorktree = required('--source-worktree');
const outputRoot = required('--output-root');
const targetImage = value('--target-image') || 'node:20.19.5-bookworm-slim';
const allowDirtySnapshot = process.argv.includes('--allow-dirty-snapshot');
if (!path.isAbsolute(outputRoot)) throw new Error('--output-root must be absolute');
const source = await resolveSourceWorktree({ sourceWorktree });
if (source.dirty && !allowDirtySnapshot) {
  throw new Error('dirty source dependencies require --allow-dirty-snapshot and remain development-only');
}
try {
  await fs.lstat(outputRoot);
  throw new Error(`dependency output already exists: ${outputRoot}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });

// Docker Desktop on the M4 runs this Linux/ARM64 image natively. The source
// mount is read-only; npm writes only the explicitly supplied local output.
await command('docker', ['pull', '--platform', 'linux/arm64', targetImage]);
const imageDigest = await command('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', targetImage]);
const containerNode = await command('docker', ['run', '--rm', '--platform', 'linux/arm64', targetImage, 'node', '--version']);
const containerNpm = await command('docker', ['run', '--rm', '--platform', 'linux/arm64', targetImage, 'npm', '--version']);
const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
const gid = typeof process.getgid === 'function' ? String(process.getgid()) : '0';
const shell = [
  'set -eu',
  'mkdir -p /tmp/work /tmp/npm-cache',
  'cp /source/package.json /source/package-lock.json /tmp/work/',
  'cd /tmp/work',
  'npm ci --omit=dev --include=optional',
  'node -e "const sharp=require(\'sharp\'); if (!sharp) process.exit(1)"',
  'cp -a node_modules /output/node_modules',
].join('\n');
await command('docker', [
  'run', '--rm', '--platform', 'linux/arm64', '--user', `${uid}:${gid}`,
  '-e', 'HOME=/tmp',
  '-e', 'npm_config_cache=/tmp/npm-cache',
  '-v', `${source.root}:/source:ro`,
  '-v', `${path.resolve(outputRoot)}:/output`,
  targetImage, 'sh', '-lc', shell,
]);

const metadata = await writeTargetDependencyMetadata({
  dependencyRoot: outputRoot,
  packageLockPath: path.join(source.root, 'package-lock.json'),
  target: { os: 'linux', architecture: 'arm64' },
  nodeVersion: containerNode,
  npmVersion: containerNpm,
  buildEnvironment: {
    method: 'docker-linux-arm64',
    image: targetImage,
    imageDigest,
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    sourceDirty: source.dirty,
    sourceHead: source.head,
    sourceTree: source.tree,
  },
});
process.stdout.write(`${JSON.stringify({
  dependencyRoot: path.resolve(outputRoot),
  target: metadata.target,
  nodeVersion: metadata.nodeVersion,
  npmVersion: metadata.npmVersion,
  imageDigest,
  dependencyFilesHash: metadata.dependencyFilesHash,
}, null, 2)}\n`);
