import { spawn as spawnChild } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { appendBootstrapAttemptEvent, BOOTSTRAP_ATTEMPT_STATE_ROOT, readBootstrapAttemptProgress, writeBootstrapAttemptProgress } from './sonuvi-bootstrap-progress.mjs';
import { verifyReleaseArtifact } from './release-artifact.mjs';
import { verifySignedGateCReleaseMetadata } from './sonuvi-gate-c-release.mjs';

export const GATE_C_FIRST_INSTALL_CONTRACT = 'sonuvi.gate-c-first-install.v1';
export const GATE_C_FIRST_INSTALL_OPERATION = 'activate_first_install';
export const GATE_C_FIRST_INSTALL_ENTRYPOINT = '/var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs';
export const GATE_C_FIRST_INSTALL_PATHS = Object.freeze({
  bootstrapReleaseRoot: '/var/lib/sonuvi-bootstrap/releases',
  bootstrapAttemptRoot: BOOTSTRAP_ATTEMPT_STATE_ROOT,
});

const STAGED_INSTALLER_RELATIVE_PATH = Object.freeze(['scripts', 'sonuvi-target-installer.mjs']);
const INSTALLER_TIMEOUT_MS = 10 * 60_000;
const INSTALLER_OUTPUT_LIMIT = 128 * 1024;

function text(value) {
  return String(value ?? '').trim();
}

function sameKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unsupported fields`);
}

function attemptId(value) {
  const result = text(value);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(result)) throw new Error('first install attempt ID is invalid');
  return result;
}

function targetIdentity(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error('first install target identity is invalid');
  return result;
}

async function verifyTargetMachineIdentity({ target, readMachineIdentity }) {
  const observed = targetIdentity((await readMachineIdentity()).toString('utf8').trim());
  if (observed !== target) throw new Error('first_install_target_identity_mismatch');
  return observed;
}

function serverIdentity(value) {
  const result = text(value);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(result)) throw new Error('first install server identity is invalid');
  return result;
}

function absolute(value, label) {
  const result = text(value);
  if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function safeFailureCode(error) {
  const value = text(error?.message);
  return /^[a-z][a-z0-9_]{2,80}$/.test(value) ? value : 'first_install_activation_failed';
}

function rootOwnedDirectory(stat, label, expectedOwnerUID) {
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()) throw new Error(`${label}_invalid`);
  if (!Number.isInteger(stat.uid) || stat.uid !== expectedOwnerUID) throw new Error(`${label}_owner_invalid`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label}_mode_invalid`);
}

function rootOwnedRegularFile(stat, label, expectedOwnerUID) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) throw new Error(`${label}_invalid`);
  if (!Number.isInteger(stat.uid) || stat.uid !== expectedOwnerUID) throw new Error(`${label}_owner_invalid`);
  // The trusted bootstrap invokes this JavaScript source through the fixed
  // Node binary. It must be root-readable and immutable, not shell-executable.
  if ((stat.mode & 0o022) !== 0 || (stat.mode & 0o400) === 0) throw new Error(`${label}_mode_invalid`);
}

function expectedOwnerUID() {
  return typeof process.getuid === 'function' ? 0 : 0;
}

export function normalizeGateCFirstInstallRequest(input = {}) {
  sameKeys(input, ['attemptId', 'envelope', 'operation', 'serverIdentity', 'targetIdentity'], 'first install request');
  if (text(input.operation) !== GATE_C_FIRST_INSTALL_OPERATION) throw new Error('first install operation is invalid');
  if (!input.envelope || typeof input.envelope !== 'object' || Array.isArray(input.envelope)) {
    throw new Error('first install release envelope is required');
  }
  return Object.freeze({
    operation: GATE_C_FIRST_INSTALL_OPERATION,
    envelope: input.envelope,
    attemptId: attemptId(input.attemptId),
    targetIdentity: targetIdentity(input.targetIdentity),
    serverIdentity: serverIdentity(input.serverIdentity),
  });
}

