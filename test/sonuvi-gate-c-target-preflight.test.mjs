import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  deriveGateCTargetIdentity,
  normalizeGateCTargetIdentity,
  readGateCTargetIdentity,
  verifyGateCTargetCompatibility,
} from '../src/lib/sonuvi-gate-c-target-preflight.mjs';

const machineIdentity = '0123456789abcdef0123456789abcdef';

test('target identity is a versioned, domain-separated machine-id digest', async () => {
  const identity = deriveGateCTargetIdentity(machineIdentity);
  assert.match(identity, /^sonuvi-target-v1-[a-f0-9]{64}$/);
  assert.notEqual(identity, machineIdentity);
  assert.equal(await readGateCTargetIdentity({ readMachineIdentity: async () => `${machineIdentity}\n` }), identity);
  assert.equal(normalizeGateCTargetIdentity(identity), identity);
  assert.throws(() => deriveGateCTargetIdentity('not-a-machine-id'), /target_machine_identity_invalid/);
  assert.throws(() => normalizeGateCTargetIdentity('machine-id-from-client'), /target_identity_invalid/);
});

test('root-side compatibility verification rejects unsupported local platforms', async () => {
  const file = async () => '12.9';
  const regular = async () => ({ isFile: () => true, isSymbolicLink: () => false });
  assert.deepEqual(await verifyGateCTargetCompatibility({ platform: 'linux', architecture: 'arm64', readFile: file, lstat: regular }), {
    os: 'debian', architecture: 'arm64', systemd: true, supported: true,
  });
  await assert.rejects(verifyGateCTargetCompatibility({ platform: 'linux', architecture: 'x64', readFile: file, lstat: regular }), /target_unsupported_platform/);
  await assert.rejects(verifyGateCTargetCompatibility({ platform: 'linux', architecture: 'arm64', readFile: async () => { throw new Error('missing'); }, lstat: regular }), /target_unsupported_debian/);
});

test('read-only target preflight script accepts no caller input or dynamic execution', async () => {
  const source = await fs.readFile(new URL('../scripts/sonuvi-target-preflight.sh', import.meta.url), 'utf8');
  assert.match(source, /\[ "\$#" -eq 0 \] \|\| fail invalid_arguments 64/);
  assert.match(source, /sonuvi\.gate-c-target-preflight\.v1/);
  assert.match(source, /sha256-machine-id/);
  assert.match(source, /grep -Eq '\^ID="\?debian"\?\$'/);
  assert.doesNotMatch(source, /\beval\b|\bsource\b|sh -c|exec \$/);
});
