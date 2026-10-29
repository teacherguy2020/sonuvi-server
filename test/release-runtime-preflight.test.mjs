import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findExecutable,
  inspectExternalExecutables,
  inspectRemotePlaybackTopology,
  inspectReleaseRuntimeState,
  inspectReleaseTargetRuntime,
} from '../src/lib/release-runtime-preflight.mjs';

function manifest() {
  return {
    target: { os: 'linux', architecture: 'arm64', nodeVersion: 'v20.19.5' },
    externalRuntimeDependencies: { executables: ['node', 'mpc'] },
  };
}

test('release target runtime accepts a later Node 20 patch on matching linux/arm64 and rejects target or major mismatches', () => {
  const accepted = inspectReleaseTargetRuntime({
    manifest: manifest(),
    runtime: { platform: 'linux', arch: 'arm64', version: 'v20.20.1', versions: { modules: '115', napi: '9' } },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.expected.nodeMajor, 20);
  assert.equal(accepted.actual.nodeVersion, 'v20.20.1');

  const rejected = inspectReleaseTargetRuntime({
    manifest: manifest(),
    runtime: { platform: 'darwin', arch: 'arm64', version: 'v22.0.0', versions: {} },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(' '), /linux/);
  assert.match(rejected.errors.join(' '), /Node 20/);
});

test('external executable inspection fails closed without executing commands', async () => {
  const checked = [];
  const result = await inspectExternalExecutables({
    manifest: manifest(),
    find: async (name) => {
      checked.push(name);
      return name === 'node' ? '/usr/bin/node' : '';
    },
  });
  assert.deepEqual(checked, ['mpc', 'node']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['mpc']);
  assert.equal(result.resolved.node, '/usr/bin/node');
});

test('remote playback topology requires non-loopback MPD and moOde SSH endpoints without contacting them', () => {
  const missing = inspectRemotePlaybackTopology({ mpdHost: '', moodeSshHost: '127.0.0.1' });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /MPD host is required/);
  assert.match(missing.errors.join(' '), /SSH host must not be loopback/);

  const configured = inspectRemotePlaybackTopology({ mpdHost: 'moode.local', moodeSshHost: 'moode.local' });
  assert.equal(configured.ok, true);
});

test('runtime-state preflight detects missing state/configuration, unavailable music, and permissive SSH identity metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-runtime-preflight-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const stateRoot = path.join(root, 'shared');
  const configRoot = path.join(stateRoot, 'config');
  for (const relative of ['config', 'data', 'cache', 'protected', 'logs', 'checkpoints']) {
    await fs.mkdir(path.join(stateRoot, relative), { recursive: true, mode: 0o700 });
  }
  const musicRoot = path.join(root, 'music');
  await fs.mkdir(musicRoot, { recursive: true, mode: 0o500 });
  const sshIdentity = path.join(stateRoot, 'protected', 'id_ed25519');
  await fs.writeFile(sshIdentity, 'fixture', { mode: 0o644 });
  await fs.chmod(sshIdentity, 0o644);

  const unavailableMusic = await inspectReleaseRuntimeState({
    stateRoot,
    configRoot,
    musicRoot: path.join(root, 'missing-cifs-mount'),
    sshIdentityPath: sshIdentity,
  });
  assert.match(unavailableMusic.errors.join(' '), /music library root is missing/);

  let result = await inspectReleaseRuntimeState({ stateRoot, configRoot, musicRoot, sshIdentityPath: sshIdentity });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /runtime configuration is missing/);
  assert.match(result.errors.join(' '), /SSH identity permissions exceed 600/);

  await fs.writeFile(path.join(configRoot, 'now-playing.config.json'), '{}\n', { mode: 0o600 });
  await fs.chmod(sshIdentity, 0o600);
  result = await inspectReleaseRuntimeState({ stateRoot, configRoot, musicRoot, sshIdentityPath: sshIdentity });
  assert.equal(result.ok, true);
});

test('executable lookup searches only PATH entries and rejects unsafe command names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-runtime-path-'));
  try {
    const command = path.join(root, 'sonuvi-tool');
    await fs.writeFile(command, '#!/bin/sh\n', { mode: 0o700 });
    assert.equal(await findExecutable('sonuvi-tool', { pathValue: root }), command);
    await assert.rejects(findExecutable('../sonuvi-tool', { pathValue: root }), /invalid/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
