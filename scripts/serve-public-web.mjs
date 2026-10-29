#!/usr/bin/env node
import path from 'node:path';

import { createPublicWebServer, resolvePublicWebListenHost } from '../src/lib/public-web-server.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const configuredRoot = option('--public-root') || String(process.env.SONUVI_PUBLIC_WEB_ROOT || '').trim();
if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
  throw new Error('set SONUVI_PUBLIC_WEB_ROOT or pass --public-root with an absolute release public root');
}
const port = Number(option('--port') || process.env.SONUVI_WEB_PORT || '8101');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SONUVI_WEB_PORT must be a valid TCP port');
const host = resolvePublicWebListenHost(option('--host') || process.env.SONUVI_WEB_HOST);

const server = await createPublicWebServer({ publicRoot: configuredRoot });
server.listen(port, host, () => {
  process.stdout.write(`Sonuvi public web server listening on ${host}:${port}\n`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
