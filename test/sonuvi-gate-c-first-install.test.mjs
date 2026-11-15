import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, makeTreeWritableForCleanup } from '../src/lib/release-artifact.mjs';
import { readBootstrapAttemptProgress, writeBootstrapAttemptProgress } from '../src/lib/sonuvi-bootstrap-progress.mjs';
import { activateVerifiedStagedRelease, GATE_C_FIRST_INSTALL_CONTRACT, normalizeGateCFirstInstallRequest, runFixedStagedInstaller } from '../src/lib/sonuvi-gate-c-first-install.mjs';
import { GATE_C_RELEASE_ENVELOPE_CONTRACT, GATE_C_RELEASE_METADATA_CONTRACT, GATE_C_RELEASE_TRANSFER_FORMAT } from '../src/lib/sonuvi-gate-c-release.mjs';
import { deriveGateCTargetIdentity } from '../src/lib/sonuvi-gate-c-target-preflight.mjs';

const releaseId = `sonuvi-${'c'.repeat(64)}`;
const attemptId = 'boot_first_install_fixture_20261105';
const machineIdentity = '0123456789abcdef0123456789abcdef';
const targetIdentity = deriveGateCTargetIdentity(machineIdentity);
const serverIdentity = 'fixture-server';

function envelope() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from('{"contract":"sonuvi.release-manifest.v1"}\n');
  const payload = {
    contract: GATE_C_RELEASE_METADATA_CONTRACT,
    releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { format: GATE_C_RELEASE_TRANSFER_FORMAT, sha256: 'a'.repeat(64), bytes: 1024 },
    bootstrap: { version: 1, sha256: 'b'.repeat(64) },
    issuedAt: '2026-11-05T00:00:00.000Z',
    expiresAt: '2026-12-05T00:00:00.000Z',
  };
  return Object.freeze({
    manifest,
    anchors: Object.freeze({ 'sonuvi-release-2026': pair.publicKey.export({ format: 'pem', type: 'spki' }) }),
    value: Object.freeze({
      contract: GATE_C_RELEASE_ENVELOPE_CONTRACT,
      keyId: 'sonuvi-release-2026',
      payload,
      signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64url'),
    }),
  });
}

