import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEffectiveRuntimeConfig, writeNativeRuntimeConfig } from '../src/lib/native-configuration-store.mjs';
const base={projectName:'preserved',environment:'fresh-install',nodes:[{name:'server',ip:'127.0.0.1',role:'api'}],ports:{api:3101,ui:8101},features:{podcasts:true},alexa:{enabled:false},display:{idleBrandLine:'original'}};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-config-overlay-'));
 const configRoot=path.join(root,'config'),dataRoot=path.join(root,'data');await fs.mkdir(configRoot);await fs.mkdir(dataRoot,{mode:0o700});
 const configPath=path.join(configRoot,'now-playing.config.json');await fs.writeFile(configPath,JSON.stringify(base),{mode:0o440});await fs.writeFile(path.join(configRoot,'administrator-verifier.json'),'protected',{mode:0o440});await fs.chmod(configRoot,0o550);
 t.after(async()=>{await fs.chmod(configRoot,0o700);await fs.rm(root,{recursive:true,force:true});});return {sharedStateEnabled:true,configPath,dataRoot};
}
test('allowlisted settings persist across processes without changing root-controlled config or verifier',async t=>{
 const paths=await fixture(t),original=await fs.readFile(paths.configPath);const next=structuredClone(base);next.display.idleBrandLine='native saved';next.features.podcasts=false;
 await writeNativeRuntimeConfig(next,{paths});assert.deepEqual(await fs.readFile(paths.configPath),original);assert.equal(await fs.readFile(path.join(path.dirname(paths.configPath),'administrator-verifier.json'),'utf8'),'protected');
 const module=new URL('../src/config/load-config.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {loadConfigOrNull} from ${JSON.stringify(module)};console.log(JSON.stringify(loadConfigOrNull()));`],{encoding:'utf8',env:{...process.env,SONUVI_STATE_ROOT:path.dirname(paths.dataRoot)}});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),next);
 assert.equal((await fs.stat(path.join(paths.dataRoot,'native-configuration.json'))).mode&0o777,0o600);
 for(const change of [{...next,projectName:'other'},{...next,ports:{api:4444,ui:8101}},{...next,trackKey:'secret'}])await assert.rejects(writeNativeRuntimeConfig(change,{paths}));
 assert.deepEqual(readEffectiveRuntimeConfig(paths.configPath,{paths}),next);
});
test('malformed, oversized and symlink overlays fail closed rather than reset to defaults',async t=>{
 const paths=await fixture(t),file=path.join(paths.dataRoot,'native-configuration.json');
 for(const content of ['{',JSON.stringify({format:'sonuvi-server-configuration',version:1,settings:{ports:{api:9999}}}),' '.repeat(65537)]){
  await fs.writeFile(file,content);assert.throws(()=>readEffectiveRuntimeConfig(paths.configPath,{paths}),/overlay_invalid/);
 }
 await fs.unlink(file);await fs.symlink(paths.configPath,file);assert.throws(()=>readEffectiveRuntimeConfig(paths.configPath,{paths}),/overlay_invalid/);await assert.rejects(writeNativeRuntimeConfig(base,{paths}),/overlay_invalid/);
});
