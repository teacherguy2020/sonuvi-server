import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { FirstAdministratorEnrollment } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { authorizeFirstController } from '../src/lib/sonuvi-first-controller-handoff.mjs';
import { buildGateB2ReadinessPackage } from '../src/lib/sonuvi-gate-b2-package.mjs';
import { makeTreeWritableForCleanup } from '../src/lib/release-artifact.mjs';
import { createFixedServiceAccount, createFixedSystemd, provisionServiceReadableConfiguration, provisionWritableStateOwnership, runFixedTargetInstallation, TARGET_WRITABLE_STATE_DIRECTORIES } from '../src/lib/sonuvi-target-installer.mjs';
import crypto from 'node:crypto';

const attemptId = 'boot_0123456789abcdef'; const targetIdentity = 'machine_0123456789abcdef';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-b2-'));
  t.after(async () => {
    const releases = path.join(root, 'opt', 'sonuvi', 'releases');
    for (const entry of await fs.readdir(releases).catch(() => [])) await makeTreeWritableForCleanup(path.join(releases, entry)).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
test('first-controller handoff requires an administrator and reuses mobile-only bearer scope', async (t) => {
  const root = await fixture(t); const enrollment = new FirstAdministratorEnrollment({ stateRoot: root }); const issued = await enrollment.create({ attemptId, targetIdentity }); const authority = new AdministratorAuthority({ stateRoot: root }); const admin = await authority.initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken: issued.enrollmentToken, administratorDeviceId: 'device_admin_0123456789', administratorPublicKey: 'admin-key' }); const adminToken = await authority.issueAccessToken({ administratorId: admin.administratorId });
  const handoff = await authorizeFirstController({ authority, administratorToken: adminToken, mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }); assert.equal(handoff.scope, 'mobile-api'); assert.equal(handoff.accessToken.includes(adminToken), false);
  const record = JSON.parse(await fs.readFile(path.join(root, 'protected', 'first-controller-pairing.json'), 'utf8'));
  assert.equal(record.accessTokenHash, crypto.createHash('sha256').update(handoff.accessToken).digest('base64url'));
  await assert.rejects(authorizeFirstController({ authority, administratorToken: 'controller-token', mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }), /required/);
});

test('fixed systemd adapter permits only reviewed units and verbs', async () => {
  const calls = []; const systemd = createFixedSystemd({ run: async (args) => { calls.push(args); } });
  await systemd.daemonReload(); await systemd.enableAndStart('sonuvi-api.service');
  assert.equal(await systemd.isHealthy('sonuvi-web.service'), true);
  assert.deepEqual(calls, [['daemon-reload'], ['enable', '--now', 'sonuvi-api.service'], ['is-active', '--quiet', 'sonuvi-web.service']]);
  await assert.rejects(systemd.enableAndStart('ssh.service'), /unapproved/);
});

test('fixed target installer has no caller-controlled paths or commands', async (t) => {
  const root = await fixture(t); const releaseId = `sonuvi-${'a'.repeat(64)}`;
  const staging = path.join(root, 'bootstrap', 'releases', releaseId);
  await fs.mkdir(path.join(staging, 'ops', 'systemd'), { recursive: true });
  await fs.writeFile(path.join(staging, 'ops', 'systemd', 'sonuvi-api.service.in'), 'api=@RELEASE_ID@');
  await fs.writeFile(path.join(staging, 'ops', 'systemd', 'sonuvi-web.service.in'), 'web=@RELEASE_ID@');
  const request = { attemptId, targetIdentity, releaseId, serverIdentity: 'sonuvi-lab-01' };
  const paths = { layoutRoot: path.join(root, 'opt', 'sonuvi'), stateRoot: path.join(root, 'var', 'lib', 'sonuvi'), unitRoot: path.join(root, 'etc', 'systemd', 'system'), bootstrapReleaseRoot: path.join(root, 'bootstrap', 'releases') };
  let configurationAccessCalled = false;
  const calls = []; const systemd = createFixedSystemd({ run: async (args) => {
    if (args[0] === 'enable') {
      const installed = path.join(paths.layoutRoot, 'releases', releaseId);
      assert.equal((await fs.stat(installed)).mode & 0o777, 0o555);
      assert.equal((await fs.stat(path.join(installed, 'ops', 'systemd', 'sonuvi-api.service.in'))).mode & 0o777, 0o444);
      assert.equal(configurationAccessCalled, true);
    }
    calls.push(args);
  } });
  const serviceAccount = { ensure: async () => 'fixture' };
  const ownershipCalls = []; const ownership = async ({ stateRoot }) => { ownershipCalls.push(stateRoot); };
  const configurationAccess = async ({ stateRoot }) => { assert.equal(stateRoot, paths.stateRoot); configurationAccessCalled = true; };
  const result = await runFixedTargetInstallation({ request, paths, platform: 'linux', architecture: 'arm64', uid: 0, systemd, serviceAccount, ownership, configurationAccess, health: async () => true, verifyArtifact: async ({ artifactRoot }) => ({ releaseId, artifactRoot }) });
  assert.equal(result.state, 'awaiting-administrator-enrollment');
  assert.equal((await fs.readlink(path.join(paths.layoutRoot, 'current'))).includes(releaseId), true);
  assert.deepEqual(calls.slice(0, 3), [['daemon-reload'], ['enable', '--now', 'sonuvi-api.service'], ['enable', '--now', 'sonuvi-web.service']]);
  assert.deepEqual(ownershipCalls, [paths.stateRoot]);
  await assert.rejects(runFixedTargetInstallation({ request: { ...request, command: 'id' }, paths, platform: 'linux', architecture: 'arm64', uid: 0, systemd, verifyArtifact: async () => ({ releaseId }) }), /unsupported fields/);
});

