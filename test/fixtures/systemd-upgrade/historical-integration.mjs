import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  activateReleaseTransaction,
  readReleaseActivationState,
  recoverInterruptedActivation,
} from '../../../src/lib/release-activation.mjs';
import {
  canonicalJson,
  makeTreeReadOnly,
  verifyReleaseArtifact,
} from '../../../src/lib/release-artifact.mjs';
import { createLinuxSystemdUpgradeAdapter } from '../../../src/lib/sonuvi-linux-systemd-upgrade.mjs';

const execFile = promisify(execFileCallback);
const layoutRoot = '/opt/sonuvi';
const stateRoot = '/var/lib/sonuvi';
const unitRoot = '/etc/systemd/system';
const historicalArchive = '/artifacts/historical.tar';
const candidateArchive = '/artifacts/candidate.tar';
const healthFailurePath = '/run/sonuvi-historical-systemd-fail-health';
const attemptId = 'boot_historical_systemd_fixture_20261109';
const targetIdentity = `sonuvi-target-v1-${'d'.repeat(64)}`;
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

async function writeFile(relative, value, mode = 0o644) {
  const target = path.isAbsolute(relative) ? relative : path.join(stateRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fs.writeFile(target, value, { mode });
  await fs.chmod(target, mode);
  return target;
}

async function extractArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  await run('/usr/bin/tar', ['-xf', archive, '-C', destination]);
}

async function readReleaseId(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8'));
  return manifest.releaseId;
}

async function installArchive(archive, destination, expectedReleaseId) {
  const extracted = path.join('/tmp', `sonuvi-historical-${expectedReleaseId}`);
  await fs.rm(extracted, { recursive: true, force: true });
  await extractArchive(archive, extracted);
  assert.equal(await readReleaseId(extracted), expectedReleaseId);
  assert.equal((await verifyReleaseArtifact({ artifactRoot: extracted })).releaseId, expectedReleaseId);
  await fs.cp(extracted, destination, { recursive: true, errorOnExist: true, force: false });
  await run('/usr/bin/chown', ['-R', '0:0', destination]);
  await makeTreeReadOnly(destination);
  await fs.rm(extracted, { recursive: true, force: true });
}

async function currentRelease() {
  return path.basename(await fs.realpath(path.join(layoutRoot, 'current')));
}

async function setCurrent(releaseId) {
  await fs.unlink(path.join(layoutRoot, 'current')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await fs.symlink(`releases/${releaseId}`, path.join(layoutRoot, 'current'));
}

async function writeProbe() {
  await fs.writeFile('/run/sonuvi-historical-systemd-probe.mjs', `
import fs from 'node:fs';
import http from 'node:http';
const kind = process.argv[2];
const releaseId = process.env.SONUVI_RELEASE_ID;
const failedRelease = fs.readFileSync('${healthFailurePath}', 'utf8').trim();
const api = kind === 'api';
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(api
    ? { contract: 'sonuvi.health.v1', ok: failedRelease !== releaseId, release: { mode: 'immutable-release', releaseId } }
    : { contract: 'sonuvi.release-web-identity.v1', releaseId }));
});
server.listen(api ? 3101 : 8101, '127.0.0.1');
`, { mode: 0o755 });
  await fs.chmod('/run/sonuvi-historical-systemd-probe.mjs', 0o755);
}

async function writeUnit(unit, service, releaseId) {
  const target = path.join(unitRoot, unit);
  const value = [
    '[Unit]',
    `Description=Sonuvi historical release ${service} fixture`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'User=sonuvi',
    'Group=sonuvi',
    'WorkingDirectory=/opt/sonuvi/current',
    `Environment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${releaseId}`,
    'Environment=SONUVI_STATE_ROOT=/var/lib/sonuvi',
    `Environment=SONUVI_RELEASE_ID=${releaseId}`,
    'Environment=SONUVI_ACTIVATION_STATE=/var/lib/sonuvi/checkpoints/release-activation-state.json',
    'ExecStartPre=/usr/bin/node /opt/sonuvi/current/scripts/verify-current-release.mjs',
    `ExecStart=/usr/bin/node /run/sonuvi-historical-systemd-probe.mjs ${service}`,
    'Restart=on-failure',
    'RestartSec=1',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  await fs.writeFile(target, value, { mode: 0o644 });
  await fs.chmod(target, 0o644);
  return target;
}

async function assertHealth(expectedReleaseId) {
  for (const [url, service] of [
    ['http://127.0.0.1:3101/health', 'api'],
    ['http://127.0.0.1:8101/release.json', 'web'],
  ]) {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.status, 200, service);
        const value = await response.json();
        if (service === 'api') assert.equal(value.ok, true);
        assert.equal(service === 'api' ? value.release.releaseId : value.releaseId, expectedReleaseId);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) {
      const status = await run('/usr/bin/systemctl', ['--no-pager', '--full', 'status', `sonuvi-${service}.service`])
        .catch((error) => ({ stdout: error.stdout || error.stderr || '' }));
      throw new Error(`${service} health unavailable: ${String(status.stdout).slice(0, 2000)}`);
    }
  }
}

