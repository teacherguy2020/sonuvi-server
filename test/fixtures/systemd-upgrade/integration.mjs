import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { activateReleaseTransaction, readReleaseActivationState, recoverInterruptedActivation } from '../../../src/lib/release-activation.mjs';
import { buildReleaseArtifact, canonicalJson, makeTreeReadOnly, writeTargetDependencyMetadata } from '../../../src/lib/release-artifact.mjs';
import { createLinuxSystemdUpgradeAdapter } from '../../../src/lib/sonuvi-linux-systemd-upgrade.mjs';

const execFile = promisify(execFileCallback);
const layoutRoot = '/opt/sonuvi';
const stateRoot = '/var/lib/sonuvi';
const unitRoot = '/etc/systemd/system';
const attemptId = 'boot_systemd_upgrade_fixture_20261109';
const targetIdentity = `sonuvi-target-v1-${'d'.repeat(64)}`;
const healthFailurePath = '/run/sonuvi-upgrade-fixture-fail-health';
const preservedState = Object.freeze({
  'protected/administrator.json': '{"contract":"fixture.admin","identity":"preserve-me"}\n',
  'protected/controller.json': '{"contract":"fixture.controller","identity":"preserve-me"}\n',
  'data/server-identity.json': '{"serverId":"fixture-server-identity"}\n',
  'config/now-playing.config.json': '{"ports":{"api":3101,"ui":8101},"fixture":true}\n',
  'data/library-browse-index.json': '{"schema":"now-playing.browse-index.v2","items":[]}\n',
});

async function run(command, args, options = {}) {
  return execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

async function write(root, relative, value, mode = 0o644) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fs.writeFile(target, value, { mode });
}

async function makeSource(root) {
  await fs.mkdir(root, { recursive: true });
  await write(root, 'package.json', JSON.stringify({ name: 'now-playing', version: '1.0.0' }));
  await write(root, 'package-lock.json', JSON.stringify({ name: 'now-playing', lockfileVersion: 3, packages: { '': { name: 'now-playing', version: '1.0.0' } } }));
  const sources = {
    'moode-nowplaying-api.mjs': 'console.log("API fixture entrypoint");\n',
    'build_moode_index.py': 'print("index fixture")\n',
    'lastfm_vibe_radio.py': 'print("vibe fixture")\n',
    'vibe_planner.py': 'print("planner fixture")\n',
    'src/config.mjs': 'export const fixture = true;\n',
    'scripts/serve-public-web.mjs': 'console.log("web fixture");\n',
    'scripts/verify-current-release.mjs': 'console.log("verify fixture");\n',
    'scripts/verify-release-runtime.mjs': 'console.log("runtime fixture");\n',
    'scripts/promote-staged-release.mjs': 'console.log("promote fixture");\n',
    'scripts/lastfm-authorize.mjs': 'console.log("authorize fixture");\n',
    'scripts/export-peppymeter-skins.mjs': 'console.log("skins fixture");\n',
    'scripts/sonuvi-bootstrap-helper.mjs': 'console.log("bootstrap fixture");\n',
    'scripts/sonuvi-bootstrap-status.mjs': 'console.log("status fixture");\n',
    'scripts/sonuvi-release-stage.mjs': 'console.log("stage fixture");\n',
    'scripts/sonuvi-admin-bootstrap.mjs': 'console.log("admin fixture");\n',
    'scripts/sonuvi-admin-session.mjs': 'console.log("session fixture");\n',
    'scripts/sonuvi-music-setup.mjs': 'console.log("session fixture");\n',
    'scripts/sonuvi-music-index.mjs': 'console.log("session fixture");\n',
    'scripts/sonuvi-debian-node-bootstrap.sh': '#!/bin/sh\nexit 0\n',
    'scripts/sonuvi-target-installer.mjs': 'console.log("target fixture");\n',
    'config/now-playing.config.example.json': '{}\n',
    'ops/systemd/sonuvi-api.service.in': '[Service]\nExecStart=/usr/bin/node api.mjs\n',
    'ops/systemd/sonuvi-web.service.in': '[Service]\nExecStart=/usr/bin/node web.mjs\n',
    'index.html': '<!doctype html><title>fixture</title>',
    'controller.html': '<!doctype html><title>fixture controller</title>',
  };
  for (const [relative, value] of Object.entries(sources)) await write(root, relative, value);
  await write(root, 'src/systemd-probe.mjs', `
import fs from 'node:fs';
import http from 'node:http';
const kind = process.argv[2];
const releaseId = process.env.SONUVI_RELEASE_ID;
const api = kind === 'api';
const server = http.createServer((_request, response) => {
  const failFor = fs.readFileSync('${healthFailurePath}', 'utf8').trim();
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(api
    ? { contract: 'sonuvi.health.v1', ok: failFor !== releaseId, release: { mode: 'immutable-release', releaseId } }
    : { contract: 'sonuvi.release-web-identity.v1', releaseId }));
});
server.listen(api ? 3101 : 8101, '127.0.0.1');
`);
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'systemd-fixture@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Systemd fixture'], { cwd: root });
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['commit', '-q', '-m', 'fixture release one'], { cwd: root });
}

