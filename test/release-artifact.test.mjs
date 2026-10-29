import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildReleaseArtifact,
  createSourceSnapshot,
  createTargetDependencyMetadata,
  makeTreeWritableForCleanup,
  promoteStagedHostRelease,
  readTargetDependencyMetadata,
  resolveSourceWorktree,
  stageReleaseArtifact,
  verifyReleaseArtifact,
  verifyReleaseRuntimeImportClosure,
  writeTargetDependencyMetadata,
} from '../src/lib/release-artifact.mjs';

const execFile = promisify(execFileCallback);

async function run(binary, args, cwd) {
  await execFile(binary, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

async function write(root, relative, content = 'fixture') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function sourceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-source-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await write(root, 'package.json', JSON.stringify({ name: 'now-playing', version: '1.0.0', engines: { node: '>=18' } }, null, 2));
  await write(root, 'package-lock.json', JSON.stringify({ name: 'now-playing', lockfileVersion: 3, packages: { '': { name: 'now-playing', version: '1.0.0' } } }, null, 2));
  await write(root, 'moode-nowplaying-api.mjs', 'export const fixtureApi = true;\n');
  await write(root, 'build_moode_index.py', 'print("fixture index")\n');
  await write(root, 'lastfm_vibe_radio.py', 'print("fixture vibe")\n');
  await write(root, 'src/config.mjs', 'export const fixtureConfig = true;\n');
  await write(root, 'src/lib/fixture.mjs', 'export const fixture = true;\n');
  await write(root, 'scripts/serve-public-web.mjs', 'console.log("fixture static server");\n');
  await write(root, 'scripts/verify-current-release.mjs', 'console.log("fixture verifier");\n');
  await write(root, 'scripts/verify-release-runtime.mjs', 'console.log("fixture runtime verifier");\n');
  await write(root, 'scripts/promote-staged-release.mjs', 'console.log("fixture promoter");\n');
  await write(root, 'scripts/lastfm-authorize.mjs', 'console.log("fixture lastfm");\n');
  await write(root, 'scripts/export-peppymeter-skins.mjs', 'console.log("fixture skins");\n');
  await write(root, 'config/now-playing.config.example.json', '{"ports":{"api":3101,"ui":8101}}\n');
  await write(root, 'config/radio-logo-aliases.json', '{"fixture.example":"Fixture Radio"}\n');
  await write(root, 'index.html', '<!doctype html><title>Sonuvi fixture</title>');
  await write(root, 'controller.html', '<!doctype html><title>Controller fixture</title>');
  await write(root, 'scripts/index.js', 'window.fixture = true;\n');
  await write(root, 'styles/hero.css', 'body { color: #123; }\n');
  await write(root, 'icons/icon-192.png', 'fixture icon');
  await run('git', ['init'], root);
  await run('git', ['config', 'user.email', 'fixture@example.test'], root);
  await run('git', ['config', 'user.name', 'Fixture'], root);
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'fixture source'], root);
  return root;
}

async function dependencyFixture(t, sourceRoot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-dependencies-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await write(root, 'node_modules/example/package.json', JSON.stringify({ name: 'example', version: '1.0.0' }));
  await write(root, 'node_modules/sharp/package.json', JSON.stringify({ name: 'sharp', version: '0.33.5' }));
  await write(root, 'node_modules/@img/sharp-linux-arm64/package.json', JSON.stringify({ name: '@img/sharp-linux-arm64', version: '0.33.5' }));
  await write(root, 'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node', 'linux arm64 native fixture');
  await writeTargetDependencyMetadata({
    dependencyRoot: root,
    packageLockPath: path.join(sourceRoot, 'package-lock.json'),
    target: { os: 'linux', architecture: 'arm64' },
    nodeVersion: 'v20.19.5',
    npmVersion: '10.8.2',
    buildEnvironment: { method: 'fixture-linux-arm64' },
  });
  return root;
}

