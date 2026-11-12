import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AdministratorAuthority } from './sonuvi-admin-authority.mjs';
import { AdministratorSessionNonceLedger } from './sonuvi-admin-session.mjs';
import { normalizeAdministratorPublicKey } from './sonuvi-bootstrap-security.mjs';
import { readGateCTargetIdentity } from './sonuvi-gate-c-target-preflight.mjs';

export const OWNER_RECOVERY_CONTRACT = 'sonuvi.privileged-owner-recovery.v1';
export function ownerRecoveryProofMessage(request) {
  return Buffer.from([OWNER_RECOVERY_CONTRACT, request.targetIdentity, request.administratorDeviceId,
    request.administratorPublicKey, request.nonce, request.expiresAt].join('\n'), 'utf8');
}

/** Not an HTTP handler. The only caller is a fixed explicit-root command. */
export async function recoverOwnerFromPrivilegedHost({ request, stateRoot = '/var/lib/sonuvi',
  getuid = () => process.getuid?.(), targetIdentity = readGateCTargetIdentity, now = () => Date.now() } = {}) {
  if (getuid() !== 0) throw new Error('explicit_root_authorization_required');
  const keys = ['administratorDeviceId','administratorProof','administratorPublicKey','contract','expiresAt','nonce','targetIdentity'];
  if (!request || Array.isArray(request) || Object.keys(request).sort().join(',') !== keys.join(',') || request.contract !== OWNER_RECOVERY_CONTRACT) throw new Error('owner_recovery_request_invalid');
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(request.administratorDeviceId || '') || !/^[A-Za-z0-9_-]{22,160}$/.test(request.nonce || '') || !/^[A-Za-z0-9_-]{80,200}$/.test(request.administratorProof || '')) throw new Error('owner_recovery_request_invalid');
  const expiry = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now() || expiry > now() + 5 * 60000) throw new Error('owner_recovery_expired');
  if (request.targetIdentity !== await targetIdentity()) throw new Error('owner_recovery_target_mismatch');
  const publicKey = normalizeAdministratorPublicKey(request.administratorPublicKey);
  if (publicKey.spki !== request.administratorPublicKey || !crypto.verify('sha256', ownerRecoveryProofMessage(request), { key: publicKey.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(request.administratorProof, 'base64url'))) throw new Error('owner_recovery_proof_invalid');
  const authority = new AdministratorAuthority({ stateRoot, now });
  const lockPath = path.join(stateRoot, 'protected', 'owner-recovery.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    const hasVerifier = await fs.access(authority.verifierFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (!hasVerifier) await authority.provisionSigningMaterial();
    const ledger = new AdministratorSessionNonceLedger({ stateRoot, now });
    await ledger.consume(request.nonce, request.expiresAt);
    return { contract: OWNER_RECOVERY_CONTRACT, ...(await authority.recoverFromPrivilegedHost(request)) };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
