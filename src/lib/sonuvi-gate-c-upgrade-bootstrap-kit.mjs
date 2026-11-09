import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { createGateCBootstrapKit, GATE_C_BOOTSTRAP_KIT_FILES } from './sonuvi-gate-c-bootstrap-kit.mjs';

const execFile = promisify(execFileCallback);

export const GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT = 'sonuvi.gate-c-bootstrap-kit.v2';
export const GATE_C_UPGRADE_BOOTSTRAP_KIT_VERSION = 2;
export const GATE_C_UPGRADE_BOOTSTRAP_KIT_ADDITIONS = Object.freeze([
  'scripts/sonuvi-existing-install-upgrade.mjs',
  'src/lib/sonuvi-gate-c-existing-install-upgrade.mjs',
  'src/lib/sonuvi-linux-systemd-upgrade.mjs',
  'src/lib/release-activation.mjs',
]);
export const GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES = Object.freeze([
  ...new Set([...GATE_C_BOOTSTRAP_KIT_FILES, ...GATE_C_UPGRADE_BOOTSTRAP_KIT_ADDITIONS]),
].sort());

function absolute(value, label) {
  const result = String(value || '').trim();
  if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function keyId(value) {
  const result = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(result)) throw new Error('bootstrap kit key ID is invalid');
  return result;
}

