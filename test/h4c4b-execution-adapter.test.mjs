import assert from 'node:assert/strict';
import test from 'node:test';

import {
  H4C4A_REHEARSAL_PLAN_CONTRACT,
  H4C4A_RUNTIME_CONTRACT_PARITY,
  H4C4A_RUNTIME_IMAGE,
} from '../scripts/lib/h4c4a-rehearsal.mjs';
import {
  H4C4B_PEER_CONTAINER_SPEC,
  H4C4B_RUNTIME_IMAGE,
  assertH4c4bContainerInspection,
  assertH4c4bNetworkInspection,
  createH4c4bExecutionPlan,
  dockerCreateArgsForH4c4bContainer,
  inspectH4c4bRuntimeDependencies,
  oneShotAuthorizationForRelease,
} from '../scripts/lib/h4c4b-execution-adapter.mjs';

const RELEASE_ID = `sonuvi-${'a'.repeat(64)}`;

function environment(kind) {
  return {
    NODE_ENV: 'production',
    HOME: '/nonexistent',
    SONUVI_EXECUTION_MODE: 'rehearsal',
    SONUVI_REHEARSAL_STATE_ROOT: '/var/lib/sonuvi-rehearsal',
    SONUVI_STATE_ROOT: '/var/lib/sonuvi-rehearsal',
    SONUVI_CONFIG_ROOT: '/var/lib/sonuvi-rehearsal/config',
    SONUVI_SECRETS_ROOT: '/run/sonuvi-empty-secrets',
    SONUVI_RELEASE_ID: RELEASE_ID,
    SONUVI_RELEASE_MANIFEST: '/opt/sonuvi/release/release-manifest.json',
    SONUVI_PUBLIC_WEB_ROOT: '/opt/sonuvi/release/public',
    ...(kind === 'api' ? { PORT: '31901' } : { SONUVI_WEB_PORT: '31902' }),
  };
}

function container(kind) {
  const api = kind === 'api';
  return {
    name: kind,
    command: api ? ['node', 'moode-nowplaying-api.mjs'] : ['node', 'scripts/serve-public-web.mjs'],
    environment: environment(kind),
    environmentMode: 'replace',
    networkMode: 'internal-rehearsal-bridge',
    publishedPorts: [],
    readOnlyRootFilesystem: true,
    privileged: false,
    hostPid: false,
    hostIpc: false,
    dockerSocket: false,
    capDrop: ['ALL'],
    noNewPrivileges: true,
    user: '1000:1000',
    mounts: [
      { type: 'bind', source: '/private/tmp/h4c4b-release', target: '/opt/sonuvi/release', readOnly: true },
      { type: 'bind', source: '/private/tmp/h4c4b-state', target: '/var/lib/sonuvi-rehearsal', readOnly: !api },
    ],
    tmpfs: api
      ? [
        { target: '/tmp', sizeBytes: 64 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: '/var/lib/sonuvi-rehearsal/cache', sizeBytes: 128 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: '/var/lib/sonuvi-rehearsal/logs', sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: '/var/lib/sonuvi-rehearsal/checkpoints', sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
      ]
      : [{ target: '/tmp', sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] }],
    resources: api
      ? { cpus: 0.75, memoryBytes: 768 * 1024 * 1024, pids: 128, nofile: 1024, logMaxBytes: 10 * 1024 * 1024, logFiles: 2 }
      : { cpus: 0.25, memoryBytes: 192 * 1024 * 1024, pids: 32, nofile: 512, logMaxBytes: 5 * 1024 * 1024, logFiles: 2 },
  };
}

function rehearsalPlan() {
  return {
    contract: H4C4A_REHEARSAL_PLAN_CONTRACT,
    action: 'preflight-only',
    startAuthorized: false,
    platform: 'linux/arm64',
    runtimeImage: H4C4A_RUNTIME_IMAGE,
    releaseId: RELEASE_ID,
    expectedReleaseId: RELEASE_ID,
    runtimeContractParity: {
      contract: H4C4A_RUNTIME_CONTRACT_PARITY,
      modules: [
        'src/lib/browse-index.mjs',
        'src/lib/release-artifact.mjs',
        'src/lib/release-runtime-preflight.mjs',
        'src/lib/runtime-capabilities.mjs',
        'src/lib/runtime-config-security.mjs',
        'src/lib/runtime-state-paths.mjs',
      ].map((relativePath) => ({ relativePath, sha256: 'b'.repeat(64) })),
    },
    releaseRoot: '/private/tmp/h4c4b-release',
    stateRoot: '/private/tmp/h4c4b-state',
    fixtureId: 'sonuvi-h4c4b-fixture-12345678',
    ports: { api: 31901, web: 31902 },
    network: { kind: 'internal-bridge', internal: true, allowExternalEgress: false, publishedPorts: [] },
    containers: [container('api'), container('web')],
    cleanup: { stateRoot: '/private/tmp/h4c4b-state', fixtureId: 'sonuvi-h4c4b-fixture-12345678' },
  };
}

