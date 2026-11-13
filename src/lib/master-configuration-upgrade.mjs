import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {writeJsonAtomically} from './atomic-file.mjs';
import {migrateMasterConfiguration,recoverMasterConfiguration,rollbackMasterConfiguration} from './master-configuration-transaction.mjs';
const execFile=promisify(execFileCallback);
const optional=async file=>{try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

/** Called only by the guarded adapter after both services are confirmed stopped.
 * The adapter's transaction directory binds this journal to its release pair.
 */
export function createMasterConfigurationUpgrade({stateRoot,run=(file,args)=>execFile(file,args)}={}){
  const configPath=path.join(stateRoot,'config/now-playing.config.json');
  const targets=['config','protected','protected/integrations',...['lastfm','apns','notifications','alexa'].map(id=>'protected/integrations/'+id)];
  const journalFor=context=>path.join(stateRoot,'checkpoints/release-upgrade-backups',context.transactionId,'master-configuration.json');
  async function prepare(context,effectiveEnvironment){
    // Candidate has already passed immutable inventory/signature verification.
    if(!context.candidate.manifest?.files?.some(file=>file.path==='src/lib/master-configuration.mjs'))return;
    const journalPath=journalFor(context),metadata=[];
    for(const relative of [...targets,'config/now-playing.config.json']){
      const file=path.join(stateRoot,relative),stat=await optional(file);
      if(stat?.isSymbolicLink()||stat&&!(stat.isDirectory()||stat.isFile()))throw new Error('Unsafe configuration migration path');
      metadata.push({relative,missing:!stat,...(stat?{uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777}:{} )});
    }
    const backupRoot=path.join(path.dirname(journalPath),'master-migration');
    await writeJsonAtomically(journalPath,{version:1,state:'preparing',metadata,backupRoot},{mode:0o600});
    await recoverMasterConfiguration({configPath,servicesStopped:true});
    await migrateMasterConfiguration({configPath,overlayPath:path.join(stateRoot,'data/native-configuration.json'),environmentFiles:[path.join(stateRoot,'protected/now-playing.env')],effectiveEnvironment,credentialEnvironmentPath:path.join(stateRoot,'protected/now-playing.env'),backupRoot,servicesStopped:true});
    for(const relative of targets){
      const file=path.join(stateRoot,relative);
      await fs.mkdir(file,{recursive:true,mode:0o700});
      const integration=relative.startsWith('protected/integrations/');
      await run('/usr/bin/chown',[integration?'sonuvi:sonuvi':'root:sonuvi',file]);
      await fs.chmod(file,relative==='config'?0o1770:integration?0o700:0o710);
    }
    await run('/usr/bin/chown',['sonuvi:sonuvi',configPath]);await fs.chmod(configPath,0o600);
    await writeJsonAtomically(journalPath,{version:1,state:'prepared',metadata,backupRoot},{mode:0o600});
  }
  async function rollback(context){
    const journalPath=journalFor(context);
    if(!await optional(journalPath))return;
    const journal=JSON.parse(await fs.readFile(journalPath,'utf8'));
    if(journal.version!==1||!Array.isArray(journal.metadata))throw new Error('Invalid configuration upgrade journal');
    if(journal.state==='rolled-back')return;
    await recoverMasterConfiguration({configPath,servicesStopped:true});
    const backups=await fs.readdir(journal.backupRoot).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of backups){
      const backup=path.join(journal.backupRoot,name),manifestPath=path.join(backup,'manifest.json');
      if(!await optional(manifestPath))continue; // No writes precede the prepared manifest.
      const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      if(manifest.state==='committed')await rollbackMasterConfiguration({backup,servicesStopped:true});
      else if(manifest.state!=='rolled-back')throw new Error('Configuration migration requires recovery');
    }
    for(const item of [...journal.metadata].reverse()){
      const file=path.join(stateRoot,item.relative);
      if(item.missing){await fs.rmdir(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      else{await fs.chown(file,item.uid,item.gid);await fs.chmod(file,item.mode);}
    }
    await writeJsonAtomically(journalPath,{...journal,state:'rolled-back'},{mode:0o600});
  }
  return {prepare,rollback};
}
