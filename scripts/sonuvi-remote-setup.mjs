#!/usr/bin/env node
import fs from 'node:fs/promises';
import {runRemoteSetup} from '../src/lib/sonuvi-remote-setup.mjs';
let locked=false;
try {
  if(process.getuid?.()!==0)throw new Error('remote_root_required');
  let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>4096)throw new Error('remote_request_invalid');}
  await fs.mkdir('/var/lib/sonuvi/protected/remote-access.lock',{mode:0o700});locked=true;
  process.stdout.write(JSON.stringify(await runRemoteSetup(JSON.parse(text)))+'\n');
} catch(e) {process.stdout.write(JSON.stringify({ok:false,code:/^remote_[a-z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'remote_setup_busy':'remote_setup_failed'})+'\n');}
finally{if(locked)await fs.rmdir('/var/lib/sonuvi/protected/remote-access.lock');}
