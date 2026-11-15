import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { bootstrapResponse, normalizeBootstrapOperation, SONUVI_BOOTSTRAP_TRANSPORT_VERSION } from './sonuvi-bootstrap-security.mjs';

export const SONUVI_BOOTSTRAP_HELPER_VERSION = '1.0.0';
export function bootstrapHelperDescriptor({ helperPath, trustedSha256, minProtocol = SONUVI_BOOTSTRAP_TRANSPORT_VERSION } = {}) {
  const digest = String(trustedSha256 || '').trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('trusted bootstrap helper digest is invalid');
  return Object.freeze({ helperVersion: SONUVI_BOOTSTRAP_HELPER_VERSION, protocolVersion: minProtocol, helperPath: String(helperPath || '').trim(), sha256: digest });
}
export async function verifyBootstrapHelperArtifact({ helperPath, descriptor } = {}) {
  const expected = bootstrapHelperDescriptor({ ...descriptor, trustedSha256: descriptor?.trustedSha256 || descriptor?.sha256 }); const actual = crypto.createHash('sha256').update(await fs.readFile(helperPath)).digest('hex');
  if (actual !== expected.sha256) throw new Error('bootstrap_helper_integrity_failed'); return Object.freeze({ ...expected, verified: true });
}
/** One JSON request, one JSON response; caller supplies only the fixed dispatcher. */
export async function processBootstrapJsonLine(line, { dispatch, timeoutMs = 30_000 } = {}) {
  if (typeof dispatch !== 'function') throw new Error('fixed bootstrap dispatcher is required');
  if (Buffer.byteLength(String(line || ''), 'utf8') > 64 * 1024) throw new Error('bootstrap request exceeds size limit');
  let request; try { request = normalizeBootstrapOperation(JSON.parse(String(line))); } catch (error) { return JSON.stringify({ version: SONUVI_BOOTSTRAP_TRANSPORT_VERSION, ok: false, code: 'invalid_request' }); }
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bootstrap_timeout')), timeoutMs); });
  try { const result = await Promise.race([dispatch(request), timeout]); return JSON.stringify(bootstrapResponse({ operation: request.operation, attemptId: request.attemptId, targetIdentity: request.targetIdentity, ok: true, state: result?.state || 'accepted' })); } catch (error) { return JSON.stringify(bootstrapResponse({ operation: request.operation, attemptId: request.attemptId, targetIdentity: request.targetIdentity, ok: false, code: error?.message === 'bootstrap_timeout' ? 'timeout' : 'operation_failed' })); } finally { clearTimeout(timer); }
}