async function verifyStagedRelease({ releaseId, manifestSha256, paths, verifyArtifact, lstat, readFile, ownerUID }) {
  const bootstrapReleaseRoot = absolute(paths.bootstrapReleaseRoot, 'bootstrap release root');
  rootOwnedDirectory(await lstat(bootstrapReleaseRoot), 'bootstrap_release_root', ownerUID);
  const releaseRoot = path.join(bootstrapReleaseRoot, releaseId);
  rootOwnedDirectory(await lstat(releaseRoot), 'staged_release_root', ownerUID);
  const scriptsRoot = path.join(releaseRoot, STAGED_INSTALLER_RELATIVE_PATH[0]);
  rootOwnedDirectory(await lstat(scriptsRoot), 'staged_installer_directory', ownerUID);
  const installerPath = path.join(scriptsRoot, STAGED_INSTALLER_RELATIVE_PATH[1]);
  rootOwnedRegularFile(await lstat(installerPath), 'staged_installer', ownerUID);
  const manifest = await readFile(path.join(releaseRoot, 'release-manifest.json'));
  if (crypto.createHash('sha256').update(manifest).digest('hex') !== manifestSha256) {
    throw new Error('staged_release_manifest_mismatch');
  }
  const verified = await verifyArtifact({ artifactRoot: releaseRoot });
  if (verified?.releaseId !== releaseId) throw new Error('staged_release_identity_mismatch');
  return Object.freeze({ releaseRoot, installerPath, verified });
}

function parseInstallerOutput(stdout) {
  const source = Buffer.from(stdout || '').toString('utf8').trim();
  if (!source || source.length > INSTALLER_OUTPUT_LIMIT) throw new Error('target_installer_result_invalid');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('target_installer_result_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('target_installer_result_invalid');
  return parsed;
}

/** Invoke only Node and the verified staged target-installer entrypoint. */
export async function runFixedStagedInstaller({ installerPath, request, spawnProcess = spawnChild, timeoutMs = INSTALLER_TIMEOUT_MS } = {}) {
  const target = absolute(installerPath, 'staged installer path');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('target installer request is invalid');
  const input = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const child = spawnProcess('/usr/bin/node', [target], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    let outputBytes = 0;
    child.once('error', () => finish(reject, new Error('target_installer_spawn_failed')));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > INSTALLER_OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        finish(reject, new Error('target_installer_output_exceeded'));
        return;
      }
      output.push(Buffer.from(chunk));
    });
    child.once('close', (code) => {
      const parsed = (() => {
        try { return parseInstallerOutput(Buffer.concat(output)); } catch { return null; }
      })();
      if (code !== 0 || parsed?.ok !== true) {
        finish(reject, new Error('target_installer_failed'));
        return;
      }
      finish(resolve, parsed);
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('target_installer_timeout'));
    }, timeoutMs);
    child.stdin.once('error', () => finish(reject, new Error('target_installer_stdin_failed')));
    child.stdin.end(input);
  });
}

async function acquireFirstInstallLock({ root, releaseId, attemptId: id, targetIdentity: target, ownerUID, lstat = fs.lstat, open = fs.open, unlink = fs.unlink } = {}) {
  const base = absolute(root, 'bootstrap attempt root');
  rootOwnedDirectory(await lstat(base), 'bootstrap_attempt_root', ownerUID);
  const lockPath = path.join(path.dirname(base), 'first-install.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('first_install_activation_in_progress');
    throw new Error('first_install_lock_unavailable');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ contract: GATE_C_FIRST_INSTALL_CONTRACT, releaseId, attemptId: id, targetIdentity: target })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  return Object.freeze({
    async release() {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    },
  });
}

async function existingAttempt({ id, target, releaseId, root }) {
  const existing = await readBootstrapAttemptProgress({ attemptId: id, root });
  if (!existing) return null;
  if (text(existing.state.targetIdentity) !== target || text(existing.state.releaseId) !== releaseId) {
    throw new Error('first_install_attempt_binding_mismatch');
  }
  if (['awaiting-administrator-enrollment', 'administrator-enrolled', 'complete'].includes(text(existing.state.phase))) {
    return Object.freeze({ state: 'already_activated', releaseId, attemptId: id, targetIdentity: target });
  }
  if (text(existing.state.phase) === 'recoverable-incomplete') throw new Error('first_install_recovery_required');
  throw new Error('first_install_activation_in_progress');
}

async function recordFailure({ id, target, releaseId, root, code }) {
  await writeBootstrapAttemptProgress({
    attemptId: id,
    targetIdentity: target,
    releaseId,
    phase: 'recoverable-incomplete',
    errorCode: safeFailureCode(code),
    root,
  }).catch(() => {});
  await appendBootstrapAttemptEvent({
    attemptId: id,
    targetIdentity: target,
    root,
    event: {
      requestId: id,
      stage: 'activation',
      state: 'failed',
      error: { code: safeFailureCode(code), recoverable: true },
    },
  }).catch(() => {});
}