async function releaseFixture(t, { label = 'one' } = {}) {
  const source = await sourceFixture(t);
  const dependencies = await dependencyFixture(t, source);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-artifact-'));
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); });
  const output = path.join(parent, `release-${label}`);
  const built = await buildReleaseArtifact({ sourceWorktree: source, outputRoot: output, dependencyRoot: dependencies });
  assert.deepEqual(built.manifest.requiredServices, ['sonuvi-api.service', 'sonuvi-web.service']);
  assert.match(built.manifest.requirements.configurationFiles.join(' '), /SONUVI_CONFIG_ROOT/);
  return { source, dependencies, parent, output, built };
}

test('source worktree selection is explicit and clean sources produce a deterministic snapshot inventory', async (t) => {
  const source = await sourceFixture(t);
  const provenance = await resolveSourceWorktree({ sourceWorktree: source });
  assert.equal(provenance.project, 'now-playing');
  assert.equal(provenance.dirty, false);
  await assert.rejects(resolveSourceWorktree({ sourceWorktree: path.join(source, 'src') }), /Git worktree root exactly/);

  const snapshots = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-snapshot-output-'));
  t.after(async () => { await fs.rm(snapshots, { recursive: true, force: true }); });
  const first = await createSourceSnapshot({ sourceWorktree: source, snapshotRoot: path.join(snapshots, 'one') });
  const second = await createSourceSnapshot({ sourceWorktree: source, snapshotRoot: path.join(snapshots, 'two') });
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.source.dirty, false);
  assert.equal(first.files.some((entry) => entry.path === 'src/config.mjs'), true);
});

test('dirty sources fail closed unless an explicit development snapshot approves each untracked source file', async (t) => {
  const source = await sourceFixture(t);
  await write(source, 'src/config.mjs', 'export const fixtureConfig = "dirty";\n');
  await write(source, 'src/approved-untracked.mjs', 'export const approved = true;\n');
  await write(source, '.env', 'SECRET_SENTINEL=must-not-ship\n');
  await write(source, 'data/library-browse-index.json', '{"private":true}\n');
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-dirty-snapshot-'));
  t.after(async () => { await fs.rm(destination, { recursive: true, force: true }); });

  await assert.rejects(
    createSourceSnapshot({ sourceWorktree: source, snapshotRoot: path.join(destination, 'rejected') }),
    /dirty source worktree rejected/,
  );
  const snapshot = await createSourceSnapshot({
    sourceWorktree: source,
    snapshotRoot: path.join(destination, 'approved'),
    allowDirtySnapshot: true,
    approvedUntracked: ['src/approved-untracked.mjs'],
  });
  assert.equal(snapshot.source.dirty, true);
  assert.equal(snapshot.source.mode, 'development-only-dirty-snapshot');
  assert.equal(snapshot.files.some((entry) => entry.path === 'src/approved-untracked.mjs'), true);
  assert.equal(snapshot.files.some((entry) => entry.path === '.env'), false);
  assert.equal(snapshot.files.some((entry) => entry.path === 'data/library-browse-index.json'), false);
  await assert.rejects(
    createSourceSnapshot({
      sourceWorktree: source,
      snapshotRoot: path.join(destination, 'bad-approved'),
      allowDirtySnapshot: true,
      approvedUntracked: ['.env'],
    }),
    /excluded by release policy/,
  );
});

