import fs from 'node:fs/promises';
import path from 'node:path';

import { BOOTSTRAP_ATTEMPT_STATE_ROOT, readBootstrapAttemptProgress } from './sonuvi-bootstrap-progress.mjs';
import { FRESH_INSTALL_STATE_CONTRACT, readFreshInstallJournal } from './sonuvi-fresh-install.mjs';

export const BOOTSTRAP_STATUS_CONTRACT = 'sonuvi.bootstrap-status.v1';
export const BOOTSTRAP_STATUS_OPERATION = 'status';

function text(value) {
  return String(value ?? '').trim();
}

function attemptId(value) {
  const result = text(value);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(result)) throw new Error('bootstrap attempt ID is invalid');
  return result;
}

function absolute(value, label) {
  const result = text(value);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function nextAction(phase) {
  if (phase === 'awaiting-administrator-enrollment') return 'administrator_enrollment';
  if (phase === 'administrator-enrolled') return 'first_controller_authorization';
  if (phase === 'complete') return 'complete';
  if (phase === 'recoverable-incomplete') return 'recover';
  return 'observe';
}

/** Validate the fixed, read-only SSH status request. */
export function normalizeBootstrapStatusRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bootstrap status request is invalid');
  if (Object.keys(input).sort().join(',') !== 'attemptId,operation') throw new Error('bootstrap status request has unsupported fields');
  if (text(input.operation) !== BOOTSTRAP_STATUS_OPERATION) throw new Error('bootstrap status operation is invalid');
  return Object.freeze({ operation: BOOTSTRAP_STATUS_OPERATION, attemptId: attemptId(input.attemptId) });
}

/**
 * Read a durable snapshot for one attempt. It never creates an attempt,
 * starts an installer, or rewrites state, so reconnecting after SSH loss is
 * observation-only and cannot duplicate installation.
 */
export async function readBootstrapStatus({ request, stateRoot = '/var/lib/sonuvi', bootstrapAttemptRoot = BOOTSTRAP_ATTEMPT_STATE_ROOT, readFile = fs.readFile } = {}) {
  const input = normalizeBootstrapStatusRequest(request);
  const root = absolute(stateRoot, 'state root');
  const statePath = path.join(root, 'install', 'state.json');
  const early = await readBootstrapAttemptProgress({ attemptId: input.attemptId, root: bootstrapAttemptRoot });
  let finalState = null;
  try {
    finalState = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('bootstrap_status_unavailable');
  }
  if (!early && !finalState) throw new Error('bootstrap_attempt_not_found');
  if (finalState && finalState?.contract !== FRESH_INSTALL_STATE_CONTRACT) throw new Error('bootstrap_status_contract_invalid');
  if (finalState && attemptId(finalState.attemptId) !== input.attemptId) throw new Error('bootstrap_attempt_not_found');
  const state = finalState || early.state;
  if (state?.contract !== FRESH_INSTALL_STATE_CONTRACT) throw new Error('bootstrap_status_contract_invalid');
  if (attemptId(state.attemptId) !== input.attemptId) throw new Error('bootstrap_attempt_not_found');
  const targetIdentity = text(state.targetIdentity);
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(targetIdentity)) throw new Error('bootstrap_status_contract_invalid');
  if (early && text(early.state.targetIdentity) !== targetIdentity) throw new Error('bootstrap_status_contract_invalid');
  const finalEvents = finalState
    ? await readFreshInstallJournal({ journalPath: path.join(root, 'install', 'journal.jsonl') })
    : [];
  const events = [...(early?.events || []), ...finalEvents]
    .filter((event) => event?.attemptId === input.attemptId && event?.targetIdentity === targetIdentity)
    .map((event) => Object.freeze({
      contract: text(event.contract),
      eventId: text(event.eventId),
      attemptId: input.attemptId,
      stage: text(event.stage),
      state: text(event.state),
      at: text(event.at),
      progress: Number.isInteger(event.progress) ? event.progress : null,
      error: event.error && typeof event.error === 'object'
        ? Object.freeze({ code: text(event.error.code), recoverable: event.error.recoverable === true })
        : null,
    }));
  const phase = text(state.phase);
  if (!phase) throw new Error('bootstrap_status_contract_invalid');
  return Object.freeze({
    contract: BOOTSTRAP_STATUS_CONTRACT,
    attemptId: input.attemptId,
    targetIdentity,
    releaseId: /^sonuvi-[a-f0-9]{64}$/.test(text(state.releaseId)) ? text(state.releaseId) : null,
    phase,
    next: nextAction(phase),
    terminal: phase === 'complete' || phase === 'recoverable-incomplete',
    updatedAt: text(state.updatedAt || state.completedAt || state.startedAt) || null,
    events: Object.freeze(events),
  });
}
