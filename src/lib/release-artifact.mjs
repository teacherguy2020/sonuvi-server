import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { buildPublicWebRoot, isPublicWebAsset } from './public-web-root.mjs';

const execFile = promisify(execFileCallback);

export const RELEASE_MANIFEST_CONTRACT = 'sonuvi.release-manifest.v1';
export const SOURCE_SNAPSHOT_CONTRACT = 'sonuvi.release-source-snapshot.v1';
export const TARGET_DEPENDENCIES_CONTRACT = 'sonuvi.target-dependencies.v1';
export const RELEASE_WEB_IDENTITY_CONTRACT = 'sonuvi.release-web-identity.v1';

export const TARGET_PLATFORM = Object.freeze({ os: 'linux', architecture: 'arm64' });

const SNAPSHOT_EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  'node_modules',
  'data',
  'var',
  'logs',
  'tmp',
  'cache',
  'coverage',
  'dist',
  'build',
  'artifacts',
  'backups',
  'credentials',
  'secrets',
]);

const SNAPSHOT_EXCLUDED_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.alac', '.ape', '.avi', '.caf', '.db', '.dmg', '.dsf', '.dts',
  '.flac', '.m4a', '.m4v', '.mka', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.opus', '.p12',
  '.pfx', '.png.tmp', '.sqlite', '.sqlite3', '.wav', '.webm', '.wma', '.wv',
]);

const RELEASE_ROOT_FILES = new Set([
  'build_moode_index.py',
  'lastfm_vibe_radio.py',
  'moode-nowplaying-api.mjs',
  'package.json',
  'package-lock.json',
]);

const RELEASE_CONFIG_FILES = new Set([
  'config/now-playing.config.example.json',
  'config/radio-logo-aliases.json',
  'now-playing.config.example.json',
]);

const RELEASE_RUNTIME_SCRIPTS = new Set([
  'scripts/export-peppymeter-skins.mjs',
  'scripts/lastfm-authorize.mjs',
  'scripts/promote-staged-release.mjs',
  'scripts/serve-public-web.mjs',
  'scripts/verify-current-release.mjs',
  'scripts/verify-release-runtime.mjs',
]);

const RELEASE_STATIC_ENTRYPOINTS = [
  'moode-nowplaying-api.mjs',
  'scripts/lastfm-authorize.mjs',
  'scripts/promote-staged-release.mjs',
  'scripts/serve-public-web.mjs',
  'scripts/verify-current-release.mjs',
  'scripts/verify-release-runtime.mjs',
];

function text(value) {
  return String(value ?? '').trim();
}

function posixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function normalizeRelativePath(value, label = 'path') {
  const input = text(value);
  if (!input || input.includes('\0') || input.includes('\\') || path.isAbsolute(input)) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} escapes its approved root`);
  }
  return normalized;
}

function assertAbsolutePath(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function inventoryHash(inventory) {
  return sha256(canonicalJson(inventory));
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDirectory(filePath, label) {
  const stat = await lstatOrNull(filePath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a real directory: ${filePath}`);
  return fs.realpath(filePath);
}

