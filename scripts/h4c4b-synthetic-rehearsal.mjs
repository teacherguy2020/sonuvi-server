#!/usr/bin/env node
import { prepareH4c4aRehearsal } from './lib/h4c4a-rehearsal.mjs';
import {
  createH4c4bExecutionPlan,
  executeH4c4bRehearsal,
  oneShotAuthorizationForRelease,
} from './lib/h4c4b-execution-adapter.mjs';

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function positiveSeconds(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) {
    throw new Error('--timeout-seconds must be an integer between 10 and 900');
  }
  return seconds * 1000;
}

const expectedReleaseId = required('--expected-release-id');
const authorization = required('--execute-once');
if (authorization !== oneShotAuthorizationForRelease(expectedReleaseId)) {
  throw new Error('--execute-once must contain the exact one-shot authorization for --expected-release-id');
}

const rehearsalPlan = await prepareH4c4aRehearsal({
  releaseRoot: required('--release-root'),
  stateRoot: required('--state-root'),
  expectedReleaseId,
  apiPort: value('--api-port') || undefined,
  webPort: value('--web-port') || undefined,
});
const execution = createH4c4bExecutionPlan({
  rehearsalPlan,
  expectedReleaseId,
  authorization,
  runId: required('--run-id'),
  timeoutMs: positiveSeconds(value('--timeout-seconds')),
});
const result = await executeH4c4bRehearsal({
  execution,
  authorization,
  evidencePath: required('--evidence-path'),
});

process.stdout.write(`${JSON.stringify({
  status: result.status,
  releaseId: result.releaseId,
  runId: result.runId,
  evidencePath: result.evidencePath,
  startup: result.startup,
  peer: result.peer,
  releaseIntegrity: result.releaseIntegrity,
  state: result.state,
  cleanup: result.cleanup,
  limitations: result.limitations,
  error: result.error,
}, null, 2)}\n`);
if (!['passed', 'passed-with-specific-limitations'].includes(result.status)) process.exitCode = 1;
