import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { activateReleaseTransaction, recoverInterruptedActivation } from './release-activation.mjs';
import { makeTreeReadOnly, promoteStagedHostRelease, verifyReleaseArtifact } from './release-artifact.mjs';
import { verifySignedGateCReleaseMetadata } from './sonuvi-gate-c-release.mjs';
import { createLinuxSystemdUpgradeAdapter } from './sonuvi-linux-systemd-upgrade.mjs';
import { readGateCTargetIdentity, verifyGateCTargetCompatibility } from './sonuvi-gate-c-target-preflight.mjs';

export const GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT = 'sonuvi.gate-c-existing-install-upgrade.v1';
export const GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION = 'activate_existing_install';
export const GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION = 'recover_interrupted_upgrade';
export const GATE_C_EXISTING_INSTALL_UPGRADE_PATHS = Object.freeze({
  layoutRoot: '/opt/sonuvi',
  stateRoot: '/var/lib/sonuvi',
  unitRoot: '/etc/systemd/system',
  bootstrapReleaseRoot: '/var/lib/sonuvi-bootstrap/releases',
  bootstrapAttemptRoot: '/var/lib/sonuvi-bootstrap/attempts',
  trustAnchorPath: '/etc/sonuvi/release-trust-anchors.json',
});
export const GATE_C_UPGRADE_FAILURE_CODES = Object.freeze([
  'upgrade_input_invalid',
  'upgrade_authorization_required',
  'upgrade_target_mismatch',
  'upgrade_attempt_mismatch',
  'upgrade_release_identity_mismatch',
  'upgrade_current_release_mismatch',
  'upgrade_state_invalid',
  'upgrade_stage_invalid',
  'upgrade_systemd_unavailable',
  'upgrade_activation_failed',
  'upgrade_rollback_failed',
  'upgrade_recovery_required',
]);

function text(value) { return String(value ?? '').trim(); }

function failure(code) {
  const error = new Error(code);
  error.upgradeCode = code;
  return error;
}

function sameKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw failure('upgrade_input_invalid');
  }
  return value;
}

function responseKeys(value, keys) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw failure('upgrade_response_invalid');
}

function attemptId(value) {
  const result = text(value);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(result)) throw failure('upgrade_input_invalid');
  return result;
}

function releaseId(value) {
  const result = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(result)) throw failure('upgrade_input_invalid');
  return result;
}

function targetIdentity(value) {
  const result = text(value);
  if (!/^sonuvi-target-v1-[a-f0-9]{64}$/.test(result)) throw failure('upgrade_input_invalid');
  return result;
}

function normalizeRequest(value) {
  if (text(value?.operation) === GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION) {
    sameKeys(value, ['attemptId', 'envelope', 'expectedPreviousReleaseId', 'operation', 'targetIdentity'], 'upgrade request');
    if (!value.envelope || typeof value.envelope !== 'object' || Array.isArray(value.envelope)) throw failure('upgrade_input_invalid');
    return Object.freeze({
      operation: GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION,
      attemptId: attemptId(value.attemptId),
      targetIdentity: targetIdentity(value.targetIdentity),
      expectedPreviousReleaseId: releaseId(value.expectedPreviousReleaseId),
      envelope: value.envelope,
    });
  }
  if (text(value?.operation) === GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION) {
    sameKeys(value, ['operation', 'targetIdentity'], 'upgrade recovery request');
    return Object.freeze({
      operation: GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION,
      targetIdentity: targetIdentity(value.targetIdentity),
    });
  }
  throw failure('upgrade_input_invalid');
}

function trustedStat(stat, { directory = false, ownerUID = 0, maxWritable = 0o022 } = {}) {
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || stat.uid !== ownerUID || ((stat.mode & 0o777) & maxWritable) !== 0) {
    throw failure('upgrade_state_invalid');
  }
}

async function readTrustedJson(filePath, ownerUID = 0) {
  try {
    const stat = await fs.lstat(filePath);
    trustedStat(stat, { ownerUID });
    if (await fs.realpath(filePath) !== path.resolve(filePath)) throw failure('upgrade_state_invalid');
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.upgradeCode) throw error;
    throw failure('upgrade_state_invalid');
  }
}

