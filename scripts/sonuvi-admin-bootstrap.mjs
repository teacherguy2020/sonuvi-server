#!/usr/bin/env node
import fs from 'node:fs/promises';

import { runAdministratorBootstrap } from '../src/lib/sonuvi-admin-bootstrap.mjs';

// This fixed local command is the enrollment leg of the authenticated SSH
// bootstrap. It is not a network listener and accepts no path, command, or
// release selector from callers.
if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-admin-bootstrap requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const request = JSON.parse(await fs.readFile('/dev/stdin', 'utf8'));
    const result = await runAdministratorBootstrap({ request });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'administrator_bootstrap_failed' })}\n`);
    process.exitCode = 1;
  }
}
