import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
  H4C4A_DEFAULT_PORTS,
  H4C4A_REHEARSAL_PLAN_CONTRACT,
  H4C4A_RUNTIME_CONTRACT_PARITY,
  createSyntheticRehearsalState,
  inspectSyntheticRehearsalState,
  prepareH4c4aRehearsal,
  removeSyntheticRehearsalState,
  assertContainerIsolationPlan,
} from '../scripts/lib/h4c4a-rehearsal.mjs';
import { createRuntimeCapabilities } from '../src/lib/runtime-capabilities.mjs';

const RELEASE_ID = `sonuvi-${'a'.repeat(64)}`;

async function temporaryRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sonuvi-h4c4a-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function verifiedManifest(overrides = {}) {
  const source = { dirty: false, snapshotStatus: 'clean-git-worktree-snapshot', ...overrides.source };
  const target = { os: 'linux', architecture: 'arm64', nodeVersion: 'v20.19.5', ...overrides.target };
  return {
    contract: 'sonuvi.release-manifest.v1',
    releaseId: RELEASE_ID,
    source,
    target,
    ...overrides,
  };
}

function runtimeContractParity() {
  return {
    contract: H4C4A_RUNTIME_CONTRACT_PARITY,
    modules: [
      'src/lib/browse-index.mjs',
      'src/lib/release-artifact.mjs',
      'src/lib/release-runtime-preflight.mjs',
      'src/lib/runtime-capabilities.mjs',
      'src/lib/runtime-config-security.mjs',
      'src/lib/runtime-state-paths.mjs',
    ].map((relativePath) => ({ relativePath, sha256: 'a'.repeat(64) })),
  };
}

async function syntheticState(t, options = {}) {
  const parent = await temporaryRoot(t, 'state-parent');
  return createSyntheticRehearsalState({
    stateRoot: path.join(parent, 'sonuvi-h4c4a-synthetic-state'),
    fixtureId: 'sonuvi-h4c4a-fixture-12345678',
    createdAt: '2026-10-25T00:00:00.000Z',
    ...options,
  });
}

async function rehearsalPlan(t, options = {}) {
  const state = options.state || await syntheticState(t, options);
  const releaseRoot = await temporaryRoot(t, 'release');
  const manifest = options.manifest || verifiedManifest();
  const plan = await prepareH4c4aRehearsal({
    releaseRoot,
    stateRoot: state.stateRoot,
    expectedReleaseId: manifest.releaseId,
    apiPort: options.apiPort || H4C4A_DEFAULT_PORTS.api,
    webPort: options.webPort || H4C4A_DEFAULT_PORTS.web,
    verifyArtifact: async ({ artifactRoot }) => ({ root: artifactRoot, releaseId: manifest.releaseId, manifest }),
    verifyRuntimeContractParity: async () => runtimeContractParity(),
    loadRuntimeCapabilities: async () => createRuntimeCapabilities,
    ...options.prepare,
  });
  return { plan, state, releaseRoot };
}

test('H4C.4A creates a closed synthetic state tree with v2 catalog and non-secret configuration', async (t) => {
  const state = await syntheticState(t);
  const inspected = await inspectSyntheticRehearsalState({ stateRoot: state.stateRoot });
  assert.equal(inspected.fixtureId, 'sonuvi-h4c4a-fixture-12345678');
  assert.equal(inspected.ports.api, H4C4A_DEFAULT_PORTS.api);
  assert.equal(inspected.files.includes('data/library-browse-index.json'), true);
  assert.equal(inspected.files.includes('data/source-audio-cache.json'), true);
  assert.equal(inspected.files.includes('data/jukebox-entries.json'), true);

  const config = JSON.parse(await fs.readFile(path.join(state.stateRoot, 'config', 'now-playing.config.json'), 'utf8'));
  assert.equal(config.alexa.enabled, false);
  assert.equal(config.notifications.trackNotify.enabled, false);
  assert.equal(config.nodes[0].ip, '127.0.0.1');
  const sourceAudio = JSON.parse(await fs.readFile(path.join(state.stateRoot, 'data', 'source-audio-cache.json'), 'utf8'));
  assert.equal(sourceAudio.version, 1);
  assert.equal(Object.keys(sourceAudio.files).every((entry) => entry.startsWith('Synthetic/')), true);
});