function request(value) {
  return Object.freeze({
    operation: 'activate_first_install',
    envelope: value,
    attemptId,
    targetIdentity,
    serverIdentity,
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-gate-c-first-install-'));
  t.after(async () => {
    await makeTreeWritableForCleanup(path.join(root, 'releases', releaseId)).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const paths = Object.freeze({
    bootstrapReleaseRoot: path.join(root, 'releases'),
    bootstrapAttemptRoot: path.join(root, 'attempts'),
  });
  const signed = envelope();
  const staged = path.join(paths.bootstrapReleaseRoot, releaseId);
  const scripts = path.join(staged, 'scripts');
  await fs.mkdir(scripts, { recursive: true, mode: 0o755 });
  await fs.mkdir(paths.bootstrapAttemptRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(staged, 'release-manifest.json'), signed.manifest, { mode: 0o444 });
  // The fixed bridge runs this source with /usr/bin/node, so the packaged
  // installer deliberately needs no execute bit.
  await fs.writeFile(path.join(scripts, 'sonuvi-target-installer.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o444 });
  await fs.chmod(scripts, 0o555);
  await fs.chmod(staged, 0o555);
  await fs.chmod(paths.bootstrapReleaseRoot, 0o755);
  await writeBootstrapAttemptProgress({
    attemptId,
    targetIdentity,
    releaseId,
    phase: 'release_staged',
    root: paths.bootstrapAttemptRoot,
  });
  return Object.freeze({
    paths,
    signed,
    ownerUID: typeof process.getuid === 'function' ? process.getuid() : 0,
    verifyArtifact: async ({ artifactRoot }) => {
      assert.equal(artifactRoot, staged);
      return Object.freeze({ releaseId });
    },
  });
}

function successfulRunner(paths) {
  return async ({ installerPath, request: installerRequest }) => {
    assert.equal(installerPath, path.join(paths.bootstrapReleaseRoot, releaseId, 'scripts', 'sonuvi-target-installer.mjs'));
    assert.deepEqual(installerRequest, { attemptId, targetIdentity, releaseId, serverIdentity });
    await writeBootstrapAttemptProgress({
      attemptId,
      targetIdentity,
      releaseId,
      phase: 'awaiting-administrator-enrollment',
      root: paths.bootstrapAttemptRoot,
    });
    return Object.freeze({ ok: true, state: 'awaiting-administrator-enrollment', releaseId });
  };
}

test('first-install activation binds signed metadata to the fixed staged installer and durable status', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await activateVerifiedStagedRelease({
    request: request(f.signed.value),
    trustedAnchors: f.signed.anchors,
    paths: f.paths,
    ownerUID: f.ownerUID,
    readMachineIdentity: async () => machineIdentity,
    verifyTargetCompatibility: async () => ({ supported: true }),
    verifyArtifact: f.verifyArtifact,
    runInstaller: async (input) => {
      calls += 1;
      return successfulRunner(f.paths)(input);
    },
  });
  assert.deepEqual(result, {
    contract: GATE_C_FIRST_INSTALL_CONTRACT,
    state: 'awaiting-administrator-enrollment',
    releaseId,
    attemptId,
    targetIdentity,
  });
  assert.equal(calls, 1);
  const progress = await readBootstrapAttemptProgress({ attemptId, root: f.paths.bootstrapAttemptRoot });
  assert.equal(progress.state.phase, 'awaiting-administrator-enrollment');
  assert.equal(progress.state.releaseId, releaseId);

  const retry = await activateVerifiedStagedRelease({
    request: request(f.signed.value),
    trustedAnchors: f.signed.anchors,
    paths: f.paths,
    ownerUID: f.ownerUID,
    readMachineIdentity: async () => machineIdentity,
    verifyTargetCompatibility: async () => ({ supported: true }),
    verifyArtifact: f.verifyArtifact,
    runInstaller: async () => { calls += 1; throw new Error('must not run twice'); },
  });
  assert.equal(retry.state, 'already_activated');
  assert.equal(calls, 1);
});

test('first-install activation fails closed for staged tampering, attempt rebinding, and a concurrent lock', async (t) => {
  const f = await fixture(t);
  let invoked = false;
  await assert.rejects(activateVerifiedStagedRelease({
    request: request(f.signed.value),
    trustedAnchors: f.signed.anchors,
    paths: f.paths,
    ownerUID: f.ownerUID,
    readMachineIdentity: async () => machineIdentity,
    verifyTargetCompatibility: async () => ({ supported: true }),
    verifyArtifact: async () => { throw new Error('staged_release_integrity_invalid'); },
    runInstaller: async () => { invoked = true; },
  }), /staged_release_integrity_invalid/);
  assert.equal(invoked, false);
  const failed = await readBootstrapAttemptProgress({ attemptId, root: f.paths.bootstrapAttemptRoot });
  assert.equal(failed.state.phase, 'recoverable-incomplete');

  await assert.rejects(activateVerifiedStagedRelease({
    request: request(f.signed.value), trustedAnchors: f.signed.anchors, paths: f.paths,
    ownerUID: f.ownerUID, readMachineIdentity: async () => machineIdentity, verifyTargetCompatibility: async () => ({ supported: true }), verifyArtifact: f.verifyArtifact, runInstaller: successfulRunner(f.paths),
  }), /first_install_recovery_required/);

  const second = await fixture(t);
  await writeBootstrapAttemptProgress({
    attemptId,
    targetIdentity: 'different_fixture_target_20261105',
    releaseId,
    phase: 'activation',
    root: second.paths.bootstrapAttemptRoot,
  });
  await assert.rejects(activateVerifiedStagedRelease({
    request: request(second.signed.value), trustedAnchors: second.signed.anchors, paths: second.paths,
    ownerUID: second.ownerUID, readMachineIdentity: async () => machineIdentity, verifyTargetCompatibility: async () => ({ supported: true }), verifyArtifact: second.verifyArtifact, runInstaller: successfulRunner(second.paths),
  }), /first_install_attempt_binding_mismatch/);

  const third = await fixture(t);
  await fs.writeFile(path.join(path.dirname(third.paths.bootstrapAttemptRoot), 'first-install.lock'), 'interrupted\n', { mode: 0o600 });
  await assert.rejects(activateVerifiedStagedRelease({
    request: request(third.signed.value), trustedAnchors: third.signed.anchors, paths: third.paths,
    ownerUID: third.ownerUID, readMachineIdentity: async () => machineIdentity, verifyTargetCompatibility: async () => ({ supported: true }), verifyArtifact: third.verifyArtifact, runInstaller: successfulRunner(third.paths),
  }), /first_install_activation_in_progress/);

  const fourth = await fixture(t);
  await assert.rejects(activateVerifiedStagedRelease({
    request: request(fourth.signed.value), trustedAnchors: fourth.signed.anchors, paths: fourth.paths,
    ownerUID: fourth.ownerUID, readMachineIdentity: async () => 'fedcba9876543210fedcba9876543210', verifyTargetCompatibility: async () => ({ supported: true }), verifyArtifact: fourth.verifyArtifact,
    runInstaller: async () => { throw new Error('must not invoke for another machine'); },
  }), /first_install_target_identity_mismatch/);
});

test('first-install request accepts no caller path, command, or release override', () => {
  const signed = envelope();
  assert.throws(() => normalizeGateCFirstInstallRequest({ ...request(signed.value), path: '/opt/sonuvi/current' }), /unsupported/);
  assert.throws(() => normalizeGateCFirstInstallRequest({ ...request(signed.value), command: 'id' }), /unsupported/);
  assert.throws(() => normalizeGateCFirstInstallRequest({ ...request(signed.value), releaseId }), /unsupported/);
});

test('fixed staged installer receives JSON through its child stdin pipe', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-gate-c-first-install-pipe-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const installer = path.join(root, 'fixed-installer.mjs');
  await fs.writeFile(installer, [
    'const chunks = [];',
    'for await (const value of process.stdin) chunks.push(Buffer.from(value));',
    'const request = JSON.parse(Buffer.concat(chunks).toString(\'utf8\'));',
    'process.stdout.write(JSON.stringify({ ok: true, state: \'awaiting-administrator-enrollment\', releaseId: request.releaseId }));',
  ].join('\n'), { mode: 0o644 });
  const result = await runFixedStagedInstaller({
    installerPath: installer,
    request: { attemptId, targetIdentity, releaseId, serverIdentity },
    spawnProcess: (_fixedNodePath, args, options) => spawnChild(process.execPath, args, options),
  });
  assert.deepEqual(result, { ok: true, state: 'awaiting-administrator-enrollment', releaseId });
});
