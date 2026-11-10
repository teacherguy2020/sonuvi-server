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
import { activateReleaseTransaction } from '../../../src/lib/release-activation.mjs';
import {
  GATE_C_BOOTSTRAP_ADMISSION_OPERATIONS,
  gateCBootstrapAdmissionGuardProgram,
} from '../../../src/lib/sonuvi-gate-c-bootstrap-replacement-contract.mjs';
import { createLinuxSystemdUpgradeAdapter } from '../../../src/lib/sonuvi-linux-systemd-upgrade.mjs';

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
const fixtureMarker = '/run/sonuvi-bootstrap-replacement-fixture-owned';
const interposerSource = '/sonuvi/test/fixtures/systemd-upgrade/renameat2-interrupt.c';
const interposerLibrary = '/tmp/sonuvi-bootstrap-replacement-interrupt.so';
const admissionGuardHelper = '/tmp/sonuvi-bootstrap-admission-helper.mjs';
const admissionGuardMarker = '/run/sonuvi-bootstrap-admission-helper-loaded';
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

async function writeProbe() {
  const source = `
import fs from 'node:fs';
import http from 'node:http';
const kind = process.argv[2];
const releaseId = process.env.SONUVI_RELEASE_ID;
const failingRelease = fs.readFileSync('${healthFailurePath}', 'utf8').trim();
const api = kind === 'api';
const server = http.createServer((_request, response) => {
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
    await fs.writeFile(healthFailurePath, 'none\n');
    await fs.chmod(healthFailurePath, 0o644);
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
  await copyReleaseArchive(OLD_RELEASE_ARCHIVE, path.join(layoutRoot, 'releases', OLD_SERVER_RELEASE_ID), OLD_SERVER_RELEASE_ID);
  await copyReleaseArchive(NEW_RELEASE_ARCHIVE, path.join(layoutRoot, 'releases', NEW_SERVER_RELEASE_ID), NEW_SERVER_RELEASE_ID);
  for (const [relative, value] of Object.entries(PRESERVED_STATE)) {
    await writeStateFile(relative, value, relative.startsWith('protected/') ? 0o600 : 0o640);
  }
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
  await fs.writeFile(healthFailurePath, 'none\n', { mode: 0o644 });
  await fs.chmod(healthFailurePath, 0o644);
  await writeUnit('sonuvi-api.service', 'api', OLD_SERVER_RELEASE_ID);
  await writeUnit('sonuvi-web.service', 'web', OLD_SERVER_RELEASE_ID);
  assertCommandOk(run('/usr/bin/systemctl', ['daemon-reload']), 'initial systemd daemon-reload');
  run('/usr/bin/systemctl', ['enable', 'sonuvi-api.service', 'sonuvi-web.service']);
  assertCommandOk(run('/usr/bin/systemctl', ['start', 'sonuvi-api.service', 'sonuvi-web.service']), 'start old Server services');
  await assertHealth(OLD_SERVER_RELEASE_ID);
  return checkpoint;
}

async function activateNewServer(releaseId, attemptId) {
  const candidate = { releaseId, root: path.join(layoutRoot, 'releases', releaseId) };
  const previous = { releaseId: OLD_SERVER_RELEASE_ID, root: path.join(layoutRoot, 'releases', OLD_SERVER_RELEASE_ID) };
  const verifiedEnvelope = JSON.parse(await fs.readFile(ENVELOPE_PATH, 'utf8'));
  return activateReleaseTransaction({
    layoutRoot,
    stateRoot,
    ownerUID: 0,
    releaseId,
    expectedPreviousReleaseId: previous.releaseId,
    attemptId,
    targetIdentity,
    envelope: verifiedEnvelope,
    trustedAnchors,
    adapter: createLinuxSystemdUpgradeAdapter(),
  });
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

  const successful = await activateNewServer(NEW_SERVER_RELEASE_ID, 'boot_bootstrap_fixture_success_20261109');
  assert.equal(successful.releaseId, NEW_SERVER_RELEASE_ID);
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), NEW_SERVER_RELEASE_ID);
  await assertHealth(NEW_SERVER_RELEASE_ID);
  await verifyPreservedState();
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const committedState = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(committedState.phase, 'committed');
  assert.equal(await fs.lstat(path.join(stateRoot, 'checkpoints/release-activation.lock')).then(() => true).catch(() => false), false);
  expectCapsuleFailure('rollback_bootstrap_kit', replacement, 'current_release_mismatch');
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256, 'bootstrap rollback cannot downgrade the recovery kit after Server release activation');

  await resetReleaseCheckpoint(OLD_SERVER_RELEASE_ID, originalCheckpoint);
  await fs.writeFile(healthFailurePath, `${NEW_SERVER_RELEASE_ID}\n`);
  await fs.chmod(healthFailurePath, 0o644);
  await assert.rejects(
    activateNewServer(NEW_SERVER_RELEASE_ID, 'boot_bootstrap_fixture_rollback_20261109'),
    /health|activation failed/i,
  );
  assert.equal((await fs.realpath(path.join(layoutRoot, 'current'))).split(path.sep).at(-1), OLD_SERVER_RELEASE_ID);
  await assertHealth(OLD_SERVER_RELEASE_ID);
  await verifyPreservedState();
  assert.equal(await activeKitDigest(), NEW_KIT_SHA256);
  const rolledBackState = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(rolledBackState.phase, 'rolled-back');
  assert.equal(await fs.lstat(path.join(stateRoot, 'checkpoints/release-activation.lock')).then(() => true).catch(() => false), false);
  const terminalRecovery = JSON.parse(await fs.readFile(path.join(stateRoot, 'checkpoints/release-upgrade-state.json'), 'utf8'));
  assert.equal(['committed', 'rolled-back'].includes(terminalRecovery.phase), true);
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
