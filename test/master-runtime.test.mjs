import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {initializeMasterConfiguration} from '../src/lib/master-configuration.mjs';
import {canonicalRuntimeEnvironment} from '../src/lib/master-runtime-environment.mjs';
import {readEffectiveRuntimeConfig} from '../src/lib/native-configuration-store.mjs';
import {planMasterConfigurationMigration} from '../src/lib/master-configuration-migration.mjs';

test('master runtime wins over stale ordinary environment but retains credentials',()=>{
  const document=initializeMasterConfiguration();
  document.plugins.mpd.host='master-player.local';
  document.plugins.library.musicLibraryRoot='/master/music';
  const env=canonicalRuntimeEnvironment(document,{MPD_HOST:'stale',MUSIC_LIBRARY_ROOT:'/stale',LASTFM_API_KEY:'fixture',TRACK_KEY:'fixture'});
  assert.equal(env.MPD_HOST,'master-player.local');
  assert.equal(env.MUSIC_LIBRARY_ROOT,'/master/music');
  assert.equal(env.LASTFM_API_KEY,'fixture');
  assert.equal(env.TRACK_KEY,'fixture');
  assert.equal(env.LASTFM_MPD_MODE,'disabled');
});
test('advanced options migrate into plugin JSON and absent options cannot inherit stale settings',()=>{
  const plan=planMasterConfigurationMigration({base:{ports:{api:3101,ui:8101}},environment:{UPNP_GAPLESS_ENABLED:'1',PIBUZ_HOST:'receiver.local'}});
  assert.equal(plan.errors.length,0);
  assert.equal(plan.document.plugins.upnp.runtimeOptions.UPNP_GAPLESS_ENABLED,'1');
  const env=canonicalRuntimeEnvironment(plan.document,{UPNP_GAPLESS_ENABLED:'0',UPNP_HTTP_TIMEOUT_MS:'999',PIBUZ_HOST:'stale',LASTFM_API_KEY:'fixture'});
  assert.equal(env.UPNP_GAPLESS_ENABLED,'1');assert.equal(env.UPNP_HTTP_TIMEOUT_MS,undefined);assert.equal(env.PIBUZ_HOST,'receiver.local');
  plan.document.plugins.upnp.runtimeOptions.LASTFM_API_KEY='not-allowed';
  assert.throws(()=>canonicalRuntimeEnvironment(plan.document,{}),{code:'configuration_invalid'});
});
test('additional integration and playback settings cannot be shadowed by old environment values',()=>{
  const document=initializeMasterConfiguration();
  document.plugins.echoLink.enabled=true;
  document.plugins.echoLink.host='echo.local';
  document.plugins.playback.favoritesPlaylistName='Saved favorites';
  document.plugins.harmony.host='harmony.local';
  document.plugins.appleMusic.country='gb';
  const env=canonicalRuntimeEnvironment(document,{ECHO_LINK_ENABLED:'0',ECHO_LINK_HOST:'old',FAVORITES_PLAYLIST_NAME:'old',HARMONY_HOST:'old',APPLE_MUSIC_COUNTRY:'us'});
  assert.equal(env.ECHO_LINK_ENABLED,'1');assert.equal(env.ECHO_LINK_HOST,'echo.local');
  assert.equal(env.FAVORITES_PLAYLIST_NAME,'Saved favorites');assert.equal(env.HARMONY_HOST,'harmony.local');assert.equal(env.APPLE_MUSIC_COUNTRY,'gb');
});
test('master read ignores even an invalid obsolete native overlay and survives fresh process startup',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-master-runtime-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'data'));
  const file=path.join(root,'config','now-playing.config.json');
  const document=initializeMasterConfiguration();document.plugins.mpd.host='master-player.local';document.plugins.library.musicLibraryRoot='/master/music';
  // Enabled but not configured must not prevent unrelated music playback/startup.
  document.plugins.alexa.enabled=true;
  await fs.writeFile(file,JSON.stringify(document));await fs.writeFile(path.join(root,'data','native-configuration.json'),'invalid obsolete overlay');
  assert.equal(readEffectiveRuntimeConfig(file,{paths:{sharedStateEnabled:true,configPath:file,dataRoot:path.join(root,'data')}}).mpd.host,'master-player.local');
  const module=new URL('../src/config.mjs',import.meta.url).href;
  for(let i=0;i<2;i++){
    const output=execFileSync(process.execPath,['--input-type=module','-e',`const c=await import(${JSON.stringify(module)});console.log(JSON.stringify({host:c.MPD_HOST,root:c.MUSIC_LIBRARY_ROOT,usb:c.MOODE_USB_PREFIX,mount:c.PI4_MOUNT_BASE,ssh:c.MOODE_SSH}));`],{env:{...process.env,SONUVI_STATE_ROOT:root,MPD_HOST:'stale',MUSIC_LIBRARY_ROOT:'/stale',MOODE_SSH:'stale@wrong-host'},encoding:'utf8'});
    assert.deepEqual(JSON.parse(output),{host:'master-player.local',root:'/master/music',usb:'',mount:'',ssh:''});
  }
});

test('hardware migration preserves explicit external bridge roles without enabling a fresh listener',()=>{
  const environment={SONUVI_HARDWARE_ENABLED:'1',SONUVI_HARDWARE_HOST:'192.168.10.20',SONUVI_HARDWARE_PORT:'3103',SONUVI_HARDWARE_CLIENTS:JSON.stringify({'192.168.10.30':['mabel']}),MILLS_PLAYLIST_NAME:'Custom Mills'};
  const plan=planMasterConfigurationMigration({base:{},environment});
  assert.equal(plan.errors.length,0);
  assert.equal(plan.document.plugins.mills.playlistName,'Custom Mills');
  assert.equal(plan.document.plugins.playback.millsPlaylistName,undefined);
  const result=canonicalRuntimeEnvironment(plan.document,{SONUVI_HARDWARE_HOST:'stale.test'});
  assert.equal(result.SONUVI_HARDWARE_HOST,'192.168.10.20');
  assert.deepEqual(JSON.parse(result.SONUVI_HARDWARE_CLIENTS),{'192.168.10.30':['mabel']});
  assert.equal(canonicalRuntimeEnvironment(initializeMasterConfiguration(),environment).SONUVI_HARDWARE_ENABLED,'0');
});
