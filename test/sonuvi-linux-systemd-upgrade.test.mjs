import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLinuxSystemdUpgradeAdapter,
  SONUVI_UPGRADE_SYSTEMD_UNITS,
} from '../src/lib/sonuvi-linux-systemd-upgrade.mjs';

const previousReleaseId = `sonuvi-${'a'.repeat(64)}`;
const candidateReleaseId = `sonuvi-${'b'.repeat(64)}`;
const attemptId = 'boot_linux_upgrade_adapter_fixture_20261109';
const targetIdentity = `sonuvi-target-v1-${'c'.repeat(64)}`;

async function writeFile(root, relative, value, mode = 0o640) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await fs.writeFile(target, value, { mode });
  await fs.chmod(target, mode);
  return target;
}

async function fixture(t, { failCandidateHealth = false, wrongCandidateProcess = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-systemd-upgrade-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    layoutRoot: path.join(root, 'opt', 'sonuvi'),
    stateRoot: path.join(root, 'var', 'lib', 'sonuvi'),
    unitRoot: path.join(root, 'etc', 'systemd', 'system'),
  };
  for (const directory of [paths.layoutRoot, paths.stateRoot, paths.unitRoot, path.join(paths.stateRoot, 'checkpoints')]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o750 });
    await fs.chmod(directory, 0o750);
  }
  const checkpoint = await writeFile(path.join(paths.stateRoot, 'checkpoints'), 'release-activation-state.json', `${JSON.stringify({
    contract: 'sonuvi.release-activation.v1', transactionId: crypto.randomUUID(), phase: 'committed',
    candidateReleaseId: previousReleaseId, previousReleaseId: null,
  }, null, 2)}\n`);
  const originalCheckpoint = await fs.readFile(checkpoint);
  const originalState = {
    identity: await writeFile(paths.stateRoot, 'data/server-identity.json', '{"serverId":"fixture-identity"}\n'),
    admin: await writeFile(paths.stateRoot, 'protected/administrator.json', '{"role":"administrator","deviceId":"fixture-device"}\n', 0o600),
    controller: await writeFile(paths.stateRoot, 'protected/controllers.json', '{"controller":"fixture-controller"}\n', 0o600),
    configuration: await writeFile(paths.stateRoot, 'config/now-playing.config.json', '{"timezone":"UTC"}\n'),
    library: await writeFile(paths.stateRoot, 'data/library-browse-index.json', '{"schema":"now-playing.browse-index.v2","tracks":[] }\n'),
  };
  const originalStateBytes = new Map(await Promise.all(Object.entries(originalState).map(async ([name, file]) => [name, await fs.readFile(file)])));

  const properties = new Map();
  const processRelease = new Map();
  let pid = 1000;
  for (const [index, unit] of SONUVI_UPGRADE_SYSTEMD_UNITS.entries()) {
    const releaseRoot = `/opt/sonuvi/releases/${previousReleaseId}`;
    const content = [
      '[Unit]',
      'Description=Sonuvi fixture service',
      'After=network-online.target',
      '',
      '[Service]',
      'User=sonuvi',
      'Group=sonuvi',
      'WorkingDirectory=/opt/sonuvi/current',
      `Environment=SONUVI_RELEASE_ROOT=${releaseRoot}`,
      'Environment=SONUVI_STATE_ROOT=/var/lib/sonuvi',
      `Environment=SONUVI_RELEASE_ID=${previousReleaseId}`,
      'EnvironmentFile=-/var/lib/sonuvi/protected/now-playing.env',
      'ExecStart=/usr/bin/node /var/lib/sonuvi-upgrade-fixture/service.mjs',
      'Restart=on-failure',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    const unitPath = await writeFile(paths.unitRoot, unit, content, 0o644);
    const unitProperties = {
      Id: unit,
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'running',
      MainPID: String(pid + index),
      FragmentPath: unitPath,
      DropInPaths: '',
      UnitFileState: 'enabled',
      Environment: `SONUVI_RELEASE_ROOT=${releaseRoot} SONUVI_STATE_ROOT=/var/lib/sonuvi SONUVI_RELEASE_ID=${previousReleaseId}`,
      User: 'sonuvi',
      Group: 'sonuvi',
      ExecStart: '/usr/bin/node /var/lib/sonuvi-upgrade-fixture/service.mjs',
      ExecStartPre: '/usr/bin/node /opt/sonuvi/current/scripts/verify-current-release.mjs',
      EnvironmentFiles: '-/var/lib/sonuvi/protected/now-playing.env',
      Restart: 'on-failure',
      RestartUSec: '3s',
      Requires: unit === 'sonuvi-web.service' ? 'sonuvi-api.service' : '',
      Wants: 'network-online.target',
      After: 'network-online.target',
      Before: '',
    };
    properties.set(unit, unitProperties);
    processRelease.set(unitProperties.MainPID, { id: previousReleaseId, root: releaseRoot });
  }

  const calls = [];
  async function runSystemctl(args) {
    calls.push([...args]);
    if (args[0] === 'daemon-reload') return { stdout: '', stderr: '' };
    if (args[0] === 'show') {
      const unit = args.at(-1);
      const value = properties.get(unit);
      if (!value) throw new Error('unknown fixture unit');
      return { stdout: Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n'), stderr: '' };
    }
    if (args[0] === 'reset-failed') return { stdout: '', stderr: '' };
    if (args[0] === 'stop' || args[0] === 'start') {
      const unit = args[1];
      const value = properties.get(unit);
      if (!value) throw new Error('unknown fixture unit');
      if (args[0] === 'stop') {
        value.ActiveState = 'inactive';
        value.SubState = 'dead';
        value.MainPID = '0';
        return { stdout: '', stderr: '' };
      }
      const content = await fs.readFile(value.FragmentPath, 'utf8');
      const id = content.match(/^Environment=SONUVI_RELEASE_ID=(sonuvi-[a-f0-9]{64})$/m)?.[1];
      const releaseRoot = content.match(/^Environment=SONUVI_RELEASE_ROOT=(\S+)$/m)?.[1];
      if (!id || !releaseRoot) throw new Error('fixture unit did not include release identity');
      value.Environment = `SONUVI_RELEASE_ROOT=${releaseRoot} SONUVI_STATE_ROOT=/var/lib/sonuvi SONUVI_RELEASE_ID=${id}`;
      value.ActiveState = 'active';
      value.SubState = 'running';
      value.MainPID = String(++pid);
      processRelease.set(value.MainPID, {
        id: wrongCandidateProcess && id === candidateReleaseId ? previousReleaseId : id,
        root: wrongCandidateProcess && id === candidateReleaseId ? `/opt/sonuvi/releases/${previousReleaseId}` : releaseRoot,
      });
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unapproved fixture systemctl operation: ${args[0]}`);
  }

  const copyPreservingMetadata = async (source, destination) => {
    const stat = await fs.stat(source);
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destination, stat.mode & 0o7777);
    await fs.chown(destination, stat.uid, stat.gid);
  };
  const adapter = createLinuxSystemdUpgradeAdapter({
    paths,
    ownerUID: process.getuid(),
    runSystemctl,
    copyPreservingMetadata,
    readProcessEnvironment: async (mainPid) => {
      const environment = processRelease.get(String(mainPid));
      if (!environment) throw new Error('unknown fixture process');
      return Buffer.from(`SONUVI_RELEASE_ID=${environment.id}\0SONUVI_RELEASE_ROOT=${environment.root}\0`);
    },
    fetchJson: async (url) => {
      const unit = url.includes(':3101/') ? 'sonuvi-api.service' : 'sonuvi-web.service';
      const id = properties.get(unit).Environment.match(/SONUVI_RELEASE_ID=(sonuvi-[a-f0-9]{64})/)?.[1];
      if (failCandidateHealth && id === candidateReleaseId) return { contract: 'sonuvi.health.v1', ok: false, release: { mode: 'immutable-release', releaseId: id } };
      return url.includes(':3101/')
        ? { contract: 'sonuvi.health.v1', ok: true, release: { mode: 'immutable-release', releaseId: id } }
        : { contract: 'sonuvi.release-web-identity.v1', releaseId: id };
    },
  });
  const context = {
    transactionId: crypto.randomUUID(), attemptId, targetIdentity,
    previous: { releaseId: previousReleaseId }, candidate: { releaseId: candidateReleaseId },
  };
  return { root, paths, checkpoint, originalCheckpoint, originalState, originalStateBytes, properties, processRelease, calls, adapter, context, failCandidateHealth };
}

test('Linux systemd adapter quiesces, switches only release-bound unit values, verifies process/API/web identity, and commits', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.prepare(f.context), { quiesced: true });
  for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) assert.equal(f.properties.get(unit).ActiveState, 'inactive');
  assert.equal(f.calls.some((entry) => entry.includes('enable') || entry.includes('disable')), false);

  await f.adapter.restart(f.context);
  for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
    const unitText = await fs.readFile(path.join(f.paths.unitRoot, unit), 'utf8');
    assert.match(unitText, new RegExp(`Environment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${candidateReleaseId}`));
    assert.match(unitText, new RegExp(`Environment=SONUVI_RELEASE_ID=${candidateReleaseId}`));
    assert.match(unitText, /Environment=SONUVI_STATE_ROOT=\/var\/lib\/sonuvi/);
    assert.match(unitText, /Restart=on-failure/);
    assert.equal(f.properties.get(unit).ActiveState, 'active');
  }
  for (const service of ['api', 'web']) await f.adapter.verify({ ...f.context, service, expectedReleaseId: candidateReleaseId });
  for (const service of ['api', 'web']) await f.adapter.health({ ...f.context, service, expectedReleaseId: candidateReleaseId });
  await f.adapter.commit(f.context);
  const checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.phase, 'committed');
  assert.equal(checkpoint.candidateReleaseId, candidateReleaseId);
  for (const [name, file] of Object.entries(f.originalState)) assert.deepEqual(await fs.readFile(file), f.originalStateBytes.get(name), name);
  assert.equal(f.calls.some((entry) => entry[0] === 'daemon-reload'), true);
  assert.equal(f.calls.some((entry) => entry[0] === 'reset-failed'), true);
  assert.equal(f.calls.some((entry) => entry[0] === 'enable' || entry[0] === 'disable'), false);
});

test('health failure rolls the real adapter state back to the prior unit and startup-checkpoint bytes', async (t) => {
  const f = await fixture(t, { failCandidateHealth: true });
  const originalUnits = new Map(await Promise.all(SONUVI_UPGRADE_SYSTEMD_UNITS.map(async (unit) => [unit, await fs.readFile(path.join(f.paths.unitRoot, unit))])));
  await f.adapter.prepare(f.context);
  await f.adapter.restart(f.context);
  for (const service of ['api', 'web']) await f.adapter.verify({ ...f.context, service, expectedReleaseId: candidateReleaseId });
  await assert.rejects(f.adapter.health({ ...f.context, service: 'api', expectedReleaseId: candidateReleaseId }), /upgrade_health_identity_mismatch/);
  await f.adapter.rollback(f.context);
  for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
    assert.deepEqual(await fs.readFile(path.join(f.paths.unitRoot, unit)), originalUnits.get(unit));
    assert.equal(f.properties.get(unit).ActiveState, 'active');
  }
  assert.deepEqual(await fs.readFile(f.checkpoint), f.originalCheckpoint);
  for (const service of ['api', 'web']) {
    assert.deepEqual(await f.adapter.verify({ ...f.context, service, expectedReleaseId: previousReleaseId }), { releaseId: previousReleaseId });
    assert.equal((await f.adapter.health({ ...f.context, service, expectedReleaseId: previousReleaseId })).releaseId, previousReleaseId);
  }
  for (const [name, file] of Object.entries(f.originalState)) assert.deepEqual(await fs.readFile(file), f.originalStateBytes.get(name), name);
});

test('process identity mismatch is rejected even when the unit and HTTP response claim the candidate', async (t) => {
  const f = await fixture(t, { wrongCandidateProcess: true });
  await f.adapter.prepare(f.context);
  await f.adapter.restart(f.context);
  await assert.rejects(f.adapter.verify({ ...f.context, service: 'api', expectedReleaseId: candidateReleaseId }), /upgrade_running_release_identity_mismatch/);
  await f.adapter.rollback(f.context);
});

test('recovery after restart but before commit restores both services and the original startup checkpoint', async (t) => {
  const f = await fixture(t);
  const originalUnits = new Map(await Promise.all(SONUVI_UPGRADE_SYSTEMD_UNITS.map(async (unit) => [unit, await fs.readFile(path.join(f.paths.unitRoot, unit))])));
  await f.adapter.prepare(f.context);
  await f.adapter.restart(f.context);
  const recoveryAdapter = createLinuxSystemdUpgradeAdapter({
    paths: f.paths,
    ownerUID: process.getuid(),
    runSystemctl: async (args) => {
      if (args[0] === 'daemon-reload') return { stdout: '', stderr: '' };
      if (args[0] === 'reset-failed') return { stdout: '', stderr: '' };
      return f.adapterSystemctl ? f.adapterSystemctl(args) : (async () => {
        const unit = args.at(-1);
        if (args[0] === 'stop') {
          const value = f.properties.get(unit); value.ActiveState = 'inactive'; value.SubState = 'dead'; value.MainPID = '0';
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'start') {
          const value = f.properties.get(unit); const content = await fs.readFile(value.FragmentPath, 'utf8');
          const id = content.match(/^Environment=SONUVI_RELEASE_ID=(sonuvi-[a-f0-9]{64})$/m)[1];
          const root = content.match(/^Environment=SONUVI_RELEASE_ROOT=(\S+)$/m)[1];
          value.Environment = `SONUVI_RELEASE_ROOT=${root} SONUVI_STATE_ROOT=/var/lib/sonuvi SONUVI_RELEASE_ID=${id}`;
          value.ActiveState = 'active'; value.SubState = 'running'; value.MainPID = String(Number(value.MainPID) + 99);
          f.processRelease.set(value.MainPID, { id, root });
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'show') {
          const value = f.properties.get(args.at(-1));
          return { stdout: Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n'), stderr: '' };
        }
        throw new Error('unexpected systemd operation');
      })();
    },
    copyPreservingMetadata: async (source, destination) => {
      const stat = await fs.stat(source);
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      await fs.chmod(destination, stat.mode & 0o7777);
      await fs.chown(destination, stat.uid, stat.gid);
    },
    readProcessEnvironment: async (mainPid) => {
      const environment = f.processRelease.get(String(mainPid));
      return Buffer.from(`SONUVI_RELEASE_ID=${environment.id}\0SONUVI_RELEASE_ROOT=${environment.root}\0`);
    },
    fetchJson: async (url) => url.includes(':3101/')
      ? { contract: 'sonuvi.health.v1', ok: true, release: { mode: 'immutable-release', releaseId: f.properties.get('sonuvi-api.service').Environment.match(/SONUVI_RELEASE_ID=(sonuvi-[a-f0-9]{64})/)[1] } }
      : { contract: 'sonuvi.release-web-identity.v1', releaseId: f.properties.get('sonuvi-web.service').Environment.match(/SONUVI_RELEASE_ID=(sonuvi-[a-f0-9]{64})/)[1] },
  });
  await recoveryAdapter.rollback(f.context);
  for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) assert.deepEqual(await fs.readFile(path.join(f.paths.unitRoot, unit)), originalUnits.get(unit));
  assert.deepEqual(await fs.readFile(f.checkpoint), f.originalCheckpoint);
});
