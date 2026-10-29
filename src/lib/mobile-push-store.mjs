import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

const STORE_VERSION = 1;
const TOKEN_PATTERN = /^[A-Fa-f0-9]{32,512}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export function normalizeMobilePushToken(value) {
  const token = String(value || '').trim();
  return TOKEN_PATTERN.test(token) ? token.toLowerCase() : '';
}

export function normalizeMobilePushEnvironment(value) {
  const environment = String(value || '').trim().toLowerCase();
  return environment === 'development' || environment === 'production'
    ? environment
    : '';
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : '';
}

function normalizeTopic(value) {
  const topic = String(value || '').trim();
  return topic && topic.length <= 200 && /^[A-Za-z0-9.-]+$/.test(topic) ? topic : '';
}

function normalizeRecord(value) {
  const token = normalizeMobilePushToken(value?.token);
  const deviceId = normalizeDeviceId(value?.deviceId);
  const environment = normalizeMobilePushEnvironment(value?.environment);
  const topic = normalizeTopic(value?.topic);
  if (!token || !deviceId || !environment || !topic) return null;
  return {
    token,
    deviceId,
    environment,
    topic,
    updatedAt: String(value?.updatedAt || new Date(0).toISOString()),
  };
}

export function createMobilePushTokenStore({ filePath } = {}) {
  const targetPath = path.resolve(String(filePath || runtimeStatePaths().mobilePushTokensPath));
  let records = null;
  let operation = Promise.resolve();

  const run = (task) => {
    const next = operation.then(task, task);
    operation = next.catch(() => {});
    return next;
  };

  const load = async () => {
    if (records) return records;
    try {
      const parsed = JSON.parse(await fs.readFile(targetPath, 'utf8'));
      records = Array.isArray(parsed?.tokens)
        ? parsed.tokens.map(normalizeRecord).filter(Boolean)
        : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A damaged registry should fail closed for delivery, but the next
        // registration can repair it through the normal atomic write path.
        records = [];
      } else {
        records = [];
      }
    }
    return records;
  };

  const persist = async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    const payload = `${JSON.stringify({ version: STORE_VERSION, tokens: records || [] }, null, 2)}\n`;
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600).catch(() => {});
    await fs.rename(temporaryPath, targetPath);
    await fs.chmod(targetPath, 0o600).catch(() => {});
  };

  return {
    path: targetPath,

    async list() {
      return run(async () => (await load()).map((record) => ({ ...record })));
    },

    async upsert({ token, deviceId, environment, topic } = {}) {
      const normalized = normalizeRecord({
        token,
        deviceId,
        environment,
        topic,
        updatedAt: new Date().toISOString(),
      });
      if (!normalized) throw new Error('invalid mobile push token registration');

      return run(async () => {
        await load();
        records = records.filter((record) => (
          record.token !== normalized.token
          && !(record.deviceId === normalized.deviceId && record.topic === normalized.topic)
        ));
        records.push(normalized);
        await persist();
        return { ...normalized };
      });
    },

    async remove({ deviceId, token } = {}) {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const normalizedToken = normalizeMobilePushToken(token);
      return run(async () => {
        await load();
        const before = records.length;
        records = records.filter((record) => {
          if (normalizedToken && record.token === normalizedToken) return false;
          if (normalizedDeviceId && record.deviceId === normalizedDeviceId) return false;
          return true;
        });
        if (records.length !== before) await persist();
        return { removed: before - records.length };
      });
    },
  };
}
