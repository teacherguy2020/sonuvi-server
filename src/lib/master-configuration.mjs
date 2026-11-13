import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findSecretConfigFields } from './runtime-config-security.mjs';
import {pluginRuntimeOptions} from './master-runtime-options.mjs';

export const MASTER_FORMAT = 'sonuvi-master-configuration';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const configurationRevision = document => createHash('sha256').update(JSON.stringify(canonical(document))).digest('hex');
const field = (type, defaultValue, extra = {}) => ({ type, default: defaultValue, ...extra });
const enabled = value => field('boolean', value);
const string = value => field('string', value);
const integer = (value, minimum, maximum) => field('integer', value, { minimum, maximum });
const plugin = (id, title, fields, credentials = []) => {
  const properties={...fields,...(id==='lastfm'?{scrobblingMode:field('string','active',{enum:['active','shadow','disabled']})}:{}),...(pluginRuntimeOptions[id]?{runtimeOptions:field('object',{})}:{})};
  return ({
  id, title, schema: { type: 'object', properties, additionalProperties: true }, credentials:id==='alexa'?['routeWebhookUrl','stopWebhookUrl',...credentials]:credentials,
  defaults: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, copy(value.default)])),
});};

// Built-in configuration modules, never dynamically loaded executable code.
export const configurationPlugins = [
  plugin('lastfm', 'Last.fm', { enabled: enabled(false), metadataEnabled: enabled(true), scrobblingEnabled: enabled(false), publicUsername: field('string','',{deprecated:true,description:'Legacy public-shelf identity fallback. Connect Last.fm to use the authorized account automatically.'}), recentsReplaceRadio: enabled(false), recentsMode: field('string', 'toptracks', { enum: ['toptracks', 'topartists', 'topalbums', 'recenttracks'] }) }, ['apiKey', 'apiSecret', 'sessionKey']),
  plugin('alexa', 'Alexa', { enabled: enabled(false), publicDomain: string(''), webhookPath: string('/alexa'), artistAliases: field('object', {}), albumAliases: field('object', {}), playlistAliases: field('object', {}) }),
  plugin('notifications', 'Track Notifications', { enabled: enabled(false), pollMs: integer(3000, 100, 3600000), dedupeMs: integer(15000, 0, 86400000), alexaMaxAgeMs: integer(21600000, 1000, 604800000) }, ['pushoverToken', 'pushoverUserKey']),
  plugin('apns', 'Apple Push Notifications', { enabled: enabled(false), topic: string(''), environment: field('string', 'auto', { enum: ['auto', 'sandbox', 'development', 'production'] }) }, ['keyId', 'teamId', 'privateKey']),
  plugin('dlna', 'DLNA MediaServer', { enabled: enabled(false), address: string(''), port: integer(3102, 1, 65535) }),
  plugin('radio', 'Radio', { enabled: enabled(true) }),
  plugin('qobuz', 'Qobuz', {}),
  plugin('upnp', 'UPnP Sources and Renderers', {}),
  plugin('podcasts', 'Podcasts', { enabled: enabled(false), root: string(''), showsDir:string(''), subscriptionsJson: string('./subscriptions.json') }),
  plugin('mpd', 'MPD', { enabled: enabled(false), host: string(''), port: integer(6600, 1, 65535),musicRoot:string('/var/lib/mpd/music'),stickerPath:string('/var/lib/mpd/sticker.sql') }),
  plugin('moode', 'moOde', { enabled: enabled(false), sshHost: string(''), sshUser: string('moode'), baseUrl: string(''), displayEnhancement: enabled(false), usbPrefix: string(''),libraryIndexPath:string(''),playlistCoverDir:string('/var/local/www/imagesw/playlist-covers') }, ['sshPrivateKey', 'sshPassword']),
  plugin('ratings', 'Ratings', { enabled: enabled(false) }),
  plugin('library', 'Library and Storage', { enabled: enabled(true), musicLibraryRoot: string(''), piMountBase: string(''), moodeUsbMount: string('') }, ['shareUsername', 'sharePassword']),
  plugin('artwork', 'Artwork', { enabled: enabled(true), albumPersonnel: enabled(true), showAboutWhenNoPersonnel: enabled(true), artCacheLimit: integer(250, 0, 100000) }),
  plugin('display', 'Display', { enabled: enabled(true), idleBrandLine: string('Sonuvi'), idleMessageLine: string('Ready to play') }),
  plugin('playback', 'Playback and Playlists', { enabled: enabled(true), transcodeTracks: enabled(false), mobileTranscodeTracks: enabled(false), mobileVideoRoot: string(''), favoritesPlaylistName: string('Favorites'), favoritesRefreshMs: integer(3000,100,3600000), favoritesM3u: string('/var/lib/mpd/playlists/Favorites.m3u'),  }),
  plugin('hardware', 'Hardware / External Bridges', {enabled:enabled(false),host:string(''),port:integer(3103,1024,65535),clients:field('object',{})}),
  plugin('mills', 'Mills', {playlistName:string('Mills Playlist')}),
  plugin('seeburg', 'Seeburg', {playlistName:string('Seeburg Playlist')}),
  plugin('multiphone', 'Shyvers Multiphone / Mabel', {playlistName:string('Multiphone Playlist')}),
  plugin('harmony', 'Harmony', { enabled: enabled(false), host: string(''), port: integer(8088,1,65535), domain: string('svcs.myharmony.com'), hubId: string(''), denonDeviceId: string(''), inputPhono: string('InputPhono'), inputAux1: string('InputAux1') }),
  plugin('echoLink', 'Echo Link', { enabled: enabled(false), host: string('127.0.0.1'), port: integer(8765,1,65535), timeoutMs: integer(8000,100,120000) }),
  plugin('appleMusic', 'Apple Music Metadata', { enabled: enabled(false), country: string('us'), timeoutMs: integer(1200,100,120000), itunesTimeoutMs: integer(2500,100,120000) }, ['developerToken','keyId','teamId','privateKey','privateKeyPath']),
];