function execution() {
  return createH4c4bExecutionPlan({
    rehearsalPlan: rehearsalPlan(),
    expectedReleaseId: RELEASE_ID,
    authorization: oneShotAuthorizationForRelease(RELEASE_ID),
    runId: 'synthetic-run-12345678',
  });
}

function inspectionFor(executionPlan, spec) {
  const peer = spec.name === 'peer';
  const labels = {
    'com.sonuvi.h4c4b.managed': 'true',
    'com.sonuvi.h4c4b.run-id': executionPlan.runId,
    'com.sonuvi.h4c4b.release-id': executionPlan.releaseId,
  };
  return {
    Name: `/${executionPlan.names[spec.name]}`,
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: peer ? `container:${executionPlan.names.web}` : executionPlan.names.network,
      PidMode: '',
      IpcMode: '',
      PublishAllPorts: false,
      PortBindings: {},
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: spec.resources.pids,
      Memory: spec.resources.memoryBytes,
      NanoCpus: Math.round(spec.resources.cpus * 1_000_000_000),
      LogConfig: { Type: 'local', Config: { 'max-size': `${spec.resources.logMaxBytes / (1024 * 1024)}m`, 'max-file': String(spec.resources.logFiles) } },
      Tmpfs: Object.fromEntries(spec.tmpfs.map((entry) => [entry.target, 'rw,noexec,nosuid'])),
    },
    Config: {
      User: spec.user,
      WorkingDir: spec.workingDirectory || '/opt/sonuvi/release',
      Image: H4C4B_RUNTIME_IMAGE,
      Labels: labels,
      Env: Object.entries(spec.environment).map(([name, value]) => `${name}=${value}`),
      ExposedPorts: {},
      Cmd: spec.command,
      OpenStdin: Boolean(spec.openStdin),
    },
    Mounts: spec.mounts.map((mount) => ({ Type: 'bind', Source: mount.source, Destination: mount.target, RW: !mount.readOnly })),
  };
}

test('H4C.4B requires an exact release-scoped one-shot authorization', () => {
  const plan = rehearsalPlan();
  assert.throws(
    () => createH4c4bExecutionPlan({ rehearsalPlan: plan, expectedReleaseId: RELEASE_ID, authorization: 'preflight-is-not-authorization', runId: 'synthetic-run-12345678' }),
    /one-shot authorization/,
  );
  const result = execution();
  assert.equal(result.action, 'execute-once');
  assert.equal(result.preflightPlan.action, 'preflight-only');
  assert.equal(result.runtimeImage, H4C4B_RUNTIME_IMAGE);
});

test('H4C.4B Docker create arguments keep the release read-only and publish no ports', () => {
  const result = execution();
  const api = result.preflightPlan.containers.find((entry) => entry.name === 'api');
  const args = dockerCreateArgsForH4c4bContainer({ execution: result, container: api });
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.includes('--network'), true);
  assert.equal(args.includes(result.names.network), true);
  assert.equal(args.some((entry) => /^--publish(?:=|$)/.test(entry)), false);
  assert.equal(args.some((entry) => /docker\.sock/.test(entry)), false);
  assert.equal(args.includes(H4C4B_RUNTIME_IMAGE), true);
});

