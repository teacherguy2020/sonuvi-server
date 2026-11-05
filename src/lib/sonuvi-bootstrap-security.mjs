import crypto, { createPublicKey, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SONUVI_BOOTSTRAP_TRANSPORT_VERSION = 1;
export const BOOTSTRAP_OPERATIONS = Object.freeze(['preflight', 'install', 'status', 'enrollment_create', 'enrollment_claim']);
export const BOOTSTRAP_SERVICE_UNITS = Object.freeze(['sonuvi-api.service', 'sonuvi-web.service']);
const TOKEN_BYTES = 32;
export const FIRST_ADMINISTRATOR_CLAIM_PROOF_DOMAIN = 'sonuvi-first-administrator-claim-v1';

function text(value) { return String(value ?? '').trim(); }
function digest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest(); }
function equal(left, right) { return left?.length === right?.length && crypto.timingSafeEqual(left, right); }
function safeId(value, label) { const result = text(value); if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error(`${label} is invalid`); return result; }
function safeDeviceId(value) { const result = text(value); if (!/^[A-Za-z0-9._-]{8,200}$/.test(result)) throw new Error('administrator device ID is invalid'); return result; }
function absolute(value, label) { const result = text(value); if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be absolute`); return path.resolve(result); }
function nowIso(now) { return new Date(now()).toISOString(); }

/** Accept the same P-256 SPKI representation used by the native pairing flow. */
export function normalizeAdministratorPublicKey(value) {
  const input = text(value);
  if (!input || input.length > 16 * 1024) throw new Error('administrator public key is invalid');
  let key;
  try {
    key = /-----BEGIN PUBLIC KEY-----/.test(input)
      ? createPublicKey(input)
      : createPublicKey({ key: Buffer.from(input, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('administrator public key is invalid');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('administrator public key must be P-256');
  }
  return Object.freeze({ key, spki: key.export({ format: 'der', type: 'spki' }).toString('base64url') });
}

export function firstAdministratorClaimMessage({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId } = {}) {
  return Buffer.from([
    FIRST_ADMINISTRATOR_CLAIM_PROOF_DOMAIN,
    safeId(attemptId, 'attempt ID'),
    safeId(targetIdentity, 'target identity'),
    safeDeviceId(administratorDeviceId),
    text(enrollmentToken),
  ].join('\n'), 'utf8');
}

export function verifyFirstAdministratorClaimProof({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof } = {}) {
  const normalized = normalizeAdministratorPublicKey(administratorPublicKey);
  let proof;
  try { proof = Buffer.from(text(administratorProof), 'base64url'); } catch { proof = Buffer.alloc(0); }
  if (!proof.length || !verifySignature('sha256', firstAdministratorClaimMessage({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId }), { key: normalized.key, dsaEncoding: 'ieee-p1363' }, proof)) {
    throw new Error('administrator proof is invalid');
  }
  return Object.freeze({
    administratorDeviceId: safeDeviceId(administratorDeviceId),
    administratorPublicKey: normalized.spki,
    administratorPublicKeyHash: digest(normalized.spki).toString('base64url'),
  });
}

/** Pure host-key policy for native clients. A changed key is never auto-trusted. */
export function verifyBootstrapHostKey({ knownFingerprint = '', presentedFingerprint = '', trustUnknown = false } = {}) {
  const known = text(knownFingerprint); const presented = text(presentedFingerprint);
  if (!/^SHA256:[A-Za-z0-9+/=]+$/.test(presented)) return Object.freeze({ accepted: false, code: 'host_key_invalid' });
  if (!known) return Object.freeze(trustUnknown ? { accepted: true, code: 'host_key_enrolled' } : { accepted: false, code: 'host_key_unknown', requiresExplicitTrust: true });
  return Object.freeze(known === presented ? { accepted: true, code: 'host_key_pinned' } : { accepted: false, code: 'host_key_changed' });
}

/** JSON-lines protocol only; SSH is transport and may carry no arbitrary command. */
export function normalizeBootstrapOperation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bootstrap operation must be an object');
  const version = Number(input.version);
  const operation = text(input.operation);
  if (version !== SONUVI_BOOTSTRAP_TRANSPORT_VERSION || !BOOTSTRAP_OPERATIONS.includes(operation)) throw new Error('unsupported bootstrap operation');
  const attemptId = safeId(input.attemptId, 'attempt ID'); const targetIdentity = safeId(input.targetIdentity, 'target identity');
  const extra = Object.keys(input).filter((key) => !['version', 'operation', 'attemptId', 'targetIdentity', 'payload'].includes(key));
  if (extra.length || (input.payload && typeof input.payload !== 'object')) throw new Error('bootstrap operation has unsupported fields');
  for (const key of Object.keys(input.payload || {})) if (/(?:password|secret|token|private|credential|command|path)/i.test(key)) throw new Error('bootstrap operation contains forbidden payload field');
  return Object.freeze({ version, operation, attemptId, targetIdentity, payload: Object.freeze({ ...(input.payload || {}) }) });
}

export function bootstrapResponse({ operation, attemptId, targetIdentity, ok, code = null, state = null } = {}) {
  return Object.freeze({ version: SONUVI_BOOTSTRAP_TRANSPORT_VERSION, operation: text(operation), attemptId: safeId(attemptId, 'attempt ID'), targetIdentity: safeId(targetIdentity, 'target identity'), ok: ok === true, code: code ? text(code) : null, state: state ? text(state) : null });
}

async function readJsonOrNull(filePath) { try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function writePrivateJson(filePath, value) { await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }); const temporary = `${filePath}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fs.rename(temporary, filePath); }

