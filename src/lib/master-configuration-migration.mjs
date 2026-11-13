import { initializeMasterConfiguration, MASTER_FORMAT, validateMasterConfiguration } from './master-configuration.mjs';
import { findSecretConfigFields } from './runtime-config-security.mjs';
import {pluginRuntimeOptions} from './master-runtime-options.mjs';

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function merge(base, update) {
  const result = clone(base);
  for (const [key, value] of Object.entries(update)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration property');
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : clone(value);
  }
  return result;
}
const get = (value, key) => key.split('.').reduce((v, part) => v?.[part], value);
function set(value, key, next) {
  const parts = key.split('.');
  const final = parts.pop();
  for (const part of parts) value = value[part] ??= {};
  value[final] = clone(next);
}

// Shared bidirectional mapping preserves the old integration implementations.
export const legacyPluginFields = {
  'playback.millsPlaylistName':'mills.playlistName', 'playback.seeburgPlaylistName':'seeburg.playlistName', 'playback.multiphonePlaylistName':'multiphone.playlistName',
  'features.lastfm': 'lastfm.enabled', 'lastfm.username': 'lastfm.publicUsername',
  'lastfm.recentsReplaceRadio': 'lastfm.recentsReplaceRadio', 'lastfm.recentsMode': 'lastfm.recentsMode',
  'features.dlnaMediaServer': 'dlna.enabled', 'features.radio': 'radio.enabled',
  'features.podcasts': 'podcasts.enabled', 'features.ratings': 'ratings.enabled',
  'features.moodeDisplayTakeover': 'moode.displayEnhancement',
  'features.albumPersonnel': 'artwork.albumPersonnel', 'features.showAboutWhenNoPersonnel': 'artwork.showAboutWhenNoPersonnel',
  'podcasts.showsDir':'podcasts.showsDir',
  'paths.musicLibraryRoot': 'library.musicLibraryRoot', 'paths.piMountBase': 'library.piMountBase',
  'paths.moodeUsbMount': 'library.moodeUsbMount', 'paths.podcastRoot': 'podcasts.root',
  'paths.subscriptionsJson': 'podcasts.subscriptionsJson', 'runtime.artCacheLimit': 'artwork.artCacheLimit',
};
const sections = { alexa:'alexa', mpd:'mpd', moode:'moode', display:'display',
  'notifications.trackNotify':'notifications', 'notifications.apns':'apns',
  hardware:'hardware', playback:'playback', harmony:'harmony', echoLink:'echoLink', appleMusic:'appleMusic' };