async function assertTrustedReleaseTree(root, ownerUID = 0) {
  const absolute = path.resolve(root);
  const rootStat = await fs.lstat(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== ownerUID
    || (rootStat.mode & 0o022) !== 0 || await fs.realpath(absolute) !== absolute) throw failure('upgrade_stage_invalid');
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.uid !== ownerUID) throw failure('upgrade_stage_invalid');
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(candidate).catch(() => null);
        if (!resolved || !(resolved === absolute || resolved.startsWith(`${absolute}${path.sep}`))) throw failure('upgrade_stage_invalid');
      } else if (stat.isDirectory()) {
        if ((stat.mode & 0o022) !== 0) throw failure('upgrade_stage_invalid');
        await visit(candidate);
      } else if (!stat.isFile() || (stat.mode & 0o022) !== 0) {
        throw failure('upgrade_stage_invalid');
      }
    }
  }
  await visit(absolute);
}

async function assertAttemptBinding({ attemptId: id, targetIdentity: identity, releaseId: idRelease, root, ownerUID = 0 }) {
  const attemptRoot = path.resolve(root);
  const directory = path.join(attemptRoot, id);
  try {
    const [rootStat, directoryStat] = await Promise.all([fs.lstat(attemptRoot), fs.lstat(directory)]);
    trustedStat(rootStat, { directory: true, ownerUID, maxWritable: 0o022 });
    trustedStat(directoryStat, { directory: true, ownerUID, maxWritable: 0o022 });
    if (await fs.realpath(attemptRoot) !== attemptRoot || await fs.realpath(directory) !== directory) throw failure('upgrade_attempt_mismatch');
    const state = await readTrustedJson(path.join(directory, 'state.json'), ownerUID);
    if (state.contract !== 'sonuvi.fresh-install-state.v1' || state.attemptId !== id
      || state.targetIdentity !== identity || state.releaseId !== idRelease || state.phase !== 'release_staged') {
      throw failure('upgrade_attempt_mismatch');
    }
  } catch (error) {
    if (error?.upgradeCode) throw error;
    throw failure('upgrade_attempt_mismatch');
  }
}

async function promoteVerifiedStagedCandidate({ layoutRoot, stagingRoot, targetRoot, releaseId: id, ownerUID }) {
  try {
    const stat = await fs.lstat(stagingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUID || (stat.mode & 0o022) !== 0) {
      throw failure('upgrade_stage_invalid');
    }
    const verified = await verifyReleaseArtifact({ artifactRoot: stagingRoot });
    if (verified.releaseId !== id) throw failure('upgrade_stage_invalid');
    await assertTrustedReleaseTree(stagingRoot, ownerUID);
    await makeTreeReadOnly(stagingRoot);
    await assertTrustedReleaseTree(stagingRoot, ownerUID);
    const promoted = await promoteStagedHostRelease({ layoutRoot, stagingRoot });
    if (promoted.releaseId !== id || promoted.releaseRoot !== targetRoot) throw failure('upgrade_stage_invalid');
    await assertTrustedReleaseTree(targetRoot, ownerUID);
    return promoted;
  } catch (error) {
    if (error?.upgradeCode) throw error;
    // A partial or unverified staging child is left untouched for inspection.
    throw failure('upgrade_stage_invalid');
  }
}

