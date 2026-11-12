import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { validateBootstrapHistory } from '../src/lib/sonuvi-bootstrap-history.mjs';
import { gateCBootstrapAdmissionGuardProgram } from '../src/lib/sonuvi-gate-c-bootstrap-replacement-contract.mjs';

const kit = (value) => ({ marker: value.repeat(64), manifest: { releaseId: `sonuvi-${value.repeat(64)}` } });
const old = kit('a');
const next = kit('b');
const third = kit('c');
const record = (id, start, before, after, extra = {}) => ({ operationId: id, targetIdentity: 'target',
  createdAt: `2050-01-01T00:00:0${start}.000Z`, updatedAt: `2050-01-01T00:00:0${start}.500Z`, before, after, ...extra });

test('fixed capsule and admission guard embed the exact same history validator without candidate imports', async () => {
  const capsule = await fs.readFile(new URL('../scripts/sonuvi-sftp-bootstrap-activate-v2.sh', import.meta.url), 'utf8');
  const embedded = capsule.split('// BEGIN FIXED HISTORY VALIDATOR (byte-parity tested with the client guard)\n')[1].split('\n// END FIXED HISTORY VALIDATOR')[0];
  assert.equal(embedded, validateBootstrapHistory.toString());
  assert.ok(gateCBootstrapAdmissionGuardProgram().includes(embedded));
  const program = capsule.split("<<'NODE'\n")[1].replace(/\nNODE\s*$/, '');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: program, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('new capsule journal starts no earlier than its allocated generation after clock rollback or same-tick reuse', async () => {
  const capsule = await fs.readFile(new URL('../scripts/sonuvi-sftp-bootstrap-activate-v2.sh', import.meta.url), 'utf8');
  const source = capsule.slice(capsule.indexOf('function makeJournal('), capsule.indexOf('\nasync function transition('));
  const create = vm.runInNewContext(`${source}; makeJournal`, { CONTRACT: 'test', Date });
  for (const createdAt of [new Date(Date.now() + 1).toISOString(), '2050-01-01T00:00:04.501Z']) {
    const journal = create({}, 'preparing', createdAt);
    assert.ok(Date.parse(journal.updatedAt) >= Date.parse(journal.createdAt));
    assert.equal(journal.createdAt, createdAt);
  }
});

test('retained abort, successive replacements and rollback bind each generation without rewriting evidence', () => {
  const history = [record('abort-A', 1, old, old), record('B', 2, old, next), record('C', 3, next, next), record('D', 4, next, third)];
  const retained = JSON.stringify(history);
  const result = validateBootstrapHistory(history, third);
  assert.equal(result.latest.operationId, 'D');
  assert.equal(JSON.stringify(history), retained);
  assert.equal(result.nextCreatedAt, '2050-01-01T00:00:04.501Z', 'generation allocation survives a clock rollback');
  assert.equal(validateBootstrapHistory(history.slice(0, 3), next).latest.operationId, 'C');
});

test('history rejects substitution, overlapping generations, wrong target, gaps and missing original identities', () => {
  const baseline = [record('A', 1, old, old), record('B', 2, old, next)];
  const mutations = [
    (r) => { r[0].before = undefined; },
    (r) => { r[0].after = third; },
    (r) => { r[1].targetIdentity = 'other'; },
    (r) => { r[1].before = third; },
    (r) => { r[1].before = { ...old, manifest: next.manifest }; },
    (r) => { r[1].createdAt = r[0].updatedAt; },
    (r) => { r[0].updatedAt = r[1].updatedAt; },
    (r) => { r[1].operationId = r[0].operationId; },
    (r) => { r[1].updatedAt = r[0].createdAt; },
  ];
  for (const mutate of mutations) {
    const records = structuredClone(baseline);
    mutate(records);
    assert.throws(() => validateBootstrapHistory(records, next), /replacement_recovery_required/);
  }
  assert.throws(() => validateBootstrapHistory(baseline, old), /replacement_recovery_required/);
});

test('only the requested latest pending generation can be reconciled; admission never accepts it', () => {
  const history = [record('A', 1, old, old), record('B', 2, old, next, { pending: true })];
  assert.throws(() => validateBootstrapHistory(history, next), /replacement_recovery_required/);
  assert.throws(() => validateBootstrapHistory(history, next, 'A'), /replacement_recovery_required/);
  assert.equal(validateBootstrapHistory(history, next, 'B').latest.operationId, 'B');
  assert.throws(() => validateBootstrapHistory([...history, record('C', 3, next, third)], third, 'B'), /replacement_recovery_required/);
});
