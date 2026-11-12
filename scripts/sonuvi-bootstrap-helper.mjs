#!/usr/bin/env node
import readline from 'node:readline';
import { processBootstrapJsonLine } from '../src/lib/sonuvi-bootstrap-helper.mjs';

// This entry point intentionally has no host-provisioning implementation.
// A target-installed fixed dispatcher is injected only by the reviewed package.
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const response = await processBootstrapJsonLine(line, { dispatch: async () => { throw new Error('bootstrap_dispatcher_not_installed'); } });
  process.stdout.write(`${response}\n`);
}
