#!/usr/bin/env node
import fs from 'node:fs/promises';

import { activateVerifiedStagedRelease } from '../src/lib/sonuvi-gate-c-first-install.mjs';

const TRUST_ANCHOR_PATH = '/etc/sonuvi/release-trust-anchors.json';
const INPUT_LIMIT = 128 * 1024;

async function fixedInput(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('first_install_request_too_large');
    chunks.push(chunk);
  }
  if (!bytes) throw new Error('first_install_request_missing');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-first-install-activate requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const [request, anchors] = await Promise.all([
      fixedInput(process.stdin),
      fs.readFile(TRUST_ANCHOR_PATH, 'utf8').then(JSON.parse),
    ]);
    const result = await activateVerifiedStagedRelease({ request, trustedAnchors: anchors });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: String(error?.message || 'first_install_activation_failed').replace(/[^a-z0-9_]/gi, '_').slice(0, 96) })}\n`);
    process.exitCode = 1;
  }
}
