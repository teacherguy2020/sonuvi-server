import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const GATE_C_BOOTSTRAP_KIT_CONTRACT = 'sonuvi.gate-c-bootstrap-kit.v1';
export const GATE_C_BOOTSTRAP_KIT_VERSION = 1;

// The status entrypoint is deliberately in this kit *and* the immutable
// release. It is the fixed reconnect-safe observation command before a staged
// release exists, and it remains available after the release is activated.
const SOURCE_FILES = Object.freeze([
  'scripts/sonuvi-bootstrap-status.mjs',
  'scripts/sonuvi-debian-node-bootstrap.sh',
  'scripts/sonuvi-release-stage.mjs',
  'src/lib/atomic-file.mjs',
  'src/lib/public-web-root.mjs',
  'src/lib/release-artifact.mjs',
  'src/lib/runtime-capabilities.mjs',
  'src/lib/runtime-config-security.mjs',
  'src/lib/sonuvi-bootstrap-contract.mjs',
  'src/lib/sonuvi-bootstrap-progress.mjs',
  'src/lib/sonuvi-bootstrap-status.mjs',
  'src/lib/sonuvi-fresh-install.mjs',
  'src/lib/sonuvi-gate-c-release.mjs',
  'src/lib/sonuvi-gate-c-staging.mjs',
]);

export const GATE_C_BOOTSTRAP_KIT_FILES = Object.freeze([
  'etc/sonuvi/release-trust-anchors.json',
  ...SOURCE_FILES,
].sort());

function parentDirectories(files) {
  const result = new Set(['.']);
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current && current !== '.') {
      result.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...result].sort();
}

export const GATE_C_BOOTSTRAP_KIT_EXTRACTED_TREE = Object.freeze([
  ...parentDirectories(GATE_C_BOOTSTRAP_KIT_FILES).map((entry) => entry === '.' ? '.' : `./${entry}`),
  './bootstrap-kit-manifest.json',
  ...GATE_C_BOOTSTRAP_KIT_FILES.map((entry) => `./${entry}`),
].sort());

function text(value) {
  return String(value ?? '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function absolute(value, label) {
  const result = text(value);
  if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(result);
}

function releaseId(value) {
  const result = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(result)) throw new Error('bootstrap kit release ID is invalid');
  return result;
}

function keyId(value) {
  const result = text(value);
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(result)) throw new Error('bootstrap kit key ID is invalid');
  return result;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function normalizedRelative(value, label) {
  const input = text(value);
  if (!input || path.isAbsolute(input) || input.includes('\\') || input.includes('\0')) throw new Error(`${label} is invalid`);
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`${label} escapes its root`);
  return normalized;
}

function stableAnchors(value, selectedKeyId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bootstrap kit trust anchors are invalid');
  const entries = Object.entries(value)
    .map(([name, pem]) => [keyId(name), text(pem)])
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length || !entries.some(([name]) => name === selectedKeyId) || entries.some(([, pem]) => !pem.includes('BEGIN PUBLIC KEY'))) {
    throw new Error('bootstrap kit trust anchors are invalid');
  }
  return Object.freeze(Object.fromEntries(entries));
}

async function regularSource(root, relative) {
  const normalized = normalizedRelative(relative, 'bootstrap kit source path');
  const candidate = path.join(root, normalized);
  if (!contained(root, candidate)) throw new Error('bootstrap kit source path escapes source root');
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`bootstrap kit source is not a regular file: ${normalized}`);
  const real = await fs.realpath(candidate);
  if (!contained(root, real)) throw new Error(`bootstrap kit source escapes source root: ${normalized}`);
  return Object.freeze({ path: normalized, source: candidate, stat });
}

async function writeRegular(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target);
  await fs.chmod(target, 0o600);
}

async function inventory(root, { includeManifest = false } = {}) {
  const files = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(child);
      if (stat.isDirectory()) {
        if (stat.isSymbolicLink()) throw new Error(`bootstrap kit directory is a symlink: ${childRelative}`);
        await visit(child, childRelative);
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`bootstrap kit entry is not a regular file: ${childRelative}`);
      if (!includeManifest && childRelative === 'bootstrap-kit-manifest.json') continue;
      files.push(Object.freeze({
        path: childRelative,
        bytes: stat.size,
        sha256: sha256(await fs.readFile(child)),
      }));
    }
  }
  await visit(root);
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bootstrap kit manifest is invalid');
  if (Object.keys(value).sort().join(',') !== 'contract,files,keyId,releaseId,target,version') throw new Error('bootstrap kit manifest has unsupported fields');
  if (value.contract !== GATE_C_BOOTSTRAP_KIT_CONTRACT || value.version !== GATE_C_BOOTSTRAP_KIT_VERSION) {
    throw new Error('bootstrap kit manifest contract is invalid');
  }
  const target = value.target;
  if (!target || Object.keys(target).sort().join(',') !== 'architecture,os' || target.os !== 'linux' || target.architecture !== 'arm64') {
    throw new Error('bootstrap kit manifest target is invalid');
  }
  if (!Array.isArray(value.files)) throw new Error('bootstrap kit manifest files are invalid');
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256') throw new Error('bootstrap kit manifest file is invalid');
    const file = normalizedRelative(entry.path, 'bootstrap kit manifest path');
    if (!GATE_C_BOOTSTRAP_KIT_FILES.includes(file) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(text(entry.sha256))) {
      throw new Error('bootstrap kit manifest file is invalid');
    }
    return Object.freeze({ path: file, bytes: entry.bytes, sha256: text(entry.sha256) });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!sameJson(files.map((entry) => entry.path), GATE_C_BOOTSTRAP_KIT_FILES)) throw new Error('bootstrap kit manifest file inventory is invalid');
  return Object.freeze({
    contract: GATE_C_BOOTSTRAP_KIT_CONTRACT,
    version: GATE_C_BOOTSTRAP_KIT_VERSION,
    releaseId: releaseId(value.releaseId),
    keyId: keyId(value.keyId),
    target: Object.freeze({ os: 'linux', architecture: 'arm64' }),
    files: Object.freeze(files),
  });
}

