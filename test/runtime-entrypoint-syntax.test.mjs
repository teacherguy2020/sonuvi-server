import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('production API and web entry points parse before release activation',()=>{
 for(const file of ['moode-nowplaying-api.mjs','scripts/serve-public-web.mjs']){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(result.status,0,`${file}: ${result.stderr}`);
 }
});