export const ordinaryEnvironmentSettings = {
  SONUVI_HARDWARE_ENABLED:['hardware.enabled','boolean'],SONUVI_HARDWARE_HOST:['hardware.host','string'],SONUVI_HARDWARE_PORT:['hardware.port','number'],SONUVI_HARDWARE_CLIENTS:['hardware.clients','json'],
  LOCAL_ADDRESS:['runtime.localAddress','string'],MOBILE_PUBLIC_BASE_URL:['runtime.mobilePublicBaseUrl','string'],LOG_LEVEL:['runtime.logLevel','string'],
  TRANSCODE_TRACKS:['playback.transcodeTracks','boolean'], MOBILE_TRANSCODE_TRACKS:['playback.mobileTranscodeTracks','boolean'], MOBILE_VIDEO_ROOT:['playback.mobileVideoRoot','string'],
  FAVORITES_PLAYLIST_NAME:['playback.favoritesPlaylistName','string'], FAVORITES_REFRESH_MS:['playback.favoritesRefreshMs','number'], FAVORITES_M3U:['playback.favoritesM3u','string'],
  SEEBURG_PLAYLIST_NAME:['playback.seeburgPlaylistName','string'], MULTIPHONE_PLAYLIST_NAME:['playback.multiphonePlaylistName','string'], MILLS_PLAYLIST_NAME:['playback.millsPlaylistName','string'],
  HARMONY_HOST:['harmony.host','string'], HARMONY_PORT:['harmony.port','number'], HARMONY_DOMAIN:['harmony.domain','string'], HARMONY_HUB_ID:['harmony.hubId','string'], HARMONY_DENON_DEVICE_ID:['harmony.denonDeviceId','string'], HARMONY_INPUT_PHONO:['harmony.inputPhono','string'], HARMONY_INPUT_AUX1:['harmony.inputAux1','string'],
  ECHO_LINK_ENABLED:['echoLink.enabled','boolean'], ECHO_LINK_HOST:['echoLink.host','string'], ECHO_LINK_PORT:['echoLink.port','number'], ECHO_LINK_TIMEOUT_MS:['echoLink.timeoutMs','number'],
  APPLE_MUSIC_COUNTRY:['appleMusic.country','string'], APPLE_MUSIC_TIMEOUT_MS:['appleMusic.timeoutMs','number'], ITUNES_TIMEOUT_MS:['appleMusic.itunesTimeoutMs','number'],
  MOODE_LIBRARY_INDEX:['moode.libraryIndexPath','string'],MOODE_PLAYLIST_COVER_DIR:['moode.playlistCoverDir','string'],MPD_MUSIC_ROOT:['mpd.musicRoot','string'],MPD_STICKER_PATH:['mpd.stickerPath','string'],PODCAST_SHOWS_DIR:['podcasts.showsDir','string'],
  MPD_HOST:['mpd.host','string'], MPD_PORT:['mpd.port','number'],
  MOODE_SSH_HOST:['moode.sshHost','string'], MOODE_SSH_USER:['moode.sshUser','string'], MOODE_BASE_URL:['moode.baseUrl','string'],
  MUSIC_LIBRARY_ROOT:['paths.musicLibraryRoot','string'], PI4_MOUNT_BASE:['paths.piMountBase','string'], PODCAST_ROOT:['paths.podcastRoot','string'],
  ENABLE_ALEXA:['alexa.enabled','boolean'], ENABLE_DLNA_MEDIA_SERVER:['features.dlnaMediaServer','boolean'],
  TRACK_NOTIFY_ENABLED:['notifications.trackNotify.enabled','boolean'], TRACK_NOTIFY_POLL_MS:['notifications.trackNotify.pollMs','number'],
  TRACK_NOTIFY_DEDUPE_MS:['notifications.trackNotify.dedupeMs','number'], TRACK_NOTIFY_ALEXA_MAX_AGE_MS:['notifications.trackNotify.alexaMaxAgeMs','number'],
  PORT:['ports.api','number'], SONUVI_WEB_PORT:['ports.ui','number'], PUBLIC_BASE_URL:['runtime.publicBaseUrl','string'],
  ART_CACHE_LIMIT:['runtime.artCacheLimit','number'], APNS_TOPIC:['notifications.apns.topic','string'], APNS_ENVIRONMENT:['notifications.apns.environment','string'],
};