/** Build the only allowed bootstrap tree before it is archived and signed. */
export async function createGateCBootstrapKit({ sourceRoot, outputRoot, releaseId: rawReleaseId, keyId: rawKeyId, trustedAnchors } = {}) {
  const source = absolute(sourceRoot, 'bootstrap kit source root');
  const output = absolute(outputRoot, 'bootstrap kit output root');
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('bootstrap kit source root is invalid');
  const sourceReal = await fs.realpath(source);
  if (contained(source, output) || contained(sourceReal, output)) throw new Error('bootstrap kit output must not be inside source root');
  try {
    await fs.lstat(output);
    throw new Error('bootstrap kit output root already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const selectedReleaseId = releaseId(rawReleaseId);
  const selectedKeyId = keyId(rawKeyId);
  const anchors = stableAnchors(trustedAnchors, selectedKeyId);
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  try {
    for (const relative of SOURCE_FILES) {
      const entry = await regularSource(sourceReal, relative);
      await writeRegular(entry.source, path.join(output, entry.path));
    }
    const anchorPath = path.join(output, 'etc', 'sonuvi', 'release-trust-anchors.json');
    await fs.mkdir(path.dirname(anchorPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(anchorPath, `${JSON.stringify(anchors, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const files = await inventory(output);
    if (!sameJson(files.map((entry) => entry.path), GATE_C_BOOTSTRAP_KIT_FILES)) throw new Error('bootstrap kit generated an unexpected file inventory');
    const manifest = Object.freeze({
      contract: GATE_C_BOOTSTRAP_KIT_CONTRACT,
      version: GATE_C_BOOTSTRAP_KIT_VERSION,
      releaseId: selectedReleaseId,
      keyId: selectedKeyId,
      target: Object.freeze({ os: 'linux', architecture: 'arm64' }),
      files,
    });
    await fs.writeFile(path.join(output, 'bootstrap-kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return Object.freeze({ root: output, manifest: await verifyGateCBootstrapKit({ kitRoot: output }) });
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Verify the extracted tree before a local build artifact is signed or used. */
export async function verifyGateCBootstrapKit({ kitRoot } = {}) {
  const root = absolute(kitRoot, 'bootstrap kit root');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('bootstrap kit root is invalid');
  let rawManifest;
  try {
    rawManifest = JSON.parse(await fs.readFile(path.join(root, 'bootstrap-kit-manifest.json'), 'utf8'));
  } catch {
    throw new Error('bootstrap kit manifest is missing or invalid');
  }
  const manifest = normalizedManifest(rawManifest);
  const files = await inventory(root);
  if (!sameJson(files.map((entry) => entry.path), GATE_C_BOOTSTRAP_KIT_FILES)) throw new Error('bootstrap kit file inventory is invalid');
  if (!sameJson(files, manifest.files)) throw new Error('bootstrap kit file integrity does not match manifest');
  return manifest;
}

/** Create an immutable tar from an already-verified fixed kit tree. */
export async function archiveGateCBootstrapKit({ kitRoot, archivePath } = {}) {
  const root = absolute(kitRoot, 'bootstrap kit root');
  const archive = absolute(archivePath, 'bootstrap kit archive path');
  await verifyGateCBootstrapKit({ kitRoot: root });
  const parent = path.dirname(archive);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('bootstrap kit archive parent is invalid');
  try {
    await fs.lstat(archive);
    throw new Error('bootstrap kit archive already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await execFile('tar', ['--format=ustar', '--create', '--file', archive, '--directory', root, 'bootstrap-kit-manifest.json', 'etc', 'scripts', 'src']);
    return Object.freeze({ archivePath: archive, bytes: (await fs.stat(archive)).size, sha256: sha256(await fs.readFile(archive)) });
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {});
    throw error;
  }
}
