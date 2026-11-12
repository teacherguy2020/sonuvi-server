import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { SonuviLogin, registerLoginRoutes } from '../src/lib/sonuvi-login.mjs';
import { DeviceSessionRegistry } from '../src/lib/sonuvi-device-sessions.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createControllerWebGateway } from '../src/lib/controller-web-gateway.mjs';
import { reversePairingProofMessage } from '../src/lib/mobile-pairing.mjs';
import { listen, close } from './helpers/controller-stack.mjs';

test('normal browser login has private cookies, survives restart and revokes only its own device; admin management stays authorized',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-browser-login-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const registry=new DeviceSessionRegistry({directory:path.join(root,'devices')});
  let login;
  const owner={claimed:true,serverId:'sonuvi-'+'a'.repeat(43),administratorId:'admin-fixture',authorityGeneration:'generation-fixture'};
  const authority={ownership:async()=>owner,verifyRootAccessToken:async token=>token==='fixture-root'?{administratorId:owner.administratorId}:null,
    verifyAccessToken:async token=>login.verifyAdministratorSession(token)};
  const apiSecret='fixture-api-secret';
  login=new SonuviLogin({directory:path.join(root,'login'),authority,sessionRegistry:registry,apiSecret});
  await login.configure({administratorToken:'fixture-root',username:'owner',password:'fixture-password-long'});
  const trustFixture={contract:'sonuvi.local-tls-trust.v1',serverId:owner.serverId,origin:'https://fixture.local:8443',anchorDER:Buffer.from('fixture-public-certificate').toString('base64')};
  const app=express();app.use(express.json());registerLoginRoutes(app,{login,localTrust:async()=>trustFixture});
  registerMobileRoutes(app,{enabled:true,apiSecret,trackIdSecret:'fixture-track-secret',sessionRegistry:registry,administratorAuthority:authority,getBrowseIndex:async()=>({tracks:[]})});
  const api=http.createServer(app);await listen(api);t.after(()=>close(api));
  const createWeb=()=>{const gateway=createControllerWebGateway({origin:'https://controller.test',apiPort:api.address().port,trustLoopbackProxy:true,sessionFile:path.join(root,'browser.json')});return http.createServer((req,res)=>gateway(req,res));};
  let web=createWeb();await listen(web);t.after(()=>close(web));
  const request=(route,options={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:web.address().port,path:'/__controller/'+route,method:options.method||'GET',headers:{host:'controller.test','x-forwarded-proto':'https',origin:'https://controller.test',...options.headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks).toString()),headers:{getSetCookie:()=>res.headers['set-cookie']||[]}}));
    });req.on('error',reject);req.end(options.body);
  });
  const signIn=()=>request('login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'fixture-password-long'})});
  assert.equal((await request('devices')).status,401);
  assert.equal((await request('local-trust')).status,401);
  assert.equal((await request('login',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const first=await signIn();assert.equal(first.status,200);const body=await first.json();
  assert.equal(body.accessToken,undefined);assert.equal(body.refreshToken,undefined);assert.equal(body.role,'administrator');
  const header=first.headers.getSetCookie()[0];assert.match(header,/HttpOnly/);assert.match(header,/Secure/);assert.match(header,/SameSite=Strict/);
  const cookie=header.split(';')[0];
  const exported=await (await request('local-trust',{headers:{cookie}})).json();
  assert.deepEqual(exported.localTrust,trustFixture);
  assert.equal(exported.fingerprint,crypto.createHash('sha256').update('fixture-public-certificate').digest('hex'));
  const second=await signIn();assert.equal(second.status,200);const secondBody=await second.json();const secondCookie=second.headers.getSetCookie()[0].split(';')[0];
  const devices=await (await request('devices',{headers:{cookie}})).json();assert.equal(devices.devices.length,2);
  assert.ok(devices.devices.every(device=>device.role==='administrator'));
  // A browser can approve a TV presentation it did not create. TV retains
  // its own poll proof; browser never obtains the resulting TV credential.
  const apiRequest=async(route,options={})=>fetch(`http://127.0.0.1:${api.address().port}${route}`,options);
  const start=await (await apiRequest('/v1/mobile/pairing/presentations',{method:'POST'})).json();
  const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const tv={deviceId:'tv-browser-fallback-fixture',deviceName:'Fixture Apple TV',deviceModel:'Apple TV'};
  const message=reversePairingProofMessage({...tv,presentationId:start.presentationId,challenge:start.challenge});
  const attested=await (await apiRequest(`/v1/mobile/pairing/presentations/${start.presentationId}/attest`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...tv,publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64url'),signature:crypto.sign('sha256',Buffer.from(message),keys.privateKey).toString('base64url'),signatureAlgorithm:'ecdsa-p256-sha256'})})).json();
  const tvPath='device-pairings/'+start.presentationId;
  assert.equal((await request(tvPath)).status,401);
  const inspected=await request(tvPath,{headers:{cookie}});assert.equal(inspected.status,200);
  assert.equal((await inspected.json()).deviceName,tv.deviceName);
  assert.equal((await request(tvPath+'/approve',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({verificationCode:attested.verificationCode})})).status,403);
  const approved=await request(tvPath+'/approve',{method:'POST',headers:{cookie,'x-csrf-token':body.csrfToken,'content-type':'application/json'},body:JSON.stringify({verificationCode:attested.verificationCode})});
  assert.equal(approved.status,200);const approval=await approved.json();assert.equal(approval.accessToken,undefined);assert.equal(approval.refreshToken,undefined);
  const completed=await (await apiRequest(`/v1/mobile/pairing/presentations/${start.presentationId}/complete`,{headers:{'x-mobile-pairing-poll-token':start.pollToken}})).json();
  assert.equal(completed.status,'approved');assert.ok(completed.accessToken);assert.equal(registry.list().find(item=>item.deviceId===tv.deviceId).role,'controller');
  assert.equal((await request('devices/'+tv.deviceId,{method:'DELETE',headers:{cookie,'x-csrf-token':body.csrfToken}})).status,200);
  await close(web);web=createWeb();await listen(web);
  const restored=await (await request('session',{headers:{cookie}})).json();assert.equal(restored.authenticated,true);assert.equal(restored.role,'administrator');
  const firstID=devices.devices[0].deviceId;
  assert.equal((await request('devices/'+firstID,{method:'DELETE',headers:{cookie:secondCookie}})).status,403);
  assert.equal((await request('devices/'+firstID,{method:'DELETE',headers:{cookie:secondCookie,'x-csrf-token':secondBody.csrfToken}})).status,200);
  // A still-unexpired cached browser access token must fail at the API after revocation.
  assert.equal((await request('devices',{headers:{cookie}})).status,401);
  assert.equal((await request('devices',{headers:{cookie:secondCookie}})).status,200);
  const out=await request('logout',{method:'POST',headers:{cookie:secondCookie,'x-csrf-token':secondBody.csrfToken}});
  assert.equal(out.status,200);assert.equal((await out.json()).revocationConfirmed,true);
  assert.equal(registry.list().filter(device=>device.status==='active').length,0);
  assert.equal((await (await request('session',{headers:{cookie:secondCookie}})).json()).authenticated,false);
});
