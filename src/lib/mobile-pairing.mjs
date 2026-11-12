import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export const MOBILE_PAIRING_PROTOCOL_VERSION = 1;
export const MOBILE_PAIRING_TTL_MS = 90 * 1000;
export const MOBILE_PAIRING_RETENTION_MS = 10 * 60 * 1000;
export const MOBILE_PAIRING_COMPLETION_GRACE_MS = 30 * 1000;
export const MOBILE_REVERSE_PAIRING_PROTOCOL_VERSION = 1;
export const MOBILE_REVERSE_PAIRING_MAX_ACTIVE_PRESENTATIONS = 64;
export const MOBILE_REVERSE_PAIRING_RATE_LIMIT_COUNT = 6;
export const MOBILE_REVERSE_PAIRING_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const PROOF_DOMAIN = 'now-playing-mobile-pairing-v1';
const REVERSE_PROOF_DOMAIN = 'now-playing-mobile-reverse-pairing-v1';
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_DEVICE_NAME_LENGTH = 120;
const MAX_DEVICE_MODEL_LENGTH = 120;

export class MobilePairingError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'MobilePairingError';
    this.status = status;
    this.code = code;
  }
}

function hashText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function sameSecretHash(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizedText(value, maxLength, fieldName) {
  const result = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!result || result.length > maxLength) {
    throw new MobilePairingError(400, `invalid_${fieldName}`, `Invalid ${fieldName}`);
  }
  return result;
}

export function normalizePairingDeviceId(value) {
  return normalizedText(value, MAX_DEVICE_ID_LENGTH, 'device_id');
}

export function normalizePairingDeviceName(value) {
  return normalizedText(value, MAX_DEVICE_NAME_LENGTH, 'device_name');
}

export function normalizePairingDeviceModel(value) {
  return normalizedText(value, MAX_DEVICE_MODEL_LENGTH, 'device_model');
}

export function pairingProofMessage({ challenge, deviceId, deviceName, deviceModel }) {
  return [
    PROOF_DOMAIN,
    String(challenge),
    normalizePairingDeviceId(deviceId),
    normalizePairingDeviceName(deviceName),
    normalizePairingDeviceModel(deviceModel),
  ].join('\n');
}

export function reversePairingProofMessage({
  presentationId,
  challenge,
  deviceId,
  deviceName,
  deviceModel,
}) {
  return [
    REVERSE_PROOF_DOMAIN,
    String(presentationId),
    String(challenge),
    normalizePairingDeviceId(deviceId),
    normalizePairingDeviceName(deviceName),
    normalizePairingDeviceModel(deviceModel),
  ].join('\n');
}

function decodeBase64(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new MobilePairingError(400, `missing_${fieldName}`, `Missing ${fieldName}`);
  }
  if (text.length > 16 * 1024) {
    throw new MobilePairingError(400, `invalid_${fieldName}`, `Invalid ${fieldName}`);
  }
  try {
    const result = Buffer.from(text, 'base64url');
    if (!result.length) throw new Error('empty');
    return result;
  } catch {
    throw new MobilePairingError(400, `invalid_${fieldName}`, `Invalid ${fieldName}`);
  }
}

function publicKeyFromPayload(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new MobilePairingError(400, 'missing_public_key', 'Missing public key');
  }
  if (text.length > 16 * 1024) {
    throw new MobilePairingError(400, 'invalid_public_key', 'Invalid public key');
  }
  try {
    if (/-----BEGIN PUBLIC KEY-----/.test(text)) {
      return createPublicKey(text);
    }
    return createPublicKey({
      key: decodeBase64(text, 'public_key'),
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    if (error instanceof MobilePairingError) throw error;
    throw new MobilePairingError(400, 'invalid_public_key', 'Invalid public key');
  }
}

function verifyProof({ proofMessage, publicKey, signature, signatureAlgorithm }) {
  const key = publicKeyFromPayload(publicKey);
  const signatureBytes = decodeBase64(signature, 'signature');
  const algorithm = String(signatureAlgorithm ?? '').trim().toLowerCase();
  const message = Buffer.from(String(proofMessage ?? ''), 'utf8');

  let valid = false;
  if (algorithm === 'ed25519') {
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new MobilePairingError(400, 'key_algorithm_mismatch', 'Public key does not match signature algorithm');
    }
    valid = verifySignature(null, message, key, signatureBytes);
  } else if (algorithm === 'ecdsa-p256-sha256') {
    if (key.asymmetricKeyType !== 'ec') {
      throw new MobilePairingError(400, 'key_algorithm_mismatch', 'Public key does not match signature algorithm');
    }
    const namedCurve = key.asymmetricKeyDetails?.namedCurve;
    if (namedCurve && namedCurve !== 'prime256v1') {
      throw new MobilePairingError(400, 'key_curve_mismatch', 'Public key is not P-256');
    }
    valid = verifySignature('sha256', message, key, signatureBytes);
  } else {
    throw new MobilePairingError(400, 'unsupported_signature_algorithm', 'Unsupported signature algorithm');
  }

  if (!valid) {
    throw new MobilePairingError(403, 'invalid_proof', 'Device proof was not accepted');
  }
  return key;
}

function verificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function requestId() {
  return `pair_${randomBytes(16).toString('base64url')}`;
}

function presentationId() {
  return `present_${randomBytes(16).toString('base64url')}`;
}

function publicKeyFingerprint(key) {
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex')
    .slice(0, 32);
}

function safeRequest(request) {
  return {
    requestId: request.requestId,
    deviceId: request.deviceId,
    deviceName: request.deviceName,
    deviceModel: request.deviceModel,
    verificationCode: request.verificationCode,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function safeChallenge(challenge) {
  return {
    status: challenge.status,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
  };
}

function safePresentation(presentation) {
  return {
    presentationId: presentation.presentationId,
    deviceId: presentation.deviceId,
    deviceName: presentation.deviceName,
    deviceModel: presentation.deviceModel,
    publicKeyFingerprint: presentation.publicKeyFingerprint,
    verificationCode: presentation.verificationCode,
    status: presentation.status,
    createdAt: presentation.createdAt,
    expiresAt: presentation.expiresAt,
  };
}

export class MobilePairingStore {
  constructor({
    ttlMs = MOBILE_PAIRING_TTL_MS,
    retentionMs = MOBILE_PAIRING_RETENTION_MS,
    completionGraceMs = MOBILE_PAIRING_COMPLETION_GRACE_MS,
    reverseMaxActivePresentations = MOBILE_REVERSE_PAIRING_MAX_ACTIVE_PRESENTATIONS,
    reverseRateLimitCount = MOBILE_REVERSE_PAIRING_RATE_LIMIT_COUNT,
    reverseRateLimitWindowMs = MOBILE_REVERSE_PAIRING_RATE_LIMIT_WINDOW_MS,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.retentionMs = retentionMs;
    this.completionGraceMs = completionGraceMs;
    this.reverseMaxActivePresentations = reverseMaxActivePresentations;
    this.reverseRateLimitCount = reverseRateLimitCount;
    this.reverseRateLimitWindowMs = reverseRateLimitWindowMs;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.challenges = new Map();
    this.requests = new Map();
    this.presentations = new Map();
    this.presentationStarts = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(this.ttlMs, 30 * 1000));
    this.cleanupTimer.unref?.();
  }

  dispose() {
    clearInterval(this.cleanupTimer);
  }

  currentTime(value) {
    return Number.isFinite(value) ? Number(value) : Number(this.now());
  }

  cleanup(now = this.currentTime()) {
    for (const challenge of this.challenges.values()) {
      if (challenge.status === 'waiting' && now >= challenge.expiresAt) {
        this.expireChallenge(challenge);
      }
      if (now > challenge.expiresAt + this.retentionMs) {
        this.challenges.delete(challenge.challengeHash.toString('base64url'));
      }
    }

    for (const request of this.requests.values()) {
      if (now > request.expiresAt + this.retentionMs) {
        this.requests.delete(request.requestId);
      }
    }

    for (const presentation of this.presentations.values()) {
      if ((presentation.status === 'created' || presentation.status === 'waiting')
        && now >= presentation.expiresAt) {
        presentation.status = 'expired';
      }
      if (now > presentation.expiresAt + this.retentionMs) {
        this.presentations.delete(presentation.presentationId);
      }
    }

    for (const [source, entry] of this.presentationStarts) {
      if (now >= entry.windowStartedAt + this.reverseRateLimitWindowMs) {
        this.presentationStarts.delete(source);
      }
    }
  }

  createChallenge({ baseUrl, now } = {}) {
    const createdAt = this.currentTime(now);
    const expiresAt = createdAt + this.ttlMs;
    const challenge = randomBytes(32).toString('base64url');
    const displayToken = randomBytes(32).toString('base64url');
    const challengeHash = hashText(challenge);
    const entry = {
      challenge,
      challengeHash,
      displayTokenHash: hashText(displayToken),
      baseUrl: String(baseUrl || ''),
      createdAt,
      expiresAt,
      status: 'waiting',
      requestIds: new Set(),
    };
    this.challenges.set(challengeHash.toString('base64url'), entry);
    return {
      challenge,
      displayToken,
      baseUrl: entry.baseUrl,
      createdAt,
      expiresAt,
      status: entry.status,
    };
  }

  challengeForValue(challengeValue, now = this.currentTime()) {
    const value = String(challengeValue ?? '').trim();
    if (!value || value.length > 256) {
      throw new MobilePairingError(410, 'invalid_challenge', 'Pairing challenge is invalid or expired');
    }
    const entry = this.challenges.get(hashText(value).toString('base64url'));
    if (!entry) {
      throw new MobilePairingError(410, 'invalid_challenge', 'Pairing challenge is invalid or expired');
    }
    if (now >= entry.expiresAt && entry.status === 'waiting') this.expireChallenge(entry);
    return entry;
  }

  challengeForDisplayToken(displayToken, now = this.currentTime()) {
    const token = String(displayToken ?? '').trim();
    if (!token) throw new MobilePairingError(401, 'invalid_display_token', 'Invalid pairing display token');
    const tokenHash = hashText(token);
    for (const challenge of this.challenges.values()) {
      if (sameSecretHash(challenge.displayTokenHash, tokenHash)) {
        if (now >= challenge.expiresAt && challenge.status === 'waiting') this.expireChallenge(challenge);
        return challenge;
      }
    }
    throw new MobilePairingError(401, 'invalid_display_token', 'Invalid pairing display token');
  }

  requestForChallenge(challenge, id) {
    const request = this.requests.get(String(id || ''));
    if (!request || !challenge.requestIds.has(request.requestId)) {
      throw new MobilePairingError(404, 'pairing_request_not_found', 'Pairing request not found');
    }
    return request;
  }

  assertWaiting(challenge) {
    if (challenge.status !== 'waiting') {
      throw new MobilePairingError(409, 'pairing_not_waiting', 'Pairing is no longer waiting for approval');
    }
  }

  expireChallenge(challenge) {
    if (challenge.status === 'waiting') challenge.status = 'expired';
    for (const id of challenge.requestIds) {
      const request = this.requests.get(id);
      if (request?.status === 'pending') request.status = 'expired';
    }
  }

  submitRequest({
    challenge: challengeValue,
    deviceId: rawDeviceId,
    deviceName: rawDeviceName,
    deviceModel: rawDeviceModel,
    publicKey,
    signature,
    signatureAlgorithm,
    now,
  } = {}) {
    const current = this.currentTime(now);
    const challenge = this.challengeForValue(challengeValue, current);
    this.assertWaiting(challenge);
    if (current >= challenge.expiresAt) {
      this.expireChallenge(challenge);
      throw new MobilePairingError(410, 'pairing_expired', 'Pairing challenge expired');
    }

    const deviceId = normalizePairingDeviceId(rawDeviceId);
    const deviceName = normalizePairingDeviceName(rawDeviceName);
    const deviceModel = normalizePairingDeviceModel(rawDeviceModel);
    const key = verifyProof({
      proofMessage: pairingProofMessage({
        challenge: challenge.challenge,
        deviceId,
        deviceName,
        deviceModel,
      }),
      publicKey,
      signature,
      signatureAlgorithm,
    });
    const fingerprint = publicKeyFingerprint(key);
    const pollToken = randomBytes(32).toString('base64url');
    const request = {
      requestId: requestId(),
      pollTokenHash: hashText(pollToken),
      challengeHash: challenge.challengeHash,
      deviceId,
      deviceName,
      deviceModel,
      publicKeyFingerprint: fingerprint,
      verificationCode: verificationCode(),
      status: 'pending',
      createdAt: current,
      expiresAt: challenge.expiresAt,
      approvedAt: 0,
      session: null,
    };
    this.requests.set(request.requestId, request);
    challenge.requestIds.add(request.requestId);
    return {
      requestId: request.requestId,
      pollToken,
      verificationCode: request.verificationCode,
      expiresAt: request.expiresAt,
      status: request.status,
    };
  }

  listPending({ displayToken, now } = {}) {
    const current = this.currentTime(now);
    const challenge = this.challengeForDisplayToken(displayToken, current);
    const requests = [...challenge.requestIds]
      .map((id) => this.requests.get(id))
      .filter((request) => request?.status === 'pending')
      .map(safeRequest);
    return {
      ...safeChallenge(challenge),
      requests,
    };
  }

  approve({ displayToken, requestId: id, verificationCode: suppliedCode, now } = {}) {
    const current = this.currentTime(now);
    const challenge = this.challengeForDisplayToken(displayToken, current);
    this.assertWaiting(challenge);
    const request = this.requestForChallenge(challenge, id);
    if (request.status !== 'pending') {
      throw new MobilePairingError(409, 'pairing_request_not_pending', 'Pairing request is no longer pending');
    }
    if (current >= request.expiresAt) {
      this.expireChallenge(challenge);
      throw new MobilePairingError(410, 'pairing_expired', 'Pairing request expired');
    }
    if (!sameSecretHash(hashText(request.verificationCode), hashText(String(suppliedCode ?? '').trim()))) {
      throw new MobilePairingError(403, 'verification_code_mismatch', 'Verification code does not match');
    }

    request.status = 'approved';
    request.approvedAt = current;
    challenge.status = 'approved';
    for (const otherId of challenge.requestIds) {
      const other = this.requests.get(otherId);
      if (other && other !== request && other.status === 'pending') other.status = 'rejected';
    }
    return safeRequest(request);
  }

  reject({ displayToken, requestId: id, verificationCode: suppliedCode, now } = {}) {
    const current = this.currentTime(now);
    const challenge = this.challengeForDisplayToken(displayToken, current);
    this.assertWaiting(challenge);
    const request = this.requestForChallenge(challenge, id);
    if (request.status !== 'pending') {
      throw new MobilePairingError(409, 'pairing_request_not_pending', 'Pairing request is no longer pending');
    }
    if (!sameSecretHash(hashText(request.verificationCode), hashText(String(suppliedCode ?? '').trim()))) {
      throw new MobilePairingError(403, 'verification_code_mismatch', 'Verification code does not match');
    }
    request.status = 'rejected';
    challenge.status = 'rejected';
    for (const otherId of challenge.requestIds) {
      const other = this.requests.get(otherId);
      if (other && other !== request && other.status === 'pending') other.status = 'rejected';
    }
    return safeRequest(request);
  }

  cancel({ displayToken, now } = {}) {
    const current = this.currentTime(now);
    const challenge = this.challengeForDisplayToken(displayToken, current);
    if (challenge.status === 'waiting') challenge.status = 'cancelled';
    for (const id of challenge.requestIds) {
      const request = this.requests.get(id);
      if (request?.status === 'pending') request.status = 'cancelled';
    }
    return safeChallenge(challenge);
  }

  complete({ requestId: id, pollToken, issueSession, now } = {}) {
    const current = this.currentTime(now);
    const request = this.requests.get(String(id || ''));
    if (!request || !pollToken || !sameSecretHash(request.pollTokenHash, hashText(pollToken))) {
      throw new MobilePairingError(401, 'invalid_poll_token', 'Invalid pairing poll token');
    }

    if (request.status === 'pending' && current >= request.expiresAt) {
      request.status = 'expired';
    }
    if (request.status === 'approved' && current > request.expiresAt + this.completionGraceMs) {
      request.status = 'expired';
    }
    if (request.status !== 'approved') {
      return {
        status: request.status,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
      };
    }

    if (!request.session) {
      if (typeof issueSession !== 'function') {
        throw new MobilePairingError(500, 'session_issuer_unavailable', 'Pairing session issuer unavailable');
      }
      request.session = issueSession({ deviceId: request.deviceId });
    }
    return {
      status: 'approved',
      requestId: request.requestId,
      deviceId: request.deviceId,
      accessToken: request.session.accessToken,
      ...(request.session.refreshToken ? { refreshToken: request.session.refreshToken } : {}),
      expiresAt: request.session.expiresAt,
    };
  }

  presentationSource(value) {
    const source = String(value ?? '').trim();
    if (!source || source.length > 200) return 'unknown';
    return source;
  }

  activePresentationCount() {
    return [...this.presentations.values()]
      .filter((presentation) => presentation.status === 'created' || presentation.status === 'waiting')
      .length;
  }

  createPresentation({ baseUrl, source, now } = {}) {
    const current = this.currentTime(now);
    this.cleanup(current);
    const sourceKey = this.presentationSource(source);
    const prior = this.presentationStarts.get(sourceKey);
    const entry = !prior || current >= prior.windowStartedAt + this.reverseRateLimitWindowMs
      ? { windowStartedAt: current, count: 0 }
      : prior;
    if (entry.count >= this.reverseRateLimitCount) {
      throw new MobilePairingError(429, 'presentation_rate_limited', 'Too many pairing presentations were started');
    }
    if (this.activePresentationCount() >= this.reverseMaxActivePresentations) {
      throw new MobilePairingError(503, 'presentation_capacity_reached', 'Pairing presentation capacity is temporarily unavailable');
    }
    entry.count += 1;
    this.presentationStarts.set(sourceKey, entry);

    const expiresAt = current + this.ttlMs;
    const presentation = {
      presentationId: presentationId(),
      challenge: randomBytes(32).toString('base64url'),
      // Assigned below once, from the sole opaque handle returned to the TV.
      // Do not retain an unused random handle or any plaintext token.
      pollTokenHash: '',
      baseUrl: String(baseUrl || ''),
      createdAt: current,
      expiresAt,
      status: 'created',
      deviceId: '',
      deviceName: '',
      deviceModel: '',
      publicKeyFingerprint: '',
      verificationCode: '',
      completionConsumed: false,
    };
    const pollToken = randomBytes(32).toString('base64url');
    presentation.pollTokenHash = hashText(pollToken);
    this.presentations.set(presentation.presentationId, presentation);
    return {
      presentationId: presentation.presentationId,
      challenge: presentation.challenge,
      pollToken,
      baseUrl: presentation.baseUrl,
      createdAt: presentation.createdAt,
      expiresAt: presentation.expiresAt,
      status: presentation.status,
    };
  }

  presentationForId(value, now = this.currentTime()) {
    const id = String(value ?? '').trim();
    if (!id || id.length > 256) {
      throw new MobilePairingError(410, 'invalid_presentation', 'Pairing presentation is invalid or expired');
    }
    const presentation = this.presentations.get(id);
    if (!presentation) {
      throw new MobilePairingError(410, 'invalid_presentation', 'Pairing presentation is invalid or expired');
    }
    if ((presentation.status === 'created' || presentation.status === 'waiting')
      && now >= presentation.expiresAt) {
      presentation.status = 'expired';
    }
    return presentation;
  }

  assertPresentationStatus(presentation, expected) {
    if (presentation.status !== expected) {
      throw new MobilePairingError(409, 'presentation_not_available', 'Pairing presentation is no longer available');
    }
  }

  attestPresentation({
    presentationId: id,
    deviceId: rawDeviceId,
    deviceName: rawDeviceName,
    deviceModel: rawDeviceModel,
    publicKey,
    signature,
    signatureAlgorithm,
    now,
  } = {}) {
    const current = this.currentTime(now);
    const presentation = this.presentationForId(id, current);
    this.assertPresentationStatus(presentation, 'created');
    const deviceId = normalizePairingDeviceId(rawDeviceId);
    const deviceName = normalizePairingDeviceName(rawDeviceName);
    const deviceModel = normalizePairingDeviceModel(rawDeviceModel);
    if (String(signatureAlgorithm ?? '').trim().toLowerCase() !== 'ecdsa-p256-sha256') {
      throw new MobilePairingError(400, 'reverse_p256_proof_required', 'Reverse pairing requires a P-256 device proof');
    }
    const key = verifyProof({
      proofMessage: reversePairingProofMessage({
        presentationId: presentation.presentationId,
        challenge: presentation.challenge,
        deviceId,
        deviceName,
        deviceModel,
      }),
      publicKey,
      signature,
      signatureAlgorithm,
    });
    presentation.deviceId = deviceId;
    presentation.deviceName = deviceName;
    presentation.deviceModel = deviceModel;
    presentation.publicKeyFingerprint = publicKeyFingerprint(key);
    presentation.verificationCode = verificationCode();
    presentation.status = 'waiting';
    return safePresentation(presentation);
  }

  inspectPresentation({ presentationId: id, now } = {}) {
    const presentation = this.presentationForId(id, this.currentTime(now));
    if (presentation.status !== 'waiting') {
      return {
        presentationId: presentation.presentationId,
        status: presentation.status,
        expiresAt: presentation.expiresAt,
      };
    }
    return safePresentation(presentation);
  }

  approvePresentation({ presentationId: id, verificationCode: suppliedCode, now } = {}) {
    const presentation = this.presentationForId(id, this.currentTime(now));
    this.assertPresentationStatus(presentation, 'waiting');
    if (!sameSecretHash(hashText(presentation.verificationCode), hashText(String(suppliedCode ?? '').trim()))) {
      throw new MobilePairingError(403, 'verification_code_mismatch', 'Verification code does not match');
    }
    presentation.status = 'approved';
    presentation.approvedAt = this.currentTime(now);
    return safePresentation(presentation);
  }

  rejectPresentation({ presentationId: id, verificationCode: suppliedCode, now } = {}) {
    const presentation = this.presentationForId(id, this.currentTime(now));
    this.assertPresentationStatus(presentation, 'waiting');
    if (!sameSecretHash(hashText(presentation.verificationCode), hashText(String(suppliedCode ?? '').trim()))) {
      throw new MobilePairingError(403, 'verification_code_mismatch', 'Verification code does not match');
    }
    presentation.status = 'rejected';
    return safePresentation(presentation);
  }

  presentationForPoll({ presentationId: id, pollToken, now } = {}) {
    const presentation = this.presentationForId(id, this.currentTime(now));
    if (!pollToken || !sameSecretHash(presentation.pollTokenHash, hashText(pollToken))) {
      throw new MobilePairingError(401, 'invalid_poll_token', 'Invalid pairing poll token');
    }
    return presentation;
  }

  cancelPresentation({ presentationId: id, pollToken, now } = {}) {
    const presentation = this.presentationForPoll({ presentationId: id, pollToken, now });
    if (presentation.status === 'created' || presentation.status === 'waiting') {
      presentation.status = 'cancelled';
    }
    return {
      presentationId: presentation.presentationId,
      status: presentation.status,
      expiresAt: presentation.expiresAt,
    };
  }

  completePresentation({ presentationId: id, pollToken, issueSession, now } = {}) {
    const current = this.currentTime(now);
    const presentation = this.presentationForPoll({ presentationId: id, pollToken, now: current });
    if (presentation.status === 'approved' && current > presentation.expiresAt + this.completionGraceMs) {
      presentation.status = 'expired';
    }
    if (presentation.status !== 'approved') {
      return {
        presentationId: presentation.presentationId,
        status: presentation.status,
        expiresAt: presentation.expiresAt,
      };
    }
    if (presentation.completionConsumed) {
      return {
        presentationId: presentation.presentationId,
        status: 'completed',
        expiresAt: presentation.expiresAt,
      };
    }
    if (typeof issueSession !== 'function') {
      throw new MobilePairingError(500, 'session_issuer_unavailable', 'Pairing session issuer unavailable');
    }
    const session = issueSession({ deviceId: presentation.deviceId });
    presentation.completionConsumed = true;
    presentation.status = 'completed';
    return {
      presentationId: presentation.presentationId,
      status: 'approved',
      deviceId: presentation.deviceId,
      accessToken: session.accessToken,
      ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      expiresAt: session.expiresAt,
    };
  }
}
