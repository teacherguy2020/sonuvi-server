import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  canonicalJson,
  makeTreeReadOnly,
  verifyReleaseArtifact,
} from '../../../src/lib/release-artifact.mjs';
import { verifySignedGateCReleaseMetadata } from '../../../src/lib/sonuvi-gate-c-release.mjs';
import { readGateCTargetIdentity } from '../../../src/lib/sonuvi-gate-c-target-preflight.mjs';
import {
  GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS,
  gateCBootstrapAdmissionGuardProgram,
} from '../../../src/lib/sonuvi-gate-c-bootstrap-replacement-contract.mjs';

const CAPSULE = '/sonuvi/scripts/sonuvi-sftp-bootstrap-activate-v2.sh';
const OLD_KIT_SHA256 = '91b2d8cc171e5106ca87102a50e3e29392680f52b748c02ac9c5926a71d1b63d';
const NEW_KIT_SHA256 = 'aec02a0ad716f6c979b2b2099099d913bee773e651f7159c402b022dfe113243';
const OLD_KIT_RELEASE_ID = 'sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66';
const OLD_SERVER_RELEASE_ID = 'sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912';
const NEW_SERVER_RELEASE_ID = 'sonuvi-3cbe87d6744b9f7a1423afa09ca91eb81e9662138d59d1e29054c72045700fdf';
const HISTORICAL_ARTIFACTS = '/artifacts/historical';
const INSTALLED_ARTIFACTS = '/artifacts/installed';
const CORRECTED_ARTIFACTS = '/artifacts/corrected';
const OLD_KIT_ARCHIVE = path.join(HISTORICAL_ARTIFACTS, 'sonuvi-bootstrap-kit-v2.tar');
const NEW_KIT_ARCHIVE = path.join(CORRECTED_ARTIFACTS, 'sonuvi-bootstrap-kit-v2.tar');
const OLD_ENVELOPE_PATH = path.join(HISTORICAL_ARTIFACTS, 'release-envelope.json');
const INSTALLED_ENVELOPE_PATH = path.join(INSTALLED_ARTIFACTS, 'release-envelope.json');
const OLD_RELEASE_ARCHIVE = path.join(INSTALLED_ARTIFACTS, `${OLD_SERVER_RELEASE_ID}-linux-arm64.tar`);
const NEW_RELEASE_ARCHIVE = path.join(CORRECTED_ARTIFACTS, `${NEW_SERVER_RELEASE_ID}-linux-arm64.tar`);
const ENVELOPE_PATH = path.join(CORRECTED_ARTIFACTS, 'release-envelope.json');
const ANCHORS_PATH = path.join(CORRECTED_ARTIFACTS, 'release-trust-anchors.json');
const BOOTSTRAP_ROOT = '/var/lib/sonuvi-bootstrap';
const ACTIVE_KIT = path.join(BOOTSTRAP_ROOT, 'bootstrap-kit-v2');
const REPLACEMENTS = path.join(BOOTSTRAP_ROOT, 'bootstrap-kit-replacements');
const HOME = '/home/sonuvi-test';
const STAGING = path.join(HOME, '.local/share/sonuvi-bootstrap-v2');
const STAGED_KIT = path.join(STAGING, `sonuvi-bootstrap-kit-v2-${NEW_KIT_SHA256}.tar`);
const layoutRoot = '/opt/sonuvi';
const stateRoot = '/var/lib/sonuvi';
const unitRoot = '/etc/systemd/system';
const healthFailurePath = '/run/sonuvi-bootstrap-replacement-fail-health';
const healthInterruptionPath = '/run/sonuvi-bootstrap-replacement-interrupt-after-services-verified';
const healthInterruptionReachedPath = '/run/sonuvi-bootstrap-replacement-interrupt-health-reached';
const healthInterruptionAcknowledgedPath = '/run/sonuvi-bootstrap-replacement-interrupt-health-acknowledged';
// The fixed promoted helper must finish candidate promotion, real systemd
// restart, and service identity verification before the fixture-only simulated
// web health gate can be reached.
const PROMOTED_ACTIVATION_INTERRUPTION_TIMEOUT_MS = 30_000;
const PROMOTED_ACTIVATION_INTERRUPTION_POLL_INTERVAL_MS = 10;
const fixtureMarker = '/run/sonuvi-bootstrap-replacement-fixture-owned';
const interposerSource = '/sonuvi/test/fixtures/systemd-upgrade/renameat2-interrupt.c';
const interposerLibrary = '/tmp/sonuvi-bootstrap-replacement-interrupt.so';
const admissionGuardHelper = '/tmp/sonuvi-bootstrap-admission-helper.mjs';
const admissionGuardMarker = '/run/sonuvi-bootstrap-admission-helper-loaded';
const sshDirectory = path.join(HOME, '.ssh');
const sshAuthorizedKeys = path.join(sshDirectory, 'authorized_keys');
const sshAuthorization = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyPinnedSshAuthorization sonuvi-fixture\n';
const upgradeStatePath = path.join(stateRoot, 'checkpoints/release-upgrade-state.json');
const releaseLockPath = path.join(stateRoot, 'checkpoints/release-activation.lock');
function ensureSystemUser(name, args) {
  const existing = spawnSync('/usr/bin/id', ['-u', name], { encoding: 'utf8' });
  if (existing.status === 0) return;
  const created = spawnSync('/usr/sbin/useradd', args, { encoding: 'utf8' });
  if (created.status !== 0) throw new Error(`could not create fixture account ${name}: ${created.stderr}`);
}

ensureSystemUser('sonuvi', ['--system', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'sonuvi']);
ensureSystemUser('sonuvi-test', ['--create-home', '--home-dir', HOME, '--shell', '/bin/sh', 'sonuvi-test']);
const userId = Number(spawnSync('/usr/bin/id', ['-u', 'sonuvi-test'], { encoding: 'utf8' }).stdout.trim());
const userGroupId = Number(spawnSync('/usr/bin/id', ['-g', 'sonuvi-test'], { encoding: 'utf8' }).stdout.trim());
const serviceUserId = Number(spawnSync('/usr/bin/id', ['-u', 'sonuvi'], { encoding: 'utf8' }).stdout.trim());
const groupId = Number(spawnSync('/usr/bin/id', ['-g', 'sonuvi'], { encoding: 'utf8' }).stdout.trim());
const envelope = JSON.parse(await fs.readFile(ENVELOPE_PATH, 'utf8'));
const historicalEnvelope = JSON.parse(await fs.readFile(OLD_ENVELOPE_PATH, 'utf8'));
const installedEnvelope = JSON.parse(await fs.readFile(INSTALLED_ENVELOPE_PATH, 'utf8'));
const trustedAnchors = JSON.parse(await fs.readFile(ANCHORS_PATH, 'utf8'));
const capsuleSource = await fs.readFile(CAPSULE);

const PRESERVED_STATE = Object.freeze({
  'protected/administrator.json': '{"contract":"fixture.admin","identity":"preserve-me"}\n',
  'protected/controller.json': '{"contract":"fixture.controller","identity":"preserve-me"}\n',
  'data/server-identity.json': '{"serverId":"fixture-server-identity"}\n',
  'config/now-playing.config.json': '{"ports":{"api":3101,"ui":8101},"fixture":true}\n',
  'data/library-browse-index.json': '{"schema":"now-playing.browse-index.v2","items":[]}\n',
});
let targetIdentity = null;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function assertCommandOk(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return result;
}

function replacementRequest(operationId, overrides = {}) {
  return {
    operationId,
    targetIdentity,
    expectedServerReleaseId: OLD_SERVER_RELEASE_ID,
    previousBootstrapKitSHA256: OLD_KIT_SHA256,
    replacementReleaseId: NEW_SERVER_RELEASE_ID,
    replacementKitSHA256: NEW_KIT_SHA256,
    replacementKitBytes: 238_592,
    envelope,
    ...overrides,
  };
}

function capsuleArgs(operation, request) {
  if (operation === 'replace_bootstrap_kit') {
    return [
      operation,
      request.operationId,
      request.targetIdentity,
      request.expectedServerReleaseId,
      request.previousBootstrapKitSHA256,
      request.replacementReleaseId,
      request.replacementKitSHA256,
      String(request.replacementKitBytes),
      Buffer.from(JSON.stringify(request.envelope), 'utf8').toString('base64url'),
    ];
  }
  if (operation === 'recover_bootstrap_kit_replacement') return [operation, request.operationId, request.targetIdentity];
  if (operation === 'rollback_bootstrap_kit') {
    return [operation, request.operationId, request.targetIdentity, request.replacementKitSHA256, request.previousBootstrapKitSHA256];
  }
  throw new Error('fixture requested an unsupported capsule operation');
}

function capsuleEnvironment(overrides = {}) {
  return {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    SUDO_USER: 'sonuvi-test',
    SUDO_UID: String(userId),
    SUDO_GID: String(userGroupId),
    ...overrides,
  };
}

function runCapsule(operation, request, envOverrides = {}) {
  const result = run('/bin/sh', ['-s', '--', ...capsuleArgs(operation, request)], {
    input: capsuleSource,
    env: capsuleEnvironment(envOverrides),
  });
  const lines = result.stdout.trim().split(/\r?\n/);
  let response = null;
  try { response = JSON.parse(lines.at(-1)); } catch {}
  assert.ok(response, `capsule returned no typed JSON response (${result.status}): ${result.stderr}`);
  return { ...result, response };
}

function typedJsonResponse(result, label, { required = true } = {}) {
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  let response = null;
  try { response = JSON.parse(lines.at(-1)); } catch {}
  if (required) assert.ok(response, `${label} returned no typed JSON response (${result.status}): ${result.stderr}`);
  return response;
}

async function promotedKitHelperPath(script) {
  const manifest = await verifyKitAt(ACTIVE_KIT, NEW_KIT_SHA256);
  const relative = `scripts/${script}`;
  assert.equal(manifest.files.some((entry) => entry.path === relative), true, `${relative} is absent from the promoted kit inventory`);
  const helper = path.join(ACTIVE_KIT, relative);
  const stat = await fs.lstat(helper);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `${relative} is not a regular promoted-kit helper`);
  assert.equal(stat.uid, 0, `${relative} is not root-owned`);
  assert.equal(stat.mode & 0o777, 0o600, `${relative} is not mode 0600`);
  return helper;
}

