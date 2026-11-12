#!/usr/bin/env node
import { recoverOwnerFromPrivilegedHost } from '../src/lib/sonuvi-owner-recovery.mjs';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Fixed explicit sudo/root entry point. No caller paths, commands, lifetime,
// password, release or service overrides. Never install an unauthenticated
// HTTP wrapper or an unprivileged sudoers bypass for this command.
if (process.getuid?.() !== 0) {
  process.stderr.write('Explicit root authorization is required.\n');
  process.exitCode = 77;
} else {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16384) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { stdout } = await promisify(execFile)('/usr/bin/id', ['-g', 'sonuvi']);
    if (!/^\d+\s*$/.test(stdout)) throw new Error('service_group_unavailable');
    const result = await recoverOwnerFromPrivilegedHost({ request });
    // Match the installer's root:sonuvi read-only verifier boundary. This
    // does not grant the API access to protected signing/identity material.
    await fs.chown('/var/lib/sonuvi/config/administrator-verifier.json', 0, Number(stdout.trim()));
    await fs.chmod('/var/lib/sonuvi/config/administrator-verifier.json', 0o640);
    // Private SSH stdout is a credential handoff, not a log.
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: 'owner_recovery_failed' }) + '\n');
    process.exitCode = 1;
  }
}
