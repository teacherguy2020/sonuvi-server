import test from 'node:test';
import assert from 'node:assert/strict';
import { startControllerStack } from './helpers/controller-stack.mjs';
import { createControllerDispatchAuthorizer, validControllerBody } from '../src/lib/controller-browser-dispatch.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';
const path='/config/diagnostics/playback';
test('paired browser playback requires cookie, exact origin, CSRF and a bounded operation schema', async t=>{
 const calls=[];const s=await startControllerStack({persistentSessions:true,onPlayback:body=>calls.push(body)});t.after(()=>s.close());
 const post=(body,headers={})=>fetch(s.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post({action:'pause'},{origin:s.url})).status,401);
 const created=await fetch(s.url+'/__controller/pairings',{method:'POST',headers:{origin:s.url}});const p=await created.json();
 await s.approve(p.presentationId,p.verificationCode);
 const completed=await fetch(s.url+'/__controller/pairings/'+p.presentationId+'/complete',{headers:{cookie:created.headers.getSetCookie()[0].split(';')[0]}});
 const session=await completed.json();const headers={cookie:completed.headers.getSetCookie()[0].split(';')[0],origin:s.url,'x-csrf-token':session.csrfToken};
 for(const bad of [{...headers,'x-csrf-token':''},{...headers,origin:'https://evil.invalid'},{...headers,'sec-fetch-site':'cross-site'}])assert.equal((await post({action:'pause'},bad)).status,403);
 const rejected=[{action:'shell',command:'id'},{action:'pause',host:'10.0.0.4'},{action:'routealexa'},{action:'clear'},{action:'playfile',file:'/etc/passwd'},{action:'seekpct',percent:-1},{action:'seekpct',percent:101},{action:'seekpct',percent:'10'},{action:'seekrel',seconds:601},{action:'repeat-mode',mode:'anything'}];
 for(const body of rejected)assert.equal((await post(body,headers)).status,400,JSON.stringify(body));
 assert.equal(calls.length,0,'rejected requests must never reach transport');
 for(const body of [{action:'pause'},{action:'play'},{action:'next'},{action:'previous'},{action:'toggle'},{action:'stop'},{action:'seekpct',percent:50},{action:'seekrel',seconds:-15},{action:'repeat-mode',mode:'one'},{action:'shuffle'}]){
  assert.equal((await post(body,headers)).status,200);assert.deepEqual(calls.at(-1),body);
 }
 assert.equal((await fetch(s.url+path+'?host=10.0.0.4',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"action":"pause"}'})).status,400);
 assert.equal((await fetch(s.url+path,{headers})).status,404);
 assert.equal((await fetch(s.url+'/config/runtime/admin',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status,405);
 await s.restartWeb();assert.equal((await post({action:'pause'},headers)).status,200,'paired cookie survives restart');
});
test('API dispatch does not trust LAN-origin requests or unvalidated playback payloads',()=>{
 const apiSecret='playback-test-only';const authorize=createControllerDispatchAuthorizer({apiSecret});
 const req={method:'POST',path,originalUrl:path,body:{action:'pause'},socket:{remoteAddress:'127.0.0.1'},headers:{'x-sonuvi-controller-dispatch':'mobile-session',authorization:'Bearer '+createMobileSessionToken({secret:apiSecret,deviceId:'test-browser'})}};
 assert.equal(authorize(req),true);
 assert.equal(authorize({...req,socket:{remoteAddress:'10.0.0.254'}}),false);
 assert.equal(authorize({...req,body:{action:'pause',command:'anything'}}),false);
 assert.equal(authorize({...req,headers:{'x-sonuvi-controller-dispatch':'mobile-session'}}),false);
 assert.equal(validControllerBody({method:'POST',pathname:path,body:[]}),false);
});