async function git(worktree, args) {
  const { stdout } = await execFile('git', ['-C', worktree, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return String(stdout || '');
}

function parseNulList(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function snapshotExcluded(relativePath) {
  const relative = normalizeRelativePath(relativePath, 'snapshot path');
  const segments = relative.split('/');
  if (segments.some((segment) => SNAPSHOT_EXCLUDED_SEGMENTS.has(segment) || segment.startsWith('.'))) return true;
  const lower = relative.toLowerCase();
  const base = segments.at(-1).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(?:key|pem|crt|cer|der|p8|p12|pfx)$/i.test(base)) return true;
  if (/^(?:id_rsa|id_ed25519|known_hosts)$/i.test(base)) return true;
  return [...SNAPSHOT_EXCLUDED_EXTENSIONS].some((extension) => lower.endsWith(extension));
}

function releaseSourcePath(relativePath) {
  const relative = normalizeRelativePath(relativePath, 'release source path');
  if (RELEASE_ROOT_FILES.has(relative) || RELEASE_CONFIG_FILES.has(relative) || RELEASE_RUNTIME_SCRIPTS.has(relative)) return true;
  if (relative.startsWith('src/')) return !relative.startsWith('src/private/');
  if (relative.startsWith('skins/')) return true;
  return false;
}

async function copyRegularFile(source, target, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  await fs.chmod(target, mode & 0o777);
}

async function copyTree(sourceRoot, outputRoot, { sourceBase = sourceRoot } = {}) {
  const source = await ensureDirectory(sourceRoot, 'copy source');
  const base = await ensureDirectory(sourceBase, 'copy source base');
  const output = path.resolve(outputRoot);
  await fs.mkdir(output, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(output, entry.name);
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: true, mode: stat.mode & 0o777 });
      await copyTree(from, to, { sourceBase: base });
      await fs.chmod(to, stat.mode & 0o777);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(from).catch(() => '');
      if (!real || !contained(base, real)) throw new Error(`refusing symlink outside source tree: ${posixPath(path.relative(base, from))}`);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.symlink(await fs.readlink(from), to);
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported artifact file type: ${posixPath(path.relative(base, from))}`);
    await copyRegularFile(from, to, stat.mode);
  }
}

function staticRelativeImportSpecifiers(source) {
  const values = new Set();
  const add = (specifier) => {
    const value = text(specifier);
    if (value.startsWith('.')) values.add(value);
  };
  // Dynamic imports are intentionally excluded: the optional private metadata
  // integration is loaded only when present and must not force private code
  // into a public immutable release.
  for (const match of source.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)) add(match[1]);
  for (const match of source.matchAll(/\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)) add(match[1]);
  return [...values].sort();
}

async function resolveStaticArtifactImport(root, importer, specifier) {
  const initial = path.resolve(path.dirname(importer), specifier);
  const candidates = [initial];
  if (!path.extname(initial)) {
    candidates.push(`${initial}.mjs`, `${initial}.js`, `${initial}.json`);
    candidates.push(path.join(initial, 'index.mjs'), path.join(initial, 'index.js'));
  }
  for (const candidate of candidates) {
    if (!contained(root, candidate)) throw new Error(`release import escapes artifact root: ${specifier}`);
    const stat = await lstatOrNull(candidate);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const real = await fs.realpath(candidate);
    if (!contained(root, real)) throw new Error(`release import escapes artifact root: ${specifier}`);
    return real;
  }
  throw new Error(`release static import is missing: ${posixPath(path.relative(root, importer))} -> ${specifier}`);
}

/** Verify that the shipped server and startup scripts retain every static relative import. */
export async function verifyReleaseRuntimeImportClosure({ artifactRoot } = {}) {
  const root = await ensureDirectory(assertAbsolutePath(artifactRoot, 'release artifact root'), 'release artifact root');
  const pending = [];
  for (const relative of RELEASE_STATIC_ENTRYPOINTS) {
    const entry = path.join(root, relative);
    const stat = await lstatOrNull(entry);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`release startup entrypoint is missing: ${relative}`);
    pending.push(entry);
  }
  const visited = new Set();
  while (pending.length) {
    const importer = pending.pop();
    const real = await fs.realpath(importer);
    if (visited.has(real)) continue;
    visited.add(real);
    const source = await fs.readFile(real, 'utf8');
    for (const specifier of staticRelativeImportSpecifiers(source)) {
      pending.push(await resolveStaticArtifactImport(root, real, specifier));
    }
  }
  return Object.freeze({ root, files: [...visited].map((file) => posixPath(path.relative(root, file))).sort() });
}

export async function collectFileInventory(root, { exclude = [] } = {}) {
  const resolvedRoot = await ensureDirectory(root, 'inventory root');
  const excluded = new Set(exclude.map((entry) => normalizeRelativePath(entry, 'inventory exclusion')));
  const files = [];

  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (excluded.has(childRelative)) continue;
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isDirectory()) {
        await visit(child, childRelative);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const real = await fs.realpath(child).catch(() => '');
        if (!real || !contained(resolvedRoot, real)) throw new Error(`artifact symlink escapes root: ${childRelative}`);
        const target = await fs.readlink(child);
        files.push({
          path: childRelative,
          type: 'symlink',
          target,
          sha256: sha256(target),
        });
        continue;
      }
      if (!stat.isFile()) throw new Error(`unsupported artifact file type: ${childRelative}`);
      files.push({
        path: childRelative,
        type: 'file',
        bytes: stat.size,
        sha256: sha256(await fs.readFile(child)),
      });
    }
  }

  await visit(resolvedRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function packageInventory(nodeModulesRoot) {
  const packages = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.bin') continue;
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (entry.name.startsWith('@')) {
        await visit(child);
        continue;
      }
      const packagePath = path.join(child, 'package.json');
      try {
        const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
        packages.push({ name: String(pkg.name || entry.name), version: String(pkg.version || '') });
      } catch {}
    }
  }
  await visit(nodeModulesRoot);
  return packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

async function nativeArtifacts(nodeModulesRoot) {
  const artifacts = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(child, childRelative);
      } else if (stat.isFile() && (entry.name.endsWith('.node') || entry.name.endsWith('.so') || entry.name.endsWith('.dylib'))) {
        artifacts.push(childRelative);
      }
    }
  }
  await visit(nodeModulesRoot);
  return artifacts;
}

function assertNoMacNativeArtifacts(artifacts) {
  if (artifacts.some((entry) => entry.endsWith('.dylib') || /darwin/i.test(entry))) {
    throw new Error('target dependency tree contains macOS native artifacts');
  }
}

function assertTarget(target) {
  const osName = text(target?.os || target?.platform);
  const architecture = text(target?.architecture || target?.arch);
  if (osName !== TARGET_PLATFORM.os || architecture !== TARGET_PLATFORM.architecture) {
    throw new Error(`only ${TARGET_PLATFORM.os}/${TARGET_PLATFORM.architecture} target dependencies are accepted`);
  }
  return { os: osName, architecture };
}

export async function resolveSourceWorktree({ sourceWorktree, expectedProject = 'now-playing' } = {}) {
  const requested = assertAbsolutePath(sourceWorktree, 'source worktree');
  const realRequested = await ensureDirectory(requested, 'source worktree');
  const reportedRoot = text(await git(realRequested, ['rev-parse', '--show-toplevel']));
  const root = await ensureDirectory(reportedRoot, 'Git worktree root');
  if (root !== realRequested) {
    throw new Error(`source worktree must name the Git worktree root exactly; resolved root is ${root}`);
  }

  const packagePath = path.join(root, 'package.json');
  const entrypointPath = path.join(root, 'moode-nowplaying-api.mjs');
  const configPath = path.join(root, 'src', 'config.mjs');
  const [packageText, entrypoint, config] = await Promise.all([
    fs.readFile(packagePath, 'utf8').catch(() => ''),
    lstatOrNull(entrypointPath),
    lstatOrNull(configPath),
  ]);
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    throw new Error(`source worktree is missing a valid package.json: ${root}`);
  }
  if (String(packageJson?.name || '') !== expectedProject || !entrypoint?.isFile() || !config?.isFile()) {
    throw new Error(`source worktree is not the expected ${expectedProject} Sonuvi Server project: ${root}`);
  }

  const [head, tree, status] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['rev-parse', 'HEAD^{tree}']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
  ]);
  let branch = '';
  try {
    branch = text(await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']));
  } catch {}
  const statusEntries = parseNulList(status);
  const untracked = statusEntries
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => normalizeRelativePath(entry.slice(3), 'untracked source path'))
    .sort();
  const dirty = statusEntries.length > 0;
  return Object.freeze({
    root,
    project: expectedProject,
    branch: branch || '(detached)',
    head: text(head),
    tree: text(tree),
    dirty,
    statusEntries,
    untracked,
    packageJson,
  });
}

export async function createSourceSnapshot({
  sourceWorktree,
  snapshotRoot,
  allowDirtySnapshot = false,
  approvedUntracked = [],
  expectedProject = 'now-playing',
} = {}) {
  const provenance = await resolveSourceWorktree({ sourceWorktree, expectedProject });
  if (provenance.dirty && !allowDirtySnapshot) {
    throw new Error('dirty source worktree rejected; pass the development-only dirty snapshot approval explicitly');
  }
  const destination = assertAbsolutePath(snapshotRoot, 'snapshot root');
  if (await lstatOrNull(destination)) throw new Error(`snapshot root already exists: ${destination}`);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });

  const tracked = parseNulList(await git(provenance.root, ['ls-files', '-z']))
    .map((entry) => normalizeRelativePath(entry, 'tracked source path'))
    .sort();
  const changedTracked = new Set(parseNulList(await git(provenance.root, ['diff', '--name-only', '-z', 'HEAD'])));
  const explicitlyApproved = [...new Set(approvedUntracked.map((entry) => normalizeRelativePath(entry, 'approved untracked source path')))].sort();
  const untracked = new Set(provenance.untracked);
  for (const relative of explicitlyApproved) {
    if (!untracked.has(relative)) throw new Error(`approved untracked source file is not an untracked file: ${relative}`);
    if (snapshotExcluded(relative)) throw new Error(`approved untracked source file is excluded by release policy: ${relative}`);
  }

  const inventory = [];
  const excluded = [];
  const removed = [];
  const candidates = [
    ...tracked.map((relative) => ({ relative, origin: 'tracked' })),
    ...explicitlyApproved.map((relative) => ({ relative, origin: 'approved-untracked' })),
  ].sort((a, b) => a.relative.localeCompare(b.relative));

  try {
    for (const { relative, origin } of candidates) {
      if (snapshotExcluded(relative)) {
        if (origin === 'tracked' && changedTracked.has(relative)) {
          throw new Error(`dirty tracked source file is excluded by release policy: ${relative}`);
        }
        excluded.push(relative);
        continue;
      }
      const source = path.join(provenance.root, relative);
      const stat = await lstatOrNull(source);
      if (!stat) {
        if (origin === 'tracked') {
          removed.push(relative);
          continue;
        }
        throw new Error(`approved untracked source file disappeared: ${relative}`);
      }
      if (stat.isSymbolicLink()) throw new Error(`source snapshot refuses symlink: ${relative}`);
      if (!stat.isFile()) throw new Error(`source snapshot requires regular files: ${relative}`);
      const target = path.join(destination, relative);
      await copyRegularFile(source, target, stat.mode);
      inventory.push({
        path: relative,
        origin,
        bytes: stat.size,
        mode: stat.mode & 0o777,
        sha256: sha256(await fs.readFile(source)),
      });
    }
    const snapshot = {
      contract: SOURCE_SNAPSHOT_CONTRACT,
      project: provenance.project,
      source: {
        branch: provenance.branch,
        gitHead: provenance.head,
        gitTree: provenance.tree,
        dirty: provenance.dirty,
        mode: provenance.dirty ? 'development-only-dirty-snapshot' : 'clean-git-worktree-snapshot',
      },
      approvedUntracked: explicitlyApproved,
      excluded,
      removed,
      files: inventory,
      contentHash: inventoryHash(inventory),
    };
    await fs.writeFile(path.join(destination, '.source-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    return Object.freeze({ ...snapshot, root: destination, provenance });
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createTargetDependencyMetadata({
  dependencyRoot,
  packageLockPath,
  target = TARGET_PLATFORM,
  nodeVersion,
  npmVersion,
  buildEnvironment = {},
} = {}) {
  const root = await ensureDirectory(assertAbsolutePath(dependencyRoot, 'dependency root'), 'dependency root');
  const targetInfo = assertTarget(target);
  const nodeModules = await ensureDirectory(path.join(root, 'node_modules'), 'dependency node_modules');
  const lockPath = assertAbsolutePath(packageLockPath, 'package lock path');
  const lockHash = sha256(await fs.readFile(lockPath));
  const packages = await packageInventory(nodeModules);
  const files = await collectFileInventory(nodeModules);
  const native = await nativeArtifacts(nodeModules);
  assertNoMacNativeArtifacts(native);
  if (packages.some((entry) => entry.name === 'sharp') && !native.some((entry) => /sharp-linux-arm64\.node$/.test(entry))) {
    throw new Error('linux/arm64 Sharp native artifact is missing from target dependencies');
  }
  return Object.freeze({
    contract: TARGET_DEPENDENCIES_CONTRACT,
    target: targetInfo,
    nodeVersion: text(nodeVersion),
    npmVersion: text(npmVersion),
    packageLockSha256: lockHash,
    packageInventory: packages,
    packageInventoryHash: inventoryHash(packages),
    dependencyFilesHash: inventoryHash(files),
    nativeArtifacts: native,
    buildEnvironment: sortValue(buildEnvironment),
  });
}

export async function writeTargetDependencyMetadata(options = {}) {
  const metadata = await createTargetDependencyMetadata(options);
  const root = assertAbsolutePath(options.dependencyRoot, 'dependency root');
  await fs.writeFile(path.join(root, 'target-dependencies.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  return metadata;
}

export async function readTargetDependencyMetadata({ dependencyRoot, packageLockSha256 } = {}) {
  const root = await ensureDirectory(assertAbsolutePath(dependencyRoot, 'dependency root'), 'dependency root');
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(root, 'target-dependencies.json'), 'utf8'));
  } catch {
    throw new Error('target dependency metadata is missing or invalid');
  }
  if (metadata?.contract !== TARGET_DEPENDENCIES_CONTRACT) throw new Error('target dependency metadata contract is invalid');
  assertTarget(metadata.target);
  if (!text(metadata.nodeVersion) || !text(metadata.npmVersion)) throw new Error('target dependency metadata lacks Node or npm version');
  if (packageLockSha256 && metadata.packageLockSha256 !== packageLockSha256) {
    throw new Error('target dependency metadata does not match the selected package-lock hash');
  }
  const nodeModules = await ensureDirectory(path.join(root, 'node_modules'), 'dependency node_modules');
  const packages = await packageInventory(nodeModules);
  const files = await collectFileInventory(nodeModules);
  if (inventoryHash(packages) !== metadata.packageInventoryHash || inventoryHash(files) !== metadata.dependencyFilesHash) {
    throw new Error('target dependency tree does not match its metadata inventory');
  }
  const native = await nativeArtifacts(nodeModules);
  assertNoMacNativeArtifacts(native);
  if (packages.some((entry) => entry.name === 'sharp') && !native.some((entry) => /sharp-linux-arm64\.node$/.test(entry))) {
    throw new Error('target dependency tree lacks the required linux/arm64 Sharp binary');
  }
  return Object.freeze({ root, nodeModules, metadata, packages, files, native });
}

function releaseIdentityInput({ source, target, packageLockSha256, payloadContentHash }) {
  return {
    contract: RELEASE_MANIFEST_CONTRACT,
    source: {
      gitHead: source.gitHead,
      gitTree: source.gitTree,
      dirty: source.dirty,
      snapshotContentHash: source.snapshotContentHash || null,
    },
    target,
    packageLockSha256,
    payloadContentHash,
  };
}

function releaseIdFor(input) {
  return `sonuvi-${sha256(canonicalJson(input))}`;
}

function defaultManifestRequirements() {
  return {
    configurationKeys: [
      'SONUVI_STATE_ROOT',
      'SONUVI_CONFIG_ROOT',
      'SONUVI_SECRETS_ROOT',
      'SONUVI_RELEASE_ID',
      'SONUVI_RELEASE_MANIFEST',
      'SONUVI_PUBLIC_WEB_ROOT',
      'MUSIC_LIBRARY_ROOT',
      'PI4_MOUNT_BASE',
      'MPD_HOST',
      'MOODE_SSH_HOST',
      'MOODE_SSH_USER',
      'TRACK_KEY (protected environment only; no mutable-config fallback)',
    ],
    configurationFiles: [
      'SONUVI_CONFIG_ROOT/now-playing.config.json (external non-secret config; current service template: /var/lib/sonuvi/config)',
      'LASTFM_ENV_FILE (external root-managed credential file; current service template: /var/lib/sonuvi/protected/lastfm.env)',
    ],
    applicationConfigKeys: [
      'nodes',
      'ports.api',
      'ports.ui',
      'alexa.enabled',
      'alexa.publicDomain (when Alexa is enabled)',
    ],
    runtimeStatePaths: [
      'config', 'data', 'cache', 'protected', 'logs', 'checkpoints',
    ],
  };
}

function externalRuntimeDependencies() {
  return {
    executables: [
      'node', 'npm', 'python3', 'mpc', 'ffmpeg', 'ffprobe', 'metaflac', 'curl', 'ssh', 'scp',
    ],
    pythonPackages: ['python-mpd2', 'requests', 'mutagen'],
    hostServicesAndAccess: [
      'MPD TCP control',
      'moOde SSH control',
      'CIFS music library read access',
      'Caddy file-gate access to a non-secret release sentinel',
      'outbound HTTPS for provider integrations',
    ],
  };
}

function assertNoDevelopmentPaths(value, forbiddenPaths) {
  const serialized = JSON.stringify(value);
  for (const forbidden of forbiddenPaths) {
    if (forbidden && serialized.includes(forbidden)) {
      throw new Error('release metadata must not contain an absolute development path');
    }
  }
}

async function assertPublicRootIntegrity(publicRoot) {
  const root = await ensureDirectory(publicRoot, 'public web root');
  const inventory = await collectFileInventory(root);
  for (const entry of inventory) {
    if (entry.type !== 'file') throw new Error(`public web root cannot contain symlinks: ${entry.path}`);
    if (entry.path.split('/').some((segment) => segment.startsWith('.'))) throw new Error(`public web root cannot contain dotfiles: ${entry.path}`);
    if (!isPublicWebAsset(entry.path)) throw new Error(`public web root contains a non-allowlisted asset: ${entry.path}`);
  }
  return inventory;
}

export async function buildReleaseArtifact({
  sourceWorktree,
  outputRoot,
  dependencyRoot,
  allowDirtySnapshot = false,
  approvedUntracked = [],
  target = TARGET_PLATFORM,
  buildTimestamp = new Date().toISOString(),
  builderVersion = 'sonuvi-h3-local',
  expectedProject = 'now-playing',
} = {}) {
  const output = assertAbsolutePath(outputRoot, 'release output root');
  if (await lstatOrNull(output)) throw new Error(`release output root already exists: ${output}`);
  const outputParent = await ensureDirectory(path.dirname(output), 'release output parent');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-build-'));
  const snapshotRoot = path.join(temporary, 'source-snapshot');
  const stage = await fs.mkdtemp(path.join(outputParent, `.${path.basename(output)}.stage-`));
  try {
    const snapshot = await createSourceSnapshot({
      sourceWorktree,
      snapshotRoot,
      allowDirtySnapshot,
      approvedUntracked,
      expectedProject,
    });
    const packageLockSha256 = sha256(await fs.readFile(path.join(snapshot.root, 'package-lock.json')));
    const dependencies = await readTargetDependencyMetadata({ dependencyRoot, packageLockSha256 });
    const targetInfo = assertTarget(target);
    if (canonicalJson(targetInfo) !== canonicalJson(dependencies.metadata.target)) {
      throw new Error('target dependency metadata does not match requested target platform');
    }

    const releaseFiles = snapshot.files.filter((entry) => releaseSourcePath(entry.path));
    for (const entry of releaseFiles) {
      const source = path.join(snapshot.root, entry.path);
      await copyRegularFile(source, path.join(stage, entry.path), entry.mode);
    }
    if (!await lstatOrNull(path.join(stage, 'moode-nowplaying-api.mjs'))) {
      throw new Error('release source snapshot did not contain the API entrypoint');
    }
    if (!await lstatOrNull(path.join(stage, 'scripts', 'serve-public-web.mjs'))) {
      throw new Error('release source snapshot did not contain the static web startup script');
    }
    if (!await lstatOrNull(path.join(stage, 'scripts', 'verify-current-release.mjs'))) {
      throw new Error('release source snapshot did not contain the release verification startup script');
    }
    for (const helper of ['build_moode_index.py', 'lastfm_vibe_radio.py']) {
      if (!await lstatOrNull(path.join(stage, helper))) {
        throw new Error(`release source snapshot did not contain required Vibe helper: ${helper}`);
      }
    }
    await verifyReleaseRuntimeImportClosure({ artifactRoot: stage });
    await copyTree(dependencies.nodeModules, path.join(stage, 'node_modules'));
    const publicRoot = path.join(stage, 'public');
    await buildPublicWebRoot({ sourceRoot: snapshot.root, outputRoot: publicRoot });
    const initialPublicInventory = await assertPublicRootIntegrity(publicRoot);

    const identityFiles = await collectFileInventory(stage);
    const identityPayloadContentHash = inventoryHash(identityFiles);
    const source = {
      project: snapshot.project,
      branch: snapshot.provenance.branch,
      gitHead: snapshot.provenance.head,
      gitTree: snapshot.provenance.tree,
      dirty: snapshot.provenance.dirty,
      snapshotStatus: snapshot.provenance.dirty ? 'development-only-dirty-snapshot' : 'clean-git-worktree-snapshot',
      snapshotContentHash: snapshot.contentHash,
      approvedUntracked: snapshot.approvedUntracked,
    };
    const identity = releaseIdentityInput({ source, target: targetInfo, packageLockSha256, payloadContentHash: identityPayloadContentHash });
    const releaseId = releaseIdFor(identity);
    const publicIdentity = {
      contract: RELEASE_WEB_IDENTITY_CONTRACT,
      releaseId,
      manifestContract: RELEASE_MANIFEST_CONTRACT,
      publicAssetContentHash: inventoryHash(initialPublicInventory),
    };
    await fs.writeFile(path.join(publicRoot, 'release.json'), `${JSON.stringify(publicIdentity, null, 2)}\n`, { mode: 0o444 });
    const publicInventory = await assertPublicRootIntegrity(publicRoot);
    const payloadFiles = await collectFileInventory(stage);
    const manifest = {
      contract: RELEASE_MANIFEST_CONTRACT,
      manifestVersion: 1,
      releaseId,
      source,
      build: {
        timestamp: text(buildTimestamp),
        builderVersion: text(builderVersion),
        builderNodeVersion: process.version,
        builderPlatform: process.platform,
        builderArchitecture: process.arch,
      },
      target: {
        ...targetInfo,
        nodeVersion: dependencies.metadata.nodeVersion,
        npmVersion: dependencies.metadata.npmVersion,
        buildEnvironment: dependencies.metadata.buildEnvironment,
      },
      packageLockSha256,
      dependencies: {
        contract: dependencies.metadata.contract,
        packageInventory: dependencies.metadata.packageInventory,
        packageInventoryHash: dependencies.metadata.packageInventoryHash,
        dependencyFilesHash: dependencies.metadata.dependencyFilesHash,
        nativeArtifacts: dependencies.metadata.nativeArtifacts,
      },
      publicAssets: {
        contract: 'sonuvi.public-web-root.v1',
        inventory: publicInventory,
        inventoryHash: inventoryHash(publicInventory),
      },
      identity: {
        payloadContentHash: identityPayloadContentHash,
        excludedGeneratedFiles: ['public/release.json', 'release-manifest.json'],
      },
      files: payloadFiles,
      payloadFilesHash: inventoryHash(payloadFiles),
      requirements: defaultManifestRequirements(),
      externalRuntimeDependencies: externalRuntimeDependencies(),
      compatibleCatalogSchemas: {
        browseIndex: ['now-playing.browse-index.v1', 'now-playing.browse-index.v2'],
      },
      requiredServices: ['sonuvi-api.service', 'sonuvi-web.service'],
      entrypoints: {
        api: { command: 'node moode-nowplaying-api.mjs', health: '/health' },
        web: { command: 'node scripts/serve-public-web.mjs', identity: '/release.json' },
      },
      verifier: {
        externalArtifact: 'node scripts/verify-release.mjs --artifact-root <release>',
        targetRuntime: 'node scripts/verify-release-runtime.mjs --release-root <release>',
      },
    };
    assertNoDevelopmentPaths(manifest, [snapshot.provenance.root, output, dependencyRoot]);
    await fs.writeFile(path.join(stage, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    await fs.rename(stage, output);
    return Object.freeze({ artifactRoot: output, releaseId, manifest, snapshot, dependencies: dependencies.metadata });
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function sameInventory(expected, actual) {
  return canonicalJson(expected) === canonicalJson(actual);
}

function assertManifestShape(manifest) {
  if (manifest?.contract !== RELEASE_MANIFEST_CONTRACT || manifest?.manifestVersion !== 1) {
    throw new Error('release manifest contract is invalid');
  }
  if (!/^sonuvi-[a-f0-9]{64}$/.test(String(manifest.releaseId || ''))) throw new Error('release manifest release ID is invalid');
  assertTarget(manifest.target);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.publicAssets?.inventory)) {
    throw new Error('release manifest inventories are missing');
  }
  if (!Array.isArray(manifest.compatibleCatalogSchemas?.browseIndex)) throw new Error('release manifest catalog compatibility is missing');
}

export async function verifyReleaseArtifact({ artifactRoot, expectedTarget = TARGET_PLATFORM } = {}) {
  const root = await ensureDirectory(assertAbsolutePath(artifactRoot, 'release artifact root'), 'release artifact root');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8'));
  } catch {
    throw new Error('release manifest is missing or invalid JSON');
  }
  assertManifestShape(manifest);
  const target = assertTarget(expectedTarget);
  if (canonicalJson(target) !== canonicalJson({ os: manifest.target.os, architecture: manifest.target.architecture })) {
    throw new Error('release target does not match the verifier target');
  }
  await verifyReleaseRuntimeImportClosure({ artifactRoot: root });
  const payloadFiles = await collectFileInventory(root, { exclude: ['release-manifest.json'] });
  if (!sameInventory(manifest.files, payloadFiles) || manifest.payloadFilesHash !== inventoryHash(payloadFiles)) {
    throw new Error('release artifact file inventory does not match its manifest');
  }
  const identityFiles = await collectFileInventory(root, { exclude: ['public/release.json', 'release-manifest.json'] });
  if (manifest.identity?.payloadContentHash !== inventoryHash(identityFiles)) {
    throw new Error('release artifact identity payload has been modified');
  }
  const expectedReleaseId = releaseIdFor(releaseIdentityInput({
    source: manifest.source,
    target: { os: manifest.target.os, architecture: manifest.target.architecture },
    packageLockSha256: manifest.packageLockSha256,
    payloadContentHash: manifest.identity.payloadContentHash,
  }));
  if (manifest.releaseId !== expectedReleaseId) throw new Error('release manifest identity is invalid');
  const lockHash = sha256(await fs.readFile(path.join(root, 'package-lock.json')));
  if (lockHash !== manifest.packageLockSha256) throw new Error('release package lock does not match its manifest');
  const dependencyRoot = path.join(root, '.verify-dependencies');
  // The dependency verifier expects its metadata alongside node_modules. Avoid
  // creating a persistent staging directory: verify the copied tree directly.
  const nodeModules = await ensureDirectory(path.join(root, 'node_modules'), 'release node_modules');
  const packages = await packageInventory(nodeModules);
  const dependencyFiles = await collectFileInventory(nodeModules);
  const native = await nativeArtifacts(nodeModules);
  assertNoMacNativeArtifacts(native);
  if (inventoryHash(packages) !== manifest.dependencies.packageInventoryHash || inventoryHash(dependencyFiles) !== manifest.dependencies.dependencyFilesHash) {
    throw new Error('release dependency inventory does not match its manifest');
  }
  if (packages.some((entry) => entry.name === 'sharp') && !native.some((entry) => /sharp-linux-arm64\.node$/.test(entry))) {
    throw new Error('release dependency tree lacks the required linux/arm64 Sharp binary');
  }
  void dependencyRoot;
  const publicRoot = path.join(root, 'public');
  const publicInventory = await assertPublicRootIntegrity(publicRoot);
  if (!sameInventory(publicInventory, manifest.publicAssets.inventory) || manifest.publicAssets.inventoryHash !== inventoryHash(publicInventory)) {
    throw new Error('release public asset inventory does not match its manifest');
  }
  let publicIdentity;
  try {
    publicIdentity = JSON.parse(await fs.readFile(path.join(publicRoot, 'release.json'), 'utf8'));
  } catch {
    throw new Error('release web identity file is missing or invalid');
  }
  if (publicIdentity?.contract !== RELEASE_WEB_IDENTITY_CONTRACT || publicIdentity.releaseId !== manifest.releaseId) {
    throw new Error('release web identity does not match the manifest');
  }
  return Object.freeze({ root, releaseId: manifest.releaseId, manifest, publicInventory, dependencyPackages: packages });
}

export async function makeTreeReadOnly(root) {
  const resolvedRoot = await ensureDirectory(root, 'release root');
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(child);
        await fs.chmod(child, 0o555);
      } else if (stat.isFile()) {
        await fs.chmod(child, (stat.mode & 0o111) ? 0o555 : 0o444);
      }
    }
  }
  await visit(resolvedRoot);
  await fs.chmod(resolvedRoot, 0o555);
}

// Test/cleanup helper. It is deliberately not used by deployment tooling.
export async function makeTreeWritableForCleanup(root) {
  const resolvedRoot = await ensureDirectory(root, 'release root');
  async function visit(directory) {
    await fs.chmod(directory, 0o755);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child);
      else if (stat.isFile()) await fs.chmod(child, (stat.mode & 0o111) ? 0o755 : 0o644);
    }
  }
  await visit(resolvedRoot);
}

export async function createDisposableReleaseLayout({ layoutRoot } = {}) {
  const root = assertAbsolutePath(layoutRoot, 'disposable release layout root');
  if (root === '/opt' || root.startsWith('/opt/')) throw new Error('H3 tooling refuses to create or stage a release layout under /opt');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, '.sonuvi-h3-disposable-layout');
  await fs.writeFile(marker, 'H3 disposable local release layout only\n', { flag: 'a', mode: 0o600 });
  const layout = {
    root,
    releases: path.join(root, 'releases'),
    current: path.join(root, 'current'),
    shared: path.join(root, 'shared'),
    backups: path.join(root, 'backups'),
  };
  await Promise.all([
    fs.mkdir(layout.releases, { recursive: true, mode: 0o755 }),
    fs.mkdir(path.join(layout.shared, 'config'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(layout.shared, 'data'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(layout.shared, 'cache'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(layout.shared, 'protected'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(layout.shared, 'logs'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(layout.shared, 'checkpoints'), { recursive: true, mode: 0o700 }),
    fs.mkdir(layout.backups, { recursive: true, mode: 0o700 }),
  ]);
  return Object.freeze(layout);
}

export async function stageReleaseArtifact({ artifactRoot, layoutRoot } = {}) {
  const verified = await verifyReleaseArtifact({ artifactRoot });
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  const releaseRoot = path.join(layout.releases, verified.releaseId);
  if (await lstatOrNull(releaseRoot)) throw new Error(`release is already staged and will not be overwritten: ${verified.releaseId}`);
  const stage = await fs.mkdtemp(path.join(layout.releases, `.${verified.releaseId}.stage-`));
  try {
    await copyTree(verified.root, stage);
    await verifyReleaseArtifact({ artifactRoot: stage });
    await makeTreeReadOnly(stage);
    await fs.rename(stage, releaseRoot);
    return Object.freeze({ layout, releaseRoot, releaseId: verified.releaseId, manifest: verified.manifest });
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Promote a separately transferred, manifest-verified candidate into a host
 * release directory. Unlike the H3 disposable helper, this intentionally does
 * not create a layout, touch `current`, create shared state, overwrite an
 * existing release, or remove a failed candidate. H4B must provision the two
 * parent directories explicitly before invoking it as root.
 */
export async function promoteStagedHostRelease({ layoutRoot, stagingRoot } = {}) {
  const layout = await ensureDirectory(assertAbsolutePath(layoutRoot, 'host release layout root'), 'host release layout root');
  const stagingParent = await ensureDirectory(path.join(layout, '.staging'), 'host release staging directory');
  const releases = await ensureDirectory(path.join(layout, 'releases'), 'host releases directory');
  const staging = await ensureDirectory(assertAbsolutePath(stagingRoot, 'host staged release root'), 'host staged release root');
  if (!contained(stagingParent, staging) || path.dirname(staging) !== stagingParent) {
    throw new Error('host staged release must be an immediate child of the host staging directory');
  }
  const verified = await verifyReleaseArtifact({ artifactRoot: staging });
  if (path.basename(staging) !== verified.releaseId) {
    throw new Error('host staged release directory must match its manifest release ID');
  }
  const releaseRoot = path.join(releases, verified.releaseId);
  if (await lstatOrNull(releaseRoot)) {
    throw new Error('host release already exists and will not be overwritten');
  }
  await makeTreeReadOnly(staging);
  await verifyReleaseArtifact({ artifactRoot: staging });
  // macOS requires the directory being renamed to be writable even when both
  // parent directories are writable. Keep only this directory writable for
  // the rename syscall; all contained payload files/directories stay read-only
  // and the target root is immediately restored to 0555 after the move.
  await fs.chmod(staging, 0o755);
  await fs.rename(staging, releaseRoot);
  await fs.chmod(releaseRoot, 0o555);
  await verifyReleaseArtifact({ artifactRoot: releaseRoot });
  return Object.freeze({ layout, releaseRoot, releaseId: verified.releaseId, manifest: verified.manifest });
}

export async function validateSharedRuntimeLayout({ layoutRoot, requireConfig = true } = {}) {
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  const required = ['config', 'data', 'cache', 'protected', 'logs', 'checkpoints'];
  for (const relative of required) {
    const directory = path.join(layout.shared, relative);
    await fs.access(directory, 2).catch(() => {
      throw new Error(`shared runtime state directory is not writable: ${relative}`);
    });
  }
  const configPath = path.join(layout.shared, 'config', 'now-playing.config.json');
  if (requireConfig && !await lstatOrNull(configPath)) {
    throw new Error('required shared runtime configuration is missing');
  }
  return Object.freeze({ ...layout, configPath });
}
