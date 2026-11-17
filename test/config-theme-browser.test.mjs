import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,webkit} from 'playwright';
import {initializeMasterConfiguration,configurationPlugins} from '../src/lib/master-configuration.mjs';
import {buildPublicWebRoot} from '../src/lib/public-web-root.mjs';
const source=new URL('../',import.meta.url).pathname;
const dark={'--theme-bg':'#101820','--theme-text':'#edf5ff','--theme-text-secondary':'#aabbcc','--theme-rail-border':'#345678','--theme-hero-card-bg':'#182838','--theme-card-secondary-fill':'#203040','--theme-tab-bg':'#263646','--theme-tab-text':'#e0eafa','--theme-tab-active-bg':'#7540b0','--theme-tab-active-text':'#fff0f8','--theme-tab-hover-bg':'#364656'};
const light={'--theme-bg':'#f5eee2','--theme-text':'#22180e','--theme-text-secondary':'#62584e','--theme-rail-border':'#9f8f7f','--theme-hero-card-bg':'#fffaed','--theme-card-secondary-fill':'#ded3c3','--theme-tab-bg':'#eee0c9','--theme-tab-text':'#31200f','--theme-tab-active-bg':'#774422','--theme-tab-active-text':'#fff8ee','--theme-tab-hover-bg':'#dac8ae'};
for(const [name,engine] of Object.entries({chromium,webkit}))test(`${name}: configuration uses theme token roles standalone and in app iframe, including live changes and restart dialog`,async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-config-theme-'));const publicRoot=path.join(temporary,'public');t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 await buildPublicWebRoot({sourceRoot:source,outputRoot:publicRoot});
 const browser=await engine.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1200,height:1000}});
  await context.addInitScript(tokens=>{
   if(localStorage.getItem('nowplaying.clientSettings.v1'))return;
   localStorage.setItem('nowplaying.clientSettings.v1',JSON.stringify({version:1,clientId:'layout-theme-fixture',app:{themeTokens:tokens,themeMode:'dark'}}));
   localStorage.setItem('nowplaying.themeTokens.v1',JSON.stringify(tokens));localStorage.setItem('np-theme','dark');
  },dark);
  const page=await context.newPage();page.setDefaultTimeout(8000);
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!=='http://theme.test')return route.abort();
   if(url.pathname.startsWith('/__controller/configuration')){
    assert.equal(route.request().method(),'GET','Theme tests never mutate server state');
    return route.fulfill({json:{ok:true,document:initializeMasterConfiguration(),revision:'theme-fixture',plugins:configurationPlugins,status:{}}});
   }
   if(url.pathname==='/__controller/config.js'||url.pathname==='/scripts/controller-browser-auth.js')return route.fulfill({contentType:'text/javascript',body:''});
   const file=path.resolve(publicRoot,'.'+url.pathname);
   if(file.startsWith(publicRoot))try{return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'});}catch{}
   return route.fulfill({json:{ok:true,items:[],profile:{}}});
  });
  const expected=tokens=>Object.fromEntries(Object.entries(tokens).map(([key,v])=>[key,`rgb(${[1,3,5].map(i=>parseInt(v.slice(i,i+2),16)).join(', ')})`]));
  async function check(frame,tokens){
   const e=expected(tokens);
   await frame.locator('.plugin-card').first().waitFor();
   await frame.waitForFunction(bg=>getComputedStyle(document.body).backgroundColor===bg,e['--theme-bg']);
   const styles=await frame.evaluate(()=>{
    const cs=selector=>getComputedStyle(document.querySelector(selector));
    return {bg:cs('body').backgroundColor,text:cs('body').color,card:cs('.plugin-card').backgroundColor,border:cs('.plugin-card').borderTopColor,muted:cs('.card-description').color,control:cs('.collection-search').backgroundColor,controlText:cs('.collection-search').color,badge:cs('.card-badge').backgroundColor,primary:cs('.configuration-actions .primary').backgroundColor,primaryText:cs('.configuration-actions .primary').color,selected:cs('.collection-filters [aria-pressed=true]').backgroundColor};
   });
   assert.deepEqual(styles,{bg:e['--theme-bg'],text:e['--theme-text'],card:e['--theme-hero-card-bg'],border:e['--theme-rail-border'],muted:e['--theme-text-secondary'],control:e['--theme-tab-bg'],controlText:e['--theme-tab-text'],badge:e['--theme-card-secondary-fill'],primary:e['--theme-tab-active-bg'],primaryText:e['--theme-tab-active-text'],selected:e['--theme-tab-active-bg']});
  }
  await page.goto('http://theme.test/config.html');await check(page,dark);
  const old=await page.evaluate(()=>localStorage.getItem('nowplaying.clientSettings.v1'));
  // Another same-origin tab changes presentation preferences, as the theme editor does.
  const second=await context.newPage();await second.goto('http://theme.test/config.html');
  await second.evaluate(tokens=>localStorage.setItem('nowplaying.clientSettings.v1',JSON.stringify({version:1,clientId:'layout-theme-fixture',app:{themeTokens:tokens,themeMode:'light'}})),light);
  await check(page,light);assert.notEqual(old,await second.evaluate(()=>localStorage.getItem('nowplaying.clientSettings.v1')));
  await second.close();
  await page.goto('http://theme.test/app.html?page=config.html');
  await page.waitForFunction(()=>document.getElementById('appFrame')?.contentWindow?.document.querySelector('.plugin-card'));
  let frame=page.frames().find(f=>f.url().includes('/config.html'));assert.ok(frame);await check(frame,light);
  await page.evaluate(tokens=>window.postMessage({type:'np-theme-updated',tokens,mode:'dark'},location.origin),dark);
  await check(frame,dark);
  await frame.getByRole('button',{name:'Restart Server',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.deepEqual(await dialog.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color,button:getComputedStyle(el.querySelector('button')).backgroundColor})),{bg:expected(dark)['--theme-hero-card-bg'],text:expected(dark)['--theme-text'],button:expected(dark)['--theme-tab-bg']});
  await page.getByRole('button',{name:'Later',exact:true}).click();
  await page.evaluate(tokens=>window.postMessage({type:'np-theme-updated',tokens,mode:'light'},location.origin),light);
  await check(frame,light);
  if(process.env.SONUVI_THEME_EVIDENCE)await page.screenshot({path:path.join(process.env.SONUVI_THEME_EVIDENCE,name+'-light-config.png'),fullPage:true});
 }finally{await browser.close();}
});