async function promoteCandidate({ sourceRoot, layoutRoot, releaseId: id, ownerUID = 0 }) {
  const verifiedSource = await verifyReleaseArtifact({ artifactRoot: sourceRoot }).catch(() => null);
  if (!verifiedSource || verifiedSource.releaseId !== id) throw failure('upgrade_stage_invalid');
  await assertTrustedReleaseTree(sourceRoot, ownerUID);
  const targetRoot = path.join(layoutRoot, 'releases', id);
  try {
    const existing = await fs.lstat(targetRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure('upgrade_stage_invalid');
    const verified = await verifyReleaseArtifact({ artifactRoot: targetRoot });
    if (verified.releaseId !== id) throw failure('upgrade_stage_invalid');
    await assertTrustedReleaseTree(targetRoot, ownerUID);
    return verified;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error?.upgradeCode) throw error;
      throw failure('upgrade_stage_invalid');
    }
  }

  const stagingParent = path.join(layoutRoot, '.staging');
  const stagingRoot = path.join(stagingParent, id);
  await fs.mkdir(stagingParent, { recursive: true, mode: 0o755 });
  const parentStat = await fs.lstat(stagingParent);
  trustedStat(parentStat, { directory: true, ownerUID, maxWritable: 0o022 });
  try {
    await fs.lstat(stagingRoot);
    // A previous process may have stopped after a complete host-side copy but
    // before the atomic rename. Resume only if the existing child verifies as
    // this exact immutable release. Incomplete children fail closed and are
    // never erased or overwritten by the upgrade operation.
    return await promoteVerifiedStagedCandidate({ layoutRoot, stagingRoot, targetRoot, releaseId: id, ownerUID });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error?.upgradeCode ? error : failure('upgrade_stage_invalid');
  }
  try {
    await fs.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw failure('upgrade_stage_invalid');
    throw failure('upgrade_stage_invalid');
  }
  try {
    await fs.cp(sourceRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true });
    return await promoteVerifiedStagedCandidate({ layoutRoot, stagingRoot, targetRoot, releaseId: id, ownerUID });
  } catch (error) {
    // Do not recursively delete a possibly valid candidate. An incomplete
    // host staging child is inert and an operator can inspect it separately.
    if (error?.upgradeCode) throw error;
    throw failure('upgrade_stage_invalid');
  }
}

function response(operation, values) {
  return Object.freeze({ contract: GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT, operation, ...values });
}

export async function runGateCExistingInstallUpgrade({
  request: rawRequest,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  architecture = process.arch,
  platform = process.platform,
  paths: configuredPaths = GATE_C_EXISTING_INSTALL_UPGRADE_PATHS,
  ownerUID = 0,
  trustedAnchors,
  readFile = fs.readFile,
  readTarget = () => readGateCTargetIdentity(),
  verifyTargetCompatibility = () => verifyGateCTargetCompatibility({ platform, architecture }),
  activate = activateReleaseTransaction,
  recover = recoverInterruptedActivation,
  promote = promoteCandidate,
  adapterFactory = (paths, owner) => createLinuxSystemdUpgradeAdapter({ paths, ownerUID: owner }),
} = {}) {
  let operation = text(rawRequest?.operation);
  try {
    const input = normalizeRequest(rawRequest);
    operation = input.operation;
    if (uid !== 0) throw failure('upgrade_authorization_required');
    await verifyTargetCompatibility();
    if (await readTarget() !== input.targetIdentity) throw failure('upgrade_target_mismatch');
    const paths = Object.freeze({ ...GATE_C_EXISTING_INSTALL_UPGRADE_PATHS, ...configuredPaths });
    const adapter = adapterFactory({ layoutRoot: paths.layoutRoot, stateRoot: paths.stateRoot, unitRoot: paths.unitRoot }, ownerUID);

    if (input.operation === GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION) {
      const result = await recover({
        layoutRoot: paths.layoutRoot,
        stateRoot: paths.stateRoot,
        ownerUID,
        targetIdentity: input.targetIdentity,
        adapter,
      });
      return response(input.operation, {
        ok: true,
        state: result.recovered ? 'recovered' : 'no-recovery-required',
        ...(result.previousReleaseId ? { previousReleaseId: result.previousReleaseId } : {}),
      });
    }

    const { metadata } = verifySignedGateCReleaseMetadata({ envelope: input.envelope, trustedAnchors });
    if (metadata.bootstrap.version !== 2) throw failure('upgrade_release_identity_mismatch');
    if (metadata.releaseId === input.expectedPreviousReleaseId) throw failure('upgrade_current_release_mismatch');
    await assertAttemptBinding({
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      releaseId: metadata.releaseId,
      root: paths.bootstrapAttemptRoot,
      ownerUID,
    });
    const bootstrapRelease = path.join(paths.bootstrapReleaseRoot, metadata.releaseId);
    const verified = await verifyReleaseArtifact({ artifactRoot: bootstrapRelease }).catch(() => null);
    if (!verified || verified.releaseId !== metadata.releaseId) throw failure('upgrade_stage_invalid');
    const manifestBytes = await readFile(path.join(bootstrapRelease, 'release-manifest.json'));
    if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== metadata.manifestSha256) {
      throw failure('upgrade_release_identity_mismatch');
    }
    await assertTrustedReleaseTree(bootstrapRelease, ownerUID);
    await promote({ sourceRoot: bootstrapRelease, layoutRoot: paths.layoutRoot, releaseId: metadata.releaseId, ownerUID });

    const result = await activate({
      layoutRoot: paths.layoutRoot,
      stateRoot: paths.stateRoot,
      ownerUID,
      releaseId: metadata.releaseId,
      expectedPreviousReleaseId: input.expectedPreviousReleaseId,
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      envelope: input.envelope,
      trustedAnchors,
      adapter,
    });
    return response(input.operation, {
      ok: true,
      state: 'committed',
      releaseId: result.releaseId,
      previousReleaseId: result.previousReleaseId,
      attemptId: input.attemptId,
      targetIdentity: input.targetIdentity,
      transactionId: result.transactionId,
    });
  } catch (error) {
    const code = GATE_C_UPGRADE_FAILURE_CODES.includes(error?.upgradeCode)
      ? error.upgradeCode
      : error?.message === 'interrupted activation target identity mismatch'
        ? 'upgrade_target_mismatch'
        : error?.message?.includes('rollback failed') || error?.upgradeCode === 'upgrade_backup_restore_failed'
          ? 'upgrade_rollback_failed'
          : error?.message?.includes('activation lock') || error?.message?.includes('manual recovery')
            ? 'upgrade_recovery_required'
            : error?.message?.includes('previous release') || error?.message?.includes('current release')
              ? 'upgrade_current_release_mismatch'
              : error?.message?.includes('signature') || error?.message?.includes('manifest mismatch')
                ? 'upgrade_release_identity_mismatch'
                : error?.message?.includes('systemd') || error?.upgradeCode?.startsWith('upgrade_systemd')
                  ? 'upgrade_systemd_unavailable'
                  : 'upgrade_activation_failed';
    return response(operation || GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION, { ok: false, code });
  }
}

