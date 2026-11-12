#!/usr/bin/env node
import fs from 'node:fs/promises';

import { runFixedTargetInstallation } from '../src/lib/sonuvi-target-installer.mjs';

// This executable is intended to be invoked locally through explicit sudo.
// It accepts one fixed JSON request from stdin and never interprets shell text.
const INPUT_LIMIT = 128 * 1024;

async function fixedInput(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('installer_request_too_large');
    chunks.push(chunk);
  }
  if (!bytes) throw new Error('installer_request_missing');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-target-installer requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const request = await fixedInput(process.stdin);
    const result = await runFixedTargetInstallation({ request });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'installation_failed' })}\n`);
    process.exitCode = 1;
  }
}