async function verifyPreservedState() {
  for (const [relative, expected] of Object.entries(preservedState)) {
    assert.equal(await fs.readFile(path.join(stateRoot, relative), 'utf8'), expected, relative);
  }
}

async function signedEnvelope(candidate, keyPair, keyId) {
  const manifest = await fs.readFile(path.join(candidate.root, 'release-manifest.json'));
  const payload = {
    contract: 'sonuvi.gate-c-release-metadata.v1',
    releaseId: candidate.releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
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

async function stopServices() {
  await run('/usr/bin/systemctl', ['stop', 'sonuvi-web.service', 'sonuvi-api.service']).catch(() => {});
}

async function setup() {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0) {
    throw new Error('run only as root in the isolated Debian ARM64 systemd container');
  }
  await run('/usr/bin/systemctl', ['show', '--property=Version', '--value']);
  await run('/usr/sbin/useradd', ['--system', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'sonuvi'])
    .catch((error) => {
      if (!String(error.stderr || '').includes('already exists')) throw error;
    });
  await writeProbe();

  const workspace = '/tmp/sonuvi-historical-systemd-fixture';
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(path.join(layoutRoot, 'releases'), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(stateRoot, 'checkpoints'), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(unitRoot), { recursive: true, mode: 0o755 });
  await fs.chown(layoutRoot, 0, 0);
  await fs.chown(path.join(layoutRoot, 'releases'), 0, 0);
  await fs.chown(stateRoot, 0, 0);
  await fs.chown(path.join(stateRoot, 'checkpoints'), 0, 0);

  const historicalExtract = path.join(workspace, 'historical');
  const candidateExtract = path.join(workspace, 'candidate');
  await extractArchive(historicalArchive, historicalExtract);
  await extractArchive(candidateArchive, candidateExtract);
  const historicalReleaseId = await readReleaseId(historicalExtract);
  const candidateReleaseId = await readReleaseId(candidateExtract);
  assert.equal(historicalReleaseId, 'sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912');
  assert.equal(candidateReleaseId, 'sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66');
  assert.equal(await fs.access(path.join(historicalExtract, 'scripts/sonuvi-admin-session.mjs')).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(path.join(candidateExtract, 'scripts/sonuvi-admin-session.mjs')).then(() => true).catch(() => false), true);
  await installArchive(historicalArchive, path.join(layoutRoot, 'releases', historicalReleaseId), historicalReleaseId);
  await installArchive(candidateArchive, path.join(layoutRoot, 'releases', candidateReleaseId), candidateReleaseId);
  await fs.rm(workspace, { recursive: true, force: true });

  for (const [relative, value] of Object.entries(preservedState)) await writeFile(relative, value, relative.startsWith('protected/') ? 0o600 : 0o640);
  const checkpointPath = await writeFile('checkpoints/release-activation-state.json', `${JSON.stringify({
    contract: 'sonuvi.release-activation.v1',
    transactionId: crypto.randomUUID(),
    phase: 'committed',
    candidateReleaseId: historicalReleaseId,
    previousReleaseId: null,
  }, null, 2)}\n`, 0o640);
  await fs.chown(checkpointPath, 0, Number((await run('/usr/bin/id', ['-g', 'sonuvi'])).stdout.trim()));
  const originalCheckpoint = await fs.readFile(checkpointPath);
  await setCurrent(historicalReleaseId);
  await writeUnit('sonuvi-api.service', 'api', historicalReleaseId);
  await writeUnit('sonuvi-web.service', 'web', historicalReleaseId);
  await fs.writeFile(healthFailurePath, 'none\n', { mode: 0o644 });
  await fs.chmod(healthFailurePath, 0o644);
  await run('/usr/bin/systemctl', ['daemon-reload']);
  await run('/usr/bin/systemctl', ['enable', 'sonuvi-api.service', 'sonuvi-web.service']);
  await run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']);
  await assertHealth(historicalReleaseId);

  const keyPair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'historical-systemd-fixture-key';
  const trustedAnchors = { [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const adapter = createLinuxSystemdUpgradeAdapter();
  const candidate = { releaseId: candidateReleaseId, root: path.join(layoutRoot, 'releases', candidateReleaseId) };
  const previous = { releaseId: historicalReleaseId, root: path.join(layoutRoot, 'releases', historicalReleaseId) };
  async function activate(selectedAdapter = adapter) {
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
  async function resetHistorical() {
    await stopServices();
    await setCurrent(previous.releaseId);
    await writeUnit('sonuvi-api.service', 'api', previous.releaseId);
    await writeUnit('sonuvi-web.service', 'web', previous.releaseId);
    await fs.writeFile(checkpointPath, originalCheckpoint, { mode: 0o640 });
    await fs.chmod(checkpointPath, 0o640);
    await fs.rm(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), { force: true });
    await fs.rm(path.join(stateRoot, 'checkpoints/release-activation.lock'), { force: true });
    await fs.rm(path.join(stateRoot, 'checkpoints/public-traffic-open.json'), { force: true });
    await fs.rm(path.join(stateRoot, 'checkpoints/release-upgrade-backups'), { recursive: true, force: true });
    await run('/usr/bin/systemctl', ['daemon-reload']);
    await run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']);
    await fs.writeFile(healthFailurePath, 'none\n');
    await fs.chmod(healthFailurePath, 0o644);
    await assertHealth(previous.releaseId);
  }
  return { candidate, previous, adapter, activate, resetHistorical, checkpointPath, originalCheckpoint };
}

async function main() {
  const fixture = await setup();
  try {
    const success = await fixture.activate();
    assert.equal(success.state.phase, 'committed');
    assert.equal(await currentRelease(), fixture.candidate.releaseId);
    await assertHealth(fixture.candidate.releaseId);
    await verifyPreservedState();
    console.log('PASS actual historical release activates to the v2 release with exact API/web health and preserved state');

    await fixture.resetHistorical();
    await fs.writeFile(healthFailurePath, `${fixture.candidate.releaseId}\n`);
    await assert.rejects(fixture.activate(), /health check failed|upgrade_health_identity_mismatch/);
    assert.equal(await currentRelease(), fixture.previous.releaseId);
    await assertHealth(fixture.previous.releaseId);
    await verifyPreservedState();
    const rolledBack = await readReleaseActivationState({ layoutRoot, stateRoot, ownerUID: 0 });
    assert.equal(rolledBack.phase, 'rolled-back');
    console.log('PASS actual historical release remains active after candidate health failure and rollback');

    await fixture.resetHistorical();
    const interruptedAdapter = Object.freeze({
      ...fixture.adapter,
      async restart(context) {
        await fixture.adapter.restart(context);
        throw new Error('historical_fixture_interrupted_after_restart');
      },
      async rollback() {
        throw new Error('historical_fixture_interrupted_before_rollback');
      },
    });
    await assert.rejects(fixture.activate(interruptedAdapter), /rollback failed/);
    assert.equal((await readReleaseActivationState({ layoutRoot, stateRoot, ownerUID: 0 })).phase, 'manual-recovery-required');
    const recovered = await recoverInterruptedActivation({ layoutRoot, stateRoot, ownerUID: 0, targetIdentity, adapter: fixture.adapter });
    assert.equal(recovered.recovered, true);
    assert.equal(await currentRelease(), fixture.previous.releaseId);
    await assertHealth(fixture.previous.releaseId);
    await verifyPreservedState();
    assert.equal((await readReleaseActivationState({ layoutRoot, stateRoot, ownerUID: 0 })).phase, 'recovered');
    console.log('PASS interrupted activation recovers the historically accurate previous release');
  } finally {
    await stopServices();
  }
}

await main();
