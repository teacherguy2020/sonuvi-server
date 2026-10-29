import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMoodeRemoteCommand,
  assertMoodeRemoteTransport,
  MOODE_REMOTE_COMMANDS,
  resolveMoodeSshProfile,
} from '../src/lib/moode-ssh-profile.mjs';
import { createRuntimeCapabilities } from '../src/lib/runtime-capabilities.mjs';
import { createRuntimeStatePaths } from '../src/lib/runtime-state-paths.mjs';

function immutableEnvironment(overrides = {}) {
  return {
    SONUVI_STATE_ROOT: '/opt/sonuvi/shared',
    SONUVI_SECRETS_ROOT: '/etc/sonuvi',
    MOODE_SSH_USER: 'sonuvi-moode',
    MOODE_SSH_HOST: 'moode.example.invalid',
    ...overrides,
  };
}

test('immutable SSH profile has an explicit identity and pinned known-hosts path', () => {
  const env = immutableEnvironment();
  const statePaths = createRuntimeStatePaths({
    cwd: '/opt/sonuvi/releases/candidate',
    env,
  });
  const profile = resolveMoodeSshProfile({ env, statePaths });
  const args = profile.argsFor();

  assert.equal(profile.immutable, true);
  assert.equal(profile.identityPath, '/etc/sonuvi/ssh/moode_ed25519');
  assert.equal(profile.knownHostsPath, '/etc/sonuvi/ssh/known_hosts');
  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null']);
  assert.equal(args.includes('-i'), true);
  assert.equal(args.includes('/etc/sonuvi/ssh/moode_ed25519'), true);
  assert.equal(args.includes('StrictHostKeyChecking=yes'), true);
  assert.equal(args.includes('UserKnownHostsFile=/etc/sonuvi/ssh/known_hosts'), true);
  assert.equal(args.includes('GlobalKnownHostsFile=/dev/null'), true);
  assert.equal(args.includes('IdentitiesOnly=yes'), true);
  assert.equal(args.some((value) => String(value).includes('/home/fixture-operator')), false);
});

test('immutable SSH paths cannot escape the root-managed secrets tree', () => {
  const statePaths = createRuntimeStatePaths({
    cwd: '/opt/sonuvi/releases/candidate',
    env: immutableEnvironment(),
  });
  assert.throws(
    () => resolveMoodeSshProfile({
      statePaths,
      env: immutableEnvironment({ SONUVI_MOODE_SSH_IDENTITY: '/tmp/personal-key' }),
    }),
    /must remain beneath SONUVI_MOODE_SSH_ROOT/,
  );
});

test('remote command inventory fails closed in rehearsal and rejects unknown commands', () => {
  const capabilities = createRuntimeCapabilities({
    env: { SONUVI_EXECUTION_MODE: 'rehearsal' },
  });
  assert.throws(
    () => assertMoodeRemoteCommand('audio-status', { capabilities }),
    (error) => error?.code === 'SONUVI_REHEARSAL_DENIED',
  );
  assert.throws(
    () => assertMoodeRemoteCommand('qobuz-renderer-release', { capabilities }),
    (error) => error?.code === 'SONUVI_REHEARSAL_DENIED',
  );
  assert.throws(
    () => assertMoodeRemoteCommand('arbitrary-shell', { capabilities }),
    /not approved/,
  );
  assert.equal(MOODE_REMOTE_COMMANDS['audio-status'].access, 'read');
  assert.equal(MOODE_REMOTE_COMMANDS['qobuz-renderer-release'].access, 'write');
});

test('immutable SSH profile rejects raw remote transport pending restricted authorization', () => {
  const env = immutableEnvironment();
  const profile = resolveMoodeSshProfile({
    env,
    statePaths: createRuntimeStatePaths({ cwd: '/opt/sonuvi/releases/candidate', env }),
  });
  assert.throws(
    () => assertMoodeRemoteTransport('diagnostics', {
      capabilities: createRuntimeCapabilities({ env: {} }),
      profile,
    }),
    (error) => error?.code === 'SONUVI_SSH_TRANSPORT_UNAUTHORIZED',
  );
});
