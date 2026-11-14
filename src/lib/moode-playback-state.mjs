import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {runtimeStatePaths} from './runtime-state-paths.mjs';

export function projectMoodePlaybackState(value, millsWakeEnabled=true) {
  if (!value || typeof value !== 'object' || !['play','pause','stop','stopped','idle'].includes(value.state)) throw Error('Invalid playback state');
  const flag = key => value[key] === true;
  return {state:value.state,millsMode:millsWakeEnabled && (flag('millsMode') || value.displayMode==='mills'),displayMode:millsWakeEnabled && value.displayMode==='mills'?'mills':'ordinary',isAirplay:flag('isAirplay'),isUpnp:flag('isUpnp'),isStream:flag('isStream'),isQobuz:flag('isQobuz') || value.source==='qobuz-connect'};
}
// A dedicated machine grant, independent of browser sessions and telemetry writes.
// No metadata, URLs, arbitrary upstreams, or control operations are exposed.
export function createMoodePlaybackState({tokenFile=process.env.SONUVI_MOODE_STATE_TOKEN_FILE,apiPort=3101,configFile=runtimeStatePaths().configPath,statusFile=path.join(runtimeStatePaths().dataRoot,'moode-display-state-status.json')}={}) {
  let lastWrite=0;
  return async(req,res)=>{
    if(req.url!=='/__moode/playback-state')return false;
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    if(req.method!=='GET'){send(405,{ok:false});return true;}
    let token='';try{token=(await fs.readFile(tokenFile,'utf8')).trim();}catch{}
    const digest=v=>crypto.createHash('sha256').update(v).digest();
    if(token.length<32 || !crypto.timingSafeEqual(digest(String(req.headers.authorization||'')),digest('Bearer '+token))){send(401,{ok:false});return true;}
    try{
      const up=await fetch(`http://127.0.0.1:${apiPort}/now-playing`,{redirect:'error',signal:AbortSignal.timeout(750)});
      if(!up.ok)throw Error('Upstream unavailable');
      const config=JSON.parse(await fs.readFile(configFile,'utf8'));
      const enabled=config.plugins?.millsDisplay?.enabled===true;
      const body=projectMoodePlaybackState(await up.json(),enabled);
      if(Date.now()-lastWrite>5000){lastWrite=Date.now();await fs.writeFile(statusFile+'.tmp',JSON.stringify({lastSeen:Date.now()}),{mode:0o600});await fs.rename(statusFile+'.tmp',statusFile);lastWrite=Date.now();}
      send(200,body);
    }catch{send(503,{ok:false});}
    return true;
  };
}

export async function moodeDisplayPowerStatus(settings,{statusFile=path.join(runtimeStatePaths().dataRoot,'moode-display-state-status.json')}={}) {
 let lastSeen=null;try{const value=JSON.parse(await fs.readFile(statusFile,'utf8'));if(Number.isFinite(value.lastSeen))lastSeen=value.lastSeen;}catch{}
 const ageMs=lastSeen===null?null:Math.max(0,Date.now()-lastSeen);
 return {enabled:settings?.enabled===true,connection:ageMs!==null&&ageMs<15000?'receiving':'not-verified',lastSeen,ageMs};
}
