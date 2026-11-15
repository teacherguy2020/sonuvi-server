import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { readLocalTLSBundle } from './sonuvi-local-tls.mjs';

export const REMOTE_CONTRACT = 'sonuvi.remote-access.v1';
export const REMOTE_PROXY_PORT = 8445;
export function remoteOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(value)) throw new Error('remote_address_invalid');
  return value;
}
export async function readRemoteConfiguration(stateRoot = '/var/lib/sonuvi', ownerUID = 0) {
  let file;
  try { file = await fs.open(path.join(stateRoot, 'config/remote-access.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ownerUID || (stat.mode & 0o022) || stat.size > 4096) throw new Error('remote_config_unsafe');
    const value = JSON.parse(await file.readFile('utf8'));
    if (value.contract !== REMOTE_CONTRACT || typeof value.serverId !== 'string') throw new Error('remote_config_invalid');
    return { contract: REMOTE_CONTRACT, serverId: value.serverId, remoteOrigin: remoteOrigin(value.remoteOrigin) };
  } finally { await file.close(); }
}
// Public delegation, signed by the same leaf key whose chain the app already
// trusts. Knowing a Server ID or presenting a new public certificate is not
// sufficient to retarget an existing device's credentials.
export function signRemoteProof(configuration, bundle, now = Date.now()) {
  if (configuration.serverId !== bundle.serverId) throw new Error('remote_identity_mismatch');
  const payload = Buffer.from(JSON.stringify({contract: REMOTE_CONTRACT, serverId: bundle.serverId,
    localOrigin: bundle.origin, remoteOrigin: remoteOrigin(configuration.remoteOrigin),
    issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 300}));
  return {payload: payload.toString('base64'), certificateDER: new crypto.X509Certificate(bundle.cert).raw.toString('base64'),
    signature: crypto.sign('sha256', payload, bundle.key).toString('base64')};
}
export function registerRemoteAccessRoute(app, {stateRoot = '/var/lib/sonuvi', ownerUID = 0} = {}) {
  app.get('/v1/auth/remote-access', async (_req, res) => {
    res.setHeader('Cache-Control','no-store');
    try {
      const configuration = await readRemoteConfiguration(stateRoot, ownerUID);
      if (!configuration) return res.json({ok: true, configured: false});
      const bundle = await readLocalTLSBundle({stateRoot, ownerUID});
      return res.json({ok: true, configured: true, proof: signRemoteProof(configuration, bundle)});
    } catch { return res.status(503).json({ok: false, error: 'remote_access_unavailable'}); }
  });
}
export function permitsRemoteRequest(req) {
  // No browser cookies/origin authority, legacy control paths, web config, or
  // administrator bootstrap exposed by this native-only tailnet listener.
  if (req.headers?.origin || req.headers?.cookie || req.headers?.['sec-fetch-site']) return false;
  const p = (req.url || '').split('?')[0];
  if (!/^\/[A-Za-z0-9_./-]+$/.test(p) || p.includes('..') || p.includes('//')) return false;
  if (['/v1/auth/status','/v1/auth/remote-access'].includes(p)) return req.method === 'GET';
  if (p === '/v1/auth/login') return req.method === 'POST';
  return p.startsWith('/v1/mobile/');
}
export function createRemoteNativeListener(handler) {
  return http.createServer((req,res) => {
    if (!permitsRemoteRequest(req)) { res.writeHead(403, {'Content-Type':'application/json'}); res.end('{"ok":false,"error":"remote_route_rejected"}'); return; }
    handler(req,res);
  });
}