async function buildRelease({ sourceRoot, dependenciesRoot, outputRoot, marker }) {
  await write(sourceRoot, 'src/release-marker.txt', `${marker}\n`);
  await run('git', ['add', 'src/release-marker.txt'], { cwd: sourceRoot });
  await run('git', ['commit', '-q', '-m', `fixture ${marker}`], { cwd: sourceRoot });
  return buildReleaseArtifact({ sourceWorktree: sourceRoot, dependencyRoot: dependenciesRoot, outputRoot });
}

async function currentRelease() {
  return path.basename(await fs.realpath(path.join(layoutRoot, 'current')));
}

async function makeUnit(unit, service, releaseId) {
  const file = path.join(unitRoot, unit);
  const value = `[Unit]\nDescription=Isolated Sonuvi ${service} upgrade fixture\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${releaseId}\nEnvironment=SONUVI_RELEASE_ID=${releaseId}\nExecStart=/usr/bin/node /opt/sonuvi/current/src/systemd-probe.mjs ${service}\nRestart=on-failure\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\n`;
  await fs.writeFile(file, value, { mode: 0o644 });
  await fs.chown(file, 0, 0);
}

async function verifyPreservedState() {
  for (const [relative, expected] of Object.entries(preservedState)) {
    assert.equal(await fs.readFile(path.join(stateRoot, relative), 'utf8'), expected, relative);
  }
}

async function assertHealth(expectedReleaseId) {
  for (const [url, identity] of [
    ['http://127.0.0.1:3101/health', 'api'],
    ['http://127.0.0.1:8101/release.json', 'web'],
  ]) {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.status, 200, identity);
        const value = await response.json();
        if (identity === 'api') assert.equal(value.ok, true);
        assert.equal(identity === 'api' ? value.release.releaseId : value.releaseId, expectedReleaseId);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) {
      const status = await run('/usr/bin/systemctl', ['--no-pager', '--full', 'status', `sonuvi-${identity}.service`]).catch((error) => ({ stdout: error.stdout || error.stderr || '' }));
      throw new Error(`${identity} fixture health unavailable; ${String(status.stdout).slice(0, 2000)}`);
    }
  }
}

async function signedEnvelope(release, keyPair, keyId) {
  const manifestBytes = await fs.readFile(path.join(release.artifactRoot, 'release-manifest.json'));
  const payload = {
    contract: 'sonuvi.gate-c-release-metadata.v1',
    releaseId: release.releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { bytes: 1, format: 'sonuvi.release-tar.v1', sha256: 'a'.repeat(64) },
    bootstrap: { version: 2, sha256: 'b'.repeat(64) },
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  return {
    contract: 'sonuvi.gate-c-release-envelope.v1',
    keyId,
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), keyPair.privateKey).toString('base64url'),
  };
}

async function assertFreshContainerPaths() {
  for (const candidate of [layoutRoot, stateRoot, path.join(unitRoot, 'sonuvi-api.service'), path.join(unitRoot, 'sonuvi-web.service')]) {
    await assert.rejects(fs.lstat(candidate), { code: 'ENOENT' }, `refusing to replace an existing fixture path: ${candidate}`);
  }
}