// The isolated fixture is already root. Its argv after sudo is the documented
// fixed command: flock -n <admission lock> node <promoted helper>.
async function runPromotedKitHelper(script, input, { requireResponse = true } = {}) {
  const helper = await promotedKitHelperPath(script);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['-n', path.join(BOOTSTRAP_ROOT, 'bootstrap-admission.lock'), '/usr/bin/node', helper], {
      env: capsuleEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.stdin.once('error', (error) => {
      // A fixed helper can reject malformed framing before flock finishes
      // writing fixture input. That expected pipe closure must not hide its
      // typed response, but every other stdin failure remains a test error.
      if (error?.code !== 'EPIPE') stdinError = error;
    });
    child.once('close', (status, signal) => {
      if (stdinError) reject(stdinError);
      else resolve({ status, signal, stdout, stderr });
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      if (error?.code !== 'EPIPE') reject(error);
    }
  });
  return { ...result, response: typedJsonResponse(result, `promoted ${script}`, { required: requireResponse }) };
}

async function stageNewServerRelease(attemptId, overrides = {}) {
  const archive = overrides.archive ?? await fs.readFile(NEW_RELEASE_ARCHIVE);
  const request = {
    operation: 'stage_release',
    envelope: overrides.envelope ?? envelope,
    attemptId,
    targetIdentity: overrides.targetIdentity ?? targetIdentity,
  };
  const input = Buffer.concat([Buffer.from(`${JSON.stringify(request)}\n`, 'utf8'), Buffer.from(archive)]);
  return runPromotedKitHelper('sonuvi-release-stage.mjs', input);
}

function existingInstallRequest(attemptId, overrides = {}) {
  return {
    operation: overrides.operation ?? 'activate_existing_install',
    attemptId,
    targetIdentity: overrides.targetIdentity ?? targetIdentity,
    expectedPreviousReleaseId: overrides.expectedPreviousReleaseId ?? OLD_SERVER_RELEASE_ID,
    envelope: overrides.envelope ?? envelope,
  };
}

async function invokePromotedExistingInstall(request) {
  return runPromotedKitHelper('sonuvi-existing-install-upgrade.mjs', Buffer.from(JSON.stringify(request), 'utf8'));
}

function expectCapsuleFailure(operation, request, code, envOverrides = {}) {
  const result = runCapsule(operation, request, envOverrides);
  assert.notEqual(result.status, 0, `expected ${code} failure`);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.code, code);
  assert.equal(result.response.operationId, request.operationId);
  assert.equal(result.response.targetIdentity, request.targetIdentity);
  return result.response;
}

function initialJournal(request) {
  const now = '2026-11-09T12:00:00.000Z';
  return {
    contract: 'sonuvi.gate-c-bootstrap-kit-replacement.v1',
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
    expectedServerReleaseId: request.expectedServerReleaseId,
    previousBootstrapKitSHA256: request.previousBootstrapKitSHA256,
    replacementReleaseId: request.replacementReleaseId,
    replacementKitSHA256: request.replacementKitSHA256,
    replacementKitBytes: request.replacementKitBytes,
    signedEnvelopeSHA256: crypto.createHash('sha256').update(JSON.stringify(request.envelope)).digest('hex'),
    state: 'preparing',
    createdAt: now,
    updatedAt: now,
  };
}

function initialJournalIntent(request) {
  const journal = initialJournal(request);
  return {
    contract: 'sonuvi.gate-c-bootstrap-initial-journal-intent.v1',
    operationId: journal.operationId,
    targetIdentity: journal.targetIdentity,
    expectedServerReleaseId: journal.expectedServerReleaseId,
    previousBootstrapKitSHA256: journal.previousBootstrapKitSHA256,
    createdAt: journal.createdAt,
  };
}

async function syncFixtureDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeInitialJournalIntent(request, { syncFile = false, syncRoot = false } = {}) {
  await fs.mkdir(REPLACEMENTS, { recursive: true, mode: 0o700 });
  await fs.chown(REPLACEMENTS, 0, 0);
  await fs.chmod(REPLACEMENTS, 0o700);
  const value = initialJournalIntent(request);
  const contents = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const target = path.join(REPLACEMENTS, `.initial-journal-intent-${request.operationId}.json`);
  const temporary = path.join(REPLACEMENTS, `.initial-journal-intent-${request.operationId}-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.chown(0, 0);
    await handle.chmod(0o600);
    if (syncFile) await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  if (syncRoot) await syncFixtureDirectory(REPLACEMENTS);
  return { contents, path: target, value };
}

async function writeInitialJournalTemporary(operationId, contents, { syncFile = false, syncRoot = false } = {}) {
  await fs.mkdir(REPLACEMENTS, { recursive: true, mode: 0o700 });
  await fs.chown(REPLACEMENTS, 0, 0);
  await fs.chmod(REPLACEMENTS, 0o700);
  const temporary = path.join(REPLACEMENTS, `.journal-${operationId}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    if (contents.length) await handle.writeFile(contents);
    if (syncFile) await handle.sync();
    await handle.chown(0, 0);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  if (syncRoot) await syncFixtureDirectory(REPLACEMENTS);
  return temporary;
}

async function ensureAdmissionGuardFixture() {
  await fs.writeFile(admissionGuardHelper, [
    "import fs from 'node:fs/promises';",
    "await fs.appendFile(process.env.SONUVI_ADMISSION_FIXTURE_MARKER, 'loaded\\n');",
  ].join('\n'), { mode: 0o600 });
  await fs.chown(admissionGuardHelper, 0, 0);
  await fs.chmod(admissionGuardHelper, 0o600);
  await fs.writeFile(admissionGuardMarker, '', { mode: 0o600 });
  await fs.chown(admissionGuardMarker, 0, 0);
  await fs.chmod(admissionGuardMarker, 0o600);
}

async function ensureAdmissionLock() {
  const lock = path.join(BOOTSTRAP_ROOT, 'bootstrap-admission.lock');
  const handle = await fs.open(lock, 'a', 0o600);
  await handle.close();
  await fs.chown(lock, 0, 0);
  await fs.chmod(lock, 0o600);
  return lock;
}

async function runAdmissionGuard(operation) {
  const lock = await ensureAdmissionLock();
  const helpers = Object.fromEntries(Object.values(GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS).map((name) => [name, admissionGuardHelper]));
  const program = gateCBootstrapAdmissionGuardProgram({
    bootstrapRoot: BOOTSTRAP_ROOT,
    expectedUID: 0,
    expectedGID: 0,
    helpers,
    nodePath: process.execPath,
  });
  const result = run('/usr/bin/flock', ['-n', lock, process.execPath, '--input-type=module', '--eval', program, operation], {
    env: { ...capsuleEnvironment(), SONUVI_ADMISSION_FIXTURE_MARKER: admissionGuardMarker },
  });
  const line = String(result.stdout || '').trim().split(/\r?\n/).at(-1);
  let response = null;
  try { response = JSON.parse(line); } catch {}
  return { ...result, response };
}

async function runPromotedAdmissionGuard(operation) {
  const lock = await ensureAdmissionLock();
  const program = gateCBootstrapAdmissionGuardProgram({
    bootstrapRoot: BOOTSTRAP_ROOT,
    expectedUID: 0,
    expectedGID: 0,
    nodePath: '/usr/bin/node',
  });
  const result = run('/usr/bin/flock', ['-n', lock, '/usr/bin/node', '--input-type=module', '--eval', program, operation], { env: capsuleEnvironment() });
  return { ...result, response: typedJsonResponse(result, `promoted admission ${operation}`) };
}

async function readAdmissionGuardMarker() {
  return await fs.readFile(admissionGuardMarker, 'utf8');
}

async function assertAdmissionBlockedForEveryOperation() {
  for (const operation of Object.values(GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS)) {
    await fs.truncate(admissionGuardMarker, 0);
    const result = await runAdmissionGuard(operation);
    assert.notEqual(result.status, 0, `${operation} unexpectedly loaded a replaceable helper`);
    assert.equal(result.response?.code, 'bootstrap_recovery_required');
    assert.equal(await readAdmissionGuardMarker(), '', `${operation} loaded a replaceable helper while blocked`);
  }
}

async function assertAdmissionOpenedForEveryOperation() {
  for (const operation of Object.values(GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS)) {
    await fs.truncate(admissionGuardMarker, 0);
    const result = await runAdmissionGuard(operation);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readAdmissionGuardMarker(), 'loaded\n', `${operation} did not reach its replaceable helper`);
  }
}

async function ensureRootKitFromArchive(archive, destination, expectedDigest) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  run('/usr/bin/tar', ['-xf', archive, '-C', destination]).status === 0 || assert.fail('historical kit extraction failed');
  for (const entry of await fs.readdir(destination, { withFileTypes: true })) {
    const candidate = path.join(destination, entry.name);
    if (entry.isDirectory()) await normalizeTreePermissions(candidate);
  }
  await normalizeTreePermissions(destination);
  await fs.writeFile(path.join(destination, '.sonuvi-bootstrap-kit-v2.sha256'), `${expectedDigest}\n`, { mode: 0o600 });
  await fs.chown(path.join(destination, '.sonuvi-bootstrap-kit-v2.sha256'), 0, 0);
  await fs.chmod(path.join(destination, '.sonuvi-bootstrap-kit-v2.sha256'), 0o600);
}

async function normalizeTreePermissions(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const stat = await fs.lstat(candidate);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      await normalizeTreePermissions(candidate);
      await fs.chown(candidate, 0, 0);
      await fs.chmod(candidate, 0o700);
    } else {
      assert.equal(stat.isFile(), true);
      await fs.chown(candidate, 0, 0);
      await fs.chmod(candidate, 0o600);
    }
  }
  await fs.chown(root, 0, 0);
  await fs.chmod(root, 0o700);
}

