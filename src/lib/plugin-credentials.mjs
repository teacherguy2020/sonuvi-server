import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeJsonAtomically} from './atomic-file.mjs';

export const pluginCredentialFields=Object.freeze({
  apns:{keyId:'APNS_KEY_ID',teamId:'APNS_TEAM_ID',privateKey:'APNS_PRIVATE_KEY'},
  notifications:{pushoverToken:'PUSHOVER_TOKEN',pushoverUserKey:'PUSHOVER_USER_KEY'},
  alexa:{routeWebhookUrl:'ALEXA_ROUTE_WEBHOOK_URL',stopWebhookUrl:'ALEXA_STOP_WEBHOOK_URL'},
});
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const fileFor=(statePaths,id)=>path.join(statePaths.secretsRoot||statePaths.protectedRoot,'integrations',id,'credentials.json');
function read(statePaths,id){
  try {
    const file=fileFor(statePaths,id),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw fail('plugin_credentials_invalid_file',500);
    const result=JSON.parse(fs.readFileSync(file,'utf8'));
    if(result.version!==1||!result.values||Object.keys(result.values).some(key=>!Object.hasOwn(pluginCredentialFields[id],key)||typeof result.values[key]!=='string'))throw fail('plugin_credentials_invalid_file',500);
    return result.values;
  }catch(error){if(error.code==='ENOENT')return {};throw error;}
}

export function installPluginCredentialEnvironment(statePaths,env=process.env){
  for(const [id,fields] of Object.entries(pluginCredentialFields)){
    const values=read(statePaths,id);
    if(id==='apns'&&Object.hasOwn(values,'privateKey'))delete env.APNS_PRIVATE_KEY_PATH;
    for(const [key,name] of Object.entries(fields))if(Object.hasOwn(values,key))env[name]=values[key];
  }
}

export function createPluginCredentialAdministration({statePaths,env=process.env}){
  const status=id=>{
    const fields=pluginCredentialFields[id],values=read(statePaths,id);
    const presence=Object.fromEntries(Object.entries(fields).map(([key,name])=>[key,Boolean(Object.hasOwn(values,key)?values[key]:env[name])]));
    return {configured:Object.values(presence).every(Boolean),credentials:presence,operational:null,
      restartRequired:Object.entries(fields).some(([key,name])=>Object.hasOwn(values,key)&&values[key]!==String(env[name]||''))};
  };
  async function save(id,updates){
    const fields=pluginCredentialFields[id];
    if(!fields)throw fail('plugin_credentials_unsupported',404);
    if(!updates||typeof updates!=='object'||Array.isArray(updates)||!Object.keys(updates).length)throw fail('plugin_credentials_required');
    for(const [key,value] of Object.entries(updates))if(!Object.hasOwn(fields,key)||typeof value!=='string'||value.length>32768||value.includes('\0'))throw fail('plugin_credentials_invalid');
    if(id==='apns'&&updates.privateKey){
      try{const key=crypto.createPrivateKey(updates.privateKey.replace(/\\n/g,'\n'));if(key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error();}
      catch{throw fail('apns_requires_p256_private_key');}
    }
    if(id==='alexa')for(const value of Object.values(updates))if(value){
      try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))throw new Error();}
      catch{throw fail('alexa_webhook_url_invalid');}
    }
    const file=fileFor(statePaths,id),lockFile=file+'.lock';let lock;
    try{lock=await fsp.open(lockFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('plugin_credentials_busy',409);throw error;}
    try{const values={...read(statePaths,id),...updates};await writeJsonAtomically(file,{version:1,values},{mode:0o600});return status(id);}
    finally{await lock.close();await fsp.unlink(lockFile);}
  }
  return {status,save};
}
