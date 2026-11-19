import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from 'playwright';
import {initializeMasterConfiguration,configurationPlugins} from '../src/lib/master-configuration.mjs';
const source=process.env.SONUVI_LAYOUT_SOURCE || fileURLToPath(new URL('../',import.meta.url));
const evidence=process.env.SONUVI_LAYOUT_EVIDENCE;

for(const [name,engine] of Object.entries({chromium,webkit}))test(`${name}: configuration cards and expanded forms remain readable without overlaps at desktop, tablet and phone widths`,async()=>{
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  const document=initializeMasterConfiguration();
  for(const id of ['lastfm','apns','hardware','mills','seeburg','multiphone','harmony','millsDisplay'])document.plugins[id].enabled=true;
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='http://config.test')return route.abort();
   if(url.pathname==='/__controller/configuration'){
    assert.equal(route.request().method(),'GET','Layout tests must never save or restart');
    return route.fulfill({json:{ok:true,document,revision:'layout-fixture',plugins:configurationPlugins,status:{}}});
   }
   if(url.pathname==='/__controller/config.js'||url.pathname==='/scripts/controller-browser-auth.js')return route.fulfill({contentType:'text/javascript',body:''});
   const file=path.resolve(source,'.'+url.pathname);
   if(file.startsWith(source))try{return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.html')?'text/html':'text/javascript'});}catch{}
   return route.abort();
  });
  for(const width of [1200,1024,768,560,390,320]){
   await page.setViewportSize({width,height:1000});await page.goto('http://config.test/config.html');
   await page.locator('[data-plugin=moode] .card-description').waitFor();
   if(evidence && width===1200)await page.screenshot({path:path.join(evidence,name+'-cards-desktop.png'),fullPage:true});
   const issues=await page.locator('.plugin-card').evaluateAll(cards=>{
    const problems=[];
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const overlaps=(a,b)=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
    for(const card of cards){
     const parts=[card.querySelector('.card-icon'),card.querySelector('.card-badge'),card.querySelector('h2,legend'),card.querySelector('.card-description'),card.querySelector('.card-footer')];
     const r=rect(card);
     for(let i=0;i<parts.length;i++){
      const a=rect(parts[i]);
      if(a.left<r.left-1||a.right>r.right+1||a.top<r.top-1||a.bottom>r.bottom+1)problems.push(card.dataset.plugin+':content outside card');
      for(let j=i+1;j<parts.length;j++)if(overlaps(a,rect(parts[j])))problems.push(card.dataset.plugin+':overlapping '+parts[i].className+' / '+parts[j].className);
     }
    }
    if(document.documentElement.scrollWidth>innerWidth)problems.push('Page overflows horizontally');return problems;
   });
   assert.deepEqual(issues,[],`card layout at ${width}px`);
   const card=page.locator('[data-plugin=apns]');
   await card.getByRole('button',{name:'Configure Apple Push Notifications',exact:true}).click();
   for(const title of ['Plugin Config','Protected credentials','JSON Config'])await card.locator('summary').filter({hasText:title}).click();
   const overflow=await card.evaluate(card=>{
    const r=card.getBoundingClientRect();return [...card.querySelectorAll('input,textarea,select,button,summary,label')].filter(e=>e.getClientRects().length).filter(e=>{const b=e.getBoundingClientRect();return b.left<r.left||b.right>r.right||e.scrollWidth>e.clientWidth+2;}).map(e=>e.tagName+':'+(e.textContent||e.type));
   });
   assert.deepEqual(overflow,[],`expanded controls fit at ${width}px`);
   if(evidence && width===390)await page.screenshot({path:path.join(evidence,name+'-settings-phone.png'),fullPage:true});
  }
 }finally{await browser.close();}
});
