#!/usr/bin/env node
import fs from 'node:fs/promises';

import { runFixedTargetInstallation } from '../src/lib/sonuvi-target-installer.mjs';

// This executable is intended to be invoked locally through explicit sudo.
// It accepts one fixed JSON request from stdin and never interprets shell text.
if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-target-installer requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const request = JSON.parse(await fs.readFile('/dev/stdin', 'utf8'));
    const result = await runFixedTargetInstallation({ request });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'installation_failed' })}\n`);
    process.exitCode = 1;
  }
}