async function stageCorrectedKit(bytes = null) {
  await fs.mkdir(STAGING, { recursive: true, mode: 0o700 });
  for (const directory of [path.join(HOME, '.local'), path.join(HOME, '.local/share'), STAGING]) {
    await fs.chown(directory, userId, userGroupId);
    await fs.chmod(directory, 0o700);
  }
  const content = bytes ?? await fs.readFile(NEW_KIT_ARCHIVE);
  await fs.writeFile(STAGED_KIT, content, { mode: 0o600 });
  await fs.chown(STAGED_KIT, userId, userGroupId);
  await fs.chmod(STAGED_KIT, 0o600);
}

async function resetBootstrapFixture() {
  assert.equal(await fs.readFile(fixtureMarker, 'utf8'), 'owned by this integration fixture\n');
  await fs.rm(BOOTSTRAP_ROOT, { recursive: true, force: true });
  await fs.mkdir(BOOTSTRAP_ROOT, { mode: 0o700 });
  await fs.chown(BOOTSTRAP_ROOT, 0, 0);
  await fs.chmod(BOOTSTRAP_ROOT, 0o700);
  await ensureRootKitFromArchive(OLD_KIT_ARCHIVE, ACTIVE_KIT, OLD_KIT_SHA256);
  await stageCorrectedKit();
}

