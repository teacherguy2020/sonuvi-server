import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { firstAdministratorClaimMessage, FirstAdministratorEnrollment } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { authorizeFirstController } from '../src/lib/sonuvi-first-controller-handoff.mjs';
import { buildGateB2ReadinessPackage } from '../src/lib/sonuvi-gate-b2-package.mjs';
import { makeTreeWritableForCleanup } from '../src/lib/release-artifact.mjs';
import { createFixedServiceAccount, createFixedSystemd, provisionServiceReadableActivationState, provisionServiceReadableConfiguration, provisionWritableStateOwnership, runFixedTargetInstallation, TARGET_WRITABLE_STATE_DIRECTORIES, verifyFixedTargetPrerequisites } from '../src/lib/sonuvi-target-installer.mjs';
import {initializeMasterConfiguration} from '../src/lib/master-configuration.mjs';

test('master provisioning grants atomic settings writes but retains root verifier ownership',async t=>{
  const root=await fixture(t),stateRoot=path.join(root,'state');
  for(const name of ['config','protected','checkpoints'])await fs.mkdir(path.join(stateRoot,name),{recursive:true});
  const file=path.join(stateRoot,'config','now-playing.config.json'),verifier=path.join(stateRoot,'config','administrator-verifier.json');
  await fs.writeFile(file,JSON.stringify(initializeMasterConfiguration()));await fs.writeFile(verifier,'{}');
  const calls=[];
  await provisionServiceReadableConfiguration({stateRoot,run:async(file,args)=>{calls.push(args);}});
  assert.equal((await fs.stat(path.dirname(file))).mode&0o7777,0o1770);
  assert.ok(calls.some(args=>args[0]==='sonuvi:sonuvi'&&args[1]===file));
  assert.ok(calls.some(args=>args[0]==='root:sonuvi'&&args[1]===verifier));
  assert.equal(calls.some(args=>args[0]==='sonuvi:sonuvi'&&args[1]===verifier),false);
  assert.equal((await fs.stat(path.join(stateRoot,'protected','integrations','lastfm'))).mode&0o777,0o700);
});
import crypto from 'node:crypto';

const attemptId = 'boot_0123456789abcdef'; const targetIdentity = 'machine_0123456789abcdef';
const fixtureTLSMaintenance = { prepare:async()=>{}, start:async()=>{}, stop:async()=>{} };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-b2-'));
  t.after(async () => {
    const releases = path.join(root, 'opt', 'sonuvi', 'releases');
    for (const entry of await fs.readdir(releases).catch(() => [])) await makeTreeWritableForCleanup(path.join(releases, entry)).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function claimPayload(token) { const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const administratorDeviceId = 'device_admin_0123456789'; const administratorPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'); const administratorProof = crypto.sign('sha256', firstAdministratorClaimMessage({ attemptId, targetIdentity, enrollmentToken: token, administratorDeviceId }), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'); return { administratorDeviceId, administratorPublicKey, administratorProof }; }
test('first-controller handoff requires an administrator and reuses mobile-only bearer scope', async (t) => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'data'), { recursive: true }); const enrollment = new FirstAdministratorEnrollment({ stateRoot: root }); const issued = await enrollment.create({ attemptId, targetIdentity }); const authority = new AdministratorAuthority({ stateRoot: root }); await authority.provisionSigningMaterial(); const admin = await authority.initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken: issued.enrollmentToken, ...claimPayload(issued.enrollmentToken) }); const adminToken = await authority.issueAccessToken({ administratorId: admin.administratorId });
  const handoff = await authorizeFirstController({ authority, administratorToken: adminToken, mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }); assert.equal(handoff.scope, 'mobile-api'); assert.equal(handoff.accessToken.includes(adminToken), false);
  const record = JSON.parse(await fs.readFile(path.join(root, 'data', 'first-controller-pairing.json'), 'utf8'));
  assert.equal(record.accessTokenHash, crypto.createHash('sha256').update(handoff.accessToken).digest('base64url'));
  await assert.rejects(authorizeFirstController({ authority, administratorToken: 'controller-token', mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }), /required/);
});

