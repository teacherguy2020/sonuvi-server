import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeMasterConfiguration,configurationPlugins} from '../src/lib/master-configuration.mjs';
import {registerConfigRuntimeAdminRoutes} from '../src/routes/config.runtime-admin.routes.mjs';

test('all personal shelves reuse protected API access and authorized identity instead of legacy username',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-shelf-identity-'));
 const env={NOW_PLAYING_CONFIG_PATH:path.join(root,'config.json'),SONUVI_STATE_ROOT:root,SONUVI_SECRETS_ROOT:root,LASTFM_ENV_FILE:path.join(root,'credentials.env')};
 const old=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]])),oldFetch=globalThis.fetch;
 t.after(async()=>{globalThis.fetch=oldFetch;for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});});
 Object.assign(process.env,env);
 const doc=initializeMasterConfiguration();doc.plugins.lastfm.enabled=true;doc.plugins.lastfm.publicUsername='legacy-account';
 await fs.writeFile(env.NOW_PLAYING_CONFIG_PATH,JSON.stringify(doc));
 await fs.writeFile(env.LASTFM_ENV_FILE,'# sonuvi-lastfm-admin-v1\nLASTFM_API_KEY=fixture-key\nLASTFM_API_SECRET=fixture-secret\nLASTFM_SESSION_KEY=fixture-session\nLASTFM_USERNAME=authorized-account\n');
 const requests=[];
 globalThis.fetch=async url=>{requests.push(new URL(url));return {ok:true,json:async()=>({toptracks:{track:[]},topalbums:{album:[]},topartists:{artist:[]},recenttracks:{track:[]}})};};
 const routes=new Map(),app={get:(p,h)=>routes.set(p,h),post(){}};
 registerConfigRuntimeAdminRoutes(app,{requireTrackKey:()=>true,trackKey:'fixture-only',log:{debug(){}}});
 for(const name of ['top-tracks','top-albums','top-artists','recent-tracks']){
   const response={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
   await routes.get('/config/lastfm/'+name)({protocol:'http',get:()=> 'configuration.test',query:{period:'overall',windowDays:0,limit:1}},response);
   assert.equal(response.code,200,JSON.stringify(response.body));
   assert.equal(response.body.username,'authorized-account');
 }
 assert.equal(requests.length,4);
 for(const url of requests){assert.equal(url.searchParams.get('api_key'),'fixture-key');assert.equal(url.searchParams.get('user'),'authorized-account');}
 await fs.writeFile(env.LASTFM_ENV_FILE,'# sonuvi-lastfm-admin-v1\nLASTFM_API_KEY=fixture-key\nLASTFM_USERNAME=\n');
 const disconnected={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await routes.get('/config/lastfm/top-artists')({query:{}},disconnected);
 assert.equal(disconnected.code,400);assert.equal(requests.length,4);
 assert.equal(configurationPlugins.find(p=>p.id==='lastfm').schema.properties.publicUsername.deprecated,true);
});
