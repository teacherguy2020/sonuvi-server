import { ordinaryEnvironmentSettings, legacyRuntimeConfiguration } from './master-configuration-migration.mjs';
import { MASTER_FORMAT, validateMasterConfiguration, MasterConfigurationError } from './master-configuration.mjs';
import {pluginRuntimeOptions} from './master-runtime-options.mjs';

const get=(value,key)=>key.split('.').reduce((v,part)=>v?.[part],value);
/** Compatibility bridge for existing integrations and child scripts. Values are
 * derived from the master, not a persistent environment configuration layer.
 * Call once before starting runtime consumers. Saves report restart-required.
 */
export function canonicalRuntimeEnvironment(document, inherited = {}) {
  if(document.format!==MASTER_FORMAT)return {...inherited};
  const errors=validateMasterConfiguration(document);
  if(errors.length)throw new MasterConfigurationError('configuration_invalid',422,errors);
  const environment={...inherited}, legacy=legacyRuntimeConfiguration(document);
  for(const [id,names] of Object.entries(pluginRuntimeOptions))for(const name of names){
    delete environment[name];
    const value=document.plugins[id].runtimeOptions?.[name];
    if(value!==undefined)environment[name]=String(value);
  }
  for(const [name,[key,type]] of Object.entries(ordinaryEnvironmentSettings)){
    const value=get(legacy,key);
    delete environment[name];
    if(value!==undefined)environment[name]=type==='json'?JSON.stringify(value):type==='boolean'?(value?'1':'0'):String(value);
  }
  const values={
    MOODE_SSH:document.plugins.moode.sshHost?`${document.plugins.moode.sshUser}@${document.plugins.moode.sshHost}`:'',
    MOODE_USB_PREFIX:document.plugins.moode.usbPrefix,
    DLNA_LAN_ADDRESS:document.plugins.dlna.address,
    DLNA_PORT:document.plugins.dlna.port,
    LASTFM_MPD_MODE:document.plugins.lastfm.enabled && document.plugins.lastfm.scrobblingEnabled?(document.plugins.lastfm.scrobblingMode||'active'):'disabled',
    SONUVI_MUSIC_CONFIGURED:document.plugins.mpd.enabled && Boolean(document.plugins.library.musicLibraryRoot)?'1':'0',
  };
  for(const [name,value] of Object.entries(values)){delete environment[name];if(value!==undefined)environment[name]=String(value);}
  return environment;
}

export function installCanonicalRuntimeEnvironment(document, target=process.env){
  const next=canonicalRuntimeEnvironment(document,target);
  for(const key of Object.keys(target))if(!Object.hasOwn(next,key))delete target[key];
  for(const [key,value] of Object.entries(next))if(target[key]!==value)target[key]=value;
}
