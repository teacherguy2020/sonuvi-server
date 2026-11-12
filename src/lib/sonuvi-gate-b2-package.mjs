import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const GATE_B2_PACKAGE_CONTRACT = 'sonuvi.gate-b2-package.v1';
async function hash(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
/** Build a manifest only: no VM, service, or privileged host operation occurs. */
export async function buildGateB2ReadinessPackage({ outputPath, helperPath, lockfilePath, serviceTemplatePaths = [] } = {}) {
  const files = [helperPath, lockfilePath, ...serviceTemplatePaths].map((file) => path.resolve(String(file || ''))); if (files.some((file) => !path.isAbsolute(file))) throw new Error('package inputs must be absolute');
  const manifest = { contract: GATE_B2_PACKAGE_CONTRACT, createdAt: new Date().toISOString(), files: await Promise.all(files.map(async (file) => ({ path: path.basename(file), sha256: await hash(file) }))) };
  const target = path.resolve(String(outputPath || '')); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); return Object.freeze({ manifestPath: target, manifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), manifest });
}