test('manifest-backed artifact excludes secrets and detects tampering before staging', async (t) => {
  const source = await sourceFixture(t);
  const dependencies = await dependencyFixture(t, source);
  await write(source, 'src/config.mjs', 'export const fixtureConfig = "dirty-release";\n');
  await write(source, 'src/approved-untracked.mjs', 'export const approved = true;\n');
  await write(source, '.env', 'SECRET_SENTINEL=must-not-ship\n');
  await write(source, 'credentials/private.key', 'SECRET_SENTINEL=must-not-ship\n');
  await write(source, 'var/cache.json', 'SECRET_SENTINEL=must-not-ship\n');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-manifest-artifact-'));
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); });
  const artifactRoot = path.join(parent, 'artifact');
  const built = await buildReleaseArtifact({
    sourceWorktree: source,
    outputRoot: artifactRoot,
    dependencyRoot: dependencies,
    allowDirtySnapshot: true,
    approvedUntracked: ['src/approved-untracked.mjs'],
    buildTimestamp: '2026-10-24T00:00:00.000Z',
  });
  assert.match(built.releaseId, /^sonuvi-[a-f0-9]{64}$/);
  assert.equal(built.manifest.source.dirty, true);
  assert.equal(built.manifest.source.snapshotStatus, 'development-only-dirty-snapshot');
  assert.equal(await fs.readFile(path.join(artifactRoot, 'src', 'config.mjs'), 'utf8'), 'export const fixtureConfig = "dirty-release";\n');
  assert.equal(await fs.readFile(path.join(artifactRoot, 'config', 'radio-logo-aliases.json'), 'utf8'), '{"fixture.example":"Fixture Radio"}\n');
  for (const blocked of ['.env', 'credentials/private.key', 'var/cache.json', 'data/library-browse-index.json']) {
    await assert.rejects(fs.access(path.join(artifactRoot, blocked)));
  }
  const manifestText = await fs.readFile(path.join(artifactRoot, 'release-manifest.json'), 'utf8');
  assert.equal(manifestText.includes('SECRET_SENTINEL'), false);
  assert.equal(manifestText.includes(source), false);
  const verified = await verifyReleaseArtifact({ artifactRoot });
  assert.equal(verified.releaseId, built.releaseId);
  assert.equal(await fs.readFile(path.join(artifactRoot, 'public', 'release.json'), 'utf8').then((value) => JSON.parse(value).releaseId), built.releaseId);

  await fs.writeFile(path.join(artifactRoot, 'public', 'index.html'), '<!doctype html>tampered');
  await assert.rejects(verifyReleaseArtifact({ artifactRoot }), /inventory|identity|public asset/i);
});

test('release build fails on a missing static runtime helper and verifies its imported helper closure', async (t) => {
  const source = await sourceFixture(t);
  const dependencies = await dependencyFixture(t, source);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-imports-'));
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  await write(source, 'moode-nowplaying-api.mjs', 'import "./src/routes/runtime.mjs";\nexport const fixtureApi = true;\n');
  await write(source, 'src/routes/runtime.mjs', 'export const fixtureConfig = true;\n');
  await write(source, 'scripts/lastfm-authorize.mjs', 'import { helper } from "../src/lib/missing-helper.mjs";\nexport { helper };\n');
  await run('git', ['add', 'moode-nowplaying-api.mjs', 'src/routes/runtime.mjs', 'scripts/lastfm-authorize.mjs'], source);
  await run('git', ['commit', '-m', 'reference release helper'], source);

  await assert.rejects(
    buildReleaseArtifact({ sourceWorktree: source, outputRoot: path.join(parent, 'missing-helper'), dependencyRoot: dependencies }),
    /release static import is missing: scripts\/lastfm-authorize\.mjs -> \.\.\/src\/lib\/missing-helper\.mjs/,
  );

  await write(source, 'src/lib/missing-helper.mjs', 'export const helper = true;\n');
  await run('git', ['add', 'src/lib/missing-helper.mjs'], source);
  await run('git', ['commit', '-m', 'add release helper'], source);
  const built = await buildReleaseArtifact({
    sourceWorktree: source,
    outputRoot: path.join(parent, 'complete-helper'),
    dependencyRoot: dependencies,
  });
  assert.equal(await fs.readFile(path.join(built.artifactRoot, 'src/lib/missing-helper.mjs'), 'utf8'), 'export const helper = true;\n');
  const closure = await verifyReleaseRuntimeImportClosure({ artifactRoot: built.artifactRoot });
  assert.equal(closure.files.includes('src/lib/missing-helper.mjs'), true);
});