async function activeKitDigest() {
  return (await fs.readFile(path.join(ACTIVE_KIT, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8')).trim();
}

async function verifyKitAt(root, digest) {
  const marker = (await fs.readFile(path.join(root, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8')).trim();
  assert.equal(marker, digest);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'bootstrap-kit-manifest.json'), 'utf8'));
  assert.equal(manifest.contract, 'sonuvi.gate-c-bootstrap-kit.v2');
  assert.equal(manifest.version, 2);
  const actualFiles = [];
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const rel = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(item, rel);
      else if (rel !== '.sonuvi-bootstrap-kit-v2.sha256' && rel !== 'bootstrap-kit-manifest.json') {
        const bytes = await fs.readFile(item);
        actualFiles.push({ path: rel, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(root);
  actualFiles.sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(actualFiles, manifest.files);
  return manifest;
}

async function compileInterposer() {
  const result = run('/usr/bin/gcc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-o', interposerLibrary, interposerSource, '-ldl']);
  assertCommandOk(result, 'compile fixture-only exchange interposer');
}

async function interruptCapsuleAtExchange(operationId, phase, operation = 'replace_bootstrap_kit') {
  const marker = `/run/sonuvi-bootstrap-${operationId}-${phase}.marker`;
  await fs.rm(marker, { force: true });
  const args = capsuleArgs(operation, replacementRequest(operationId));
  const child = spawn('/usr/bin/setsid', ['/bin/sh', '-s', '--', ...args], {
    env: capsuleEnvironment({
      LD_PRELOAD: interposerLibrary,
      SONUVI_FIXTURE_EXCHANGE_INTERRUPT: phase,
      SONUVI_FIXTURE_EXCHANGE_MARKER: marker,
    }),
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: false,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(capsuleSource);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await fs.lstat(marker).then(() => true).catch(() => false)) break;
    if (child.exitCode !== null) throw new Error(`capsule exited before ${phase}-exchange interruption: ${stderr.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await fs.lstat(marker).then(() => true).catch(() => false), true, `${phase}-exchange marker was not reached`);
  process.kill(-child.pid, 'SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  await fs.rm(marker, { force: true });
}

async function copyReleaseArchive(archive, destination, expectedReleaseId) {
  const extracted = path.join('/tmp', `sonuvi-bootstrap-replacement-${expectedReleaseId}`);
  await fs.rm(extracted, { recursive: true, force: true });
  await fs.mkdir(extracted, { recursive: true, mode: 0o755 });
  assertCommandOk(run('/usr/bin/tar', ['-xf', archive, '-C', extracted]), `extract ${expectedReleaseId}`);
  assert.equal((await verifyReleaseArtifact({ artifactRoot: extracted })).releaseId, expectedReleaseId);
  const existing = await fs.lstat(destination).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!existing) await fs.cp(extracted, destination, { recursive: true, errorOnExist: true, force: false });
  else assert.equal(existing.isDirectory() && !existing.isSymbolicLink(), true, `existing release directory ${expectedReleaseId}`);
  assertCommandOk(run('/usr/bin/chown', ['-R', '0:0', destination]), `own ${expectedReleaseId}`);
  await makeTreeReadOnly(destination);
  assert.equal((await verifyReleaseArtifact({ artifactRoot: destination })).releaseId, expectedReleaseId);
  await fs.rm(extracted, { recursive: true, force: true });
}

async function writeStateFile(relative, value, mode = 0o640) {
  const target = path.join(stateRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await fs.writeFile(target, value, { mode });
  await fs.chown(target, 0, relative.startsWith('protected/') ? 0 : groupId);
  await fs.chmod(target, mode);
  return target;
}

async function writeSshAuthorization() {
  await fs.mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  await fs.chown(sshDirectory, userId, userGroupId);
  await fs.chmod(sshDirectory, 0o700);
  await fs.writeFile(sshAuthorizedKeys, sshAuthorization, { mode: 0o600 });
  await fs.chown(sshAuthorizedKeys, userId, userGroupId);
  await fs.chmod(sshAuthorizedKeys, 0o600);
}

async function verifySshAuthorization() {
  const stat = await fs.lstat(sshAuthorizedKeys);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, 'fixture SSH authorization remains a regular file');
  assert.equal(stat.uid, userId, 'fixture SSH authorization owner is preserved');
  assert.equal(stat.gid, userGroupId, 'fixture SSH authorization group is preserved');
  assert.equal(stat.mode & 0o777, 0o600, 'fixture SSH authorization mode is preserved');
  assert.equal(await fs.readFile(sshAuthorizedKeys, 'utf8'), sshAuthorization, 'fixture SSH authorization is preserved');
}

async function writeHealthControls() {
  for (const [file, value] of [
    [healthFailurePath, 'none\n'],
    [healthInterruptionPath, 'none\n'],
    [healthInterruptionAcknowledgedPath, 'none\n'],
  ]) {
    await fs.writeFile(file, value, { mode: 0o644 });
    await fs.chown(file, 0, 0);
    await fs.chmod(file, 0o644);
  }
  await fs.writeFile(healthInterruptionReachedPath, 'none\n', { mode: 0o600 });
  await fs.chown(healthInterruptionReachedPath, serviceUserId, groupId);
  await fs.chmod(healthInterruptionReachedPath, 0o600);
}

async function writeProbe() {
  const source = `
import fs from 'node:fs';
import http from 'node:http';
const kind = process.argv[2];
const releaseId = process.env.SONUVI_RELEASE_ID;
const failingRelease = fs.readFileSync('${healthFailurePath}', 'utf8').trim();
const api = kind === 'api';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const server = http.createServer(async (_request, response) => {
  // Fixture-only interruption handshake. It is reached only after the fixed
  // adapter's real systemd identity verification, then releases a valid
  // simulated health response after the fixture freezes the promoted helper.
  const interruptAfterServicesVerified = fs.readFileSync('${healthInterruptionPath}', 'utf8').trim();
  if (!api && interruptAfterServicesVerified === releaseId) {
    fs.writeFileSync('${healthInterruptionReachedPath}', releaseId + '\\n', { mode: 0o600 });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (fs.readFileSync('${healthInterruptionAcknowledgedPath}', 'utf8').trim() === releaseId) break;
      await delay(10);
    }
    if (fs.readFileSync('${healthInterruptionAcknowledgedPath}', 'utf8').trim() !== releaseId) {
      response.statusCode = 503;
      response.end('fixture interruption acknowledgement timed out\\n');
      return;
    }
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(api
    ? { contract: 'sonuvi.health.v1', ok: failingRelease !== releaseId, release: { mode: 'immutable-release', releaseId } }
    : { contract: 'sonuvi.release-web-identity.v1', releaseId }));
});
server.listen(api ? 3101 : 8101, '127.0.0.1');
`;
  await fs.writeFile('/run/sonuvi-bootstrap-replacement-probe.mjs', source, { mode: 0o755 });
  await fs.chmod('/run/sonuvi-bootstrap-replacement-probe.mjs', 0o755);
}

async function writeUnit(unit, service, releaseId) {
  const file = path.join(unitRoot, unit);
  const text = [
    '[Unit]',
    `Description=Sonuvi bootstrap replacement ${service} fixture`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'User=sonuvi',
    'Group=sonuvi',
    'WorkingDirectory=/opt/sonuvi/current',
    `Environment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${releaseId}`,
    `Environment=SONUVI_RELEASE_ID=${releaseId}`,
    `Environment=SONUVI_STATE_ROOT=${stateRoot}`,
    `Environment=SONUVI_ACTIVATION_STATE=${stateRoot}/checkpoints/release-activation-state.json`,
    'ExecStartPre=/usr/bin/node /opt/sonuvi/current/scripts/verify-current-release.mjs',
    `ExecStart=/usr/bin/node /run/sonuvi-bootstrap-replacement-probe.mjs ${service}`,
    'Restart=on-failure',
    'RestartSec=1',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  await fs.writeFile(file, text, { mode: 0o644 });
  await fs.chmod(file, 0o644);
}

async function setCurrent(releaseId) {
  await fs.unlink(path.join(layoutRoot, 'current')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await fs.symlink(`releases/${releaseId}`, path.join(layoutRoot, 'current'));
}

async function stopServices() {
  run('/usr/bin/systemctl', ['stop', 'sonuvi-web.service', 'sonuvi-api.service']);
}

async function startServices() {
  assertCommandOk(run('/usr/bin/systemctl', ['daemon-reload']), 'systemd daemon-reload');
  assertCommandOk(run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']), 'start fixture services');
}

async function assertHealth(expectedReleaseId) {
  for (const [url, kind] of [['http://127.0.0.1:3101/health', 'api'], ['http://127.0.0.1:8101/release.json', 'web']]) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.status, 200, kind);
        const value = await response.json();
        if (kind === 'api') {
          assert.equal(value.contract, 'sonuvi.health.v1');
          assert.equal(value.ok, true);
          assert.equal(value.release.releaseId, expectedReleaseId);
        } else {
          assert.equal(value.contract, 'sonuvi.release-web-identity.v1');
          assert.equal(value.releaseId, expectedReleaseId);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) {
      const status = run('/usr/bin/systemctl', ['--no-pager', '--full', 'status', `sonuvi-${kind}.service`]);
      throw new Error(`${kind} service health unavailable: ${String(status.stdout || status.stderr).slice(0, 1200)}`);
    }
  }
}

// HTTP endpoints below are fixture probes; service/process assertions remain
// against the real systemd units and their live process environments.
async function assertSystemdServiceIdentity(expectedReleaseId) {
  for (const kind of ['api', 'web']) {
    const unit = `sonuvi-${kind}.service`;
    const result = assertCommandOk(run('/usr/bin/systemctl', ['show', '--no-pager', '--property=ActiveState,SubState,MainPID,Environment', unit]), `show ${unit}`);
    const properties = Object.fromEntries(String(result.stdout).trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s)));
    assert.equal(properties.ActiveState, 'active', `${unit} is active`);
    assert.equal(properties.SubState, 'running', `${unit} is running`);
    const pid = Number(properties.MainPID);
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true, `${unit} has a main process`);
    assert.match(properties.Environment || '', new RegExp(`SONUVI_RELEASE_ID=${expectedReleaseId}`), `${unit} unit identity`);
    assert.match(properties.Environment || '', new RegExp(`SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${expectedReleaseId}`), `${unit} unit root`);
    const environment = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
    assert.equal(environment.includes(`SONUVI_RELEASE_ID=${expectedReleaseId}\0`), true, `${unit} process identity`);
    assert.equal(environment.includes(`SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${expectedReleaseId}\0`), true, `${unit} process root`);
  }
}

async function verifyPreservedState(expected = PRESERVED_STATE) {
  for (const [relative, value] of Object.entries(expected)) {
    assert.equal(await fs.readFile(path.join(stateRoot, relative), 'utf8'), value, relative);
  }
}

async function signedTestEnvelope(candidateRoot, releaseId, kitDigest, kitBytes, keyPair, keyId) {
  const manifest = await fs.readFile(path.join(candidateRoot, 'release-manifest.json'));
  const payload = {
    contract: 'sonuvi.gate-c-release-metadata.v1',
    releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { bytes: 1, format: 'sonuvi.release-tar.v1', sha256: 'f'.repeat(64) },
    bootstrap: { version: 2, sha256: kitDigest },
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  return {
    contract: 'sonuvi.gate-c-release-envelope.v1',
    keyId,
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), keyPair.privateKey).toString('base64url'),
    _testKitBytes: kitBytes,
  };
}

function expectedKitTree(manifest) {
  const dirs = new Set();
  for (const entry of manifest.files) {
    let parent = path.posix.dirname(entry.path);
    while (parent && parent !== '.') {
      dirs.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return ['bootstrap-kit-manifest.json', ...manifest.files.map((entry) => entry.path), ...dirs].sort();
}

async function assertUnsafeArchiveRejected() {
  const capsuleText = capsuleSource.toString('utf8');
  const start = capsuleText.indexOf('const SAFE_EXTRACT_PY = `');
  const end = capsuleText.indexOf('\n`;\n\nfunction validEnvelopeArgument', start);
  assert.ok(start >= 0 && end > start, 'fixed capsule archive validator is present');
  const template = capsuleText.slice(start + 'const SAFE_EXTRACT_PY = `'.length, end);
  const safeExtractPy = vm.runInNewContext(`\`${template}\``);
  const maliciousArchive = '/tmp/sonuvi-bootstrap-replacement-unsafe.tar';
  const destination = '/tmp/sonuvi-bootstrap-replacement-unsafe-extract';
  const manifestRoot = '/tmp/sonuvi-bootstrap-replacement-manifest';
  await fs.rm(maliciousArchive, { force: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rm(manifestRoot, { recursive: true, force: true });
  await fs.mkdir(manifestRoot, { mode: 0o700 });
  assertCommandOk(run('/usr/bin/tar', ['-xf', NEW_KIT_ARCHIVE, '-C', manifestRoot]), 'extract signed kit manifest for unsafe archive test');
  const builder = `import io,sys,tarfile
source,destination=sys.argv[1:3]
with tarfile.open(source, 'r:') as original, tarfile.open(destination, 'w:', format=tarfile.USTAR_FORMAT) as output:
    for member in original.getmembers():
        if member.name == 'scripts/sonuvi-release-stage.mjs':
            link=tarfile.TarInfo(member.name)
            link.type=tarfile.SYMTYPE
            link.linkname='../../tmp/sonuvi-bootstrap-unsafe-sentinel'
            link.mode=0o777
            output.addfile(link)
        else:
            source_file=original.extractfile(member) if member.isfile() else None
            output.addfile(member, source_file)
`;
  assertCommandOk(run('/usr/bin/python3', ['-c', builder, NEW_KIT_ARCHIVE, maliciousArchive]), 'build unsafe fixture archive');
  const manifest = JSON.parse(await fs.readFile(path.join(manifestRoot, 'bootstrap-kit-manifest.json'), 'utf8'));
  await fs.writeFile('/tmp/sonuvi-bootstrap-unsafe-sentinel', 'must remain unchanged\n');
  const sentinelBefore = await fs.readFile('/tmp/sonuvi-bootstrap-unsafe-sentinel', 'utf8');
  const result = run('/usr/bin/python3', ['-c', safeExtractPy, maliciousArchive, destination, JSON.stringify(expectedKitTree(manifest))]);
  assert.notEqual(result.status, 0, 'fixed archive validator rejects a signed-kit-shaped tar containing a symlink');
  assert.equal(await fs.readFile('/tmp/sonuvi-bootstrap-unsafe-sentinel', 'utf8'), sentinelBefore);
  await fs.rm('/tmp/sonuvi-bootstrap-unsafe-sentinel', { force: true });
  await fs.rm(maliciousArchive, { force: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rm(manifestRoot, { recursive: true, force: true });
}

function resetReleaseCheckpoint(previousReleaseId, originalCheckpoint) {
  run('/usr/bin/systemctl', ['stop', 'sonuvi-web.service', 'sonuvi-api.service']);
  return (async () => {
    await setCurrent(previousReleaseId);
    await writeUnit('sonuvi-api.service', 'api', previousReleaseId);
    await writeUnit('sonuvi-web.service', 'web', previousReleaseId);
    await fs.writeFile(originalCheckpoint.path, originalCheckpoint.bytes, { mode: originalCheckpoint.mode });
    await fs.chmod(originalCheckpoint.path, originalCheckpoint.mode);
    for (const relative of [
      'checkpoints/release-upgrade-state.json',
      'checkpoints/release-activation.lock',
      'checkpoints/public-traffic-open.json',
      'checkpoints/release-upgrade-backups',
    ]) await fs.rm(path.join(stateRoot, relative), { recursive: true, force: true });
    await writeHealthControls();
    await startServices();
    await assertHealth(previousReleaseId);
  })();
}

async function setupServerReleases() {
  await fs.mkdir(path.join(layoutRoot, 'releases'), { recursive: true, mode: 0o755 });
  await fs.chown(layoutRoot, 0, 0);
  await fs.chmod(layoutRoot, 0o755);
  await fs.chown(path.join(layoutRoot, 'releases'), 0, 0);
  await fs.chmod(path.join(layoutRoot, 'releases'), 0o755);
  await fs.mkdir(path.join(stateRoot, 'checkpoints'), { recursive: true, mode: 0o750 });
  await fs.chown(stateRoot, 0, 0);
  await fs.chmod(stateRoot, 0o755);
  await fs.chown(path.join(stateRoot, 'checkpoints'), 0, groupId);
  await fs.chmod(path.join(stateRoot, 'checkpoints'), 0o750);
  await fs.mkdir(unitRoot, { recursive: true, mode: 0o755 });
  await fs.mkdir('/etc/sonuvi', { recursive: true, mode: 0o755 });
  await fs.chown('/etc/sonuvi', 0, 0);
  await fs.chmod('/etc/sonuvi', 0o755);
  await fs.copyFile(ANCHORS_PATH, '/etc/sonuvi/release-trust-anchors.json');
  await fs.chown('/etc/sonuvi/release-trust-anchors.json', 0, 0);
  await fs.chmod('/etc/sonuvi/release-trust-anchors.json', 0o644);
  await fs.rm(path.join(layoutRoot, 'releases', NEW_SERVER_RELEASE_ID), { recursive: true, force: true });
  await copyReleaseArchive(OLD_RELEASE_ARCHIVE, path.join(layoutRoot, 'releases', OLD_SERVER_RELEASE_ID), OLD_SERVER_RELEASE_ID);
  for (const [relative, value] of Object.entries(PRESERVED_STATE)) {
    await writeStateFile(relative, value, relative.startsWith('protected/') ? 0o600 : 0o640);
  }
  await writeSshAuthorization();
  const checkpointPath = await writeStateFile('checkpoints/release-activation-state.json', `${JSON.stringify({
    contract: 'sonuvi.release-activation.v1',
    transactionId: crypto.randomUUID(),
    phase: 'committed',
    candidateReleaseId: OLD_SERVER_RELEASE_ID,
    previousReleaseId: null,
  }, null, 2)}\n`, 0o640);
  await fs.chown(checkpointPath, 0, groupId);
  const checkpoint = { path: checkpointPath, bytes: await fs.readFile(checkpointPath), mode: 0o640 };
  await setCurrent(OLD_SERVER_RELEASE_ID);
  await writeProbe();
  await writeHealthControls();
  await writeUnit('sonuvi-api.service', 'api', OLD_SERVER_RELEASE_ID);
  await writeUnit('sonuvi-web.service', 'web', OLD_SERVER_RELEASE_ID);
  assertCommandOk(run('/usr/bin/systemctl', ['daemon-reload']), 'initial systemd daemon-reload');
  run('/usr/bin/systemctl', ['enable', 'sonuvi-api.service', 'sonuvi-web.service']);
  assertCommandOk(run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']), 'start old Server services');
  await assertHealth(OLD_SERVER_RELEASE_ID);
  await assertSystemdServiceIdentity(OLD_SERVER_RELEASE_ID);
  return checkpoint;
}

async function activateNewServer(attemptId, overrides = {}) {
  return invokePromotedExistingInstall(existingInstallRequest(attemptId, overrides));
}

async function recoverInterruptedServerRelease() {
  return invokePromotedExistingInstall({ operation: 'recover_interrupted_upgrade', targetIdentity });
}

async function readUpgradeState() {
  return JSON.parse(await fs.readFile(upgradeStatePath, 'utf8'));
}

function waitForChildClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
}

function pauseDetachedFlockProcessTree(child) {
  assert.equal(child.exitCode === null && child.signalCode === null, true, 'promoted activation exited before the fixture-only health interruption could be paused');
  try {
    process.kill(-child.pid, 'SIGSTOP');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      throw new Error(`promoted activation process group exited before fixture-only pause; helper exit=${child.exitCode === null ? 'still running' : child.exitCode}; signal=${child.signalCode ?? 'none'}`);
    }
    throw error;
  }
}

async function killAndAwaitDetachedFlockProcessTree(child, closed) {
  // A signal-terminated ChildProcess keeps exitCode at null and records its
  // terminal signal separately. ESRCH here is therefore only tolerated after
  // the detached flock group has already disappeared; close still confirms it.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  await closed;
}

async function interruptPromotedActivation(attemptId) {
  await fs.writeFile(healthInterruptionPath, `${NEW_SERVER_RELEASE_ID}\n`, { mode: 0o644 });
  await fs.chmod(healthInterruptionPath, 0o644);
  const helper = await promotedKitHelperPath('sonuvi-existing-install-upgrade.mjs');
  const request = existingInstallRequest(attemptId);
  // detached makes the direct fixed flock command its session and process-group
  // leader. flock may fork Node, but the complete documented helper tree stays
  // in the known group addressed by -child.pid.
  const child = spawn('/usr/bin/flock', ['-n', path.join(BOOTSTRAP_ROOT, 'bootstrap-admission.lock'), '/usr/bin/node', helper], {
    env: capsuleEnvironment(),
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: true,
  });
  const childClosed = waitForChildClose(child);
  child.stdin.end(Buffer.from(JSON.stringify(request), 'utf8'));
  let state = null;
  let interruptionMarker = '';
  const interruptionDeadline = Date.now() + PROMOTED_ACTIVATION_INTERRUPTION_TIMEOUT_MS;
  try {
    while (Date.now() < interruptionDeadline) {
      interruptionMarker = await fs.readFile(healthInterruptionReachedPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
      if (interruptionMarker.trim() === NEW_SERVER_RELEASE_ID) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`promoted activation exited before the fixture-only health interruption point; helper exit=${child.exitCode === null ? 'still running' : child.exitCode}; signal=${child.signalCode ?? 'none'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, PROMOTED_ACTIVATION_INTERRUPTION_POLL_INTERVAL_MS));
    }
    if (interruptionMarker.trim() !== NEW_SERVER_RELEASE_ID) {
      throw new Error(
        `timed out after ${PROMOTED_ACTIVATION_INTERRUPTION_TIMEOUT_MS}ms waiting for promoted activation to reach the fixture-only simulated web health interruption point; ` +
        `last marker=${JSON.stringify(interruptionMarker.trim())}; helper exit=${child.exitCode === null ? 'still running' : child.exitCode}; signal=${child.signalCode ?? 'none'}`,
      );
    }
    pauseDetachedFlockProcessTree(child);
    await fs.writeFile(healthInterruptionAcknowledgedPath, `${NEW_SERVER_RELEASE_ID}\n`, { mode: 0o644 });
    await fs.chmod(healthInterruptionAcknowledgedPath, 0o644);
    state = await readUpgradeState();
    assert.equal(state?.phase, 'services-verified', 'promoted helper reached the fixture-only health interruption after real systemd restart and service verification');
    await assertSystemdServiceIdentity(NEW_SERVER_RELEASE_ID);
    assert.equal(child.exitCode === null && child.signalCode === null, true, 'fixture-only health interruption completed the promoted helper');
    await killAndAwaitDetachedFlockProcessTree(child, childClosed);
    return state;
  } finally {
    await killAndAwaitDetachedFlockProcessTree(child, childClosed);
    await fs.writeFile(healthInterruptionPath, 'none\n', { mode: 0o644 });
    await fs.chmod(healthInterruptionPath, 0o644);
    await fs.writeFile(healthInterruptionAcknowledgedPath, 'none\n', { mode: 0o644 });
    await fs.chmod(healthInterruptionAcknowledgedPath, 0o644);
  }
}

function parseJournal(operationId) {
  return fs.readFile(path.join(REPLACEMENTS, operationId, 'journal.json'), 'utf8').then(JSON.parse);
}

async function fixtureSetup() {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0) {
    throw new Error('run only as root in the isolated Debian ARM64 systemd container');
  }
  assertCommandOk(run('/usr/bin/systemctl', ['show', '--property=Version', '--value']), 'systemd fixture availability');
  await fs.writeFile(fixtureMarker, 'owned by this integration fixture\n', { mode: 0o600 });
  const testMachineId = '0123456789abcdef0123456789abcdef';
  await fs.writeFile('/etc/machine-id', `${testMachineId}\n`, { mode: 0o444 });
  await fs.chown('/etc/machine-id', 0, 0);
  await fs.chmod('/etc/machine-id', 0o444);
  targetIdentity = await readGateCTargetIdentity();
  const signed = verifySignedGateCReleaseMetadata({ envelope, trustedAnchors });
  await stopServices();
  assert.equal(signed.keyId, 'sonuvi-lab-gate-c-20261105');
  assert.equal(signed.metadata.releaseId, NEW_SERVER_RELEASE_ID);
  assert.equal(signed.metadata.bootstrap.sha256, NEW_KIT_SHA256);
  const historical = verifySignedGateCReleaseMetadata({ envelope: historicalEnvelope, trustedAnchors });
  assert.equal(historical.keyId, signed.keyId);
  assert.equal(historical.metadata.releaseId, OLD_KIT_RELEASE_ID);
  assert.equal(historical.metadata.bootstrap.sha256, OLD_KIT_SHA256);
  for (const [archivePath, expectedDigest, expectedBytes] of [
    [OLD_KIT_ARCHIVE, OLD_KIT_SHA256, 236_032],
    [NEW_KIT_ARCHIVE, NEW_KIT_SHA256, 238_592],
  ]) {
    const archive = await fs.readFile(archivePath);
    assert.equal(archive.length, expectedBytes);
    assert.equal(crypto.createHash('sha256').update(archive).digest('hex'), expectedDigest);
  }
  const installed = verifySignedGateCReleaseMetadata({ envelope: installedEnvelope, trustedAnchors });
  assert.equal(installed.keyId, signed.keyId);
  assert.equal(installed.metadata.releaseId, OLD_SERVER_RELEASE_ID);
  const historicalRelease = await fs.readFile(OLD_RELEASE_ARCHIVE);
  assert.equal(historicalRelease.length, installed.metadata.artifact.bytes);
  assert.equal(crypto.createHash('sha256').update(historicalRelease).digest('hex'), installed.metadata.artifact.sha256);
  const replacementRelease = await fs.readFile(NEW_RELEASE_ARCHIVE);
  assert.equal(replacementRelease.length, signed.metadata.artifact.bytes);
  assert.equal(crypto.createHash('sha256').update(replacementRelease).digest('hex'), signed.metadata.artifact.sha256);
  await compileInterposer();
  await ensureAdmissionGuardFixture();
  await resetBootstrapFixture();
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  await setupServerReleases();
}

test('actual historical v2 kit is replaced by the actual corrected signed kit and retained intact', async () => {
  await fixtureSetup();
  const request = replacementRequest('bkr_10000000-0000-4000-8000-000000000001');
  const result = runCapsule('replace_bootstrap_kit', request);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.response.contract, 'sonuvi.gate-c-bootstrap-kit-replacement.v1');
  assert.equal(result.response.state, 'replaced');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const journal = await parseJournal(request.operationId);
  assert.equal(journal.state, 'committed');
  assert.equal(journal.targetIdentity, targetIdentity);
  assert.equal(journal.expectedServerReleaseId, OLD_SERVER_RELEASE_ID);
  assert.equal(journal.previousBootstrapKitSHA256, OLD_KIT_SHA256);
  assert.equal(journal.replacementReleaseId, NEW_SERVER_RELEASE_ID);
  assert.equal(journal.replacementKitSHA256, NEW_KIT_SHA256);
  assert.equal(journal.signedEnvelopeSHA256, crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
  const previousRoot = path.join(REPLACEMENTS, request.operationId, 'previous');
  const previousManifest = await verifyKitAt(previousRoot, OLD_KIT_SHA256);
  assert.equal(previousManifest.releaseId, OLD_KIT_RELEASE_ID);
  const activeManifest = await verifyKitAt(ACTIVE_KIT, NEW_KIT_SHA256);
  assert.equal(activeManifest.releaseId, NEW_SERVER_RELEASE_ID);

  const repeated = runCapsule('replace_bootstrap_kit', request);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'already_replaced');
  const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'already_replaced');

  const conflict = runCapsule('replace_bootstrap_kit', replacementRequest(request.operationId, {
    previousBootstrapKitSHA256: 'f'.repeat(64),
  }));
  assert.notEqual(conflict.status, 0);
  assert.equal(conflict.response.code, 'replacement_operation_conflict');
});

test('fixed recovery records retained pre-promotion evidence after actual initial-journal interruptions and only then reopens admission', async () => {
  const safelyPrefixTruncated = (request) => {
    const complete = Buffer.from(`${JSON.stringify(initialJournal(request))}\n`, 'utf8');
    return complete.subarray(0, complete.length - 2);
  };
  const cases = [
    {
      label: 'after durable intent and before temporary file synchronization',
      contents: () => Buffer.alloc(0),
      intentDurability: { syncFile: true },
      temporaryDurability: {},
    },
    {
      label: 'after temporary file synchronization and before directory synchronization',
      contents: safelyPrefixTruncated,
      intentDurability: { syncFile: true },
      temporaryDurability: { syncFile: true },
    },
    {
      label: 'after file and directory synchronization',
      contents: safelyPrefixTruncated,
      intentDurability: { syncFile: true, syncRoot: true },
      temporaryDurability: { syncFile: true, syncRoot: true },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await resetBootstrapFixture();
    const request = replacementRequest(`bkr_11000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const intent = await writeInitialJournalIntent(request, scenario.intentDurability);
    const contents = scenario.contents(request);
    const temporary = await writeInitialJournalTemporary(request.operationId, contents, scenario.temporaryDurability);
    const intentBefore = await fs.readFile(intent.path);
    const temporaryBefore = await fs.readFile(temporary);

    await assertAdmissionBlockedForEveryOperation();
    const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
    assert.equal(recovered.status, 0, `${scenario.label}: ${recovered.stderr}`);
    assert.equal(recovered.response.contract, 'sonuvi.gate-c-bootstrap-kit-replacement.v1');
    assert.equal(recovered.response.state, 'aborted_before_promotion');
    assert.equal(await activeKitDigest(), OLD_KIT_SHA256, `${scenario.label} changed the active kit`);
    assert.equal((await verifyKitAt(ACTIVE_KIT, OLD_KIT_SHA256)).releaseId, OLD_KIT_RELEASE_ID);

    const receiptPath = path.join(REPLACEMENTS, `.initial-journal-recovery-${request.operationId}.json`);
    const receiptBefore = await fs.readFile(receiptPath);
    const receipt = JSON.parse(receiptBefore.toString('utf8'));
    assert.equal(receipt.state, 'aborted_before_promotion');
    assert.equal(receipt.targetIdentity, request.targetIdentity);
    assert.equal(receipt.activeBootstrapKitSHA256, OLD_KIT_SHA256);
    assert.equal(receipt.activeBootstrapReleaseId, OLD_KIT_RELEASE_ID);
    assert.equal(receipt.initialJournalIntentSHA256, crypto.createHash('sha256').update(intentBefore).digest('hex'));
    assert.equal(receipt.temporaryJournalSHA256, crypto.createHash('sha256').update(temporaryBefore).digest('hex'));
    assert.deepEqual(await fs.readFile(intent.path), intentBefore, `${scenario.label} deleted initial intent evidence`);
    assert.deepEqual(await fs.readFile(temporary), temporaryBefore, `${scenario.label} changed incomplete journal evidence`);

    await assertAdmissionOpenedForEveryOperation();
    const repeated = runCapsule('recover_bootstrap_kit_replacement', request);
    assert.equal(repeated.status, 0, `${scenario.label}: ${repeated.stderr}`);
    assert.equal(repeated.response.state, 'aborted_before_promotion');
    assert.deepEqual(await fs.readFile(intent.path), intentBefore, `${scenario.label} changed retained intent on retry`);
    assert.deepEqual(await fs.readFile(temporary), temporaryBefore, `${scenario.label} changed retained temporary on retry`);
    assert.deepEqual(await fs.readFile(receiptPath), receiptBefore, `${scenario.label} changed retained recovery receipt on retry`);
  }
});

test('fixed recovery fails closed without advancing initial-journal evidence for ambiguous or unverified states', async () => {
  const safelyPrefixTruncated = (request) => {
    const complete = Buffer.from(`${JSON.stringify(initialJournal(request))}\n`, 'utf8');
    return complete.subarray(0, complete.length - 2);
  };
  const evidencePaths = (operationId) => ({
    intent: path.join(REPLACEMENTS, `.initial-journal-intent-${operationId}.json`),
    temporary: path.join(REPLACEMENTS, `.journal-${operationId}.tmp`),
    recovery: path.join(REPLACEMENTS, `.initial-journal-recovery-${operationId}.json`),
    journal: path.join(REPLACEMENTS, operationId, 'journal.json'),
  });
  async function optionalBytes(candidate) {
    try { return await fs.readFile(candidate); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function snapshotEvidence(operationId) {
    const paths = evidencePaths(operationId);
    return {
      activeMarker: await fs.readFile(path.join(ACTIVE_KIT, '.sonuvi-bootstrap-kit-v2.sha256')),
      intent: await optionalBytes(paths.intent),
      temporary: await optionalBytes(paths.temporary),
      recovery: await optionalBytes(paths.recovery),
      journal: await optionalBytes(paths.journal),
    };
  }
  async function assertEvidenceUnchanged(operationId, before, label) {
    const after = await snapshotEvidence(operationId);
    assert.deepEqual(after, before, `${label} advanced or deleted recovery evidence`);
  }
  async function writePromotedJournalAmbiguity(request) {
    const operationRoot = path.join(REPLACEMENTS, request.operationId);
    await fs.mkdir(operationRoot, { mode: 0o700 });
    await fs.chown(operationRoot, 0, 0);
    await fs.chmod(operationRoot, 0o700);
    const journalPath = path.join(operationRoot, 'journal.json');
    await fs.writeFile(journalPath, `${JSON.stringify(initialJournal(request))}\n`, { mode: 0o600 });
    await fs.chown(journalPath, 0, 0);
    await fs.chmod(journalPath, 0o600);
  }
  async function corruptActiveFile() {
    const file = path.join(ACTIVE_KIT, 'scripts/sonuvi-bootstrap-status.mjs');
    const contents = Buffer.from(await fs.readFile(file));
    contents[0] ^= 1;
    await fs.writeFile(file, contents, { mode: 0o600 });
    await fs.chown(file, 0, 0);
    await fs.chmod(file, 0o600);
  }
  async function replaceActiveFileWithSymlink() {
    const file = path.join(ACTIVE_KIT, 'scripts/sonuvi-bootstrap-status.mjs');
    const retained = `${file}.retained`;
    await fs.rename(file, retained);
    await fs.symlink(retained, file);
  }
  async function expectInitialRecoveryFailure(index, scenario) {
    await resetBootstrapFixture();
    const request = replacementRequest(`bkr_12000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const intentRequest = scenario.omitIntent ? null : (scenario.intentRequest?.(request) || request);
    if (intentRequest) await writeInitialJournalIntent(intentRequest, { syncFile: true, syncRoot: true });
    await writeInitialJournalTemporary(request.operationId, scenario.contents?.(request) || safelyPrefixTruncated(request), { syncFile: true, syncRoot: true });
    await scenario.mutate?.(request);
    const before = await snapshotEvidence(request.operationId);

    await assertAdmissionBlockedForEveryOperation();
    expectCapsuleFailure('recover_bootstrap_kit_replacement', request, scenario.code || 'replacement_recovery_required');
    await assertEvidenceUnchanged(request.operationId, before, scenario.label);
    await assertAdmissionBlockedForEveryOperation();
  }

  const scenarios = [
    {
      label: 'arbitrary malformed partial journal',
      contents: () => Buffer.from('{not-json\n', 'utf8'),
    },
    {
      label: 'missing matching initial intent',
      omitIntent: true,
    },
    {
      label: 'mismatched durable initial intent',
      intentRequest: (request) => replacementRequest(request.operationId, { previousBootstrapKitSHA256: 'f'.repeat(64) }),
    },
    {
      label: 'transaction directory with promoted journal beside initial evidence',
      mutate: writePromotedJournalAmbiguity,
    },
    {
      label: 'active kit payload corruption with retained marker',
      code: 'replacement_kit_inventory_invalid',
      mutate: corruptActiveFile,
    },
    {
      label: 'active kit symlink substitution',
      code: 'replacement_kit_inventory_invalid',
      mutate: replaceActiveFileWithSymlink,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) await expectInitialRecoveryFailure(index, scenario);

  await resetBootstrapFixture();
  const identityRequest = replacementRequest('bkr_12000000-0000-4000-8000-000000000007');
  const identityIntent = await writeInitialJournalIntent(identityRequest, { syncFile: true, syncRoot: true });
  const identityTemporary = await writeInitialJournalTemporary(identityRequest.operationId, safelyPrefixTruncated(identityRequest), { syncFile: true, syncRoot: true });
  await assertAdmissionBlockedForEveryOperation();
  const recovered = runCapsule('recover_bootstrap_kit_replacement', identityRequest);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'aborted_before_promotion');
  const evidenceBeforeIdentityMismatch = await snapshotEvidence(identityRequest.operationId);
  const manifestPath = path.join(ACTIVE_KIT, 'bootstrap-kit-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.releaseId = `sonuvi-${'f'.repeat(64)}`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.chown(manifestPath, 0, 0);
  await fs.chmod(manifestPath, 0o600);

  expectCapsuleFailure('recover_bootstrap_kit_replacement', identityRequest, 'replacement_recovery_required');
  await assertEvidenceUnchanged(identityRequest.operationId, evidenceBeforeIdentityMismatch, 'active release identity mismatch');
  assert.deepEqual(await fs.readFile(identityIntent.path), evidenceBeforeIdentityMismatch.intent);
  assert.deepEqual(await fs.readFile(identityTemporary), evidenceBeforeIdentityMismatch.temporary);
  await assertAdmissionBlockedForEveryOperation();
});
test('invalid signature, target, release, ownership, mode, symlink, digest, and previous-kit bindings fail closed', async () => {
  await resetBootstrapFixture();
  const base = replacementRequest('bkr_20000000-0000-4000-8000-000000000001');

  const invalidSignature = structuredClone(envelope);
  invalidSignature.signature = `${invalidSignature.signature[0] === 'A' ? 'B' : 'A'}${invalidSignature.signature.slice(1)}`;
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000002', { envelope: invalidSignature }), 'replacement_signature_invalid');
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000003', { targetIdentity: `sonuvi-target-v1-${'f'.repeat(64)}` }), 'replacement_target_mismatch');
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000004', { replacementReleaseId: `sonuvi-${'f'.repeat(64)}` }), 'replacement_release_mismatch');
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000005', { previousBootstrapKitSHA256: 'f'.repeat(64) }), 'previous_bootstrap_mismatch');

  await fs.chown(STAGED_KIT, 0, 0);
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000006'), 'staging_owner_invalid');
  await fs.chown(STAGED_KIT, userId, userGroupId);
  await fs.chmod(STAGED_KIT, 0o644);
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000007'), 'staging_mode_invalid');
  await fs.chmod(STAGED_KIT, 0o600);

  const moved = `${STAGED_KIT}.evidence`;
  await fs.rename(STAGED_KIT, moved);
  await fs.symlink(NEW_KIT_ARCHIVE, STAGED_KIT);
  expectCapsuleFailure('replace_bootstrap_kit', replacementRequest('bkr_20000000-0000-4000-8000-000000000008'), 'staging_source_invalid');
  await fs.unlink(STAGED_KIT);
  await fs.rename(moved, STAGED_KIT);

  const original = await fs.readFile(STAGED_KIT);
  const damaged = Buffer.from(original);
  damaged[1024] ^= 1;
  await stageCorrectedKit(damaged);
  const digestRequest = replacementRequest('bkr_20000000-0000-4000-8000-000000000009');
  expectCapsuleFailure('replace_bootstrap_kit', digestRequest, 'replacement_kit_digest_invalid');
  const recovery = runCapsule('recover_bootstrap_kit_replacement', digestRequest);
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(recovery.response.state, 'aborted_before_promotion');
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  assert.equal(await fs.stat(path.join(REPLACEMENTS, digestRequest.operationId, 'incoming.tar')).then((value) => value.size), original.length);
  await stageCorrectedKit(original);

  const invalidSize = replacementRequest('bkr_20000000-0000-4000-8000-000000000010', { replacementKitBytes: 238_591 });
  expectCapsuleFailure('replace_bootstrap_kit', invalidSize, 'replacement_kit_size_invalid');
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  assert.equal(base.replacementKitSHA256, NEW_KIT_SHA256);
});

test('interruption before atomic exchange recovers to the intact old kit without promotion', async () => {
  await resetBootstrapFixture();
  const request = replacementRequest('bkr_30000000-0000-4000-8000-000000000001');
  await interruptCapsuleAtExchange(request.operationId, 'before');
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'aborted_before_promotion');
  assert.equal(await verifyKitAt(ACTIVE_KIT, OLD_KIT_SHA256).then((value) => value.releaseId), OLD_KIT_RELEASE_ID);
  assert.equal((await parseJournal(request.operationId)).state, 'aborted_before_promotion');
});

test('interruption after atomic exchange recovers the new active kit and preserved old kit idempotently', async () => {
  await resetBootstrapFixture();
  const request = replacementRequest('bkr_30000000-0000-4000-8000-000000000002');
  await interruptCapsuleAtExchange(request.operationId, 'after');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'committed_after_interruption');
  const previous = await verifyKitAt(path.join(REPLACEMENTS, request.operationId, 'previous'), OLD_KIT_SHA256);
  assert.equal(previous.releaseId, OLD_KIT_RELEASE_ID);
  assert.equal((await parseJournal(request.operationId)).state, 'committed');
  const repeated = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'already_replaced');
});

test('admission-lock contention is rejected, and the fixed archive validator rejects unsafe tar entries', async () => {
  await resetBootstrapFixture();
  const admissionLock = path.join(BOOTSTRAP_ROOT, 'bootstrap-admission.lock');
  await fs.writeFile(admissionLock, '', { mode: 0o600 });
  await fs.chown(admissionLock, 0, 0);
  await fs.chmod(admissionLock, 0o600);
  const holder = spawn('/usr/bin/flock', ['-n', admissionLock, '/usr/bin/sleep', '30'], { stdio: 'ignore', detached: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(holder.exitCode, null);
  const request = replacementRequest('bkr_40000000-0000-4000-8000-000000000001');
  expectCapsuleFailure('recover_bootstrap_kit_replacement', request, 'operation_busy');
  process.kill(-holder.pid, 'SIGTERM');
  await new Promise((resolve) => holder.once('close', resolve));
  const noRecovery = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(noRecovery.status, 0, noRecovery.stderr);
  assert.equal(noRecovery.response.state, 'no_recovery_required');
  await assertUnsafeArchiveRejected();
});

test('promoted-kit fixed helpers reject bad framing and identities before staged activation', async () => {
  await fixtureSetup();
  const replacement = replacementRequest('bkr_41000000-0000-4000-8000-000000000001');
  assert.equal(runCapsule('replace_bootstrap_kit', replacement).response.state, 'replaced');
  const wrongTarget = `sonuvi-target-v1-${'f'.repeat(64)}`;
  const malformedStage = await runPromotedKitHelper('sonuvi-release-stage.mjs', Buffer.from('{"operation":"stage_release"}\n', 'utf8'));
  assert.notEqual(malformedStage.status, 0);
  assert.equal(malformedStage.response.ok, false);
  assert.equal(malformedStage.response.code, 'stage_input_invalid');
  const wrongStage = await stageNewServerRelease('boot_bootstrap_fixture_wrong_target_20261109', { targetIdentity: wrongTarget });
  assert.notEqual(wrongStage.status, 0);
  assert.equal(wrongStage.response.code, 'stage_target_mismatch');
  const malformedUpgrade = await runPromotedKitHelper('sonuvi-existing-install-upgrade.mjs', Buffer.from('{', 'utf8'));
  assert.notEqual(malformedUpgrade.status, 0);
  assert.equal(malformedUpgrade.response.code, 'upgrade_input_invalid');
  const wrongUpgrade = await activateNewServer('boot_bootstrap_fixture_wrong_target_20261109', { targetIdentity: wrongTarget });
  assert.notEqual(wrongUpgrade.status, 0);
  assert.equal(wrongUpgrade.response.code, 'upgrade_target_mismatch');
  const admissionLock = await ensureAdmissionLock();
  const holder = spawn('/usr/bin/flock', ['-n', admissionLock, '/usr/bin/sleep', '30'], { stdio: 'ignore', detached: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const locked = await runPromotedKitHelper('sonuvi-release-stage.mjs', Buffer.from('{"operation":"stage_release"}\n', 'utf8'), { requireResponse: false });
  assert.notEqual(locked.status, 0, 'the fixed flock command must reject concurrent admission before Node opens the helper');
  assert.equal(locked.response, null, 'the contended fixed command must not load a release helper');
  process.kill(-holder.pid, 'SIGTERM');
  await new Promise((resolve) => holder.once('close', resolve));
  const staged = await stageNewServerRelease('boot_bootstrap_fixture_framing_20261109');
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.response.ok, true);
  assert.equal(staged.response.state, 'staged');
  const repeated = await stageNewServerRelease('boot_bootstrap_fixture_framing_20261109');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'already_staged');
});

test('successful replacement permits real historical Server upgrade; failed activation rolls back release and preserves state', async () => {
  await resetBootstrapFixture();
  const replacement = replacementRequest('bkr_50000000-0000-4000-8000-000000000001');
  const replaced = runCapsule('replace_bootstrap_kit', replacement);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);

  const originalCheckpoint = await setupServerReleases();
  assert.equal(await readGateCTargetIdentity(), targetIdentity);
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), OLD_SERVER_RELEASE_ID);
  assert.equal(await fs.lstat(path.join(stateRoot, 'checkpoints/release-activation.lock')).then(() => true).catch(() => false), false);

  const successAttempt = 'boot_bootstrap_fixture_success_20261109';
  const staged = await stageNewServerRelease(successAttempt);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.response.ok, true);
  assert.equal(staged.response.contract, 'sonuvi.gate-c-stage-response.v1');
  assert.equal(staged.response.operation, 'stage_release');
  assert.equal(staged.response.state, 'staged');
  assert.equal(staged.response.releaseId, NEW_SERVER_RELEASE_ID);
  const repeatedStage = await stageNewServerRelease(successAttempt);
  assert.equal(repeatedStage.status, 0, repeatedStage.stderr);
  assert.equal(repeatedStage.response.state, 'already_staged');

  const successful = await activateNewServer(successAttempt);
  assert.equal(successful.status, 0, successful.stderr);
  assert.equal(successful.response.ok, true);
  assert.equal(successful.response.contract, 'sonuvi.gate-c-existing-install-upgrade.v1');
  assert.equal(successful.response.operation, 'activate_existing_install');
  assert.equal(successful.response.state, 'committed');
  assert.equal(successful.response.releaseId, NEW_SERVER_RELEASE_ID);
  assert.equal(successful.response.previousReleaseId, OLD_SERVER_RELEASE_ID);
  assert.equal(successful.response.attemptId, successAttempt);
  assert.equal(successful.response.targetIdentity, targetIdentity);
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), NEW_SERVER_RELEASE_ID);
  await assertSystemdServiceIdentity(NEW_SERVER_RELEASE_ID);
  await assertHealth(NEW_SERVER_RELEASE_ID);
  await verifyPreservedState();
  await verifySshAuthorization();
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const committedState = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(committedState.phase, 'committed');
  assert.equal(await fs.lstat(path.join(stateRoot, 'checkpoints/release-activation.lock')).then(() => true).catch(() => false), false);
  expectCapsuleFailure('rollback_bootstrap_kit', replacement, 'current_release_mismatch');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256, 'bootstrap rollback cannot downgrade the recovery kit after Server release activation');

  await resetReleaseCheckpoint(OLD_SERVER_RELEASE_ID, originalCheckpoint);
  await fs.writeFile(healthFailurePath, `${NEW_SERVER_RELEASE_ID}\n`);
  await fs.chmod(healthFailurePath, 0o644);
  const rollbackAttempt = 'boot_bootstrap_fixture_rollback_20261109';
  const restaged = await stageNewServerRelease(rollbackAttempt);
  assert.equal(restaged.status, 0, restaged.stderr);
  assert.equal(restaged.response.state, 'already_staged');
  const failed = await activateNewServer(rollbackAttempt);
  assert.notEqual(failed.status, 0, 'simulated health failure unexpectedly committed');
  assert.equal(failed.response.ok, false);
  assert.equal(failed.response.code, 'upgrade_activation_failed');
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), OLD_SERVER_RELEASE_ID);
  await assertSystemdServiceIdentity(OLD_SERVER_RELEASE_ID);
  await assertHealth(OLD_SERVER_RELEASE_ID);
  await verifyPreservedState();
  await verifySshAuthorization();
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const rolledBackState = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(rolledBackState.phase, 'rolled-back');
  assert.equal(await fs.lstat(path.join(stateRoot, 'checkpoints/release-activation.lock')).then(() => true).catch(() => false), false);
  const terminalRecovery = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(['committed', 'rolled-back'].includes(terminalRecovery.phase), true);
});

test('bootstrap recovery completes before the promoted-kit Server interruption recovery', async () => {
  await fixtureSetup();
  const replacement = replacementRequest('bkr_51000000-0000-4000-8000-000000000001');
  await interruptCapsuleAtExchange(replacement.operationId, 'after');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  await assertAdmissionBlockedForEveryOperation();
  const actualAdmission = await runPromotedAdmissionGuard('stage_release');
  assert.notEqual(actualAdmission.status, 0, 'unresolved bootstrap recovery must reject the actual promoted helper path');
  assert.equal(actualAdmission.response.code, 'bootstrap_recovery_required');
  const bootstrapRecovered = runCapsule('recover_bootstrap_kit_replacement', replacement);
  assert.equal(bootstrapRecovered.status, 0, bootstrapRecovered.stderr);
  assert.equal(bootstrapRecovered.response.state, 'committed_after_interruption');
  await verifyKitAt(ACTIVE_KIT, NEW_KIT_SHA256);

  const attemptId = 'boot_bootstrap_fixture_interrupted_20261109';
  const staged = await stageNewServerRelease(attemptId);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.response.state, 'staged');
  assert.equal(await fs.lstat(path.join(layoutRoot, 'releases', NEW_SERVER_RELEASE_ID)).then(() => true).catch(() => false), false, 'only the fixed activation helper promotes the staged release to the host inventory');
  const interrupted = await interruptPromotedActivation(attemptId);
  assert.equal(interrupted.phase, 'services-verified');
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), NEW_SERVER_RELEASE_ID);
  assert.equal(await fs.lstat(releaseLockPath).then(() => true).catch(() => false), true);
  const recovered = await recoverInterruptedServerRelease();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.ok, true);
  assert.equal(recovered.response.operation, 'recover_interrupted_upgrade');
  assert.equal(recovered.response.state, 'recovered');
  assert.equal(recovered.response.previousReleaseId, OLD_SERVER_RELEASE_ID);
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), OLD_SERVER_RELEASE_ID);
  await assertSystemdServiceIdentity(OLD_SERVER_RELEASE_ID);
  await assertHealth(OLD_SERVER_RELEASE_ID);
  await verifyPreservedState();
  await verifySshAuthorization();
  await verifyKitAt(ACTIVE_KIT, NEW_KIT_SHA256);
  await verifyKitAt(path.join(REPLACEMENTS, replacement.operationId, 'previous'), OLD_KIT_SHA256);
  assert.equal(await fs.lstat(releaseLockPath).then(() => true).catch(() => false), false);
  const repeated = await recoverInterruptedServerRelease();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'no-recovery-required');
});

test('bootstrap rollback uses only the preserved verified directory exchange', async () => {
  await resetBootstrapFixture();
  const request = replacementRequest('bkr_60000000-0000-4000-8000-000000000001');
  assert.equal(runCapsule('replace_bootstrap_kit', request).response.state, 'replaced');
  const rolledBack = runCapsule('rollback_bootstrap_kit', request);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(rolledBack.response.state, 'rolled_back');
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  await verifyKitAt(path.join(REPLACEMENTS, request.operationId, 'previous'), NEW_KIT_SHA256);
  const repeated = runCapsule('rollback_bootstrap_kit', request);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'already_rolled_back');
});

test('idempotent rollback recovery verifies complete kit trees before reporting success', async () => {
  const kitFile = 'scripts/sonuvi-bootstrap-status.mjs';

  async function rollbackPrepared(operationId) {
    await resetBootstrapFixture();
    const request = replacementRequest(operationId);
    const replaced = runCapsule('replace_bootstrap_kit', request);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(replaced.response.state, 'replaced');
    await interruptCapsuleAtExchange(operationId, 'before', 'rollback_bootstrap_kit');
    const operationRoot = path.join(REPLACEMENTS, operationId);
    assert.equal((await parseJournal(operationId)).state, 'rollback_prepared');
    return { operationRoot, previous: path.join(operationRoot, 'previous'), request };
  }

  async function rolledBack(operationId) {
    await resetBootstrapFixture();
    const request = replacementRequest(operationId);
    const replaced = runCapsule('replace_bootstrap_kit', request);
    assert.equal(replaced.status, 0, replaced.stderr);
    const rollback = runCapsule('rollback_bootstrap_kit', request);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(rollback.response.state, 'rolled_back');
    return { operationRoot: path.join(REPLACEMENTS, operationId), request };
  }

  async function assertJournalUnchanged(operationId, before, expectedState, label) {
    const journal = await fs.readFile(path.join(REPLACEMENTS, operationId, 'journal.json'));
    assert.deepEqual(journal, before, label + ' rewrote recovery evidence');
    assert.equal(JSON.parse(journal.toString('utf8')).state, expectedState, label + ' advanced the recovery journal');
  }

  async function corruptKitFile(root) {
    const target = path.join(root, kitFile);
    const bytes = Buffer.from(await fs.readFile(target));
    assert.notEqual(bytes.length, 0, 'fixture kit file has content');
    bytes[0] ^= 1;
    await fs.writeFile(target, bytes, { mode: 0o600 });
    await fs.chown(target, 0, 0);
    await fs.chmod(target, 0o600);
  }

  async function expectPreparedFailure(operationId, label, code, mutate) {
    const fixture = await rollbackPrepared(operationId);
    const before = await fs.readFile(path.join(fixture.operationRoot, 'journal.json'));
    await mutate(fixture);
    const result = runCapsule('recover_bootstrap_kit_replacement', fixture.request);
    assert.notEqual(result.status, 0, label + ' unexpectedly reported recovery success');
    assert.equal(result.response.ok, false, label + ' returned an untyped recovery response');
    assert.equal(result.response.code, code, label + ' returned the wrong typed failure');
    await assertJournalUnchanged(operationId, before, 'rollback_prepared', label);
  }

  const validPrepared = await rollbackPrepared('bkr_71000000-0000-4000-8000-000000000001');
  const reconciled = runCapsule('recover_bootstrap_kit_replacement', validPrepared.request);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.equal(reconciled.response.state, 'already_replaced');
  await verifyKitAt(ACTIVE_KIT, NEW_KIT_SHA256);
  await verifyKitAt(validPrepared.previous, OLD_KIT_SHA256);
  assert.equal((await parseJournal(validPrepared.request.operationId)).state, 'committed');

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000002', 'matching markers with corrupted active contents', 'replacement_kit_inventory_invalid', async () => {
    await corruptKitFile(ACTIVE_KIT);
    assert.equal(await activeKitDigest(), NEW_KIT_SHA256, 'corruption must retain the matching marker');
  });

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000003', 'missing preserved kit', 'replacement_recovery_required', async ({ previous }) => {
    await fs.rm(previous, { recursive: true, force: true });
  });

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000004', 'preserved kit ownership change', 'replacement_kit_inventory_invalid', async ({ previous }) => {
    await fs.chown(path.join(previous, kitFile), userId, userGroupId);
  });

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000005', 'preserved kit permission change', 'replacement_kit_inventory_invalid', async ({ previous }) => {
    await fs.chmod(path.join(previous, kitFile), 0o644);
  });

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000006', 'preserved kit symlink substitution', 'replacement_kit_inventory_invalid', async ({ previous }) => {
    const target = path.join(previous, kitFile);
    const evidence = target + '.evidence';
    await fs.rename(target, evidence);
    await fs.symlink(evidence, target);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
  });

  await expectPreparedFailure('bkr_71000000-0000-4000-8000-000000000007', 'replacement release identity mismatch', 'replacement_recovery_required', async () => {
    const manifestPath = path.join(ACTIVE_KIT, 'bootstrap-kit-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.releaseId = 'sonuvi-' + 'f'.repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await fs.chown(manifestPath, 0, 0);
    await fs.chmod(manifestPath, 0o600);
  });

  const validRolledBack = await rolledBack('bkr_71000000-0000-4000-8000-000000000008');
  const repeated = runCapsule('replace_bootstrap_kit', validRolledBack.request);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.response.state, 'already_rolled_back');
  await verifyKitAt(ACTIVE_KIT, OLD_KIT_SHA256);

  const corruptedRolledBack = await rolledBack('bkr_71000000-0000-4000-8000-000000000009');
  const terminalEvidence = await fs.readFile(path.join(corruptedRolledBack.operationRoot, 'journal.json'));
  await corruptKitFile(ACTIVE_KIT);
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256, 'terminal corruption must retain the matching marker');
  const terminalRetry = runCapsule('replace_bootstrap_kit', corruptedRolledBack.request);
  assert.notEqual(terminalRetry.status, 0, 'corrupted rolled-back active kit unexpectedly reported idempotent success');
  assert.equal(terminalRetry.response.ok, false);
  assert.equal(terminalRetry.response.code, 'replacement_kit_inventory_invalid');
  await assertJournalUnchanged(corruptedRolledBack.request.operationId, terminalEvidence, 'rolled_back', 'terminal active-kit corruption');
});

test('interrupted bootstrap rollback before exchange preserves the replacement until fixed recovery reconciles it', async () => {
  await resetBootstrapFixture();
  const request = replacementRequest('bkr_70000000-0000-4000-8000-000000000000');
  assert.equal(runCapsule('replace_bootstrap_kit', request).response.state, 'replaced');
  await interruptCapsuleAtExchange(request.operationId, 'before', 'rollback_bootstrap_kit');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);

  const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'already_replaced');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  assert.equal((await parseJournal(request.operationId)).state, 'committed');
});

test('interrupted bootstrap rollback retains the replacement while a Server release transaction is unresolved', async () => {
  await resetBootstrapFixture();
  const request = replacementRequest('bkr_70000000-0000-4000-8000-000000000001');
  assert.equal(runCapsule('replace_bootstrap_kit', request).response.state, 'replaced');
  await interruptCapsuleAtExchange(request.operationId, 'after', 'rollback_bootstrap_kit');
  assert.equal(await activeKitDigest(), OLD_KIT_SHA256);
  const releaseLock = path.join(stateRoot, 'checkpoints/release-activation.lock');
  await fs.writeFile(releaseLock, '', { mode: 0o600 });
  await fs.chown(releaseLock, 0, 0);
  await fs.chmod(releaseLock, 0o600);

  const recovered = runCapsule('recover_bootstrap_kit_replacement', request);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.response.state, 'committed_after_interruption');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  assert.equal((await parseJournal(request.operationId)).state, 'committed');
  await fs.unlink(releaseLock);
});
