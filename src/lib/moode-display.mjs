import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveMoodeSshProfile, assertMoodeRemoteCommand} from './moode-ssh-profile.mjs';
import {runtimeStatePaths} from './runtime-state-paths.mjs';

export const DISPLAY_MODES = Object.freeze(['player','peppy','visualizer','kiosk']);
export function displayUrl(origin, mode) {
  if (!DISPLAY_MODES.includes(mode)) throw Error('Invalid display mode');
  const u = new URL(origin);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('A canonical HTTPS display origin is required');
  return mode === 'kiosk' ? `${u.origin}/kiosk.html` : `${u.origin}/display.html?mode=${mode}&kiosk=1`;
}
export function displaySshArgs(mode, {env=process.env, statePaths=runtimeStatePaths({env}), profileDefaults={}}={}) {
  if (!DISPLAY_MODES.includes(mode) || env.SONUVI_MOODE_DISPLAY_PROTOCOL !== 'v1' || !statePaths.sharedStateEnabled) throw Error('Restricted moOde display switching is not configured');
  assertMoodeRemoteCommand('peppy-display-config');
  const root=path.join(statePaths.secretsRoot,'display-ssh');
  const profile=resolveMoodeSshProfile({env:{...env, SONUVI_MOODE_SSH_ROOT:root, SONUVI_MOODE_SSH_IDENTITY:path.join(root,'display_ed25519'), SONUVI_MOODE_SSH_KNOWN_HOSTS:path.join(root,'known_hosts')},statePaths,profileDefaults});
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(profile.host) || !/^[a-z_][a-z0-9_-]*$/i.test(profile.user)) throw Error('Invalid moOde display target');
  return ['-n','-T','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',...profile.argsFor(),`sonuvi-display-v1 ${mode}`];
}
export function isManagedDisplayInvocation(command,args,options,context={}) {
  if (command !== '/usr/bin/ssh' || !Array.isArray(args) || (options && (options.shell || options.env || options.uid != null || options.gid != null))) return false;
  try { return DISPLAY_MODES.some(mode=>JSON.stringify(args)===JSON.stringify(displaySshArgs(mode,context))); } catch { return false; }
}
export async function pushMoodeDisplay(mode,{env=process.env,profileDefaults={},run=promisify(execFile)}={}) {
  const url=displayUrl(env.SONUVI_CONTROLLER_WEB_ORIGIN,mode);
  const {stdout}=await run('/usr/bin/ssh',displaySshArgs(mode,{env,profileDefaults}),{timeout:60000,maxBuffer:16384});
  const reply=JSON.parse(stdout);
  if(reply.contract!=='sonuvi.moode-display.v1'||reply.ok!==true||reply.verified!==true||reply.url!==url||reply.mode!==mode) throw Error('moOde did not verify the requested display');
  return {ok:true,verified:true,mode,url};
}
const profileKeys = new Set(['skin','theme','meterType','fontMode','fontSize','linearStyle','linearSize','meterMode','colorMode','spectrumColor','spectrumEnergy','spectrumPeak','sensitivity','smoothing','playerSize']);
export function validPeppyProfile(p) {
  return !!p && typeof p==='object' && !Array.isArray(p) && Object.keys(p).every(k=>profileKeys.has(k) && typeof p[k]==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(p[k]))
    && (!p.meterType || ['circular','linear','spectrum'].includes(p.meterType))
    && (!p.playerSize || /^\d{2,4}x\d{2,4}$/.test(p.playerSize));
}
export function registerMoodeDisplayRoutes(app,{authorize,readConfig,env=process.env,push=pushMoodeDisplay,profilePath=runtimeStatePaths().peppyLastPushPath}={}) {
  let busy=false;
  app.post('/v1/admin/configuration/master/display',async(req,res)=>{
    if(!(await authorize(req,res))) return;
    const b=req.body;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['mode','playerSize','profile'].includes(k))||!DISPLAY_MODES.includes(b.mode)||(b.playerSize!==undefined&&(b.mode!=='player'||!/^\d{2,4}x\d{2,4}$/.test(b.playerSize)))) return res.status(400).json({ok:false,error:'Invalid display selection'});
    if(b.profile!==undefined&&(b.mode!=='peppy'||!validPeppyProfile(b.profile))) return res.status(400).json({ok:false,error:'Invalid Peppy profile'});
    if(busy) return res.status(409).json({ok:false,error:'A display switch is already in progress'});
    busy=true;let original, saved=false;
    try {
      const cfg=await readConfig();
      try {original=await fs.readFile(profilePath,'utf8');} catch(e) {if(e.code!=='ENOENT')throw e;}
      const previous=original?JSON.parse(original):{};
      if(!previous||typeof previous!=='object'||Array.isArray(previous)) throw Error('Invalid saved display profile');
      const next={...previous,...(b.profile||{}),displayMode:b.mode,...(b.playerSize?{playerSize:b.playerSize}:{}),ts:Date.now()};
      await fs.mkdir(path.dirname(profilePath),{recursive:true});
      await fs.writeFile(profilePath+'.display-tmp',JSON.stringify(next,null,2));
      await fs.rename(profilePath+'.display-tmp',profilePath);saved=true;
      const result=await push(b.mode,{env,profileDefaults:{host:cfg?.moode?.sshHost||cfg?.mpd?.host,user:cfg?.moode?.sshUser||'moode'}});
      return res.json(result);
    } catch(e) {
      let restored=true;
      if(saved)try {if(original===undefined)await fs.unlink(profilePath);else {await fs.writeFile(profilePath+'.display-tmp',original);await fs.rename(profilePath+'.display-tmp',profilePath);}}catch{restored=false;}
      return res.status(502).json({ok:false,error:restored?'Display switch failed; moOde did not confirm the requested target.':'Display switch failed and the saved profile could not be restored.'});
    } finally {busy=false;}
  });
}