export function initializeMasterConfiguration(existing = {}) {
  const document = copy(existing);
  document.format ??= MASTER_FORMAT;
  document.version ??= 1;
  document.core ??= { projectName: 'sonuvi', environment: 'fresh-install', timezone: 'UTC', apiHost:'127.0.0.1', nodes:[{name:'sonuvi',ip:'127.0.0.1',role:'both',sshUser:'sonuvi'}], ports: { api: 3101, ui: 8101 } };
  const fillMissing = (target,defaults) => {
    if(!plain(target))return;
    for(const [key,value] of Object.entries(defaults)){
      if(!Object.hasOwn(target,key))target[key]=copy(value);
      else if(plain(value))fillMissing(target[key],value);
    }
  };
  fillMissing(document.core,{projectName:'sonuvi',environment:'fresh-install',timezone:'UTC',apiHost:'127.0.0.1',nodes:[{name:'sonuvi',ip:'127.0.0.1',role:'both',sshUser:'sonuvi'}],ports:{api:3101,ui:8101}});
  document.plugins ??= {};
  for (const module of configurationPlugins) {
    document.plugins[module.id] ??= {};
    for (const [key, value] of Object.entries(module.defaults)) {
      if (!Object.hasOwn(document.plugins[module.id], key)) document.plugins[module.id][key] = copy(value);
    }
  }
  return document;
}

