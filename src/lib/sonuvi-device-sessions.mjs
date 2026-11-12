import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_RECORDS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const validSession = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const identifier = () => crypto.randomBytes(32).toString('base64url');

/**
 * Durable device grants, shared by all API verification boundaries. This store
 * never grants administrator authority and never stores bearer/refresh tokens.
 * Legacy signed credentials remain controller-only until authenticated renewal.
 * Tombstones are permanent: legacy credentials cannot resurrect revoked grants.
 * Each operation rereads disk, so revocation is visible across API processes.
 */
export class DeviceSessionRegistry {
  constructor({ directory, now = () => Date.now(), allowLegacy = true } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('device_session_directory_invalid');
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'devices.json');
    this.lock = path.join(this.directory, 'devices.lock');
    this.now = now;
    this.allowLegacy = allowLegacy;
    // Reject symlink components before creating anything beneath them.
    let ancestor = this.directory;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (fs.realpathSync(ancestor) !== ancestor) throw new Error('device_session_directory_unsafe');
    const fresh = !fs.existsSync(this.directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.checkDirectory();
    if (fresh) {
      const fd = fs.openSync(this.file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, devices: [] })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.read(); // Corrupt or unsafe persistence must fail startup, not reset it.
  }

  checkDirectory() {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('device_session_directory_unsafe');
  }

  read() {
    this.checkDirectory();
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      throw new Error('device_session_state_unavailable');
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > MAX_BYTES) throw new Error('device_session_state_unsafe');
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.devices) || state.devices.length > MAX_RECORDS) throw new Error('device_session_state_invalid');
      const seen = new Set();
      for (const entry of state.devices) {
        if (!validId(entry?.deviceId) || !validSession(entry?.sessionId) || seen.has(entry.deviceId)
            || !['active', 'revoked'].includes(entry.status) || typeof entry.allowLegacy !== 'boolean'
            || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)
            || entry.role !== 'controller') throw new Error('device_session_state_invalid');
        seen.add(entry.deviceId);
      }
      return state.devices;
    } finally { fs.closeSync(fd); }
  }

  mutate(operation) {
    this.checkDirectory();
    // A concurrent writer or a lock left by a crashed writer fails closed. No
    // age-based lock stealing can discard an in-flight revocation.
    const lock = fs.openSync(this.lock, 'wx', 0o600);
    let temporary;
    try {
      const devices = this.read();
      const result = operation(devices);
      if (devices.length > MAX_RECORDS) throw new Error('device_session_capacity');
      const serialized = JSON.stringify({ version: 1, devices });
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('device_session_capacity');
      temporary = path.join(this.directory, `devices.${identifier()}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      temporary = null;
      const directory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return result;
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.closeSync(lock);
      fs.unlinkSync(this.lock);
    }
  }

  accepts(claims) {
    if (!validId(claims?.deviceId)) return false;
    try {
      const record = this.read().find(item => item.deviceId === claims.deviceId);
      if (!record) return this.allowLegacy && claims.sid === undefined;
      if (record.status !== 'active') return false;
      return claims.sid === record.sessionId || (claims.sid === undefined && this.allowLegacy && record.allowLegacy);
    } catch { return false; }
  }

  /** Call only AFTER independent pairing/login authorization, never on refresh. */
  authorize(deviceId) {
    if (!validId(deviceId)) throw new Error('device_session_id_invalid');
    return this.mutate(devices => {
      const old = devices.find(item => item.deviceId === deviceId);
      const record = { deviceId, sessionId: identifier(), role: 'controller', status: 'active', allowLegacy: false, createdAt: this.now(), updatedAt: this.now() };
      if (old) Object.assign(old, record); else devices.push(record);
      return record.sessionId;
    });
  }

  /** Atomically rechecks authorization under the writer lock before migration. */
  renew(claims) {
    if (!validId(claims?.deviceId)) throw new Error('device_session_rejected');
    return this.mutate(devices => {
      const record = devices.find(item => item.deviceId === claims.deviceId);
      if (record) {
        if (record.status !== 'active' || !(claims.sid === record.sessionId || (claims.sid === undefined && this.allowLegacy && record.allowLegacy))) throw new Error('device_session_rejected');
        return record.sessionId;
      }
      if (!this.allowLegacy || claims.sid !== undefined) throw new Error('device_session_rejected');
      const migrated = { deviceId: claims.deviceId, sessionId: identifier(), role: 'controller', status: 'active', allowLegacy: true, createdAt: this.now(), updatedAt: this.now() };
      devices.push(migrated);
      return migrated.sessionId;
    });
  }

  revoke(deviceId) {
    if (!validId(deviceId)) throw new Error('device_session_id_invalid');
    return this.mutate(devices => {
      let record = devices.find(item => item.deviceId === deviceId);
      if (!record) {
        record = { deviceId, sessionId: identifier(), role: 'controller', createdAt: this.now() };
        devices.push(record);
      }
      Object.assign(record, { status: 'revoked', allowLegacy: false, updatedAt: this.now() });
      return true;
    });
  }

  list() {
    return this.read().map(({ deviceId, role, status, createdAt, updatedAt }) => ({ deviceId, role, status, createdAt, updatedAt }));
  }
}
