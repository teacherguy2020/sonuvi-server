import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';

import {
  H4C4_ARTIFACT_BROWSE_ISOLATION_CONTRACT,
  assertArtifactBrowseIsolationEvidence,
  createArtifactBrowseIsolationDockerArgs,
  runArtifactBrowseIsolationProbe,
} from '../scripts/lib/h4c4-artifact-browse-isolation.mjs';
import { createSyntheticRehearsalState, removeSyntheticRehearsalState } from '../scripts/lib/h4c4a-rehearsal.mjs';
import { H4C4B_EXECUTION_CONTRACT, oneShotAuthorizationForRelease } from '../scripts/lib/h4c4b-execution-adapter.mjs';
import {
  H4C4_RELEASE_ACCEPTANCE_RECORD_CONTRACT,
  assertReleaseAcceptanceRecord,
  cleanupReleaseAcceptance,
  createReleaseAcceptancePreflight,
  executeReleaseAcceptance,
  readReleaseAcceptanceRecord,
  writeReleaseAcceptanceRecord,
} from '../scripts/lib/h4c4-release-acceptance.mjs';

const RELEASE_ID = `sonuvi-${'a'.repeat(64)}`;
const SOURCE_COMMIT = 'b'.repeat(40);
const SOURCE_TREE = 'c'.repeat(40);
const DEPENDENCY_HASH = 'd'.repeat(64);

