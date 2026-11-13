import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLastfmPluginAdministration} from '../src/lib/lastfm-plugin-admin.mjs';
import {loadProtectedLastfmEnvironment} from '../src/lib/protected-runtime-secrets.mjs';

test('owner can configure, authorize, restart and disconnect Last.fm without exposing credentials in status',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-lastfm-plugin-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const statePaths={sharedStateEnabled:true,lastfmEnvPath:path.join(root,'lastfm.env')};
  const env={LASTFM_API_KEY:'stale-key',LASTFM_API_SECRET:'stale-secret',LASTFM_SESSION_KEY:'stale-session'};
  const admin=createLastfmPluginAdministration({statePaths,env,requestToken:async()=> 'fixture-token',exchangeToken:async()=>({sessionKey:'fixture-session',username:'fixture-user'})});
  const configured=await admin.action('credentials',{apiKey:'fixture-key',apiSecret:'fixture-secret'});
  assert.equal(configured.configured,true);assert.equal(configured.authorized,false);
  assert.equal(JSON.stringify(configured).includes('fixture-key'),false);
  const start=await admin.action('authorize/start');
  assert.equal(new URL(start.authorizationUrl).hostname,'www.last.fm');
  const complete=await admin.action('authorize/complete');
  assert.equal(complete.authorized,true);assert.equal(complete.username,'fixture-user');
  assert.equal((await fs.stat(statePaths.lastfmEnvPath)).mode&0o777,0o600);
  const stale={LASTFM_API_KEY:'old',LASTFM_API_SECRET:'old',LASTFM_SESSION_KEY:'old'};
  assert.equal(loadProtectedLastfmEnvironment({statePaths,env:stale}).LASTFM_SESSION_KEY,'fixture-session');
  const restarted=createLastfmPluginAdministration({statePaths,env:stale});
  assert.equal(restarted.status().username,'fixture-user');
  await restarted.action('disconnect');
  assert.equal(createLastfmPluginAdministration({statePaths,env:{LASTFM_SESSION_KEY:'stale'}}).status().authorized,false);
  assert.equal(restarted.status().operational,null);
});

test('invalid credentials and expired authorization do not write configuration',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-lastfm-plugin-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const statePaths={sharedStateEnabled:true,lastfmEnvPath:path.join(root,'lastfm.env')};
  const admin=createLastfmPluginAdministration({statePaths,env:{}});
  await assert.rejects(admin.action('credentials',{apiKey:'bad\nvalue',apiSecret:'different'}),/required/);
  await assert.rejects(admin.action('authorize/complete'),/expired/);
  assert.deepEqual(await fs.readdir(root),[]);
});
