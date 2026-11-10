import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GATE_C_BOOTSTRAP_ADMISSION_CONTRACT,
  GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS,
  gateCBootstrapAdmissionGuardProgram,
  gateCBootstrapKitReplacementCommand,
  GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS,
} from '../src/lib/sonuvi-gate-c-bootstrap-replacement-contract.mjs';

const OLD_KIT = 'a'.repeat(64);
const NEW_KIT = 'b'.repeat(64);
const TARGET = `sonuvi-target-v1-${'c'.repeat(64)}`;
const OLD_RELEASE = `sonuvi-${'d'.repeat(64)}`;
const NEW_RELEASE = `sonuvi-${'e'.repeat(64)}`;
const OPERATIONS = Object.freeze(Object.values(GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS));
const uid = process.getuid?.();
const gid = process.getgid?.();
const flockAvailable = spawnSync('/usr/bin/flock', ['--version'], { encoding: 'utf8' }).status === 0;

async function writeKit(root, digest) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const marker = path.join(root, '.sonuvi-bootstrap-kit-v2.sha256');
  await fs.writeFile(marker, `${digest}\n`, { mode: 0o600 });
  await fs.chmod(marker, 0o600);
}

function journal(operationId, state) {
  return {
    contract: 'sonuvi.gate-c-bootstrap-kit-replacement.v1',
    operationId,
    targetIdentity: TARGET,
    expectedServerReleaseId: OLD_RELEASE,
    previousBootstrapKitSHA256: OLD_KIT,
    replacementReleaseId: NEW_RELEASE,
    replacementKitSHA256: NEW_KIT,
    replacementKitBytes: 238_592,
    signedEnvelopeSHA256: 'f'.repeat(64),
    state,
    createdAt: '2026-11-09T12:00:00.000Z',
    updatedAt: '2026-11-09T12:00:00.000Z',
  };
}

