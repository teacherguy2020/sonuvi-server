import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createPeppyIngest} from '../src/lib/peppy-ingest.mjs';
test('Peppy ingress requires dedicated credential and validates fixed telemetry only',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'peppy-'));const token='x'.repeat(48);const tokenFile=path.join(dir,'token');await fs.writeFile(tokenFile,token);const received=[];
 const up=http.createServer(async(req,res)=>{let s='';for await(const c of req)s+=c;received.push({url:req.url,body:JSON.parse(s)});res.end('{}');});await new Promise(r=>up.listen(0,'127.0.0.1',r));
 const ingest=createPeppyIngest({tokenFile,apiPort:up.address().port});const server=http.createServer(async(req,res)=>{if(!await ingest(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=(route,body,auth=true,method='PUT')=>fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:auth?{authorization:'Bearer '+token}:{},body:method==='GET'?undefined:JSON.stringify(body)});
 try{
 assert.equal((await call('/__peppy/vumeter',{left:1,right:2,mono:1},false)).status,401);
 assert.equal((await call('/__peppy/vumeter',null,true,'GET')).status,405);
 assert.equal((await call('/__peppy/other',{})).status,404);
 assert.equal((await call('/__peppy/vumeter',{left:101,right:2,mono:1})).status,400);
 assert.equal((await call('/__peppy/vumeter',{left:1,right:2,mono:1,command:'x'})).status,400);
 assert.equal((await call('/__peppy/spectrum',{bins:[1,'2']})).status,400);
 assert.equal((await call('/__peppy/vumeter',{left:1,right:2,mono:1})).status,200);
 assert.equal((await call('/__peppy/spectrum',{bins:[1,2],size:2,maxValue:100})).status,200);
 assert.deepEqual(received.map(x=>x.url),['/peppy/vumeter','/peppy/spectrum']);
 }finally{server.closeAllConnections();up.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>up.close(r))]);await fs.rm(dir,{recursive:true});}
});
