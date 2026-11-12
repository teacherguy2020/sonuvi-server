import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createMobileControllerBridge } from '../src/lib/mobile-controller-bridge.mjs';
import { createControllerDispatchAuthorizer, validNativeControllerBody, validControllerTarget } from '../src/lib/controller-browser-dispatch.mjs';
import { createMobileSessionToken, createMobileRefreshToken } from '../src/lib/mobile-auth.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
const playback='/config/diagnostics/playback';
test('native Home controls work without Track Key and revalidate the paired grant',async t=>{
 const app=express();app.use(express.json());const secret='native-controller-fixture';let revoked=false;const calls=[];
 const registry={accepts:claims=>!revoked&&claims.deviceId==='paired-native'};
 const authorize=createControllerDispatchAuthorizer({apiSecret:secret,sessionRegistry:registry});
 app.post(playback,(req,res)=>{if(!authorize(req))return res.status(503).json({error:'Operator authentication is unavailable'});assert.equal(req.headers['x-track-key'],undefined);calls.push(req.body);res.json({ok:true,consumeOn:false,repeatMode:req.body.mode});});
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const port=server.address().port;const bridge=createMobileControllerBridge({port});
 app.post('/config/queue-wizard/apply',(req,res)=>{if(!authorize(req))return res.sendStatus(403);calls.push(req.body);res.json({ok:true,added:req.body.tracks.length});});
 const index={tracks:[{file:'USB/Fixture/Album/01.flac',title:'Fixture Song',artist:'Fixture Artist',album:'Fixture Album'}]};
 registerMobileRoutes(app,{enabled:true,apiSecret:secret,trackIdSecret:'test-track',fetchControllerRequest:bridge,getBrowseIndex:async()=>index,mpdQueryRaw:async()=> 'OK\n'});
 const token=createMobileSessionToken({secret,deviceId:'paired-native'});
 const post=(body,bearer=token)=>fetch(`http://127.0.0.1:${port}/v1/mobile/now-playing/control`,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(body)});
 for(const body of [{action:'pause'},{action:'play'},{action:'next'},{action:'previous'},{action:'stop'},{action:'consume'},{action:'consume',state:'off'},{action:'repeatMode',mode:'one'},{action:'seekRelative',seconds:-15},{action:'seekPercent',percent:50}])assert.equal((await post(body)).status,200,JSON.stringify(body));
 assert.equal(calls.length,10);assert.deepEqual(calls[6],{action:'consume',setTo:'off'});
 assert.equal((await post({action:'pause',host:'evil.invalid'})).status,400);
 assert.equal((await post({action:'pause'},'invalid')).status,401);
 assert.equal((await post({action:'pause'},createMobileRefreshToken({secret,deviceId:'paired-native'}))).status,401);
 for(const action of ['shuffle','shufflequeue','undoshuffle','crop']) {
  const r=await fetch(`http://127.0.0.1:${port}/v1/mobile/queue/actions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action})});
  assert.equal(r.status,200,action);
 }
 const catalog=await (await fetch(`http://127.0.0.1:${port}/v1/mobile/search?q=Fixture`,{headers:{authorization:`Bearer ${token}`}})).json();
 const queue=await fetch(`http://127.0.0.1:${port}/v1/mobile/queue-wizard/apply`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({trackIds:[catalog.items[0].id],mode:'append',play:false})});
 assert.equal(queue.status,200);assert.deepEqual(calls.at(-1).tracks,['USB/Fixture/Album/01.flac']);
 const beforeRevocation=calls.length;
 revoked=true;assert.equal((await bridge(playback,{method:'POST',body:{action:'pause'}},token)).ok,false);assert.equal(calls.length,beforeRevocation);
});
test('bridge rejects escaped targets, privileged bodies, missing grants and redirects',async()=>{
 let count=0;const bridge=createMobileControllerBridge({port:3101,fetchImpl:async(url,options)=>{count++;assert.equal(url,'http://127.0.0.1:3101'+playback);assert.equal(options.redirect,'error');assert.equal(options.headers['x-track-key'],undefined);return{ok:true,status:200,json:async()=>({ok:true})};}});
 for(const target of ['https://evil.invalid'+playback,'//evil.invalid'+playback,playback+'?host=evil','/config/runtime/admin'])assert.equal((await bridge(target,{method:'POST',body:{action:'pause'}},'fixture')).status,403);
 for(const body of [{action:'routealexa'},{action:'playfile',file:'/etc/passwd'},{action:'consume',setTo:'bad'},{action:'consume',command:'id'},{action:'pause',host:'evil'}])assert.equal((await bridge(playback,{method:'POST',body},'fixture')).status,403);
 assert.equal((await bridge(playback,{method:'POST',body:{action:'pause'}})).status,403);assert.equal(count,0);
 assert.equal((await bridge(playback,{method:'POST',body:{action:'pause'}},'fixture')).status,200);assert.equal(count,1);
});

test('native queue allowlist remains distinct from browser and forbids path and field injection',()=>{
 const path='/config/queue-wizard/apply';const valid={mode:'append',tracks:['USB/Music/01.flac'],play:false};
 assert.equal(validControllerTarget(path,'POST'),false);
 assert.equal(validNativeControllerBody({method:'POST',pathname:path,body:valid}),true);
 for(const tracks of [['/etc/passwd'],['../outside'],['USB/../outside'],['file:///etc/passwd'],['https://name:password@example.invalid/audio'],['USB/a\nb']])assert.equal(validNativeControllerBody({method:'POST',pathname:path,body:{...valid,tracks}}),false);
 for(const extra of [{host:'evil'},{command:'id'},{playlistName:'../outside'},{play:'yes'},{previewCoverBase64:'invalid!'}])assert.equal(validNativeControllerBody({method:'POST',pathname:path,body:{...valid,...extra}}),false);
});
