import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const GATE_C_TARGET_PREFLIGHT_CONTRACT = 'sonuvi.gate-c-target-preflight.v1';
export const GATE_C_TARGET_IDENTITY_CONTRACT = 'sonuvi.gate-c-target-identity.v1';
export const GATE_C_TARGET_IDENTITY_ALGORITHM = 'sha256-machine-id';

function text(value) {
  return String(value ?? '').trim();
}

/**
 * The Linux machine ID is never sent to the client.  The public target
 * identity is a domain-separated digest, which the root-side operations
 * independently derive again from the local machine ID.
 */
export function deriveGateCTargetIdentity(machineIdentity) {
  const machine = text(machineIdentity);
  if (!/^[a-f0-9]{32}$/.test(machine)) throw new Error('target_machine_identity_invalid');
  return `sonuvi-target-v1-${crypto.createHash('sha256').update(`sonuvi.gate-c.target.v1:${machine}`, 'utf8').digest('hex')}`;
}

export function normalizeGateCTargetIdentity(value) {
  const identity = text(value);
  if (!/^sonuvi-target-v1-[a-f0-9]{64}$/.test(identity)) throw new Error('target_identity_invalid');
  return identity;
}

export async function readGateCTargetIdentity({ readMachineIdentity = () => fs.readFile('/etc/machine-id', 'utf8') } = {}) {
  return deriveGateCTargetIdentity(await readMachineIdentity());
}

/** Root-side compatibility check repeated after unprivileged preflight. */
export async function verifyGateCTargetCompatibility({
  platform = process.platform,
  architecture = process.arch,
  readFile = fs.readFile,
  lstat = fs.lstat,
} = {}) {
  if (platform !== 'linux' || architecture !== 'arm64') throw new Error('target_unsupported_platform');
  try {
    await readFile('/etc/debian_version', 'utf8');
    const systemctl = await lstat('/usr/bin/systemctl');
    if (!systemctl.isFile() || systemctl.isSymbolicLink()) throw new Error('target_systemd_unavailable');
  } catch (error) {
    if (error?.message === 'target_systemd_unavailable') throw error;
    throw new Error('target_unsupported_debian');
  }
  return Object.freeze({ os: 'debian', architecture: 'arm64', systemd: true, supported: true });
}
