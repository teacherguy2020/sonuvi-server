import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {projectMoodePlaybackState,createMoodePlaybackState} from '../src/lib/moode-playback-state.mjs';
test('projection preserves Mills and ordinary idle semantics without metadata',()=>{
 const state=projectMoodePlaybackState({state:'pause',millsMode:true,artist:'private',file:'secret',displayArtUrl:'private'});assert.equal(state.millsMode,true);assert.equal(state.artist,undefined);assert.equal(state.file,undefined);
 for(const mode of ['pause','stop','idle']){const p=projectMoodePlaybackState({state:mode});assert.equal(p.millsMode,false);assert.equal(p.isAirplay,false);assert.equal(p.isUpnp,false);assert.equal(p.state,mode);}
 assert.equal(projectMoodePlaybackState({state:'pause',displayMode:'mills'}).millsMode,true);assert.throws(()=>projectMoodePlaybackState({ok:false}));
});
test('machine endpoint denies cookies, wrong tokens, writes, query paths; fixed upstream and failure semantics',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moode-state-'));const token='a'.repeat(48);await fs.writeFile(path.join(dir,'token'),token);let calls=0,fail=false;
 const upstream=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/now-playing');assert.equal(req.method,'GET');res.writeHead(fail?500:200,{'content-type':'application/json'});res.end(JSON.stringify({state:'pause',millsMode:true,title:'private'}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 await fs.writeFile(path.join(dir,'config'),JSON.stringify({plugins:{millsDisplay:{enabled:true}}}));
 const handler=createMoodePlaybackState({tokenFile:path.join(dir,'token'),configFile:path.join(dir,'config'),statusFile:path.join(dir,'status'),apiPort:upstream.address().port});const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);await fs.rm(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}/__moode/playback-state`;
 for(const headers of [{},{cookie:'sonuvi_controller=browser'},{authorization:'Bearer wrong'}])assert.equal((await fetch(url,{headers})).status,401);
 const headers={authorization:'Bearer '+token};assert.equal((await fetch(url,{method:'POST',headers})).status,405);assert.equal((await fetch(url+'?target=/config',{headers})).status,404);assert.equal(calls,0);
 let r=await fetch(url,{headers});assert.equal(r.status,200);const p=await r.json();assert.equal(p.millsMode,true);assert.equal(p.title,undefined);await fs.writeFile(path.join(dir,'config'),JSON.stringify({plugins:{millsDisplay:{enabled:false}}}));r=await fetch(url,{headers});assert.equal((await r.json()).millsMode,false);fail=true;assert.equal((await fetch(url,{headers})).status,503);
});