/** Persistent, single-use claim state. The raw enrollment token is never written. */
export class FirstAdministratorEnrollment {
  constructor({ stateRoot, now = () => Date.now(), ttlMs = 10 * 60 * 1000 } = {}) { this.stateRoot = absolute(stateRoot, 'state root'); this.now = now; this.ttlMs = ttlMs; this.file = path.join(this.stateRoot, 'protected', 'first-administrator-enrollment.json'); this.lock = `${this.file}.lock`; }
  async withLock(fn) { await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); const handle = await fs.open(this.lock, 'wx', 0o600).catch((error) => { if (error?.code === 'EEXIST') throw new Error('enrollment_conflict'); throw error; }); try { return await fn(); } finally { await handle.close(); await fs.unlink(this.lock).catch(() => {}); } }
  async create({ attemptId, targetIdentity } = {}) { return this.withLock(async () => {
    const existing = await readJsonOrNull(this.file);
    if (existing?.status === 'claimed') throw new Error('server_already_claimed');
    if (existing?.status === 'pending' && this.now() < Date.parse(existing.expiresAt)) throw new Error('enrollment_pending');
    const issuedAt = this.now();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const record = { version: 1, status: 'pending', attemptId: safeId(attemptId, 'attempt ID'), targetIdentity: safeId(targetIdentity, 'target identity'), tokenHash: digest(token).toString('base64url'), issuedAt: nowIso(() => issuedAt), expiresAt: nowIso(() => issuedAt + this.ttlMs) };
    await writePrivateJson(this.file, record);
    return Object.freeze({ enrollmentToken: token, expiresAt: record.expiresAt });
  }); }
  async claim({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof } = {}) { return this.withLock(async () => {
    const record = await readJsonOrNull(this.file);
    if (!record) throw new Error('enrollment_missing');
    if (record.attemptId !== safeId(attemptId, 'attempt ID') || record.targetIdentity !== safeId(targetIdentity, 'target identity')) throw new Error('enrollment_target_mismatch');
    // A claim is deliberately resumable only by the same possession proof and
    // enrollment token. This closes the crash window between recording the
    // single-use claim and persisting administrator authority without making
    // a claimed server generally claimable again.
    if (record.status === 'claimed') {
      if (!record.tokenHash || !equal(Buffer.from(record.tokenHash, 'base64url'), digest(text(enrollmentToken)))) throw new Error('server_already_claimed');
      const proof = verifyFirstAdministratorClaimProof({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof });
      if (record.administratorDeviceId !== proof.administratorDeviceId || record.administratorPublicKeyHash !== proof.administratorPublicKeyHash) throw new Error('server_already_claimed');
      return Object.freeze({ status: 'claimed', claimedAt: record.claimedAt, administratorDeviceId: proof.administratorDeviceId, administratorPublicKey: proof.administratorPublicKey, administratorPublicKeyHash: proof.administratorPublicKeyHash });
    }
    if (record.status !== 'pending') throw new Error('enrollment_unavailable');
    if (this.now() >= Date.parse(record.expiresAt)) { await writePrivateJson(this.file, { ...record, status: 'expired' }); throw new Error('enrollment_expired'); }
    if (!equal(Buffer.from(record.tokenHash, 'base64url'), digest(text(enrollmentToken)))) throw new Error('enrollment_invalid');
    const proof = verifyFirstAdministratorClaimProof({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof });
    // tokenHash is a non-secret one-way verifier retained solely for the
    // bounded same-token resumption path above; the raw token is never stored.
    const claimed = { version: 1, status: 'claimed', attemptId: record.attemptId, targetIdentity: record.targetIdentity, tokenHash: record.tokenHash, claimedAt: nowIso(this.now), administratorDeviceId: proof.administratorDeviceId, administratorPublicKeyHash: proof.administratorPublicKeyHash };
    await writePrivateJson(this.file, claimed);
    return Object.freeze({ status: 'claimed', claimedAt: claimed.claimedAt, administratorDeviceId: proof.administratorDeviceId, administratorPublicKey: proof.administratorPublicKey, administratorPublicKeyHash: proof.administratorPublicKeyHash });
  }); }
  async status() { const record = await readJsonOrNull(this.file); if (!record) return Object.freeze({ status: 'absent' }); if (record.status === 'pending' && this.now() >= Date.parse(record.expiresAt)) return Object.freeze({ status: 'expired' }); return Object.freeze({ status: record.status, attemptId: record.attemptId, targetIdentity: record.targetIdentity, expiresAt: record.expiresAt || null }); }
  async revokePending({ attemptId, targetIdentity } = {}) { return this.withLock(async () => { const record = await readJsonOrNull(this.file); if (!record || record.status !== 'pending') return false; if (record.attemptId !== safeId(attemptId, 'attempt ID') || record.targetIdentity !== safeId(targetIdentity, 'target identity')) throw new Error('enrollment_target_mismatch'); await writePrivateJson(this.file, { ...record, status: 'revoked' }); return true; }); }
}
