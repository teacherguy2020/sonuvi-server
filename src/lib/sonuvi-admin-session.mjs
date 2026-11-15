import crypto, { verify as verifySignature } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AdministratorAuthority } from './sonuvi-admin-authority.mjs';
import { normalizeAdministratorPublicKey } from './sonuvi-bootstrap-security.mjs';

export const ADMINISTRATOR_SESSION_REQUEST_CONTRACT = 'sonuvi.administrator-session-request.v1';
export const ADMINISTRATOR_SESSION_CONTRACT = 'sonuvi.administrator-session.v1';
export const ADMINISTRATOR_SESSION_PROOF_DOMAIN = 'sonuvi-administrator-session-v1';

const SESSION_TTL_MS = 15 * 60 * 1000;
const PROOF_MAX_TTL_MS = 5 * 60 * 1000;

function text(value) { return String(value ?? '').trim(); }
function absolute(value, label) { const result = text(value); if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be absolute`); return path.resolve(result); }
function targetIdentity(value) { const result = text(value); if (!/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error('administrator session target identity is invalid'); return result; }
function deviceId(value) { const result = text(value); if (!/^[A-Za-z0-9._-]{8,200}$/.test(result)) throw new Error('administrator session device ID is invalid'); return result; }
function nonce(value) { const result = text(value); if (!/^[A-Za-z0-9_-]{22,160}$/.test(result)) throw new Error('administrator session nonce is invalid'); return result; }
function proof(value) { const result = text(value); if (!/^[A-Za-z0-9_-]{80,200}$/.test(result)) throw new Error('administrator session proof is invalid'); return result; }
function nonceHash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('base64url'); }

function expiresAt(value, now) {
  const parsed = Date.parse(text(value));
  const current = Number(now());
  if (!Number.isFinite(parsed) || !Number.isFinite(current) || parsed <= current || parsed > current + PROOF_MAX_TTL_MS) {
    throw new Error('administrator session proof is expired');
  }
  return new Date(parsed).toISOString();
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function administratorSessionProofMessage({ operation, targetIdentity: target, administratorDeviceId, nonce: sessionNonce, expiresAt: proofExpiresAt, administratorPublicKey = '' } = {}) {
  const fields = [
    ADMINISTRATOR_SESSION_PROOF_DOMAIN,
    text(operation),
    targetIdentity(target),
    deviceId(administratorDeviceId),
    nonce(sessionNonce),
    text(proofExpiresAt),
  ];
  if (operation === 'rebind_administrator') fields.push(normalizeAdministratorPublicKey(administratorPublicKey).spki);
  return Buffer.from(fields.join('\n'), 'utf8');
}

export function normalizeAdministratorSessionRequest(input = {}, { now = () => Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('administrator session request is invalid');
  if (text(input.contract) !== ADMINISTRATOR_SESSION_REQUEST_CONTRACT) throw new Error('administrator session contract is invalid');
  const operation = text(input.operation);
  const rebind = operation === 'rebind_administrator';
  if (!rebind && operation !== 'issue_session') throw new Error('administrator session operation is invalid');
  const expected = rebind
    ? ['administratorDeviceId', 'administratorProof', 'administratorPublicKey', 'contract', 'expiresAt', 'nonce', 'operation', 'targetIdentity']
    : ['administratorDeviceId', 'administratorProof', 'contract', 'expiresAt', 'nonce', 'operation', 'targetIdentity'];
  if (!exactKeys(input, expected)) throw new Error('administrator session request has unsupported fields');
  const normalized = {
    contract: ADMINISTRATOR_SESSION_REQUEST_CONTRACT,
    operation,
    targetIdentity: targetIdentity(input.targetIdentity),
    administratorDeviceId: deviceId(input.administratorDeviceId),
    nonce: nonce(input.nonce),
    expiresAt: expiresAt(input.expiresAt, now),
    administratorProof: proof(input.administratorProof),
  };
  if (rebind) normalized.administratorPublicKey = normalizeAdministratorPublicKey(input.administratorPublicKey).spki;
  return Object.freeze(normalized);
}

async function readJsonOrNull(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function writePrivateJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Root-only nonce ledger. It retains hashes, never proof nonces or tokens. */
export class AdministratorSessionNonceLedger {
  constructor({ stateRoot, now = () => Date.now() } = {}) {
    this.root = absolute(stateRoot, 'state root');
    this.now = now;
    this.file = path.join(this.root, 'protected', 'administrator-session-nonces.json');
    this.lock = `${this.file}.lock`;
  }

  async consume(value, expiresAtValue) {
    const digest = nonceHash(nonce(value));
    const expires = Date.parse(text(expiresAtValue));
    const now = Number(this.now());
    if (!Number.isFinite(expires) || !Number.isFinite(now)) throw new Error('administrator session nonce is invalid');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await fs.open(this.lock, 'wx', 0o600).catch((error) => {
      if (error?.code === 'EEXIST') throw new Error('administrator_session_nonce_conflict');
      throw error;
    });
    try {
      const previous = await readJsonOrNull(this.file);
      if (previous && (previous.version !== 1 || !Array.isArray(previous.entries))) throw new Error('administrator_session_nonce_state_invalid');
      const entries = (previous?.entries || []).filter((entry) => Number(Date.parse(entry?.expiresAt)) > now);
      if (entries.some((entry) => entry?.nonceHash === digest)) throw new Error('administrator_session_replayed');
      entries.push({ nonceHash: digest, expiresAt: new Date(expires).toISOString() });
      await writePrivateJson(this.file, { version: 1, entries });
    } finally {
      await handle.close();
      await fs.unlink(this.lock).catch(() => {});
    }
  }
}

function verifyProof({ record, request }) {
  const publicKey = normalizeAdministratorPublicKey(request.administratorPublicKey || record.administratorPublicKey);
  const signature = Buffer.from(request.administratorProof, 'base64url');
  const message = administratorSessionProofMessage({ ...request, administratorPublicKey: publicKey.spki });
  if (!signature.length || !verifySignature('sha256', message, { key: publicKey.key, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('administrator session proof is invalid');
  }
}

/**
 * Fixed root-side issuer. It accepts only a proof over the bound target and a
 * fresh nonce, then reuses the existing per-server ES256 administrator token.
 */
export async function runAdministratorSession({
  request,
  stateRoot = '/var/lib/sonuvi',
  now = () => Date.now(),
  authority = null,
  nonceLedger = null,
} = {}) {
  const input = normalizeAdministratorSessionRequest(request, { now });
  const administratorAuthority = authority || new AdministratorAuthority({ stateRoot });
  const ledger = nonceLedger || new AdministratorSessionNonceLedger({ stateRoot, now });
  const record = await administratorAuthority.administratorRecord();
  if (input.targetIdentity !== record.targetIdentity || input.administratorDeviceId !== record.deviceId) {
    throw new Error('administrator_session_identity_mismatch');
  }

  if (input.operation === 'issue_session') {
    if (record.legacy) throw new Error('administrator_rebind_required');
    verifyProof({ record, request: input });
    await ledger.consume(input.nonce, input.expiresAt);
    const administratorAccessToken = await administratorAuthority.issueAccessToken({ administratorId: record.administratorId, ttlMs: SESSION_TTL_MS });
    return Object.freeze({
      contract: ADMINISTRATOR_SESSION_CONTRACT,
      state: 'issued',
      role: 'administrator',
      administratorId: record.administratorId,
      expiresAt: new Date(Number(now()) + SESSION_TTL_MS).toISOString(),
      administratorAccessToken,
    });
  }

  if (!record.legacy) throw new Error('administrator_rebind_not_required');
  verifyProof({ record: { ...record, administratorPublicKey: input.administratorPublicKey }, request: input });
  await ledger.consume(input.nonce, input.expiresAt);
  const rebound = await administratorAuthority.rebindLegacyAdministrator({
    targetIdentity: input.targetIdentity,
    administratorDeviceId: input.administratorDeviceId,
    administratorPublicKey: input.administratorPublicKey,
  });
  return Object.freeze({
    contract: ADMINISTRATOR_SESSION_CONTRACT,
    state: 'administrator-rebound',
    role: 'administrator',
    administratorId: rebound.administratorId,
  });
}
