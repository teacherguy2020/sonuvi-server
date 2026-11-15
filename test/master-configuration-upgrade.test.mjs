import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMasterConfigurationUpgrade} from '../src/lib/master-configuration-upgrade.mjs';
async function fixture(t){
 const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-config-upgrade-'));t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
 const context={transactionId:'fixture-transaction',candidate:{manifest:{files:[{path:'src/lib/master-configuration.mjs'}]}}};
 for(const dir of ['config','data','protected','checkpoints/release-upgrade-backups/'+context.transactionId])await fs.mkdir(path.join(stateRoot,dir),{recursive:true,mode:0o700});
 const original=JSON.stringify({ports:{api:3101,ui:8101},mpd:{host:'legacy.test',port:6600},custom:{retained:true}});
 await fs.writeFile(path.join(stateRoot,'config/now-playing.config.json'),original,{mode:0o640});
 await fs.chmod(path.join(stateRoot,'config/now-playing.config.json'),0o640);
 await fs.writeFile(path.join(stateRoot,'protected/now-playing.env'),'MPD_HOST=env.test\nLASTFM_API_KEY=fixture-only\n',{mode:0o600});
 return {stateRoot,context,original};
}
test('upgrade uses effective service settings and restores config, environment and modes on release rollback',async t=>{
 const f=await fixture(t),upgrade=createMasterConfigurationUpgrade({stateRoot:f.stateRoot,run:async()=>{}});
 await upgrade.prepare(f.context,{MPD_HOST:'effective.test'});
 const file=path.join(f.stateRoot,'config/now-playing.config.json');
 const document=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(document.plugins.mpd.host,'effective.test');assert.equal(document.core.custom.retained,true);
 assert.equal((await fs.stat(path.dirname(file))).mode&0o7777,0o1770);
 await upgrade.rollback(f.context);
 assert.equal(await fs.readFile(file,'utf8'),f.original);
 assert.equal((await fs.stat(file)).mode&0o777,0o640);
 assert.equal((await fs.stat(path.dirname(file))).mode&0o7777,0o700);
 assert.match(await fs.readFile(path.join(f.stateRoot,'protected/now-playing.env'),'utf8'),/MPD_HOST=env.test/);
 await upgrade.rollback(f.context);
});
test('permission provisioning failure remains recoverable through a new adapter instance',async t=>{
 const f=await fixture(t),upgrade=createMasterConfigurationUpgrade({stateRoot:f.stateRoot,run:async()=>{throw new Error('fixture provisioning failure');}});
 await assert.rejects(upgrade.prepare(f.context,{}),/provisioning/);
 await createMasterConfigurationUpgrade({stateRoot:f.stateRoot}).rollback(f.context);
 assert.equal(await fs.readFile(path.join(f.stateRoot,'config/now-playing.config.json'),'utf8'),f.original);
});
test('older candidates do not migrate configuration or change permissions',async t=>{
 const f=await fixture(t),upgrade=createMasterConfigurationUpgrade({stateRoot:f.stateRoot,run:async()=>{throw new Error('must not run');}});
 await upgrade.prepare({...f.context,candidate:{manifest:{files:[]}}},{});
 assert.equal(await fs.readFile(path.join(f.stateRoot,'config/now-playing.config.json'),'utf8'),f.original);
});
