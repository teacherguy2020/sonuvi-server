import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrateMasterConfiguration,rollbackMasterConfiguration} from '../src/lib/master-configuration-transaction.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-master-migration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json'),overlayPath=path.join(root,'overlay.json'),env=path.join(root,'music.env');
  const original=JSON.stringify({ports:{api:3101,ui:8101},paths:{musicLibraryRoot:'/empty'},features:{ratings:false}});
  await fs.writeFile(configPath,original);
  await fs.writeFile(overlayPath,JSON.stringify({format:'sonuvi-server-configuration',version:1,settings:{features:{ratings:true}}}));
  await fs.writeFile(env,'MUSIC_LIBRARY_ROOT=/music\nLASTFM_API_KEY=fixture-secret\n');
  return {configPath,overlayPath,environmentFiles:[env],backupRoot:path.join(root,'backups'),servicesStopped:true,original,env};
}
test('migration consolidates, disables overlays, retains secrets and rolls back byte-exactly',async t=>{
  const f=await fixture(t), result=await migrateMasterConfiguration(f);
  assert.equal(result.document.plugins.library.musicLibraryRoot,'/music');
  assert.equal(result.document.plugins.ratings.enabled,true);
  await assert.rejects(fs.access(f.overlayPath));
  assert.equal(await fs.readFile(f.env,'utf8'),'LASTFM_API_KEY=fixture-secret\n');
  assert.deepEqual(await migrateMasterConfiguration(f),{changed:false});
  await rollbackMasterConfiguration({backup:result.backup,servicesStopped:true});
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
  assert.equal(await fs.readFile(f.env,'utf8'),'MUSIC_LIBRARY_ROOT=/music\nLASTFM_API_KEY=fixture-secret\n');
  await fs.access(f.overlayPath);
});
test('write failure restores original inputs and keeps a rollback journal',async t=>{
  const f=await fixture(t);
  await assert.rejects(migrateMasterConfiguration({...f,beforeWrite:async file=>{if(file===f.configPath)throw new Error('injected failure');}}),/injected/);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
  assert.equal(await fs.readFile(f.env,'utf8'),'MUSIC_LIBRARY_ROOT=/music\nLASTFM_API_KEY=fixture-secret\n');
  await fs.access(f.overlayPath);
});
test('validation failure leaves configuration and environment unchanged',async t=>{
  const f=await fixture(t);
  await fs.appendFile(f.env,'MPD_PORT=invalid\n');
  await assert.rejects(migrateMasterConfiguration(f),{code:'migration_validation_failed'});
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
  assert.match(await fs.readFile(f.env,'utf8'),/MPD_PORT=invalid/);
});
test('rollback refuses to discard subsequent administrator changes',async t=>{
  const f=await fixture(t),result=await migrateMasterConfiguration(f);
  await fs.appendFile(f.configPath,'\n');
  await assert.rejects(rollbackMasterConfiguration({backup:result.backup,servicesStopped:true}),{code:'rollback_configuration_changed'});
});
test('inline Last.fm credentials transfer atomically with environment precedence and recoverable rollback',async t=>{
  const f=await fixture(t),credentialEnvironmentPath=path.join(path.dirname(f.configPath),'lastfm.env');
  const base=JSON.parse(f.original);base.lastfm={apiKey:'old-inline',apiSecret:'fixture-secret-value'};
  const original=JSON.stringify(base);await fs.writeFile(f.configPath,original);
  const result=await migrateMasterConfiguration({...f,credentialEnvironmentPath});
  const credentials=await fs.readFile(credentialEnvironmentPath,'utf8');
  assert.match(credentials,/LASTFM_API_KEY="fixture-secret"/);
  assert.match(credentials,/LASTFM_API_SECRET="fixture-secret-value"/);
  assert.equal(JSON.stringify(result.document).includes('fixture-secret'),false);
  assert.equal((await fs.stat(credentialEnvironmentPath)).mode&0o777,0o600);
  await rollbackMasterConfiguration({backup:result.backup,servicesStopped:true});
  assert.equal(await fs.readFile(f.configPath,'utf8'),original);
  await assert.rejects(fs.access(credentialEnvironmentPath));
});
test('failed activation removes only the newly created credential file and restores inline original',async t=>{
  const f=await fixture(t),credentialEnvironmentPath=path.join(path.dirname(f.configPath),'lastfm.env');
  const base=JSON.parse(f.original);base.lastfm={apiSecret:'fixture-secret-value'};
  const original=JSON.stringify(base);await fs.writeFile(f.configPath,original);
  await assert.rejects(migrateMasterConfiguration({...f,credentialEnvironmentPath,beforeWrite:async file=>{if(file===f.configPath)throw new Error('injected');}}),/injected/);
  assert.equal(await fs.readFile(f.configPath,'utf8'),original);await assert.rejects(fs.access(credentialEnvironmentPath));
});

