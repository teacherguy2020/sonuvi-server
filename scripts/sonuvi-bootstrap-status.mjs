#!/usr/bin/env node
import fs from 'node:fs/promises';

import { readBootstrapStatus } from '../src/lib/sonuvi-bootstrap-status.mjs';

// Root-only fixed status endpoint for SSH. It consumes a single structured
// request and never invokes an installer, service manager, shell, or network.
if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-bootstrap-status requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const request = JSON.parse(await fs.readFile('/dev/stdin', 'utf8'));
    process.stdout.write(`${JSON.stringify({ ok: true, ...(await readBootstrapStatus({ request })))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'bootstrap_status_failed' })}\n`);
    process.exitCode = 1;
  }
}
