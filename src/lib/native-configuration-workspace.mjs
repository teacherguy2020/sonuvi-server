import { normalizeMoodeBaseUrl } from './moode-url.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectRuntimeAdminConfig, sanitizeRuntimeConfigUpdate, mergeRuntimeConfig, validateRuntimeConfigShape } from './runtime-config-projection.mjs';
import { assertImmutableRuntimeConfig } from './runtime-config-security.mjs';

// Explicit portable allowlist. Identity, network listeners, credentials, databases,
// caches, subscription records and deployment topology are never serialized.
const field = (id, section, label, type, fallback, env = null, extra = {}) => Object.freeze({ id, section, label, type, fallback, env, ...extra });
export const configurationFields = Object.freeze([
 field('mpd.host','moOde / MPD','MPD host','string','moode.local','MPD_HOST'),
 field('mpd.port','moOde / MPD','MPD port','integer',6600,'MPD_PORT',{min:1,max:65535}),
 field('moode.sshHost','moOde / MPD','moOde SSH host','string','moode.local','MOODE_SSH_HOST'),
 field('moode.sshUser','moOde / MPD','moOde SSH account','string','moode','MOODE_SSH_USER'),
 field('moode.baseUrl','moOde / MPD','moOde URL','url','http://moode.local','MOODE_BASE_URL'),
 field('paths.musicLibraryRoot','Library sources and paths','Remote music root','path','/var/lib/mpd/music','MUSIC_LIBRARY_ROOT'),
 field('paths.moodeUsbMount','Library sources and paths','Remote moOde USB mount','path','/media/usb',null),
 field('paths.piMountBase','Library sources and paths','Server media mount','path','/mnt/SamsungMoode','PI4_MOUNT_BASE'),
 field('paths.podcastRoot','Podcasts','Podcast folder','path','/var/lib/mpd/music/Podcasts','PODCAST_ROOT'),
 ...[['podcasts','Podcasts',true],['ratings','Ratings',true],['radio','Radio artwork',true],['albumPersonnel','Album personnel',true],['showAboutWhenNoPersonnel','About fallback',true],['moodeDisplayTakeover','moOde display enhancement',true],['lastfm','Last.fm metadata',false],['dlnaMediaServer','DLNA MediaServer',false]].map(([id,label,value])=>field('features.'+id,id==='dlnaMediaServer'?'DLNA':id==='podcasts'?'Podcasts':'Features',label,'boolean',value,id==='dlnaMediaServer'?'ENABLE_DLNA_MEDIA_SERVER':null)),
 field('display.idleBrandLine','Idle display','Brand line','string','Clem’s Place'),
 field('display.idleMessageLine','Idle display','Idle message','string','The record room is quiet'),
 field('lastfm.username','Last.fm','Username','string',''),
 field('lastfm.recentsReplaceRadio','Last.fm','Show Last.fm recent row','boolean',false),
 field('lastfm.recentsMode','Last.fm','Recent row content','choice','toptracks',null,{choices:['toptracks','topartists','topalbums','recenttracks']}),
 field('alexa.enabled','Alexa','Enable Alexa','boolean',false,'ENABLE_ALEXA'),
 field('alexa.publicDomain','Alexa','Public domain','string',''),
 field('notifications.trackNotify.enabled','Track notifications','Background monitor','boolean',false,'TRACK_NOTIFY_ENABLED'),
 field('notifications.trackNotify.pollMs','Track notifications','Poll interval (ms)','integer',3000,'TRACK_NOTIFY_POLL_MS',{min:100,max:3600000}),
 field('notifications.trackNotify.dedupeMs','Track notifications','Deduplicate window (ms)','integer',15000,'TRACK_NOTIFY_DEDUPE_MS',{min:0,max:86400000}),
 field('notifications.trackNotify.alexaMaxAgeMs','Track notifications','Alexa maximum age (ms)','integer',21600000,'TRACK_NOTIFY_ALEXA_MAX_AGE_MS',{min:1000,max:604800000}),
]);
const byID = new Map(configurationFields.map(f=>[f.id,f]));
const get = (o,id) => id.split('.').reduce((v,k)=>v?.[k],o);
const set = (o,id,v) => { const keys=id.split('.');const last=keys.pop();for(const k of keys)o=o[k]??={};o[last]=v; };
const plain = v => v!==null && typeof v==='object' && !Array.isArray(v);
export function configError(code,status=400){return Object.assign(new Error(code),{code,status});}
function canonical(v) { return Array.isArray(v)?v.map(canonical):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v; }
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function validate(f,v){
 if(f.type==='boolean')return typeof v==='boolean';
 if(f.type==='integer')return Number.isInteger(v)&&v>=f.min&&v<=f.max;
 if(typeof v!=='string'||v.length>1024||/[\x00-\x1f\x7f]/.test(v))return false;
 if(f.type==='choice')return f.choices.includes(v);
 if(f.type==='path')return v.startsWith('/')&&!v.split('/').includes('..');
 if(f.type==='url'){if(!v)return true;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}
 if(['mpd.host','moode.sshHost'].includes(f.id))return /^[a-zA-Z0-9_.:\[\]-]{1,253}$/.test(v);
 if(f.id==='moode.sshUser')return /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(v);
 if(f.id==='alexa.publicDomain')return !v||/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(v);
 return true;
}
function flatten(value,prefix='',out={}){
 if(!plain(value))throw configError('configuration_invalid');
 for(const [k,v] of Object.entries(value)){
  const id=prefix?prefix+'.'+k:k;
  if(['__proto__','constructor','prototype'].includes(k))throw configError('configuration_field_not_allowed');
  if(plain(v))flatten(v,id,out);else out[id]=v;
 }
 return out;
}
export function validatePortableConfiguration(document){
 if(!plain(document)||Object.keys(document).some(k=>!['format','version','settings'].includes(k))||document.format!=='sonuvi-server-configuration'||document.version!==1||!plain(document.settings))throw configError('configuration_import_invalid');
 const fields=flatten(document.settings);
 if(!Object.keys(fields).length)throw configError('configuration_import_empty');
 for(const [id,v]of Object.entries(fields)){const f=byID.get(id);if(!f)throw configError('configuration_field_not_allowed');if(!validate(f,v))throw configError('configuration_value_invalid');}
 return fields;
}
export function exportPortableConfiguration(cfg){
 const settings={};
 for(const f of configurationFields){const value=get(cfg,f.id);if(value!==undefined){if(!validate(f,value))throw configError('configuration_export_invalid');set(settings,f.id,value);}}
 return {format:'sonuvi-server-configuration',version:1,settings};
}
export function configurationWorkspace(cfg, options={}){
 const env=options.environment??process.env;
 const projection=projectRuntimeAdminConfig(cfg,options);
 const fields=configurationFields.map(f=>{
  const saved=get(cfg,f.id)??get(projection,f.id)??f.fallback;
  const managed=f.env!==null&&env[f.env]!==undefined;
  let effective=managed?env[f.env]:get(projection,f.id)??saved;
  if(managed&&f.type==='boolean')effective=f.env==='ENABLE_ALEXA'?String(effective).trim()==='1':/^(1|true|yes|on)$/i.test(String(effective).trim());
  if(managed&&f.type==='integer')effective=Number(effective);
  const moodeHost=env.MOODE_SSH_HOST||cfg.moode?.sshHost||cfg.mpd?.host||'moode.local';
  if(f.id==='moode.sshHost')effective=moodeHost;
  if(f.id==='mpd.host')effective=env.MPD_HOST||cfg.mpd?.host||moodeHost;
  if(f.id==='moode.baseUrl')effective=normalizeMoodeBaseUrl(env.MOODE_BASE_URL||cfg.moode?.baseUrl,moodeHost);
  if(f.id==='paths.podcastRoot')effective=env.PODCAST_ROOT||cfg.paths?.podcastRoot||(env.MUSIC_LIBRARY_ROOT||cfg.paths?.musicLibraryRoot||'/var/lib/mpd/music').replace(/\/$/,'')+'/Podcasts';
  return {...f,saved,effective,editable:!managed,source:managed?'environment':'configuration',reason:managed?`${f.env} is host-managed. Change the host environment and restart Sonuvi services.`:f.id.startsWith('paths.')?'The folder must already exist on its host; this setting does not create or mount storage.':'Save requires a Server restart for startup-loaded settings.'};
 });
 return {...(projection.storage.musicSource ? { musicSource: projection.storage.musicSource } : {}),revision:digest({cfg,environment:fields.filter(f=>!f.editable).map(f=>[f.id,f.effective])}),fields,hostManaged:[
  'API bind address, API/UI ports, HTTPS certificates and DNS are deployment-managed; changing them here could disconnect this Server.',
  'Network shares, storage mounts, permissions and remote SSH authorization require host setup. Sonuvi uses one MPD/moOde catalog, not an arbitrary source registry.',
  'DLNA requires a host-selected private LAN interface (DLNA_LAN_ADDRESS) and port. The toggle does not create that network configuration.',
  'Last.fm account secrets, APNs, Pushover, Alexa webhooks and Qobuz account linking remain host-managed; configuration exports never include them.',
  'Podcast scheduled downloads require host scheduling. MPD sticker backup/restore and tag/artwork editing are separate maintenance operations, not configuration transfer.',
 ],integrations:{lastfmConfigured:projection.lastfm.configured,pushoverConfigured:projection.notifications.pushover.configured,apnsConfigured:projection.notifications.apns.configured}};
}
export function previewConfigurationImport(cfg,document,options={}){
 const incoming=validatePortableConfiguration(document);const workspace=configurationWorkspace(cfg,options);const changes=[];const skipped=[];const update={};
 for(const f of workspace.fields){if(!Object.hasOwn(incoming,f.id))continue;const value=incoming[f.id];if(!f.editable){skipped.push({id:f.id,reason:f.reason});continue;}if(isDeepStrictEqual(value,f.saved))continue;set(update,f.id,value);changes.push({id:f.id,label:f.label,before:f.saved,after:value,hostSpecific:f.type==='path'||f.section==='moOde / MPD'});}
 const next=mergeRuntimeConfig(cfg,sanitizeRuntimeConfigUpdate(update));
 if(validateRuntimeConfigShape(next).length)throw configError('configuration_validation_failed');
 if(options.environment?.SONUVI_STATE_ROOT||options.environment?.NOW_PLAYING_STATE_ROOT)assertImmutableRuntimeConfig(next);
 return {revision:workspace.revision,previewId:digest({targetIdentity:options.targetIdentity??null,revision:workspace.revision,document}),changes,skipped,restartRequired:changes.length>0,next};
}


export function projectNativeDlnaStatus(value) {
 const installed=value?.installed===true;
 const enabled=installed&&value.enabled===true&&['enabled','running'].includes(value.status);
 return {installed,enabled,status:!installed?'unavailable':enabled?'enabled':'disabled',
  reason:!installed?'not_installed':value.status==='error'?'runtime_start_failed':value.status==='starting'?'starting':enabled?'running':value?.reason==='operator_configuration_required'?'operator_configuration_required':'disabled_by_configuration'};
}