export function validateMasterConfiguration(document) {
  const errors = [];
  const add = (pointer, message) => errors.push({ path: pointer, message });
  if (!plain(document)) return [{ path: '/', message: 'Expected a JSON object' }];
  if (document.format !== MASTER_FORMAT || document.version !== 1) add('/format', 'Unsupported master configuration format/version');
  if (!plain(document.core)) add('/core', 'Core settings must be an object');
  for(const key of ['projectName','environment','timezone','apiHost'])if(typeof document.core?.[key]!=='string')add(`/core/${key}`,'Expected string');
  if(!Array.isArray(document.core?.nodes)||!document.core.nodes.length)add('/core/nodes','Expected at least one Server node');
  else document.core.nodes.forEach((node,index)=>{
    for(const key of ['name','ip','role'])if(typeof node?.[key]!=='string'||!node[key])add(`/core/nodes/${index}/${key}`,'Expected nonempty string');
  });
  for (const key of ['api','ui']) {
    const port=document.core?.ports?.[key];
    if(!Number.isInteger(port)||port<1||port>65535)add(`/core/ports/${key}`,'Expected a port from 1 to 65535');
  }
  if (!plain(document.plugins)) add('/plugins', 'Plugin settings must be an object');
  for (const name of findSecretConfigFields(document.core)) add(`/core/${name.replaceAll('.', '/')}`, 'Use the plugin credential action for this field');
  for (const module of configurationPlugins) {
    const settings = document.plugins?.[module.id];
    if (!plain(settings)) { add(`/plugins/${module.id}`, 'Plugin settings must be an object'); continue; }
    for(const [name,value] of Object.entries(settings.runtimeOptions||{})){
      if(!pluginRuntimeOptions[module.id]?.includes(name)||!['string','number','boolean'].includes(typeof value))add(`/plugins/${module.id}/runtimeOptions/${name}`,'Expected a supported ordinary runtime option with a scalar value');
    }
    for (const key of module.credentials) {
      if (Object.hasOwn(settings, key)) add(`/plugins/${module.id}/${key}`, 'Use the plugin credential action for this field');
    }
    for (const [key, schema] of Object.entries(module.schema.properties)) {
      const value = settings[key], pointer = `/plugins/${module.id}/${key}`;
      const correct = schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'object' ? plain(value) : typeof value === schema.type;
      if (!correct) { add(pointer, `Expected ${schema.type}`); continue; }
      if (schema.enum && !schema.enum.includes(value)) add(pointer, `Choose ${schema.enum.join(', ')}`);
      if (schema.minimum !== undefined && value < schema.minimum) add(pointer, `Minimum is ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) add(pointer, `Maximum is ${schema.maximum}`);
    }
  }
  const inspect = (value, pointer = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) add(`${pointer}/${key}`, 'Unsupported property name');
      inspect(child, `${pointer}/${key}`);
    }
  };
  inspect(document);
  return errors;
}

export class MasterConfigurationError extends Error {
  constructor(code, status, details = []) { super(code); Object.assign(this, { code, status, details }); }
}

// The lock covers the revision check AND rename, including multiple processes.
// A crash leaves a lock for explicit recovery rather than risking concurrent writes.
export function createMasterConfigurationStore(filePath) {
  const target = path.resolve(filePath);
  const read = async () => {
    const document = JSON.parse(await fs.readFile(target, 'utf8'));
    const errors = validateMasterConfiguration(document);
    if (errors.length) throw new MasterConfigurationError('configuration_invalid', 422, errors);
    return { document, revision: configurationRevision(document) };
  };
  const save = async (document, expectedRevision) => {
    const snapshot = copy(document);
    const errors = validateMasterConfiguration(snapshot);
    if (errors.length) throw new MasterConfigurationError('configuration_invalid', 422, errors);
    if (typeof expectedRevision !== 'string') throw new MasterConfigurationError('configuration_revision_required', 428);
    const lockPath = `${target}.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new MasterConfigurationError('configuration_busy', 409); throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const before = await read();
      if (before.revision !== expectedRevision) throw new MasterConfigurationError('configuration_conflict', 409);
      if (before.revision === configurationRevision(snapshot)) return { ...before, changed: false };
      const metadata = await fs.stat(target);
      const mode = metadata.mode & 0o777;
      const output = await fs.open(temporary, 'wx', mode);
      try {
        const created = await output.stat();
        if (created.uid !== metadata.uid || created.gid !== metadata.gid) await output.chown(metadata.uid, metadata.gid);
        await output.chmod(mode); await output.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await output.sync();
      }
      finally { await output.close(); }
      await fs.rename(temporary, target);
      const directory = await fs.open(path.dirname(target), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return { document: snapshot, revision: configurationRevision(snapshot), changed: true };
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await lock.close();
      await fs.unlink(lockPath);
    }
  };
  return { read, save };
}
