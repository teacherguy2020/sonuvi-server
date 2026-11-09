#!/usr/bin/env node
import fs from 'node:fs/promises';

import {
  GATE_C_EXISTING_INSTALL_UPGRADE_PATHS,
  runGateCExistingInstallUpgrade,
} from '../src/lib/sonuvi-gate-c-existing-install-upgrade.mjs';

const TRUST_ANCHOR_PATH = GATE_C_EXISTING_INSTALL_UPGRADE_PATHS.trustAnchorPath;
const INPUT_LIMIT = 128 * 1024;

async function fixedInput(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('upgrade_input_invalid');
    chunks.push(chunk);
  }
  if (!bytes) throw new Error('upgrade_input_invalid');
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch {
    throw new Error('upgrade_input_invalid');
  }
}

async function main({ stdin = process.stdin, stdout = process.stdout, uid = process.getuid?.() } = {}) {
  let result;
  if (uid !== 0) {
    result = {
      contract: 'sonuvi.gate-c-existing-install-upgrade.v1',
      operation: 'activate_existing_install',
      ok: false,
      code: 'upgrade_authorization_required',
    };
    stdout.write(`${JSON.stringify(result)}\n`);
    return 77;
  }
  try {
    const request = await fixedInput(stdin);
    let trustedAnchors = null;
    try { trustedAnchors = JSON.parse(await fs.readFile(TRUST_ANCHOR_PATH, 'utf8')); } catch {}
    result = await runGateCExistingInstallUpgrade({ request, trustedAnchors });
  } catch {
    result = {
      contract: 'sonuvi.gate-c-existing-install-upgrade.v1',
      operation: 'activate_existing_install',
      ok: false,
      code: 'upgrade_input_invalid',
    };
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

const exitCode = await main();
process.exitCode = exitCode;
