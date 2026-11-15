import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { planMasterConfigurationMigration, ordinaryEnvironmentSettings } from './master-configuration-migration.mjs';
import { MASTER_FORMAT, MasterConfigurationError, validateMasterConfiguration } from './master-configuration.mjs';
import {ordinaryRuntimeOptionNames} from './master-runtime-options.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const credentialEnvironmentNames={
  trackKey:'TRACK_KEY',mobileApiSecret:'MOBILE_API_SECRET',mobileTrackIdSecret:'MOBILE_TRACK_ID_SECRET',mobileApiEnrollmentCode:'MOBILE_API_ENROLLMENT_CODE',
  'lastfm.apiKey':'LASTFM_API_KEY','lastfm.apiSecret':'LASTFM_API_SECRET','lastfm.sessionKey':'LASTFM_SESSION_KEY',
  'notifications.pushover.token':'PUSHOVER_TOKEN','notifications.pushover.userKey':'PUSHOVER_USER_KEY',
  'notifications.apns.keyId':'APNS_KEY_ID','notifications.apns.teamId':'APNS_TEAM_ID','notifications.apns.privateKey':'APNS_PRIVATE_KEY','notifications.apns.privateKeyPath':'APNS_PRIVATE_KEY_PATH',
  appleMusicDeveloperToken:'APPLE_MUSIC_DEVELOPER_TOKEN','appleMusic.developerToken':'APPLE_MUSIC_DEVELOPER_TOKEN','appleMusic.keyId':'APPLE_MUSIC_KEY_ID','appleMusic.teamId':'APPLE_MUSIC_TEAM_ID','appleMusic.privateKeyPath':'APPLE_MUSIC_PRIVATE_KEY_PATH',
  'alexa.routeWebhookUrl':'ALEXA_ROUTE_WEBHOOK_URL','alexa.stopWebhookUrl':'ALEXA_STOP_WEBHOOK_URL',
};
const ordinaryNames = new Set([...Object.keys(ordinaryEnvironmentSettings),...ordinaryRuntimeOptionNames, 'MOODE_SSH','DLNA_LAN_ADDRESS','DLNA_PORT','MOODE_USB_PREFIX','LASTFM_MPD_MODE']);
function parseEnvironment(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
    result[match[1]]=value;
  }
  return result;
}
async function readOptional(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Migration input must be a regular file');
    return {file, data:await fs.readFile(file), mode:stat.mode & 0o777, uid:stat.uid, gid:stat.gid};
  } catch(error) { if(error.code==='ENOENT')return {file,missing:true}; throw error; }
}
async function replace(file, data, metadata) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary,'wx',metadata?.mode ?? 0o600);
    try {
      if(metadata){await handle.chown(metadata.uid,metadata.gid);await handle.chmod(metadata.mode);}
      await handle.writeFile(data); await handle.sync();
    } finally {await handle.close();}
    await fs.rename(temporary,file);
    const directory=await fs.open(path.dirname(file),'r');
    try {await directory.sync();} finally {await directory.close();}
  } finally {await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Explicit installer/maintenance operation; never invoked by a configuration GET.
 * Environment files must be listed in the service's actual load order.
 * Services must be stopped by the caller before transaction activation/rollback.
 */
export async function migrateMasterConfiguration({configPath, overlayPath, environmentFiles=[], effectiveEnvironment=null, credentialEnvironmentPath=null, backupRoot, servicesStopped=false, beforeWrite=async()=>{}}) {
  if(!servicesStopped)throw new MasterConfigurationError('migration_requires_stopped_services',409);
  for(const file of [configPath,overlayPath,backupRoot,...environmentFiles])if(!path.isAbsolute(file))throw new Error('Migration paths must be absolute');
  if(credentialEnvironmentPath&&(!path.isAbsolute(credentialEnvironmentPath)||[configPath,overlayPath].includes(credentialEnvironmentPath)))throw new Error('Invalid protected credential target');
  const lockPath=`${configPath}.migration.lock`;
  const lock=await fs.open(lockPath,'wx',0o600);
  await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();
  let backup,manifest;
  let prepared=false,retainLock=false;
  const written=new Set();
  try {
    const eventStatePath=path.join(path.dirname(overlayPath),'alexa-events.json');
    const inputPaths=[configPath,overlayPath,...environmentFiles];
    if(!inputPaths.includes(eventStatePath))inputPaths.push(eventStatePath);
    if(credentialEnvironmentPath&&!inputPaths.includes(credentialEnvironmentPath))inputPaths.push(credentialEnvironmentPath);
    const inputs=await Promise.all(inputPaths.map(readOptional));
    const base=JSON.parse(inputs[0].data.toString());
    if(base.format===MASTER_FORMAT){
      const errors=validateMasterConfiguration(base);
      if(errors.length)throw new MasterConfigurationError('migration_validation_failed',422,errors);
      return {changed:false};
    }
    const environment=Object.assign({},...inputs.slice(2,2+environmentFiles.length).filter(item=>!item.missing).map(item=>parseEnvironment(item.data.toString())),effectiveEnvironment||{});
    const plan=planMasterConfigurationMigration({base,overlay:inputs[1].missing?null:JSON.parse(inputs[1].data.toString()),environment});
    if(plan.errors.length)throw new MasterConfigurationError('migration_validation_failed',422,plan.errors);
    if(plan.credentialTransfers.length&&(!credentialEnvironmentPath||plan.credentialTransfers.some(item=>!credentialEnvironmentNames[item.path])))throw new MasterConfigurationError('migration_inline_credentials_require_transfer',409,plan.credentialTransfers.map(item=>({path:item.path})));
    backup=path.join(backupRoot,`master-${randomUUID()}`);
    await fs.mkdir(backup,{recursive:true,mode:0o700});
    manifest={version:1,state:'prepared',files:[]};
    for(let i=0;i<inputs.length;i++){
      const item=inputs[i],name=String(i);
      if(!item.missing)await replace(path.join(backup,name),item.data);
      manifest.files.push({...item,data:undefined,backup:name,sha256:item.missing?null:digest(item.data)});
    }
    await replace(path.join(backup,'manifest.json'),JSON.stringify(manifest));
    await lock.truncate(0);await lock.write(JSON.stringify({pid:process.pid,backup}),0,'utf8');await lock.sync();
    prepared=true;
    const writes=[];
    if(Object.keys(plan.eventState?.alexa||{}).length){
      const item=inputs.find(input=>input.file===eventStatePath);
      const existing=item.missing?{}:JSON.parse(item.data.toString());
      const directory=await fs.stat(path.dirname(eventStatePath));
      writes.push({item,data:JSON.stringify({...existing,version:1,alexa:{...plan.eventState.alexa,...existing.alexa}})+'\n',metadata:item.missing?{uid:directory.uid,gid:directory.gid,mode:0o600}:item});
    }
    for(const item of inputs.slice(2,2+environmentFiles.length).filter(item=>!item.missing)){
      const cleaned=item.data.toString().split(/\r?\n/).filter(line=>!ordinaryNames.has(line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1])).join('\n');
      writes.push({item,data:cleaned});
    }
    if(plan.credentialTransfers.length){
      const item=inputs.find(input=>input.file===credentialEnvironmentPath);
      let write=writes.find(entry=>entry.item.file===credentialEnvironmentPath);
      if(!write){write={item,data:item.missing?'':item.data.toString()};writes.push(write);}
      const existing=parseEnvironment(write.data),updates={};
      for(const transfer of plan.credentialTransfers){
        const name=credentialEnvironmentNames[transfer.path];
        updates[name]=String(environment[name]||existing[name]||transfer.value||'');
      }
      const lines=write.data.split(/\r?\n/).filter(line=>!Object.hasOwn(updates,line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]));
      for(const [name,value] of Object.entries(updates))lines.push(`${name}=${JSON.stringify(value)}`);
      write.data=lines.join('\n')+'\n';
      write.item={...item,mode:0o600};
    }
    for(const write of writes){await beforeWrite(write.item.file);await replace(write.item.file,write.data,write.metadata||(write.item.missing?undefined:write.item));written.add(write.item.file);}
    // The master rename is the commit point; a prepared journal can restore all
    // originals if interrupted before completion. No process should start then.
    await beforeWrite(configPath);
    await replace(configPath,JSON.stringify(plan.document,null,2)+'\n',inputs[0]);
    written.add(configPath);
    if(!inputs[1].missing){await beforeWrite(overlayPath);await fs.unlink(overlayPath);}
    manifest.state='committed';
    manifest.after=await Promise.all(inputs.map(async item=>{const current=await readOptional(item.file);return {file:item.file,sha256:current.missing?null:digest(current.data)};}));
    await replace(path.join(backup,'manifest.json'),JSON.stringify(manifest));
    return {changed:true,backup,document:plan.document};
  } catch(error) {
    if(prepared){
      retainLock=true;
      for(const item of manifest.files){
        if(!item.missing)await replace(item.file,await fs.readFile(path.join(backup,item.backup)),item);
        else if(written.has(item.file))await fs.unlink(item.file);
      }
      manifest.state='rolled-back';await replace(path.join(backup,'manifest.json'),JSON.stringify(manifest));
      retainLock=false;
    }
    throw error;
  } finally {await lock.close();if(!retainLock)await fs.unlink(lockPath);}
}