test('H4C.4A rejects unexpected state entries and only cleans an exact marked fixture', async (t) => {
  const state = await syntheticState(t);
  const unexpected = path.join(state.stateRoot, 'data', 'unexpected.json');
  await fs.writeFile(unexpected, '{"value":true}\n', { mode: 0o600 });
  await assert.rejects(
    inspectSyntheticRehearsalState({ stateRoot: state.stateRoot }),
    /file inventory is unexpected/,
  );
  await assert.rejects(
    removeSyntheticRehearsalState({ stateRoot: state.stateRoot, fixtureId: 'sonuvi-h4c4a-wrong-12345678' }),
    /exact fixture ID/,
  );
  const removed = await removeSyntheticRehearsalState({ stateRoot: state.stateRoot, fixtureId: state.fixtureId });
  assert.equal(removed.fixtureId, state.fixtureId);
  await assert.rejects(fs.access(state.stateRoot));
});

test('H4C.4A produces a no-start internal-only plan from a clean verified release', async (t) => {
  const { plan } = await rehearsalPlan(t);
  assert.equal(plan.contract, H4C4A_REHEARSAL_PLAN_CONTRACT);
  assert.equal(plan.action, 'preflight-only');
  assert.equal(plan.startAuthorized, false);
  assert.equal(plan.platform, 'linux/arm64');
  assert.equal(plan.network.internal, true);
  assert.deepEqual(plan.network.publishedPorts, []);
  assert.equal(plan.containers.length, 2);
  assert.equal(plan.containers.every((container) => container.readOnlyRootFilesystem && !container.privileged && !container.dockerSocket), true);
  assert.equal(plan.containers.every((container) => container.mounts.length === 2), true);
  assert.equal(plan.containers.find((container) => container.name === 'api').environment.PORT, '31901');
  assert.equal(plan.containers.find((container) => container.name === 'web').environment.SONUVI_WEB_PORT, '31902');
  assert.equal(plan.containers.find((container) => container.name === 'api').mounts.find((mount) => mount.target === '/var/lib/sonuvi-rehearsal').readOnly, false);
  assert.equal(plan.containers.find((container) => container.name === 'web').mounts.find((mount) => mount.target === '/var/lib/sonuvi-rehearsal').readOnly, true);
  assert.doesNotThrow(() => assertContainerIsolationPlan(plan));

  const capabilities = createRuntimeCapabilities({ env: plan.containers[0].environment });
  assert.equal(capabilities.rehearsal, true);
  assert.throws(() => capabilities.assertExternalMutation('test.integration'), /disabled in Sonuvi rehearsal mode/);
  assert.throws(() => capabilities.assertExternalRead('test.integration'), /disabled in Sonuvi rehearsal mode/);
});

test('H4C.4A rejects a dirty or wrong-target artifact before a plan exists', async (t) => {
  const state = await syntheticState(t);
  const releaseRoot = await temporaryRoot(t, 'release-invalid');
  const dirty = verifiedManifest({ source: { dirty: true } });
  await assert.rejects(
    prepareH4c4aRehearsal({
      releaseRoot,
      stateRoot: state.stateRoot,
      expectedReleaseId: dirty.releaseId,
      verifyArtifact: async ({ artifactRoot }) => ({ root: artifactRoot, releaseId: dirty.releaseId, manifest: dirty }),
    }),
    /clean Git-provenance release artifact/,
  );
  const wrongArchitecture = verifiedManifest({ target: { architecture: 'amd64' } });
  await assert.rejects(
    prepareH4c4aRehearsal({
      releaseRoot,
      stateRoot: state.stateRoot,
      expectedReleaseId: wrongArchitecture.releaseId,
      verifyArtifact: async ({ artifactRoot }) => ({ root: artifactRoot, releaseId: wrongArchitecture.releaseId, manifest: wrongArchitecture }),
    }),
    /linux\/arm64 release artifact/,
  );
});

