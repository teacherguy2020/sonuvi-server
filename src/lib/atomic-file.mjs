import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

/**
 * Write a file through a same-directory temporary name, then rename it into
 * place. Keeping the temporary beside the target preserves atomic rename
 * semantics on the same filesystem and leaves an interrupted old file intact.
 */
export async function writeFileAtomically(filePath, data, { mode = 0o600 } = {}) {
  const requested = String(filePath || '').trim();
  if (!requested) throw new Error('atomic write target is required');
  const target = path.resolve(requested);
  if (target === path.parse(target).root) throw new Error('atomic write target is required');
  runtimeCapabilities().assertStateWrite(target);
  const directory = path.dirname(target);
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temp, data, { encoding: 'utf8', mode });
    await fs.chmod(temp, mode).catch(() => {});
    await fs.rename(temp, target);
    await fs.chmod(target, mode).catch(() => {});
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomically(filePath, value, { mode = 0o600, trailingNewline = true } = {}) {
  const serialized = JSON.stringify(value, null, 2);
  return writeFileAtomically(filePath, trailingNewline ? `${serialized}\n` : serialized, { mode });
}
