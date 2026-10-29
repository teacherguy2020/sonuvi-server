import WebSocket from 'ws';
import { runtimeCapabilities } from '../lib/runtime-capabilities.mjs';

const HARMONY_ENGINE = 'vnd.logitech.harmony/vnd.logitech.harmony.engine?';

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`Harmony configuration missing: ${name}`);
  return result;
}

function envelope(hubId, command, params, id) {
  return {
    hubId: String(hubId),
    timeout: 30,
    hbus: { cmd: command, id: String(id), params },
  };
}

/**
 * Minimal persistent Harmony client for fire-and-forget IR commands.
 * Harmony holdAction does not reliably return a correlated response, so a
 * successful WebSocket send is treated as delivery. Configuration is kept
 * outside the repository in the Now-Playing service environment.
 */
export class HarmonyHubClient {
  constructor({
    host = process.env.HARMONY_HOST || '',
    port = Number(process.env.HARMONY_PORT || 8088),
    domain = process.env.HARMONY_DOMAIN || 'svcs.myharmony.com',
    hubId = process.env.HARMONY_HUB_ID || '',
    connectTimeoutMs = 10000,
    maxRetries = 2,
    capabilities = runtimeCapabilities(),
  } = {}) {
    this.host = String(host).trim();
    this.port = Number(port);
    this.domain = String(domain).trim();
    this.hubId = String(hubId).trim();
    this.url = this.host && this.hubId
      ? `ws://${this.host}:${this.port}/?domain=${encodeURIComponent(this.domain)}&hubId=${encodeURIComponent(this.hubId)}`
      : '';
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxRetries = maxRetries;
    this.capabilities = capabilities;
    this.socket = null;
    this.connecting = null;
    this.nextId = 1;
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect() {
    required(this.host, 'HARMONY_HOST');
    required(this.hubId, 'HARMONY_HUB_ID');
    this.capabilities.assertExternalRead('harmony.websocket-connect');
    if (this.isOpen()) return this;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error('Harmony WebSocket connection timed out'));
      }, this.connectTimeoutMs);

      this.socket = socket;
      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this);
      });
      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Harmony WebSocket closed while connecting'));
        }
        if (this.socket === socket) this.socket = null;
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async sendWithoutResponse(command, params = {}) {
    this.capabilities.assertExternalMutation('harmony.websocket-command');
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.connect();
        if (!this.isOpen()) throw new Error('Harmony WebSocket is not open');
        const id = String(this.nextId++);
        const payload = envelope(this.hubId, command, params, id);
        await new Promise((resolve, reject) => {
          this.socket.send(JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
        });
        return { sent: true, id };
      } catch (error) {
        lastError = error;
        if (this.socket) {
          try { this.socket.terminate(); } catch {}
          this.socket = null;
        }
        if (attempt < this.maxRetries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

export async function sendHarmonyIrCommand(client, deviceId, command) {
  const id = required(deviceId, 'HARMONY_DENON_DEVICE_ID');
  const name = required(command, 'Harmony command');
  const action = JSON.stringify({ command: name, type: 'IRCommand', deviceId: id });
  return client.sendWithoutResponse(`${HARMONY_ENGINE}holdAction`, {
    status: 'press',
    timestamp: '0',
    verb: 'render',
    action,
  });
}