test('fixed target installer rejects a non-bootstrap attempt ID before host mutation', async () => {
  const releaseId = `sonuvi-${'b'.repeat(64)}`;
  let serviceAccountCalled = false;
  let artifactVerifierCalled = false;
  await assert.rejects(
    runFixedTargetInstallation({
      request: { attemptId: 'gateb2_20261104_04', targetIdentity, releaseId, serverIdentity: 'sonuvi-lab-01' },
      serviceAccount: { ensure: async () => { serviceAccountCalled = true; } },
      verifyArtifact: async () => { artifactVerifierCalled = true; return { releaseId }; },
    }),
    /bootstrap request ID is invalid/,
  );
  assert.equal(serviceAccountCalled, false);
  assert.equal(artifactVerifierCalled, false);
});
test('B2 package manifest hashes fixed package inputs without executing them', async (t) => {
  const root = await fixture(t); const helper = path.join(root, 'helper.mjs'); const lock = path.join(root, 'package-lock.json'); const unit = path.join(root, 'unit.service.in'); await Promise.all([fs.writeFile(helper, 'helper'), fs.writeFile(lock, 'lock'), fs.writeFile(unit, 'unit')]); const built = await buildGateB2ReadinessPackage({ outputPath: path.join(root, 'candidate', 'manifest.json'), helperPath: helper, lockfilePath: lock, serviceTemplatePaths: [unit] }); assert.equal(built.manifest.contract, 'sonuvi.gate-b2-package.v1'); assert.equal(built.manifest.files.length, 3);
});

test('fixed service account creates only the approved non-login identity and rejects conflicts', async () => {
  const calls = []; const absent = createFixedServiceAccount({ lookup: async () => null, run: async (file, args) => { calls.push([file, args]); } });
  assert.equal(await absent.ensure(), 'created');
  assert.deepEqual(calls, [['/usr/sbin/groupadd', ['--system', 'sonuvi']], ['/usr/sbin/useradd', ['--system', '--gid', 'sonuvi', '--home-dir', '/var/lib/sonuvi', '--shell', '/usr/sbin/nologin', '--no-create-home', 'sonuvi']]]);
  assert.equal(await createFixedServiceAccount({ lookup: async () => ({ group: 'sonuvi', shell: '/usr/sbin/nologin' }) }).ensure(), 'existing');
  await assert.rejects(createFixedServiceAccount({ lookup: async () => ({ group: 'users', shell: '/usr/sbin/nologin' }) }).ensure(), /service_account_conflict/);
  await assert.rejects(createFixedServiceAccount({ lookup: async () => ({ group: 'sonuvi', shell: '/bin/bash' }) }).ensure(), /service_account_conflict/);
});

test('bounded state ownership includes the configured podcast root without touching protected siblings', async (t) => {
  const root = await fixture(t);
  const stateRoot = path.join(root, 'var', 'lib', 'sonuvi');
  for (const directory of ['config', 'data', 'cache', 'protected', 'logs', 'checkpoints', 'install', 'empty-library', 'empty-library/podcasts']) {
    await fs.mkdir(path.join(stateRoot, directory), { recursive: true });
  }
  const calls = [];
  await provisionWritableStateOwnership({
    stateRoot,
    run: async (file, args) => { calls.push([file, args]); },
  });
  assert.deepEqual(TARGET_WRITABLE_STATE_DIRECTORIES, ['data', 'cache', 'logs', 'empty-library', 'empty-library/podcasts']);
  assert.deepEqual(calls.map(([, args]) => args[1]), TARGET_WRITABLE_STATE_DIRECTORIES.map((directory) => path.join(stateRoot, directory)));
  assert.equal(calls.every(([file, args]) => file === '/usr/bin/chown' && args[0] === 'sonuvi:sonuvi'), true);
  for (const protectedDirectory of ['config', 'protected', 'checkpoints', 'install']) {
    assert.equal(calls.some(([, args]) => args[1] === path.join(stateRoot, protectedDirectory)), false);
  }
  assert.equal((await fs.stat(path.join(stateRoot, 'empty-library', 'podcasts'))).mode & 0o777, 0o700);
});

test('initial configuration is root-owned but readable by the service group', async (t) => {
  const root = await fixture(t); const stateRoot = path.join(root, 'var', 'lib', 'sonuvi');
  const configRoot = path.join(stateRoot, 'config'); const configFile = path.join(configRoot, 'now-playing.config.json');
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 }); await fs.writeFile(configFile, '{}\n', { mode: 0o600 });
  const calls = [];
  await provisionServiceReadableConfiguration({ stateRoot, run: async (file, args) => { calls.push([file, args]); } });
  assert.deepEqual(calls, [['/usr/bin/chown', ['root:sonuvi', configRoot]], ['/usr/bin/chown', ['root:sonuvi', configFile]]]);
  assert.equal((await fs.stat(configRoot)).mode & 0o777, 0o750);
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o640);
  await fs.rm(configFile); await fs.symlink('/tmp', configFile);
  await assert.rejects(provisionServiceReadableConfiguration({ stateRoot, run: async () => {} }), /configuration_path_invalid/);
});
