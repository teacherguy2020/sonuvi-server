import net from 'node:net';
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';
import {createControllerWebGateway} from '../src/lib/controller-web-gateway.mjs';
const freePort=async()=>{const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const get=(url,options={})=>new Promise((resolve,reject)=>{(url.startsWith('https:')?https:http).get(url,options,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString()}));}).on('error',reject);});
test('direct HTTPS validates its certificate; HTTP redirects without changing immutable health contract',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-lan-tls-'));const publicRoot=path.join(root,'public');await fs.mkdir(publicRoot);await fs.writeFile(path.join(publicRoot,'index.html'),'LAN controller');await fs.writeFile(path.join(publicRoot,'release.json'),JSON.stringify({releaseId:'fixture-release'}));
 const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
 const port=await freePort(),tlsPort=await freePort();const origin=`https://127.0.0.1:${tlsPort}`;
 const child=spawn(process.execPath,['scripts/serve-public-web.mjs'],{cwd:process.cwd(),env:{...process.env,SONUVI_PUBLIC_WEB_ROOT:publicRoot,SONUVI_WEB_HOST:'127.0.0.1',SONUVI_WEB_PORT:String(port),SONUVI_WEB_TLS_PORT:String(tlsPort),SONUVI_WEB_TLS_KEY:key,SONUVI_WEB_TLS_CERT:cert,SONUVI_WEB_CA_CERT:cert,SONUVI_CONTROLLER_WEB_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
 let err='';child.stderr.on('data',b=>err+=b);t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await fs.rm(root,{recursive:true,force:true});});
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(err)}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('HTTPS startup timeout')),10000);timer.unref();})]);
 const ca=await fs.readFile(cert);assert.equal((await get(origin+'/',{ca})).status,200);
 const redirected=await get(`http://127.0.0.1:${port}/controller-tablet.html?pane=kiosk-albums.html`,{headers:{Host:'untrusted.invalid'}});assert.equal(redirected.status,307);assert.equal(redirected.headers.location,origin+'/controller-tablet.html?pane=kiosk-albums.html');
 const health=await get(`http://127.0.0.1:${port}/release.json`);assert.equal(health.status,200);assert.equal(JSON.parse(health.body).releaseId,'fixture-release');
 const publicCA=await get(`http://127.0.0.1:${port}/sonuvi-browser-ca.crt`);assert.equal(publicCA.status,200);assert.match(publicCA.body,/BEGIN CERTIFICATE/);assert.doesNotMatch(publicCA.body,/PRIVATE KEY/);
 assert.equal((await get(origin+'/__controller/session',{ca})).status,200);
 assert.equal((await get(origin+'/config/runtime/admin',{ca})).status,404);
 // An incomplete active HTTP request must not wedge the real service shutdown.
 const socket=net.createConnection({host:'127.0.0.1',port});
 socket.on('error',()=>{});t.after(()=>socket.destroy());await once(socket,'connect');
 socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
 await new Promise(r=>setTimeout(r,100));
 const exited=once(child,'exit');const start=Date.now();child.kill('SIGTERM');
 let watchdog;try {
  const [code,signal]=await Promise.race([exited,new Promise((_,reject)=>{watchdog=setTimeout(()=>{child.kill('SIGKILL');reject(Error('service shutdown exceeded deadline'));},8000);})]);
  assert.equal(code,0);assert.equal(signal,null);assert(Date.now()-start<8000);
 }finally{clearTimeout(watchdog);socket.destroy();}
});
test('persistent bearer grants reject public or symlinked session storage',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-web-private-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);assert.throws(()=>createControllerWebGateway({sessionFile:path.join(root,'sessions')}),/private service-owned/);await fs.chmod(root,0o700);await fs.writeFile(path.join(root,'sessions'),'{}',{mode:0o644});await fs.chmod(path.join(root,'sessions'),0o644);assert.throws(()=>createControllerWebGateway({sessionFile:path.join(root,'sessions')}),/unsafe browser session/);await fs.chmod(path.join(root,'sessions'),0o600);await fs.symlink(path.join(root,'sessions'),path.join(root,'link'));assert.throws(()=>createControllerWebGateway({sessionFile:path.join(root,'link')}),/unsafe browser session/);
});
