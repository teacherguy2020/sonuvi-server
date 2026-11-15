import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FreshInstallOrchestrator } from '../src/lib/sonuvi-fresh-install-orchestrator.mjs';
import { readFreshInstallJournal } from '../src/lib/sonuvi-fresh-install.mjs';

const attemptId = 'boot_0123456789abcdef'; const targetIdentity = 'machine_0123456789abcdef';
test('orchestration records real ordered stages, persists recovery, and completes only after claim', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-orchestrator-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const stages = ['preflight', 'release_verification', 'checkpoint', 'configuration', 'activation', 'health_verification', 'administrator_enrollment']; const calls = []; const actions = Object.fromEntries(stages.map((stage) => [stage, async () => calls.push(stage)])); const flow = new FreshInstallOrchestrator({ stateRoot: root, attemptId, targetIdentity, actions });
  assert.equal((await flow.run()).state, 'awaiting-administrator-enrollment'); assert.deepEqual(calls, stages); await flow.completeAdministratorClaim({ claim: async () => calls.push('claim') }); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'install', 'state.json'), 'utf8')).phase, 'complete'); assert.equal((await readFreshInstallJournal({ journalPath: path.join(root, 'install', 'journal.jsonl') })).at(-1).stage, 'complete');
});
