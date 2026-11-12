import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { readGateCTargetIdentity } from './sonuvi-gate-c-target-preflight.mjs';
import { isMusicLibraryTrack } from './music-library-counts.mjs';
import { writeJsonAtomically } from './atomic-file.mjs';

const exec = promisify(callback);
export const MUSIC_SETUP_CONTRACT = 'sonuvi.music-setup.v1';
const ROOT = '/var/lib/sonuvi';
const MOUNT = ROOT + '/music';
const STATUS = ROOT + '/config/music-setup.json';
const ENV = ROOT + '/protected/music-setup.env';
const CREDS = ROOT + '/protected/music-share.credentials';
const UNIT = 'var-lib-sonuvi-music.mount';
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function privateIPv4(value) {
 const a = String(value).split('.');
 if(a.length!==4||a.some(x=>!/^\d{1,3}$/.test(x)||String(Number(x))!==x||Number(x)>255))return false;
 const n=a.map(Number);return n[0]===10||(n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&n[1]===168);
}
export function validateMusicSetupRequest(r) {
 if(!r||Array.isArray(r)||typeof r!=='object'||Object.keys(r).some(k=>!['contract','targetIdentity','operation','host','port','share','shareUser','sharePassword'].includes(k)))fail('music_request_invalid');
 if(r.contract!==MUSIC_SETUP_CONTRACT||!/^sonuvi-target-v1-[a-f0-9]{64}$/.test(r.targetIdentity)||!['discover','inspect','check','apply','status'].includes(r.operation))fail('music_request_invalid');
 if(['inspect','check','apply'].includes(r.operation)) {
  if(typeof r.host!=='string'||! /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(r.host)||r.host.includes('..'))fail('music_host_invalid');
  if(!Number.isInteger(r.port)||r.port<1||r.port>65535)fail('music_port_invalid');
 }
 if(['check','apply'].includes(r.operation)&&!validShare(r.share))fail('music_share_invalid');
 for(const k of ['shareUser','sharePassword'])if(r[k]!==undefined&&(typeof r[k]!=='string'||r[k].length>256||/[\x00-\x1f\x7f]/.test(r[k])))fail('music_share_login_invalid');
 if(r.sharePassword&&!r.shareUser)fail('music_share_login_invalid');
 return r;
}
export const validShare = s => typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9 _().-]{0,79}$/.test(s)&&!s.endsWith('.')&&!s.includes('..');
export async function resolvePlayer(host, lookup=dns.lookup) {
 const rows=await lookup(host,{all:true,family:4}).catch(()=>fail('music_player_not_found'));
 if(!rows.length||rows.some(x=>!privateIPv4(x.address)))fail('music_player_not_private_lan');
 return rows[0].address;
}
export function readMPD(address,port,command) {
 if(!privateIPv4(address)||!Number.isInteger(port)||!['stats','listall'].includes(command))fail('music_request_invalid');
 return new Promise((resolve,reject)=>{
  let data='',greeted=false,settled=false;
  const socket=net.createConnection({host:address,port});
  const finish=(error,result)=>{if(settled)return;settled=true;socket.destroy();error?reject(Object.assign(new Error(error),{code:error})):resolve(result);};
  socket.setTimeout(15000,()=>finish('music_player_timeout'));
  socket.on('error',()=>finish('music_player_unreachable'));
  socket.on('end',()=>{if(!settled)finish('music_player_response_invalid');});
  socket.on('data',bytes=>{
   data+=bytes.toString('utf8');if(Buffer.byteLength(data)>32*1024*1024)return finish('music_catalog_too_large');
   if(!greeted){const i=data.indexOf('\n');if(i<0)return;if(!/^OK MPD \d+\.\d+/.test(data.slice(0,i)))return finish('music_player_response_invalid');data=data.slice(i+1);greeted=true;socket.write(command+'\n');}
   if(/(?:^|\n)ACK /.test(data))return finish('music_player_access_denied');
   if(data==='OK\n'||data.endsWith('\nOK\n'))finish(null,data.slice(0,-3));
  });
 });
}
export function catalogFiles(raw) {
 return raw.split('\n').filter(x=>x.startsWith('file: ')).map(x=>x.slice(6)).filter(file=>isMusicLibraryTrack({file}));
}
export function safeRelative(file) {
 return typeof file==='string'&&file.length<4096&&!file.startsWith('/')&&!file.includes('\\')&&!/[\x00-\x1f\x7f]/.test(file)&&!file.split('/').some(x=>x==='..'||x==='.'||!x);
}
export function mappingCandidates(files,share) {
 const prefixes=[`USB/${share}/`,`NAS/${share}/`,''];
 return prefixes.filter(prefix=>{const selected=files.filter(file=>file.startsWith(prefix));return selected.length>0&&selected.every(file=>safeRelative(file.slice(prefix.length)));});
}
const run = (file,args,options={}) => exec(file,args,{timeout:20000,maxBuffer:2*1024*1024,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'},...options});
async function discover() {
 let names=['moode.local'];
 try {const {stdout}=await run('/usr/bin/avahi-browse',['-rpt','_mpd._tcp'],{timeout:6000});for(const row of stdout.split('\n')){const p=row.split(';');if(p[0]==='='&&p[2]==='IPv4'&&privateIPv4(p[7]))names.push(p[7]);}}catch{}
 const seen=new Set(),players=[];
 await Promise.all([...new Set(names)].slice(0,12).map(async host=>{try{const address=await resolvePlayer(host);if(seen.has(address))return;seen.add(address);const stats=await readMPD(address,6600,'stats');players.push({host,address,port:6600,songs:Number(stats.match(/^songs: (\d+)$/m)?.[1]||0)});}catch{}}));
 return {players:players.sort((a,b)=>a.host.localeCompare(b.host))};
}
async function withCredentials(r,action) {
 const directory=await fs.mkdtemp('/run/sonuvi-music-');
 try {
  const file=path.join(directory,'credentials');
  await fs.writeFile(file,`username=${r.shareUser||'guest'}\npassword=${r.sharePassword||''}\n`,{mode:0o600,flag:'wx'});
  return await action(file,directory);
 }finally{await fs.unlink(path.join(directory,'credentials')).catch(()=>{});await fs.rmdir(path.join(directory,'music')).catch(()=>{});await fs.rmdir(directory).catch(()=>{});}
}
async function inspect(r,address) {
 const stats=await readMPD(address,r.port,'stats');
 const shares=await withCredentials(r,async file=>{
  const {stdout}=await run('/usr/bin/smbclient',['-g','-L',address,'-A',file,'-m','SMB3','-t','6']).catch(()=>fail('music_share_login_or_access_failed'));
  return stdout.split('\n').map(x=>x.split('|')).filter(x=>x[0]==='Disk'&&validShare(x[1])).map(x=>x[1]).slice(0,32);
 });
 return {player:{host:r.host,address,port:r.port,songs:Number(stats.match(/^songs: (\d+)$/m)?.[1]||0)},shares};
}
async function verifyFiles(root,files,share) {
 for(const prefix of mappingCandidates(files,share)) {
  const selected=files.filter(file=>file.startsWith(prefix));
  const samples=[...new Set([selected[0],selected[Math.floor(selected.length/2)],selected.at(-1)])];
  let valid=true;
  for(const file of samples) {
   const candidate=path.join(root,file.slice(prefix.length));
   try {
    const real=await fs.realpath(candidate);if(!real.startsWith(root+'/')){valid=false;break;}
    const stat=await fs.stat(real);if(!stat.isFile()||stat.size===0){valid=false;break;}
    await run('/usr/sbin/runuser',['-u','sonuvi','--','/usr/bin/head','-c','1','--',real],{maxBuffer:64});
   }catch{valid=false;break;}
  }
  if(valid)return {prefix,tracks:selected.length,excludedTracks:files.length-selected.length,samplesVerified:samples.length};
 }
 fail(files.length?'music_share_does_not_match_catalog':'music_player_library_empty');
}
async function mountShare(r,address,credentials,where) {
 const uid=(await run('/usr/bin/id',['-u','sonuvi'])).stdout.trim();const gid=(await run('/usr/bin/id',['-g','sonuvi'])).stdout.trim();
 if(!/^\d+$/.test(uid)||!/^\d+$/.test(gid))fail('music_service_account_unavailable');
 const options=`ro,nosuid,nodev,noexec,vers=3.0,port=445,ip=${address},credentials=${credentials},uid=${uid},gid=${gid},file_mode=0440,dir_mode=0550,nounix`;
 await run('/usr/sbin/mount.cifs',[`//${address}/${r.share}`,where,'-o',options],{timeout:25000}).catch(()=>fail('music_share_mount_failed'));
 return options;
}
async function check(r,address) {
 const files=catalogFiles(await readMPD(address,r.port,'listall'));
 return withCredentials(r,async(credentials,directory)=>{
  // Parent needs traverse permission for the service-user read test. Secrets remain0600.
  await fs.chmod(directory,0o711);const mount=path.join(directory,'music');await fs.mkdir(mount,{mode:0o755});let mounted=false;
  try{await mountShare(r,address,credentials,mount);mounted=true;return {check:await verifyFiles(mount,files,r.share)};}
  finally{if(mounted)await run('/usr/bin/umount',[mount]);}
 });
}
async function safeFile(file) {
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0)fail('music_host_state_conflict');return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function saveState(value) {
 await safeFile(STATUS);await writeJsonAtomically(STATUS,value,{mode:0o640});await run('/usr/bin/chown',['root:sonuvi',STATUS]);
}
async function verifiedStatus() {
 const state=JSON.parse(await safeFile(STATUS)||'{"state":"not-configured"}');
 if(state.state!=='ready')return state;
 try {
  const {stdout}=await run('/usr/bin/findmnt',['-n','-o','SOURCE,OPTIONS','--mountpoint',MOUNT]);
  if(!stdout.startsWith(`//${state.address}/${state.share} `)||!/(?:^|[, ])ro(?:,|$)/.test(stdout.trim()))fail('music_share_mount_failed');
  const files=catalogFiles(await readMPD(state.address,state.port,'listall'));
  await verifyFiles(MOUNT,files,state.share);
  return state;
 }catch(e){return {...state,state:'failed',code:e.code||'music_setup_failed'};}
}
async function apply(r,address) {
 const previous=JSON.parse(await safeFile(STATUS)||'null');
 if(previous?.state==='ready') {
  if(previous.address!==address||previous.share!==r.share||previous.port!==r.port)fail('music_already_configured');
  return verifiedStatus();
 }
 if(previous)fail('music_setup_needs_recovery');
 await check(r,address); // Read-only proof before durable host changes.
 for(const file of [ENV,CREDS,`/etc/systemd/system/${UNIT}`,'/etc/systemd/system/sonuvi-api.service.d/50-music-setup.conf'])if(await safeFile(file)!==null)fail('music_host_state_conflict');
 const mountExists=await fs.lstat(MOUNT).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
 if(mountExists)fail('music_host_state_conflict');
 const files=catalogFiles(await readMPD(address,r.port,'listall'));
 let state={state:'mounting',address,host:r.host,port:r.port,share:r.share,updatedAt:new Date().toISOString()};
 await saveState(state);
 try {
  await fs.mkdir(MOUNT,{mode:0o755});
  await fs.writeFile(CREDS,`username=${r.shareUser||'guest'}\npassword=${r.sharePassword||''}\n`,{mode:0o600,flag:'wx'});
  const options=await mountShare(r,address,CREDS,MOUNT);
  const verified=await verifyFiles(MOUNT,files,r.share);
  state={...state,state:'configuring',...verified};await saveState(state);
  const env=`SONUVI_MUSIC_CONFIGURED=1\nMPD_HOST=${address}\nMPD_PORT=${r.port}\nMOODE_SSH_HOST=${address}\nMOODE_BASE_URL=http://${address}\nMOODE_USB_PREFIX=${verified.prefix}\nMUSIC_LIBRARY_ROOT=${MOUNT}\nPI4_MOUNT_BASE=${MOUNT}\n`;
  await fs.writeFile(ENV,env,{mode:0o600,flag:'wx'});
  // No fstab edits and no remote writes. Only this fixed read-only share unit.
  const unit=`[Unit]\nDescription=Sonuvi read-only music share\nAfter=network-online.target\nWants=network-online.target\n[Mount]\nWhat=//${address}/${r.share}\nWhere=${MOUNT}\nType=cifs\nOptions=${options}\nTimeoutSec=25\n[Install]\nWantedBy=multi-user.target\n`;
  await fs.writeFile(`/etc/systemd/system/${UNIT}`,unit,{mode:0o644,flag:'wx'});
  await fs.mkdir('/etc/systemd/system/sonuvi-api.service.d',{recursive:true});
  await fs.writeFile('/etc/systemd/system/sonuvi-api.service.d/50-music-setup.conf',`[Unit]\nWants=${UNIT}\nAfter=${UNIT}\n[Service]\nEnvironmentFile=${ENV}\nReadOnlyPaths=${MOUNT}\n`,{mode:0o644,flag:'wx'});
  await run('/usr/bin/systemctl',['daemon-reload']);await run('/usr/bin/systemctl',['enable',UNIT]);
  state={...state,state:'indexing'};await saveState(state);
  const result=await run('/usr/sbin/runuser',['-u','sonuvi','--','/usr/bin/env',`SONUVI_STATE_ROOT=${ROOT}`,`SONUVI_RELEASE_ROOT=/opt/sonuvi/current`,`MPD_HOST=${address}`,`MPD_PORT=${r.port}`,'SONUVI_MUSIC_CONFIGURED=1',`MOODE_USB_PREFIX=${verified.prefix}`,'/usr/bin/node','/opt/sonuvi/current/scripts/sonuvi-music-index.mjs'],{timeout:180000,maxBuffer:65536});
  const counts=JSON.parse(result.stdout);if(!Number.isInteger(counts.tracks)||counts.tracks<1)fail('music_index_empty');
  state={...state,state:'restarting',counts};await saveState(state);
  await run('/usr/bin/systemctl',['restart','sonuvi-api.service'],{timeout:30000});
  let healthy=false;
  for(let i=0;i<30;i++){try{const response=await fetch('http://127.0.0.1:3101/health',{signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).ok){healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!healthy)fail('music_service_restart_failed');
  state={...state,state:'ready',updatedAt:new Date().toISOString()};await saveState(state);return state;
 }catch(e){await saveState({...state,state:'failed',code:/^music_[a-z_]+$/.test(e.code||'')?e.code:'music_setup_failed',updatedAt:new Date().toISOString()});throw e;}
}
export async function runMusicSetup(request,{readIdentity=readGateCTargetIdentity,discoverPlayers=discover,resolve=resolvePlayer,inspectPlayer=inspect,checkShare=check,applySetup=apply,readState=verifiedStatus}={}) {
 const r=validateMusicSetupRequest(request);const targetIdentity=await readIdentity();if(r.targetIdentity!==targetIdentity)fail('music_target_mismatch');
 let result;
 if(r.operation==='discover')result=await discoverPlayers();
 else if(r.operation==='status')result=await readState();
 else {const address=await resolve(r.host);result=await ({inspect:inspectPlayer,check:checkShare,apply:applySetup}[r.operation])(r,address);}
 return {ok:true,contract:MUSIC_SETUP_CONTRACT,targetIdentity,...result};
}
