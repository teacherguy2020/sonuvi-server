import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN_TYPE = 'sonuvi-administrator';
function text(value) { return String(value ?? '').trim(); }
function absolute(value) { const result = text(value); if (!result || !path.isAbsolute(result)) throw new Error('state root must be absolute'); return path.resolve(result); }
function hmac(input, key) { return crypto.createHmac('sha256', key).update(input).digest('base64url'); }
function same(a, b) { const x = Buffer.from(text(a)); const y = Buffer.from(text(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writePrivate(file, value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fs.rename(temp, file); }

/** Durable admin authority is intentionally separate from mobile bearer and Track Key. */
export class AdministratorAuthority {
  constructor({ stateRoot, now = () => Date.now() } = {}) { this.root = absolute(stateRoot); this.now = now; this.identityFile = path.join(this.root, 'protected', 'administrator-identity.json'); this.keyFile = path.join(this.root, 'protected', 'administrator-signing.key'); }
  async initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey } = {}) {
    const existing = await fs.readFile(this.identityFile, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) throw new Error('administrator_authority_exists');
    const claimed = await enrollment.claim({ attemptId, targetIdentity, enrollmentToken, administratorDeviceId, administratorPublicKey });
    const key = crypto.randomBytes(32).toString('base64url');
    const identity = { version: 1, role: 'administrator', administratorId: `adm_${crypto.randomBytes(16).toString('base64url')}`, deviceId: text(administratorDeviceId), publicKeyHash: crypto.createHash('sha256').update(text(administratorPublicKey)).digest('base64url'), createdAt: new Date(this.now()).toISOString(), attemptId: text(attemptId), targetIdentity: text(targetIdentity), enrollmentStatus: claimed.status };
    await writePrivate(this.keyFile, { version: 1, key }); await writePrivate(this.identityFile, identity); return Object.freeze({ administratorId: identity.administratorId, role: identity.role, createdAt: identity.createdAt });
  }
  async issueAccessToken({ administratorId, ttlMs = 15 * 60 * 1000 } = {}) { const identity = await readJson(this.identityFile); if (identity.administratorId !== text(administratorId)) throw new Error('administrator_identity_mismatch'); const key = (await readJson(this.keyFile)).key; const nowSec = Math.floor(this.now() / 1000); const payload = { typ: TOKEN_TYPE, v: 1, role: 'administrator', administratorId: identity.administratorId, iat: nowSec, exp: nowSec + Math.max(1, Math.floor(ttlMs / 1000)), jti: crypto.randomBytes(16).toString('base64url') }; const signed = `${encode({ typ: TOKEN_TYPE, v: 1, alg: 'HS256' })}.${encode(payload)}`; return `${signed}.${hmac(signed, key)}`; }
  async verifyAccessToken(token) { try { const [header, body, signature] = text(token).split('.'); const key = (await readJson(this.keyFile)).key; if (!header || !body || !signature || !same(signature, hmac(`${header}.${body}`, key))) return null; const parsedHeader = decode(header); const claims = decode(body); const identity = await readJson(this.identityFile); if (parsedHeader.typ !== TOKEN_TYPE || claims.role !== 'administrator' || claims.administratorId !== identity.administratorId || Number(claims.exp) <= Math.floor(this.now() / 1000)) return null; return Object.freeze({ administratorId: claims.administratorId, role: 'administrator' }); } catch { return null; } }
  async revoke() { await fs.unlink(this.keyFile).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); await fs.unlink(this.identityFile).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); }
}

/** Dependency-free guard for a future HTTP adapter; no route is registered here. */
export async function requireAdministratorAuthorization({ authority, bearerToken } = {}) { const claims = await authority?.verifyAccessToken(bearerToken); if (!claims) { const error = new Error('administrator_authorization_required'); error.code = 'administrator_authorization_required'; throw error; } return claims; }
