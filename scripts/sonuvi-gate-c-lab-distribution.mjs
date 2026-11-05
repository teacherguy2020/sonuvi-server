#!/usr/bin/env node
import fs from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';

import {
  GATE_C_LAB_TRUSTED_LAN_CIDR,
  createGateCLabDistributionServer,
  isGateCLabTrustedLanAddress,
} from '../src/lib/sonuvi-gate-c-lab-distribution.mjs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const accepted = new Set(['--release-root', '--tls-cert', '--tls-key', '--port', '--bind-address', '--trusted-lan-cidr']);
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--') && !accepted.has(argument)) throw new Error(`unsupported option: ${argument}`);
}
const releaseRoot = required('--release-root');
const tlsCert = required('--tls-cert');
const tlsKey = required('--tls-key');
const port = Number(value('--port') || '9443');
if (!Number.isSafeInteger(port) || port !== 9443) throw new Error('the lab distribution port is fixed at 9443');
const host = value('--bind-address') || '127.0.0.1';
const trustedLanCidr = value('--trusted-lan-cidr');
const isLoopback = host === '127.0.0.1';
const isApprovedLanHost = host === '10.0.0.210';
if (!isLoopback && !isApprovedLanHost) throw new Error('the lab distribution bind address is not approved');
if (isLoopback && trustedLanCidr) throw new Error('a loopback listener cannot declare a trusted LAN');
if (isApprovedLanHost && trustedLanCidr !== GATE_C_LAB_TRUSTED_LAN_CIDR) {
  throw new Error(`the approved LAN listener requires ${GATE_C_LAB_TRUSTED_LAN_CIDR}`);
}
if (isApprovedLanHost) {
  const hostOwnsAddress = Object.values(os.networkInterfaces())
    .flat()
    .some((entry) => entry?.family === 'IPv4' && entry.address === host && !entry.internal);
  if (!hostOwnsAddress) throw new Error('the approved LAN bind address is not assigned to this host');
}

const { distribution, server } = await createGateCLabDistributionServer({
  releaseRoot,
  tls: { cert: await fs.readFile(tlsCert), key: await fs.readFile(tlsKey) },
  isTrustedRemoteAddress: isApprovedLanHost ? isGateCLabTrustedLanAddress : undefined,
});
server.once('error', (error) => {
  process.stderr.write(`sonuvi Gate C lab distribution failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen({ host, port });
await once(server, 'listening');
process.stdout.write(`${JSON.stringify({ ready: true, host, port, trustedLanCidr: isApprovedLanHost ? trustedLanCidr : null, releaseId: distribution.releaseId, prefix: `/v1/gate-c/releases/${distribution.releaseId}/` })}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
