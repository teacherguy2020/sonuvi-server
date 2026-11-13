import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadProtectedLastfmEnvironment} from './protected-runtime-secrets.mjs';
import {requestLastfmToken,exchangeLastfmToken,lastfmAuthorizationUrl} from '../../scripts/lastfm-authorize.mjs';

const names=['LASTFM_API_KEY','LASTFM_API_SECRET','LASTFM_SESSION_KEY','LASTFM_USERNAME'];
const failure=(code,status=400)=>Object.assign(new Error(code),{code,status});

/** Existing Last.fm app/browser authorization, with owner-API actions.
 * The installer must provision this specific credential file/directory for the
 * service. Never broaden access to the complete protected state directory.
 */
export function createLastfmPluginAdministration({statePaths,env=process.env,requestToken=requestLastfmToken,exchangeToken=exchangeLastfmToken,now=Date.now}={}) {
  let pending=null, tail=Promise.resolve();
  const read=()=>loadProtectedLastfmEnvironment({statePaths,env});
  const status=()=>{
    const c=read();
    const authorized=Boolean(c.LASTFM_API_KEY&&c.LASTFM_API_SECRET&&c.LASTFM_SESSION_KEY);
    return {configured:Boolean(c.LASTFM_API_KEY),apiKeyConfigured:Boolean(c.LASTFM_API_KEY),apiSecretConfigured:Boolean(c.LASTFM_API_SECRET),authorized,username:c.LASTFM_USERNAME||'',
      metadata:{configured:Boolean(c.LASTFM_API_KEY),operational:null},scrobbling:{configured:authorized,operational:null},
      operational:null,error:c.LASTFM_API_KEY?null:'Configure Last.fm API access to use metadata and Vibe.'};
  };
  async function persist(updates){
    const target=statePaths.lastfmAdminEnvPath || statePaths.lastfmEnvPath,temporary=`${target}.${randomUUID()}.tmp`;
    let original='';
    try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw failure('lastfm_credentials_invalid_file',500);original=await fs.readFile(target,'utf8');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const lines=original.split(/\r?\n/).filter(line=>line!=='# sonuvi-lastfm-admin-v1'&&!Object.hasOwn(updates,line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]));
    lines.unshift('# sonuvi-lastfm-admin-v1');
    for(const [key,value] of Object.entries(updates)){
      if(!names.includes(key)||typeof value!=='string'||/[\r\n\0"']/.test(value))throw failure('lastfm_credential_invalid');
      lines.push(`${key}=${value}`);
    }
    try{
      const file=await fs.open(temporary,'wx',0o600);
      try{await file.writeFile(lines.join('\n')+'\n');await file.sync();}finally{await file.close();}
      await fs.rename(temporary,target);
      const directory=await fs.open(path.dirname(target),'r');try{await directory.sync();}finally{await directory.close();}
      Object.assign(env,updates);
    }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async function perform(action,body={}){
    if(!body||typeof body!=='object'||Array.isArray(body))throw failure('lastfm_request_invalid');
    if(action==='credentials'){
      if(typeof body.apiKey!=='string'||typeof body.apiSecret!=='string'||!body.apiKey||!body.apiSecret||/[\s"'\0]/.test(body.apiKey+body.apiSecret)||body.apiKey===body.apiSecret)throw failure('lastfm_api_key_and_secret_required');
      await persist({LASTFM_API_KEY:body.apiKey,LASTFM_API_SECRET:body.apiSecret,LASTFM_SESSION_KEY:'',LASTFM_USERNAME:''});pending=null;
    }else if(action==='authorize/start'){
      const c=read();if(!c.LASTFM_API_KEY||!c.LASTFM_API_SECRET)throw failure('lastfm_api_credentials_required');
      const token=await requestToken({apiKey:c.LASTFM_API_KEY,apiSecret:c.LASTFM_API_SECRET});
      pending={token,expiresAt:now()+600000};
      return {authorizationUrl:lastfmAuthorizationUrl(c.LASTFM_API_KEY,token),expiresInSeconds:600};
    }else if(action==='authorize/complete'){
      if(!pending||pending.expiresAt<now())throw failure('lastfm_authorization_expired');
      const c=read();const session=await exchangeToken({apiKey:c.LASTFM_API_KEY,apiSecret:c.LASTFM_API_SECRET,token:pending.token});
      await persist({LASTFM_SESSION_KEY:session.sessionKey,LASTFM_USERNAME:session.username});pending=null;
    }else if(action==='disconnect'){
      await persist({LASTFM_SESSION_KEY:'',LASTFM_USERNAME:''});pending=null;
    }else throw failure('lastfm_action_unknown',404);
    return {...status(),restartRequired:true};
  }
  return {status,action(action,body){const result=tail.then(()=>perform(action,body));tail=result.catch(()=>{});return result;}};
}
