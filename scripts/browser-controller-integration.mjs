#!/usr/bin/env node
/* Runnable local harness: production public-web gateway + actual controller HTML. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { buildPublicWebRoot } from '../src/lib/public-web-root.mjs';
import { createPublicWebServer } from '../src/lib/public-web-server.mjs';
import { verifyControllerDispatch } from '../src/lib/controller-browser-dispatch.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const secret='fixture-controller-secret';
const listen=(server)=>new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=(server)=>new Promise((resolve)=>server.close(resolve));
const app=express(); app.use(express.json());
const dispatch=(req,res,next)=>verifyControllerDispatch({secret,header:req.get('x-sonuvi-controller-dispatch'),method:req.method,pathname:req.path})?next():res.status(403).json({ok:false,error:'dispatch denied'});
app.post('/v1/mobile/pairing/presentations',dispatch,(_req,res)=>res.json({ok:true,presentationId:'present_fixture',challenge:'fixture-challenge',pollToken:'fixture-poll',baseUrl:'http://127.0.0.1'}));
app.get('/v1/mobile/pairing/presentations/present_fixture/complete',dispatch,(req,res)=>req.get('x-mobile-pairing-poll-token')==='fixture-poll'?res.json({ok:true,status:'approved'}):res.status(401).json({status:'waiting'}));
app.get('/config/browse/albums',dispatch,(_req,res)=>res.json({ok:true,albums:[{album:'Fixture Album',artist:'Fixture Artist',file:'Music/fixture.flac'}]}));
app.get('/config/browse/artists',dispatch,(_req,res)=>res.json({ok:true,artists:['Fixture Artist']}));
app.get('/config/browse/artist-albums',dispatch,(_req,res)=>res.json({ok:true,albums:[{album:'Fixture Album',artist:'Fixture Artist'}]}));
app.get('/now-playing',dispatch,(_req,res)=>res.json({title:'Fixture Song',artist:'Fixture Artist',album:'Fixture Album'}));
app.get('/art/track_640.jpg',dispatch,(_req,res)=>res.type('image/jpeg').send(Buffer.from([0xff,0xd8,0xff,0xd9])));
const api=http.createServer(app); const apiPort=await listen(api); const temp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'sonuvi-browser-')); const publicRoot=path.join(temp,'public'); await buildPublicWebRoot({sourceRoot:root,outputRoot:publicRoot});
const web=await createPublicWebServer({publicRoot,controllerSecret:secret,apiPort,allowLoopbackFixture:true}); const webPort=await listen(web); const url='http://127.0.0.1:'+webPort;
try { const browser=await chromium.launch({headless:true,executablePath:process.env.SONUVI_BROWSER_EXECUTABLE||undefined}); const page=await browser.newPage(); await page.goto(url+'/controller-tablet.html'); await page.getByRole('button',{name:'Start trusted-device pairing'}).click(); await page.waitForTimeout(1800); await page.waitForFunction(()=>!document.getElementById('sonuviBrowserPairing')); await page.waitForFunction(()=>document.body.textContent.includes('Fixture Album')); assert.match(await page.content(),/Fixture Album/); assert.match(await page.content(),/Albums/); await browser.close(); console.log('browser controller harness: PASS '+url); } finally { await close(web); await close(api); await fs.promises.rm(temp,{recursive:true,force:true}); }
