import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, verifyReleaseArtifact } from '../../src/lib/release-artifact.mjs';
import {
  H4C4A_REHEARSAL_PLAN_CONTRACT,
  prepareH4c4aRehearsal,
  removeSyntheticRehearsalState,
} from './h4c4a-rehearsal.mjs';
import {
  H4C4B_EXECUTION_CONTRACT,
  createH4c4bExecutionPlan,
  executeH4c4bRehearsal,
  oneShotAuthorizationForRelease,
} from './h4c4b-execution-adapter.mjs';
import { assertArtifactBrowseIsolationEvidence } from './h4c4-artifact-browse-isolation.mjs';

export const H4C4_RELEASE_ACCEPTANCE_CONTRACT = 'sonuvi.h4c4.release-acceptance.v1';
export const H4C4_RELEASE_ACCEPTANCE_RECORD_CONTRACT = 'sonuvi.h4c4.release-acceptance-record.v1';

export const H4C4_RELEASE_ACCEPTANCE_CRITERIA = Object.freeze({
  runtime: Object.freeze([
    'api-and-web-start-from-the-same-pinned-release',
    'api-health-and-web-release-identity-match',
    'no-unexpected-startup-failure',
  ]),
  catalog: Object.freeze([
    'fictional-browse-index-v2-is-accepted',
    'instrumented-mpc-invocation-count-is-zero',
    'no-mpd-network-attempt',
    'no-catalog-write-or-regeneration',
  ]),
  security: Object.freeze([
    'public-configuration-is-allowlisted',
    'protected-configuration-and-private-files-are-inaccessible',
    'external-mutations-and-unknown-capabilities-fail-closed',
    'no-credentials-or-production-mounts',
  ]),
  pwa: Object.freeze([
    'main-page-and-allowlisted-assets-load',
    'pwa-manifest-is-available',
    'service-worker-absence-matches-the-current-product-contract',
  ]),
  isolationAndCleanup: Object.freeze([
    'internal-network-has-no-external-route-or-dns',
    'no-docker-socket-privileges-host-network-or-production-ports',
    'release-hashes-and-synthetic-state-boundaries-remain-unchanged',
    'rehearsal-owned-containers-and-network-are-removed',
  ]),
});

function text(value) {
  return String(value ?? '').trim();
}

function immutable(value) {
  return Object.freeze(value);
}

function absolute(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(candidate);
}

