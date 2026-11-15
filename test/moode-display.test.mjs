import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {DISPLAY_MODES,displayUrl,displaySshArgs,isManagedDisplayInvocation,pushMoodeDisplay,registerMoodeDisplayRoutes} from '../src/lib/moode-display.mjs';
const env={SONUVI_STATE_ROOT:'/var/lib/sonuvi',SONUVI_SECRETS_ROOT:'/var/lib/sonuvi/protected',SONUVI_CONTROLLER_WEB_ORIGIN:'https://sonuvi.local',SONUVI_MOODE_DISPLAY_PROTOCOL:'v1',MOODE_SSH_HOST:'moode.local',MOODE_SSH_USER:'moode'};
test('only explicit modes, canonical HTTPS and dedicated restricted identity are admitted',()=>{
 for(const mode of DISPLAY_MODES){
  const url=displayUrl(env.SONUVI_CONTROLLER_WEB_ORIGIN,mode);assert.ok(mode==='kiosk'?url.endsWith('/kiosk.html'):url.includes('mode='+mode));
  const args=displaySshArgs(mode,{env});assert.ok(args.includes('/var/lib/sonuvi/protected/display-ssh/display_ed25519'));
  assert.ok(isManagedDisplayInvocation('/usr/bin/ssh',args,{}, {env}));
  for(const options of [{shell:true},{env:{}},{uid:0}])assert.equal(isManagedDisplayInvocation('/usr/bin/ssh',args,options,{env}),false);
  assert.equal(isManagedDisplayInvocation('/usr/bin/ssh',[...args.slice(0,-1),'sonuvi-display-v1 '+mode+'; id'],{}, {env}),false);
 }
 for(const origin of ['http://sonuvi.local','https://x/path','https://user@x','https://x/?q=1'])assert.throws(()=>displayUrl(origin,'player'));
 assert.throws(()=>displaySshArgs('player;id',{env}));assert.throws(()=>displaySshArgs('player',{env:{...env,SONUVI_MOODE_DISPLAY_PROTOCOL:''}}));
});
test('remote reply must match verified mode and expected canonical URL',async()=>{
 const good={contract:'sonuvi.moode-display.v1',ok:true,verified:true,mode:'player',url:displayUrl(env.SONUVI_CONTROLLER_WEB_ORIGIN,'player')};
 for(const changes of [{verified:false},{mode:'peppy'},{url:'https://evil.test'},{contract:'other'},{ok:false}])await assert.rejects(pushMoodeDisplay('player',{env,run:async()=>({stdout:JSON.stringify({...good,...changes})})}));
 assert.equal((await pushMoodeDisplay('player',{env,run:async()=>({stdout:JSON.stringify(good)})})).verified,true);
});
test('route rejects auth and invalid bodies, preserves profile options, restores on failed switch',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'display-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'profile.json');
 const original=JSON.stringify({skin:'retained',visualizer:{energy:8},playerSize:'1280x400'});await fs.writeFile(file,original);
 let handler,authorized=true,fail=false,calls=0;
 registerMoodeDisplayRoutes({post:(route,h)=>{assert.equal(route,'/v1/admin/configuration/master/display');handler=h;}},{authorize:async(req,res)=>{if(!authorized)res.status(401).json({ok:false});return authorized;},readConfig:async()=>({}),profilePath:file,env,push:async mode=>{calls++;if(fail)throw Error('failed');return {ok:true,verified:true,mode};}});
 const request=async body=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(j){this.body=j;return this;}};await handler({body},res);return res;};
 authorized=false;assert.equal((await request({mode:'player'})).statusCode,401);assert.equal(calls,0);authorized=true;
 for(const body of [{mode:'evil'},{mode:'player',url:'https://evil.test'},{mode:'kiosk',playerSize:'1280x400'}])assert.equal((await request(body)).statusCode,400);
 for(const mode of DISPLAY_MODES){assert.equal((await request({mode})).statusCode,200);const p=JSON.parse(await fs.readFile(file));assert.equal(p.skin,'retained');assert.equal(p.visualizer.energy,8);assert.equal(p.displayMode,mode);}
 const before=await fs.readFile(file,'utf8');fail=true;assert.equal((await request({mode:'player',playerSize:'1920x1080'})).statusCode,502);assert.equal(await fs.readFile(file,'utf8'),before);
});
test('all four real HTML handlers send correct mode, report failures, and unlock buttons',async()=>{
 const html=await fs.readFile(new URL('../displays.html',import.meta.url),'utf8');const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
 const elements=new Map();for(const label of ['Player','Peppy','Visualizer','Kiosk'])for(const suffix of ['Btn','Status'])elements.set('push'+label+suffix,{addEventListener(event,fn){this.click=fn;}});
 let requested,fail=false;
 const context={document:{getElementById:id=>elements.get(id)},localStorage:{getItem:()=>'{"size":"1920x1080"}'},SonuviControllerAuth:{ready:Promise.resolve()},fetch:async(url,options)=>{requested={url,body:JSON.parse(options.body)};return {ok:!fail,status:fail?502:200,json:async()=>fail?{ok:false,error:'readback failed'}:{ok:true,verified:true,url:'https://sonuvi.local/target'}};}};
 vm.runInNewContext(script,context);
 for(const label of ['Player','Peppy','Visualizer','Kiosk']){await elements.get('push'+label+'Btn').click();assert.equal(requested.body.mode,label.toLowerCase());assert.equal(requested.url,'/__controller/configuration/display');assert.match(elements.get('push'+label+'Status').textContent,/verified/);}
 fail=true;await elements.get('pushPlayerBtn').click();assert.match(elements.get('pushPlayerStatus').textContent,/Push failed/);assert.equal(elements.get('pushPlayerBtn').disabled,false);
});
test('Peppy profile persists with verified push and rolls back on failure; arbitrary fields rejected',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'peppy-profile-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'profile.json');await fs.writeFile(file,JSON.stringify({skin:'old',visualizer:{energy:7}}));
 let handler,fail=false;
 registerMoodeDisplayRoutes({post:(_,h)=>handler=h},{authorize:async()=>true,readConfig:async()=>({}),profilePath:file,env,push:async()=>{if(fail)throw Error('no readback');return {ok:true,verified:true};}});
 const request=async body=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(j){this.body=j;return this;}};await handler({body},res);return res;};
 for(const profile of [{url:'http://evil'},{skin:'../evil'},{skin:3},{meterType:'evil'},{playerSize:'bogus'},[]])assert.equal((await request({mode:'peppy',profile})).statusCode,400);
 assert.equal((await request({mode:'player',profile:{skin:'blue'}})).statusCode,400);
 assert.equal((await request({mode:'peppy',profile:{skin:'blue-1280',theme:'abyss-graphite',playerSize:'1280x400'}})).statusCode,200);
 const saved=await fs.readFile(file,'utf8');assert.equal(JSON.parse(saved).skin,'blue-1280');assert.equal(JSON.parse(saved).visualizer.energy,7);
 fail=true;assert.equal((await request({mode:'peppy',profile:{skin:'other'}})).statusCode,502);assert.equal(await fs.readFile(file,'utf8'),saved);
});
