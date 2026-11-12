import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMobileSessionToken, createPersistentMobileRefreshToken, readBearerToken, verifyMobileToken } from './mobile-auth.mjs';
import { isLoopbackAddress } from './controller-browser-dispatch.mjs';

const scrypt = promisify(crypto.scrypt);
const KDF = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const ACCESS_TTL = 15 * 60 * 1000;
const normalizeUsername = input => typeof input === 'string' ? input.trim().toLowerCase() : '';
const validUsername = value => /^[a-z0-9][a-z0-9._@+-]{2,127}$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 1024;

export class LoginError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

/** One human login bound to the existing root-established Server owner. */
export class SonuviLogin {
  constructor({ directory, authority, sessionRegistry, apiSecret, now = () => Date.now() } = {}) {
    if (!path.isAbsolute(directory || '') || !authority || !sessionRegistry || !apiSecret) throw new Error('login_configuration_invalid');
    this.directory = path.resolve(directory);
    let ancestor = this.directory;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (fs.realpathSync(ancestor) !== ancestor) throw new Error('login_directory_unsafe');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.directory, 'owner.json');
    this.lock = path.join(this.directory, 'owner.lock');
    this.authority = authority;
    this.registry = sessionRegistry;
    this.secret = apiSecret;
    this.now = now;
    this.attempts = new Map();
    this.activeDerivations = 0;
    this.dummySalt = crypto.randomBytes(32).toString('hex');
    this.read();
  }

  checkDirectory() {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('login_directory_unsafe');
  }

  read() {
    this.checkDirectory();
    let fd;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('login_state_unavailable'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) throw new Error('login_state_unsafe');
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (record.version !== 1 || record.kdf !== 'scrypt-32768-8-3' || !validUsername(record.username)
          || !/^[a-f0-9]{64}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash)
          || typeof record.administratorId !== 'string' || !record.administratorId
          || typeof record.authorityGeneration !== 'string' || !record.authorityGeneration
          || typeof record.generation !== 'string' || !record.generation) throw new Error('login_state_invalid');
      return record;
    } finally { fs.closeSync(fd); }
  }

  async derive(password, salt) {
    if (this.activeDerivations >= 4) throw new LoginError('login_temporarily_limited', 429);
    this.activeDerivations++;
    try { return await scrypt(password, Buffer.from(salt, 'hex'), 64, KDF); }
    finally { this.activeDerivations--; }
  }

  admit(source, username) {
    const now = this.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    if (this.attempts.size > 4096) throw new LoginError('login_temporarily_limited', 429);
    // Hash labels so neither usernames nor remote addresses are retained as
    // diagnostic text. A global cap also limits distributed password guesses.
    const keys = [['global', 40], [`source:${source}`, 10], [`account:${username}`, 10]];
    for (const [label, limit] of keys) {
      const key = crypto.createHash('sha256').update(label).digest('hex');
      const entry = this.attempts.get(key) || { count: 0, until: now + 60000 };
      if (entry.count >= limit) throw new LoginError('login_temporarily_limited', 429);
      entry.count++;
      this.attempts.set(key, entry);
    }
  }

  async status() {
    const owner = await this.authority.ownership();
    const record = this.read();
    return { serverId: owner.serverId, ownershipEstablished: owner.claimed, loginConfigured: Boolean(owner.claimed && record && record.administratorId === owner.administratorId && record.authorityGeneration === owner.authorityGeneration) };
  }

  async configure({ administratorToken, username, password, replace = false } = {}) {
    // Only the existing root-issued ownership proof may establish/recover a
    // login. A paired controller (or even an ordinary login session) cannot
    // silently replace the owner's durable credential.
    const claims = await this.authority.verifyRootAccessToken(administratorToken);
    if (!claims) throw new LoginError('ownership_proof_required', 401);
    username = normalizeUsername(username);
    if (!validUsername(username) || !validPassword(password)) throw new LoginError('login_credentials_invalid');
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = (await this.derive(password, salt)).toString('hex');
    const lock = fs.openSync(this.lock, 'wx', 0o600);
    let temporary;
    try {
      const owner = await this.authority.ownership();
      const currentOwner = await this.authority.verifyRootAccessToken(administratorToken);
      if (currentOwner?.administratorId !== claims.administratorId || owner.administratorId !== claims.administratorId || !owner.claimed) throw new LoginError('ownership_proof_required', 401);
      const existing = this.read();
      if (existing && !replace) {
        // A lost configure response is safe to retry only for the identical
        // owner, authority generation and credential. Never silently replace.
        if (existing.administratorId === claims.administratorId && existing.authorityGeneration === owner.authorityGeneration && existing.username === username &&
            crypto.timingSafeEqual(await this.derive(password, existing.salt), Buffer.from(existing.hash, 'hex'))) return { configured: true };
        throw new LoginError('login_already_configured', 409);
      }
      // Revoke before committing a replacement: interruption cannot leave a
      // changed password while older administrator sessions remain usable.
      if (existing) this.registry.revokeAdministrator(existing.administratorId);
      const record = { version: 1, kdf: 'scrypt-32768-8-3', username, salt, hash, administratorId: claims.administratorId, authorityGeneration: owner.authorityGeneration, generation: crypto.randomUUID() };
      temporary = path.join(this.directory, `owner.${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); temporary = null;
      const directory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return { configured: true };
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.closeSync(lock); fs.unlinkSync(this.lock);
    }
  }

  async login({ username, password, deviceName = 'Sonuvi device', source = 'unknown', controllerOnly = false } = {}) {
    username = normalizeUsername(username);
    this.admit(String(source).slice(0,256), username.slice(0,128));
    if (!validUsername(username) || !validPassword(password) || typeof deviceName !== 'string' || deviceName.length > 120 || /[\x00-\x1f\x7f]/.test(deviceName)) throw new LoginError('login_failed', 401);
    const record = this.read();
    const hash = await this.derive(password, record?.salt || this.dummySalt);
    const expected = record ? Buffer.from(record.hash, 'hex') : Buffer.alloc(64);
    const passwordMatches = crypto.timingSafeEqual(hash, expected);
    const owner = await this.authority.ownership();
    if (!record || record.username !== username || !passwordMatches || !owner.claimed || record.administratorId !== owner.administratorId || record.authorityGeneration !== owner.authorityGeneration) throw new LoginError('login_failed', 401);
    // Hold the account lock across the final generation check and issuance so
    // a password replacement racing this derivation cannot issue a stale grant.
    const lock = fs.openSync(this.lock, 'wx', 0o600);
    try {
      if (this.read()?.generation !== record.generation) throw new LoginError('login_failed', 401);
      const deviceId = `device-${crypto.randomUUID()}`;
      const sessionId = this.registry.authorize(deviceId, { ...(controllerOnly ? {} : { administratorId: owner.administratorId }), label: deviceName });
      const now = this.now();
      return { tokenType: 'Bearer', deviceId, serverId: owner.serverId, role: controllerOnly ? 'controller' : 'administrator',
        accessToken: createMobileSessionToken({ secret: this.secret, deviceId, sessionId, ttlMs: ACCESS_TTL, now }),
        refreshToken: createPersistentMobileRefreshToken({ secret: this.secret, deviceId, sessionId, now }),
        expiresAt: new Date(now + ACCESS_TTL).toISOString() };
    } finally { fs.closeSync(lock); fs.unlinkSync(this.lock); }
  }

  async verifyAdministratorSession(token) {
    const claims = verifyMobileToken(token, { secret: this.secret, scope: 'mobile-api', now: this.now(), sessionRegistry: this.registry });
    if (!claims) return null;
    const administratorId = this.registry.administratorFor(claims);
    if (!administratorId) return null;
    const owner = await this.authority.ownership();
    const record = this.read();
    if (!owner.claimed || owner.administratorId !== administratorId || record?.administratorId !== administratorId || record.authorityGeneration !== owner.authorityGeneration) return null;
    return { role: 'administrator', administratorId, deviceId: claims.deviceId };
  }
}

/** Transport/origin checks apply before passwords or ownership proofs are used. */
export function registerLoginRoutes(app, { login, canonicalOrigin = '', localTrust = async () => null } = {}) {
  if (!login) return;
  const route = handler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const local = isLoopbackAddress(req.socket?.remoteAddress);
    // Loopback is the existing pinned SSH/HTTPS proxy boundary, not a LAN
    // address inferred from X-Forwarded-For. Direct LAN plaintext is rejected.
    if (!local && req.socket?.encrypted !== true) return res.status(403).json({ ok: false, error: 'secure_transport_required' });
    if (req.headers?.origin && (!canonicalOrigin || req.headers.origin !== canonicalOrigin)) return res.status(403).json({ ok: false, error: 'origin_rejected' });
    if (req.headers?.['sec-fetch-site'] === 'cross-site') return res.status(403).json({ ok: false, error: 'origin_rejected' });
    try { return await handler(req, res); }
    catch (error) {
      const status = error instanceof LoginError ? error.status : error?.code === 'EEXIST' ? 409 : 503;
      return res.status(status).json({ ok: false, error: error instanceof LoginError ? error.code : 'login_unavailable' });
    }
  };
  app.get('/v1/auth/status', route(async (_req, res) => res.json({ ok: true, ...(await login.status()) })));
  app.post('/v1/auth/login', route(async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !['username', 'password', 'deviceName', 'controllerOnly'].includes(key)) || (body.controllerOnly !== undefined && typeof body.controllerOnly !== 'boolean')) throw new LoginError('login_request_invalid');
    return res.json({ ok: true, ...(await login.login({ ...body, source: req.socket?.remoteAddress || 'unknown' })) });
  }));
  app.post('/v1/auth/configure', route(async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !['username', 'password', 'replace'].includes(key)) || (body.replace !== undefined && typeof body.replace !== 'boolean')) throw new LoginError('login_request_invalid');
    const configured = await login.configure({ ...body, administratorToken: readBearerToken(req) });
    // Public material is useful only when received through the verified
    // installer channel. There is no anonymous ownership/trust-claim endpoint.
    return res.json({ ok: true, ...configured, localTrust: await localTrust() });
  }));
}
