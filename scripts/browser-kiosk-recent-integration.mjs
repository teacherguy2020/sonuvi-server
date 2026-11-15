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
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:400}});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const requests=[],errors=[];
 page.on('response',r=>requests.push({path:new URL(r.url()).pathname,status:r.status()}));
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/kiosk.html');
 const createdResponse=page.waitForResponse(r=>r.url()===origin+'/__controller/pairings'&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Use trusted-device approval instead'}).click();
 const created=await createdResponse;assert.equal(created.status(),201);
 const pairing=await created.json();await stack.approve(pairing.presentationId,pairing.verificationCode);
 await page.waitForFunction(()=>globalThis.SonuviControllerAuth?.csrfToken);
 await page.waitForFunction(()=>document.querySelector('#recentRail .cap')?.textContent==='Fixture Album');
 await page.evaluate(()=>localStorage.setItem('np.recent.albums.cache.v1',JSON.stringify({ts:Date.now(),albums:[{album:'Stale Album',artist:'Unknown Artist',addedTs:1,thumbUrl:'/config/library-health/album-thumb?folder=obsolete'}]})));
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#recentRail .cap')?.textContent==='Fixture Album');
 await page.waitForFunction(()=>{const img=document.querySelector('#recentRail img');return img?.complete&&img.naturalWidth>0;});
 await page.locator('#recentRail .thumb img').first().click();
 await page.waitForFunction(()=>document.querySelector('#recentAlbumTracks')?.textContent.includes('Fixture Song'));
 assert.ok(requests.some(r=>r.path==='/recent/albums'&&r.status===200));
 assert.ok(requests.some(r=>r.path==='/config/browse/album-tracks'&&r.status===200));
 assert.equal(requests.some(r=>r.path==='/config/queue-wizard/preview'||r.path==='/config/library-health/album-thumb'),false);
 assert.deepEqual(errors,[]);
 if(process.env.SONUVI_BROWSER_EVIDENCE)await page.screenshot({path:path.join(process.env.SONUVI_BROWSER_EVIDENCE,'kiosk-recent-album.png')});
 console.log(JSON.stringify({result:'PASS',paired:true,staleCacheIgnored:true,decodedCover:true,albumTracksVisible:true,requests,errors},null,2));
 await context.close();
} finally {if(browser)await browser.close();if(proxy)await close(proxy);if(stack)await stack.close();await fs.rm(temp,{recursive:true,force:true});}
