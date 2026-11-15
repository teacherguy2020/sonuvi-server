#!/usr/bin/env node
import fs from 'node:fs/promises';

import { runAdministratorSession } from '../src/lib/sonuvi-admin-session.mjs';

// Fixed local command for the pinned-SSH transport. It accepts a typed
// administrator proof only; callers cannot select paths, commands, releases,
// services, Track Keys, controller credentials, or a token lifetime.
if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-admin-session requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const request = JSON.parse(await fs.readFile('/dev/stdin', 'utf8'));
    const result = await runAdministratorSession({ request });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'administrator_session_failed' })}\n`);
    process.exitCode = 1;
  }
}
