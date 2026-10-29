import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './atomic-file.mjs';
import {
  createDisposableReleaseLayout,
  validateSharedRuntimeLayout,
  verifyReleaseArtifact,
} from './release-artifact.mjs';

export const ACTIVATION_STATE_CONTRACT = 'sonuvi.release-activation.v1';
export const TRAFFIC_GATE_CONTRACT = 'sonuvi.release-traffic-gate.v1';

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function releaseIdText(value) {
  const releaseId = String(value || '').trim();
  if (!/^sonuvi-[a-f0-9]{64}$/.test(releaseId)) throw new Error('release ID is invalid');
  return releaseId;
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function statePaths(layout) {
  const checkpoint = path.join(layout.shared, 'checkpoints');
  return {
    lock: path.join(checkpoint, 'release-activation.lock'),
    state: path.join(checkpoint, 'release-activation-state.json'),
    trafficGate: path.join(checkpoint, 'public-traffic-open.json'),
  };
}

async function writeState(paths, state) {
  await writeJsonAtomically(paths.state, state);
}

async function readState(paths) {
  try {
    return JSON.parse(await fs.readFile(paths.state, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('activation state is corrupt');
  }
}

async function writeLock(lock, state) {
  const handle = await fs.open(lock, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') throw new Error('an activation lock already exists; run interrupted-activation recovery first');
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function updateLock(lock, state) {
  await fs.writeFile(lock, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

async function clearLock(lock) {
  await fs.unlink(lock).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function closeTrafficGate(paths) {
  await fs.unlink(paths.trafficGate).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function openTrafficGate(paths, { releaseId, transactionId, phase }) {
  await writeJsonAtomically(paths.trafficGate, {
    contract: TRAFFIC_GATE_CONTRACT,
    releaseId: releaseIdText(releaseId),
    transactionId: String(transactionId || '').trim(),
    phase: String(phase || '').trim(),
    openedAt: new Date().toISOString(),
  });
}

async function readCurrentPointer(layout) {
  try {
    const stat = await fs.lstat(layout.current);
    if (!stat.isSymbolicLink()) throw new Error('current release pointer is not a symbolic link');
    const link = await fs.readlink(layout.current);
    const candidate = path.resolve(path.dirname(layout.current), link);
    const real = await fs.realpath(candidate);
    if (!contained(layout.releases, real)) throw new Error('current release pointer escapes releases directory');
    const verified = await verifyReleaseArtifact({ artifactRoot: real });
    return Object.freeze({ releaseId: verified.releaseId, releaseRoot: real, link });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function switchCurrentPointer(layout, releaseRoot) {
  const real = await fs.realpath(releaseRoot);
  if (!contained(layout.releases, real)) throw new Error('candidate release escapes the releases directory');
  const name = path.basename(real);
  const temporary = path.join(layout.root, `.current.${name}.${crypto.randomUUID()}`);
  const link = path.relative(layout.root, real);
  await fs.symlink(link, temporary);
  try {
    await fs.rename(temporary, layout.current);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function assertAdapter(adapter) {
  for (const method of ['prepare', 'restart', 'verify', 'health', 'rollback']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`activation service adapter requires ${method}()`);
  }
  return adapter;
}

async function assertServiceIdentity(adapter, service, context, expectedReleaseId = context.candidate.releaseId) {
  const expected = releaseIdText(expectedReleaseId);
  const result = await adapter.verify({ ...context, service, expectedReleaseId: expected });
  if (!result || result.releaseId !== expected) {
    throw new Error(`${service} did not report the expected release identity`);
  }
  return result;
}

async function assertServiceHealth(adapter, service, context, expectedReleaseId = context.candidate.releaseId) {
  const expected = releaseIdText(expectedReleaseId);
  const result = await adapter.health({ ...context, service, expectedReleaseId: expected });
  const healthy = result === true || (result?.ok === true && (!result.releaseId || result.releaseId === expected));
  if (!healthy) throw new Error(`${service} health check failed`);
  return result;
}

async function verifyServices(adapter, context, expectedReleaseId) {
  const services = {};
  for (const service of ['api', 'web']) {
    services[service] = await assertServiceIdentity(adapter, service, context, expectedReleaseId);
  }
  return services;
}

async function checkServiceHealth(adapter, context, expectedReleaseId) {
  const health = {};
  for (const service of ['api', 'web']) {
    health[service] = await assertServiceHealth(adapter, service, context, expectedReleaseId);
  }
  return health;
}

async function assertCatalogCompatibility(layout, manifest) {
  const catalogPath = path.join(layout.shared, 'data', 'library-browse-index.json');
  try {
    const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    const schema = String(catalog?.schema || '').trim();
    if (!schema || !manifest.compatibleCatalogSchemas.browseIndex.includes(schema)) {
      throw new Error(`shared browse catalog schema is not compatible with ${manifest.releaseId}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof SyntaxError) throw new Error('shared browse catalog is invalid JSON');
    throw error;
  }
}

function initialState({ transactionId, candidate, previous }) {
  return {
    contract: ACTIVATION_STATE_CONTRACT,
    transactionId,
    phase: 'preparing',
    candidateReleaseId: candidate.releaseId,
    previousReleaseId: previous?.releaseId || null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    rollback: null,
  };
}

async function record(paths, state) {
  await writeState(paths, state);
  if (await exists(paths.lock)) await updateLock(paths.lock, state);
}

/**
 * The adapter is intentionally an explicit seam. `prepare()` runs only after
 * this module closes the Caddy-readable traffic gate. `restart()` then starts
 * both services from the switched `current` pointer. A pointer switch alone
 * cannot atomically replace two already-running processes, so no public
 * traffic is reopened until API and web identities and health agree.
 */
export async function activateReleaseTransaction({ layoutRoot, releaseId, adapter } = {}) {
  const services = assertAdapter(adapter);
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  const paths = statePaths(layout);
  const candidateId = releaseIdText(releaseId);
  const candidateRoot = path.join(layout.releases, candidateId);
  const candidate = await verifyReleaseArtifact({ artifactRoot: candidateRoot });
  if (candidate.releaseId !== candidateId) throw new Error('candidate directory does not match its manifest release ID');
  const previous = await readCurrentPointer(layout);
  if (!previous) throw new Error('activation requires a verified previous release for rollback');
  await verifyReleaseArtifact({ artifactRoot: previous.releaseRoot });
  await validateSharedRuntimeLayout({ layoutRoot, requireConfig: true });
  await assertCatalogCompatibility(layout, candidate.manifest);

  const transactionId = crypto.randomUUID();
  const state = initialState({ transactionId, candidate, previous });
  await writeLock(paths.lock, state);
  await writeState(paths, state);
  const context = Object.freeze({ layout, candidate, previous, transactionId });
  let switched = false;
  try {
    await closeTrafficGate(paths);
    state.phase = 'traffic-gated';
    await record(paths, state);

    await services.prepare(context);
    state.phase = 'prepared';
    await record(paths, state);

    await switchCurrentPointer(layout, candidateRoot);
    switched = true;
    state.phase = 'pointer-switched';
    await record(paths, state);

    await services.restart(context);
    state.phase = 'services-restarted';
    await record(paths, state);

    const verifiedServices = await verifyServices(services, context, candidate.releaseId);
    state.phase = 'services-verified';
    await record(paths, state);

    const health = await checkServiceHealth(services, context, candidate.releaseId);
    state.phase = 'health-passed';
    await record(paths, state);

    if (typeof services.commit === 'function') await services.commit(context);
    await openTrafficGate(paths, {
      releaseId: candidate.releaseId,
      transactionId,
      phase: 'committed',
    });
    state.phase = 'committed';
    state.completedAt = new Date().toISOString();
    state.services = verifiedServices;
    state.health = health;
    await record(paths, state);
    await clearLock(paths.lock);
    return Object.freeze({ layout, transactionId, releaseId: candidate.releaseId, previousReleaseId: previous.releaseId, state });
  } catch (cause) {
    await closeTrafficGate(paths).catch(() => {});
    state.phase = 'rolling-back';
    state.rollback = { attemptedAt: new Date().toISOString(), reason: String(cause?.message || cause) };
    await record(paths, state).catch(() => {});
    let rollbackFailure = null;
    try {
      if (!switched) {
        // The pointer never moved, so shared state and the previous process
        // selection remain untouched.
      } else if (!await exists(previous.releaseRoot)) {
        throw new Error('previous release disappeared during activation; manual recovery is required');
      } else {
        await verifyReleaseArtifact({ artifactRoot: previous.releaseRoot });
        await switchCurrentPointer(layout, previous.releaseRoot);
      }
      await services.rollback({ ...context, cause });
      const rollbackServices = await verifyServices(services, context, previous.releaseId);
      const rollbackHealth = await checkServiceHealth(services, context, previous.releaseId);
      await openTrafficGate(paths, {
        releaseId: previous.releaseId,
        transactionId,
        phase: 'rolled-back',
      });
      state.phase = 'rolled-back';
      state.completedAt = new Date().toISOString();
      state.rollback = {
        ...state.rollback,
        completedAt: state.completedAt,
        services: rollbackServices,
        health: rollbackHealth,
      };
      await record(paths, state);
      await clearLock(paths.lock);
    } catch (error) {
      rollbackFailure = error;
      state.phase = 'manual-recovery-required';
      state.rollback = { ...state.rollback, error: String(error?.message || error) };
      await record(paths, state).catch(() => {});
    }
    if (rollbackFailure) {
      throw new Error(`activation failed: ${String(cause?.message || cause)}; rollback failed: ${String(rollbackFailure?.message || rollbackFailure)}`);
    }
    throw cause;
  }
}

export async function recoverInterruptedActivation({ layoutRoot, adapter } = {}) {
  const services = assertAdapter(adapter);
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  const paths = statePaths(layout);
  const state = await readState(paths);
  if (!state) return Object.freeze({ recovered: false, reason: 'no-activation-state' });
  if (state.contract !== ACTIVATION_STATE_CONTRACT) throw new Error('activation state contract is invalid');
  if (['committed', 'rolled-back', 'recovered'].includes(state.phase)) {
    await clearLock(paths.lock);
    return Object.freeze({ recovered: false, reason: `terminal-${state.phase}`, state });
  }
  await closeTrafficGate(paths);
  const previousId = state.previousReleaseId;
  if (!previousId) {
    state.phase = 'manual-recovery-required';
    state.rollback = { ...(state.rollback || {}), error: 'no previous release was recorded for interrupted activation' };
    await writeState(paths, state);
    throw new Error('interrupted activation has no previous release; manual recovery is required');
  }
  const previousRoot = path.join(layout.releases, releaseIdText(previousId));
  if (!await exists(previousRoot)) {
    state.phase = 'manual-recovery-required';
    state.rollback = { ...(state.rollback || {}), error: 'previous release is missing' };
    await writeState(paths, state);
    throw new Error('interrupted activation previous release is missing; manual recovery is required');
  }
  const previous = await verifyReleaseArtifact({ artifactRoot: previousRoot });
  const candidateRoot = path.join(layout.releases, releaseIdText(state.candidateReleaseId));
  // A corrupt or incomplete candidate must never prevent restoration of the
  // already-verified previous release. Rollback adapters must not execute code
  // from this fallback record.
  const candidate = await verifyReleaseArtifact({ artifactRoot: candidateRoot }).catch(() => Object.freeze({
    releaseId: state.candidateReleaseId,
    releaseRoot: candidateRoot,
    artifactValid: false,
  }));
  await switchCurrentPointer(layout, previousRoot);
  const context = Object.freeze({ layout, previous, candidate, transactionId: state.transactionId, interrupted: true });
  await services.rollback(context);
  const rollbackServices = await verifyServices(services, context, previous.releaseId);
  const rollbackHealth = await checkServiceHealth(services, context, previous.releaseId);
  await openTrafficGate(paths, {
    releaseId: previous.releaseId,
    transactionId: state.transactionId,
    phase: 'recovered',
  });
  state.phase = 'recovered';
  state.completedAt = new Date().toISOString();
  state.rollback = {
    ...(state.rollback || {}),
    recoveredAt: state.completedAt,
    services: rollbackServices,
    health: rollbackHealth,
  };
  await writeState(paths, state);
  await clearLock(paths.lock);
  return Object.freeze({ recovered: true, previousReleaseId: previous.releaseId, state });
}

export async function readReleaseActivationState({ layoutRoot } = {}) {
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  return readState(statePaths(layout));
}

export async function readReleaseTrafficGate({ layoutRoot } = {}) {
  const layout = await createDisposableReleaseLayout({ layoutRoot });
  const paths = statePaths(layout);
  try {
    const gate = JSON.parse(await fs.readFile(paths.trafficGate, 'utf8'));
    if (gate?.contract !== TRAFFIC_GATE_CONTRACT) throw new Error('release traffic gate contract is invalid');
    releaseIdText(gate.releaseId);
    return Object.freeze(gate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