async function temporaryRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sonuvi-${label}-`));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function manifest() {
  return {
    releaseId: RELEASE_ID,
    source: {
      dirty: false,
      snapshotStatus: 'clean-git-worktree-snapshot',
      gitHead: SOURCE_COMMIT,
      gitTree: SOURCE_TREE,
    },
    target: { os: 'linux', architecture: 'arm64', nodeVersion: 'v20.19.5', npmVersion: '10.8.2' },
    files: [{ path: 'moode-nowplaying-api.mjs', type: 'file', bytes: 1, sha256: 'e'.repeat(64) }],
    publicAssets: { inventory: [{ path: 'release.json', type: 'file', bytes: 1, sha256: 'f'.repeat(64) }] },
    dependencies: { dependencyFilesHash: DEPENDENCY_HASH },
  };
}

async function releaseFixture(t) {
  const root = await temporaryRoot(t, 'acceptance-release');
  const value = manifest();
  await fs.writeFile(path.join(root, 'release-manifest.json'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const verifyArtifact = async ({ artifactRoot }) => ({ root: artifactRoot, releaseId: RELEASE_ID, manifest: value });
  return { root, value, verifyArtifact };
}

function browseEvidence(manifestSha256 = '1'.repeat(64)) {
  return {
    contract: H4C4_ARTIFACT_BROWSE_ISOLATION_CONTRACT,
    releaseId: RELEASE_ID,
    releaseManifestSha256: manifestSha256,
    fixtureId: 'sonuvi-h4c4-fixture-12345678',
    network: { mode: 'none', externalEgress: false, externalDns: false },
    releaseReadOnly: true,
    validFixture: { accepted: true },
    missingFixture: { failsClosed: true },
    forceRefresh: { denied: true },
    rebuild: { denied: true },
    mpcInvocations: 0,
    mpdNetworkAttempts: 0,
    catalogWrites: 0,
    stateUnchanged: true,
  };
}

function rehearsalPlan({ releaseRoot, stateRoot }) {
  return {
    contract: 'sonuvi.h4c4a.rehearsal-plan.v1',
    action: 'preflight-only',
    startAuthorized: false,
    releaseId: RELEASE_ID,
    expectedReleaseId: RELEASE_ID,
    releaseRoot,
    stateRoot,
    fixtureId: 'sonuvi-h4c4-fixture-12345678',
    ports: { api: 31901, web: 31902 },
  };
}

test('artifact browse-isolation evidence rejects side effects and Docker config stays non-candidate', () => {
  const evidence = browseEvidence();
  assert.equal(assertArtifactBrowseIsolationEvidence(evidence, { expectedReleaseId: RELEASE_ID }).mpcInvocations, 0);
  const invokedMpc = structuredClone(evidence);
  invokedMpc.mpcInvocations = 1;
  assert.throws(
    () => assertArtifactBrowseIsolationEvidence(invokedMpc, { expectedReleaseId: RELEASE_ID }),
    /external or catalog side effect/,
  );
  const args = createArtifactBrowseIsolationDockerArgs({
    releaseRoot: '/private/tmp/h4c4-release',
    stateRoot: '/private/tmp/h4c4-state',
    probeRoot: '/private/tmp/h4c4-probe',
    releaseId: RELEASE_ID,
  });
  assert.equal(args.includes('--network'), true);
  assert.equal(args.includes('none'), true);
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.some((entry) => /--publish|moode-nowplaying-api|serve-public-web/.test(entry)), false);
  assert.equal(args.some((entry) => /docker\.sock/.test(entry)), false);
});

test('artifact browse-isolation probe writes exclusive evidence and removes only its generated probe root', async (t) => {
  const release = await releaseFixture(t);
  const parent = await temporaryRoot(t, 'artifact-probe-parent');
  const stateRoot = path.join(parent, 'fixture');
  const fixture = await createSyntheticRehearsalState({
    stateRoot,
    fixtureId: 'sonuvi-h4c4-fixture-12345678',
    apiPort: 32001,
    webPort: 32002,
  });
  t.after(async () => {
    await fs.access(stateRoot).then(
      () => removeSyntheticRehearsalState({ stateRoot, fixtureId: fixture.fixtureId }),
      () => undefined,
    );
  });
  const evidencePath = path.join(parent, 'artifact-browse-evidence.json');
  const runDocker = async (args) => {
    assert.equal(args.includes('--network'), true);
    assert.equal(args.includes('none'), true);
    assert.equal(args.some((entry) => /moode-nowplaying-api|serve-public-web/.test(entry)), false);
    const probeMount = args.find((entry) => entry.includes(',dst=/probe'));
    const probeRoot = probeMount.match(/src=([^,]+)/)[1];
    await fs.writeFile(path.join(probeRoot, 'result.json'), `${JSON.stringify({
      validFixtureAccepted: true,
      missingFixtureFailsClosed: true,
      forceRefreshDenied: true,
      rebuildDenied: true,
    })}\n`, { mode: 0o600 });
    return { stdout: '', stderr: '' };
  };
  const result = await runArtifactBrowseIsolationProbe({
    releaseRoot: release.root,
    stateRoot,
    expectedReleaseId: RELEASE_ID,
    scratchParent: parent,
    evidencePath,
    apiPort: 32001,
    webPort: 32002,
    verifyArtifact: release.verifyArtifact,
    runDocker,
    randomUUID: () => 'probe-12345678',
    now: () => '2026-10-25T12:00:00.000Z',
  });
  assert.equal(result.mpcInvocations, 0);
  assert.equal(result.catalogWrites, 0);
  assert.equal((await fs.stat(evidencePath)).mode & 0o077, 0);
  assert.equal(await fs.access(path.join(parent, 'sonuvi-h4c4-artifact-browse-probe-12345678')).then(() => true, () => false), false);
});

test('acceptance preflight remains non-executable, persists privately, and revalidates before an injected execution adapter', async (t) => {
  const release = await releaseFixture(t);
  const recordParent = await temporaryRoot(t, 'acceptance-record');
  const stateRoot = path.join(recordParent, 'synthetic-state');
  await fs.mkdir(stateRoot, { mode: 0o700 });
  const manifestSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(release.root, 'release-manifest.json'))).digest('hex');
  const prepareRehearsal = async ({ releaseRoot, stateRoot: requestedStateRoot }) => rehearsalPlan({ releaseRoot, stateRoot: requestedStateRoot });
  const record = await createReleaseAcceptancePreflight({
    releaseRoot: release.root,
    stateRoot,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedSourceTree: SOURCE_TREE,
    artifactBrowseIsolation: browseEvidence(manifestSha256),
    runId: 'acceptance-run-12345678',
    verifyArtifact: release.verifyArtifact,
    prepareRehearsal,
    now: () => '2026-10-25T12:00:00.000Z',
  });
  assert.equal(record.contract, H4C4_RELEASE_ACCEPTANCE_RECORD_CONTRACT);
  assert.equal(record.executionAuthorized, false);
  assert.equal(record.action, 'preflight-only');
  assert.equal(assertReleaseAcceptanceRecord(record).recordSha256, record.recordSha256);

  const recordPath = path.join(recordParent, 'acceptance-record.json');
  await writeReleaseAcceptanceRecord({ recordPath, record });
  const loaded = await readReleaseAcceptanceRecord({ recordPath });
  assert.equal(loaded.recordSha256, record.recordSha256);
  assert.equal((await fs.stat(recordPath)).mode & 0o077, 0);

  await assert.rejects(
    executeReleaseAcceptance({
      record: loaded,
      authorization: 'not-authorized',
      runId: 'execute-run-12345678',
      evidencePath: path.join(recordParent, 'execution-evidence.json'),
      verifyArtifact: release.verifyArtifact,
      prepareRehearsal,
    }),
    /one-shot authorization/,
  );

  let executed = false;
  const result = await executeReleaseAcceptance({
    record: loaded,
    authorization: oneShotAuthorizationForRelease(RELEASE_ID),
    runId: 'execute-run-12345678',
    evidencePath: path.join(recordParent, 'execution-evidence.json'),
    verifyArtifact: release.verifyArtifact,
    prepareRehearsal,
    createExecutionPlan: () => ({ contract: H4C4B_EXECUTION_CONTRACT }),
    executeRehearsal: async ({ execution, authorization, evidencePath }) => {
      executed = true;
      assert.equal(execution.contract, H4C4B_EXECUTION_CONTRACT);
      assert.equal(authorization, oneShotAuthorizationForRelease(RELEASE_ID));
      return { status: 'passed', evidencePath };
    },
  });
  assert.equal(executed, true);
  assert.equal(result.status, 'passed');

  let cleanup = null;
  await cleanupReleaseAcceptance({
    record: loaded,
    removeSyntheticState: async (value) => {
      cleanup = value;
      return { removed: value.stateRoot, fixtureId: value.fixtureId };
    },
  });
  assert.deepEqual(cleanup, { stateRoot, fixtureId: 'sonuvi-h4c4-fixture-12345678' });
});
