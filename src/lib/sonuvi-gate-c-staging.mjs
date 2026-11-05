import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { makeTreeReadOnly, verifyReleaseArtifact } from './release-artifact.mjs';
import { verifyGateCReleaseTransfer, verifySignedGateCReleaseMetadata } from './sonuvi-gate-c-release.mjs';

const execFile = promisify(execFileCallback);

export const GATE_C_STAGE_PATHS = Object.freeze({
  uploadRoot: '/var/lib/sonuvi-bootstrap/uploads',
  releaseRoot: '/var/lib/sonuvi-bootstrap/releases',
});

function text(value) {
  return String(value ?? '').trim();
}

function absolute(value, label) {
  const result = text(value);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unsupported fields`);
}

async function ensureRoot(root, mode) {
  await fs.mkdir(root, { recursive: true, mode });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('release staging root is invalid');
  return root;
}

async function fileExists(file) {
  return fs.lstat(file).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
}

async function defaultExtractArchive({ archivePath, outputRoot }) {
  // Paths and arguments are fixed; the client controls only authenticated
  // archive bytes. Signature and byte/digest verification occur first.
  await execFile('/usr/bin/tar', [
    '--extract', '--file', archivePath, '--directory', outputRoot,
    '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
  ], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
}

async function writeVerifiedArchive({ archive, filePath, metadata }) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of archive) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > metadata.artifact.bytes) throw new Error('release artifact byte count exceeds metadata');
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  verifyGateCReleaseTransfer({ metadata, bytes, sha256: digest.digest('hex') });
}

export function normalizeGateCStageRequest(input = {}) {
  sameKeys(input, ['envelope', 'operation'], 'release stage request');
  if (text(input.operation) !== 'stage_release') throw new Error('release stage operation is invalid');
  if (!input.envelope || typeof input.envelope !== 'object' || Array.isArray(input.envelope)) throw new Error('release metadata envelope is required');
  return Object.freeze({ operation: 'stage_release', envelope: input.envelope });
}

/**
 * Consume exactly one verified archive stream and stage it under its immutable
 * release ID. There are no caller-provided filesystem paths, URLs, commands,
 * or overwrite semantics. Retrying the same authenticated archive is safe.
 */
export async function stageGateCReleaseArchive({ request, archive, trustedAnchors, paths = GATE_C_STAGE_PATHS, verifyArtifact = verifyReleaseArtifact, extractArchive = defaultExtractArchive } = {}) {
  const input = normalizeGateCStageRequest(request);
  if (!archive || typeof archive[Symbol.asyncIterator] !== 'function') throw new Error('release archive stream is required');
  const { metadata, keyId } = verifySignedGateCReleaseMetadata({ envelope: input.envelope, trustedAnchors });
  const roots = Object.freeze({
    uploadRoot: absolute(paths.uploadRoot, 'release upload root'),
    releaseRoot: absolute(paths.releaseRoot, 'release root'),
  });
  await Promise.all([ensureRoot(roots.uploadRoot, 0o700), ensureRoot(roots.releaseRoot, 0o755)]);
  const archivePath = path.join(roots.uploadRoot, `.${metadata.releaseId}.${randomUUID()}.tar`);
  const finalRoot = path.join(roots.releaseRoot, metadata.releaseId);
  const extractionRoot = path.join(roots.releaseRoot, `.${metadata.releaseId}.${randomUUID()}.stage`);
  try {
    await writeVerifiedArchive({ archive, filePath: archivePath, metadata });
    if (await fileExists(finalRoot)) {
      const existing = await verifyArtifact({ artifactRoot: finalRoot });
      if (existing.releaseId !== metadata.releaseId) throw new Error('existing staged release identity mismatch');
      const manifest = await fs.readFile(path.join(finalRoot, 'release-manifest.json'));
      if (createHash('sha256').update(manifest).digest('hex') !== metadata.manifestSha256) {
        throw new Error('existing staged release manifest mismatch');
      }
      return Object.freeze({ state: 'already_staged', releaseId: metadata.releaseId, keyId, releaseRoot: finalRoot });
    }
    await fs.mkdir(extractionRoot, { recursive: false, mode: 0o700 });
    await extractArchive({ archivePath, outputRoot: extractionRoot });
    const manifest = await fs.readFile(path.join(extractionRoot, 'release-manifest.json'));
    if (createHash('sha256').update(manifest).digest('hex') !== metadata.manifestSha256) {
      throw new Error('staged release manifest digest mismatch');
    }
    const verified = await verifyArtifact({ artifactRoot: extractionRoot });
    if (verified.releaseId !== metadata.releaseId) throw new Error('staged release identity mismatch');
    await makeTreeReadOnly(extractionRoot);
    await fs.rename(extractionRoot, finalRoot);
    return Object.freeze({ state: 'staged', releaseId: metadata.releaseId, keyId, releaseRoot: finalRoot });
  } catch (error) {
    await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }
}
