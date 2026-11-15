import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {alexaHostname,publicIPv4,createAlexaReadiness} from '../src/lib/alexa-readiness.mjs';
const settings={enabled:true,publicDomain:'music.example.com'};
const resolve=async()=>[{address:'8.8.8.8',family:4}];
function requestFixture({error,statusCode=200,body='{"state":"stop","file":""}'}={}){
 return (options,callback)=>{
  assert.equal(options.rejectUnauthorized,true);assert.equal(options.path,'/now-playing');assert.equal(options.headers.authorization,undefined);
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
   if(error)return req.emit('error',{code:error});
   const res=new EventEmitter();res.statusCode=statusCode;res.setEncoding=()=>{};callback(res);res.emit('data',body);res.emit('end');
  });return req;
 };
}
test('hostname and public DNS checks reject URLs, private targets and special networks',async()=>{
 for(const value of ['https://music.example.com','localhost','sonuvi.local','127.0.0.1','music.example.com:443','music.example.com/path','music.example.com@evil.test'])assert.equal(alexaHostname(value),null);
 for(const value of ['10.0.0.35','127.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','172.31.2.3','0.0.0.0','224.1.1.1','198.18.0.1'])assert.equal(publicIPv4(value),false,value);
 const check=createAlexaReadiness({resolve:async()=>[{address:'10.0.0.35'}],request:()=>assert.fail('must not probe LAN')});
 assert.equal((await check.check(settings)).setupState,'public-dns-required');
});
test('saved hostname never implies operational or verified; successful probe does not claim playback',async()=>{
 const check=createAlexaReadiness({resolve,request:requestFixture()});
 assert.equal(check.status(settings).setupState,'not-checked');assert.equal(check.status(settings).operational,null);
 const result=await check.check(settings);assert.equal(result.setupState,'endpoint-reachable');assert.equal(result.operational,null);assert.match(result.error,/playback test/);
 assert.equal(check.status({...settings,publicDomain:'changed.example.com'}).setupState,'not-checked');
});
test('TLS, connection, DNS, non-API and redirect failures are actionable',async()=>{
 for(const [fixture,expected] of [[{error:'CERT_HAS_EXPIRED'},'certificate-invalid'],[{error:'ECONNREFUSED'},'connection-failed'],[{error:'ENOTFOUND'},'dns-failed'],[{statusCode:302},'route-invalid'],[{body:'<html>login</html>'},'route-invalid'],[{body:'{"ok":true}'},'route-invalid']]){
  assert.equal((await createAlexaReadiness({resolve,request:requestFixture(fixture)}).check(settings)).setupState,expected);
 }
});
test('DNS lookup has an overall deadline; disabled integrations do not probe',async()=>{
 const check=createAlexaReadiness({resolve:()=>new Promise(()=>{}),timeoutMs:10,request:()=>assert.fail()});
 assert.equal((await check.check(settings)).setupState,'connection-failed');
 assert.equal((await check.check({...settings,enabled:false})).setupState,'disabled');
});