test('H4C.4B pre-creates and validates the peer with bounded logging before candidate startup', () => {
  const result = execution();
  const args = dockerCreateArgsForH4c4bContainer({ execution: result, container: H4C4B_PEER_CONTAINER_SPEC });
  assert.equal(args[0], 'create');
  assert.equal(args.includes('--interactive'), true);
  assert.equal(args.includes(`container:${result.names.web}`), true);
  assert.equal(args.includes('--network-alias'), false);
  assert.equal(args.includes('max-size=2m'), true);
  assert.equal(args.includes('max-file=2'), true);
  assert.equal(args.some((entry) => /h4c4b-release|h4c4b-state/.test(entry)), false);

  const web = result.preflightPlan.containers.find((entry) => entry.name === 'web');
  const webInspection = { ...inspectionFor(result, web), Id: 'web-container-id' };
  const peerInspection = inspectionFor(result, H4C4B_PEER_CONTAINER_SPEC);
  peerInspection.HostConfig.NetworkMode = 'container:web-container-id';
  assert.doesNotThrow(() => assertH4c4bContainerInspection({
    execution: result,
    container: H4C4B_PEER_CONTAINER_SPEC,
    inspection: peerInspection,
    networkTargetInspection: webInspection,
  }));

  const wrongLogLimit = structuredClone(peerInspection);
  wrongLogLimit.HostConfig.LogConfig.Config['max-file'] = '1';
  assert.throws(() => assertH4c4bContainerInspection({
    execution: result,
    container: H4C4B_PEER_CONTAINER_SPEC,
    inspection: wrongLogLimit,
    networkTargetInspection: webInspection,
  }), /log limits/);
});

test('H4C.4B rejects inspected Docker privilege, host-network, and secret-environment regressions', () => {
  const result = execution();
  const api = result.preflightPlan.containers.find((entry) => entry.name === 'api');
  const clean = inspectionFor(result, api);
  assert.doesNotThrow(() => assertH4c4bContainerInspection({ execution: result, container: api, inspection: clean }));

  const privileged = structuredClone(clean);
  privileged.HostConfig.Privileged = true;
  assert.throws(() => assertH4c4bContainerInspection({ execution: result, container: api, inspection: privileged }), /isolation settings/);

  const hostNetwork = structuredClone(clean);
  hostNetwork.HostConfig.NetworkMode = 'host';
  assert.throws(() => assertH4c4bContainerInspection({ execution: result, container: api, inspection: hostNetwork }), /isolation settings/);

  const leaked = structuredClone(clean);
  leaked.Config.Env.push(`TRACK_KEY${'=synthetic-should-still-be-rejected'}`);
  assert.throws(() => assertH4c4bContainerInspection({ execution: result, container: api, inspection: leaked }), /sensitive environment/);
});

test('H4C.4B validates the internal bridge ownership and rejects an egress-capable network', () => {
  const result = execution();
  const clean = {
    Name: result.names.network,
    Driver: 'bridge',
    Internal: true,
    EnableIPv6: false,
    Labels: {
      'com.sonuvi.h4c4b.managed': 'true',
      'com.sonuvi.h4c4b.run-id': result.runId,
      'com.sonuvi.h4c4b.release-id': result.releaseId,
    },
  };
  assert.doesNotThrow(() => assertH4c4bNetworkInspection({ execution: result, inspection: clean }));
  clean.Internal = false;
  assert.throws(() => assertH4c4bNetworkInspection({ execution: result, inspection: clean }), /network isolation/);
});

test('H4C.4B inventory accepts only Node startup and rejects an enabled integration executable', async () => {
  const manifest = {
    externalRuntimeDependencies: {
      executables: ['node', 'npm', 'python3', 'mpc', 'ffmpeg', 'ffprobe', 'metaflac', 'curl', 'ssh', 'scp'],
    },
  };
  const absentIntegration = async () => ({
    stdout: 'node=present\nnpm=present\npython3=absent\nmpc=absent\nffmpeg=absent\nffprobe=absent\nmetaflac=absent\ncurl=absent\nssh=absent\nscp=absent\n',
    stderr: '',
  });
  const inventory = await inspectH4c4bRuntimeDependencies({ manifest, runDocker: absentIntegration });
  assert.equal(inventory.availability.node, true);
  assert.equal(inventory.availability.mpc, false);

  const enabledMpc = async () => ({
    stdout: 'node=present\nnpm=present\npython3=absent\nmpc=present\nffmpeg=absent\nffprobe=absent\nmetaflac=absent\ncurl=absent\nssh=absent\nscp=absent\n',
    stderr: '',
  });
  await assert.rejects(inspectH4c4bRuntimeDependencies({ manifest, runDocker: enabledMpc }), /unexpectedly exposes an integration executable/);
});