export async function rollbackMasterConfiguration({backup,servicesStopped=false}) {
  if(!servicesStopped)throw new MasterConfigurationError('migration_requires_stopped_services',409);
  const manifest=JSON.parse(await fs.readFile(path.join(backup,'manifest.json'),'utf8'));
  if(manifest.version!==1 || manifest.state!=='committed')throw new Error('No committed migration to roll back');
  // Do not overwrite settings saved since migration.
  for(const expected of manifest.after){const current=await readOptional(expected.file);if((current.missing?null:digest(current.data))!==expected.sha256)throw new MasterConfigurationError('rollback_configuration_changed',409);}
  for(const item of manifest.files)if(!item.missing){const bytes=await fs.readFile(path.join(backup,item.backup));if(digest(bytes)!==item.sha256)throw new Error('Migration backup checksum mismatch');}
  for(const item of manifest.files){
    if(!item.missing)await replace(item.file,await fs.readFile(path.join(backup,item.backup)),item);
    else if(manifest.after.find(value=>value.file===item.file)?.sha256)await fs.unlink(item.file);
  }
  manifest.state='rolled-back';await replace(path.join(backup,'manifest.json'),JSON.stringify(manifest));
  return {rolledBack:true};
}

/** Recover an interrupted migration only while its owner is gone and services
 * are stopped. The journal is durable before the first input mutation. */
