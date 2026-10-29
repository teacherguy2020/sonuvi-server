import assert from 'node:assert/strict';
import test from 'node:test';

import { createQobuzConnectController } from '../src/lib/qobuz-connect-control.mjs';

test('Qobuz release controller uses only the fixed moOde disconnect operation', async () => {
  const calls = [];
  const controller = createQobuzConnectController({
    sshUser: 'moode',
    sshHost: 'moode.local',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '"job submitted"\nreleased\nrestarted\nready\n', stderr: '' };
    },
  });

  const result = await controller.release();
  assert.deepEqual(result, { accepted: true, confirmed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ssh');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    'moode@moode.local',
  ]);
  assert.match(calls[0].args.join(' '), /renderer\.php\?cmd=disconnect_renderer/);
  assert.match(calls[0].args.join(' '), /job=qobuzsvc/);
  assert.match(calls[0].args.join(' '), /pgrep -x pibuz/);
  assert.match(calls[0].args.join(' '), /systemd-run/);
  assert.match(calls[0].args.join(' '), /sonuvi-pibuz-b3-dev\.service/);
  assert.match(calls[0].args.join(' '), /--property=Restart=no/);
  assert.match(calls[0].args.join(' '), /\/usr\/bin\/pibuz run/);
  assert.doesNotMatch(calls[0].args.join(' '), /exit 0/);
  assert.doesNotMatch(calls[0].args.join(' '), /TOKEN|SECRET|PRIVATE_KEY/i);
});

test('Qobuz release controller coalesces concurrent requests', async () => {
  let calls = 0;
  let resolveRun;
  const pending = new Promise((resolve) => { resolveRun = resolve; });
  const controller = createQobuzConnectController({
    sshUser: 'moode',
    sshHost: 'moode.local',
    runCommand: async () => {
      calls += 1;
      await pending;
      return { stdout: 'submitted', stderr: '' };
    },
  });

  const first = controller.release();
  const second = controller.release();
  resolveRun();
  assert.deepEqual(await Promise.all([first, second]), [
    { accepted: true, confirmed: false },
    { accepted: true, confirmed: false },
  ]);
  assert.equal(calls, 1);
});

test('Qobuz release controller recognizes explicit PiBuZ process-stop confirmation', async () => {
  const controller = createQobuzConnectController({
    sshUser: 'moode',
    sshHost: 'moode.local',
    runCommand: async () => ({ stdout: 'submitted\nreleased\nrestarted\nready\n', stderr: '' }),
  });

  assert.deepEqual(await controller.release(), { accepted: true, confirmed: true });
});

test('Qobuz release controller accepts explicit proof from an ambiguous SSH exit', async () => {
  const controller = createQobuzConnectController({
    sshUser: 'moode',
    sshHost: 'moode.local',
    runCommand: async () => {
      const error = new Error('ssh exited with status 1');
      error.code = 1;
      error.stdout = 'submitted\nreleased\nrestarted\nready\n';
      error.stderr = '';
      throw error;
    },
  });

  assert.deepEqual(await controller.release(), { accepted: true, confirmed: true });
});

test('Qobuz release controller does not confirm until the restarted receiver is ready', async () => {
  const controller = createQobuzConnectController({
    sshUser: 'moode',
    sshHost: 'moode.local',
    runCommand: async () => ({ stdout: 'submitted\nreleased\nrestarted\n', stderr: '' }),
  });

  assert.deepEqual(await controller.release(), { accepted: true, confirmed: false });
});

test('Qobuz release controller fails closed in immutable mode before a remote command starts', async () => {
  let calls = 0;
  const controller = createQobuzConnectController({
    sshUser: 'sonuvi-moode',
    sshHost: 'moode.example.invalid',
    env: {
      SONUVI_STATE_ROOT: '/opt/sonuvi/shared',
      SONUVI_SECRETS_ROOT: '/etc/sonuvi',
    },
    runCommand: async () => {
      calls += 1;
      return { stdout: 'unexpected' };
    },
  });

  await assert.rejects(
    () => controller.release(),
    (error) => error?.code === 'SONUVI_SSH_TRANSPORT_UNAUTHORIZED',
  );
  assert.equal(calls, 0);
});
