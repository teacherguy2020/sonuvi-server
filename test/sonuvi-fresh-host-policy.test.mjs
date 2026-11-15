import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {RESTART_RULE,provisionFreshHostPolicy} from '../src/lib/sonuvi-fresh-host-policy.mjs';

test('policy permits only Sonuvi restart, never arbitrary units, verbs or users',()=>{
 let rule;
 vm.runInNewContext(RESTART_RULE,{polkit:{addRule:r=>{rule=r;},Result:{YES:'yes'}}});
 for(const user of ['sonuvi','root','nobody']) for(const id of ['org.freedesktop.systemd1.manage-units','org.freedesktop.systemd1.manage-unit-files']) for(const unit of ['sonuvi-api.service','sonuvi-web.service','sshd.service','sonuvi-alexa-public.service']) for(const verb of ['restart','start','stop','reload','enable']){
  const actual=rule({id,lookup:key=>({unit,verb})[key]},{user});
  const allowed=user==='sonuvi'&&id==='org.freedesktop.systemd1.manage-units'&&['sonuvi-api.service','sonuvi-web.service'].includes(unit)&&verb==='restart';
  assert.equal(actual,allowed?'yes':undefined,`${user} ${id} ${unit} ${verb}`);
 }
});
test('provisioning is idempotent, refuses conflicting or symlinked rules',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-policy-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {target}=await provisionFreshHostPolicy({etcRoot:root});
 await provisionFreshHostPolicy({etcRoot:root});
 assert.equal((await fs.stat(target)).mode&0o777,0o644);
 await fs.writeFile(target,'different');
 await assert.rejects(provisionFreshHostPolicy({etcRoot:root}),/conflict/);
 await fs.unlink(target);await fs.symlink(path.join(root,'missing'),target);
 await assert.rejects(provisionFreshHostPolicy({etcRoot:root}),/unsafe/);
});