function releaseId(value, label = 'release ID') {
  const candidate = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function gitObject(value, label) {
  const candidate = text(value);
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error(`${label} must be a full Git object ID`);
  return candidate;
}

function runId(value) {
  const candidate = text(value);
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/i.test(candidate)) throw new Error('acceptance run ID is invalid');
  return candidate;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recordDigest(record) {
  const copy = { ...record };
  delete copy.recordSha256;
  return sha256(canonicalJson(copy));
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureRealDirectory(value, label) {
  const target = absolute(value, label);
  const stat = await lstatOrNull(target);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return await fs.realpath(target);
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function verifiedArtifactSummary({
  releaseRoot,
  expectedReleaseId,
  expectedSourceCommit,
  expectedSourceTree,
  verifyArtifact = verifyReleaseArtifact,
} = {}) {
  const root = await ensureRealDirectory(releaseRoot, 'release root');
  const expectedId = releaseId(expectedReleaseId, 'expected release ID');
  const expectedCommit = gitObject(expectedSourceCommit, 'expected source commit');
  const expectedTree = gitObject(expectedSourceTree, 'expected source tree');
  const verified = await verifyArtifact({ artifactRoot: root });
  if (!verified || absolute(verified.root, 'verified release root') !== root || !verified.manifest) {
    throw new Error('release manifest verifier did not confirm the explicit release root');
  }
  const manifest = verified.manifest;
  const id = releaseId(verified.releaseId || manifest.releaseId);
  if (id !== expectedId || releaseId(manifest.releaseId) !== expectedId) {
    throw new Error('verified release identity does not match the explicit expected release');
  }
  const source = manifest.source || {};
  if (source.dirty !== false || source.snapshotStatus !== 'clean-git-worktree-snapshot') {
    throw new Error('release acceptance requires clean Git provenance');
  }
  if (gitObject(source.gitHead, 'release source commit') !== expectedCommit || gitObject(source.gitTree, 'release source tree') !== expectedTree) {
    throw new Error('release acceptance source provenance does not match the explicit commit and tree');
  }
  if (manifest?.target?.os !== 'linux' || manifest?.target?.architecture !== 'arm64' || !/^v?20\./.test(text(manifest?.target?.nodeVersion))) {
    throw new Error('release acceptance requires a Linux/ARM64 Node 20 artifact');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest?.publicAssets?.inventory) || !manifest.publicAssets.inventory.length) {
    throw new Error('release acceptance manifest inventory is incomplete');
  }
  const dependencyHash = text(manifest?.dependencies?.dependencyFilesHash);
  if (!/^[a-f0-9]{64}$/.test(dependencyHash)) throw new Error('release acceptance dependency inventory hash is invalid');
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('release manifest must be a regular non-symlink file');
  return immutable({
    releaseId: id,
    releaseRoot: root,
    manifestSha256: await sha256File(manifestPath),
    source: immutable({ commit: expectedCommit, tree: expectedTree, snapshotStatus: source.snapshotStatus, dirty: false }),
    target: immutable({ os: manifest.target.os, architecture: manifest.target.architecture, nodeVersion: manifest.target.nodeVersion, npmVersion: text(manifest.target.npmVersion) || null }),
    fileCount: manifest.files.length,
    publicAssetCount: manifest.publicAssets.inventory.length,
    dependencyFilesHash: dependencyHash,
  });
}

function assertRehearsalPlan(plan, artifact) {
  if (!plan || plan.contract !== H4C4A_REHEARSAL_PLAN_CONTRACT || plan.action !== 'preflight-only' || plan.startAuthorized !== false) {
    throw new Error('release acceptance requires an unchanged fail-closed rehearsal preflight plan');
  }
  if (plan.releaseId !== artifact.releaseId || plan.expectedReleaseId !== artifact.releaseId || absolute(plan.releaseRoot, 'rehearsal plan release root') !== artifact.releaseRoot) {
    throw new Error('rehearsal preflight plan does not pin the verified release');
  }
  return plan;
}

export function assertReleaseAcceptanceRecord(value) {
  if (!value || value.contract !== H4C4_RELEASE_ACCEPTANCE_RECORD_CONTRACT) {
    throw new Error('release acceptance record contract is invalid');
  }
  if (value.action !== 'preflight-only' || value.executionAuthorized !== false || value.status !== 'preflight-passed-no-start') {
    throw new Error('release acceptance record must remain a no-start preflight');
  }
  if (!/^[a-f0-9]{64}$/.test(text(value.recordSha256)) || recordDigest(value) !== value.recordSha256) {
    throw new Error('release acceptance record integrity hash is invalid');
  }
  const artifact = value.artifact || {};
  const id = releaseId(artifact.releaseId);
  if (!/^[a-f0-9]{64}$/.test(text(artifact.manifestSha256))) throw new Error('release acceptance record manifest hash is invalid');
  gitObject(artifact?.source?.commit, 'release acceptance record source commit');
  gitObject(artifact?.source?.tree, 'release acceptance record source tree');
  if (artifact?.source?.dirty !== false || artifact?.source?.snapshotStatus !== 'clean-git-worktree-snapshot') {
    throw new Error('release acceptance record does not preserve clean source provenance');
  }
  if (artifact?.target?.os !== 'linux' || artifact?.target?.architecture !== 'arm64' || !/^v?20\./.test(text(artifact?.target?.nodeVersion))) {
    throw new Error('release acceptance record target is invalid');
  }
  if (!Number.isInteger(artifact.fileCount) || artifact.fileCount < 1 || !Number.isInteger(artifact.publicAssetCount) || artifact.publicAssetCount < 1 || !/^[a-f0-9]{64}$/.test(text(artifact.dependencyFilesHash))) {
    throw new Error('release acceptance record inventory is invalid');
  }
  assertArtifactBrowseIsolationEvidence(value.artifactBrowseIsolation, {
    expectedReleaseId: id,
    expectedManifestSha256: artifact.manifestSha256,
  });
  assertRehearsalPlan(value.rehearsalPlan, {
    releaseId: id,
    releaseRoot: absolute(artifact.releaseRoot, 'release acceptance record release root'),
  });
  if (!value.cleanup || absolute(value.cleanup.stateRoot, 'release acceptance cleanup state root') !== absolute(value.rehearsalPlan.stateRoot, 'rehearsal plan state root') || text(value.cleanup.fixtureId) !== text(value.rehearsalPlan.fixtureId)) {
    throw new Error('release acceptance record cleanup scope is invalid');
  }
  runId(value.runId);
  if (Number.isNaN(Date.parse(text(value.createdAt)))) throw new Error('release acceptance record timestamp is invalid');
  return immutable(value);
}

export async function createReleaseAcceptancePreflight({
  releaseRoot,
  stateRoot,
  expectedReleaseId,
  expectedSourceCommit,
  expectedSourceTree,
  artifactBrowseIsolation,
  runId: requestedRunId,
  apiPort,
  webPort,
  verifyArtifact = verifyReleaseArtifact,
  prepareRehearsal = prepareH4c4aRehearsal,
  now = () => new Date().toISOString(),
} = {}) {
  const artifact = await verifiedArtifactSummary({
    releaseRoot,
    expectedReleaseId,
    expectedSourceCommit,
    expectedSourceTree,
    verifyArtifact,
  });
  const isolation = assertArtifactBrowseIsolationEvidence(artifactBrowseIsolation, {
    expectedReleaseId: artifact.releaseId,
    expectedManifestSha256: artifact.manifestSha256,
  });
  const plan = await prepareRehearsal({
    releaseRoot: artifact.releaseRoot,
    stateRoot: absolute(stateRoot, 'synthetic state root'),
    expectedReleaseId: artifact.releaseId,
    apiPort,
    webPort,
    verifyArtifact,
  });
  assertRehearsalPlan(plan, artifact);
  const createdAt = text(now());
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('release acceptance preflight timestamp is invalid');
  const record = {
    contract: H4C4_RELEASE_ACCEPTANCE_RECORD_CONTRACT,
    status: 'preflight-passed-no-start',
    action: 'preflight-only',
    executionAuthorized: false,
    runId: runId(requestedRunId),
    createdAt,
    artifact,
    artifactBrowseIsolation: isolation,
    rehearsalPlan: plan,
    criteria: H4C4_RELEASE_ACCEPTANCE_CRITERIA,
    cleanup: { action: 'cleanup-only', stateRoot: plan.stateRoot, fixtureId: plan.fixtureId },
  };
  record.recordSha256 = recordDigest(record);
  return assertReleaseAcceptanceRecord(record);
}

export async function writeReleaseAcceptanceRecord({ recordPath, record } = {}) {
  const accepted = assertReleaseAcceptanceRecord(record);
  const target = absolute(recordPath, 'release acceptance record path');
  const parent = await ensureRealDirectory(path.dirname(target), 'release acceptance record parent');
  const relative = path.relative(parent, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('release acceptance record path escapes its parent');
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(accepted, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return immutable({ path: target, recordSha256: accepted.recordSha256 });
}

export async function readReleaseAcceptanceRecord({ recordPath } = {}) {
  const target = absolute(recordPath, 'release acceptance record path');
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('release acceptance record must be a private regular non-symlink file');
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    throw new Error('release acceptance record JSON is invalid');
  }
  return assertReleaseAcceptanceRecord(parsed);
}

export async function executeReleaseAcceptance({
  record,
  authorization,
  runId: requestedRunId,
  evidencePath,
  timeoutMs,
  verifyArtifact = verifyReleaseArtifact,
  prepareRehearsal = prepareH4c4aRehearsal,
  createExecutionPlan = createH4c4bExecutionPlan,
  executeRehearsal = executeH4c4bRehearsal,
} = {}) {
  const accepted = assertReleaseAcceptanceRecord(record);
  const expectedAuthorization = oneShotAuthorizationForRelease(accepted.artifact.releaseId);
  if (text(authorization) !== expectedAuthorization) {
    throw new Error('release acceptance execution requires the exact release-scoped one-shot authorization');
  }
  const artifact = await verifiedArtifactSummary({
    releaseRoot: accepted.artifact.releaseRoot,
    expectedReleaseId: accepted.artifact.releaseId,
    expectedSourceCommit: accepted.artifact.source.commit,
    expectedSourceTree: accepted.artifact.source.tree,
    verifyArtifact,
  });
  if (artifact.manifestSha256 !== accepted.artifact.manifestSha256) {
    throw new Error('release acceptance execution refuses an artifact whose manifest changed after preflight');
  }
  const currentPlan = await prepareRehearsal({
    releaseRoot: artifact.releaseRoot,
    stateRoot: accepted.cleanup.stateRoot,
    expectedReleaseId: artifact.releaseId,
    apiPort: accepted.rehearsalPlan.ports.api,
    webPort: accepted.rehearsalPlan.ports.web,
    verifyArtifact,
  });
  assertRehearsalPlan(currentPlan, artifact);
  if (canonicalJson(currentPlan) !== canonicalJson(accepted.rehearsalPlan)) {
    throw new Error('release acceptance execution refuses a changed preflight plan');
  }
  const execution = createExecutionPlan({
    rehearsalPlan: currentPlan,
    expectedReleaseId: artifact.releaseId,
    authorization,
    runId: runId(requestedRunId),
    timeoutMs,
  });
  if (execution.contract !== H4C4B_EXECUTION_CONTRACT) throw new Error('release acceptance execution adapter contract is invalid');
  return await executeRehearsal({ execution, authorization, evidencePath: absolute(evidencePath, 'release acceptance execution evidence path'), verifyArtifact });
}

export async function cleanupReleaseAcceptance({
  record,
  removeSyntheticState = removeSyntheticRehearsalState,
} = {}) {
  const accepted = assertReleaseAcceptanceRecord(record);
  return await removeSyntheticState({
    stateRoot: accepted.cleanup.stateRoot,
    fixtureId: accepted.cleanup.fixtureId,
  });
}