test('target dependency verification rejects a mismatched platform and artifact staging is read-only', async (t) => {
  const fixture = await releaseFixture(t);
  const metadataPath = path.join(fixture.dependencies, 'target-dependencies.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.target = { os: 'darwin', architecture: 'arm64' };
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(readTargetDependencyMetadata({ dependencyRoot: fixture.dependencies }), /linux\/arm64/);
  await writeTargetDependencyMetadata({
    dependencyRoot: fixture.dependencies,
    packageLockPath: path.join(fixture.source, 'package-lock.json'),
    target: { os: 'linux', architecture: 'arm64' },
    nodeVersion: 'v20.19.5',
    npmVersion: '10.8.2',
    buildEnvironment: { method: 'fixture-linux-arm64' },
  });
  const rebuilt = await buildReleaseArtifact({
    sourceWorktree: fixture.source,
    outputRoot: path.join(fixture.parent, 'stageable'),
    dependencyRoot: fixture.dependencies,
  });
  const layoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-layout-'));
  t.after(async () => {
    const stagedRoot = path.join(layoutRoot, 'releases', rebuilt.releaseId);
    if (await fs.stat(stagedRoot).then(() => true).catch(() => false)) await makeTreeWritableForCleanup(stagedRoot);
    await fs.rm(layoutRoot, { recursive: true, force: true });
  });
  const staged = await stageReleaseArtifact({ artifactRoot: rebuilt.artifactRoot, layoutRoot });
  assert.equal((await fs.stat(staged.releaseRoot)).mode & 0o777, 0o555);
  assert.equal((await fs.stat(path.join(staged.releaseRoot, 'release-manifest.json'))).mode & 0o222, 0);
  await verifyReleaseArtifact({ artifactRoot: staged.releaseRoot });
  await assert.rejects(fs.writeFile(path.join(staged.releaseRoot, 'release-manifest.json'), 'nope'));
});

test('incomplete artifacts are rejected before a release layout is created', async (t) => {
  const fixture = await releaseFixture(t);
  await fs.unlink(path.join(fixture.output, 'public', 'index.html'));
  const layoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-incomplete-layout-'));
  t.after(async () => { await fs.rm(layoutRoot, { recursive: true, force: true }); });
  await assert.rejects(stageReleaseArtifact({ artifactRoot: fixture.output, layoutRoot }), /inventory/);
  assert.equal(await fs.stat(path.join(layoutRoot, 'releases')).then(() => true).catch(() => false), false);
});

test('host promotion verifies an immediate staged artifact, makes only that release read-only, and never changes current', async (t) => {
  const fixture = await releaseFixture(t, { label: 'host-promotion' });
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-host-promotion-'));
  const stagingParent = path.join(hostRoot, '.staging');
  const releases = path.join(hostRoot, 'releases');
  const stagingRoot = path.join(stagingParent, fixture.built.releaseId);
  await fs.mkdir(stagingParent, { recursive: true });
  await fs.mkdir(releases, { recursive: true });
  await fs.cp(fixture.output, stagingRoot, { recursive: true });
  t.after(async () => {
    for (const entry of await fs.readdir(releases).catch(() => [])) {
      await makeTreeWritableForCleanup(path.join(releases, entry)).catch(() => {});
    }
    await fs.rm(hostRoot, { recursive: true, force: true });
  });

  const promoted = await promoteStagedHostRelease({ layoutRoot: hostRoot, stagingRoot });
  assert.equal(promoted.releaseId, fixture.built.releaseId);
  assert.equal(await fs.stat(path.join(hostRoot, 'current')).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(stagingRoot).then(() => true).catch(() => false), false);
  assert.equal((await fs.stat(promoted.releaseRoot)).mode & 0o777, 0o555);
  await verifyReleaseArtifact({ artifactRoot: promoted.releaseRoot });

  const duplicate = path.join(stagingParent, fixture.built.releaseId);
  await fs.cp(fixture.output, duplicate, { recursive: true });
  await assert.rejects(
    promoteStagedHostRelease({ layoutRoot: hostRoot, stagingRoot: duplicate }),
    /already exists/,
  );
});
