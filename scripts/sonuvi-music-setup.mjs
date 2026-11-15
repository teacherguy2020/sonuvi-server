#!/usr/bin/env node
import fs from 'node:fs/promises';
import { runMusicSetup } from '../src/lib/sonuvi-music-setup.mjs';
// Fixed pinned-SSH command, explicit sudo; no generic commands/paths/options.
let lock=false;
try {
 if(process.getuid?.()!==0)throw Object.assign(new Error(),{code:'music_root_required'});
 let data='';for await(const chunk of process.stdin){data+=chunk;if(Buffer.byteLength(data)>8192)throw Object.assign(new Error(),{code:'music_request_too_large'});}
 const request=JSON.parse(data);
 if(['check','apply'].includes(request.operation)){await fs.mkdir('/var/lib/sonuvi/protected/music-setup.lock');lock=true;}
 const result=await runMusicSetup(request);process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stdout.write(JSON.stringify({ok:false,code:/^music_[a-z_]+$/.test(e.code||'')?e.code:e.code==='EEXIST'?'music_setup_busy':'music_setup_failed'})+'\n');}
finally{if(lock)await fs.rmdir('/var/lib/sonuvi/protected/music-setup.lock');}