/** Pure migration plan: no disk writes, credential changes or host mutations. */
export function planMasterConfigurationMigration({ base, overlay = null, environment = {} }) {
  if (base.format === MASTER_FORMAT) return { document: clone(base), changed: false, sources: [], errors: validateMasterConfiguration(base) };
  if (overlay && (overlay.format !== 'sonuvi-server-configuration' || overlay.version !== 1 || !object(overlay.settings))) {
    throw new Error('Invalid native configuration overlay; migration aborted');
  }
  const effective = merge(base, overlay?.settings || {});
  // Never silently move legacy inline credentials into the public document.
  // The disk migration must move these to protected storage before activation.
  const credentialTransfers = [];
  for (const key of findSecretConfigFields(effective)) {
    credentialTransfers.push({path:key, value:get(effective,key)});
    const parts = key.split('.'); const last = parts.pop();
    const parent = parts.reduce((value,part)=>value?.[part],effective);
    if (parent) delete parent[last];
  }
  const eventState={alexa:{}};
  for(const name of ['unresolvedArtists','heardArtists','unresolvedAlbums','heardAlbums','unresolvedPlaylists','heardPlaylists']){
    if(effective.alexa&&Object.hasOwn(effective.alexa,name)){eventState.alexa[name]=clone(effective.alexa[name]);delete effective.alexa[name];}
  }
  const sources = [];
  for (const [name, [key, type]] of Object.entries(ordinaryEnvironmentSettings)) {
    if (environment[name] === undefined) continue;
    const raw = String(environment[name]);
    const value = type === 'json' ? JSON.parse(raw) : type === 'number' ? Number(raw) : type === 'boolean' ? /^(1|true|yes|on)$/i.test(raw.trim()) : raw;
    set(effective, key, value);
    sources.push({ path:key, source:name });
  }
  if(environment.MOODE_SSH){
    const target=String(environment.MOODE_SSH).trim(),separator=target.lastIndexOf('@');
    set(effective,'moode.sshHost',separator<0?target:target.slice(separator+1));
    if(separator>=0)set(effective,'moode.sshUser',target.slice(0,separator));
  }
  const document = initializeMasterConfiguration();
  for(const [id,names] of Object.entries(pluginRuntimeOptions))for(const name of names){
    if(environment[name]!==undefined){document.plugins[id].runtimeOptions[name]=String(environment[name]);sources.push({path:`plugins.${id}.runtimeOptions.${name}`,source:name});}
  }
  // Preserve custom legacy properties until their consumer has an explicit mapping.
  // This is inside the master, never a second persisted source.
  document.core = merge(document.core,effective);
  for (const [legacy, id] of Object.entries(sections)) {
    const value = get(effective, legacy);
    if (object(value)) document.plugins[id] = { ...document.plugins[id], ...clone(value) };
  }
  for (const [legacy, destination] of Object.entries(legacyPluginFields)) {
    const value = get(effective, legacy);
    if (value !== undefined) set(document.plugins, destination, value);
  }
  for(const key of ['millsPlaylistName','seeburgPlaylistName','multiphonePlaylistName'])delete document.plugins.playback[key];
  document.plugins.mpd.enabled = Boolean(document.plugins.mpd.host);
  document.plugins.moode.enabled = Boolean(document.plugins.moode.sshHost || document.plugins.moode.baseUrl);
  const legacyCredential=(name,key)=>environment[name]||credentialTransfers.find(item=>item.path===key)?.value;
  if(get(effective,'features.lastfm')===undefined)document.plugins.lastfm.enabled=Boolean(legacyCredential('LASTFM_API_KEY','lastfm.apiKey'));
  document.plugins.lastfm.scrobblingEnabled=Boolean(legacyCredential('LASTFM_SESSION_KEY','lastfm.sessionKey'));
  document.plugins.lastfm.scrobblingMode='shadow'; // Prior installations defer MPD to their existing scrobbler.
  if(get(effective,'notifications.apns.enabled')===undefined)document.plugins.apns.enabled=Boolean(legacyCredential('APNS_KEY_ID','notifications.apns.keyId')&&legacyCredential('APNS_TEAM_ID','notifications.apns.teamId')&&(legacyCredential('APNS_PRIVATE_KEY','notifications.apns.privateKey')||legacyCredential('APNS_PRIVATE_KEY_PATH','notifications.apns.privateKeyPath')));
  if (environment.MOODE_USB_PREFIX !== undefined) document.plugins.moode.usbPrefix = environment.MOODE_USB_PREFIX;
  if (environment.DLNA_LAN_ADDRESS !== undefined) document.plugins.dlna.address = environment.DLNA_LAN_ADDRESS;
  if (environment.DLNA_PORT !== undefined) document.plugins.dlna.port = Number(environment.DLNA_PORT);
  if (environment.LASTFM_MPD_MODE !== undefined) {
    document.plugins.lastfm.scrobblingMode = environment.LASTFM_MPD_MODE;
    document.plugins.lastfm.scrobblingEnabled = environment.LASTFM_MPD_MODE === 'active';
  }
  // Remove mapped fields from core: only the plugin section owns their values.
  const remove = key => {
    const parts = key.split('.'); const last = parts.pop();
    const parent = parts.reduce((value, part) => value?.[part], document.core);
    if (parent) delete parent[last];
  };
  for (const key of Object.keys(legacyPluginFields)) remove(key);
  for (const key of Object.keys(sections)) remove(key);
  return { document, changed: true, sources, credentialTransfers, eventState, errors: validateMasterConfiguration(document) };
}

export function legacyRuntimeConfiguration(document) {
  if (document.format !== MASTER_FORMAT) return clone(document);
  const result = clone(document.core);
  for (const [legacy, id] of Object.entries(sections)) {
    const value = clone(document.plugins[id]);
    if (['mpd', 'moode', 'display', 'apns'].includes(id)) delete value.enabled;
    set(result, legacy, value);
  }
  for (const [legacy, source] of Object.entries(legacyPluginFields)) {
    const value = get(document.plugins, source);
    if (value !== undefined) set(result, legacy, value);
  }
  Object.defineProperty(result,Symbol.for('sonuvi.master.document'),{value:clone(document),enumerable:false});
  return result;
}