function releaseId(value) {
  const result = String(value || '').trim();
  if (!/^sonuvi-[a-f0-9]{64}$/.test(result)) throw new Error('bootstrap kit release ID is invalid');
  return result;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function expectedDirectories(files) {
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

async function inventory(root) {
  const result = [];
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const name = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(child);
      if (name === 'bootstrap-kit-manifest.json' && stat.isFile() && !stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await walk(child, name);
      } else if (stat.isFile() && !stat.isSymbolicLink() && name !== 'bootstrap-kit-manifest.json') {
        const bytes = await fs.readFile(child);
        result.push({ path: name, bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else {
        throw new Error(`bootstrap kit contains a non-regular entry: ${name}`);
      }
    }
  }
  await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'contract,files,keyId,releaseId,target,version'
    || value.contract !== GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT
    || value.version !== GATE_C_UPGRADE_BOOTSTRAP_KIT_VERSION
    || !value.target || Object.keys(value.target).sort().join(',') !== 'architecture,os'
    || value.target?.os !== 'linux' || value.target?.architecture !== 'arm64') {
    throw new Error('Gate C upgrade bootstrap-kit manifest is invalid');
  }
  if (!Array.isArray(value.files)) throw new Error('Gate C upgrade bootstrap-kit inventory is invalid');
  const files = value.files.map((item) => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'bytes,path,sha256'
      || !GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES.includes(item.path)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
      throw new Error('Gate C upgrade bootstrap-kit inventory is invalid');
    }
    return { path: item.path, bytes: item.bytes, sha256: item.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(files.map((item) => item.path)) !== JSON.stringify(GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES)) {
    throw new Error('Gate C upgrade bootstrap-kit inventory is incomplete');
  }
  return Object.freeze({
    contract: GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT,
    version: GATE_C_UPGRADE_BOOTSTRAP_KIT_VERSION,
    releaseId: releaseId(value.releaseId),
    keyId: keyId(value.keyId),
    target: Object.freeze({ os: 'linux', architecture: 'arm64' }),
    files: Object.freeze(files),
  });
}

export async function createGateCUpgradeBootstrapKit({ sourceRoot, outputRoot, releaseId: rawReleaseId, keyId: rawKeyId, trustedAnchors } = {}) {
  const source = absolute(sourceRoot, 'bootstrap kit source root');
  const output = absolute(outputRoot, 'bootstrap kit output root');
  if (contained(source, output) || contained(await fs.realpath(source), output)) throw new Error('bootstrap kit output must not be inside source root');
  const anchorKeyId = keyId(rawKeyId);
  const seedRoot = `${output}.v1-seed-${crypto.randomUUID()}`;
  let seed = null;
  let outputCreated = false;
  try {
    try {
      await fs.lstat(output);
      throw new Error('bootstrap kit output root already exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    seed = await createGateCBootstrapKit({
      sourceRoot: source,
      outputRoot: seedRoot,
      releaseId: rawReleaseId,
      keyId: anchorKeyId,
      trustedAnchors,
    });
    await fs.cp(seed.root, output, { recursive: true, errorOnExist: true, force: false, dereference: false });
    outputCreated = true;
    for (const relative of GATE_C_UPGRADE_BOOTSTRAP_KIT_ADDITIONS) {
      const sourcePath = path.join(source, relative);
      const sourceStat = await fs.lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('upgrade bootstrap-kit source is not a regular file');
      const destination = path.join(output, relative);
      if (!contained(output, destination)) throw new Error('upgrade bootstrap-kit source escapes output');
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
      await fs.chmod(destination, 0o600);
    }
    await fs.unlink(path.join(output, 'bootstrap-kit-manifest.json'));
    const files = await inventory(output);
    if (JSON.stringify(files.map((item) => item.path)) !== JSON.stringify(GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES)) {
      throw new Error('Gate C upgrade bootstrap-kit contains an unexpected source set');
    }
    const manifest = {
      contract: GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT,
      version: GATE_C_UPGRADE_BOOTSTRAP_KIT_VERSION,
      releaseId: releaseId(rawReleaseId),
      keyId: anchorKeyId,
      target: { os: 'linux', architecture: 'arm64' },
      files,
    };
    await fs.writeFile(path.join(output, 'bootstrap-kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return Object.freeze({ root: output, manifest: await verifyGateCUpgradeBootstrapKit({ kitRoot: output }) });
  } catch (error) {
    if (outputCreated) await fs.rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (seed) await fs.rm(seed.root, { recursive: true, force: true }).catch(() => {});
  }
}

export async function verifyGateCUpgradeBootstrapKit({ kitRoot } = {}) {
  const root = absolute(kitRoot, 'bootstrap kit root');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Gate C upgrade bootstrap-kit root is invalid');
  let value;
  try { value = JSON.parse(await fs.readFile(path.join(root, 'bootstrap-kit-manifest.json'), 'utf8')); } catch { throw new Error('Gate C upgrade bootstrap-kit manifest is invalid'); }
  const manifest = normalizeManifest(value);
  const files = await inventory(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Gate C upgrade bootstrap-kit digest mismatch');
  let anchors;
  try { anchors = JSON.parse(await fs.readFile(path.join(root, 'etc/sonuvi/release-trust-anchors.json'), 'utf8')); } catch { throw new Error('Gate C upgrade bootstrap-kit trust anchors are invalid'); }
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)
    || !Object.hasOwn(anchors, manifest.keyId)
    || !String(anchors[manifest.keyId] || '').includes('BEGIN PUBLIC KEY')) {
    throw new Error('Gate C upgrade bootstrap-kit trust anchor does not match its manifest');
  }
  return manifest;
}

export async function archiveGateCUpgradeBootstrapKit({ kitRoot, archivePath } = {}) {
  const root = absolute(kitRoot, 'bootstrap kit root');
  const archive = absolute(archivePath, 'bootstrap kit archive path');
  await verifyGateCUpgradeBootstrapKit({ kitRoot: root });
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
    await execFile('/usr/bin/tar', ['--format=ustar', '--create', '--file', archive, '--directory', root, 'bootstrap-kit-manifest.json', 'etc', 'scripts', 'src']);
    const bytes = await fs.readFile(archive);
    return Object.freeze({ archivePath: archive, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {});
    throw error;
  }
}

export const GATE_C_UPGRADE_BOOTSTRAP_KIT_EXTRACTED_TREE = Object.freeze([
  ...expectedDirectories(GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES).map((item) => item === '.' ? '.' : `./${item}`),
  './bootstrap-kit-manifest.json',
  ...GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES.map((item) => `./${item}`),
].sort());
