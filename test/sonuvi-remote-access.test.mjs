import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {provisionLocalTLS, readLocalTLSBundle, localTrustRecord} from '../src/lib/sonuvi-local-tls.mjs';
import {remoteOrigin, signRemoteProof, readRemoteConfiguration, permitsRemoteRequest, createRemoteNativeListener, registerRemoteAccessRoute, REMOTE_CONTRACT} from '../src/lib/sonuvi-remote-access.mjs';
import {classifyServe, runRemoteSetup} from '../src/lib/sonuvi-remote-setup.mjs';
const serverId='sonuvi-'+'a'.repeat(43), origin='https://sonuvi.tail1234.ts.net';
async function fixture(t){
 const stateRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'remote-fixture-')));
 t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
 await provisionLocalTLS({stateRoot,serverId,getuid:()=>0,ownerUID:process.getuid(),serviceGID:process.getgid()});
 return {stateRoot, bundle:await readLocalTLSBundle({stateRoot,ownerUID:process.getuid()})};
}
test('signed alias binds exact origin, identity and short validity, with no secrets',async t=>{
 const {bundle}=await fixture(t), now=Date.now();
 const proof=signRemoteProof({serverId,remoteOrigin:origin},bundle,now);
 const data=Buffer.from(proof.payload,'base64'), claims=JSON.parse(data);
 assert.equal(claims.localOrigin,bundle.origin);assert.equal(claims.remoteOrigin,origin);assert.equal(claims.serverId,serverId);
 assert.equal(claims.expiresAt-claims.issuedAt,300);
 const key=new crypto.X509Certificate(Buffer.from(proof.certificateDER,'base64')).publicKey;
 assert(crypto.verify('sha256',data,key,Buffer.from(proof.signature,'base64')));
 assert(!crypto.verify('sha256',Buffer.from(data.toString().replace('tail1234','tail5678')),key,Buffer.from(proof.signature,'base64')));
 assert.throws(()=>signRemoteProof({serverId:'other',remoteOrigin:origin},bundle),/mismatch/);
 assert(!JSON.stringify(proof).includes('PRIVATE KEY'));
 if(process.env.REMOTE_SWIFT_FIXTURE)await fs.writeFile(process.env.REMOTE_SWIFT_FIXTURE,JSON.stringify({trust:localTrustRecord(bundle),proof,now:Math.floor(now/1000)+1},null,2));
});
test('reject URL tricks, arbitrary hosts, ports, paths and credentials',()=>{
 assert.equal(remoteOrigin(origin),origin);
 for(const x of ['http://sonuvi.tail1234.ts.net',origin+'/',origin+':8443',origin+'/foo',origin+'?x=1','https://user@sonuvi.tail1234.ts.net','https://100.93.63.52','https://evil.example','https://a.ts.net','https://a.b.ts.net.evil.test'])assert.throws(()=>remoteOrigin(x));
});
test('native gateway exposes only native API and rejects browser/legacy/admin paths',async t=>{
 for(const url of ['/config','/now-playing','/v1/admin/configuration','/v1/auth/configure','/__controller/session','/v1/mobile/../admin','/v1/mobile/%2e%2e/admin'])assert(!permitsRemoteRequest({url,method:'GET',headers:{}}),url);
 for(const headers of [{origin:origin},{cookie:'session=x'},{'sec-fetch-site':'same-origin'}])assert(!permitsRemoteRequest({url:'/v1/mobile/catalog',method:'GET',headers}));
 const server=createRemoteNativeListener((_req,res)=>{res.statusCode=401;res.end('pairing required');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/v1/mobile/catalog/tracks')).status,401);
 assert.equal((await fetch(base+'/config')).status,403);
});
test('setup refuses conflicts/Funnel, does not silently overwrite existing routes',()=>{
 assert.equal(classifyServe({},'sonuvi.tail1234.ts.net'),'empty');
 const config={TCP:{443:{HTTPS:true}},Web:{'sonuvi.tail1234.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:8445'}}}}};
 assert.equal(classifyServe(config,'sonuvi.tail1234.ts.net'),'configured');
 assert.equal(classifyServe({...config,AllowFunnel:{'sonuvi.tail1234.ts.net:443':true}},'sonuvi.tail1234.ts.net'),'conflict');
 config.Web['sonuvi.tail1234.ts.net:443'].Handlers['/extra']={Proxy:'http://localhost:3000'};
 assert.equal(classifyServe(config,'sonuvi.tail1234.ts.net'),'conflict');
});
test('configuration rejects writable files and signed identity mismatch; unset means not configured',async t=>{
 const {stateRoot,bundle}=await fixture(t);
 assert.equal(await readRemoteConfiguration(stateRoot,process.getuid()),null);
 const file=path.join(stateRoot,'config/remote-access.json');
 await fs.writeFile(file,JSON.stringify({contract:REMOTE_CONTRACT,serverId,remoteOrigin:origin}),{mode:0o644});
 assert.equal((await readRemoteConfiguration(stateRoot,process.getuid())).remoteOrigin,origin);
 await fs.chmod(file,0o666);await assert.rejects(readRemoteConfiguration(stateRoot,process.getuid()),/unsafe/);
});
test('setup validates target before invoking Tailscale; status is non-mutating',async t=>{
 const {stateRoot}=await fixture(t), target='sonuvi-target-v1-'+'a'.repeat(64);let calls=[];
 const options={stateRoot,ownerUID:process.getuid(),targetIdentity:async()=>target,run:async args=>{calls.push(args);return args[0]==='status'?JSON.stringify({BackendState:'Running',Self:{DNSName:'sonuvi.tail1234.ts.net.'}}):'{}';}};
 await assert.rejects(runRemoteSetup({contract:REMOTE_CONTRACT,operation:'enable',targetIdentity:'wrong'},options),/target_mismatch/);assert.equal(calls.length,0);
 const result=await runRemoteSetup({contract:REMOTE_CONTRACT,operation:'status',targetIdentity:target},options);
 assert.equal(result.state,'not-configured');assert.equal(calls.length,2);assert(!calls.some(c=>c.includes('--bg')));
 assert.equal(await readRemoteConfiguration(stateRoot,process.getuid()),null);
});
test('enable verifies Serve readback before persisting; repeat is idempotent',async t=>{
 const {stateRoot}=await fixture(t), target='sonuvi-target-v1-'+'a'.repeat(64);let config={},enables=0;
 const run=async args=>{
  if(args[0]==='status')return JSON.stringify({BackendState:'Running',Self:{DNSName:'sonuvi.tail1234.ts.net.'}});
  if(args[1]==='status')return JSON.stringify(config);
  assert.deepEqual(args,['serve','--bg','--https=443','--yes','http://127.0.0.1:8445']);enables++;
  config={TCP:{443:{HTTPS:true}},Web:{'sonuvi.tail1234.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:8445'}}}}};return '';
 };
 const input={contract:REMOTE_CONTRACT,operation:'enable',targetIdentity:target},options={stateRoot,ownerUID:process.getuid(),targetIdentity:async()=>target,run};
 assert.equal((await runRemoteSetup(input,options)).state,'configured');assert.equal(enables,1);
 assert.equal((await readRemoteConfiguration(stateRoot,process.getuid())).remoteOrigin,origin);
 assert.equal((await runRemoteSetup(input,options)).state,'configured');assert.equal(enables,1);
 config={TCP:{443:{HTTPS:true}},Web:{'sonuvi.tail1234.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}};
 assert.equal((await runRemoteSetup(input,options)).state,'conflict');assert.equal(enables,1);
});
test('missing Tailscale and signed-out states never mutate Serve',async t=>{
 const {stateRoot}=await fixture(t),target='sonuvi-target-v1-'+'a'.repeat(64),input={contract:REMOTE_CONTRACT,operation:'enable',targetIdentity:target};
 const options={stateRoot,ownerUID:process.getuid(),targetIdentity:async()=>target};
 assert.equal((await runRemoteSetup(input,{...options,run:async()=>{throw Object.assign(new Error(),{code:'ENOENT'});}})).state,'needs-install');
 let calls=0;assert.equal((await runRemoteSetup(input,{...options,run:async()=>{calls++;return '{"BackendState":"NeedsLogin"}';}})).state,'needs-login');assert.equal(calls,1);
});