test('H4C.4A rejects egress, Docker socket, host mounting, or port-collision regressions in a plan', async (t) => {
  const { plan } = await rehearsalPlan(t);
  const egress = structuredClone(plan);
  egress.network.allowExternalEgress = true;
  assert.throws(() => assertContainerIsolationPlan(egress), /network isolation/);

  const socket = structuredClone(plan);
  socket.containers[0].dockerSocket = true;
  assert.throws(() => assertContainerIsolationPlan(socket), /sandbox settings/);

  const hostMount = structuredClone(plan);
  hostMount.containers[0].mounts.push({ type: 'bind', source: '/Users/fixture-operator', target: '/host-home', readOnly: true });
  assert.throws(() => assertContainerIsolationPlan(hostMount), /mount inventory|prohibited production or home path/);

  const collision = structuredClone(plan);
  collision.ports.web = collision.ports.api;
  assert.throws(() => assertContainerIsolationPlan(collision), /must be distinct/);

  const externalRead = structuredClone(plan);
  externalRead.containers[0].environment.SONUVI_REHEARSAL_ALLOW_EXTERNAL_READ = '1';
  assert.throws(() => assertContainerIsolationPlan(externalRead), /must not allow external reads/);

  const injectedEnvironment = structuredClone(plan);
  injectedEnvironment.containers[0].environment.UNRELATED_SECRET = 'must-not-pass';
  assert.throws(() => assertContainerIsolationPlan(injectedEnvironment), /unexpected variable/);

  const inheritedEnvironment = structuredClone(plan);
  inheritedEnvironment.containers[0].environmentMode = 'merge';
  assert.throws(() => assertContainerIsolationPlan(inheritedEnvironment), /internal bridge/);
});

test('H4C.4A refuses a verifier that does not confirm the exact release root', async (t) => {
  const state = await syntheticState(t);
  const releaseRoot = await temporaryRoot(t, 'release-mismatch');
  const otherRoot = await temporaryRoot(t, 'other-release');
  const manifest = verifiedManifest();
  await assert.rejects(
    prepareH4c4aRehearsal({
      releaseRoot,
      stateRoot: state.stateRoot,
      expectedReleaseId: manifest.releaseId,
      verifyArtifact: async () => ({ root: otherRoot, releaseId: manifest.releaseId, manifest }),
    }),
    /explicit release root/,
  );
});

test('H4C.4A pins the artifact identity and requires a verified artifact capability gate', async (t) => {
  const state = await syntheticState(t);
  const releaseRoot = await temporaryRoot(t, 'release-pinned');
  const manifest = verifiedManifest();
  const common = {
    releaseRoot,
    stateRoot: state.stateRoot,
    verifyArtifact: async ({ artifactRoot }) => ({ root: artifactRoot, releaseId: manifest.releaseId, manifest }),
    verifyRuntimeContractParity: async () => runtimeContractParity(),
  };
  await assert.rejects(
    prepareH4c4aRehearsal({
      ...common,
      expectedReleaseId: `sonuvi-${'b'.repeat(64)}`,
      loadRuntimeCapabilities: async () => createRuntimeCapabilities,
    }),
    /does not match the explicit rehearsal release identity/,
  );
  await assert.rejects(
    prepareH4c4aRehearsal({
      ...common,
      expectedReleaseId: manifest.releaseId,
      loadRuntimeCapabilities: async () => () => ({ rehearsal: false }),
    }),
    /did not activate the capability gate/,
  );
});
