import net from 'node:net';
import { runtimeCapabilities } from './lib/runtime-capabilities.mjs';

import {
  LOCAL_SOCKET_PATH,
  MAX_RESPONSE_BYTES,
  normalizeRequest,
  parseOwnershipResponse,
  parseResponse,
  requestBytes,
} from './protocol.mjs';

const DEFAULT_TIMEOUT_MS = 25_000;

function defaultConnectRequest({ socketPath, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('local bridge request timed out')), timeoutMs);
    socket.on('connect', () => socket.end(input));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) finish(new Error('local bridge response exceeds the size limit'));
      else chunks.push(chunk);
    });
    socket.on('error', (error) => finish(new Error(`local bridge unavailable: ${error.code || 'connect_error'}`)));
    socket.on('close', () => {
      if (!settled) finish(null, Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

/**
 * Client used by the existing Server process. It has no SSH key, host, remote
 * command, or receiver path. The only production destination is the fixed
 * local socket owned by the now-playing service account.
 */
export function createLocalPibuzBridgeClient({
  socketPath = LOCAL_SOCKET_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connectRequest = defaultConnectRequest,
  capabilities = runtimeCapabilities(),
} = {}) {
  if (socketPath !== LOCAL_SOCKET_PATH) throw new Error('local bridge socket path is fixed');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 30_000) {
    throw new Error('local bridge timeout is outside the safe range');
  }

  async function invoke(request) {
    const normalized = normalizeRequest(request);
    requestBytes(normalized);
    const raw = await connectRequest({
      socketPath: LOCAL_SOCKET_PATH,
      input: `${JSON.stringify(normalized)}\n`,
      timeoutMs,
    });
    return parseResponse(String(raw), normalized.operation_id);
  }

  async function invokeOwnership() {
    const normalized = normalizeRequest({
      kind: 'get_ownership',
      protocol_version: 1,
    });
    requestBytes(normalized);
    const raw = await connectRequest({
      socketPath: LOCAL_SOCKET_PATH,
      input: `${JSON.stringify(normalized)}\n`,
      timeoutMs,
    });
    return parseOwnershipResponse(String(raw));
  }

  return {
    loadSavedQueue(request) {
      capabilities.assertExternalMutation('pibuz.saved-queue-load');
      return invoke(request);
    },
    getStatus(operationId) {
      capabilities.assertExternalRead('pibuz.saved-queue-status');
      return invoke({ kind: 'get_status', protocol_version: 1, operation_id: operationId });
    },
    getOwnership() {
      capabilities.assertExternalRead('pibuz.saved-queue-ownership');
      return invokeOwnership();
    },
    socketPathForTest() {
      return LOCAL_SOCKET_PATH;
    },
  };
}
