import https from 'node:https';
import { readLocalTLSBundle, validateLocalTLSBundle } from './sonuvi-local-tls.mjs';

/** Additive native HTTPS listener. Existing LAN compatibility listeners are
 * not silently removed. Only /v1 APIs cross this endpoint; their existing
 * authentication/authorization checks remain authoritative.
 */
export function createLocalTLSListener({ bundle, handler, reload, onReloadError = () => {} }) {
  validateLocalTLSBundle(bundle);
  const origin = new URL(bundle.origin);
  const reject = (res, status) => { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end('{"ok":false,"error":"local_https_request_rejected"}'); };
  const server = https.createServer({key:bundle.key, cert:bundle.cert, minVersion:'TLSv1.2'}, (req,res) => {
    if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin) || req.headers['sec-fetch-site'] === 'cross-site') return reject(res,403);
    // No absolute-form proxy targets, traversal, or legacy/Track-Key routes.
    const rawPath = String(req.url || '').split('?')[0];
    if (!rawPath.startsWith('/v1/') || /[\\\x00-\x20]|%(?:2f|5c|2e)|\.\./i.test(rawPath)) return reject(res,404);
    handler(req,res);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  let timer, running = false;
  const refresh = async () => {
    if (!reload || running) return;
    running = true;
    try {
      const next = await reload();
      if (!next || next.origin !== bundle.origin || next.serverId !== bundle.serverId || next.anchorDER !== bundle.anchorDER) throw new Error('local_tls_reload_identity_changed');
      validateLocalTLSBundle(next);
      server.setSecureContext({ key:next.key, cert:next.cert, minVersion:'TLSv1.2' });
    } catch { onReloadError(); }
    finally { running = false; }
  };
  if (reload) { timer = setInterval(refresh, 5*60000); timer.unref(); }
  server.once('close', () => clearInterval(timer));
  return { server, refresh };
}

export async function loadLocalTLSListener({ stateRoot, handler, onReloadError }) {
  const load = () => readLocalTLSBundle({stateRoot});
  const bundle = await load();
  return bundle ? createLocalTLSListener({bundle, handler, reload:load, onReloadError}) : null;
}
