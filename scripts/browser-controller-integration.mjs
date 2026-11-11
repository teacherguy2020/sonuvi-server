#!/usr/bin/env node
// Real Chrome + HTTPS proxy + production web gateway, pairing store, catalog/art/media routes.
// No page interception, autoapproval route, or invented route responses for the corrected features.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { startControllerStack, listen, close } from '../test/helpers/controller-stack.mjs';
const exec=promisify(execFile),temp=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-chrome-'));
let browser,stack,proxy;
const observations=[];
try {
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
 const video=path.join(temp,'motion.mp4');
 await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=96x96:rate=12','-t','2','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',video]);
 proxy=https.createServer({key:await fs.readFile(path.join(temp,'key.pem')),cert:await fs.readFile(path.join(temp,'cert.pem'))},(req,res)=>{
   const up=http.request({host:'127.0.0.1',port:stack.webPort,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
   up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);
 });
 const port=await listen(proxy),origin=`https://127.0.0.1:${port}`;
 stack=await startControllerStack({mediaFile:video,tlsOrigin:origin});
 browser=await chromium.launch({headless:true,executablePath:process.env.SONUVI_BROWSER_EXECUTABLE||undefined});
 for(const shell of ['controller-tablet.html','controller-mobile.html']) {
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});const page=await context.newPage();page.setDefaultTimeout(15000);console.error("STAGE",shell,"navigate");
   const network=[],errors=[];
   page.on('response',r=>{const u=new URL(r.url());if(u.origin===origin)network.push({path:u.pathname,status:r.status()});});
   page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',shell,e.message);});
   const recentResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/recent/albums'&&r.status()===200);
   await page.goto(origin+'/'+shell);
   const pairResponse=page.waitForResponse(r=>r.url()===origin+'/__controller/pairings'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Start trusted-device pairing'}).click();
   const created=await pairResponse;assert.equal(created.status(),201);const pairing=await created.json();
   await page.locator('#sonuviPairCode').waitFor();assert.equal(await page.locator('#sonuviPairCode').textContent(),pairing.verificationCode);
   await stack.approve(pairing.presentationId,pairing.verificationCode);
   await page.waitForFunction(()=>globalThis.SonuviControllerAuth?.csrfToken);
   await page.waitForFunction(()=>document.body.textContent.includes('Fixture Album'));
   const cookies=await context.cookies();const session=cookies.find(c=>c.name==='sonuvi_controller');assert.ok(session?.httpOnly&&session?.secure&&session.sameSite==='Strict');
   console.error("STAGE",shell,"paired");
   await recentResponse;
   assert.ok(network.some(r=>r.path==='/recent/albums'&&r.status===200));
   if(shell==='controller-tablet.html') {
     await page.waitForFunction(()=>{const v=document.getElementById('npArtMotion');return v&&v.videoWidth>0&&!v.paused&&v.currentTime>0;},{},{timeout:30000});
     assert.ok(network.some(r=>r.path==='/v1/mobile/animated-art'&&r.status===200));
     assert.ok(network.some(r=>r.path.startsWith('/v1/mobile/animated-art/media/')&&[200,206].includes(r.status)));
   }
   await page.locator('#homeQuickSearch').fill('Fixture');
   await page.waitForFunction(()=>document.getElementById('homeQuickResults')?.textContent.includes('Fixture Song'));
   console.error('STAGE',shell,'album navigation');
   await page.goto(origin+'/controller-albums.html');
   await page.waitForFunction(()=>document.body.textContent.includes('Fixture Album'));
   await page.waitForFunction(()=>Array.from(document.images).some(i=>i.src.includes('/art/track_640.jpg')&&i.complete&&i.naturalWidth>0));
   assert.ok(network.some(r=>r.path==='/config/browse/albums'&&r.status===200));
   await page.goto(origin+'/controller-artists.html');
   await page.waitForFunction(()=>document.body.textContent.includes('Fixture Artist'));
   assert.ok(network.some(r=>r.path==='/config/browse/artists'&&r.status===200));
   const query=await page.evaluate(async()=>{const r=await fetch('/config/browse/albums?q=Fixture');return {status:r.status,body:await r.json()};});assert.equal(query.status,200);assert.equal(query.body.albums.length,1);
   assert.equal(network.some(r=>r.path==='/config/runtime/admin'),false);
   if(process.env.SONUVI_BROWSER_EVIDENCE)await page.screenshot({path:path.join(process.env.SONUVI_BROWSER_EVIDENCE,shell+'.png')});
   observations.push({shell,paired:true,catalogNavigation:true,decodedArtwork:true,animatedPlayback:shell==='controller-tablet.html',errors,requests:network});
   await context.close();
 }
 console.log(JSON.stringify({result:'PASS',transport:'real TLS via trusted loopback proxy',authentication:'real P-256 presentation, trusted approval and HttpOnly cookie',observations},null,2));
} finally {if(browser)await browser.close();if(proxy)await close(proxy);if(stack)await stack.close();await fs.rm(temp,{recursive:true,force:true});}
