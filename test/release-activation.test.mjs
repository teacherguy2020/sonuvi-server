import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildReleaseArtifact,
  makeTreeWritableForCleanup,
  stageReleaseArtifact,
  writeTargetDependencyMetadata,
} from '../src/lib/release-artifact.mjs';
import {
  activateReleaseTransaction,
  readReleaseActivationState,
  readReleaseTrafficGate,
  recoverInterruptedActivation,
} from '../src/lib/release-activation.mjs';

const execFile = promisify(execFileCallback);

async function run(binary, args, cwd) {
  await execFile(binary, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

async function write(root, relative, content = 'fixture') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-activation-'));
  t.after(async () => {
    const releases = path.join(root, 'layout', 'releases');
    for (const entry of await fs.readdir(releases).catch(() => [])) {
      await makeTreeWritableForCleanup(path.join(releases, entry)).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  const dependencies = path.join(root, 'dependencies');
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(source, { recursive: true });
  await write(source, 'package.json', JSON.stringify({ name: 'now-playing', version: '1.0.0' }));
  await write(source, 'package-lock.json', JSON.stringify({ name: 'now-playing', lockfileVersion: 3, packages: { '': { name: 'now-playing', version: '1.0.0' } } }));
  await write(source, 'moode-nowplaying-api.mjs', 'export const api = "one";\n');
  await write(source, 'build_moode_index.py', 'print("index")\n');
  await write(source, 'lastfm_vibe_radio.py', 'print("vibe")\n');
  await write(source, 'vibe_planner.py', 'print("planner")\n');
  await write(source, 'src/config.mjs', 'export const config = "one";\n');
  await write(source, 'scripts/serve-public-web.mjs', 'console.log("web");\n');
  await write(source, 'scripts/verify-current-release.mjs', 'console.log("verify");\n');
  await write(source, 'scripts/verify-release-runtime.mjs', 'console.log("runtime verify");\n');
  await write(source, 'scripts/promote-staged-release.mjs', 'console.log("promote");\n');
  await write(source, 'scripts/lastfm-authorize.mjs', 'console.log("lastfm");\n');
  await write(source, 'scripts/export-peppymeter-skins.mjs', 'console.log("skins");\n');
  await write(source, 'config/now-playing.config.example.json', '{}\n');
  await write(source, 'index.html', '<!doctype html>one');
  await write(source, 'controller.html', '<!doctype html>controller');
  await run('git', ['init'], source);
  await run('git', ['config', 'user.email', 'fixture@example.test'], source);
  await run('git', ['config', 'user.name', 'Fixture'], source);
  await run('git', ['add', '.'], source);
  await run('git', ['commit', '-m', 'release one'], source);

  await write(dependencies, 'node_modules/sharp/package.json', JSON.stringify({ name: 'sharp', version: '0.33.5' }));
  await write(dependencies, 'node_modules/@img/sharp-linux-arm64/package.json', JSON.stringify({ name: '@img/sharp-linux-arm64', version: '0.33.5' }));
  await write(dependencies, 'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node', 'fixture linux native');
  await writeTargetDependencyMetadata({
    dependencyRoot: dependencies,
    packageLockPath: path.join(source, 'package-lock.json'),
    target: { os: 'linux', architecture: 'arm64' },
    nodeVersion: 'v20.19.5',
    npmVersion: '10.8.2',
    buildEnvironment: { method: 'fixture' },
  });
  await fs.mkdir(artifacts, { recursive: true });
  const first = await buildReleaseArtifact({ sourceWorktree: source, outputRoot: path.join(artifacts, 'first'), dependencyRoot: dependencies });
  await write(source, 'src/config.mjs', 'export const config = "two";\n');
  await run('git', ['add', 'src/config.mjs'], source);
  await run('git', ['commit', '-m', 'release two'], source);
  const second = await buildReleaseArtifact({ sourceWorktree: source, outputRoot: path.join(artifacts, 'second'), dependencyRoot: dependencies });
  const layoutRoot = path.join(root, 'layout');
  const stagedFirst = await stageReleaseArtifact({ artifactRoot: first.artifactRoot, layoutRoot });
  const stagedSecond = await stageReleaseArtifact({ artifactRoot: second.artifactRoot, layoutRoot });
  await write(layoutRoot, 'shared/config/now-playing.config.json', '{"nodes":[{"role":"api"}],"ports":{"api":3101,"ui":8101}}\n');
  await write(layoutRoot, 'shared/data/library-browse-index.json', '{"schema":"now-playing.browse-index.v2"}\n');
  async function pointAt(staged) {
    await fs.unlink(path.join(layoutRoot, 'current')).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    await fs.symlink(path.relative(layoutRoot, staged.releaseRoot), path.join(layoutRoot, 'current'));
  }
  await pointAt(stagedFirst);
  return { root, layoutRoot, first: stagedFirst, second: stagedSecond, pointAt };
}

function healthyAdapter(calls, { fail = '' } = {}) {
  const failures = new Set(String(fail).split(',').map((item) => item.trim()).filter(Boolean));
  return {
    async prepare(context) {
      calls.push(['prepare', context.candidate.releaseId]);
      assert.equal(await readReleaseTrafficGate({ layoutRoot: context.layout.root }), null, 'traffic must be gated before service preparation');
    },
    async restart(context) {
      calls.push(['restart', context.candidate.releaseId]);
      assert.equal(await currentRelease(context.layout.root), context.candidate.releaseId, 'services restart only after the pointer switch');
    },
    async verify({ service, expectedReleaseId, candidate }) {
      calls.push(['verify', service, expectedReleaseId]);
      if (failures.has(`startup:${service}`) && expectedReleaseId === candidate.releaseId) throw new Error(`${service} startup failed`);
      return { releaseId: expectedReleaseId };
    },
    async health({ service, expectedReleaseId, candidate }) {
      calls.push(['health', service, expectedReleaseId]);
      if (failures.has(`health:${service}`) && expectedReleaseId === candidate.releaseId) return { ok: false, releaseId: expectedReleaseId };
      return { ok: true, releaseId: expectedReleaseId };
    },
    async commit(context) { calls.push(['commit', context.candidate.releaseId]); },
    async rollback(context) {
      calls.push(['rollback', context.previous.releaseId]);
      if (failures.has('rollback')) throw new Error('rollback failed');
    },
  };
}

async function currentRelease(layoutRoot) {
  return path.basename(await fs.realpath(path.join(layoutRoot, 'current')));
}

test('paired API/web activation commits a single release identity only after both fixture services verify and pass health', async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const result = await activateReleaseTransaction({
    layoutRoot: fixture.layoutRoot,
    releaseId: fixture.second.releaseId,
    adapter: healthyAdapter(calls),
  });
  assert.equal(result.releaseId, fixture.second.releaseId);
  assert.equal(result.previousReleaseId, fixture.first.releaseId);
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.second.releaseId);
  assert.deepEqual(calls.map((entry) => entry.slice(0, 2)), [
    ['prepare', fixture.second.releaseId],
    ['restart', fixture.second.releaseId],
    ['verify', 'api'],
    ['verify', 'web'],
    ['health', 'api'],
    ['health', 'web'],
    ['commit', fixture.second.releaseId],
  ]);
  const state = await readReleaseActivationState({ layoutRoot: fixture.layoutRoot });
  assert.equal(state.phase, 'committed');
  assert.equal(state.candidateReleaseId, fixture.second.releaseId);
  assert.equal((await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot })).releaseId, fixture.second.releaseId);
});

