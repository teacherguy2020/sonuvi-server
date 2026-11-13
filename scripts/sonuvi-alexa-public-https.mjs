#!/usr/bin/env node
// Installed host oneshot only; never invoked with user-selected shell/paths.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {alexaPublicCaddyfile} from '../src/lib/alexa-public-https.mjs';
if(process.getuid?.()!==0)throw Error('root_required');
const config='/var/lib/sonuvi/config/now-playing.config.json';
const target='/etc/sonuvi/alexa-public.Caddyfile';
const marker='/var/lib/sonuvi/config/alexa-public-https-status.json';
const unit='sonuvi-alexa-public.service';
try{
 const next=alexaPublicCaddyfile(JSON.parse(await fs.readFile(config,'utf8')));
 if(next===null){execFileSync('/usr/bin/systemctl',['stop',unit]);await fs.writeFile(marker,JSON.stringify({managed:true,state:'disabled'})+'\n',{mode:0o644});}
 else{
  const prior=await fs.readFile(target,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  if(prior!==next){
   const temporary=target+'.next';await fs.writeFile(temporary,next,{mode:0o644});
   execFileSync('/usr/bin/caddy',['validate','--config',temporary,'--adapter','caddyfile'],{stdio:'pipe'});
   await fs.rename(temporary,target);execFileSync('/usr/bin/systemctl',['restart',unit]);
  }else execFileSync('/usr/bin/systemctl',['start',unit]);
  await fs.writeFile(marker,JSON.stringify({managed:true,state:'awaiting-public-verification',internalPort:9443,externalPort:443,challenge:'tls-alpn-01'})+'\n',{mode:0o644});
 }
}catch{
 // Invalid settings must never leave a previous domain publicly served.
 execFileSync('/usr/bin/systemctl',['stop',unit],{stdio:'pipe'});
 await fs.writeFile(marker,JSON.stringify({managed:true,state:'configuration-error'})+'\n',{mode:0o644});
 process.exitCode=1;
}