async function writeJournal(fixture, operationId, state) {
  await fs.mkdir(fixture.replacements, { recursive: true, mode: 0o700 });
  await fs.chmod(fixture.replacements, 0o700);
  const root = path.join(fixture.replacements, operationId);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  const file = path.join(root, 'journal.json');
  await fs.writeFile(file, `${JSON.stringify(journal(operationId, state))}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return { file, root };
}

async function setJournalTimes(file, createdAt, updatedAt) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  value.createdAt = createdAt;
  value.updatedAt = updatedAt;
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function resetActive(fixture, digest) {
  await fs.rm(fixture.active, { recursive: true, force: true });
  await writeKit(fixture.active, digest);
}

async function loadMarker(fixture) {
  return await fs.readFile(fixture.loadMarker, 'utf8');
}

function runGuard(fixture, operation) {
  return spawnSync('/usr/bin/flock', [
    '-n',
    fixture.lock,
    process.execPath,
    '--input-type=module',
    '--eval',
    fixture.program,
    operation,
  ], {
    encoding: 'utf8',
    env: { ...process.env, SONUVI_ADMISSION_TEST_LOAD_MARKER: fixture.loadMarker },
    maxBuffer: 1024 * 1024,
  });
}

function blockedResponse(result, operation) {
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const line = String(result.stdout || '').trim().split(/\r?\n/).at(-1);
  return JSON.parse(line);
}

async function assertBlockedForEveryOperation(fixture) {
  for (const operation of OPERATIONS) {
    await fs.truncate(fixture.loadMarker, 0);
    assert.deepEqual(blockedResponse(runGuard(fixture, operation), operation), {
      contract: GATE_C_BOOTSTRAP_ADMISSION_CONTRACT,
      operation,
      ok: false,
      code: 'bootstrap_recovery_required',
    });
    assert.equal(await loadMarker(fixture), '', `${operation} loaded the replaceable helper while blocked`);
  }
}

async function assertAdmittedForEveryOperation(fixture) {
  for (const operation of OPERATIONS) {
    await fs.truncate(fixture.loadMarker, 0);
    const result = runGuard(fixture, operation);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await loadMarker(fixture), 'loaded\n', `${operation} did not reach its replaceable helper after reconciliation`);
  }
}

async function createFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-bootstrap-admission-'));
  t.after(async () => fs.rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'bootstrap');
  const active = path.join(root, 'bootstrap-kit-v2');
  const replacements = path.join(root, 'bootstrap-kit-replacements');
  const lock = path.join(root, 'bootstrap-admission.lock');
  const loadMarker = path.join(workspace, 'replaceable-helper-loaded');
  const helper = path.join(workspace, 'replaceable-helper.mjs');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  await writeKit(active, OLD_KIT);
  await fs.writeFile(lock, '', { mode: 0o600 });
  await fs.chmod(lock, 0o600);
  await fs.writeFile(loadMarker, '', { mode: 0o600 });
  await fs.writeFile(helper, [
    "import fs from 'node:fs/promises';",
    "await fs.appendFile(process.env.SONUVI_ADMISSION_TEST_LOAD_MARKER, 'loaded\\n');",
    "process.stdout.write('{\"ok\":true}\\n');",
  ].join('\n'), { mode: 0o600 });
  await fs.chmod(helper, 0o600);
  const helpers = Object.fromEntries(OPERATIONS.map((operation) => [operation, helper]));
  return {
    active,
    helpers,
    loadMarker,
    lock,
    program: gateCBootstrapAdmissionGuardProgram({
      bootstrapRoot: root,
      expectedGID: gid,
      expectedUID: uid,
      helpers,
      nodePath: process.execPath,
    }),
    replacements,
    root,
    workspace,
  };
}

async function writeIndependentServerTransaction(workspace) {
  const checkpoints = path.join(workspace, 'server-release', 'checkpoints');
  await fs.mkdir(checkpoints, { recursive: true, mode: 0o700 });
  const journalPath = path.join(checkpoints, 'release-upgrade-state.json');
  const lockPath = path.join(checkpoints, 'release-activation.lock');
  await fs.writeFile(journalPath, '{"contract":"sonuvi.release-activation.v1","phase":"activating"}\n', { mode: 0o600 });
  await fs.writeFile(lockPath, 'independent Server transaction lock\n', { mode: 0o600 });
  return {
    journalPath,
    journal: await fs.readFile(journalPath),
    lockPath,
    lock: await fs.readFile(lockPath),
  };
}

test('actual locked admission entrypoint blocks every normal helper for replacement and rollback interruptions without mutating journals', {
  skip: !flockAvailable || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid),
}, async (t) => {
  const scenarios = [
    { label: 'during initial journal handoff', active: OLD_KIT, temporaryJournal: true },
    { label: 'before replacement exchange', state: 'prepared', active: OLD_KIT, candidate: NEW_KIT },
    { label: 'after replacement exchange', state: 'prepared', active: NEW_KIT, candidate: OLD_KIT },
    { label: 'while replacement is preparing', state: 'preparing', active: OLD_KIT },
    { label: 'after replacement journal promotion', state: 'promoted', active: NEW_KIT, candidate: OLD_KIT },
    { label: 'before rollback exchange', state: 'rollback_prepared', active: NEW_KIT, previous: OLD_KIT },
    { label: 'after rollback exchange', state: 'rollback_prepared', active: OLD_KIT, previous: NEW_KIT },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const fixture = await createFixture(t);
    const operationId = `bkr_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await resetActive(fixture, scenario.active);
    let journalFile;
    let transaction = null;
    if (scenario.temporaryJournal) {
      await fs.mkdir(fixture.replacements, { mode: 0o700 });
      await fs.chmod(fixture.replacements, 0o700);
      journalFile = path.join(fixture.replacements, `.journal-${operationId}.tmp`);
      await fs.writeFile(journalFile, `${JSON.stringify(journal(operationId, 'preparing'))}\n`, { mode: 0o600 });
      await fs.chmod(journalFile, 0o600);
    } else {
      transaction = await writeJournal(fixture, operationId, scenario.state);
      journalFile = transaction.file;
      if (scenario.candidate) await writeKit(path.join(transaction.root, 'candidate'), scenario.candidate);
      if (scenario.previous) await writeKit(path.join(transaction.root, 'previous'), scenario.previous);
    }
    const journalBefore = await fs.readFile(journalFile);
    const independent = await writeIndependentServerTransaction(fixture.workspace);

    await assertBlockedForEveryOperation(fixture);

    assert.deepEqual(await fs.readFile(journalFile), journalBefore, `${scenario.label} journal was changed by admission`);
    assert.equal((await fs.readFile(path.join(fixture.active, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8')).trim(), scenario.active, `${scenario.label} changed the active kit`);
    assert.deepEqual(await fs.readFile(independent.journalPath), independent.journal, `${scenario.label} touched the Server release journal`);
    assert.deepEqual(await fs.readFile(independent.lockPath), independent.lock, `${scenario.label} touched the Server release lock`);
  }
});

test('malformed or inaccessible bootstrap recovery state fails closed before an actual helper loads', {
  skip: !flockAvailable || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid),
}, async (t) => {
  const malformed = await createFixture(t);
  const malformedId = 'bkr_00000000-0000-4000-8000-000000000101';
  const malformedTransaction = await writeJournal(malformed, malformedId, 'committed');
  await fs.writeFile(malformedTransaction.file, '{not-json\n', { mode: 0o600 });
  await fs.chmod(malformedTransaction.file, 0o600);
  await assertBlockedForEveryOperation(malformed);

  const inaccessible = await createFixture(t);
  await fs.mkdir(inaccessible.replacements, { mode: 0o700 });
  await fs.chmod(inaccessible.replacements, 0o000);
  await assertBlockedForEveryOperation(inaccessible);
  await fs.chmod(inaccessible.replacements, 0o700);
});

test('normal helpers become reachable only after the fixed recovery operation has reconciled to a terminal state', {
  skip: !flockAvailable || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid),
}, async (t) => {
  const reconciled = [
    { state: 'aborted_before_promotion', active: OLD_KIT },
    { state: 'committed', active: NEW_KIT, previous: OLD_KIT },
    { state: 'rolled_back', active: OLD_KIT, previous: NEW_KIT },
  ];
  for (const [index, terminal] of reconciled.entries()) {
    const fixture = await createFixture(t);
    const operationId = `bkr_00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`;
    await resetActive(fixture, terminal.active);
    const transaction = await writeJournal(fixture, operationId, terminal.state);
    if (terminal.previous) await writeKit(path.join(transaction.root, 'previous'), terminal.previous);
    await assertAdmittedForEveryOperation(fixture);
  }

  const historical = await createFixture(t);
  const first = await writeJournal(historical, 'bkr_00000000-0000-4000-8000-000000000401', 'committed');
  await writeKit(path.join(first.root, 'previous'), OLD_KIT);
  await setJournalTimes(first.file, '2026-11-09T12:00:00.000Z', '2026-11-09T12:01:00.000Z');
  const second = await writeJournal(historical, 'bkr_00000000-0000-4000-8000-000000000402', 'rolled_back');
  await writeKit(path.join(second.root, 'previous'), NEW_KIT);
  await setJournalTimes(second.file, '2026-11-09T12:02:00.000Z', '2026-11-09T12:03:00.000Z');
  await resetActive(historical, OLD_KIT);
  await assertAdmittedForEveryOperation(historical);

  await setJournalTimes(second.file, '2026-11-09T12:00:00.000Z', '2026-11-09T12:01:00.000Z');
  await assertBlockedForEveryOperation(historical);

  const fixedRecovery = gateCBootstrapKitReplacementCommand({
    operation: GATE_C_BOOTSTRAP_REPLACEMENT_OPERATIONS.recover,
    operationId: 'bkr_00000000-0000-4000-8000-000000000301',
    targetIdentity: TARGET,
  });
  assert.ok(fixedRecovery.includes('recover_bootstrap_kit_replacement'));
  assert.equal(fixedRecovery.includes('--eval'), false, 'the documented fixed recovery capsule remains independently reachable');
});
