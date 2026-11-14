import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {validControllerTarget} from '../src/lib/controller-browser-dispatch.mjs';
test('app indicators distinguish independent measured success, failure and unknown',async()=>{
 const html=await fs.readFile(new URL('../app.html',import.meta.url),'utf8');
 const code=html.slice(html.indexOf('      async function syncPills(){'),html.indexOf('      function getPageFromUrl()'));
 const states={},elements=new Map();let failed=new Set();
 const payloads={'/config/runtime':{ok:true,config:{features:{moodeDisplayTakeover:false}}},'/status/services':{ok:true,moode:{reachable:true}},'/release.json':{releaseId:'release'},'/peppy/vumeter':{fresh:true},'/peppy/spectrum':{fresh:true}};
 const ctx={moodeDisplayTakeoverEnabled:false,document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);}},setPillState:(id,state)=>states[id]=state,fetchJsonWithTimeout:async url=>({r:{ok:!failed.has(url)},j:failed.has(url)?null:payloads[url]}),refreshPushPeppyVisibility(){},refreshNotifyPillFromCfg(){},refreshScreenPill(){},refreshScrobblePill:async()=>{throw Error('unrelated failure');}};
 vm.createContext(ctx);vm.runInContext(code,ctx);await ctx.syncPills();for(const id of ['api','web','peppy','peppyAlsa','moode'])assert.equal(states[id+'Pill'],'ok');
 failed=new Set(['/peppy/spectrum']);await ctx.syncPills();assert.equal(states.peppyPill,'warn');assert.equal(states.apiPill,'ok');assert.equal(states.webPill,'ok');
 failed=new Set(['/status/services']);await ctx.syncPills();assert.equal(states.apiPill,'bad');assert.equal(states.moodePill,'warn');assert.equal(states.webPill,'ok');
});
test('health projection and artwork cache keys remain narrowly allowlisted',()=>{
 assert.equal(validControllerTarget('/status/services','GET'),true);
 assert.equal(validControllerTarget('/status/services?host=evil','GET'),false);
 assert.equal(validControllerTarget('/art/current.jpg?v=cover&_=track&t=123','GET'),true);
});
