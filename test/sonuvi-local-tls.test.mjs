import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { provisionLocalTLS, readLocalTLSBundle, validateLocalTLSBundle, localTLSHostname } from '../src/lib/sonuvi-local-tls.mjs';
import { createLocalTLSListener } from '../src/lib/sonuvi-local-tls-listener.mjs';
import { createLocalBrowserRuntime } from '../src/lib/sonuvi-local-browser.mjs';

const serverId = 'sonuvi-'+'a'.repeat(43);
test('private browser fallback requires explicit root trust and preserves identity during reload', async t => {
  const f=await fixture(t);await provisionLocalTLS(f.options);const bundle=await f.read();
  const publicRoot=path.join(f.stateRoot,'web');await fs.mkdir(publicRoot);
  let next=bundle,errors=0;
  const runtime=await createLocalBrowserRuntime({publicRoot,stateRoot:f.stateRoot,load:async()=>next,onReloadError:()=>errors++});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>runtime.server.close(resolve)));
  const hostname=localTLSHostname(serverId),port=runtime.server.address().port;
  assert.equal(runtime.origin,`https://${hostname}:8444`);
  const ca=new X509Certificate(Buffer.from(bundle.anchorDER,'base64')).toString();
  const request=(options={})=>new Promise((resolve,reject)=>https.get({host:'127.0.0.1',port,servername:hostname,ca,path:'/__controller/session',headers:{host:hostname+':8444'},agent:false,...options},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));}).on('error',reject));
  const initial=await request();assert.equal(initial.status,200);assert.equal(initial.body.authenticated,false);
  await assert.rejects(request({ca:undefined}));
  await assert.rejects(request({servername:'other.local'}));
  assert.equal((await request({headers:{host:'other.local:8444'}})).status,403);
  await runtime.refresh();assert.equal(errors,0);
  next={...bundle,anchorDER:'invalid'};await runtime.refresh();assert.equal(errors,1);
  assert.equal((await request()).body.authenticated,false);
});

async function fixture(t) {
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-local-tls-')));
  t.after(() => fs.rm(stateRoot,{recursive:true,force:true}));
  const options = {stateRoot,serverId,getuid:()=>0,ownerUID:process.getuid(),serviceGID:process.getgid()};
  const read = () => readLocalTLSBundle({stateRoot,ownerUID:process.getuid()});
  return {options,read,stateRoot};
}

test('privileged local issuance is per-Server, idempotent and returns no private keys', async t => {
  const f=await fixture(t);
  await assert.rejects(provisionLocalTLS({...f.options,getuid:()=>501}),/explicit_root/);
  assert.throws(()=>localTLSHostname('bad\nhost'),/identity/);
  const created=await provisionLocalTLS(f.options);
  assert.equal(created.renewed,true); assert.equal(created.trust.serverId,serverId);
  assert.equal(created.trust.origin,`https://${localTLSHostname(serverId)}:8443`);
  assert.deepEqual(Object.keys(created.trust).sort(),['anchorDER','contract','origin','serverId']);
  assert.ok(!JSON.stringify(created).includes('PRIVATE KEY'));
  const before=await f.read(); assert.equal(new X509Certificate(before.cert).ca,false);
  assert.equal((await provisionLocalTLS(f.options)).renewed,false);
  assert.deepEqual(await f.read(),before);
  await assert.rejects(provisionLocalTLS({...f.options,serverId:'sonuvi-'+'b'.repeat(43)}),/bundle_invalid/);
  assert.equal((await fs.stat(path.join(f.stateRoot,'config','local-tls.json'))).mode&0o777,0o640);
  assert.equal((await fs.stat(path.join(f.stateRoot,'protected','local-tls','authority','root.key'))).mode&0o777,0o600);
  const changed={...before,key:'invalid'};
  assert.throws(()=>validateLocalTLSBundle(changed));
  assert.throws(()=>validateLocalTLSBundle({...before,origin:'https://other.local:8443'}),/bundle_invalid/);
  assert.throws(()=>validateLocalTLSBundle(before,{now:Date.now()+100*86400000}),/certificate_invalid/);
  const renewed=await provisionLocalTLS({...f.options,now:()=>Date.now()+70*86400000});
  assert.equal(renewed.renewed,true); assert.deepEqual(renewed.trust,created.trust);
  assert.notEqual((await f.read()).cert,before.cert);
});

test('existing authority cannot be silently replaced; unsafe bundle paths fail closed', async t => {
  const f=await fixture(t);await provisionLocalTLS(f.options);
  const authority=path.join(f.stateRoot,'protected','local-tls','authority');
  await fs.rename(authority,authority+'-retained');
  // Renewal must not generate a new root even if the old leaf has expired.
  await assert.rejects(provisionLocalTLS({...f.options,now:()=>Date.now()+100*86400000}),/authority_missing/);
  const file=path.join(f.stateRoot,'config','local-tls.json');
  await fs.rename(file,file+'.retained');await fs.symlink(file+'.retained',file);
  await assert.rejects(f.read());
});

test('real local HTTPS handshake enforces trust, hostname, Host and origin; reload preserves identity', async t => {
  const f=await fixture(t);await provisionLocalTLS(f.options);const bundle=await f.read();
  let calls=0, next=bundle, errors=0;
  const runtime=createLocalTLSListener({bundle,handler:(_req,res)=>{calls++;res.end('{"ok":true}');},reload:async()=>next,onReloadError:()=>errors++});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>runtime.server.close(resolve)));
  const hostname=localTLSHostname(serverId), port=runtime.server.address().port;
  const ca=new X509Certificate(Buffer.from(bundle.anchorDER,'base64')).toString();
  const request=(options={})=>new Promise((resolve,reject)=>https.get({host:'127.0.0.1',port,servername:hostname,ca,path:'/v1/auth/status',headers:{host:hostname+':8443'},agent:false,...options},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
  assert.equal(await request(),200);
  await assert.rejects(request({ca:undefined}));
  await assert.rejects(request({servername:'sonuvi-other.local'}));
  assert.equal(await request({headers:{host:'other.local'}}),403);
  assert.equal(await request({headers:{host:hostname+':8443',origin:'https://evil.example'}}),403);
  assert.equal(await request({path:'/config/runtime/admin'}),404);
  assert.equal(calls,1);
  await runtime.refresh();assert.equal(errors,0);
  next={...bundle,serverId:'sonuvi-'+'b'.repeat(43)};await runtime.refresh();assert.equal(errors,1);
  assert.equal(await request(),200);
});
