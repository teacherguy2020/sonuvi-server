import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN_TYPE = 'sonuvi-administrator';
const TOKEN_ALGORITHM = 'ES256';
const VERIFIER_VERSION = 1;

function text(value) { return String(value ?? '').trim(); }
function absolute(value) { const result = text(value); if (!result || !path.isAbsolute(result)) throw new Error('state root must be absolute'); return path.resolve(result); }
function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
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
  constructor({ stateRoot, now = () => Date.now() } = {}) {
    this.root = absolute(stateRoot);
    this.now = now;
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
      if (verifier.status !== 'claimed' || verifier.administratorId !== existing.administratorId) {
        await writeVerifier(this.verifierFile, { version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: verifier.publicKey, status: 'claimed', administratorId: existing.administratorId });
      }
      return Object.freeze({ administratorId: existing.administratorId, role: existing.role, createdAt: existing.createdAt });
    }
    const identity = {
      version: 1,
      role: 'administrator',
      administratorId: `adm_${crypto.randomBytes(16).toString('base64url')}`,
      deviceId: text(claimed.administratorDeviceId),
      publicKeyHash: text(claimed.administratorPublicKeyHash),
      createdAt: new Date(this.now()).toISOString(),
      attemptId: text(attemptId),
      targetIdentity: text(targetIdentity),
      enrollmentStatus: claimed.status,
    };
    await writePrivate(this.identityFile, identity);
    await writeVerifier(this.verifierFile, { version: VERIFIER_VERSION, algorithm: TOKEN_ALGORITHM, publicKey: verifier.publicKey, status: 'claimed', administratorId: identity.administratorId });
    return Object.freeze({ administratorId: identity.administratorId, role: identity.role, createdAt: identity.createdAt });
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

  async verifyAccessToken(token) {
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