test('fixed systemd adapter permits only reviewed units and verbs', async () => {
  const calls = []; const systemd = createFixedSystemd({ run: async (args) => { calls.push(args); } });
  await systemd.daemonReload(); await systemd.enableAndStart('sonuvi-api.service');
  await systemd.disableAndStop('sonuvi-api.service');
  assert.equal(await systemd.isHealthy('sonuvi-web.service'), true);
  assert.deepEqual(calls, [['daemon-reload'], ['enable', '--now', 'sonuvi-api.service'], ['disable', '--now', 'sonuvi-api.service'], ['is-active', '--quiet', 'sonuvi-web.service']]);
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
  let configurationAccessCalled = false; let activationStateAccessCalled = false;
  const calls = []; const systemd = createFixedSystemd({ run: async (args) => {
    if (args[0] === 'enable') {
      const installed = path.join(paths.layoutRoot, 'releases', releaseId);
      assert.equal((await fs.stat(installed)).mode & 0o777, 0o555);
      assert.equal((await fs.stat(path.join(installed, 'ops', 'systemd', 'sonuvi-api.service.in'))).mode & 0o777, 0o444);
      assert.match(await fs.readFile(path.join(paths.stateRoot, 'protected', 'now-playing.env'), 'utf8'), /^MOBILE_API_ENABLED=1$/m);
      assert.equal((await fs.stat(path.join(paths.stateRoot, 'config', 'administrator-verifier.json'))).isFile(), true);
      assert.equal(configurationAccessCalled, true);
      assert.equal(activationStateAccessCalled, true);
    }
    calls.push(args);
  } });
  const serviceAccount = { ensure: async () => 'fixture' };
  const ownershipCalls = []; const ownership = async ({ stateRoot }) => { ownershipCalls.push(stateRoot); };
  const configurationAccess = async ({ stateRoot }) => { assert.equal(stateRoot, paths.stateRoot); configurationAccessCalled = true; };
  const activationStateAccess = async ({ stateRoot }) => { assert.equal(stateRoot, paths.stateRoot); activationStateAccessCalled = true; };
  let tlsProvisioned = false;
  const result = await runFixedTargetInstallation({ request, paths, platform: 'linux', architecture: 'arm64', uid: 0, systemd, serviceAccount, ownership, configurationAccess, activationStateAccess, health: async () => true, verifyArtifact: async ({ artifactRoot }) => ({ releaseId, artifactRoot }), verifyPrerequisites: async () => {}, tlsMaintenance:fixtureTLSMaintenance, localTLS: async ({stateRoot,serverId}) => { assert.equal(stateRoot,paths.stateRoot); assert.match(serverId,/^sonuvi-[A-Za-z0-9_-]{43}$/); tlsProvisioned=true; } });
  assert.equal(tlsProvisioned,true);
  assert.equal(result.state, 'awaiting-administrator-enrollment');
  assert.equal((await fs.readlink(path.join(paths.layoutRoot, 'current'))).includes(releaseId), true);
  const installState = JSON.parse(await fs.readFile(path.join(paths.stateRoot, 'install', 'state.json'), 'utf8'));
  const journal = await fs.readFile(path.join(paths.stateRoot, 'install', 'journal.jsonl'), 'utf8');
  const bootstrapJournal = await fs.readFile(path.join(root, 'bootstrap', 'attempts', attemptId, 'journal.jsonl'), 'utf8');
  assert.equal(installState.phase, 'awaiting-administrator-enrollment');
  assert.match(journal, /"stage":"administrator_enrollment","state":"waiting"/);
  assert.match(bootstrapJournal, /"stage":"preflight","state":"passed"/);
  assert.match(bootstrapJournal, /"stage":"dependency_setup","state":"passed"/);
  assert.match(bootstrapJournal, /"stage":"administrator_enrollment","state":"waiting"/);
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

test('failed first start disables only the approved candidate units before cleanup', async (t) => {
  const root = await fixture(t); const releaseId = `sonuvi-${'c'.repeat(64)}`;
  const staging = path.join(root, 'bootstrap', 'releases', releaseId);
  await fs.mkdir(path.join(staging, 'ops', 'systemd'), { recursive: true });
  await fs.writeFile(path.join(staging, 'ops', 'systemd', 'sonuvi-api.service.in'), 'api=@RELEASE_ID@');
  await fs.writeFile(path.join(staging, 'ops', 'systemd', 'sonuvi-web.service.in'), 'web=@RELEASE_ID@');
  const paths = { layoutRoot: path.join(root, 'opt', 'sonuvi'), stateRoot: path.join(root, 'var', 'lib', 'sonuvi'), unitRoot: path.join(root, 'etc', 'systemd', 'system'), bootstrapReleaseRoot: path.join(root, 'bootstrap', 'releases') };
  const calls = [];
  const systemd = createFixedSystemd({ run: async (args) => { calls.push(args); if (args[0] === 'enable') throw new Error('api start failed'); } });
  const request = { attemptId, targetIdentity, releaseId, serverIdentity: 'sonuvi-lab-01' };
  await assert.rejects(runFixedTargetInstallation({ request, paths, platform: 'linux', architecture: 'arm64', uid: 0, systemd, serviceAccount: { ensure: async () => 'fixture' }, ownership: async () => {}, configurationAccess: async () => {}, activationStateAccess: async () => {}, verifyArtifact: async ({ artifactRoot }) => ({ releaseId, artifactRoot }), verifyPrerequisites: async () => {}, localTLS: async () => {}, tlsMaintenance:fixtureTLSMaintenance }), /api start failed/);
  assert.deepEqual(calls, [['daemon-reload'], ['enable', '--now', 'sonuvi-api.service'], ['disable', '--now', 'sonuvi-web.service'], ['disable', '--now', 'sonuvi-api.service']]);
  await assert.rejects(fs.lstat(path.join(paths.layoutRoot, 'current')), { code: 'ENOENT' });
});
test('target installer rechecks the packaged Node ABI and fixed executable set before activation', async () => {
  const runtime = { version: 'v20.19.2', platform: 'linux', arch: 'arm64', versions: { modules: '115', napi: '9' } };
  const manifest = { target: { os: 'linux', architecture: 'arm64', nodeVersion: 'v20.19.5', nodeModuleAbi: '115', napiVersion: '9' }, externalRuntimeDependencies: { executables: ['node', 'ffmpeg'] } };
  const checked = await verifyFixedTargetPrerequisites({ manifest, runtime, find: async (name) => `/usr/bin/${name}` });
  assert.deepEqual(checked.missing, []);
  await assert.rejects(verifyFixedTargetPrerequisites({ manifest, runtime, find: async (name) => name === 'node' ? '/usr/bin/node' : '' }), /runtime_prerequisites_missing:ffmpeg/);
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
  const configRoot = path.join(stateRoot, 'config'); const configFile = path.join(configRoot, 'now-playing.config.json'); const verifierFile = path.join(configRoot, 'administrator-verifier.json');
  const checkpointsRoot = path.join(stateRoot, 'checkpoints'); const activationState = path.join(checkpointsRoot, 'release-activation-state.json');
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 }); await fs.mkdir(checkpointsRoot, { recursive: true, mode: 0o700 }); await fs.writeFile(configFile, '{}\n', { mode: 0o600 }); await fs.writeFile(verifierFile, '{}\n', { mode: 0o600 }); await fs.writeFile(activationState, '{}\n', { mode: 0o600 });
  const calls = [];
  await provisionServiceReadableConfiguration({ stateRoot, run: async (file, args) => { calls.push([file, args]); } });
  await provisionServiceReadableActivationState({ stateRoot, run: async (file, args) => { calls.push([file, args]); } });
  assert.deepEqual(calls, [['/usr/bin/chown', ['root:sonuvi', stateRoot]], ['/usr/bin/chown', ['root:sonuvi', configRoot]], ['/usr/bin/chown', ['root:sonuvi', configFile]], ['/usr/bin/chown', ['root:sonuvi', verifierFile]], ['/usr/bin/chown', ['root:sonuvi', checkpointsRoot]], ['/usr/bin/chown', ['root:sonuvi', activationState]]]);
  assert.equal((await fs.stat(stateRoot)).mode & 0o777, 0o710);
  assert.equal((await fs.stat(configRoot)).mode & 0o777, 0o750);
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(verifierFile)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(checkpointsRoot)).mode & 0o777, 0o750);
  assert.equal((await fs.stat(activationState)).mode & 0o777, 0o640);
  await fs.rm(configFile); await fs.symlink('/tmp', configFile);
  await assert.rejects(provisionServiceReadableConfiguration({ stateRoot, run: async () => {} }), /configuration_path_invalid/);
});
