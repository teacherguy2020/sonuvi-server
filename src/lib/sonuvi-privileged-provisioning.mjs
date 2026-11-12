import fs from 'node:fs/promises';
import path from 'node:path';

import { BOOTSTRAP_SERVICE_UNITS } from './sonuvi-bootstrap-security.mjs';
import { provisionFreshSystemdUnits } from './sonuvi-fresh-install.mjs';

const ALLOWED_OPERATIONS = Object.freeze(['write_units', 'daemon_reload', 'enable_start', 'verify_health', 'cleanup_attempt']);
function text(value) { return String(value ?? '').trim(); }
function id(value, label) { const result = text(value); if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error(`${label} is invalid`); return result; }
function fixedResult(operation, state, code = null) { return Object.freeze({ operation, state, code }); }

/**
 * A fixed host adapter. It deliberately accepts no executable, service name,
 * filesystem path, or shell fragment from the bootstrap client.
 */
export class PrivilegedProvisioningAdapter {
  constructor({ targetIdentity, attemptId, unitRoot, ownedRoot, systemd } = {}) {
    this.targetIdentity = id(targetIdentity, 'target identity'); this.attemptId = id(attemptId, 'attempt ID');
    this.unitRoot = path.resolve(String(unitRoot || '')); this.ownedRoot = path.resolve(String(ownedRoot || ''));
    if (!path.isAbsolute(this.unitRoot) || !path.isAbsolute(this.ownedRoot)) throw new Error('provisioning roots must be absolute');
    if (!systemd || typeof systemd !== 'object') throw new Error('constrained systemd adapter is required'); this.systemd = systemd;
  }
  assertContext({ targetIdentity, attemptId }) { if (id(targetIdentity, 'target identity') !== this.targetIdentity || id(attemptId, 'attempt ID') !== this.attemptId) throw new Error('bootstrap_target_or_attempt_mismatch'); }
  async execute({ operation, targetIdentity, attemptId, units = null } = {}) {
    this.assertContext({ targetIdentity, attemptId }); const requested = text(operation); if (!ALLOWED_OPERATIONS.includes(requested)) throw new Error('privileged_operation_rejected');
    if (requested === 'write_units') { const result = await provisionFreshSystemdUnits({ unitRoot: this.unitRoot, units }); return fixedResult(requested, 'passed', result.some((entry) => entry.changed) ? 'units_written' : 'units_unchanged'); }
    if (requested === 'daemon_reload') { await this.systemd.daemonReload(); return fixedResult(requested, 'passed'); }
    if (requested === 'enable_start') { for (const unit of BOOTSTRAP_SERVICE_UNITS) await this.systemd.enableAndStart(unit); return fixedResult(requested, 'passed'); }
    if (requested === 'verify_health') { for (const unit of BOOTSTRAP_SERVICE_UNITS) if (await this.systemd.isHealthy(unit) !== true) throw new Error('service_health_failed'); return fixedResult(requested, 'passed'); }
    const marker = path.join(this.ownedRoot, `.sonuvi-bootstrap-${this.attemptId}`);
    const owned = await fs.readFile(marker, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (owned !== this.attemptId) throw new Error('cleanup_ownership_unproven');
    await fs.rm(this.ownedRoot, { recursive: true, force: true }); return fixedResult(requested, 'passed', 'attempt_cleanup_complete');
  }
}

export async function markAttemptOwnedRoot({ ownedRoot, attemptId } = {}) {
  const root = path.resolve(String(ownedRoot || '')); const attempt = id(attemptId, 'attempt ID');
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(root, `.sonuvi-bootstrap-${attempt}`), attempt, { mode: 0o600 });
}