test('API startup, web startup, and health failures restore the previous pointer without deleting the candidate or shared state', async (t) => {
  const fixture = await createFixture(t);
  for (const failure of ['startup:api', 'startup:web', 'health:api', 'health:web']) {
    await fixture.pointAt(fixture.first);
    const calls = [];
    await assert.rejects(
      activateReleaseTransaction({ layoutRoot: fixture.layoutRoot, releaseId: fixture.second.releaseId, adapter: healthyAdapter(calls, { fail: failure }) }),
      /(startup failed|health check failed)/,
    );
    assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId, failure);
    assert.equal(await fs.stat(fixture.second.releaseRoot).then(() => true), true, failure);
    assert.equal(await fs.readFile(path.join(fixture.layoutRoot, 'shared/config/now-playing.config.json'), 'utf8'), '{"nodes":[{"role":"api"}],"ports":{"api":3101,"ui":8101}}\n');
    assert.equal((await readReleaseActivationState({ layoutRoot: fixture.layoutRoot })).phase, 'rolled-back');
    assert.equal(calls.some((entry) => entry[0] === 'rollback'), true, failure);
    assert.equal((await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot })).releaseId, fixture.first.releaseId, failure);
  }
});

test('activation preflight rejects missing configuration, unwritable shared state, and incompatible catalog schemas before pointer switching', async (t) => {
  const fixture = await createFixture(t);
  const configPath = path.join(fixture.layoutRoot, 'shared/config/now-playing.config.json');
  await fs.unlink(configPath);
  await assert.rejects(
    activateReleaseTransaction({ layoutRoot: fixture.layoutRoot, releaseId: fixture.second.releaseId, adapter: healthyAdapter([]) }),
    /configuration is missing/,
  );
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);

  await write(fixture.layoutRoot, 'shared/config/now-playing.config.json', '{}\n');
  const dataDirectory = path.join(fixture.layoutRoot, 'shared/data');
  await fs.chmod(dataDirectory, 0o500);
  try {
    await assert.rejects(
      activateReleaseTransaction({ layoutRoot: fixture.layoutRoot, releaseId: fixture.second.releaseId, adapter: healthyAdapter([]) }),
      /not writable/,
    );
  } finally {
    await fs.chmod(dataDirectory, 0o700);
  }
  await write(fixture.layoutRoot, 'shared/data/library-browse-index.json', '{"schema":"now-playing.browse-index.v3"}\n');
  await assert.rejects(
    activateReleaseTransaction({ layoutRoot: fixture.layoutRoot, releaseId: fixture.second.releaseId, adapter: healthyAdapter([]) }),
    /not compatible/,
  );
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);
});