export function normalizeGateCExistingInstallUpgradeResponse(value, { operation, attemptId: expectedAttempt, targetIdentity: expectedTarget } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== GATE_C_EXISTING_INSTALL_UPGRADE_CONTRACT
    || value.operation !== operation || typeof value.ok !== 'boolean') throw failure('upgrade_response_invalid');
  if (value.ok === false) {
    responseKeys(value, ['code', 'contract', 'ok', 'operation']);
    if (!GATE_C_UPGRADE_FAILURE_CODES.includes(value.code)) throw failure('upgrade_response_invalid');
    return Object.freeze(value);
  }
  if (value.ok) {
    if (operation === GATE_C_EXISTING_INSTALL_UPGRADE_OPERATION) {
      responseKeys(value, ['attemptId', 'contract', 'ok', 'operation', 'previousReleaseId', 'releaseId', 'state', 'targetIdentity', 'transactionId']);
      if (value.state !== 'committed' || !/^sonuvi-[a-f0-9]{64}$/.test(value.releaseId || '')
        || !/^sonuvi-[a-f0-9]{64}$/.test(value.previousReleaseId || '')
        || value.attemptId !== expectedAttempt || value.targetIdentity !== expectedTarget
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.transactionId || '')) throw failure('upgrade_response_invalid');
    } else if (operation === GATE_C_EXISTING_INSTALL_RECOVERY_OPERATION) {
      const keys = Object.keys(value).sort().join(',');
      const required = ['contract', 'ok', 'operation', 'state'];
      const withPrevious = [...required, 'previousReleaseId'];
      const allowedKeys = value.state === 'recovered' ? withPrevious.sort().join(',') : required.sort().join(',');
      if (!['recovered', 'no-recovery-required'].includes(value.state) || keys !== allowedKeys
        || (Object.hasOwn(value, 'previousReleaseId') && !/^sonuvi-[a-f0-9]{64}$/.test(value.previousReleaseId || ''))) {
        throw failure('upgrade_response_invalid');
      }
    } else {
      throw failure('upgrade_response_invalid');
    }
    return Object.freeze(value);
  }
  throw failure('upgrade_response_invalid');
}
