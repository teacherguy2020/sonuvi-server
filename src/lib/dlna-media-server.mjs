import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DLNA_DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
export const CONTENT_DIRECTORY_TYPE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
export const CONNECTION_MANAGER_TYPE = 'urn:schemas-upnp-org:service:ConnectionManager:1';

// This is the canonical Sonuvi app mark. It is copied to each immutable
// release's allowlisted public web root, so DLNA controllers can retrieve it
// without an authenticated browser session.
const DLNA_DEVICE_ICON = Object.freeze({
  mimeType: 'image/png',
  width: 192,
  height: 192,
  depth: 32,
  url: '/icons/app-192.png',
});

const MIME_TYPES = Object.freeze({
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
});
const ARTWORK_CACHE_TTL_MS = 5 * 60 * 1000;
const ARTWORK_CACHE_LIMIT = 64;
const MAX_ARTWORK_LOOKUPS_PER_BROWSE = 24;

function xml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function id(prefix, value) { return `${prefix}:${Buffer.from(String(value || ''), 'utf8').toString('base64url')}`; }
function decodeId(raw, prefix) { try { const text = String(raw || ''); return text.startsWith(`${prefix}:`) ? Buffer.from(text.slice(prefix.length + 1), 'base64url').toString('utf8') : ''; } catch { return ''; } }
function mimeFor(file) { return MIME_TYPES[path.extname(String(file || '')).toLowerCase()] || ''; }
function contained(root, candidate) { const relative = path.relative(root, candidate); return Boolean(relative) && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
function duration(seconds) { const value = Number(seconds); if (!Number.isFinite(value) || value < 0) return ''; const h = Math.floor(value / 3600); const m = Math.floor((value % 3600) / 60); const s = Math.floor(value % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }

function privateIpv4(value) { const parts = String(value || '').split('.').map(Number); return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)); }
export function selectLanAddress({ preferred = '', interfaces = os.networkInterfaces() } = {}) { if (privateIpv4(preferred)) return String(preferred); for (const values of Object.values(interfaces || {})) for (const item of values || []) if (item?.family === 'IPv4' && !item.internal && privateIpv4(item.address)) return item.address; return ''; }
export async function persistentUdn(identityPath, fsApi = fs) { try { const existing = JSON.parse(await fsApi.readFile(identityPath, 'utf8')); if (/^uuid:[0-9a-f-]{36}$/i.test(String(existing?.udn || ''))) return existing.udn; } catch {} const udn = `uuid:${crypto.randomUUID()}`; await fsApi.mkdir(path.dirname(identityPath), { recursive: true }); const temporary = `${identityPath}.${process.pid}.${Date.now()}.tmp`; await fsApi.writeFile(temporary, `${JSON.stringify({ contract: 'sonuvi.dlna-identity.v1', udn })}\n`, { mode: 0o600 }); await fsApi.rename(temporary, identityPath); return udn; }

