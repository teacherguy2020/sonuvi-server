import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendFreshInstallJournal, FRESH_INSTALL_STATE_CONTRACT, writeFreshInstallState } from '../src/lib/sonuvi-fresh-install.mjs';
import { appendBootstrapAttemptEvent, writeBootstrapAttemptProgress } from '../src/lib/sonuvi-bootstrap-progress.mjs';
import { BOOTSTRAP_STATUS_CONTRACT, normalizeBootstrapStatusRequest, readBootstrapStatus } from '../src/lib/sonuvi-bootstrap-status.mjs';

const attemptId = 'boot_0123456789abcdef';
const targetIdentity = 'machine_0123456789abcdef';
const releaseId = `sonuvi-${'a'.repeat(64)}`;

test('root-only status entrypoint remains syntactically executable', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', 'scripts/sonuvi-bootstrap-status.mjs'], { stdio: 'pipe' }));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-bootstrap-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('status is a fixed read-only, reconnect-safe attempt snapshot', async (t) => {
  const root = await fixture(t);
  const installRoot = path.join(root, 'install');
  await writeFreshInstallState({
    statePath: path.join(installRoot, 'state.json'),
    state: { contract: FRESH_INSTALL_STATE_CONTRACT, attemptId, targetIdentity, releaseId, phase: 'awaiting-administrator-enrollment', updatedAt: '2026-11-05T00:00:00.000Z' },
  });
  await appendFreshInstallJournal({ journalPath: path.join(installRoot, 'journal.jsonl'), attemptId, targetIdentity, event: { requestId: attemptId, stage: 'preflight', state: 'passed', at: '2026-11-05T00:00:00.000Z' } });
  await appendFreshInstallJournal({ journalPath: path.join(installRoot, 'journal.jsonl'), attemptId: 'boot_other_0123456789', targetIdentity, event: { requestId: 'boot_other_0123456789', stage: 'preflight', state: 'passed', at: '2026-11-05T00:00:00.000Z' } });
  const result = await readBootstrapStatus({ request: { operation: 'status', attemptId }, stateRoot: root });
  assert.equal(result.contract, BOOTSTRAP_STATUS_CONTRACT);
  assert.equal(result.next, 'administrator_enrollment');
  assert.equal(result.terminal, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].attemptId, attemptId);
});

test('status refuses arbitrary fields and mismatched attempts without mutation', async () => {
  assert.throws(() => normalizeBootstrapStatusRequest({ operation: 'status', attemptId, command: 'id' }), /unsupported/);
  assert.throws(() => normalizeBootstrapStatusRequest({ operation: 'follow', attemptId }), /operation/);
  await assert.rejects(readBootstrapStatus({ request: { operation: 'status', attemptId }, stateRoot: '/tmp/sonuvi-no-attempt' }), /not_found/);
});

test('status resumes an early attempt before the Sonuvi state root exists', async (t) => {
  const root = await fixture(t);
  const bootstrapRoot = path.join(root, 'bootstrap-attempts');
  await writeBootstrapAttemptProgress({ attemptId, targetIdentity, releaseId, phase: 'dependency_setup', root: bootstrapRoot });
  await appendBootstrapAttemptEvent({ attemptId, targetIdentity, root: bootstrapRoot, event: { requestId: attemptId, stage: 'preflight', state: 'passed', at: '2026-11-05T00:00:00.000Z' } });
  const result = await readBootstrapStatus({ request: { operation: 'status', attemptId }, stateRoot: path.join(root, 'not-yet-installed'), bootstrapAttemptRoot: bootstrapRoot });
  assert.equal(result.phase, 'dependency_setup');
  assert.equal(result.next, 'observe');
  assert.equal(result.events[0].stage, 'preflight');
});