export async function recoverMasterConfiguration({configPath,servicesStopped=false}) {
  if(!servicesStopped)throw new MasterConfigurationError('migration_requires_stopped_services',409);
  const lockPath=`${configPath}.migration.lock`;
  const lock=await readOptional(lockPath);
  if(lock.missing)return {recovered:false};
  const owner=JSON.parse(lock.data.toString());
  if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Invalid migration owner');
  try {process.kill(owner.pid,0);throw new MasterConfigurationError('migration_owner_running',409);}
  catch(error){if(error.code!=='ESRCH')throw error;}
  if(owner.backup){
    const manifestPath=path.join(owner.backup,'manifest.json');
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    if(manifest.version!==1||!manifest.files.some(item=>item.file===configPath))throw new Error('Invalid migration journal');
    if(manifest.state==='prepared'){
      // Verify the entire backup before restoring any file. Recovery itself is
      // repeatable if interrupted partway through restoration.
      const originals=await Promise.all(manifest.files.map(async item=>{
        if(item.missing)return null;
        const data=await fs.readFile(path.join(owner.backup,item.backup));
        if(digest(data)!==item.sha256)throw new Error('Migration backup checksum mismatch');
        return data;
      }));
      for(let i=0;i<manifest.files.length;i++){
        const item=manifest.files[i];
        if(item.missing)await fs.unlink(item.file).catch(error=>{if(error.code!=='ENOENT')throw error;});
        else await replace(item.file,originals[i],item);
      }
      manifest.state='rolled-back';
      await replace(manifestPath,JSON.stringify(manifest));
    }else if(!['committed','rolled-back'].includes(manifest.state))throw new Error('Invalid migration journal state');
  }
  await fs.unlink(lockPath);
  return {recovered:true};
}
