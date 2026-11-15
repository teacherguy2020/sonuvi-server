import fs from 'node:fs/promises';
import path from 'node:path';

import { AdministratorAuthority } from './sonuvi-admin-authority.mjs';
import { FirstAdministratorEnrollment } from './sonuvi-bootstrap-security.mjs';
import { appendFreshInstallJournal, FRESH_INSTALL_STATE_CONTRACT, writeFreshInstallState } from './sonuvi-fresh-install.mjs';

export const ADMIN_BOOTSTRAP_OPERATIONS = Object.freeze(['enrollment_create', 'enrollment_claim']);

function text(value) { return String(value ?? '').trim(); }
function absolute(value, label) { const raw = text(value); if (!raw || !path.isAbsolute(raw)) throw new Error(`${label} must be absolute`); return path.resolve(raw); }
function id(value, label) { const result = text(value); if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error(`${label} is invalid`); return result; }

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('administrator bootstrap request is invalid');
  const operation = text(input.operation);
  if (!ADMIN_BOOTSTRAP_OPERATIONS.includes(operation)) throw new Error('administrator bootstrap operation is invalid');
  const expected = operation === 'enrollment_create'
    ? ['operation']
    : ['administratorDeviceId', 'administratorProof', 'administratorPublicKey', 'enrollmentToken', 'operation'];
  if (Object.keys(input).sort().join(',') !== expected.join(',')) throw new Error('administrator bootstrap request has unsupported fields');
  return Object.freeze({
    operation,
    enrollmentToken: operation === 'enrollment_claim' ? text(input.enrollmentToken) : '',
    administratorDeviceId: operation === 'enrollment_claim' ? text(input.administratorDeviceId) : '',
    administratorPublicKey: operation === 'enrollment_claim' ? text(input.administratorPublicKey) : '',
    administratorProof: operation === 'enrollment_claim' ? text(input.administratorProof) : '',
  });
}

async function readInstallation(stateRoot) {
  const root = absolute(stateRoot, 'state root');
  const statePath = path.join(root, 'install', 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { throw new Error('fresh_installation_state_unavailable'); }
  if (state?.contract !== FRESH_INSTALL_STATE_CONTRACT || state?.phase !== 'awaiting-administrator-enrollment') throw new Error('administrator_enrollment_unavailable');
  return Object.freeze({ root, statePath, state, attemptId: id(state.attemptId, 'attempt ID'), targetIdentity: id(state.targetIdentity, 'target identity') });
}

/**
 * Fixed root-side enrollment bridge. It reads target/attempt binding from the
 * durable fresh-install state; callers can never select another host, path,
 * release, or command. Raw credentials enter and leave only this local stdin/
 * stdout exchange and are never added to the installation journal or state.
 */
export async function runAdministratorBootstrap({ request, stateRoot = '/var/lib/sonuvi', now = () => new Date().toISOString() } = {}) {
  const input = normalizeRequest(request);
  const installation = await readInstallation(stateRoot);
  const enrollment = new FirstAdministratorEnrollment({ stateRoot: installation.root });
  const authority = new AdministratorAuthority({ stateRoot: installation.root });
  const journalPath = path.join(installation.root, 'install', 'journal.jsonl');

  if (input.operation === 'enrollment_create') {
    const created = await enrollment.create({ attemptId: installation.attemptId, targetIdentity: installation.targetIdentity });
    await appendFreshInstallJournal({ journalPath, attemptId: installation.attemptId, targetIdentity: installation.targetIdentity, event: { requestId: installation.attemptId, stage: 'administrator_enrollment', state: 'waiting', at: now() } });
    return Object.freeze({ state: 'administrator-enrollment-pending', enrollmentToken: created.enrollmentToken, expiresAt: created.expiresAt });
  }

  await appendFreshInstallJournal({ journalPath, attemptId: installation.attemptId, targetIdentity: installation.targetIdentity, event: { requestId: installation.attemptId, stage: 'administrator_enrollment', state: 'started', at: now() } });
  try {
    const administrator = await authority.initializeFromClaim({
      enrollment,
      attemptId: installation.attemptId,
      targetIdentity: installation.targetIdentity,
      enrollmentToken: input.enrollmentToken,
      administratorDeviceId: input.administratorDeviceId,
      administratorPublicKey: input.administratorPublicKey,
      administratorProof: input.administratorProof,
    });
    const administratorAccessToken = await authority.issueAccessToken({ administratorId: administrator.administratorId });
    const complete = { ...installation.state, phase: 'administrator-enrolled', administratorId: administrator.administratorId, administratorEnrolledAt: administrator.createdAt, updatedAt: now() };
    await writeFreshInstallState({ statePath: installation.statePath, state: complete });
    await appendFreshInstallJournal({ journalPath, attemptId: installation.attemptId, targetIdentity: installation.targetIdentity, event: { requestId: installation.attemptId, stage: 'administrator_enrollment', state: 'passed', at: now() } });
    return Object.freeze({ state: 'administrator-enrolled', administratorId: administrator.administratorId, administratorAccessToken });
  } catch (error) {
    await appendFreshInstallJournal({ journalPath, attemptId: installation.attemptId, targetIdentity: installation.targetIdentity, event: { requestId: installation.attemptId, stage: 'administrator_enrollment', state: 'failed', at: now(), error: { code: 'administrator_enrollment_failed', recoverable: true } } }).catch(() => {});
    throw error;
  }
}
