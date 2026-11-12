import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeAdministratorPublicKey } from './sonuvi-bootstrap-security.mjs';

const TOKEN_TYPE = 'sonuvi-administrator';
const TOKEN_ALGORITHM = 'ES256';
const VERIFIER_VERSION = 1;

function text(value) { return String(value ?? '').trim(); }
function absolute(value) { const result = text(value); if (!result || !path.isAbsolute(result)) throw new Error('state root must be absolute'); return path.resolve(result); }
function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
function digest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function readJsonOrNull(file) { try { return await readJson(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function writePrivate(file, value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fs.rename(temp, file); }

// The verifier is intentionally non-secret and pre-created during root-owned
// installation. Direct replacement preserves its root:sonuvi ownership/mode,
// so the unprivileged API can verify but never sign administrator tokens.
async function writeVerifier(file, value) {
  const handle = await fs.open(file, 'w', 0o640);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

function parseVerifier(value) {
  if (!value || value.version !== VERIFIER_VERSION || value.algorithm !== TOKEN_ALGORITHM || !/^[A-Za-z0-9_-]+$/.test(text(value.publicKey))) throw new Error('administrator verifier is invalid');
  const key = crypto.createPublicKey({ key: Buffer.from(value.publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('administrator verifier is invalid');
  return Object.freeze({
    key,
    publicKey: text(value.publicKey),
    status: text(value.status),
    administratorId: text(value.administratorId) || null,
    serverId: text(value.serverId) || `sonuvi-${digest(text(value.publicKey))}`,
  });
}

function createMaterial() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return Object.freeze({
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  });
}

/** Durable administrator authority is separate from mobile bearer and Track Key. */
export class AdministratorAuthority {
  constructor({ stateRoot, now = () => Date.now(), verifyLoginSession = null } = {}) {
    this.root = absolute(stateRoot);
    this.now = now;
    this.verifyLoginSession = verifyLoginSession;
    this.identityFile = path.join(this.root, 'protected', 'administrator-identity.json');
    this.keyFile = path.join(this.root, 'protected', 'administrator-signing.key');
    this.verifierFile = path.join(this.root, 'config', 'administrator-verifier.json');
  }

  async provisionSigningMaterial() {
    const [key, verifier] = await Promise.all([readJsonOrNull(this.keyFile), readJsonOrNull(this.verifierFile)]);
    if (key && verifier) { parseVerifier(verifier); return Object.freeze({ provisioned: false }); }
    if (key || verifier) throw new Error('administrator_authority_material_incomplete');
    const material = createMaterial();
    await writePrivate(this.keyFile, { version: 1, algorithm: TOKEN_ALGORITHM, privateKey: material.privateKey });
    await fs.mkdir(path.dirname(this.verifierFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.verifierFile, `${JSON.stringify({ version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: material.publicKey, status: 'unclaimed', administratorId: null })}\n`, { mode: 0o600 });
    return Object.freeze({ provisioned: true });
  }

  async initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof } = {}) {
    const existing = await readJsonOrNull(this.identityFile);
    const verifier = parseVerifier(await readJson(this.verifierFile));
    const material = await readJson(this.keyFile);
    if (material?.algorithm !== TOKEN_ALGORITHM || !text(material?.privateKey)) throw new Error('administrator_authority_material_incomplete');
    const claimed = await enrollment.claim({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey, administratorProof });
    if (existing) {
      if (existing.role !== 'administrator' || existing.attemptId !== text(attemptId) || existing.targetIdentity !== text(targetIdentity) || existing.deviceId !== text(claimed.administratorDeviceId) || existing.publicKeyHash !== text(claimed.administratorPublicKeyHash) || !text(existing.administratorId) || !text(existing.createdAt)) throw new Error('administrator_authority_exists');
      // Version 1 records retained only the hash. A resumable first-install
      // claim proves possession again, so it is the only safe automatic path
      // that may upgrade such a record with its non-secret SPKI verifier.
      const storedPublicKey = text(existing.administratorPublicKey);
      if (storedPublicKey) {
        const normalized = normalizeAdministratorPublicKey(storedPublicKey);
        if (normalized.spki !== text(claimed.administratorPublicKey) || digest(normalized.spki) !== text(existing.publicKeyHash)) throw new Error('administrator_authority_exists');
      } else {
        await writePrivate(this.identityFile, {
          ...existing,
          version: 2,
          administratorPublicKey: text(claimed.administratorPublicKey),
        });
      }
      if (verifier.status !== 'claimed' || verifier.administratorId !== existing.administratorId) {
        await writeVerifier(this.verifierFile, { version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: verifier.publicKey, serverId: verifier.serverId, status: 'claimed', administratorId: existing.administratorId });
      }
      return Object.freeze({ administratorId: existing.administratorId, role: existing.role, createdAt: existing.createdAt });
    }
    const identity = {
      version: 2,
      role: 'administrator',
      administratorId: `adm_${crypto.randomBytes(16).toString('base64url')}`,
      deviceId: text(claimed.administratorDeviceId),
      administratorPublicKey: text(claimed.administratorPublicKey),
      publicKeyHash: text(claimed.administratorPublicKeyHash),
      createdAt: new Date(this.now()).toISOString(),
      attemptId: text(attemptId),
      targetIdentity: text(targetIdentity),
      enrollmentStatus: claimed.status,
    };
    await writePrivate(this.identityFile, identity);
    await writeVerifier(this.verifierFile, { version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: verifier.publicKey, serverId: verifier.serverId, status: 'claimed', administratorId: identity.administratorId });
    return Object.freeze({ administratorId: identity.administratorId, role: identity.role, createdAt: identity.createdAt });
  }

  /**
   * Returns only non-secret administrator identity material. Version 1
   * records remain valid for the bootstrap handoff but cannot issue a new
   * post-install session because they have no public-key verifier.
   */
  async administratorRecord() {
    const identity = await readJson(this.identityFile);
    if (identity?.role !== 'administrator' || !text(identity.administratorId) || !text(identity.deviceId) || !text(identity.targetIdentity) || !text(identity.publicKeyHash)) {
      throw new Error('administrator_identity_invalid');
    }
    const version = Number(identity.version) || 1;
    const administratorPublicKey = text(identity.administratorPublicKey);
    if (!administratorPublicKey) {
      if (version !== 1) throw new Error('administrator_identity_invalid');
      return Object.freeze({
        version: 1,
        administratorId: text(identity.administratorId),
        deviceId: text(identity.deviceId),
        targetIdentity: text(identity.targetIdentity),
        publicKeyHash: text(identity.publicKeyHash),
        legacy: true,
      });
    }
    if (version !== 2) throw new Error('administrator_identity_invalid');
    const normalized = normalizeAdministratorPublicKey(administratorPublicKey);
    if (digest(normalized.spki) !== text(identity.publicKeyHash)) throw new Error('administrator_identity_invalid');
    return Object.freeze({
      version,
      administratorId: text(identity.administratorId),
      deviceId: text(identity.deviceId),
      targetIdentity: text(identity.targetIdentity),
      publicKeyHash: text(identity.publicKeyHash),
      administratorPublicKey: normalized.spki,
      legacy: false,
    });
  }

  /**
   * This is deliberately a root-side recovery primitive. Callers must have
   * already obtained explicit local root authorization; ordinary API, mobile,
   * Track Key, and SSH credentials are never accepted here as authority.
   */
  async rebindLegacyAdministrator({ targetIdentity, administratorDeviceId, administratorPublicKey } = {}) {
    const identity = await readJson(this.identityFile);
    const current = await this.administratorRecord();
    if (!current.legacy) throw new Error('administrator_rebind_not_required');
    if (text(targetIdentity) !== current.targetIdentity || text(administratorDeviceId) !== current.deviceId) throw new Error('administrator_rebind_identity_mismatch');
    const normalized = normalizeAdministratorPublicKey(administratorPublicKey);
    // A legacy record still pins a hash of its original P-256 SPKI. Root
    // authorization selects this recovery operation; the matching hash and
    // the caller's fresh proof prove it is the enrolled administrator key,
    // rather than a newly supplied key paired with a claimed device ID.
    if (digest(normalized.spki) !== current.publicKeyHash) throw new Error('administrator_rebind_key_mismatch');
    // Rebinding changes the proof verifier. Rotate the Server token signing
    // material first so any short-lived token issued before explicit recovery
    // dies even if a crash occurs before the durable identity upgrade. The
    // legacy record then remains safely recoverable through this same explicit
    // root-authorized path.
    const material = createMaterial();
    await writePrivate(this.keyFile, { version: 1, algorithm: TOKEN_ALGORITHM, privateKey: material.privateKey });
    await writeVerifier(this.verifierFile, {
      version: VERIFIER_VERSION,
      algorithm: TOKEN_ALGORITHM,
      publicKey: material.publicKey,
      serverId: (await this.ownership()).serverId,
      status: 'claimed',
      administratorId: current.administratorId,
    });
    const next = {
      ...identity,
      version: 2,
      administratorPublicKey: normalized.spki,
      publicKeyHash: digest(normalized.spki),
      reboundAt: new Date().toISOString(),
    };
    await writePrivate(this.identityFile, next);
    return this.administratorRecord();
  }

  async issueAccessToken({ administratorId, ttlMs = 15 * 60 * 1000 } = {}) {
    const [identity, material, verifierRecord] = await Promise.all([readJson(this.identityFile), readJson(this.keyFile), readJson(this.verifierFile)]);
    const verifier = parseVerifier(verifierRecord);
    if (identity.administratorId !== text(administratorId) || verifier.status !== 'claimed' || verifier.administratorId !== identity.administratorId || material?.algorithm !== TOKEN_ALGORITHM) throw new Error('administrator_identity_mismatch');
    const nowSec = Math.floor(this.now() / 1000);
    const payload = { typ: TOKEN_TYPE, v: 1, role: 'administrator', administratorId: identity.administratorId, iat: nowSec, exp: nowSec + Math.max(1, Math.floor(ttlMs / 1000)), jti: crypto.randomBytes(16).toString('base64url') };
    const signed = `${encode({ typ: TOKEN_TYPE, v: 1, alg: TOKEN_ALGORITHM })}.${encode(payload)}`;
    const signature = crypto.sign('sha256', Buffer.from(signed, 'utf8'), { key: material.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${signed}.${signature}`;
  }

  async ownership() {
    const verifier = parseVerifier(await readJson(this.verifierFile));
    return Object.freeze({
      claimed: verifier.status === 'claimed' && Boolean(verifier.administratorId),
      administratorId: verifier.administratorId,
      serverId: verifier.serverId,
      authorityGeneration: digest(verifier.publicKey),
    });
  }

  async verifyAccessToken(token) {
    const rootClaims = await this.verifyRootAccessToken(token);
    if (rootClaims) return rootClaims;
    try { return this.verifyLoginSession ? await this.verifyLoginSession(token) : null; }
    catch { return null; }
  }

  /** Root-only recovery after independently verified privileged host control. */
  async recoverFromPrivilegedHost({ targetIdentity, administratorDeviceId, administratorPublicKey } = {}) {
    const normalized = normalizeAdministratorPublicKey(administratorPublicKey);
    const previous = await readJsonOrNull(this.identityFile);
    const verifier = parseVerifier(await readJson(this.verifierFile));
    if (previous && previous.targetIdentity !== targetIdentity) throw new Error('administrator_recovery_target_mismatch');
    const administratorId = previous?.administratorId || `adm_${crypto.randomBytes(16).toString('base64url')}`;
    const material = createMaterial();
    await writePrivate(this.keyFile, { version: 1, algorithm: TOKEN_ALGORITHM, privateKey: material.privateKey });
    await writePrivate(this.identityFile, {
      version: 2, role: 'administrator', administratorId,
      deviceId: administratorDeviceId, administratorPublicKey: normalized.spki,
      publicKeyHash: digest(normalized.spki), targetIdentity,
      createdAt: previous?.createdAt || new Date(this.now()).toISOString(),
      recoveredAt: new Date(this.now()).toISOString(),
      attemptId: previous?.attemptId || `recovery_${crypto.randomUUID()}`,
    });
    await writeVerifier(this.verifierFile, { version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: material.publicKey, serverId: verifier.serverId, status: 'claimed', administratorId });
    return { administratorId, administratorAccessToken: await this.issueAccessToken({ administratorId, ttlMs: 5 * 60 * 1000 }) };
  }

  async verifyRootAccessToken(token) {
    try {
      const [header, body, signature] = text(token).split('.');
      if (!header || !body || !signature) return null;
      const verifier = parseVerifier(await readJson(this.verifierFile));
      if (verifier.status !== 'claimed' || !verifier.administratorId) return null;
      const parsedHeader = decode(header);
      const claims = decode(body);
      const valid = crypto.verify('sha256', Buffer.from(`${header}.${body}`, 'utf8'), { key: verifier.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      if (!valid || parsedHeader.typ !== TOKEN_TYPE || parsedHeader.alg !== TOKEN_ALGORITHM || claims.role !== 'administrator' || claims.administratorId !== verifier.administratorId || Number(claims.exp) <= Math.floor(this.now() / 1000)) return null;
      return Object.freeze({ administratorId: claims.administratorId, role: 'administrator' });
    } catch { return null; }
  }

  async revoke() {
    const verifier = await readJsonOrNull(this.verifierFile);
    if (verifier) await writeVerifier(this.verifierFile, { ...verifier, status: 'revoked', administratorId: null });
    await fs.unlink(this.keyFile).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    await fs.unlink(this.identityFile).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

/** Dependency-free guard for the API; verification needs only the public key. */
export async function requireAdministratorAuthorization({ authority, bearerToken } = {}) {
  const claims = await authority?.verifyAccessToken(bearerToken);
  if (!claims) { const error = new Error('administrator_authorization_required'); error.code = 'administrator_authorization_required'; throw error; }
  return claims;
}
