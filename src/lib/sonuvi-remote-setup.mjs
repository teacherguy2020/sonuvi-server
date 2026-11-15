import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readGateCTargetIdentity} from './sonuvi-gate-c-target-preflight.mjs';
import {readLocalTLSBundle} from './sonuvi-local-tls.mjs';
import {REMOTE_CONTRACT, remoteOrigin, readRemoteConfiguration} from './sonuvi-remote-access.mjs';
const execute=promisify(execFile);
const tailscale=async args => (await execute('/usr/bin/tailscale',args,{timeout:20000,maxBuffer:131072})).stdout;
export function classifyServe(config, hostname) {
  const web=config.Web?.[hostname+':443'];
  const tcp=config.TCP?.['443'];
  const exact=web && Object.keys(web.Handlers || {}).length===1 && web.Handlers['/']?.Proxy==='http://127.0.0.1:8445' && tcp?.HTTPS===true;
  if (config.AllowFunnel && Object.values(config.AllowFunnel).some(Boolean)) return 'conflict';
  if (web || tcp) return exact ? 'configured' : 'conflict';
  return 'empty';
}
export async function runRemoteSetup(input,{stateRoot='/var/lib/sonuvi',ownerUID=0,run=tailscale,targetIdentity=readGateCTargetIdentity}={}) {
  if (!input || input.contract!==REMOTE_CONTRACT || !['status','enable'].includes(input.operation) || Object.keys(input).some(k=>!['contract','operation','targetIdentity'].includes(k))) throw new Error('remote_request_invalid');
  if (input.targetIdentity!==await targetIdentity()) throw new Error('remote_target_mismatch');
  const base={ok:true,contract:REMOTE_CONTRACT,targetIdentity:input.targetIdentity};
  let status;
  try { status=JSON.parse(await run(['status','--json'])); }
  catch(e) { return {...base,state:e.code==='ENOENT'?'needs-install':'unavailable'}; }
  if(status.BackendState!=='Running') return {...base,state:'needs-login'};
  const hostname=(status.Self?.DNSName || '').replace(/\.$/,'');
  const origin=remoteOrigin('https://'+hostname);
  const bundle=await readLocalTLSBundle({stateRoot,ownerUID});
  if(!bundle)throw new Error('remote_local_identity_missing');
  const previous=await readRemoteConfiguration(stateRoot,ownerUID);
  if(previous && (previous.serverId!==bundle.serverId || previous.remoteOrigin!==origin))throw new Error('remote_configuration_changed');
  const config=JSON.parse(await run(['serve','status','--json']));
  const current=classifyServe(config,hostname);
  if(current==='conflict')return {...base,state:'conflict'};
  if(input.operation==='status')return {...base,state:current==='configured'&&previous?'configured':'not-configured',remoteOrigin:origin};
  // Do not reset/overwrite unrelated services, routes or tailnet settings.
  if(current!=='configured') await run(['serve','--bg','--https=443','--yes','http://127.0.0.1:8445']);
  if(classifyServe(JSON.parse(await run(['serve','status','--json'])),hostname)!=='configured')throw new Error('remote_serve_unverified');
  const destination=path.join(stateRoot,'config/remote-access.json');
  const temporary=destination+'.'+crypto.randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,JSON.stringify({contract:REMOTE_CONTRACT,serverId:bundle.serverId,remoteOrigin:origin})+'\n',{flag:'wx',mode:0o644});
    await fs.chown(temporary,ownerUID,-1);await fs.rename(temporary,destination);
  } finally {await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return {...base,state:'configured',remoteOrigin:origin};
}