test('an existing activation lock prevents a concurrent transaction before services or the release pointer change', async (t) => {
  const fixture = await createFixture(t);
  const lockPath = path.join(fixture.layoutRoot, 'shared/checkpoints/release-activation.lock');
  await fs.writeFile(lockPath, '{"transactionId":"already-running"}\n', { mode: 0o600 });
  const calls = [];

  await assert.rejects(
    activateReleaseTransaction({ layoutRoot: fixture.layoutRoot, releaseId: fixture.second.releaseId, adapter: healthyAdapter(calls) }),
    /activation lock already exists/,
  );
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);
  assert.deepEqual(calls, []);
});

test('interrupted activation recovery restores the retained previous release and refuses guesswork when it is missing', async (t) => {
  const fixture = await createFixture(t);
  const checkpoint = path.join(fixture.layoutRoot, 'shared/checkpoints');
  await fixture.pointAt(fixture.second);
  const interrupted = {
    contract: 'sonuvi.release-activation.v1',
    transactionId: 'fixture-interrupted',
    phase: 'pointer-switched',
    candidateReleaseId: fixture.second.releaseId,
    previousReleaseId: fixture.first.releaseId,
    startedAt: '2026-10-24T00:00:00.000Z',
    completedAt: null,
    rollback: null,
  };
  await fs.writeFile(path.join(checkpoint, 'release-activation-state.json'), JSON.stringify(interrupted));
  await fs.writeFile(path.join(checkpoint, 'release-activation.lock'), JSON.stringify(interrupted));
  const calls = [];
  const recovered = await recoverInterruptedActivation({ layoutRoot: fixture.layoutRoot, adapter: healthyAdapter(calls) });
  assert.equal(recovered.recovered, true);
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);
  assert.equal((await readReleaseActivationState({ layoutRoot: fixture.layoutRoot })).phase, 'recovered');
  assert.equal(calls.some((entry) => entry[0] === 'rollback'), true);
  assert.equal((await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot })).releaseId, fixture.first.releaseId);

  const missingPrevious = { ...interrupted, transactionId: 'fixture-missing', previousReleaseId: `sonuvi-${'f'.repeat(64)}` };
  await fs.writeFile(path.join(checkpoint, 'release-activation-state.json'), JSON.stringify(missingPrevious));
  await fs.writeFile(path.join(checkpoint, 'release-activation.lock'), JSON.stringify(missingPrevious));
  await assert.rejects(recoverInterruptedActivation({ layoutRoot: fixture.layoutRoot, adapter: healthyAdapter([]) }), /manual recovery/);
  assert.equal((await readReleaseActivationState({ layoutRoot: fixture.layoutRoot })).phase, 'manual-recovery-required');
  assert.equal(await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot }), null, 'manual recovery must leave public traffic closed');
});

test('rollback keeps traffic closed if the previous API/web pair cannot be restored, and interrupted recovery tolerates a corrupt candidate', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    activateReleaseTransaction({
      layoutRoot: fixture.layoutRoot,
      releaseId: fixture.second.releaseId,
      adapter: healthyAdapter([], { fail: 'startup:api' }),
    }),
    /startup failed/,
  );
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);

  await fixture.pointAt(fixture.second);
  const checkpoint = path.join(fixture.layoutRoot, 'shared/checkpoints');
  const interrupted = {
    contract: 'sonuvi.release-activation.v1',
    transactionId: 'fixture-corrupt-candidate',
    phase: 'pointer-switched',
    candidateReleaseId: fixture.second.releaseId,
    previousReleaseId: fixture.first.releaseId,
    startedAt: '2026-10-24T00:00:00.000Z',
    completedAt: null,
    rollback: null,
  };
  await fs.writeFile(path.join(checkpoint, 'release-activation-state.json'), JSON.stringify(interrupted));
  await fs.writeFile(path.join(checkpoint, 'release-activation.lock'), JSON.stringify(interrupted));
  await makeTreeWritableForCleanup(fixture.second.releaseRoot);
  await fs.appendFile(path.join(fixture.second.releaseRoot, 'src/config.mjs'), '// corrupt candidate\n');

  const recovered = await recoverInterruptedActivation({ layoutRoot: fixture.layoutRoot, adapter: healthyAdapter([]) });
  assert.equal(recovered.recovered, true);
  assert.equal(await currentRelease(fixture.layoutRoot), fixture.first.releaseId);
  assert.equal((await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot })).releaseId, fixture.first.releaseId);
});

test('a rollback adapter failure leaves the traffic gate closed for manual recovery', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    activateReleaseTransaction({
      layoutRoot: fixture.layoutRoot,
      releaseId: fixture.second.releaseId,
      adapter: healthyAdapter([], { fail: 'health:api,rollback' }),
    }),
    /rollback failed/,
  );
  assert.equal((await readReleaseActivationState({ layoutRoot: fixture.layoutRoot })).phase, 'manual-recovery-required');
  assert.equal(await readReleaseTrafficGate({ layoutRoot: fixture.layoutRoot }), null);
});
