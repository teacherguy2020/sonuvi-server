import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTLSMaintenance, TLS_RENEW_TIMER, TLS_RENEW_SERVICE } from '../src/lib/sonuvi-local-tls-maintenance.mjs';
test('fixed renewal units cannot overwrite other units and only control their own timer/service',async t=>{
  const unitRoot=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-tls-units-'));t.after(()=>fs.rm(unitRoot,{recursive:true,force:true}));
  const calls=[];const maintenance=localTLSMaintenance({unitRoot,run:async args=>calls.push(args)});
  await maintenance.prepare();await maintenance.prepare();await maintenance.start();await maintenance.stop();
  assert.deepEqual(calls,[['enable','--now',TLS_RENEW_TIMER],['disable','--now',TLS_RENEW_TIMER],['stop',TLS_RENEW_SERVICE]]);
  const unit=await fs.readFile(path.join(unitRoot,TLS_RENEW_SERVICE),'utf8');
  assert.match(unit,/User=root/);assert.match(unit,/verify-current-release/);assert.match(unit,/sonuvi-local-tls-renew\.mjs/);
  await fs.writeFile(path.join(unitRoot,TLS_RENEW_SERVICE),'existing different service');
  await assert.rejects(maintenance.prepare(),/tls_unit_conflict/);
});
