export const SONUVI_BOOTSTRAP_PROTOCOL_VERSION = 1;

export const SONUVI_BOOTSTRAP_STAGES = Object.freeze([
  'preflight',
  'release_acquisition',
  'release_verification',
  'checkpoint',
  'dependency_setup',
  'configuration',
  'activation',
  'health_verification',
  'administrator_enrollment',
  'pairing_ready',
  'complete',
]);

const STAGES = new Set(SONUVI_BOOTSTRAP_STAGES);
const SENSITIVE_KEY = /(?:password|secret|token|private|credential|authorization)/i;

function text(value) {
  return String(value ?? '').trim();
}

function timestamp(value) {
  const candidate = text(value) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(candidate))) throw new Error('event timestamp is invalid');
  return candidate;
}

function assertNoSensitiveKeys(value, path = 'request') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${path}.${key} is not allowed in the bootstrap contract`);
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

export function normalizeBootstrapRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bootstrap request must be an object');
  assertNoSensitiveKeys(input);
  const protocolVersion = Number(input.protocolVersion);
  if (protocolVersion !== SONUVI_BOOTSTRAP_PROTOCOL_VERSION) throw new Error('unsupported bootstrap protocol version');
  const requestId = text(input.requestId);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(requestId)) throw new Error('bootstrap request ID is invalid');
  const releaseId = text(input.releaseId);
  if (releaseId && !/^sonuvi-[a-f0-9]{64}$/.test(releaseId)) throw new Error('bootstrap release ID is invalid');
  const manifestSha256 = text(input.manifestSha256);
  if (manifestSha256 && !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('bootstrap manifest digest is invalid');
  return Object.freeze({
    protocolVersion,
    requestId,
    releaseId: releaseId || null,
    manifestSha256: manifestSha256 || null,
    options: Object.freeze({
      hostname: text(input.options?.hostname) || null,
      libraryPolicy: text(input.options?.libraryPolicy) || null,
    }),
  });
}

export function bootstrapEvent({ requestId, stage, state, message = '', error = null, progress = null, at } = {}) {
  const normalizedRequest = text(requestId);
  if (!/^boot_[A-Za-z0-9_-]{16,128}$/.test(normalizedRequest)) throw new Error('bootstrap request ID is invalid');
  const normalizedStage = text(stage);
  if (!STAGES.has(normalizedStage)) throw new Error('bootstrap stage is invalid');
  const normalizedState = text(state);
  if (!['started', 'passed', 'failed', 'waiting'].includes(normalizedState)) throw new Error('bootstrap event state is invalid');
  if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
    throw new Error('bootstrap progress must be an integer percentage');
  }
  if (error !== null && (!error || typeof error !== 'object' || !/^[a-z][a-z0-9_]{2,80}$/.test(text(error.code)))) {
    throw new Error('bootstrap error code is invalid');
  }
  return Object.freeze({
    v: SONUVI_BOOTSTRAP_PROTOCOL_VERSION,
    type: 'stage',
    requestId: normalizedRequest,
    stage: normalizedStage,
    state: normalizedState,
    at: timestamp(at),
    message: text(message) || null,
    progress,
    error: error ? Object.freeze({ code: text(error.code), recoverable: error.recoverable === true }) : null,
  });
}
