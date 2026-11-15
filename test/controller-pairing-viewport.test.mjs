import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

test('trusted-device pairing code and QR fit the 1280x400 moOde viewport', {skip:!process.env.SONUVI_BROWSER_EXECUTABLE}, async()=>{
 const b=await chromium.launch({executablePath:process.env.SONUVI_BROWSER_EXECUTABLE,headless:true});
 try{
  const p=await b.newPage({viewport:{width:1280,height:400}});
  await p.route('http://sonuvi.test/**',async r=>{
   const path=new URL(r.request().url()).pathname;
   const json=body=>r.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   if(path==='/__controller/session')return json({authenticated:false});
   if(path==='/__controller/pairings')return json({presentationId:'fixture-pairing',verificationCode:'123456',qrDataUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260"><rect width="260" height="260" fill="white"/></svg>')});
   if(path.includes('/complete'))return json({status:'waiting'});
   if(path==='/auth.js')return r.fulfill({contentType:'application/javascript',body:await fs.readFile('scripts/controller-browser-auth.js','utf8')});
   return r.fulfill({contentType:'text/html',body:'<script>globalThis.SonuviControllerWeb=true</script><script src="/auth.js"></script><body></body>'});
  });
  await p.goto('http://sonuvi.test/');
  const button=p.locator('#sonuviPairStart');await button.waitFor({state:'visible'});
  const initial=await button.boundingBox();assert.ok(initial.y>=0&&initial.y+initial.height<=400,'Pairing alternative visible without a keyboard');
  await button.click();await p.locator('#sonuviPairCode').filter({hasText:'123456'}).waitFor();
  for(const id of ['sonuviPairQr','sonuviPairCode','sonuviPairStart']){
   const box=await p.locator('#'+id).boundingBox();
   assert.ok(box&&box.y>=0&&box.y+box.height<=400,id+' entirely visible on short display');
  }
  assert.equal(await p.locator('#sonuviLoginForm').isVisible(),false,'Do not retain keyboard form while showing QR');
 }finally{await b.close()}
});
