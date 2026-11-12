import { appendFreshInstallJournal, FRESH_INSTALL_STATE_CONTRACT, writeFreshInstallState } from './sonuvi-fresh-install.mjs';

const ORDER = Object.freeze(['preflight', 'release_verification', 'checkpoint', 'configuration', 'activation', 'health_verification', 'administrator_enrollment', 'pairing_ready', 'complete']);
function required(value, label) { const result = String(value ?? '').trim(); if (!result) throw new Error(`${label} is required`); return result; }

/** Coordinates only injected fixed operations; it never executes a shell itself. */
export class FreshInstallOrchestrator {
  constructor({ stateRoot, targetIdentity, attemptId, now = () => new Date().toISOString(), actions } = {}) { this.stateRoot = required(stateRoot, 'state root'); this.targetIdentity = required(targetIdentity, 'target identity'); this.attemptId = required(attemptId, 'attempt ID'); this.now = now; this.actions = actions || {}; this.journalPath = `${this.stateRoot}/install/journal.jsonl`; this.statePath = `${this.stateRoot}/install/state.json`; }
  async event(stage, state, error = null) { return appendFreshInstallJournal({ journalPath: this.journalPath, attemptId: this.attemptId, targetIdentity: this.targetIdentity, event: { requestId: this.attemptId, stage, state, at: this.now(), ...(error ? { error } : {}) } }); }
  async persist(phase, extra = {}) { return writeFreshInstallState({ statePath: this.statePath, state: { contract: FRESH_INSTALL_STATE_CONTRACT, attemptId: this.attemptId, targetIdentity: this.targetIdentity, phase, updatedAt: this.now(), ...extra } }); }
  async run() {
    for (const stage of ORDER.slice(0, 7)) {
      await this.event(stage, 'started'); await this.persist(stage);
      try { const action = this.actions[stage]; if (typeof action !== 'function') throw new Error('operation_not_installed'); await action({ attemptId: this.attemptId, targetIdentity: this.targetIdentity }); await this.event(stage, 'passed'); } catch (error) { await this.event(stage, 'failed', { code: 'operation_failed', recoverable: true }); await this.persist('recoverable-incomplete', { failedStage: stage }); throw error; }
    }
    await this.persist('awaiting-administrator-enrollment');
    return Object.freeze({ state: 'awaiting-administrator-enrollment', next: 'administrator_claim' });
  }
  async completeAdministratorClaim({ claim } = {}) { if (typeof claim !== 'function') throw new Error('administrator claim action is required'); await this.event('administrator_enrollment', 'started'); await claim({ attemptId: this.attemptId, targetIdentity: this.targetIdentity }); await this.event('administrator_enrollment', 'passed'); await this.event('pairing_ready', 'passed'); await this.event('complete', 'passed'); await this.persist('complete'); return Object.freeze({ state: 'complete' }); }
}
