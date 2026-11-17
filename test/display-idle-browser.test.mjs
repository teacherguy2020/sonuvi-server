import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
for(const surface of ['index.html','player-render.html','peppy.html']) {
  test(`${surface}: finished queue shows configured branding despite retained metadata; pause and Mills retain artwork`, async()=>{
    const browser=await chromium.launch({headless:true});
    try {
      const page=await browser.newPage();page.setDefaultTimeout(7000);
      let playback={state:'play',file:'Music/last.flac',title:'Last song',artist:'Last artist',album:'Last album',duration:180,elapsed:180};
      let display={idleBrandLine:'My record room',idleMessageLine:'Pick another record'};
      let configUnavailable=false;
      let polls=0;
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!=='http://display.test')return route.abort();
        const json=value=>route.fulfill({json:value});
        if(url.pathname==='/__controller/config.js')return route.fulfill({contentType:'text/javascript',body:'globalThis.SonuviControllerWeb=true;'});
        if(url.pathname==='/__controller/session')return json({authenticated:true,role:'controller',csrfToken:'fixture'});
        if(url.pathname==='/now-playing'){polls++;return json(playback);}
        if(url.pathname==='/config/runtime')return configUnavailable?route.fulfill({status:503,json:{ok:false}}):json({ok:true,config:{display,features:{ratings:false,albumPersonnel:false}}});
        if(url.pathname==='/config/diagnostics/queue')return json({ok:true,items:[],playbackState:playback.state});
        if(url.pathname.startsWith('/art/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="navy"/></svg>'});
        const file=path.resolve(root,'.'+url.pathname);
        if(file.startsWith(root)&&/\.(html|js|mjs|css|json|svg|png|jpg|woff2?)$/.test(file)){
          try {return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.html')?'text/html':/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':undefined});}catch{}
        }
        return json({ok:true,items:[],profile:{},rows:[]});
      });
      await page.goto(`http://display.test/${surface}?kiosk=1&alexa=0`);
      const overlay=page.locator(surface==='peppy.html'?'#peppy-idle-overlay':'#np-idle-overlay');
      await overlay.waitFor({state:'attached'});
      await overlay.waitFor({state:'hidden'});
      playback={...playback,state:'stop'};
      await overlay.waitFor({state:'visible'});
      await page.waitForFunction(()=>document.body.textContent.includes('My record room')&&document.body.textContent.includes('Pick another record'));
      display={idleBrandLine:'Updated room',idleMessageLine:'<b>Plain text only</b>'};
      await page.waitForFunction(()=>document.body.textContent.includes('Updated room')&&document.body.textContent.includes('<b>Plain text only</b>'),null,{timeout:12000});
      assert.equal(await overlay.locator('b').count(),0);
      configUnavailable=true;
      const n=polls;
      playback={...playback,state:'pause',elapsed:30};
      await overlay.waitFor({state:'hidden'});
      assert.ok(polls>n);
      playback={...playback,state:'pause',millsMode:true,displayMode:'mills',file:'',title:'',artist:'',album:''};
      if(surface==='peppy.html') await page.waitForFunction(()=>document.body.classList.contains('is-mills'));
      else await page.waitForFunction(()=>lastNowPlayingData?.millsMode===true);
      assert.equal(await overlay.isVisible(),false);
      playback={state:'stop',file:'',title:'',artist:'',millsMode:false};
      await overlay.waitFor({state:'visible'});
      assert.match(await overlay.textContent(),/Updated room/);
      playback={state:'play',file:'Music/next.flac',title:'Next song',artist:'Next artist'};
      await overlay.waitFor({state:'hidden'});
    } finally {await browser.close();}
  });
}
