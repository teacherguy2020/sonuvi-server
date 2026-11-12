import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { SonuviLogin, registerLoginRoutes } from '../src/lib/sonuvi-login.mjs';
import { DeviceSessionRegistry } from '../src/lib/sonuvi-device-sessions.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createControllerWebGateway } from '../src/lib/controller-web-gateway.mjs';
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
  const app=express();app.use(express.json());registerLoginRoutes(app,{login});
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
  assert.equal((await request('login',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const first=await signIn();assert.equal(first.status,200);const body=await first.json();
  assert.equal(body.accessToken,undefined);assert.equal(body.refreshToken,undefined);assert.equal(body.role,'administrator');
  const header=first.headers.getSetCookie()[0];assert.match(header,/HttpOnly/);assert.match(header,/Secure/);assert.match(header,/SameSite=Strict/);
  const cookie=header.split(';')[0];
  const second=await signIn();assert.equal(second.status,200);const secondBody=await second.json();const secondCookie=second.headers.getSetCookie()[0].split(';')[0];
  const devices=await (await request('devices',{headers:{cookie}})).json();assert.equal(devices.devices.length,2);
  assert.ok(devices.devices.every(device=>device.role==='administrator'));
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
