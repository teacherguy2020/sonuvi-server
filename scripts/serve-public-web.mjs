#!/usr/bin/env node
import '../src/config/master-runtime-bootstrap.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { X509Certificate } from 'node:crypto';

import { createPublicWebServer, resolvePublicWebListenHost } from '../src/lib/public-web-server.mjs';
import { createLocalBrowserRuntime, LOCAL_BROWSER_PORT } from '../src/lib/sonuvi-local-browser.mjs';

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

const certPath = String(process.env.SONUVI_WEB_TLS_CERT || '').trim();
const keyPath = String(process.env.SONUVI_WEB_TLS_KEY || '').trim();
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('TLS certificate and key must both be configured');
const servers = [];
if (process.env.SONUVI_LOCAL_HTTPS_ENABLED === '1') {
  const local = await createLocalBrowserRuntime({publicRoot:configuredRoot,stateRoot:process.env.SONUVI_STATE_ROOT || '/var/lib/sonuvi',
    onReloadError:()=>process.stderr.write('Local browser TLS renewal unavailable; trust was not changed.\n')});
  await new Promise((resolve,reject)=>{local.server.once('error',reject);local.server.listen(LOCAL_BROWSER_PORT,host,resolve);});
  servers.push(local.server);
}
if (certPath) {
  if (![certPath,keyPath].every(path.isAbsolute)) throw new Error('TLS paths must be absolute protected paths');
  const origin = new URL(process.env.SONUVI_CONTROLLER_WEB_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('TLS requires the configured HTTPS controller origin');
  const tlsPort = Number(process.env.SONUVI_WEB_TLS_PORT || origin.port || '443');
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535 || tlsPort === port || tlsPort !== Number(origin.port || '443')) throw new Error('TLS port must match controller origin and differ from HTTP port');
  const server = await createPublicWebServer({ publicRoot: configuredRoot, tls: { cert: await fs.readFile(certPath), key: await fs.readFile(keyPath) } });
  server.listen(tlsPort, host, () => process.stdout.write(`Sonuvi HTTPS web server listening on ${host}:${tlsPort}\n`));
  // Never derive a redirect authority from untrusted Host/Forwarded headers.
  const caPath = String(process.env.SONUVI_WEB_CA_CERT || '').trim();
  const caCertificate = caPath ? new X509Certificate(await fs.readFile(caPath)).toString() : '';
  const redirect = http.createServer((req,res) => {
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(400,{'content-type':'text/plain'});res.end('Use the HTTPS controller address.');return;}
    let target;try { target = new URL(req.url, origin); } catch {res.writeHead(400);res.end();return;}
    if (target.pathname === '/sonuvi-browser-ca.crt' && caCertificate) {res.writeHead(200,{'content-type':'application/x-x509-ca-cert','content-disposition':'attachment; filename=sonuvi-browser-ca.crt','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:caCertificate);return;}
    // The immutable upgrade health contract remains available over loopback HTTP.
    if (target.pathname === '/release.json' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      fs.readFile(path.join(configuredRoot,'release.json')).then(body=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}).catch(()=>{res.writeHead(503);res.end();});return;
    }
    res.writeHead(307,{location:origin.origin+target.pathname+target.search,'cache-control':'no-store'});res.end();
  });
  redirect.listen(port,host);servers.push(server,redirect);
} else {
  const server = await createPublicWebServer({ publicRoot: configuredRoot });
  server.listen(port, host, () => process.stdout.write(`Sonuvi public web server listening on ${host}:${port}\n`));servers.push(server);
}
function stop() {
  // Bound graceful draining: SSE/proxy requests can otherwise hold systemd stop
  // indefinitely. Force remaining HTTP connections closed before its deadline.
  const deadline = setTimeout(() => {
    for (const server of servers) server.closeAllConnections?.();
    process.exit(0);
  }, 5000);
  deadline.unref();
  Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeIdleConnections?.();
  }))).then(() => { clearTimeout(deadline); process.exit(0); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