async function setup() {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0) {
    throw new Error('run only as root in the isolated Debian ARM64 systemd container');
  }
  const manager = await run('/usr/bin/systemctl', ['show', '--property=Version', '--value']);
  assert.match(manager.stdout, /^\d+/);
  await assertFreshContainerPaths();

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-systemd-upgrade-integration-'));
  const sourceRoot = path.join(workspace, 'source');
  const dependenciesRoot = path.join(workspace, 'dependencies');
  const artifactRoot = path.join(workspace, 'artifacts');
  await fs.mkdir(artifactRoot, { recursive: true });
  await makeSource(sourceRoot);
  await write(dependenciesRoot, 'node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await writeTargetDependencyMetadata({
    dependencyRoot: dependenciesRoot,
    packageLockPath: path.join(sourceRoot, 'package-lock.json'),
    target: { os: 'linux', architecture: 'arm64' },
    nodeVersion: process.version,
    npmVersion: '10.8.2',
    buildEnvironment: { method: 'isolated-systemd-fixture' },
  });
  const releases = [];
  for (const [index, marker] of ['one', 'two', 'three', 'four'].entries()) {
    releases.push(await buildRelease({
      sourceRoot,
      dependenciesRoot,
      outputRoot: path.join(artifactRoot, marker),
      marker: `${index}-${marker}`,
    }));
  }

  await fs.mkdir(path.join(layoutRoot, 'releases'), { recursive: true, mode: 0o755 });
  await fs.chown(layoutRoot, 0, 0);
  await fs.chown(path.join(layoutRoot, 'releases'), 0, 0);
  for (const release of releases) {
    const destination = path.join(layoutRoot, 'releases', release.releaseId);
    await fs.cp(release.artifactRoot, destination, { recursive: true, errorOnExist: true, force: false });
    await makeTreeReadOnly(destination);
    await fs.chown(destination, 0, 0);
  }
  const [first, second, third, fourth] = releases;
  await fs.symlink(`releases/${first.releaseId}`, path.join(layoutRoot, 'current'));

  await fs.mkdir(path.join(stateRoot, 'checkpoints'), { recursive: true, mode: 0o755 });
  for (const [relative, value] of Object.entries(preservedState)) await write(stateRoot, relative, value, 0o640);
  const initialCheckpoint = {
    contract: 'sonuvi.release-activation.v1', transactionId: crypto.randomUUID(), phase: 'committed',
    candidateReleaseId: first.releaseId, previousReleaseId: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), rollback: null,
  };
  const startupCheckpointPath = path.join(stateRoot, 'checkpoints/release-activation-state.json');
  await fs.writeFile(startupCheckpointPath, `${JSON.stringify(initialCheckpoint, null, 2)}\n`, { mode: 0o600 });
  const originalCheckpointBytes = await fs.readFile(startupCheckpointPath);

  await makeUnit('sonuvi-api.service', 'api', first.releaseId);
  await makeUnit('sonuvi-web.service', 'web', first.releaseId);
  await run('/usr/bin/systemctl', ['daemon-reload']);
  await run('/usr/bin/systemctl', ['enable', 'sonuvi-api.service', 'sonuvi-web.service']);
  await run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']);
  await fs.writeFile(healthFailurePath, 'none\n', { mode: 0o600 });
  await assertHealth(first.releaseId);

  const unitSnapshots = new Map();
  const unitModes = new Map();
  for (const unit of ['sonuvi-api.service', 'sonuvi-web.service']) {
    const file = path.join(unitRoot, unit);
    unitSnapshots.set(file, await fs.readFile(file));
    unitModes.set(file, (await fs.stat(file)).mode & 0o7777);
  }
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'linux-systemd-fixture-key';
  const trustedAnchors = { [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const adapter = createLinuxSystemdUpgradeAdapter();
  async function activate(candidate, previous, selectedAdapter = adapter) {
    return activateReleaseTransaction({
      layoutRoot,
      stateRoot,
      ownerUID: 0,
      releaseId: candidate.releaseId,
      expectedPreviousReleaseId: previous.releaseId,
      attemptId,
      targetIdentity,
      envelope: await signedEnvelope(candidate, keyPair, keyId),
      trustedAnchors,
      adapter: selectedAdapter,
    });
  }
  return { workspace, first, second, third, fourth, originalCheckpointBytes, unitSnapshots, unitModes, adapter, activate };
}

async function verifyPreservedUnitConfiguration(fixture, expectedReleaseId) {
  for (const [file, original] of fixture.unitSnapshots) {
    const expected = original.toString('utf8')
      .replaceAll(fixture.first.releaseId, expectedReleaseId)
      .replaceAll(`/opt/sonuvi/releases/${fixture.first.releaseId}`, `/opt/sonuvi/releases/${expectedReleaseId}`);
    assert.equal(await fs.readFile(file, 'utf8'), expected, path.basename(file));
    assert.equal((await fs.stat(file)).mode & 0o7777, fixture.unitModes.get(file), path.basename(file));
    assert.equal((await fs.stat(file)).uid, 0, path.basename(file));
    assert.equal((await fs.stat(file)).gid, 0, path.basename(file));
  }
}

async function main() {
  const fixture = await setup();
  const startupCheckpoint = path.join(stateRoot, 'checkpoints/release-activation-state.json');
  try {
    const success = await fixture.activate(fixture.second, fixture.first);
    assert.equal(success.state.phase, 'committed');
    assert.equal(await currentRelease(), fixture.second.releaseId);
    await assertHealth(fixture.second.releaseId);
    await verifyPreservedState();
    await verifyPreservedUnitConfiguration(fixture, fixture.second.releaseId);
    const committedBytes = await fs.readFile(startupCheckpoint);
    const committed = JSON.parse(committedBytes.toString('utf8'));
    assert.equal(committed.contract, 'sonuvi.release-activation.v1');
    assert.equal(committed.phase, 'committed');
    assert.equal(committed.candidateReleaseId, fixture.second.releaseId);
    assert.equal((await fs.stat(startupCheckpoint)).mode & 0o7777, 0o600);
    for (const unit of ['sonuvi-api.service', 'sonuvi-web.service']) {
      assert.equal((await run('/usr/bin/systemctl', ['is-enabled', unit])).stdout.trim(), 'enabled');
    }
    console.log('PASS real systemd activation starts and verifies the exact API/web release identity');

    await fs.writeFile(healthFailurePath, `${fixture.third.releaseId}\n`, { mode: 0o600 });
    await assert.rejects(fixture.activate(fixture.third, fixture.second), /health check failed|upgrade_health_identity_mismatch/);
    assert.equal(await currentRelease(), fixture.second.releaseId);
    await assertHealth(fixture.second.releaseId);
    await verifyPreservedState();
    await verifyPreservedUnitConfiguration(fixture, fixture.second.releaseId);
    assert.deepEqual(await fs.readFile(startupCheckpoint), committedBytes, 'failed activation restores the original release-specific startup checkpoint');
    console.log('PASS health failure rolls back the pointer, systemd units, services, permissions, and checkpoint');

    const interruptedAdapter = Object.freeze({
      ...fixture.adapter,
      async restart(context) {
        await fixture.adapter.restart(context);
        throw new Error('fixture_interrupted_after_systemd_restart');
      },
      async rollback() { throw new Error('fixture_interrupted_before_rollback'); },
    });
    await fs.writeFile(healthFailurePath, 'none\n', { mode: 0o600 });
    await assert.rejects(fixture.activate(fixture.fourth, fixture.second, interruptedAdapter), /rollback failed/);
    assert.equal((await readReleaseActivationState({ layoutRoot, stateRoot, ownerUID: 0 })).phase, 'manual-recovery-required');
    const recovered = await recoverInterruptedActivation({ layoutRoot, stateRoot, ownerUID: 0, targetIdentity, adapter: fixture.adapter });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.previousReleaseId, fixture.second.releaseId);
    assert.equal(await currentRelease(), fixture.second.releaseId);
    await assertHealth(fixture.second.releaseId);
    await verifyPreservedState();
    await verifyPreservedUnitConfiguration(fixture, fixture.second.releaseId);
    assert.deepEqual(await fs.readFile(startupCheckpoint), committedBytes, 'interrupted recovery preserves the prior release-specific checkpoint');
    const recoveredState = await readReleaseActivationState({ layoutRoot, stateRoot, ownerUID: 0 });
    assert.equal(recoveredState.phase, 'recovered');
    console.log('PASS interrupted service restart is recovered through the independent upgrade journal');

    const api = await run('/usr/bin/systemctl', ['show', '--property=MainPID', '--value', 'sonuvi-api.service']);
    const environment = await fs.readFile(`/proc/${api.stdout.trim()}/environ`);
    assert.ok(environment.includes(Buffer.from(`SONUVI_RELEASE_ID=${fixture.second.releaseId}`)));
    assert.ok(environment.includes(Buffer.from(`SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${fixture.second.releaseId}`)));
    console.log('PASS running process environment matches the verified release and startup checkpoint remains intact');
  } finally {
    await run('/usr/bin/systemctl', ['stop', 'sonuvi-web.service', 'sonuvi-api.service']).catch(() => {});
    await fs.rm(fixture.workspace, { recursive: true, force: true });
  }
}

await main();
