import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomically } from './atomic-file.mjs';
import { ACTIVATION_STATE_CONTRACT } from './release-activation.mjs';
import { verifyReleaseArtifact } from './release-artifact.mjs';
import { appendFreshInstallJournal, FRESH_INSTALL_STATE_CONTRACT, writeFreshInstallState } from './sonuvi-fresh-install.mjs';
function releaseId(value) { const result = String(value || '').trim(); if (!/^sonuvi-[a-f0-9]{64}$/.test(result)) throw new Error('release ID is invalid'); return result; }
async function currentOrNull(layoutRoot) { try { return await fs.lstat(path.join(layoutRoot, 'current')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function pointCurrent(layoutRoot, releaseRoot) { const pending = path.join(layoutRoot, `.current.${crypto.randomUUID()}`); await fs.symlink(path.relative(layoutRoot, releaseRoot), pending); await fs.rename(pending, path.join(layoutRoot, 'current')); }
function assertAdapter(adapter) { for (const method of ['prepare', 'restart', 'verify', 'health', 'rollback']) if (typeof adapter?.[method] !== 'function') throw new Error(`first-release adapter requires ${method}()`); return adapter; }
async function recordServiceActivationCheckpoint({ services, stateRoot, transactionId, releaseId: id, phase, startedAt, completedAt = null }) {
  const statePath = path.join(stateRoot, 'checkpoints', 'release-activation-state.json');
  const state = { contract: ACTIVATION_STATE_CONTRACT, transactionId, phase, candidateReleaseId: id, previousReleaseId: null, startedAt, completedAt, rollback: null };
  await writeJsonAtomically(statePath, state, { mode: 0o600 });
  if (typeof services.makeActivationStateReadable === 'function') await services.makeActivationStateReadable({ statePath, state });
  return state;
}
/** First activation has no fictional previous release; failure removes only its pointer. */
export async function activateFirstRelease({ layoutRoot, stateRoot, releaseId: requestedReleaseId, attemptId, targetIdentity, adapter, verifyArtifact = verifyReleaseArtifact } = {}) {
  const services = assertAdapter(adapter);
  if (typeof verifyArtifact !== 'function') throw new Error('release verifier is required');
  const root = path.resolve(String(layoutRoot || ''));
  const stateBase = path.resolve(String(stateRoot || ''));
  const statePath = path.join(stateBase, 'install', 'state.json');
  const journalPath = path.join(stateBase, 'install', 'journal.jsonl');
  const id = releaseId(requestedReleaseId);
  if (await currentOrNull(root)) throw new Error('first activation refused: current release already exists');
  const candidateRoot = path.join(root, 'releases', id);
  const candidate = await verifyArtifact({ artifactRoot: candidateRoot });
  if (candidate.releaseId !== id) throw new Error('candidate manifest does not match requested release');
  const transactionId = crypto.randomUUID();
  const base = { contract: FRESH_INSTALL_STATE_CONTRACT, attemptId, transactionId, targetIdentity, releaseId: id, previousReleaseId: null, startedAt: new Date().toISOString(), completedAt: null, phase: 'activation' };
  const event = async (stage, state, error) => appendFreshInstallJournal({ journalPath, attemptId, targetIdentity, event: { requestId: attemptId, stage, state, at: new Date().toISOString(), ...(error ? { error } : {}) } });
  await writeFreshInstallState({ statePath, state: base });
  await event('activation', 'started');
  const context = Object.freeze({ layoutRoot: root, stateRoot: stateBase, candidate, transactionId, attemptId, targetIdentity, previous: null });
  let pointed = false;
  try {
    await services.prepare(context);
    await pointCurrent(root, candidateRoot);
    pointed = true;
    await recordServiceActivationCheckpoint({ services, stateRoot: stateBase, transactionId, releaseId: id, phase: 'pointer-switched', startedAt: base.startedAt });
    await services.restart(context);
    await recordServiceActivationCheckpoint({ services, stateRoot: stateBase, transactionId, releaseId: id, phase: 'services-restarted', startedAt: base.startedAt });
    for (const service of ['api', 'web']) {
      const verified = await services.verify({ ...context, service, expectedReleaseId: id });
      if (!verified || verified.releaseId !== id) throw new Error(`${service} did not report candidate release`);
    }
    await recordServiceActivationCheckpoint({ services, stateRoot: stateBase, transactionId, releaseId: id, phase: 'services-verified', startedAt: base.startedAt });
    for (const service of ['api', 'web']) {
      const healthy = await services.health({ ...context, service, expectedReleaseId: id });
      if (!(healthy === true || healthy?.ok === true)) throw new Error(`${service} health check failed`);
    }
    const completedAt = new Date().toISOString();
    await recordServiceActivationCheckpoint({ services, stateRoot: stateBase, transactionId, releaseId: id, phase: 'committed', startedAt: base.startedAt, completedAt });
    const complete = { ...base, phase: 'complete', completedAt };
    await writeFreshInstallState({ statePath, state: complete });
    await event('health_verification', 'passed');
    return Object.freeze({ transactionId, releaseId: id, state: complete });
  } catch (cause) {
    if (pointed) await fs.unlink(path.join(root, 'current')).catch(() => {});
    await services.rollback({ ...context, cause, firstRelease: true });
    const failed = { ...base, phase: 'recoverable-incomplete', completedAt: new Date().toISOString(), errorCode: 'first_release_activation_failed' };
    await writeFreshInstallState({ statePath, state: failed }).catch(() => {});
    await event('activation', 'failed', { code: 'first_release_activation_failed', recoverable: true }).catch(() => {});
    throw cause;
  }
}