test('process termination after partial credential transfer recovers originals and permits retry',async t=>{
  const {spawn}=await import('node:child_process');
  const {recoverMasterConfiguration}=await import('../src/lib/master-configuration-transaction.mjs');
  const f=await fixture(t),credentialEnvironmentPath=path.join(path.dirname(f.configPath),'credentials.env');
  const original=JSON.stringify({...JSON.parse(f.original),lastfm:{apiSecret:'fixture-only'}});
  await fs.writeFile(f.configPath,original);
  const moduleUrl=new URL('../src/lib/master-configuration-transaction.mjs',import.meta.url).href;
  const script=`import {migrateMasterConfiguration} from ${JSON.stringify(moduleUrl)}; await migrateMasterConfiguration({...${JSON.stringify({...f,credentialEnvironmentPath})},beforeWrite:async file=>{if(file===${JSON.stringify(f.configPath)})process.kill(process.pid,'SIGKILL');}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
  const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
  assert.equal(result.signal,'SIGKILL');
  await fs.access(credentialEnvironmentPath);
  assert.deepEqual(await recoverMasterConfiguration(f),{recovered:true});
  assert.equal(await fs.readFile(f.configPath,'utf8'),original);
  assert.equal(await fs.readFile(f.env,'utf8'),'MUSIC_LIBRARY_ROOT=/music\nLASTFM_API_KEY=fixture-secret\n');
  await assert.rejects(fs.access(credentialEnvironmentPath));
  assert.deepEqual(await recoverMasterConfiguration(f),{recovered:false});
  assert.equal((await migrateMasterConfiguration({...f,credentialEnvironmentPath})).changed,true);
});

test('recovery refuses a live migration owner',async t=>{
  const {recoverMasterConfiguration}=await import('../src/lib/master-configuration-transaction.mjs');
  const f=await fixture(t);
  await fs.writeFile(`${f.configPath}.migration.lock`,JSON.stringify({pid:process.pid}));
  await assert.rejects(recoverMasterConfiguration(f),{code:'migration_owner_running'});
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
});
test('malformed and absent legacy configuration never activate defaults',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.configPath,'{broken');
  await assert.rejects(migrateMasterConfiguration(f),SyntaxError);
  assert.equal(await fs.readFile(f.configPath,'utf8'),'{broken');
  await fs.unlink(f.configPath);
  await assert.rejects(migrateMasterConfiguration(f));
  await assert.rejects(fs.access(f.configPath));
  assert.equal(await fs.readFile(f.env,'utf8'),'MUSIC_LIBRARY_ROOT=/music\nLASTFM_API_KEY=fixture-secret\n');
});

test('observed service environment preserves effective unit and drop-in settings',async t=>{
  const f=await fixture(t);
  const result=await migrateMasterConfiguration({...f,effectiveEnvironment:{MUSIC_LIBRARY_ROOT:'/actual-service-mount',MPD_HOST:'player.test'}});
  assert.equal(result.document.plugins.library.musicLibraryRoot,'/actual-service-mount');
  assert.equal(result.document.plugins.mpd.host,'player.test');
});
test('termination after master rename restores legacy master and overlay before retry',async t=>{
  const {spawn}=await import('node:child_process');
  const {recoverMasterConfiguration}=await import('../src/lib/master-configuration-transaction.mjs');
  const f=await fixture(t);
  const moduleUrl=new URL('../src/lib/master-configuration-transaction.mjs',import.meta.url).href;
  const script=`import {migrateMasterConfiguration} from ${JSON.stringify(moduleUrl)}; await migrateMasterConfiguration({...${JSON.stringify(f)},beforeWrite:async file=>{if(file===${JSON.stringify(f.overlayPath)})process.kill(process.pid,'SIGKILL');}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
  const signal=await new Promise(resolve=>child.on('exit',(_code,signal)=>resolve(signal)));
  assert.equal(signal,'SIGKILL');
  assert.notEqual(await fs.readFile(f.configPath,'utf8'),f.original);
  await recoverMasterConfiguration(f);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
  await fs.access(f.overlayPath);
  assert.equal((await migrateMasterConfiguration(f)).changed,true);
});

test('migration separates historical Alexa observations from configuration and rolls them back',async t=>{
 const f=await fixture(t),base=JSON.parse(f.original);base.alexa={artistAliases:{heard:'correct'},heardArtists:[{artist:'Historical'}]};
 const original=JSON.stringify(base);await fs.writeFile(f.configPath,original);
 const result=await migrateMasterConfiguration(f);
 assert.deepEqual(result.document.plugins.alexa.artistAliases,{heard:'correct'});
 assert.equal(result.document.plugins.alexa.heardArtists,undefined);
 const events=path.join(path.dirname(f.overlayPath),'alexa-events.json');
 assert.deepEqual(JSON.parse(await fs.readFile(events,'utf8')).alexa.heardArtists,[{artist:'Historical'}]);
 await rollbackMasterConfiguration({backup:result.backup,servicesStopped:true});
 assert.equal(await fs.readFile(f.configPath,'utf8'),original);await assert.rejects(fs.access(events));
});