function soapAction(request) { const header = String(request.headers?.soapaction || '').replace(/["']/g, '').trim().split('#').pop(); return header || (String(request.body || '').match(/<u:([A-Za-z0-9_]+)/) || [])[1] || ''; }
function soapArgument(body, name) { const match = String(body || '').match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : ''; }
function envelope(service, action, args = {}) { const fields = Object.entries(args).map(([name, value]) => `<${name}>${xml(value)}</${name}>`).join(''); return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${service}">${fields}</u:${action}Response></s:Body></s:Envelope>`; }
function fault(code, description) { return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${xml(description)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`; }
function didl(items) { const body = items.map((item) => item.kind === 'container' ? `<container id="${xml(item.id)}" parentID="${xml(item.parentId)}" restricted="1" searchable="0"><dc:title>${xml(item.title)}</dc:title><upnp:class>${item.class}</upnp:class></container>` : `<item id="${xml(item.id)}" parentID="${xml(item.parentId)}" restricted="1"><dc:title>${xml(item.title)}</dc:title>${item.artist ? `<upnp:artist>${xml(item.artist)}</upnp:artist>` : ''}${item.album ? `<upnp:album>${xml(item.album)}</upnp:album>` : ''}${item.genre ? `<upnp:genre>${xml(item.genre)}</upnp:genre>` : ''}${item.track ? `<upnp:originalTrackNumber>${item.track}</upnp:originalTrackNumber>` : ''}<upnp:class>object.item.audioItem.musicTrack</upnp:class>${item.artworkUrl ? `<upnp:albumArtURI>${xml(item.artworkUrl)}</upnp:albumArtURI>` : ''}<res protocolInfo="http-get:*:${xml(item.mime)}:*"${item.duration ? ` duration="${item.duration}"` : ''}>${xml(item.url)}</res></item>`).join(''); return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${body}</DIDL-Lite>`; }
function scpd({ actions, variables }) {
  const state = (variable) => `<stateVariable><sendEventsAttribute>${variable.events ? 'yes' : 'no'}</sendEventsAttribute><name>${xml(variable.name)}</name><dataType>${variable.type || 'string'}</dataType>${variable.values?.length ? `<allowedValueList>${variable.values.map((value) => `<allowedValue>${xml(value)}</allowedValue>`).join('')}</allowedValueList>` : ''}</stateVariable>`;
  const action = (item) => `<action><name>${xml(item.name)}</name>${item.arguments?.length ? `<argumentList>${item.arguments.map((argument) => `<argument><name>${xml(argument.name)}</name><direction>${argument.direction}</direction><relatedStateVariable>${xml(argument.state)}</relatedStateVariable></argument>`).join('')}</argumentList>` : ''}</action>`;
  return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions.map(action).join('')}</actionList><serviceStateTable>${variables.map(state).join('')}</serviceStateTable></scpd>`;
}

const CONTENT_DIRECTORY_SCPD = Object.freeze({
  variables: [
    { name: 'SearchCapabilities', events: true }, { name: 'SortCapabilities', events: true }, { name: 'SystemUpdateID', type: 'ui4', events: true },
    { name: 'A_ARG_TYPE_GetSearchCapabilities_SearchCaps' }, { name: 'A_ARG_TYPE_GetSortCapabilities_SortCaps' },
    { name: 'A_ARG_TYPE_Browse_ObjectID' }, { name: 'A_ARG_TYPE_Browse_BrowseFlag', values: ['BrowseMetadata', 'BrowseDirectChildren'] }, { name: 'A_ARG_TYPE_Browse_Filter' }, { name: 'A_ARG_TYPE_Browse_StartingIndex', type: 'ui4' }, { name: 'A_ARG_TYPE_Browse_RequestedCount', type: 'ui4' }, { name: 'A_ARG_TYPE_Browse_SortCriteria' }, { name: 'A_ARG_TYPE_Browse_Result' }, { name: 'A_ARG_TYPE_Browse_NumberReturned', type: 'ui4' }, { name: 'A_ARG_TYPE_Browse_TotalMatches', type: 'ui4' }, { name: 'A_ARG_TYPE_Browse_UpdateID', type: 'ui4' },
  ],
  actions: [
    { name: 'GetSearchCapabilities', arguments: [{ name: 'SearchCaps', direction: 'out', state: 'A_ARG_TYPE_GetSearchCapabilities_SearchCaps' }] },
    { name: 'GetSortCapabilities', arguments: [{ name: 'SortCaps', direction: 'out', state: 'A_ARG_TYPE_GetSortCapabilities_SortCaps' }] },
    { name: 'GetSystemUpdateID', arguments: [{ name: 'Id', direction: 'out', state: 'SystemUpdateID' }] },
    { name: 'Browse', arguments: [{ name: 'ObjectID', direction: 'in', state: 'A_ARG_TYPE_Browse_ObjectID' }, { name: 'BrowseFlag', direction: 'in', state: 'A_ARG_TYPE_Browse_BrowseFlag' }, { name: 'Filter', direction: 'in', state: 'A_ARG_TYPE_Browse_Filter' }, { name: 'StartingIndex', direction: 'in', state: 'A_ARG_TYPE_Browse_StartingIndex' }, { name: 'RequestedCount', direction: 'in', state: 'A_ARG_TYPE_Browse_RequestedCount' }, { name: 'SortCriteria', direction: 'in', state: 'A_ARG_TYPE_Browse_SortCriteria' }, { name: 'Result', direction: 'out', state: 'A_ARG_TYPE_Browse_Result' }, { name: 'NumberReturned', direction: 'out', state: 'A_ARG_TYPE_Browse_NumberReturned' }, { name: 'TotalMatches', direction: 'out', state: 'A_ARG_TYPE_Browse_TotalMatches' }, { name: 'UpdateID', direction: 'out', state: 'A_ARG_TYPE_Browse_UpdateID' }] },
  ],
});

const CONNECTION_MANAGER_SCPD = Object.freeze({
  variables: [
    { name: 'SourceProtocolInfo', events: true }, { name: 'SinkProtocolInfo', events: true }, { name: 'CurrentConnectionIDs', events: true },
    { name: 'A_ARG_TYPE_ConnectionStatus', values: ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown'] }, { name: 'A_ARG_TYPE_ConnectionManager' }, { name: 'A_ARG_TYPE_Direction', values: ['Input', 'Output'] }, { name: 'A_ARG_TYPE_ProtocolInfo' }, { name: 'A_ARG_TYPE_ConnectionID', type: 'i4' }, { name: 'A_ARG_TYPE_AVTransportID', type: 'i4' }, { name: 'A_ARG_TYPE_RcsID', type: 'i4' },
  ],
  actions: [
    { name: 'GetProtocolInfo', arguments: [{ name: 'Source', direction: 'out', state: 'SourceProtocolInfo' }, { name: 'Sink', direction: 'out', state: 'SinkProtocolInfo' }] },
    { name: 'GetCurrentConnectionIDs', arguments: [{ name: 'ConnectionIDs', direction: 'out', state: 'CurrentConnectionIDs' }] },
    { name: 'GetCurrentConnectionInfo', arguments: [{ name: 'ConnectionID', direction: 'in', state: 'A_ARG_TYPE_ConnectionID' }, { name: 'RcsID', direction: 'out', state: 'A_ARG_TYPE_RcsID' }, { name: 'AVTransportID', direction: 'out', state: 'A_ARG_TYPE_AVTransportID' }, { name: 'ProtocolInfo', direction: 'out', state: 'A_ARG_TYPE_ProtocolInfo' }, { name: 'PeerConnectionManager', direction: 'out', state: 'A_ARG_TYPE_ConnectionManager' }, { name: 'PeerConnectionID', direction: 'out', state: 'A_ARG_TYPE_ConnectionID' }, { name: 'Direction', direction: 'out', state: 'A_ARG_TYPE_Direction' }, { name: 'Status', direction: 'out', state: 'A_ARG_TYPE_ConnectionStatus' }] },
  ],
});

export function createDlnaMediaServer({ getBrowseIndex, resolveFile, readArtworkForTrack, mountRoot, identityPath, localAddress = '', port = 3101, enabled = false, log = console, fsApi = fs } = {}) {
  const root = path.resolve(String(mountRoot || '/mnt/SamsungMoode')); const lanAddress = selectLanAddress({ preferred: localAddress }); const baseUrl = lanAddress ? `http://${lanAddress}:${Number(port) || 3101}` : ''; let udn = ''; let socket = null;
  const artworkReader = typeof readArtworkForTrack === 'function' ? readArtworkForTrack : null;
  const artworkCache = new Map();
  const catalog = async () => { const index = await getBrowseIndex(); return { index, tracks: Array.isArray(index?.tracks) ? index.tracks : [], albums: Array.isArray(index?.albums) ? index.albums : [], artists: Array.isArray(index?.artists) ? index.artists : [] }; };
  const trackItem = (track) => { const trackId = id('track', track.file); return { kind: 'item', id: trackId, parentId: id('album', track.albumKey), title: track.title || path.basename(track.file || ''), artist: track.artist || track.albumArtist || '', album: track.album || '', genre: track.genre || '', track: Number(track.track) || 0, duration: duration(track.duration), mime: mimeFor(track.file), url: `${baseUrl}/dlna/media/${encodeURIComponent(trackId)}`, artworkKey: String(track.albumKey || track.file || ''), artworkFile: String(track.file || '') }; };
  const activeArtworkEntry = (key) => {
    const entry = artworkCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { artworkCache.delete(key); return null; }
    artworkCache.delete(key);
    artworkCache.set(key, entry);
    return entry;
  };
  const resolveArtwork = async (item) => {
    if (!baseUrl || !artworkReader || !item?.artworkKey || !item?.artworkFile) return null;
    const key = item.artworkKey;
    const cached = activeArtworkEntry(key);
    if (cached) return cached.promise;
    const entry = { expiresAt: Date.now() + ARTWORK_CACHE_TTL_MS, promise: null };
    entry.promise = Promise.resolve(artworkReader(item.artworkFile)).then((artwork) => {
      if (!artwork?.body || !Buffer.isBuffer(artwork.body) || !artwork.body.length || !/^image\/[a-z0-9.+-]+$/i.test(String(artwork.contentType || ''))) return null;
      return Object.freeze({ body: artwork.body, contentType: String(artwork.contentType) });
    }).catch(() => null);
    artworkCache.set(key, entry);
    while (artworkCache.size > ARTWORK_CACHE_LIMIT) artworkCache.delete(artworkCache.keys().next().value);
    return entry.promise;
  };
  const decorateArtwork = async (items) => {
    if (!artworkReader) return items;
    const grouped = new Map();
    for (const item of items) {
      if (item?.kind !== 'item' || !item.artworkKey || !item.artworkFile) continue;
      if (!grouped.has(item.artworkKey)) grouped.set(item.artworkKey, item);
    }
    let freshLookups = 0;
    const resolved = new Map(await Promise.all([...grouped.entries()].map(async ([key, item]) => {
      const cached = activeArtworkEntry(key);
      if (!cached && freshLookups >= MAX_ARTWORK_LOOKUPS_PER_BROWSE) return [key, null];
      if (!cached) freshLookups += 1;
      return [key, await resolveArtwork(item)];
    })));
    return items.map((item) => resolved.get(item?.artworkKey)
      ? { ...item, artworkUrl: `${baseUrl}/dlna/artwork/${encodeURIComponent(item.id)}` }
      : item);
  };
  async function children(objectId) { const data = await catalog(); if (objectId === '0') return [{ kind: 'container', id: 'artists', parentId: '0', title: 'Artists', class: 'object.container.person.musicArtist' }, { kind: 'container', id: 'albums', parentId: '0', title: 'Albums', class: 'object.container.album.musicAlbum' }, { kind: 'container', id: 'genres', parentId: '0', title: 'Genres', class: 'object.container.genre.musicGenre' }]; if (objectId === 'artists') return data.artists.map((artist) => ({ kind: 'container', id: id('artist', artist.name || artist.key), parentId: 'artists', title: artist.name || artist.key, class: 'object.container.person.musicArtist' })); if (objectId === 'albums') return data.albums.map((album) => ({ kind: 'container', id: id('album', album.key), parentId: 'albums', title: album.title || album.album || album.key, class: 'object.container.album.musicAlbum' })); if (objectId === 'genres') return [...new Set(data.tracks.map((track) => String(track.genre || '').trim()).filter(Boolean))].sort().map((name) => ({ kind: 'container', id: id('genre', name), parentId: 'genres', title: name, class: 'object.container.genre.musicGenre' })); const artist = decodeId(objectId, 'artist'); if (artist) return data.albums.filter((album) => String(album.artist || album.albumArtist || '') === artist || String(album.artistKey || '') === artist).map((album) => ({ kind: 'container', id: id('album', album.key), parentId: objectId, title: album.title || album.album || album.key, class: 'object.container.album.musicAlbum' })); const albumKey = decodeId(objectId, 'album'); if (albumKey) return data.tracks.filter((track) => String(track.albumKey || '') === albumKey).map(trackItem); const genre = decodeId(objectId, 'genre'); return genre ? data.tracks.filter((track) => String(track.genre || '') === genre).map(trackItem) : []; }
  async function metadata(objectId) { if (objectId === '0') return { kind: 'container', id: '0', parentId: '-1', title: 'Sonuvi Music Library', class: 'object.container' }; const file = decodeId(objectId, 'track'); if (file) { const data = await catalog(); const track = data.tracks.find((item) => item.file === file); return track ? trackItem(track) : null; } const roots = await children('0'); const rootItem = roots.find((item) => item.id === objectId); if (rootItem) return rootItem; const prefix = objectId.split(':')[0]; const value = decodeId(objectId, prefix); if (!value) return null; return { kind: 'container', id: objectId, parentId: prefix === 'album' ? 'albums' : `${prefix}s`, title: value, class: prefix === 'artist' ? 'object.container.person.musicArtist' : prefix === 'genre' ? 'object.container.genre.musicGenre' : 'object.container.album.musicAlbum' }; }
function register(app, express) { if (!enabled) return; const observeSoap = (service) => (req, res, next) => { res.once('finish', () => log.info?.('[dlna] SOAP', { service, action: soapAction(req) || 'Unknown', status: res.statusCode })); next(); }; app.get('/dlna/device.xml', (_req, res) => res.type('application/xml').send(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>${DLNA_DEVICE_TYPE}</deviceType><friendlyName>Sonuvi Music Library</friendlyName><manufacturer>Sonuvi</manufacturer><modelName>Sonuvi Server</modelName><iconList><icon><mimetype>${DLNA_DEVICE_ICON.mimeType}</mimetype><width>${DLNA_DEVICE_ICON.width}</width><height>${DLNA_DEVICE_ICON.height}</height><depth>${DLNA_DEVICE_ICON.depth}</depth><url>${DLNA_DEVICE_ICON.url}</url></icon></iconList><UDN>${udn}</UDN><serviceList><service><serviceType>${CONTENT_DIRECTORY_TYPE}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/dlna/content-directory.xml</SCPDURL><controlURL>/dlna/content-directory/control</controlURL><eventSubURL></eventSubURL></service><service><serviceType>${CONNECTION_MANAGER_TYPE}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/dlna/connection-manager.xml</SCPDURL><controlURL>/dlna/connection-manager/control</controlURL><eventSubURL></eventSubURL></service></serviceList></device></root>`)); app.get('/dlna/content-directory.xml', (_req, res) => res.type('application/xml').send(scpd(CONTENT_DIRECTORY_SCPD))); app.get('/dlna/connection-manager.xml', (_req, res) => res.type('application/xml').send(scpd(CONNECTION_MANAGER_SCPD))); app.post('/dlna/content-directory/control', observeSoap('ContentDirectory'), express.text({ type: ['text/xml', 'application/soap+xml'], limit: '1mb' }), async (req, res) => { const action = soapAction(req); try { if (action === 'Browse') { const objectId = soapArgument(req.body, 'ObjectID') || '0'; const flag = soapArgument(req.body, 'BrowseFlag'); const all = flag === 'BrowseMetadata' ? [await metadata(objectId)].filter(Boolean) : await children(objectId); const start = Math.max(0, Number(soapArgument(req.body, 'StartingIndex')) || 0); const requested = Math.max(0, Number(soapArgument(req.body, 'RequestedCount')) || 0); const selected = all.slice(start, requested ? start + requested : undefined); return res.type('text/xml').send(envelope(CONTENT_DIRECTORY_TYPE, 'Browse', { Result: didl(selected), NumberReturned: selected.length, TotalMatches: all.length, UpdateID: Date.parse((await catalog()).index?.builtAt || '') || 0 })); } if (action === 'GetSearchCapabilities') return res.type('text/xml').send(envelope(CONTENT_DIRECTORY_TYPE, action, { SearchCaps: '' })); if (action === 'GetSortCapabilities') return res.type('text/xml').send(envelope(CONTENT_DIRECTORY_TYPE, action, { SortCaps: '' })); if (action === 'GetSystemUpdateID') return res.type('text/xml').send(envelope(CONTENT_DIRECTORY_TYPE, action, { Id: Date.now() })); return res.status(500).type('text/xml').send(fault(401, 'Invalid Action')); } catch (error) { log.warn?.('[dlna] content browse failed', error?.message || error); return res.status(500).type('text/xml').send(fault(501, 'Action Failed')); } }); app.post('/dlna/connection-manager/control', observeSoap('ConnectionManager'), express.text({ type: ['text/xml', 'application/soap+xml'], limit: '1mb' }), (req, res) => { const action = soapAction(req); const source = Object.values(MIME_TYPES).map((mime) => `http-get:*:${mime}:*`).join(','); if (action === 'GetProtocolInfo') return res.type('text/xml').send(envelope(CONNECTION_MANAGER_TYPE, action, { Source: source, Sink: '' })); if (action === 'GetCurrentConnectionIDs') return res.type('text/xml').send(envelope(CONNECTION_MANAGER_TYPE, action, { ConnectionIDs: '0' })); if (action === 'GetCurrentConnectionInfo') { if (soapArgument(req.body, 'ConnectionID') !== '0') return res.status(500).type('text/xml').send(fault(706, 'No Such Connection')); return res.type('text/xml').send(envelope(CONNECTION_MANAGER_TYPE, action, { RcsID: '-1', AVTransportID: '-1', ProtocolInfo: source, PeerConnectionManager: '', PeerConnectionID: '-1', Direction: 'Output', Status: 'OK' })); } return res.status(500).type('text/xml').send(fault(401, 'Invalid Action')); }); app.all('/dlna/media/:trackId', async (req, res) => { const file = decodeId(req.params.trackId, 'track'); const data = await catalog(); if (!file || !data.tracks.some((track) => track.file === file)) return res.sendStatus(404); const local = String(await resolveFile(file) || ''); if (!local || !contained(root, path.resolve(local)) || !mimeFor(file)) return res.sendStatus(404); let stat; try { stat = await fsApi.stat(local); } catch { return res.sendStatus(404); } if (!stat.isFile()) return res.sendStatus(404); let start = 0; let end = stat.size - 1; let status = 200; const range = String(req.headers.range || ''); if (range) { const match = range.match(/^bytes=(\d*)-(\d*)$/); if (!match) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end(); start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0)); end = match[2] ? Number(match[2]) : end; if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= stat.size) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end(); end = Math.min(end, stat.size - 1); status = 206; } res.status(status).set({ 'Content-Type': mimeFor(file), 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) }); if (req.method === 'HEAD') return res.end(); createReadStream(local, { start, end }).on('error', () => { if (!res.headersSent) res.sendStatus(500); else res.destroy(); }).pipe(res); }); }
  // The legacy compact control registration below remains responsible for the
  // advertised services. Register this asynchronous Browse handler first so
  // track metadata can await bounded artwork resolution without affecting the
  // existing actions.
  function registerWithArtwork(app, express) {
    if (!enabled) return;
    app.post(
      '/dlna/content-directory/control',
      express.text({ type: ['text/xml', 'application/soap+xml'], limit: '1mb' }),
      async (req, res, next) => {
        if (soapAction(req) !== 'Browse') return next();
        try {
          const objectId = soapArgument(req.body, 'ObjectID') || '0';
          const flag = soapArgument(req.body, 'BrowseFlag');
          const all = flag === 'BrowseMetadata'
            ? [await metadata(objectId)].filter(Boolean)
            : await children(objectId);
          const start = Math.max(0, Number(soapArgument(req.body, 'StartingIndex')) || 0);
          const requested = Math.max(0, Number(soapArgument(req.body, 'RequestedCount')) || 0);
          const selected = all.slice(start, requested ? start + requested : undefined);
          const decorated = await decorateArtwork(selected);
          log.info?.('[dlna] SOAP', { service: 'ContentDirectory', action: 'Browse', status: 200 });
          return res.type('text/xml').send(envelope(CONTENT_DIRECTORY_TYPE, 'Browse', {
            Result: didl(decorated),
            NumberReturned: decorated.length,
            TotalMatches: all.length,
            UpdateID: Date.parse((await catalog()).index?.builtAt || '') || 0,
          }));
        } catch (error) {
          log.warn?.('[dlna] content browse failed', error?.message || error);
          return res.status(500).type('text/xml').send(fault(501, 'Action Failed'));
        }
      },
    );
    app.all('/dlna/artwork/:trackId', async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD').end();
      const file = decodeId(req.params.trackId, 'track');
      const data = await catalog();
      const track = file ? data.tracks.find((item) => item.file === file) : null;
      if (!track) return res.sendStatus(404);
      const artwork = await resolveArtwork(trackItem(track));
      if (!artwork) return res.sendStatus(404);
      res.status(200).set({
        'Content-Type': artwork.contentType,
        'Content-Length': String(artwork.body.length),
        'Cache-Control': 'public, max-age=300',
      });
      return req.method === 'HEAD' ? res.end() : res.send(artwork.body);
    });
    register(app, express);
  }
  async function initialize() { if (!udn) udn = await persistentUdn(identityPath, fsApi); return udn; }
  async function capabilities() {
    const identity = await initialize();
    return Object.freeze({
      supported: true,
      enabled,
      udn: identity,
      deviceType: DLNA_DEVICE_TYPE,
      friendlyName: 'Sonuvi Music Library',
      deviceDescriptionUrl: baseUrl ? `${baseUrl}/dlna/device.xml` : null,
      mediaBaseUrl: baseUrl ? `${baseUrl}/dlna/media` : null,
    });
  }
  async function resourceForFile(file) {
    if (!enabled) return null;
    await initialize();
    const data = await catalog();
    const track = data.tracks.find((item) => item.file === file);
    if (!track || !mimeFor(track.file)) return null;
    const local = String(await resolveFile(track.file) || '');
    if (!local || !contained(root, path.resolve(local))) return null;
    try { if (!(await fsApi.stat(local)).isFile()) return null; } catch { return null; }
    const [item] = await decorateArtwork([trackItem(track)]);
    return Object.freeze({
      objectId: item.id,
      mediaUrl: item.url,
      mimeType: item.mime,
      protocolInfo: `http-get:*:${item.mime}:*`,
      didlLite: didl([item]),
    });
  }
  async function start() { if (!enabled || !baseUrl) return false; await initialize(); socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); socket.on('message', (message, remote) => { const request = message.toString('utf8'); if (!/^M-SEARCH \*/i.test(request) || !/MAN:\s*"ssdp:discover"/i.test(request)) return; const target = (request.match(/ST:\s*([^\r\n]+)/i) || [])[1]?.trim() || ''; if (!['ssdp:all', 'upnp:rootdevice', DLNA_DEVICE_TYPE, CONTENT_DIRECTORY_TYPE, CONNECTION_MANAGER_TYPE].includes(target)) return; socket.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${baseUrl}/dlna/device.xml\r\nSERVER: Sonuvi/1.0 UPnP/1.1 SonuviMediaServer/1.0\r\nST: ${target}\r\nUSN: ${udn}::${target}\r\n\r\n`, remote.port, remote.address); }); await new Promise((resolve) => socket.bind(1900, resolve)); socket.send(`NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${baseUrl}/dlna/device.xml\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\nUSN: ${udn}::upnp:rootdevice\r\n\r\n`, 1900, '239.255.255.250'); return true; }
  return Object.freeze({ enabled, baseUrl, get udn() { return udn; }, register: registerWithArtwork, initialize, capabilities, resourceForFile, start, stop: () => { try { socket?.close(); } catch {} socket = null; }, children, metadata });
}
