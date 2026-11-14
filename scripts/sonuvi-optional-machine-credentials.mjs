#!/usr/bin/env node
// Explicit root-only, fixed-target enrollment. Never accepts paths or tokens.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const choices={peppy:['peppy-ingest-token','SONUVI_PEPPY_TOKEN_FILE'], 'moode-state':['moode-state-token','SONUVI_MOODE_STATE_TOKEN_FILE']};
if(process.getuid?.()!==0||process.argv.length!==3||!Object.hasOwn(choices,process.argv[2])) throw Error('root_and_fixed_integration_required');
const [filename,variable]=choices[process.argv[2]],root='/var/lib/sonuvi/protected';
const stat=await fs.lstat(root);
if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)||await fs.realpath(root)!==root) throw Error('protected_path_unsafe');
const gid=Number(execFileSync('/usr/bin/id',['-g','sonuvi'],{encoding:'utf8'}).trim());
if(!Number.isInteger(gid)||gid<0)throw Error('service_group_missing');
const tokenPath=root+'/'+filename;
const directory='/etc/systemd/system/sonuvi-web.service.d';
await fs.mkdir(directory,{recursive:true,mode:0o755});
if(await fs.realpath(directory)!==directory)throw Error('unit_path_unsafe');
const override=directory+'/'+process.argv[2]+'.conf';
// Refuse existing enrollment; never rotate a live sender token implicitly.
for(const file of [tokenPath,override]){try{await fs.lstat(file);throw Error('already_enrolled');}catch(e){if(e.code!=='ENOENT')throw e;}}
await fs.writeFile(tokenPath,crypto.randomBytes(32).toString('base64url')+'\n',{flag:'wx',mode:0o600});
await fs.chown(tokenPath,0,gid);await fs.chmod(tokenPath,0o640);
await fs.writeFile(override,`[Service]\nEnvironment=${variable}=${tokenPath}\n`,{flag:'wx',mode:0o644});
await fs.chmod(override,0o644);
execFileSync('/usr/bin/systemctl',['daemon-reload']);
console.log(JSON.stringify({created:true,integration:process.argv[2],tokenPath,restartRequired:true,companionEnrollmentRequired:true}));
