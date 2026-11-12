import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createMobileRefreshToken, createMobileSessionToken } from './mobile-auth.mjs';
import { requireAdministratorAuthorization } from './sonuvi-admin-authority.mjs';

function text(value) { return String(value ?? '').trim(); }
function safeDevice(value) { const result = text(value); if (!/^[A-Za-z0-9._-]{8,200}$/.test(result)) throw new Error('controller device ID is invalid'); return result; }
/**
 * Reuses the existing mobile bearer token format. Administrator authority is
 * needed only to authorize the first controller; it is never embedded in the
 * controller token and controller scope cannot administer the Server.
 */
export async function authorizeFirstController({ authority, administratorToken, mobileApiSecret, controllerDeviceId, stateRoot, now = Date.now() } = {}) {
  const administrator = await requireAdministratorAuthorization({ authority, bearerToken: administratorToken }); const deviceId = safeDevice(controllerDeviceId); const secret = text(mobileApiSecret); if (!secret) throw new Error('mobile API secret is required');
  const root = path.resolve(text(stateRoot)); if (!path.isAbsolute(root)) throw new Error('state root must be absolute');
  const accessToken = createMobileSessionToken({ secret, deviceId, now });
  const refreshToken = createMobileRefreshToken({ secret, deviceId, now });
  // This is an audit record containing only a token hash. It must be written
  // by the unprivileged API, so it lives in the narrowly approved data root,
  // not beside root-only administrator keys or installer state.
  const file = path.join(root, 'data', 'first-controller-pairing.json');
  const existing = await fs.readFile(file, 'utf8').then((value) => JSON.parse(value), (error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && existing.deviceId !== deviceId) throw new Error('first_controller_already_authorized');
  if (!existing) {
    const pairingRecord = { schema: 'sonuvi.first-controller-pairing.v1', deviceId, authorizedBy: administrator.administratorId, authorizedAt: new Date(now).toISOString(), accessTokenHash: crypto.createHash('sha256').update(accessToken).digest('base64url') };
    const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(pairingRecord)}\n`, { mode: 0o600 }); await fs.rename(temp, file);
  }
  return Object.freeze({ deviceId, accessToken, refreshToken, scope: 'mobile-api' });
}
