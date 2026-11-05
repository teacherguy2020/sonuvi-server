import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFreshInstallJournal,
  classifyFreshInstallHost,
  FreshInstallClassification,
  freshRuntimeConfig,
  initializeFreshHostLayout,
  provisionFreshSystemdUnits,
  readFreshInstallJournal,
  renderFreshSystemdUnits,
} from '../src/lib/sonuvi-fresh-install.mjs';
import { activateFirstRelease } from '../src/lib/sonuvi-first-release.mjs';

const releaseId = `sonuvi-${'a'.repeat(64)}`;
const attemptId = 'boot_0123456789abcdef';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-fresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, layoutRoot: path.join(root, 'opt', 'sonuvi'), stateRoot: path.join(root, 'var', 'lib', 'sonuvi') };
}

const hostFacts = { platform: 'linux', architecture: 'arm64', hasSystemd: true, uid: 0, availableBytes: 4 * 1024 * 1024 * 1024 };

test('fresh host classification never treats partial state as empty', async (t) => {
  const f = await fixture(t);
  assert.equal((await classifyFreshInstallHost({ ...f, ...hostFacts })).classification, FreshInstallClassification.FRESH_ELIGIBLE);
  await fs.mkdir(f.layoutRoot, { recursive: true });
  assert.equal((await classifyFreshInstallHost({ ...f, ...hostFacts })).classification, FreshInstallClassification.INCOMPLETE_INSTALLATION);
  await fs.rm(f.layoutRoot, { recursive: true });
  assert.equal((await classifyFreshInstallHost({ ...f, ...hostFacts, platform: 'darwin' })).classification, FreshInstallClassification.UNSUPPORTED_HOST);
  assert.equal((await classifyFreshInstallHost({ ...f, ...hostFacts, conflictingPorts: [3101] })).classification, FreshInstallClassification.CONFLICTING_INSTALLATION);
});

test('initial layout has a non-production, secret-free configuration and safe modes', async (t) => {
  const f = await fixture(t);
  const initialized = await initializeFreshHostLayout({ ...f, serverIdentity: 'sonuvi-ios-setup-01' });
  const config = JSON.parse(await fs.readFile(initialized.configPath, 'utf8'));
  assert.equal(config.nodes[0].ip, '127.0.0.1');
  assert.equal(config.paths.musicLibraryRoot, '/var/lib/sonuvi/empty-library');
  assert.equal(config.alexa.enabled, false);
  assert.equal((await fs.stat(initialized.configPath)).mode & 0o777, 0o600);
  assert.throws(() => freshRuntimeConfig({ serverIdentity: 'bad identity!' }), /identity/);
  await assert.rejects(initializeFreshHostLayout({ ...f, serverIdentity: 'sonuvi-ios-setup-01' }), /incomplete_installation/);
});

test('journal is durable, ordered, and does not retain sensitive named values', async (t) => {
  const f = await fixture(t);
  const journalPath = path.join(f.stateRoot, 'install', 'journal.jsonl');
  await appendFreshInstallJournal({ journalPath, attemptId, targetIdentity: 'machine-1', event: { requestId: attemptId, stage: 'preflight', state: 'started' } });
  await appendFreshInstallJournal({ journalPath, attemptId, targetIdentity: 'machine-1', event: { requestId: attemptId, stage: 'preflight', state: 'passed' } });
  const entries = await readFreshInstallJournal({ journalPath });
  assert.deepEqual(entries.map((entry) => entry.state), ['started', 'passed']);
  assert.equal(entries[0].contract, 'sonuvi.fresh-install-journal.v1');
});

test('systemd rendering is deterministic and rejects template injection', () => {
  const units = renderFreshSystemdUnits({ apiTemplate: 'User=@SERVICE_ACCOUNT@\nRelease=@RELEASE_ID@\n', webTemplate: 'Mount=@MUSIC_LIBRARY_ROOT@\n', releaseId });
  assert.match(units['sonuvi-api.service'], /User=sonuvi/);
  assert.throws(() => renderFreshSystemdUnits({ apiTemplate: '', webTemplate: '', releaseId, serviceAccount: 'x\nExecStart=bad' }), /unsafe/);
});

test('only approved, identical systemd units are provisioned idempotently', async (t) => {
  const f = await fixture(t);
  const units = renderFreshSystemdUnits({ apiTemplate: 'api=@RELEASE_ID@', webTemplate: 'web=@RELEASE_ID@', releaseId });
  const first = await provisionFreshSystemdUnits({ unitRoot: path.join(f.root, 'units'), units });
  const second = await provisionFreshSystemdUnits({ unitRoot: path.join(f.root, 'units'), units });
  assert.deepEqual(first.map((entry) => entry.changed), [true, true]);
  assert.deepEqual(second.map((entry) => entry.changed), [false, false]);
  await assert.rejects(provisionFreshSystemdUnits({ unitRoot: path.join(f.root, 'units'), units: { ...units, 'other.service': 'no' } }), /only approved/);
});

function adapter({ fail = false, onRestart = null } = {}) {
  return {
    async prepare() {}, async restart(context) { if (onRestart) await onRestart(context); },
    async verify({ expectedReleaseId }) { return { releaseId: expectedReleaseId }; },
    async health() { return fail ? { ok: false } : { ok: true }; },
    async rollback() {},
  };
}

test('first release activates without inventing a rollback release and failure leaves no current pointer', async (t) => {
  const f = await fixture(t);
  await initializeFreshHostLayout({ ...f, serverIdentity: 'sonuvi-ios-setup-01' });
  const candidate = path.join(f.layoutRoot, 'releases', releaseId);
  await fs.mkdir(candidate, { recursive: true });
  const verifyArtifact = async ({ artifactRoot }) => ({ releaseId, root: artifactRoot });
  let checkpointAtRestart;
  const success = await activateFirstRelease({ ...f, releaseId, attemptId, targetIdentity: 'machine-1', adapter: adapter({ onRestart: async () => { checkpointAtRestart = JSON.parse(await fs.readFile(path.join(f.stateRoot, 'checkpoints', 'release-activation-state.json'), 'utf8')); } }), verifyArtifact });
  assert.equal(success.state.previousReleaseId, null);
  assert.equal(path.basename(await fs.realpath(path.join(f.layoutRoot, 'current'))), releaseId);
  assert.equal(checkpointAtRestart.phase, 'pointer-switched');
  assert.equal(checkpointAtRestart.candidateReleaseId, releaseId);
  const committedCheckpoint = JSON.parse(await fs.readFile(path.join(f.stateRoot, 'checkpoints', 'release-activation-state.json'), 'utf8'));
  assert.equal(committedCheckpoint.phase, 'committed');
  assert.equal(committedCheckpoint.previousReleaseId, null);
  await fs.unlink(path.join(f.layoutRoot, 'current'));
  await assert.rejects(activateFirstRelease({ ...f, releaseId, attemptId, targetIdentity: 'machine-1', adapter: adapter({ fail: true }), verifyArtifact }), /health check failed/);
  await assert.rejects(fs.lstat(path.join(f.layoutRoot, 'current')), { code: 'ENOENT' });
  assert.equal(await fs.stat(candidate).then(() => true), true);
});
