import { execFile } from 'node:child_process';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

export function execFileStrict(cmd, args, opts = {}) {
  const command = String(cmd || 'external-command').split(/[\\/]/).at(-1) || 'external-command';
  runtimeCapabilities().assertExternalMutation(`process.${command}`);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = [
          `cmd=${cmd}`,
          `args=${JSON.stringify(args)}`,
          `err=${err.message}`,
          `stderr=${(stderr || '').trim()}`,
          `stdout=${(stdout || '').trim()}`,
        ].filter(Boolean).join('\n');
        return reject(new Error(msg));
      }
      resolve({ stdout, stderr });
    });
  });
}
