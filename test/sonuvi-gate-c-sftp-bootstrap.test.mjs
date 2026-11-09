import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  GATE_C_SFTP_BOOTSTRAP_ACTIVATOR_SHA256,
  GATE_C_SFTP_BOOTSTRAP_CONTRACT,
  GATE_C_SFTP_UPGRADE_BOOTSTRAP_ACTIVATOR_SHA256,
  GATE_C_SFTP_UPGRADE_BOOTSTRAP_CONTRACT,
  assertGateCSftpBootstrapEntry,
  assertGateCSftpUpgradeBootstrapEntry,
  gateCSftpBootstrapActivationCommand,
  gateCSftpUpgradeBootstrapActivationCommand,
  normalizeGateCSftpBootstrapTransfer,
  normalizeGateCSftpHomeDirectory,
  normalizeGateCSftpUpgradeBootstrapTransfer,
} from '../src/lib/sonuvi-gate-c-sftp-bootstrap.mjs';

const sha256 = 'a'.repeat(64);

function plan() {
  return normalizeGateCSftpBootstrapTransfer({
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT,
    homeDirectory: '/home/sonuvi-test',
    bytes: 98_304,
    sha256,
  });
}

function upgradePlan() {
  return normalizeGateCSftpUpgradeBootstrapTransfer({
    contract: GATE_C_SFTP_UPGRADE_BOOTSTRAP_CONTRACT,
    homeDirectory: '/home/sonuvi-test',
    bytes: 131_072,
    sha256,
  });
}

test('Gate C SFTP bootstrap derives only fixed account-relative artifact paths', () => {
  const value = plan();
  assert.equal(value.directory, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v1');
  assert.equal(value.partialPath, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial');
  assert.equal(value.finalPath, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar');
  assert.throws(() => normalizeGateCSftpHomeDirectory('/home/sonuvi-test/../root'), /canonical/);
  assert.throws(() => normalizeGateCSftpHomeDirectory('/'), /canonical/);
  assert.throws(() => normalizeGateCSftpBootstrapTransfer({
    contract: value.contract,
    homeDirectory: '/home/test',
    bytes: 16 * 1024 * 1024 + 1,
    sha256: value.sha256,
  }), /byte count/);
});

test('Gate C SFTP bootstrap handles an interrupted partial only as a restart-from-zero candidate', () => {
  const value = plan();
  assert.equal(assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.partialPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: 512 }).bytes, 512);
  assert.throws(() => assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: 512 }), /final size/);
});

test('Gate C SFTP bootstrap rejects malformed, oversized, and unauthorized staging records', () => {
  const value = plan();
  assert.equal(assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.directory, kind: 'directory', mode: 0o700, uid: 1000 }).kind, 'directory');
  assert.equal(assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: 98_304 }).bytes, 98_304);
  assert.throws(() => assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.finalPath, kind: 'symlink', mode: 0o777, uid: 1000, bytes: 98_304 }), /symlinks/);
  assert.throws(() => assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o644, uid: 1000, bytes: 98_304 }), /file is invalid/);
  assert.throws(() => assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1001, bytes: 98_304 }), /owner does not match/);
  assert.throws(() => assertGateCSftpBootstrapEntry({ plan: value, expectedUID: 1000, path: '/tmp/not-allowed', kind: 'regular', mode: 0o600, uid: 1000, bytes: 1 }), /allowlisted/);
  assert.throws(() => normalizeGateCSftpBootstrapTransfer({ contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT, homeDirectory: '/home/sonuvi-test', bytes: 16 * 1024 * 1024 + 1, sha256 }), /byte count/);
});

test('Gate C SFTP bootstrap activation command has no caller-controlled remote path or shell', () => {
  assert.equal(
    gateCSftpBootstrapActivationCommand({ sha256, bytes: 98_304 }),
    `/usr/bin/sudo -n /bin/sh -s -- ${sha256} 98304`,
  );
  assert.equal(
    gateCSftpBootstrapActivationCommand({ sha256, bytes: 98_304 }, { requiresPassword: true }),
    `/usr/bin/sudo -S -k -p '' /bin/sh -s -- ${sha256} 98304`,
  );
  assert.throws(() => gateCSftpBootstrapActivationCommand({ sha256: 'x;rm -rf /', bytes: 1 }), /digest/);
});

test('Gate C SFTP bootstrap activation capsule has a pinned source identity', async () => {
  const source = await fs.readFile(path.resolve('scripts/sonuvi-sftp-bootstrap-activate-v1.sh'));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), GATE_C_SFTP_BOOTSTRAP_ACTIVATOR_SHA256);
});

test('Gate C upgrade SFTP contract uses only its disjoint fixed v2 staging paths', () => {
  const value = upgradePlan();
  assert.equal(value.directory, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v2');
  assert.equal(value.partialPath, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v2/sonuvi-bootstrap-kit-v2.tar.partial');
  assert.equal(value.finalPath, '/home/sonuvi-test/.local/share/sonuvi-bootstrap-v2/sonuvi-bootstrap-kit-v2.tar');
  assert.throws(() => assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: plan().finalPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: value.bytes,
  }), /allowlisted/);
  assert.throws(() => normalizeGateCSftpUpgradeBootstrapTransfer({
    contract: GATE_C_SFTP_BOOTSTRAP_CONTRACT, homeDirectory: value.homeDirectory, bytes: value.bytes, sha256,
  }), /unsupported/);
});

test('Gate C upgrade SFTP validates exact owner, type, permissions, and transfer size', () => {
  const value = upgradePlan();
  assert.equal(assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.directory, kind: 'directory', mode: 0o700, uid: 1000,
  }).kind, 'directory');
  assert.equal(assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: value.bytes,
  }).bytes, value.bytes);
  assert.throws(() => assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.finalPath, kind: 'symlink', mode: 0o777, uid: 1000, bytes: value.bytes,
  }), /symlinks/);
  assert.throws(() => assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o644, uid: 1000, bytes: value.bytes,
  }), /file is invalid/);
  assert.throws(() => assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1001, bytes: value.bytes,
  }), /owner does not match/);
  assert.throws(() => assertGateCSftpUpgradeBootstrapEntry({
    plan: value, expectedUID: 1000, path: value.finalPath, kind: 'regular', mode: 0o600, uid: 1000, bytes: value.bytes - 1,
  }), /final size/);
});

test('Gate C upgrade capsule command remains fixed and separately pinned', async () => {
  assert.equal(
    gateCSftpUpgradeBootstrapActivationCommand({ sha256, bytes: 131_072 }),
    `/usr/bin/sudo -n /bin/sh -s -- ${sha256} 131072`,
  );
  assert.equal(
    gateCSftpUpgradeBootstrapActivationCommand({ sha256, bytes: 131_072 }, { requiresPassword: true }),
    `/usr/bin/sudo -S -k -p '' /bin/sh -s -- ${sha256} 131072`,
  );
  assert.throws(() => gateCSftpUpgradeBootstrapActivationCommand({ sha256: 'x;id', bytes: 1 }), /digest/);
  const source = await fs.readFile(path.resolve('scripts/sonuvi-sftp-bootstrap-activate-v2.sh'));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), GATE_C_SFTP_UPGRADE_BOOTSTRAP_ACTIVATOR_SHA256);
});