/**
 * First-install bridge between the root-owned bootstrap kit and the immutable
 * staged release. Client input cannot supply paths, commands, release IDs, or
 * installer arguments; the release ID is taken only from verified metadata.
 */
export async function activateVerifiedStagedRelease({ request, trustedAnchors, paths = GATE_C_FIRST_INSTALL_PATHS, verifyArtifact = verifyReleaseArtifact, lstat = fs.lstat, readFile = fs.readFile, readMachineIdentity = () => fs.readFile('/etc/machine-id'), ownerUID = expectedOwnerUID(), runInstaller = runFixedStagedInstaller } = {}) {
  const input = normalizeGateCFirstInstallRequest(request);
  const { metadata } = verifySignedGateCReleaseMetadata({ envelope: input.envelope, trustedAnchors });
  await verifyTargetMachineIdentity({ target: input.targetIdentity, readMachineIdentity });
  const configured = Object.freeze({
    bootstrapReleaseRoot: absolute(paths.bootstrapReleaseRoot, 'bootstrap release root'),
    bootstrapAttemptRoot: absolute(paths.bootstrapAttemptRoot, 'bootstrap attempt root'),
  });
  const prior = await existingAttempt({
    id: input.attemptId,
    target: input.targetIdentity,
    releaseId: metadata.releaseId,
    root: configured.bootstrapAttemptRoot,
  });
  if (prior) return Object.freeze({ contract: GATE_C_FIRST_INSTALL_CONTRACT, ...prior });

  const lock = await acquireFirstInstallLock({
    root: configured.bootstrapAttemptRoot,
    releaseId: metadata.releaseId,
    attemptId: input.attemptId,
    targetIdentity: input.targetIdentity,
    ownerUID,
    lstat,
  });
  let bound = false;
  try {
    await writeBootstrapAttemptProgress({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      releaseId: metadata.releaseId,
      phase: 'release_verification',
      root: configured.bootstrapAttemptRoot,
    });
    bound = true;
    await appendBootstrapAttemptEvent({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      root: configured.bootstrapAttemptRoot,
      event: { requestId: input.attemptId, stage: 'release_verification', state: 'started' },
    });
    const staged = await verifyStagedRelease({
      releaseId: metadata.releaseId,
      manifestSha256: metadata.manifestSha256,
      paths: configured,
      verifyArtifact,
      lstat,
      readFile,
      ownerUID,
    });
    await appendBootstrapAttemptEvent({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      root: configured.bootstrapAttemptRoot,
      event: { requestId: input.attemptId, stage: 'release_verification', state: 'passed' },
    });
    await writeBootstrapAttemptProgress({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      releaseId: metadata.releaseId,
      phase: 'activation',
      root: configured.bootstrapAttemptRoot,
    });
    await appendBootstrapAttemptEvent({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      root: configured.bootstrapAttemptRoot,
      event: { requestId: input.attemptId, stage: 'activation', state: 'started' },
    });
    const result = await runInstaller({
      installerPath: staged.installerPath,
      request: Object.freeze({
        attemptId: input.attemptId,
        targetIdentity: input.targetIdentity,
        releaseId: metadata.releaseId,
        serverIdentity: input.serverIdentity,
      }),
    });
    if (!result || result.ok !== true || text(result.releaseId) !== metadata.releaseId || text(result.state) !== 'awaiting-administrator-enrollment') {
      throw new Error('target_installer_result_invalid');
    }
    const complete = await readBootstrapAttemptProgress({ attemptId: input.attemptId, root: configured.bootstrapAttemptRoot });
    if (!complete || text(complete.state.targetIdentity) !== input.targetIdentity || text(complete.state.releaseId) !== metadata.releaseId || text(complete.state.phase) !== 'awaiting-administrator-enrollment') {
      throw new Error('target_installer_status_missing');
    }
    return Object.freeze({
      contract: GATE_C_FIRST_INSTALL_CONTRACT,
      state: 'awaiting-administrator-enrollment',
      releaseId: metadata.releaseId,
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
    });
  } catch (error) {
    if (bound) await recordFailure({
      id: input.attemptId,
      target: input.targetIdentity,
      releaseId: metadata.releaseId,
      root: configured.bootstrapAttemptRoot,
      code: error,
    });
    throw error;
  } finally {
    await lock.release();
  }
}
