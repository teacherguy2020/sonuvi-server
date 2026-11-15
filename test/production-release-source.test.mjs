import test from 'node:test';
import assert from 'node:assert/strict';
import {assertProductionReleaseSource} from '../src/lib/release-activation.mjs';
test('installed upgrade rejects signed development snapshots, including the reverted Home build',()=>{
 for(const source of [undefined,{}, {dirty:true,gitHead:'536275386e412d5cd33212b7401e484bbd41b89f',snapshotStatus:'development-only-dirty-snapshot'}, {dirty:false,snapshotStatus:'development-only-dirty-snapshot'}]) {
  assert.throws(()=>assertProductionReleaseSource({source}),/installed_release_requires_clean_source/);
 }
 assert.doesNotThrow(()=>assertProductionReleaseSource({source:{dirty:false,snapshotStatus:'clean-git-worktree-snapshot'}}));
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertReleaseCompatibility} from '../src/lib/release-activation.mjs';
test('installed compatibility floor refuses missing/older policy before cutover',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'release-floor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const old=path.join(root,'old'),next=path.join(root,'next');
 for(const p of [old,next]) await fs.mkdir(path.join(p,'config'),{recursive:true});
 const write=(p,g)=>fs.writeFile(path.join(p,'config/release-policy.json'),JSON.stringify({contract:'sonuvi.release-policy.v1',compatibilityGeneration:g}));
 await assertReleaseCompatibility(next,old);
 await write(old,20261115);
 await assert.rejects(assertReleaseCompatibility(next,old),/release_compatibility_regression/);
 await write(next,20261114);await assert.rejects(assertReleaseCompatibility(next,old),/release_compatibility_regression/);
 await write(next,20261115);await assertReleaseCompatibility(next,old);
 await write(next,20261116);await assertReleaseCompatibility(next,old);
});
