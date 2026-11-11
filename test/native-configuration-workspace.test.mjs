import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { projectNativeDlnaStatus, configurationWorkspace, exportPortableConfiguration, previewConfigurationImport, validatePortableConfiguration } from '../src/lib/native-configuration-workspace.mjs';
import { registerConfigurationWorkspaceRoutes } from '../src/routes/admin-configuration-workspace.routes.mjs';
const baseline=()=>({projectName:'identity-preserved',environment:'fresh-install',ports:{api:3101,ui:8101},features:{podcasts:true},mpd:{host:'moode.local',port:6600},alexa:{enabled:false},paths:{piMountBase:'/mnt/media'},runtime:{trackCacheDir:'/var/lib/sonuvi/cache/tracks'}});
const doc=settings=>({format:'sonuvi-server-configuration',version:1,settings});
test('export excludes identity, credentials, cache and deployment topology',()=>{
 const c={...baseline(),trackKey:'private',mobileApiSecret:'private',lastfm:{apiKey:'private',username:'listener'},notifications:{apns:{privateKey:'private'}},nodes:[{ip:'host'}]};
 const portable=exportPortableConfiguration(c);assert(!JSON.stringify(portable).includes('private'));assert(!portable.settings.projectName);assert(!portable.settings.runtime);assert(!portable.settings.ports);assert.equal(portable.settings.lastfm.username,'listener');
});
test('reject unknown/secret fields, malformed values and nested prototype keys before merge',()=>{
 for(const settings of [{trackKey:'x'},{features:{podcasts:'yes'}},{mpd:{port:0}},{moode:{baseUrl:'http://name:secret@host'}},{paths:{piMountBase:'/mnt/../etc'}},JSON.parse('{"__proto__":{"bad":true}}')])assert.throws(()=>validatePortableConfiguration(doc(settings)));
});
test('preview preserves untouched fields and skips effective environment overrides',()=>{
 const c=baseline();const p=previewConfigurationImport(c,doc({mpd:{host:'other'},features:{podcasts:false}}),{environment:{MPD_HOST:'override'}});
 assert.equal(p.skipped.length,1);assert.equal(p.changes.length,1);assert.equal(p.next.mpd.host,'moode.local');assert.equal(p.next.projectName,c.projectName);assert.deepEqual(p.next.runtime,c.runtime);assert.equal(p.next.features.podcasts,false);
});
test('effective DLNA false and paths are correctly represented; fresh export round-trip no changes',()=>{
 const c=baseline();const w=configurationWorkspace(c,{environment:{ENABLE_DLNA_MEDIA_SERVER:'0',PODCAST_ROOT:'/mnt/podcasts',MUSIC_LIBRARY_ROOT:'/mnt/music'}});
 assert.equal(w.fields.find(f=>f.id==='features.dlnaMediaServer').effective,false);assert.equal(w.fields.find(f=>f.id==='paths.podcastRoot').effective,'/mnt/podcasts');assert.equal(w.fields.find(f=>f.id==='paths.musicLibraryRoot').editable,false);
 assert.equal(previewConfigurationImport(c,exportPortableConfiguration(c),{environment:{}}).changes.length,0);
});
test('administrator authorization, target isolation, preview conflict, atomic apply/readback and no media mutation',async()=>{
 let cfg=baseline(),writes=0,scans=0;
 const app=express();app.use(express.json({limit:'64kb'}));
 registerConfigurationWorkspaceRoutes(app,{administratorAuthority:{async verifyAccessToken(t){if(t!=='admin')throw Error();return {role:'administrator',administratorId:'adm_test'};},async administratorRecord(){return {targetIdentity:'target-A'};}},readConfig:async()=>structuredClone(cfg),writeConfig:async c=>{writes++;cfg=c;},runtimeProjectionOptions:{environment:{}},refreshIndex:async()=>{scans++;}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/v1/admin/configuration`;
 const request=async(body,token='admin')=>{const r=await fetch(url+'/operation',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  const document=doc({features:{podcasts:false},display:{idleBrandLine:'VM acceptance'}});const input={operation:'preview',targetIdentity:'target-A',document};
  assert.equal((await request(input,'controller')).status,401);assert.equal((await request({...input,targetIdentity:'target-B'})).status,409);
  const p=await request(input);assert.equal(p.status,200);assert.equal(writes,0);
  const applied=await request({...input,operation:'import',previewId:p.body.previewId,revision:p.body.revision});assert.equal(applied.status,200);assert.equal(writes,1);assert.equal(cfg.features.podcasts,false);assert.equal(cfg.projectName,'identity-preserved');
  assert.equal((await request({...input,operation:'import',previewId:p.body.previewId,revision:p.body.revision})).status,409);assert.equal(writes,1);
  const exported=await request({operation:'export',targetIdentity:'target-A'});assert.equal(exported.body.document.settings.features.podcasts,false);assert.equal(scans,0);
  const scan=await request({operation:'refresh-index',targetIdentity:'target-A'});assert.equal(scan.status,202);await new Promise(r=>setImmediate(r));assert.equal(scans,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('preview is bound to target and detects changed configuration',()=>{
 const c=baseline();const d=doc({features:{podcasts:false}});
 const a=previewConfigurationImport(c,d,{environment:{},targetIdentity:'A'});
 const b=previewConfigurationImport(c,d,{environment:{},targetIdentity:'B'});assert.notEqual(a.previewId,b.previewId);
 c.display={idleBrandLine:'changed elsewhere'};assert.notEqual(a.revision,previewConfigurationImport(c,d,{environment:{},targetIdentity:'A'}).revision);
});
test('blank derived moOde URL survives portable production compatibility',()=>{
 const c=baseline();c.moode={baseUrl:''};const d=exportPortableConfiguration(c);
 assert.equal(d.settings.moode.baseUrl,'');assert.equal(previewConfigurationImport(c,d,{environment:{}}).changes.length,0);
});

test('DLNA native status reports running correctly without leaking startup errors',()=>{
 assert.deepEqual(projectNativeDlnaStatus({installed:true,enabled:true,status:'running'}),{installed:true,enabled:true,status:'enabled',reason:'running'});
 const error=projectNativeDlnaStatus({installed:true,enabled:true,status:'error',reason:'private /etc/secret'});assert.equal(error.enabled,false);assert.equal(error.status,'disabled');assert.equal(error.reason,'runtime_start_failed');
});
