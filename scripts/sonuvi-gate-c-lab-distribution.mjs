#!/usr/bin/env node
import fs from 'node:fs/promises';
import { once } from 'node:events';

import { createGateCLabDistributionServer } from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const accepted = new Set(['--release-root', '--tls-cert', '--tls-key', '--port']);
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--') && !accepted.has(argument)) throw new Error(`unsupported option: ${argument}`);
}
const releaseRoot = required('--release-root');
const tlsCert = required('--tls-cert');
const tlsKey = required('--tls-key');
const port = Number(value('--port') || '9443');
if (!Number.isSafeInteger(port) || port !== 9443) throw new Error('the lab distribution port is fixed at 9443');

const { distribution, server } = await createGateCLabDistributionServer({
  releaseRoot,
  tls: { cert: await fs.readFile(tlsCert), key: await fs.readFile(tlsKey) },
});
server.once('error', (error) => {
  process.stderr.write(`sonuvi Gate C lab distribution failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port });
await once(server, 'listening');
process.stdout.write(`${JSON.stringify({ ready: true, host: '127.0.0.1', port, releaseId: distribution.releaseId, prefix: `/v1/gate-c/releases/${distribution.releaseId}/` })}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
