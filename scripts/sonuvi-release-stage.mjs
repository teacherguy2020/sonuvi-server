#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TRUST_ANCHOR_PATH = '/etc/sonuvi/release-trust-anchors.json';
const HEADER_LIMIT = 64 * 1024;

export const GATE_C_STAGE_RESPONSE_CONTRACT = 'sonuvi.gate-c-stage-response.v1';
export const GATE_C_STAGE_FAILURE_CODES = Object.freeze([
  'stage_input_invalid',
  'stage_release_identity_mismatch',
  'stage_release_digest_mismatch',
  'stage_target_mismatch',
  'stage_attempt_mismatch',
  'stage_conflict',
  'stage_permission_denied',
  'stage_helper_unavailable',
  'stage_internal_error',
]);

const failureCodes = new Set(GATE_C_STAGE_FAILURE_CODES);

function text(value) {
  return String(value ?? '').trim();
}

function stageFailure(code) {
  const error = new Error(code);
  error.stageCode = code;
  return error;
}

function validReleaseId(value) {
  return /^sonuvi-[a-f0-9]{64}$/.test(text(value));
}

function validAttemptId(value) {
  return /^boot_[A-Za-z0-9_-]{16,128}$/.test(text(value));
}

function validTargetIdentity(value) {
  return /^sonuvi-target-v1-[a-f0-9]{64}$/.test(text(value));
}

function validKeyId(value) {
  return /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(text(value));
}

/** Maps every root-side exception to one reviewed, non-secret client code. */
export function gateCStageFailureCode(error) {
  const explicit = text(error?.stageCode);
  if (failureCodes.has(explicit)) return explicit;

  const nodeCode = text(error?.code);
  if (nodeCode === 'EACCES' || nodeCode === 'EPERM') return 'stage_permission_denied';
  if (nodeCode === 'EEXIST' || nodeCode === 'ENOTEMPTY') return 'stage_conflict';
  if (nodeCode === 'ENOENT' || nodeCode === 'MODULE_NOT_FOUND' || nodeCode === 'ERR_MODULE_NOT_FOUND') {
    return 'stage_helper_unavailable';
  }

  const message = text(error?.message).toLowerCase();
  if (/release_stage_target_identity_mismatch|target identity mismatch/.test(message)) return 'stage_target_mismatch';
  if (/release_stage_attempt_(binding_mismatch|unavailable)|attempt binding/.test(message)) return 'stage_attempt_mismatch';
  if (/existing staged release|already exists|staging conflict/.test(message)) return 'stage_conflict';
  if (/byte count|digest|manifest digest|trailing archive/.test(message)) return 'stage_release_digest_mismatch';
  if (/signature|trust anchor|release metadata|release envelope|release (id|signing key)|target is unsupported|release artifact is invalid/.test(message)) {
    return 'stage_release_identity_mismatch';
  }
  if (/header|json|release stage request|release stage operation|attempt id|archive stream|unsupported fields|target identity is invalid/.test(message)) {
    return 'stage_input_invalid';
  }
  if (/permission|root authorization|sudo/.test(message)) return 'stage_permission_denied';
  if (/tar|extract|import|module|initializ|staging root|release root/.test(message)) return 'stage_helper_unavailable';
  return 'stage_internal_error';
}

export function gateCStageFailureResponse(error) {
  return Object.freeze({
    ok: false,
    contract: GATE_C_STAGE_RESPONSE_CONTRACT,
    operation: 'stage_release',
    code: gateCStageFailureCode(error),
  });
}

export function gateCStageSuccessResponse(result = {}) {
  if (!['staged', 'already_staged'].includes(text(result.state))
    || !validReleaseId(result.releaseId)
    || !validAttemptId(result.attemptId)
    || !validTargetIdentity(result.targetIdentity)
    || !validKeyId(result.keyId)) {
    throw stageFailure('stage_internal_error');
  }
  // `releaseRoot` is intentionally omitted: it is root-side implementation
  // detail and must never reach the client, even on a successful operation.
  return Object.freeze({
    ok: true,
    contract: GATE_C_STAGE_RESPONSE_CONTRACT,
    operation: 'stage_release',
    state: result.state,
    releaseId: result.releaseId,
    keyId: result.keyId,
    attemptId: result.attemptId,
    targetIdentity: result.targetIdentity,
  });
}

export async function framedInput(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  while (true) {
    const next = await iterator.next();
    if (next.done) throw stageFailure('stage_input_invalid');
    buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      if (buffered.length > HEADER_LIMIT) throw stageFailure('stage_input_invalid');
      continue;
    }
    let header;
    try {
      header = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
    } catch {
      throw stageFailure('stage_input_invalid');
    }
    const initial = buffered.subarray(newline + 1);
    return {
      header,
      archive: (async function* archive() {
        if (initial.length) yield initial;
        while (true) {
          const body = await iterator.next();
          if (body.done) return;
          yield Buffer.from(body.value);
        }
      }()),
    };
  }
}

async function trustedAnchors(readFile, trustAnchorPath) {
  try {
    return JSON.parse(await readFile(trustAnchorPath, 'utf8'));
  } catch {
    throw stageFailure('stage_helper_unavailable');
  }
}

async function stageHelper(loadStageHelper) {
  try {
    const value = await loadStageHelper();
    if (typeof value?.stageGateCReleaseArchive !== 'function') throw new Error('stage helper export is unavailable');
    return value.stageGateCReleaseArchive;
  } catch {
    throw stageFailure('stage_helper_unavailable');
  }
}

export async function executeGateCStageRelease({
  stream,
  readFile = fs.readFile,
  trustAnchorPath = TRUST_ANCHOR_PATH,
  loadStageHelper = () => import('../src/lib/sonuvi-gate-c-staging.mjs'),
} = {}) {
  const anchors = await trustedAnchors(readFile, trustAnchorPath);
  const { header, archive } = await framedInput(stream);
  const stageGateCReleaseArchive = await stageHelper(loadStageHelper);
  return gateCStageSuccessResponse(await stageGateCReleaseArchive({ request: header, archive, trustedAnchors: anchors }));
}

export async function runGateCStageRelease({
  stream = process.stdin,
  uid = process.getuid?.(),
  execute = executeGateCStageRelease,
} = {}) {
  if (uid !== 0) {
    return Object.freeze({ exitCode: 77, response: gateCStageFailureResponse(stageFailure('stage_permission_denied')) });
  }
  try {
    return Object.freeze({ exitCode: 0, response: await execute({ stream }) });
  } catch (error) {
    return Object.freeze({ exitCode: 1, response: gateCStageFailureResponse(error) });
  }
}

export async function main({ stdout = process.stdout } = {}) {
  const result = await runGateCStageRelease();
  stdout.write(`${JSON.stringify(result.response)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
