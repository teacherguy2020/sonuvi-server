#!/usr/bin/env node
import { runArtifactBrowseIsolationProbe } from './lib/h4c4-artifact-browse-isolation.mjs';

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function optionalInteger(name) {
  const raw = value(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

if (process.argv.includes('--start')) {
  throw new Error('artifact browse-isolation imports only the browse adapter and never starts Sonuvi candidates');
}

const result = await runArtifactBrowseIsolationProbe({
  releaseRoot: required('--release-root'),
  stateRoot: required('--state-root'),
  expectedReleaseId: required('--expected-release-id'),
  scratchParent: required('--scratch-parent'),
  evidencePath: required('--evidence-path'),
  apiPort: optionalInteger('--api-port'),
  webPort: optionalInteger('--web-port'),
  retainProbe: process.argv.includes('--retain-probe'),
});

process.stdout.write(`${JSON.stringify({
  contract: result.contract,
  releaseId: result.releaseId,
  releaseManifestSha256: result.releaseManifestSha256,
  fixtureId: result.fixtureId,
  mpcInvocations: result.mpcInvocations,
  mpdNetworkAttempts: result.mpdNetworkAttempts,
  catalogWrites: result.catalogWrites,
  stateUnchanged: result.stateUnchanged,
  evidencePath: result.evidencePath,
  probeRetained: Boolean(result.probeRoot),
}, null, 2)}\n`);
