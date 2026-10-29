#!/usr/bin/env node
import fs from 'node:fs/promises';

import {
  cleanupReleaseAcceptance,
  createReleaseAcceptancePreflight,
  executeReleaseAcceptance,
  readReleaseAcceptanceRecord,
  writeReleaseAcceptanceRecord,
} from './lib/h4c4-release-acceptance.mjs';

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

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} must be readable valid JSON`);
  }
}

const mode = required('--mode');

if (mode === 'preflight') {
  if (process.argv.includes('--execute-once')) {
    throw new Error('preflight never accepts execution authorization or starts a candidate');
  }
  const record = await createReleaseAcceptancePreflight({
    releaseRoot: required('--release-root'),
    stateRoot: required('--state-root'),
    expectedReleaseId: required('--expected-release-id'),
    expectedSourceCommit: required('--expected-source-commit'),
    expectedSourceTree: required('--expected-source-tree'),
    artifactBrowseIsolation: await readJson(required('--browse-isolation-evidence'), 'artifact browse-isolation evidence'),
    runId: required('--run-id'),
    apiPort: optionalInteger('--api-port'),
    webPort: optionalInteger('--web-port'),
  });
  const written = await writeReleaseAcceptanceRecord({ recordPath: required('--record-path'), record });
  process.stdout.write(`${JSON.stringify({
    status: record.status,
    action: record.action,
    executionAuthorized: record.executionAuthorized,
    releaseId: record.artifact.releaseId,
    recordPath: written.path,
    recordSha256: written.recordSha256,
    cleanup: record.cleanup,
  }, null, 2)}\n`);
} else if (mode === 'execute') {
  const record = await readReleaseAcceptanceRecord({ recordPath: required('--record-path') });
  const result = await executeReleaseAcceptance({
    record,
    authorization: required('--execute-once'),
    runId: required('--run-id'),
    evidencePath: required('--evidence-path'),
    timeoutMs: optionalInteger('--timeout-ms'),
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    releaseId: result.releaseId,
    runId: result.runId,
    evidencePath: result.evidencePath,
    cleanup: result.cleanup,
    releaseIntegrity: result.releaseIntegrity,
    state: result.state,
    error: result.error,
  }, null, 2)}\n`);
  if (!['passed', 'passed-with-specific-limitations'].includes(result.status)) process.exitCode = 1;
} else if (mode === 'cleanup') {
  if (process.argv.includes('--execute-once')) {
    throw new Error('cleanup never accepts execution authorization or starts a candidate');
  }
  const result = await cleanupReleaseAcceptance({
    record: await readReleaseAcceptanceRecord({ recordPath: required('--record-path') }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  throw new Error('--mode must be preflight, execute, or cleanup');
}
