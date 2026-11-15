import fs from 'node:fs/promises';
import path from 'node:path';

import { appendFreshInstallJournal, FRESH_INSTALL_STATE_CONTRACT, readFreshInstallJournal, writeFreshInstallState } from './sonuvi-fresh-install.mjs';

export const BOOTSTRAP_ATTEMPT_STATE_ROOT = '/var/lib/sonuvi-bootstrap/attempts';

function text(value) {
  return String(value ?? '').trim();
}

function absolute(value, label) {
  const result = text(value);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function attemptId(value) {
  const result = text(value);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(result)) throw new Error('bootstrap attempt ID is invalid');
  return result;
}

function targetIdentity(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error('target identity is invalid');
  return result;
}

export function bootstrapAttemptPaths({ attemptId: rawAttemptId, root = BOOTSTRAP_ATTEMPT_STATE_ROOT } = {}) {
  const id = attemptId(rawAttemptId);
  const base = path.join(absolute(root, 'bootstrap attempt root'), id);
  return Object.freeze({ root: base, statePath: path.join(base, 'state.json'), journalPath: path.join(base, 'journal.jsonl') });
}

/** Persist only non-secret, reconnect-safe progress before the Sonuvi state root exists. */
export async function writeBootstrapAttemptProgress({ attemptId: rawAttemptId, targetIdentity: rawTargetIdentity, releaseId = null, phase, errorCode = null, root = BOOTSTRAP_ATTEMPT_STATE_ROOT, now = () => new Date().toISOString() } = {}) {
  const id = attemptId(rawAttemptId);
  const target = targetIdentity(rawTargetIdentity);
  const state = {
    contract: FRESH_INSTALL_STATE_CONTRACT,
    attemptId: id,
    targetIdentity: target,
    releaseId: /^sonuvi-[a-f0-9]{64}$/.test(text(releaseId)) ? text(releaseId) : null,
    phase: text(phase),
    updatedAt: now(),
    ...(errorCode ? { errorCode: text(errorCode) } : {}),
  };
  if (!state.phase) throw new Error('bootstrap phase is required');
  const paths = bootstrapAttemptPaths({ attemptId: id, root });
  await writeFreshInstallState({ statePath: paths.statePath, state });
  return Object.freeze({ ...paths, state: Object.freeze(state) });
}

export async function appendBootstrapAttemptEvent({ attemptId: rawAttemptId, targetIdentity: rawTargetIdentity, event, root = BOOTSTRAP_ATTEMPT_STATE_ROOT } = {}) {
  const id = attemptId(rawAttemptId);
  const target = targetIdentity(rawTargetIdentity);
  const paths = bootstrapAttemptPaths({ attemptId: id, root });
  return appendFreshInstallJournal({ journalPath: paths.journalPath, attemptId: id, targetIdentity: target, event });
}

/** Read-only recovery primitive used by the fixed status helper. */
export async function readBootstrapAttemptProgress({ attemptId: rawAttemptId, root = BOOTSTRAP_ATTEMPT_STATE_ROOT } = {}) {
  const id = attemptId(rawAttemptId);
  const paths = bootstrapAttemptPaths({ attemptId: id, root });
  let state;
  try {
    state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('bootstrap_status_unavailable');
  }
  if (state?.contract !== FRESH_INSTALL_STATE_CONTRACT || state.attemptId !== id) throw new Error('bootstrap_status_contract_invalid');
  return Object.freeze({ paths, state: Object.freeze(state), events: await readFreshInstallJournal({ journalPath: paths.journalPath }) });
}
