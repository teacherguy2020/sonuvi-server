#!/usr/bin/env node
import { prepareH4c4aRehearsal } from './lib/h4c4a-rehearsal.mjs';

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

if (process.argv.includes('--start')) {
  throw new Error('H4C.4A preflight never starts Sonuvi candidate processes');
}

const plan = await prepareH4c4aRehearsal({
  releaseRoot: required('--release-root'),
  stateRoot: required('--state-root'),
  expectedReleaseId: required('--expected-release-id'),
  apiPort: value('--api-port') || undefined,
  webPort: value('--web-port') || undefined,
});

process.stdout.write(`${JSON.stringify({
  contract: plan.contract,
  action: plan.action,
  startAuthorized: plan.startAuthorized,
  releaseId: plan.releaseId,
  expectedReleaseId: plan.expectedReleaseId,
  runtimeContractParity: plan.runtimeContractParity,
  fixtureId: plan.fixtureId,
  ports: plan.ports,
  network: plan.network,
  containers: plan.containers.map(({ name, command, environmentMode, networkMode, publishedPorts, readOnlyRootFilesystem, privileged, hostPid, hostIpc, dockerSocket, capDrop, noNewPrivileges, mounts, tmpfs, resources }) => ({ name, command, environmentMode, networkMode, publishedPorts, readOnlyRootFilesystem, privileged, hostPid, hostIpc, dockerSocket, capDrop, noNewPrivileges, mounts, tmpfs, resources })),
  cleanup: plan.cleanup,
}, null, 2)}\n`);
