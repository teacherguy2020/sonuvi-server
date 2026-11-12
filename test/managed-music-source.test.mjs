import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readManagedMusicSource } from '../src/lib/managed-music-source.mjs';
import { projectRuntimeAdminConfig, projectRuntimePublicConfig } from '../src/lib/runtime-config-projection.mjs';
import { configurationWorkspace, exportPortableConfiguration } from '../src/lib/native-configuration-workspace.mjs';

test('source is named from installer state, not a mount-path guess; secrets stay excluded', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sonuvi-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'config'));
 fs.writeFileSync(path.join(root,'config/music-setup.json'),JSON.stringify({state:'ready',share:'SamsungMoode',host:'moode.local',sharePassword:'NEVER-EXPOSE',address:'10.0.0.254'}),{mode:0o640});
 const read=()=>readManagedMusicSource({stateRoot:root,ownerUID:process.getuid()});
 const source=read();assert.deepEqual(source,{kind:'network-share',name:'SamsungMoode',host:'moode.local',mountPath:path.join(root,'music'),access:'read-only'});
 const cfg={paths:{musicLibraryRoot:path.join(root,'music'),podcastRoot:path.join(root,'music/Podcasts')}};
 const options={environment:{SONUVI_MUSIC_CONFIGURED:'1',MUSIC_LIBRARY_ROOT:path.join(root,'music')},readMusicSource:read};
 assert.deepEqual(projectRuntimeAdminConfig(cfg,options).storage.musicSource,source);
 assert.deepEqual(configurationWorkspace(cfg,options).musicSource,source);
 assert.ok(!JSON.stringify(projectRuntimeAdminConfig(cfg,options)).includes('NEVER-EXPOSE'));
 assert.ok(!JSON.stringify(projectRuntimePublicConfig(cfg,options)).includes('SamsungMoode'));
 assert.ok(!JSON.stringify(exportPortableConfiguration(cfg)).includes('SamsungMoode'));
 assert.equal(projectRuntimeAdminConfig(cfg,{...options,environment:{}}).storage.musicSource,undefined);
 assert.equal(projectRuntimeAdminConfig(cfg,{...options,environment:{...options.environment,MUSIC_LIBRARY_ROOT:'/unrelated'}}).storage.musicSource,undefined);
});

test('source descriptions fail closed on unsafe, invalid, missing or unfinished state',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sonuvi-source-invalid-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'config'));const file=path.join(root,'config/music-setup.json');
 const read=()=>readManagedMusicSource({stateRoot:root,ownerUID:process.getuid()});assert.equal(read(),null);
 for(const value of [{state:'failed',share:'SamsungMoode',host:'moode.local'},{state:'ready',share:'../escape',host:'moode.local'},{state:'ready',share:'Drive',host:'user:pass@host'},{}]) {fs.writeFileSync(file,JSON.stringify(value),{mode:0o640});assert.equal(read(),null);}
 fs.writeFileSync(file,JSON.stringify({state:'restarting',share:'Second Drive',host:'10.0.0.22'}));assert.equal(read().name,'Second Drive');
 fs.chmodSync(file,0o666);assert.equal(read(),null);fs.chmodSync(file,0o640);
 fs.writeFileSync(file,'x'.repeat(65537));assert.equal(read(),null);
 fs.unlinkSync(file);const other=path.join(root,'other');fs.writeFileSync(other,'{}');fs.symlinkSync(other,file);assert.equal(read(),null);
});
