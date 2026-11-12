import fs from 'node:fs/promises';
import path from 'node:path';
import { createPublicWebServer } from './public-web-server.mjs';
import { readLocalTLSBundle, validateLocalTLSBundle } from './sonuvi-local-tls.mjs';

export const LOCAL_BROWSER_PORT=8444;

/** Explicit private-browser fallback. Safari must already trust this per-Server
 * root; native pinning cannot make it browser-trusted. No HTTP password path.
 * The optional public-domain listener remains the preferred browser origin.
 */
export async function createLocalBrowserRuntime({publicRoot,stateRoot='/var/lib/sonuvi',load=()=>readLocalTLSBundle({stateRoot}),onReloadError=()=>{}}={}) {
  const bundle=await load();if(!bundle)throw new Error('local_browser_trust_unavailable');
  validateLocalTLSBundle(bundle);
  const origin=new URL(bundle.origin);origin.port=String(LOCAL_BROWSER_PORT);
  const directory=path.join(stateRoot,'data','browser-local');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const server=await createPublicWebServer({publicRoot,tls:{key:bundle.key,cert:bundle.cert},origin:origin.origin,apiPort:3101,sessionFile:path.join(directory,'sessions.json')});
  let running=false;
  const refresh=async()=>{
    if(running)return;running=true;
    try{const next=await load();if(!next||next.serverId!==bundle.serverId||next.origin!==bundle.origin||next.anchorDER!==bundle.anchorDER)throw new Error('local_browser_identity_changed');validateLocalTLSBundle(next);server.setSecureContext({key:next.key,cert:next.cert,minVersion:'TLSv1.2'});}
    catch{onReloadError();}finally{running=false;}
  };
  const timer=setInterval(refresh,5*60000);timer.unref();server.once('close',()=>clearInterval(timer));
  return {server,origin:origin.origin,refresh};
}
