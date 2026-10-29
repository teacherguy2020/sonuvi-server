import { readMoodeRadioCatalog } from '../lib/moode-radio-catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { getBrowseIndex } from '../lib/browse-index.mjs';
import { radioDisplayName } from '../lib/radio-display.mjs';
import { isMoodeTransportError, moodeDirectTransportCommand } from '../lib/moode-transport.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { runtimeCapabilities } from '../lib/runtime-capabilities.mjs';

const nativeExecFileP = promisify(execFile);
const execFileP = (...args) => {
  const command = path.basename(String(args[0] || 'external-command'));
  runtimeCapabilities().assertExternalMutation(`process.${command}`);
  return nativeExecFileP(...args);
};
function fetch(input, init = {}) {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    runtimeCapabilities().assertExternalRead('network.fetch');
  } else {
    runtimeCapabilities().assertExternalMutation('network.fetch');
  }
  return globalThis.fetch(input, init);
}

// One-level, guarded undo for the Live Queue's physical shuffle. The snapshot
// is intentionally process-local: undo is a convenience action, not a second
// queue store, and it must never restore over intervening queue mutations.
let liveQueueShuffleUndo = null;

function queueFingerprint(files = []) {
  return JSON.stringify(Array.isArray(files) ? files.map((f) => String(f || '')) : []);
}

function parseMpdHeadPosition(statusText = '') {
  const m = String(statusText || '').match(/#(\d+)\/\d+/);
  const n = m ? Number(m[1] || 0) : 0;
  return Number.isFinite(n) && n > 0 ? n - 1 : -1;
}

async function readMpdQueueFiles(mpdHost) {
  const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'playlist']);
  return String(stdout || '').split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean);
}

async function moveMpdQueueToOrder(mpdHost, currentFiles, targetFiles) {
  const working = [...currentFiles];
  for (let targetIndex = 0; targetIndex < targetFiles.length; targetIndex += 1) {
    if (working[targetIndex] === targetFiles[targetIndex]) continue;
    let sourceIndex = targetIndex + 1;
    while (sourceIndex < working.length && working[sourceIndex] !== targetFiles[targetIndex]) sourceIndex += 1;
    if (sourceIndex >= working.length) throw new Error('Queue changed while applying shuffle order');
    await execFileP('mpc', ['-h', mpdHost, 'move', String(sourceIndex), String(targetIndex)]);
    const [moved] = working.splice(sourceIndex, 1);
    working.splice(targetIndex, 0, moved);
  }
  return working;
}

function shuffleArray(input = []) {
  const output = [...input];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

function reconcileShuffleUndo(currentFiles = []) {
  if (!liveQueueShuffleUndo) return false;
  const current = Array.isArray(currentFiles) ? currentFiles.map((f) => String(f || '')) : [];
  const shuffled = liveQueueShuffleUndo.shuffledFiles.map((f) => String(f || ''));
  const original = liveQueueShuffleUndo.originalFiles.map((f) => String(f || ''));
  const keptIndices = [];
  let cursor = 0;
  for (const file of current) {
    while (cursor < shuffled.length && shuffled[cursor] !== file) cursor += 1;
    if (cursor >= shuffled.length) {
      liveQueueShuffleUndo = null;
      return false;
    }
    keptIndices.push(cursor);
    cursor += 1;
  }
  // Deletions are safe to absorb: retain the surviving entries in their
  // shuffled order and remove the same entries from the undo target. A reorder
  // cannot match this subsequence and therefore intentionally invalidates Undo.
  if (keptIndices.length !== shuffled.length) {
    liveQueueShuffleUndo.shuffledFiles = keptIndices.map((i) => shuffled[i]);
    liveQueueShuffleUndo.originalFiles = keptIndices.map((i) => original[i]);
  }
  return true;
}

export async function enrichQueueSourceAudio(items, getSourceAudio) {
  const rows = Array.isArray(items) ? items : [];
  if (typeof getSourceAudio !== 'function') return rows;
  return Promise.all(rows.map(async (item) => {
    const file = String(item?.file || '').trim();
    if (!item || item.isStream || item.sourceAudio || !file) return item;
    try {
      const sourceAudio = await getSourceAudio(file);
      if (!sourceAudio
        || typeof sourceAudio !== 'object'
        || Array.isArray(sourceAudio)
        || Object.keys(sourceAudio).length === 0) return item;
      return { ...item, sourceAudio };
    } catch {
      return item;
    }
  }));
}

function cleanIheartQueueMeta(artistRaw, titleRaw) {
  const artist = String(artistRaw || '').trim();
  const title = String(titleRaw || '').trim();
  const combined = `${artist} ${title}`.trim();
  if (!combined) return { artist, title, artUrl: '' };

  const blobSource = [artist, title].find((s) => /\bTPID="\d+"/i.test(String(s || '')) || /\btitle="[^"]+"/i.test(String(s || '')) || /\btext="[^"]+"/i.test(String(s || ''))) || '';
  if (!blobSource) return { artist, title, artUrl: '' };

  const s = String(blobSource || '').trim();
  const t1 = s.match(/(?:^|[\s,])text\s*=\s*"([^"]+)"/i);
  const t2 = s.match(/(?:^|[\s,])title\s*=\s*"([^"]+)"/i);
  const a1 = s.match(/(?:^|[\s,])artist\s*=\s*"([^"]+)"/i);
  const p1 = s.match(/^(.*?)\s*-\s*text\s*=\s*"/i);
  const art1 = s.match(/\bamgArtworkURL\s*=\s*"([^"]+)"/i);

  const cleanArtist = String((a1 && a1[1]) || (p1 && p1[1]) || '').trim() || artist;
  const cleanTitle = String((t1 && t1[1]) || (t2 && t2[1]) || '').trim() || title;
  const artUrl = String((art1 && art1[1]) || '').trim();

  return { artist: cleanArtist, title: cleanTitle, artUrl };
}

function isStreamUrl(file) {
  return /:\/\//.test(String(file || ''));
}

function stationLogoUrlFromAlbum(album) {
  const a = String(album || '').trim();
  if (!a) return '';
  return `/art/radio-logo.jpg?name=${encodeURIComponent(a)}`;
}

function safeLogoKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
}

async function readCachedRadioLogo(name) {
  const k = safeLogoKey(name);
  if (!k) return null;
  const p = path.join(runtimeStatePaths().radioLogoCacheDir, `${k}.jpg`);
  try {
    const buf = await fs.readFile(p);
    return buf;
  } catch {
    return null;
  }
}

async function writeCachedRadioLogo(name, buf) {
  const k = safeLogoKey(name);
  if (!k || !buf) return;
  const p = path.join(runtimeStatePaths().radioLogoCacheDir, `${k}.jpg`);
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
  } catch {}
}

function stationKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const hostPort = `${u.hostname}${u.port ? `:${u.port}` : ''}`;
    return `${hostPort}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return s.replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

let radioCatalogCacheTs = 0;
let radioMetaByStation = new Map();

async function loadRadioQueueMap() {
  try {
    const p = runtimeStatePaths().radioQueueMapPath;
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw || '{}');
    const map = new Map();
    for (const e of (Array.isArray(j.entries) ? j.entries : [])) {
      const f = String(e?.file || '').trim();
      const stationName = String(e?.stationName || '').trim();
      const genre = String(e?.genre || '').trim();
      if (!f) continue;
      const meta = { stationName, genre };
      map.set(f, meta);
      const k = stationKey(f);
      const h = stationHost(f);
      if (k) map.set(`key:${k}`, meta);
      if (h) map.set(`host:${h}`, meta);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function loadRadioLogoAliases() {
  try {
    const p = new URL('../../config/radio-logo-aliases.json', import.meta.url);
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw || '{}');
    return (j && typeof j === 'object') ? j : {};
  } catch {
    return {};
  }
}

function stationHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { return String(new URL(s).hostname || '').toLowerCase(); } catch { return ''; }
}

async function loadRadioCatalogMap() {
  const now = Date.now();
  if (radioMetaByStation.size && (now - radioCatalogCacheTs) < (5 * 60 * 1000)) return radioMetaByStation;
  const catalog = await readMoodeRadioCatalog();
  const map = new Map();
  const hostCounts = new Map();
  const hostName = new Map();
  for (const { station, name, genre, type } of catalog) {
    const s = String(station || '').trim();
    const n = String(name || '').trim();
    const g = String(genre || '').trim();
    const t = String(type || '').trim().toLowerCase();
    if (s && n) {
      const meta = { stationName: n, genre: g, isFavorite: t === 'f' };
      map.set(s, meta);
      const k = stationKey(s);
      if (k) map.set(k, meta);
      const h = stationHost(s);
      if (h) {
        hostCounts.set(h, Number(hostCounts.get(h) || 0) + 1);
        if (!hostName.has(h)) hostName.set(h, meta);
      }
    }
  }
  for (const [h, c] of hostCounts.entries()) {
    if (c === 1) map.set(`host:${h}`, hostName.get(h) || { stationName: '', genre: '', isFavorite: false });
  }
  radioMetaByStation = map;
  radioCatalogCacheTs = now;
  return radioMetaByStation;
}

function splitArtistDashTitle(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const m = s.match(/^(.+?)\s+[\-–—]\s+(.+)$/);
  if (!m) return null;
  return { artist: String(m[1] || '').trim(), title: String(m[2] || '').trim() };
}

export function registerConfigDiagnosticsRoutes(app, deps) {
  const {
    requireTrackKey,
    getRatingForFile,
    setRatingForFile,
    getAlexaWasPlaying,
    clearAlexaWasPlayingState,
    setAlexaModeState,
    getYoutubeNowPlayingHint,
    getYoutubeQueueHint,
    getSourceAudio,
    getQobuzNowPlaying,
    runMpc,
  } = deps;
  const configPath = runtimeStatePaths().configPath;
  const immutableRuntime = () => runtimeStatePaths().sharedStateEnabled;
  const executeMpc = typeof runMpc === 'function'
    ? runMpc
    : (args, options) => execFileP('mpc', args, options);

  function pos0FromAlexaToken(tokenRaw) {
    const s = String(tokenRaw || '').trim();
    if (!s || !s.startsWith('moode-track:')) return null;
    try {
      const b64 = s.slice('moode-track:'.length);
      const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
      const json = Buffer.from((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const obj = JSON.parse(json || '{}');
      const n = Number(obj?.pos0);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    } catch {
      return null;
    }
  }

  async function isRatingsEnabled() {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      return Boolean(cfg?.features?.ratings ?? true);
    } catch {
      return true;
    }
  }

  async function getAlexaRouteWebhookUrl() {
    const protectedValue = String(process.env.ALEXA_ROUTE_WEBHOOK_URL || '').trim();
    if (protectedValue) return protectedValue;
    if (immutableRuntime()) return '';
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      return String(cfg?.alexa?.routeWebhookUrl || '').trim();
    } catch {
      return '';
    }
  }

  async function getAlexaStopWebhookUrl() {
    const protectedValue = String(process.env.ALEXA_STOP_WEBHOOK_URL || '').trim();
    if (protectedValue) return protectedValue;
    if (immutableRuntime()) return '';
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      return String(cfg?.alexa?.stopWebhookUrl || '').trim();
    } catch {
      return '';
    }
  }

  async function getAlexaControlWebhookUrl(control) {
    try {
      const name = String(control || '').trim().toLowerCase();
      const envName = `ALEXA_${name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_WEBHOOK_URL`;
      const protectedValue = String(process.env[envName] || '').trim();
      if (protectedValue) return protectedValue;

      const route = await getAlexaRouteWebhookUrl();
      if (immutableRuntime()) {
        if (!route) return '';
        const parsed = new URL(route);
        if (/\/alexa-start\/?$/i.test(parsed.pathname)) {
          parsed.pathname = parsed.pathname.replace(/alexa-start\/?$/i, `alexa-${name}`);
          return parsed.toString();
        }
        return '';
      }

      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const explicit = String(cfg?.alexa?.[`${name}WebhookUrl`] || '').trim();
      if (explicit) return explicit;

      // Derive the sibling Homebridge action from the configured start URL.
      // This keeps the new controls aligned with the existing Homebridge host
      // and port without adding another required config field.
      const configuredRoute = String(cfg?.alexa?.routeWebhookUrl || '').trim();
      if (!configuredRoute) return '';
      const parsed = new URL(configuredRoute);
      if (/\/alexa-start\/?$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/alexa-start\/?$/i, `alexa-${name}`);
        return parsed.toString();
      }
      return '';
    } catch {
      return '';
    }
  }

  const endpointCatalog = [
    { group: 'Integrations', method: 'POST', path: '/integrations/alexa/state', body: { state: 'on|off' } },
    { group: 'Integrations', method: 'POST', path: '/alexa/natural-finish' },
    { group: 'Now Playing', method: 'GET', path: '/now-playing' },
    { group: 'Now Playing', method: 'GET', path: '/next-up' },
    { group: 'Now Playing', method: 'GET', path: '/track' },

    { group: 'Diagnostics', method: 'GET', path: '/config/diagnostics/queue' },
    { group: 'Diagnostics', method: 'POST', path: '/config/diagnostics/queue/save-playlist', body: { playlistName: 'My Queue', generateCollage: true } },
    { group: 'Diagnostics', method: 'GET', path: '/config/diagnostics/album-tracks', query: { album: '', artist: '' } },
    { group: 'Diagnostics', method: 'GET', path: '/config/diagnostics/artist-albums', query: { artist: '' } },
    { group: 'Diagnostics', method: 'POST', path: '/config/diagnostics/playback', body: { action: 'play' } },

    { group: 'Runtime/Admin', method: 'GET', path: '/config/runtime' },
    { group: 'Runtime/Admin', method: 'POST', path: '/config/runtime/check-env', body: { mpdHost: '', mpdPort: 6600, sshHost: '', sshUser: 'moode', paths: {} } },
    { group: 'Runtime/Admin', method: 'POST', path: '/config/runtime/resolve-host', body: { host: '' } },
    { group: 'Runtime/Admin', method: 'POST', path: '/config/restart-api', body: {} },
    { group: 'Runtime/Admin', method: 'POST', path: '/config/restart-services', body: {} },
    { group: 'Runtime/Admin', method: 'GET', path: '/config/services/mpdscribble/status' },
    { group: 'Runtime/Admin', method: 'POST', path: '/config/services/mpdscribble/action', body: { action: 'restart' } },

    { group: 'Last.fm', method: 'GET', path: '/config/lastfm/top-tracks', query: { period: '1month', limit: 18 } },
    { group: 'Last.fm', method: 'GET', path: '/config/lastfm/recent-tracks', query: { limit: 18 } },
    { group: 'Last.fm', method: 'GET', path: '/config/lastfm/top-artists', query: { period: '1month', limit: 18 } },
    { group: 'Last.fm', method: 'GET', path: '/config/lastfm/top-albums', query: { period: '1month', limit: 18 } },

    { group: 'Queue Wizard', method: 'GET', path: '/config/queue-wizard/options' },
    { group: 'Queue Wizard', method: 'GET', path: '/config/queue-wizard/playlists' },
    { group: 'Browse', method: 'GET', path: '/config/browse/stats' },
    { group: 'Browse', method: 'GET', path: '/config/browse/artists', query: { q: '', limit: 50 } },
    { group: 'Browse', method: 'GET', path: '/config/browse/albums', query: { artist: '', q: '', limit: 100 } },
    { group: 'Browse', method: 'GET', path: '/config/browse/artist-albums', query: { artist: '' } },
    { group: 'Browse', method: 'GET', path: '/config/browse/album-tracks', query: { album: '', artist: '' } },
    { group: 'Browse', method: 'POST', path: '/config/browse/rebuild', body: { force: true } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/queue-wizard/preview', body: { genres: [], artists: [], albums: [], excludeGenres: [], minRating: 0, maxTracks: 25 } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/queue-wizard/apply', body: { mode: 'append', keepNowPlaying: false, tracks: [''], shuffle: false } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/queue-wizard/add-to-playlist', body: { playlistName: 'My Playlist', tracks: [''] } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/queue-wizard/vibe-start', body: { targetQueue: 50, minRating: 0 } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/queue-wizard/vibe-seed-start', body: { seedArtist: 'John Mayer', seedTitle: 'Gravity', targetQueue: 12 } },
    { group: 'Queue Wizard', method: 'GET', path: '/config/queue-wizard/radio-options' },
    { group: 'Queue Wizard', method: 'GET', path: '/config/queue-wizard/radio-favorites' },
    { group: 'Queue Wizard', method: 'GET', path: '/config/radio-browser/search', query: { q: 'jazz', limit: 25 } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/radio-browser/preview', body: { url: '' } },
    { group: 'Queue Wizard', method: 'POST', path: '/config/radio-browser/add', body: { station: '', name: '', genre: '' } },

    { group: 'Library Health', method: 'GET', path: '/config/library-health' },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/missing-artwork' },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/album-tracks' },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/album-artist-cleanup', body: { folder: '' } },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/album-genre' },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/album-art-search', query: { folder: '' } },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/album-art-fetch', query: { url: '' } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/album-genre', body: { folder: '', genre: '' } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/rating-batch', body: { files: [], rating: 3 } },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/animated-art/discovery', query: { page: 1, pageSize: 25 } },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/animated-art/lookup', query: { album: '', artist: '' } },
    { group: 'Library Health', method: 'GET', path: '/config/library-health/animated-art/job', query: { id: '' } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/animated-art/discover', body: { force: false } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/animated-art/build', body: { album: '', artist: '', sourceUrl: '' } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/animated-art/suppress', body: { album: '', artist: '', suppressed: true } },
    { group: 'Library Health', method: 'POST', path: '/config/library-health/animated-art/clear', body: { album: '', artist: '' } },

    { group: 'Moode/Peppy', method: 'GET', path: '/config/moode/display/status' },
    { group: 'Moode/Peppy', method: 'POST', path: '/config/moode/display', body: { mode: 'on' } },
    { group: 'Moode/Peppy', method: 'GET', path: '/config/moode/browser-url/status' },
    { group: 'Moode/Peppy', method: 'POST', path: '/config/moode/browser-url', body: { url: 'http://sonuvi.local:8101/display.html' } },
    { group: 'Moode/Peppy', method: 'GET', path: '/peppy/last-profile' },
    { group: 'Moode/Peppy', method: 'POST', path: '/peppy/last-profile', body: { displayMode: 'peppy' } },

    { group: 'Ratings Stickers', method: 'GET', path: '/config/ratings/sticker-status' },
    { group: 'Ratings Stickers', method: 'GET', path: '/config/ratings/sticker-backups' },
    { group: 'Ratings Stickers', method: 'POST', path: '/config/ratings/sticker-backup', body: {} },

    { group: 'Art', method: 'GET', path: '/art/current_640.jpg' },
    { group: 'Art', method: 'GET', path: '/art/current_bg_640_blur.jpg' },
    { group: 'Art', method: 'GET', path: '/art/track_640.jpg' },
  ];

  app.post('/config/browse-index/rebuild', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost, { force: true });
      return res.json({ ok: true, builtAt: idx?.builtAt || '', counts: idx?.counts || {} });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  function inferEndpointGroup(pathname = '') {
    const p = String(pathname || '');
    if (p.startsWith('/config/lastfm/')) return 'Last.fm';
    if (p.startsWith('/config/diagnostics/')) return 'Diagnostics';
    if (p.startsWith('/config/queue-wizard/') || p.startsWith('/config/radio-browser/')) return 'Queue Wizard';
    if (p.startsWith('/config/browse/')) return 'Browse';
    if (p.startsWith('/config/library-health/')) return 'Library Health';
    if (p.startsWith('/config/runtime') || p.startsWith('/config/restart-') || p.startsWith('/config/services/')) return 'Runtime/Admin';
    if (p.startsWith('/config/moode/') || p.startsWith('/peppy/')) return 'Moode/Peppy';
    if (p.startsWith('/config/ratings/')) return 'Ratings Stickers';
    if (p.startsWith('/podcasts')) return 'Podcasts';
    if (p.startsWith('/queue/')) return 'Queue';
    if (p.startsWith('/rating')) return 'Ratings';
    if (p.startsWith('/art/')) return 'Art';
    if (p === '/now-playing' || p === '/next-up' || p === '/track') return 'Now Playing';
    return 'Other';
  }

  function discoverAppRoutes() {
    const stack = app?._router?.stack || app?.router?.stack || [];
    const out = [];
    const walk = (layers = [], prefix = '') => {
      for (const layer of layers) {
        if (layer?.route?.path) {
          const routePath = `${prefix}${layer.route.path}`;
          const methods = Object.keys(layer.route.methods || {})
            .filter((k) => layer.route.methods[k])
            .map((k) => k.toUpperCase());
          for (const method of methods) out.push({ method, path: routePath });
          continue;
        }
        if (layer?.name === 'router' && Array.isArray(layer?.handle?.stack)) {
          // Nested routers are uncommon here in this project; recurse without extra prefix.
          walk(layer.handle.stack, prefix);
        }
      }
    };
    walk(stack);
    return out;
  }

  app.get('/config/diagnostics/endpoints', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const metaByKey = new Map();
      for (const e of endpointCatalog) {
        const method = String(e?.method || 'GET').toUpperCase();
        const path = String(e?.path || '').trim();
        if (!path) continue;
        metaByKey.set(`${method} ${path}`, {
          group: String(e?.group || inferEndpointGroup(path)).trim(),
          body: (e && typeof e.body === 'object') ? e.body : undefined,
          query: (e && typeof e.query === 'object') ? e.query : undefined,
          name: String(e?.name || path).trim(),
        });
      }

      const discovered = discoverAppRoutes();
      for (const r of discovered) {
        const method = String(r?.method || 'GET').toUpperCase();
        const path = String(r?.path || '').trim();
        if (!path) continue;
        const k = `${method} ${path}`;
        if (!metaByKey.has(k)) {
          metaByKey.set(k, {
            group: inferEndpointGroup(path),
            name: path,
          });
        }
      }

      const endpoints = Array.from(metaByKey.entries())
        .map(([k, meta]) => {
          const i = k.indexOf(' ');
          const method = k.slice(0, i);
          const path = k.slice(i + 1);
          return {
            group: String(meta?.group || inferEndpointGroup(path)).trim(),
            method,
            path,
            name: String(meta?.name || path).trim(),
            ...(meta?.query ? { query: meta.query } : {}),
            ...(meta?.body ? { body: meta.body } : {}),
          };
        })
        .sort((a, b) => {
          const g = String(a.group || '').localeCompare(String(b.group || ''));
          if (g) return g;
          const p = String(a.path || '').localeCompare(String(b.path || ''));
          if (p) return p;
          return String(a.method || '').localeCompare(String(b.method || ''));
        });

      return res.json({ ok: true, count: endpoints.length, endpoints });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/diagnostics/album-tracks', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const album = String(req.query?.album || '').trim();
      const artist = String(req.query?.artist || '').trim();
      if (!album) return res.status(400).json({ ok: false, error: 'album is required' });

      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      const albLc = album.toLowerCase();
      const artLc = artist.toLowerCase();
      const tracks = (Array.isArray(idx?.tracks) ? idx.tracks : [])
        .filter((t) => String(t?.album || '').trim().toLowerCase() === albLc)
        .filter((t) => !artLc || String(t?.artist || t?.albumArtist || '').trim().toLowerCase() === artLc)
        .map((t) => ({
          file: String(t?.file || '').trim(),
          track: String(t?.track || '').trim(),
          title: String(t?.title || '').trim(),
          artist: String(t?.artist || t?.albumArtist || artist || '').trim(),
          album: String(t?.album || album || '').trim(),
        }))
        .filter((t) => !!t.file);

      tracks.sort((a, b) => {
        const ta = Number.parseInt(String(a.track || '').replace(/[^0-9].*$/, ''), 10);
        const tb = Number.parseInt(String(b.track || '').replace(/[^0-9].*$/, ''), 10);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, undefined, { sensitivity: 'base' });
      });

      return res.json({ ok: true, album, artist, count: tracks.length, tracks });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/diagnostics/artist-albums', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const artist = String(req.query?.artist || '').trim();
      if (!artist) return res.status(400).json({ ok: false, error: 'artist is required' });
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      const artLc = artist.toLowerCase();
      const byAlbum = new Map();

      for (const t of (Array.isArray(idx?.tracks) ? idx.tracks : [])) {
        const rowArtist = String(t?.artist || t?.albumArtist || '').trim();
        if (rowArtist.toLowerCase() !== artLc) continue;
        const albumName = String(t?.album || '').trim();
        const fileName = String(t?.file || '').trim();
        if (!albumName || !fileName) continue;
        const key = albumName.toLowerCase();
        if (!byAlbum.has(key)) {
          const i = fileName.lastIndexOf('/');
          const folder = i > 0 ? fileName.slice(0, i) : '';
          byAlbum.set(key, {
            album: albumName,
            artist: rowArtist || artist,
            genre: String(t?.genre || '').trim(),
            sampleFile: fileName,
            folder,
            count: 1,
          });
        } else {
          byAlbum.get(key).count += 1;
        }
      }

      const albums = Array.from(byAlbum.values()).sort((a, b) => String(a.album || '').localeCompare(String(b.album || ''), undefined, { sensitivity: 'base' }));
      return res.json({ ok: true, artist, count: albums.length, albums });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/diagnostics/queue/save-playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const rawName = String(req.body?.playlistName || '').trim();
      if (!rawName) return res.status(400).json({ ok: false, error: 'playlistName is required' });
      const safeName = rawName.replace(/[\r\n]/g, ' ').replace(/[\x00-\x1F]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!safeName) return res.status(400).json({ ok: false, error: 'playlistName is invalid' });

      const mpdHost = String(MPD_HOST || process.env.MPD_HOST || '127.0.0.1').trim();
      const mpdPort = String(process.env.MPD_PORT || '6600').trim();

      const q = await execFileP('mpc', ['-h', mpdHost, '-p', mpdPort, 'playlist'], { timeout: 15000 });
      const qLines = String(q?.stdout || '').split(/\r?\n/).map((s)=>String(s||'').trim()).filter(Boolean);
      const trackCount = qLines.length;
      const youtubeThumbs = qLines
        .map((u) => {
          try {
            return String((typeof getYoutubeQueueHint === 'function' ? (getYoutubeQueueHint(u)?.thumbnail || '') : '') || '').trim();
          } catch {
            return '';
          }
        })
        .filter(Boolean);

      const sourceManifest = {
        schema: 'now-playing.youtube-manifest.v1',
        playlistName: safeName,
        savedAt: new Date().toISOString(),
        entries: qLines.map((u, idx) => {
          const file = String(u || '').trim();
          const isYtProxy = /\/youtube\/proxy\//i.test(file);
          const hint = (isYtProxy && typeof getYoutubeQueueHint === 'function') ? (getYoutubeQueueHint(file) || {}) : {};
          const sourceUrl = String(hint?.webpageUrl || '').trim();
          return {
            index: idx,
            type: isYtProxy ? 'youtube' : 'mpd',
            file,
            sourceUrl,
            title: String(hint?.title || '').trim(),
            channel: String(hint?.channel || '').trim(),
            thumbnail: String(hint?.thumbnail || '').trim(),
          };
        }),
      };
      if (!trackCount) {
        return res.status(400).json({ ok: false, error: 'Live queue is empty. Nothing to save.' });
      }

      try {
        await execFileP('mpc', ['-h', mpdHost, '-p', mpdPort, 'rm', safeName], { timeout: 15000 });
      } catch {}
      await execFileP('mpc', ['-h', mpdHost, '-p', mpdPort, 'save', safeName], { timeout: 20000 });

      const sshHost = String(MOODE_SSH_HOST || mpdHost || '').trim();
      const sshUser = String(MOODE_SSH_USER || 'moode').trim();

      // Rewrite saved .m3u to use durable source URLs for YouTube entries (not proxy URLs).
      let m3uRewritten = false;
      let m3uRewriteError = '';
      try {
        const playlistFileName = `${safeName}.m3u`;
        const m3uLines = sourceManifest.entries
          .map((ent) => {
            const t = String(ent?.type || '').trim().toLowerCase();
            const f = String(ent?.file || '').trim();
            const src = String(ent?.sourceUrl || '').trim();
            if (t === 'youtube') return src || f;
            return f;
          })
          .filter(Boolean);
        const m3uText = `${m3uLines.join('\n')}\n`;
        const m3uB64 = Buffer.from(m3uText, 'utf8').toString('base64');
        const remoteM3u = `/var/lib/mpd/playlists/${playlistFileName}`;
        const cmd = `sudo -n bash -lc 'echo ${m3uB64} | base64 -d > ${remoteM3u.replace(/ /g, '\\ ')} && chown root:audio ${remoteM3u.replace(/ /g, '\\ ')} && chmod 644 ${remoteM3u.replace(/ /g, '\\ ')}'`;
        await execFileP('ssh', [`${sshUser}@${sshHost}`, cmd], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        m3uRewritten = true;
      } catch (e) {
        m3uRewriteError = e?.message || String(e);
      }

      // Save sidecar manifest so YouTube entries can be rebuilt later.
      let manifestSaved = false;
      let manifestError = '';
      try {
        const manifestName = `${safeName}.youtube.json`.replace(/[^A-Za-z0-9._ -]/g, '_');
        const manifestJson = JSON.stringify(sourceManifest, null, 2);
        const manifestB64 = Buffer.from(manifestJson, 'utf8').toString('base64');
        const remotePath = `/var/lib/mpd/playlists/${manifestName}`;
        const cmd = `sudo -n bash -lc 'echo ${manifestB64} | base64 -d > ${remotePath.replace(/ /g, '\\ ')} && chown root:audio ${remotePath.replace(/ /g, '\\ ')} && chmod 644 ${remotePath.replace(/ /g, '\\ ')}'`;
        await execFileP('ssh', [`${sshUser}@${sshHost}`, cmd], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        manifestSaved = true;
      } catch (e) {
        manifestError = e?.message || String(e);
      }

      let collageGenerated = false;
      let collageError = '';
      const generateCollage = req.body?.generateCollage !== false;
      if (generateCollage) {
        const sshHost = String(MOODE_SSH_HOST || mpdHost || '').trim();
        const sshUser = String(MOODE_SSH_USER || 'moode').trim();

        // Prefer direct thumb cover for YouTube/stream-heavy queues.
        if (youtubeThumbs.length) {
          try {
            const firstThumb = String(youtubeThumbs[0] || '').trim();
            const coverName = safeName.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
            const remoteOut = `/var/local/www/imagesw/playlist-covers/${coverName}.jpg`;
            const esc = (s) => String(s).replace(/'/g, `'"'"'`);
            const cmdInner = `set -e; mkdir -p /var/local/www/imagesw/playlist-covers; curl -fsSL '${esc(firstThumb)}' -o '${esc(remoteOut)}'`;
            const cmd = `sudo -n bash -lc '${cmdInner.replace(/'/g, "'\\''")}'`;
            await execFileP('ssh', [`${sshUser}@${sshHost}`, cmd], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
            collageGenerated = true;
          } catch (e) {
            collageError = e?.message || String(e);
          }
        }

        // Non-YouTube or fallback path: try moOde collage script.
        if (!collageGenerated) {
          try {
            const remoteScriptCandidates = [
              '/usr/local/bin/moode-playlist-cover.sh',
              '/opt/now-playing/scripts/moode-playlist-cover.sh',
              '/var/local/www/scripts/moode-playlist-cover.sh',
            ];
            const cmdInner = `set -e; P='${safeName.replace(/'/g, "'\\''")}'; `
              + `for s in ${remoteScriptCandidates.map((p)=>`'${p}'`).join(' ')}; do `
              + `if [ -x "$s" ]; then bash "$s" "$P"; exit 0; fi; `
              + `done; echo 'cover-script-not-found' >&2; exit 127`;
            const cmd = `sudo -n bash -lc '${cmdInner.replace(/'/g, "'\\''")}'`;
            await execFileP('ssh', [`${sshUser}@${sshHost}`, cmd], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
            collageGenerated = true;
          } catch (e) {
            if (!collageError) collageError = e?.message || String(e);
          }
        }
      }

      if (collageError) {
        const one = String(collageError).split(/\r?\n/)[0];
        collageError = one.replace(/^Command failed:\s*/i, '').slice(0, 180);
      }

      return res.json({ ok: true, playlistName: safeName, playlistSaved: true, trackCount, m3uRewritten, m3uRewriteError, manifestSaved, manifestError, collageGenerated, collageError });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/integrations/alexa/state', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const state = String(req.body?.state || '').trim().toLowerCase();
      if (state !== 'on' && state !== 'off') {
        return res.status(400).json({ ok: false, error: 'state must be on or off' });
      }
      if (typeof setAlexaModeState !== 'function') {
        return res.status(500).json({ ok: false, error: 'Alexa state handler is unavailable' });
      }

      const mode = await setAlexaModeState(state === 'on');
      return res.json({
        ok: true,
        state,
        alexaMode: state === 'on',
        modeActive: !!mode?.modeActive,
        active: !!mode?.modeActive,
        playbackTarget: String(mode?.playbackTarget || ''),
        playbackMode: String(mode?.playbackMode || ''),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/alexa/natural-finish', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const url = await getAlexaControlWebhookUrl('finished');
      if (!url) return res.status(400).json({ ok: false, error: 'Alexa natural-finish webhook URL is not configured' });

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ ok: false, error: 'Alexa natural-finish webhook URL is invalid' });
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ ok: false, error: 'Alexa natural-finish webhook URL must be http(s)' });
      }

      const response = await fetch(parsed.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'now-playing-next', action: 'alexa-finished', ts: Date.now() }),
      });
      let bodyPreview = '';
      try { bodyPreview = String(await response.text()).slice(0, 240); } catch {}
      if (!response.ok) {
        return res.status(502).json({ ok: false, error: `Webhook returned HTTP ${response.status}`, statusCode: response.status, body: bodyPreview });
      }

      const mode = typeof setAlexaModeState === 'function' ? await setAlexaModeState(false) : null;
      return res.json({ ok: true, action: 'alexa-finished', statusCode: response.status, body: bodyPreview, alexaCleared: !!mode });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/diagnostics/playback', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const action = String(req.body?.action || '').trim().toLowerCase();
      const mpdHost = String(MPD_HOST || 'moode.local');
      const map = { play: 'play', pause: 'pause', toggle: 'toggle', next: 'next', prev: 'prev', previous: 'prev', stop: 'stop' };
      const qobuzUnavailableActions = new Set([
        'play', 'pause', 'toggle', 'toggle_play_pause', 'next', 'prev', 'previous', 'stop',
        'seek', 'seekcur', 'seekpct', 'shuffle', 'shufflequeue', 'undoshuffle',
        'repeat', 'repeat-mode', 'consume', 'crossfade',
      ]);

      if (qobuzUnavailableActions.has(action) && typeof getQobuzNowPlaying === 'function') {
        let qobuz = null;
        try { qobuz = await getQobuzNowPlaying(); } catch {}
        if (qobuz?.active) {
          return res.status(409).json({
            ok: false,
            unavailable: true,
            source: 'qobuz-connect',
            error: 'MPD playback controls are unavailable while Qobuz Connect owns playback',
          });
        }
      }

      if (action === 'shuffle' || action === 'shufflequeue') {
        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const beforeFiles = await readMpdQueueFiles(mpdHost);
        if (beforeFiles.length < 2) {
          return res.status(400).json({ ok: false, error: 'Not enough queued tracks to shuffle.' });
        }

        // Physical queue order is the user-visible source for Live Queue. Keep
        // the current track and any already-played entries fixed; only the
        // upcoming portion is randomized. MPD random mode would make the
        // visible queue disagree with actual playback, so disable it here.
        const headIndex = parseMpdHeadPosition(beforeStatus);
        const upcomingStart = headIndex >= 0 ? Math.min(beforeFiles.length, headIndex + 1) : 0;
        const targetFiles = [
          ...beforeFiles.slice(0, upcomingStart),
          ...shuffleArray(beforeFiles.slice(upcomingStart)),
        ];
        const randomWasOn = /random:\s*on/i.test(String(beforeStatus || ''));
        if (randomWasOn) await execFileP('mpc', ['-h', mpdHost, 'random', 'off']);
        await moveMpdQueueToOrder(mpdHost, beforeFiles, targetFiles);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const afterFiles = await readMpdQueueFiles(mpdHost);
        liveQueueShuffleUndo = {
          originalFiles: beforeFiles,
          shuffledFiles: afterFiles,
          originalRandomOn: randomWasOn,
          createdAt: Date.now(),
        };
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        const repeatOn = /repeat:\s*on/i.test(String(afterStatus || ''));
        return res.json({
          ok: true,
          action,
          randomOn,
          repeatOn,
          undoAvailable: queueFingerprint(afterFiles) === queueFingerprint(targetFiles),
          shuffledUpcoming: Math.max(0, beforeFiles.length - upcomingStart),
          status: String(afterStatus || ''),
        });
      }

      if (action === 'undoshuffle') {
        if (!liveQueueShuffleUndo) {
          return res.status(409).json({ ok: false, error: 'No reversible shuffle is available.' });
        }
        const currentFiles = await readMpdQueueFiles(mpdHost);
        if (!reconcileShuffleUndo(currentFiles)
          || queueFingerprint(currentFiles) !== queueFingerprint(liveQueueShuffleUndo?.shuffledFiles || [])) {
          return res.status(409).json({ ok: false, error: 'The queue changed after shuffle; undo is no longer available.' });
        }
        await moveMpdQueueToOrder(mpdHost, currentFiles, liveQueueShuffleUndo.originalFiles);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const afterFiles = await readMpdQueueFiles(mpdHost);
        const restored = queueFingerprint(afterFiles) === queueFingerprint(liveQueueShuffleUndo.originalFiles);
        liveQueueShuffleUndo = null;
        if (!restored) return res.status(409).json({ ok: false, error: 'Queue changed while undoing shuffle.' });
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        const repeatOn = /repeat:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, randomOn, repeatOn, undoAvailable: false, status: String(afterStatus || '') });
      }

      if (action === 'repeat-mode') {
        const mode = req.body?.mode;
        if (!['off', 'all', 'one'].includes(mode)) {
          return res.status(400).json({
            ok: false,
            error: 'mode must be off, all, or one',
            code: 'REPEAT_MODE_INVALID',
          });
        }

        const commands = {
          off: [['single', 'off'], ['repeat', 'off']],
          all: [['single', 'off'], ['repeat', 'on']],
          one: [['repeat', 'on'], ['single', 'on']],
        }[mode];
        for (const command of commands) {
          await executeMpc(['-h', mpdHost, ...command]);
        }

        const { stdout: afterStatus } = await executeMpc(['-h', mpdHost, 'status']);
        const status = String(afterStatus || '');
        const randomOn = /random:\s*on/i.test(status);
        const repeatOn = /repeat:\s*on/i.test(status);
        const singleOn = /single:\s*on/i.test(status);
        const repeatMode = singleOn ? 'one' : (repeatOn ? 'all' : 'off');
        if (repeatMode !== mode) {
          return res.status(502).json({
            ok: false,
            error: 'MPD repeat mode readback did not match the requested mode',
            code: 'REPEAT_MODE_READBACK_MISMATCH',
            requestedMode: mode,
            repeatMode,
          });
        }
        return res.json({
          ok: true,
          action,
          mode: repeatMode,
          repeatMode,
          randomOn,
          repeatOn,
          singleOn,
          status,
        });
      }

      if (action === 'repeat') {
        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const wasOn = /repeat:\s*on/i.test(String(beforeStatus || ''));
        const setTo = wasOn ? 'off' : 'on';
        await execFileP('mpc', ['-h', mpdHost, 'repeat', setTo]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        const repeatOn = /repeat:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, randomOn, repeatOn, status: String(afterStatus || '') });
      }

      if (action === 'consume') {
        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const wasOn = /consume:\s*on/i.test(String(beforeStatus || ''));
        const setToRaw = String(req.body?.setTo || '').trim().toLowerCase();
        const setTo = (setToRaw === 'on' || setToRaw === 'off') ? setToRaw : (wasOn ? 'off' : 'on');
        await execFileP('mpc', ['-h', mpdHost, 'consume', setTo]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const consumeOn = /consume:\s*on/i.test(String(afterStatus || ''));
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        const repeatOn = /repeat:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, consumeOn, randomOn, repeatOn, status: String(afterStatus || '') });
      }

      if (action === 'crossfade') {
        const secRaw = Number(req.body?.seconds);
        const seconds = Number.isFinite(secRaw) ? Math.max(0, Math.min(10, Math.round(secRaw))) : -1;
        if (seconds < 0) return res.status(400).json({ ok: false, error: 'seconds (0..10) is required for crossfade' });

        const sshHost = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
        const sshUser = String(MOODE_SSH_USER || 'moode').trim();
        const remote = `mpc crossfade ${seconds} && mpc status`;
        const { stdout: afterStatus } = await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${sshUser}@${sshHost}`, remote], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
        const st = String(afterStatus || '');
        const { stdout: cfOut } = await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${sshUser}@${sshHost}`, 'mpc crossfade'], { timeout: 12000, maxBuffer: 256 * 1024 });
        const cfText = String(cfOut || '').trim();
        const mCf = cfText.match(/crossfade:\s*([0-9]+(?:\.[0-9]+)?)/i);
        const crossfadeSec = mCf ? Math.max(0, Math.min(10, Math.round(Number(mCf[1] || 0)))) : seconds;
        const randomOn = /random:\s*on/i.test(st);
        const repeatOn = /repeat:\s*on/i.test(st);
        const consumeOn = /consume:\s*on/i.test(st);
        return res.json({ ok: true, action, crossfadeSec, randomOn, repeatOn, consumeOn, status: st });
      }

      if (action === 'remove') {
        const posRaw = Number(req.body?.position);
        const pos = Number.isFinite(posRaw) ? Math.max(1, Math.floor(posRaw)) : 0;
        if (!pos) return res.status(400).json({ ok: false, error: 'position is required for remove' });
        await execFileP('mpc', ['-h', mpdHost, 'del', String(pos)]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, removedPosition: pos, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'clear') {
        await execFileP('mpc', ['-h', mpdHost, 'clear']);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'crop') {
        let cropFallback = '';
        const keepQueueHead = async () => {
          const { stdout: queueOut } = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'playlist']);
          const firstFile = String(queueOut || '')
            .split(/\r?\n/)
            .map((line) => String(line || '').trim())
            .find(Boolean);
          if (!firstFile) return false;

          await execFileP('mpc', ['-h', mpdHost, 'clear']);
          await execFileP('mpc', ['-h', mpdHost, 'add', firstFile]);
          return true;
        };

        // MPD's crop command requires a current song. During Alexa playback,
        // or after a stop, the queue can still exist while MPD has no current
        // song. Check first so that state produces a clean queue-head fallback
        // instead of a raw command error in the controller.
        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const hasCurrentSong = /#\d+\/\d+/.test(String(beforeStatus || ''));
        if (!hasCurrentSong) {
          if (!(await keepQueueHead())) {
            return res.status(409).json({ ok: false, action, error: 'Cannot crop an empty queue because there is no current song' });
          }
          cropFallback = 'queue-head';
        } else {
          try {
            await execFileP('mpc', ['-h', mpdHost, 'crop']);
          } catch (e) {
            const cropError = String(e?.stderr || e?.message || e || '');
            if (!/no\s+(?:current\s+)?song|not\s+playing|current\s+song/i.test(cropError)) throw e;
            if (!(await keepQueueHead())) {
              return res.status(409).json({ ok: false, action, error: 'Cannot crop an empty queue because there is no current song' });
            }
            cropFallback = 'queue-head';
          }
        }
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, randomOn, cropFallback, status: String(afterStatus || '') });
      }

      const alexaControl = ({
        pausealexa: 'pause',
        'pause-alexa': 'pause',
        'alexa-pause': 'pause',
        resumealexa: 'resume',
        'resume-alexa': 'resume',
        'alexa-resume': 'resume',
        nextalexa: 'next',
        'next-alexa': 'next',
        'alexa-next': 'next',
      })[action];
      if (alexaControl) {
        const url = await getAlexaControlWebhookUrl(alexaControl);
        if (!url) return res.status(400).json({ ok: false, error: `Alexa ${alexaControl} webhook URL is not configured` });
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return res.status(400).json({ ok: false, error: `Alexa ${alexaControl} webhook URL is invalid` });
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ ok: false, error: `Alexa ${alexaControl} webhook URL must be http(s)` });
        }

        const response = await fetch(parsed.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'now-playing-next', action: `alexa-${alexaControl}`, ts: Date.now() }),
        });
        let bodyPreview = '';
        try { bodyPreview = String(await response.text()).slice(0, 240); } catch {}
        if (!response.ok) {
          return res.status(502).json({ ok: false, error: `Webhook returned HTTP ${response.status}`, statusCode: response.status, body: bodyPreview });
        }

        return res.json({
          ok: true,
          action,
          alexaControl,
          ...(immutableRuntime() ? { webhookConfigured: true } : { webhookUrl: parsed.toString() }),
          statusCode: response.status,
          body: bodyPreview,
        });
      }

      if (action === 'routealexa') {
        const url = await getAlexaRouteWebhookUrl();
        if (!url) return res.status(400).json({ ok: false, error: 'Alexa route webhook URL is not configured' });
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return res.status(400).json({ ok: false, error: 'Alexa route webhook URL is invalid' });
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ ok: false, error: 'Alexa route webhook URL must be http(s)' });
        }

        const methodRaw = String(req.body?.method || '').trim().toUpperCase();
        const method = (methodRaw === 'POST' || methodRaw === 'GET') ? methodRaw : 'POST';
        const response = await fetch(parsed.toString(), {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: method === 'POST' ? JSON.stringify({ source: 'now-playing-next', action: 'route-to-alexa', ts: Date.now() }) : undefined,
        });

        let bodyPreview = '';
        try { bodyPreview = String(await response.text()).slice(0, 240); } catch {}
        if (!response.ok) {
          return res.status(502).json({ ok: false, error: `Webhook returned HTTP ${response.status}`, statusCode: response.status, body: bodyPreview });
        }

        return res.json({
          ok: true,
          action,
          ...(immutableRuntime() ? { webhookConfigured: true } : { webhookUrl: parsed.toString() }),
          statusCode: response.status,
          body: bodyPreview,
        });
      }

      if (action === 'stopalexa' || action === 'stop-alexa') {
        const url = await getAlexaStopWebhookUrl();
        if (!url) return res.status(400).json({ ok: false, error: 'Alexa stop webhook URL is not configured' });
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return res.status(400).json({ ok: false, error: 'Alexa stop webhook URL is invalid' });
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ ok: false, error: 'Alexa stop webhook URL must be http(s)' });
        }

        const methodRaw = String(req.body?.method || '').trim().toUpperCase();
        const method = (methodRaw === 'POST' || methodRaw === 'GET') ? methodRaw : 'POST';
        const response = await fetch(parsed.toString(), {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: method === 'POST' ? JSON.stringify({ source: 'now-playing-next', action: 'stop-alexa', ts: Date.now() }) : undefined,
        });

        let bodyPreview = '';
        try { bodyPreview = String(await response.text()).slice(0, 240); } catch {}
        if (!response.ok) {
          return res.status(502).json({ ok: false, error: `Webhook returned HTTP ${response.status}`, statusCode: response.status, body: bodyPreview });
        }

        const alexaCleared = typeof clearAlexaWasPlayingState === 'function';
        if (alexaCleared) await clearAlexaWasPlayingState();

        return res.json({
          ok: true,
          action,
          ...(immutableRuntime() ? { webhookConfigured: true } : { webhookUrl: parsed.toString() }),
          statusCode: response.status,
          body: bodyPreview,
          alexaCleared,
        });
      }

      if (action === 'playpos') {
        const posRaw = Number(req.body?.position);
        const pos = Number.isFinite(posRaw) ? Math.max(1, Math.floor(posRaw)) : 0;
        if (!pos) return res.status(400).json({ ok: false, error: 'position is required for playpos' });
        await execFileP('mpc', ['-h', mpdHost, 'play', String(pos)]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, playedPosition: pos, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'move') {
        const fromRaw = Number(req.body?.fromPosition);
        const toRaw = Number(req.body?.toPosition);
        const fromPosition = Number.isFinite(fromRaw) ? Math.max(1, Math.floor(fromRaw)) : 0;
        const toPosition = Number.isFinite(toRaw) ? Math.max(1, Math.floor(toRaw)) : 0;
        if (!fromPosition || !toPosition) return res.status(400).json({ ok: false, error: 'fromPosition and toPosition are required for move' });
        await execFileP('mpc', ['-h', mpdHost, 'move', String(fromPosition), String(toPosition)]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, fromPosition, toPosition, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'addfile') {
        const file = String(req.body?.file || '').trim();
        if (!file) return res.status(400).json({ ok: false, error: 'file is required for addfile' });
        await execFileP('mpc', ['-h', mpdHost, 'add', file]);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, file, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'trackmeta') {
        const file = String(req.body?.file || '').trim();
        if (!file) return res.status(400).json({ ok: false, error: 'file is required for trackmeta' });
        const fmt = '%file%\t%genre%\t%date%\t%track%\t%time%\t%composer%\t%performer%\t%albumartist%\t%album%\t%name%\t%audio%';
        const basename = file.split('/').pop() || file;

        async function pull(args) {
          try {
            const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', fmt, ...args], { maxBuffer: 4 * 1024 * 1024 });
            return String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          } catch {
            return [];
          }
        }

        function resolveLocalPath(f) {
          const s = String(f || '').trim().replace(/^\/+/, '');
          if (!s) return '';
          const candidates = [
            s.startsWith('USB/SamsungMoode/') ? '/mnt/SamsungMoode/' + s.slice('USB/SamsungMoode/'.length) : '',
            s.startsWith('OSDISK/') ? '/mnt/OSDISK/' + s.slice('OSDISK/'.length) : '',
            '/mnt/SamsungMoode/' + s,
            '/mnt/OSDISK/' + s,
            s.startsWith('/mnt/') ? s : '',
          ].filter(Boolean);
          return candidates;
        }

        async function ffprobeAudio(localPath) {
          try {
            const { stdout } = await execFileP('ffprobe', [
              '-v', 'error',
              '-select_streams', 'a:0',
              '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,bit_rate',
              '-of', 'default=noprint_wrappers=1:nokey=0',
              localPath,
            ], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
            const kv = {};
            String(stdout || '').split(/\r?\n/).forEach((ln) => {
              const i = ln.indexOf('=');
              if (i > 0) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
            });
            const codec = String(kv.codec_name || '').trim();
            const sr = Number(kv.sample_rate || 0) || 0;
            const ch = Number(kv.channels || 0) || 0;
            const bits = Number(kv.bits_per_raw_sample || kv.bits_per_sample || 0) || 0;
            const br = Number(kv.bit_rate || 0) || 0;
            const human = [
              codec || '',
              bits ? `${bits}-bit` : '',
              sr ? `${Math.round(sr/1000)} kHz` : '',
              ch ? `${ch}ch` : '',
              br ? `${Math.round(br/1000)} kbps` : '',
            ].filter(Boolean).join(' • ');
            return { codec, sample_rate: sr ? `${sr}` : '', bits: bits ? `${bits}` : '', bit_rate: br ? `${Math.round(br/1000)}` : '', channels: ch ? `${ch}` : '', human };
          } catch {
            return { codec:'', sample_rate:'', bits:'', bit_rate:'', channels:'', human:'' };
          }
        }

        async function ffprobePersonnel(localPath) {
          try {
            const { stdout } = await execFileP('ffprobe', [
              '-v', 'error',
              '-show_entries', 'format_tags=artist,album_artist,performer,composer,conductor,ensemble,soloist',
              '-of', 'default=noprint_wrappers=1:nokey=0',
              localPath,
            ], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
            const vals = [];
            String(stdout || '').split(/\r?\n/).forEach((ln) => {
              const m = ln.match(/^TAG:([^=]+)=(.*)$/);
              if (!m) return;
              const key = String(m[1] || '').toLowerCase();
              const v = String(m[2] || '').trim();
              if (!v) return;
              if (['artist','album_artist','performer','composer','conductor','ensemble','soloist'].includes(key)) vals.push(v);
            });
            return Array.from(new Set(vals)).join(' • ');
          } catch {
            return '';
          }
        }

        let rows = await pull(['find', 'file', file]);
        if (!rows.length && !file.startsWith('/')) rows = await pull(['find', 'file', `/${file}`]);
        if (!rows.length) rows = await pull(['find', 'filename', basename]);
        if (!rows.length) rows = await pull(['search', 'filename', basename]);

        let first = rows[0] || '';
        if (rows.length > 1) {
          const lowFile = file.toLowerCase();
          const byPath = rows.find((ln) => String(ln.split('\t')[0] || '').toLowerCase().includes(lowFile));
          if (byPath) first = byPath;
        }

        const [fileOut='', genre='', date='', track='', time='', composer='', performer='', albumartist='', album='', name='', audio=''] = String(first || '').split('\t');
        let audioOut = String(audio || '').trim();
        let audioInfo = { codec:'', sample_rate:'', bits:'', bit_rate:'', channels:'', human:'' };
        let personnelOut = [String(performer || '').trim(), String(composer || '').trim()].filter(Boolean).join(' • ');
        if (!audioOut || /%audio%/i.test(audioOut)) {
          const rel = String(fileOut || file || '').trim();
          const cands = resolveLocalPath(rel);
          for (const p of cands) {
            try {
              await fs.access(p);
              audioInfo = await ffprobeAudio(p);
              const pp = await ffprobePersonnel(p);
              if (pp) personnelOut = pp;
              if (audioInfo.human || pp) {
                if (audioInfo.human) audioOut = audioInfo.human;
                break;
              }
            } catch {}
          }
        }

        return res.json({
          ok: true,
          action,
          file,
          found: !!first,
          foundFile: String(fileOut || '').trim(),
          meta: {
            genre: String(genre || '').trim(),
            date: String(date || '').trim(),
            track: String(track || '').trim(),
            time: String(time || '').trim(),
            composer: String(composer || '').trim(),
            performer: String(performer || '').trim(),
            albumartist: String(albumartist || '').trim(),
            album: String(album || '').trim(),
            name: String(name || '').trim(),
            personnel: String(personnelOut || '').trim(),
            audio: String(audioOut || '').trim(),
            audioInfo,
          },
        });
      }

      if (action === 'playfile') {
        const file = String(req.body?.file || '').trim();
        if (!file) return res.status(400).json({ ok: false, error: 'file is required for playfile' });

        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const beforeMatch = String(beforeStatus || '').match(/#(\d+)\/(\d+)/);
        const curPos = beforeMatch ? Number(beforeMatch[1] || 0) : 0;

        await execFileP('mpc', ['-h', mpdHost, 'add', file]);

        const { stdout: midStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const midMatch = String(midStatus || '').match(/#(\d+)\/(\d+)/);
        const totalAfterAdd = midMatch ? Number(midMatch[2] || 0) : 0;

        let targetPos = 0;
        if (Number.isFinite(curPos) && curPos > 0) {
          targetPos = curPos + 1;
          const fromPos = Number.isFinite(totalAfterAdd) && totalAfterAdd > 0 ? totalAfterAdd : 0;
          if (fromPos > 0 && fromPos !== targetPos) {
            await execFileP('mpc', ['-h', mpdHost, 'move', String(fromPos), String(targetPos)]);
          }
          await execFileP('mpc', ['-h', mpdHost, 'play', String(targetPos)]);
        } else {
          const fallbackPos = Number.isFinite(totalAfterAdd) && totalAfterAdd > 0 ? totalAfterAdd : 1;
          targetPos = fallbackPos;
          await execFileP('mpc', ['-h', mpdHost, 'play', String(fallbackPos)]);
        }

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, file, targetPos, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'playtracksearch' || action === 'addtracksearch') {
        const track = String(req.body?.track || req.body?.title || '').trim();
        const artist = String(req.body?.artist || '').trim();
        if (!track) return res.status(400).json({ ok: false, error: 'track is required for playtracksearch/addtracksearch' });

        let files = [];
        try {
          const args = ['-h', mpdHost, '-f', '%file%', 'find', 'title', track];
          if (artist) args.push('artist', artist);
          const { stdout } = await execFileP('mpc', args, { maxBuffer: 16 * 1024 * 1024 });
          files = String(stdout || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
        } catch {}

        if (!files.length) {
          try {
            const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'search', 'title', track], { maxBuffer: 16 * 1024 * 1024 });
            files = String(stdout || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
          } catch {}
        }

        files = Array.from(new Set(files));
        const file = String(files[0] || '').trim();
        if (!file) return res.status(404).json({ ok: false, error: 'No local track match found', track, artist });

        if (action === 'playtracksearch') {
          await execFileP('mpc', ['-h', mpdHost, 'clear']);
          await execFileP('mpc', ['-h', mpdHost, 'add', file]);
          await execFileP('mpc', ['-h', mpdHost, 'play', '1']);
        } else {
          await execFileP('mpc', ['-h', mpdHost, 'add', file]);
        }

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        return res.json({ ok: true, action, track, artist, file, status: String(afterStatus || '') });
      }

      if (action === 'addalbum') {
        const album = String(req.body?.album || '').trim();
        const artist = String(req.body?.artist || '').trim();
        const mode = String(req.body?.mode || 'append').trim().toLowerCase();
        if (!album) return res.status(400).json({ ok: false, error: 'album is required for addalbum' });
        if (!['append', 'crop', 'replace'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be append|crop|replace' });

        if (mode === 'replace') await execFileP('mpc', ['-h', mpdHost, 'clear']);
        if (mode === 'crop') await execFileP('mpc', ['-h', mpdHost, 'crop']);

        const args = ['-h', mpdHost, '-f', '%file%', 'find', 'album', album];
        if (artist) args.push('artist', artist);
        let filesOut = '';
        try {
          const { stdout } = await execFileP('mpc', args, { maxBuffer: 16 * 1024 * 1024 });
          filesOut = String(stdout || '');
        } catch {
          const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'find', 'album', album], { maxBuffer: 16 * 1024 * 1024 });
          filesOut = String(stdout || '');
        }
        const files = Array.from(new Set(String(filesOut || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean)));
        for (const f of files) {
          await execFileP('mpc', ['-h', mpdHost, 'add', f]);
        }
        if (mode === 'replace' && files.length > 0) {
          await execFileP('mpc', ['-h', mpdHost, 'play', '1']);
        }

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, album, artist, mode, added: files.length, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'addartistshuffle') {
        const artist = String(req.body?.artist || '').trim();
        const mode = String(req.body?.mode || 'append').trim().toLowerCase();
        const minRatingRaw = Number(req.body?.minRating);
        const minRating = Number.isFinite(minRatingRaw) ? Math.max(0, Math.min(5, Math.round(minRatingRaw))) : 2;
        const excludeGenreEnabled = String(req.body?.excludeGenreEnabled || '').trim().toLowerCase();
        const excludeGenre = String(req.body?.excludeGenre || '').trim();
        const excludeOn = ['1','true','yes','on'].includes(excludeGenreEnabled) || (!!excludeGenre);
        if (!artist) return res.status(400).json({ ok: false, error: 'artist is required for addartistshuffle' });
        if (!['append', 'crop', 'replace'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be append|crop|replace' });

        if (mode === 'replace') await execFileP('mpc', ['-h', mpdHost, 'clear']);
        if (mode === 'crop') await execFileP('mpc', ['-h', mpdHost, 'crop']);

        const pull = async (field) => {
          const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'find', field, artist], { maxBuffer: 24 * 1024 * 1024 });
          return String(stdout || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
        };
        const dedup = Array.from(new Set([...(await pull('artist')), ...(await pull('albumartist'))]));

        const filtered = [];
        for (const f of dedup) {
          if (excludeOn && excludeGenre) {
            try {
              const { stdout: gOut } = await execFileP('mpc', ['-h', mpdHost, '-f', '%genre%', 'find', 'file', f], { maxBuffer: 1024 * 1024 });
              const g = String(gOut || '').trim().toLowerCase();
              if (g && g.includes(String(excludeGenre || '').trim().toLowerCase())) continue;
            } catch {}
          }
          let rating = 0;
          try { rating = Number(await getRatingForFile(f)) || 0; } catch {}
          if (rating >= minRating) filtered.push(f);
        }

        for (let i = filtered.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = filtered[i]; filtered[i] = filtered[j]; filtered[j] = t;
        }
        for (const f of filtered) await execFileP('mpc', ['-h', mpdHost, 'add', f]);
        if (mode === 'replace' && filtered.length > 0) await execFileP('mpc', ['-h', mpdHost, 'play', '1']);

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, artist, mode, minRating, excludeGenre: excludeOn ? excludeGenre : '', matched: dedup.length, added: filtered.length, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'rate') {
        const ratingsEnabled = await isRatingsEnabled();
        if (!ratingsEnabled) return res.status(403).json({ ok: false, error: 'Ratings feature is disabled' });
        if (typeof setRatingForFile !== 'function') return res.status(501).json({ ok: false, error: 'rating dependency not wired' });
        const file = String(req.body?.file || '').trim();
        const ratingRaw = Number(req.body?.rating);
        const rating = Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, Math.round(ratingRaw))) : -1;
        if (!file) return res.status(400).json({ ok: false, error: 'file is required for rate' });
        if (rating < 0) return res.status(400).json({ ok: false, error: 'rating must be 0..5' });
        await setRatingForFile(file, rating);
        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, file, rating, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'seekrel') {
        const secRaw = Number(req.body?.seconds);
        const seconds = Number.isFinite(secRaw) ? Math.max(-600, Math.min(600, Math.round(secRaw))) : 0;
        if (!seconds) return res.status(400).json({ ok: false, error: 'seconds is required for seekrel' });

        const delta = seconds > 0 ? `+${seconds}` : String(seconds);
        try {
          await execFileP('mpc', ['-h', mpdHost, 'seekcur', delta]);
        } catch (e) {
          // Fallback for older mpc versions without seekcur.
          const msg = String(e?.message || '');
          if (!/unknown command\s+"seekcur"/i.test(msg)) throw e;

          // Older mpc supports relative seek via `seek [+|-]HH:MM:SS|seconds|%`.
          await execFileP('mpc', ['-h', mpdHost, 'seek', delta]);
        }

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, seconds, randomOn, status: String(afterStatus || '') });
      }

      if (action === 'seekpct') {
        const pctRaw = Number(req.body?.percent);
        const percent = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, Math.round(pctRaw))) : -1;
        if (percent < 0) return res.status(400).json({ ok: false, error: 'percent (0..100) is required for seekpct' });

        await execFileP('mpc', ['-h', mpdHost, 'seek', `${percent}%`]);

        const { stdout: afterStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const randomOn = /random:\s*on/i.test(String(afterStatus || ''));
        return res.json({ ok: true, action, percent, randomOn, status: String(afterStatus || '') });
      }

      const cmd = map[action];
      if (!cmd) return res.status(400).json({ ok: false, error: 'Invalid action' });

      // Fast path for core transport controls: hit moOde command endpoint directly,
      // then fall back to mpc if direct command is unavailable.
      const directCmd = moodeDirectTransportCommand(action);
      if (directCmd) {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 1200);
          try {
            const response = await fetch(`http://${mpdHost}/command/?cmd=${encodeURIComponent(directCmd)}`, {
              method: 'GET',
              cache: 'no-store',
              signal: ac.signal,
            });
            const body = await response.text();
            if (!response.ok || isMoodeTransportError(body)) {
              throw new Error(`moOde command failed with HTTP ${response.status}`);
            }
          } finally {
            clearTimeout(t);
          }
          return res.json({ ok: true, action, direct: true, command: directCmd });
        } catch {
          // fallback below
        }
      }

      if (action === 'toggle') {
        const { stdout: beforeStatus } = await execFileP('mpc', ['-h', mpdHost, 'status']);
        const fallbackCommand = /\[playing\]/i.test(String(beforeStatus || '')) ? 'pause' : 'play';
        await execFileP('mpc', ['-h', mpdHost, fallbackCommand]);
      } else {
        await execFileP('mpc', ['-h', mpdHost, cmd]);
      }
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, 'status']);
      const randomOn = /random:\s*on/i.test(String(stdout || ''));
      return res.json({ ok: true, action, randomOn, status: String(stdout || '') });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/art/radio-logo.jpg', async (req, res) => {
    try {
      const mpdHost = String(MPD_HOST || 'moode.local');
      let name = String(req.query?.name || '').trim();
      const file = String(req.query?.file || '').trim();

      if (!name && file) {
        let stationMap = new Map();
        let recentRadioMap = new Map();
        let aliases = {};
        try { stationMap = await loadRadioCatalogMap(); } catch {}
        try { recentRadioMap = await loadRadioQueueMap(); } catch {}
        try { aliases = await loadRadioLogoAliases(); } catch {}
        const fKey = stationKey(file);
        const fHost = stationHost(file);
        const q = recentRadioMap.get(file) || recentRadioMap.get(`key:${fKey}`) || recentRadioMap.get(`host:${fHost}`) || {};
        const c1 = stationMap.get(file) || {};
        const c2 = stationMap.get(fKey) || {};
        const c3 = stationMap.get(`host:${fHost}`) || {};
        const aliasName = String(aliases?.[fKey] || aliases?.[fHost] || '').trim();
        name = String(q.stationName || c1.stationName || c2.stationName || c3.stationName || aliasName || fHost || '').trim();
      }

      if (!name) return res.status(400).end('missing name');

      const cached = await readCachedRadioLogo(name);
      if (cached) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(cached);
      }

      const tryFetchLogo = async (nm) => {
        const u = `http://${mpdHost}/imagesw/radio-logos/${encodeURIComponent(nm)}.jpg`;
        const r = await fetch(u, { redirect: 'follow' });
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return { r, buf: Buffer.from(ab), nameUsed: nm };
      };

      let got = await tryFetchLogo(name);
      if (!got) {
        const aliases = await loadRadioLogoAliases();
        const aliasTarget = String(aliases?.[name] || aliases?.[String(name).toLowerCase()] || '').trim();
        if (aliasTarget && aliasTarget.toLowerCase() !== String(name).toLowerCase()) {
          got = await tryFetchLogo(aliasTarget);
        }
      }
      if (!got) return res.status(404).end('not found');

      const { r, buf, nameUsed } = got;
      await writeCachedRadioLogo(nameUsed || name, buf);
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      // Treat freshly fetched logos as cacheable for a full day to reduce repeat latency.
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(buf);
    } catch {
      return res.status(404).end('not found');
    }
  });

  app.get('/config/diagnostics/queue', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const ratingsEnabled = await isRatingsEnabled();
      const [{ stdout: qOut }, { stdout: sOut }, { stdout: cOut }, { stdout: cfOut }] = await Promise.all([
        execFileP('mpc', ['-h', mpdHost, '-f', '%position%\t%artist%\t%title%\t%album%\t%file%\t%name%', 'playlist']),
        execFileP('mpc', ['-h', mpdHost, 'status']),
        execFileP('mpc', ['-h', mpdHost, '-f', '%artist%\t%title%', 'current']),
        execFileP('mpc', ['-h', mpdHost, 'crossfade']),
      ]);
      const st = String(sOut || '');
      const m = st.match(/#(\d+)\/(\d+)/);
      const headPos = m ? Number(m[1] || 0) : -1;
      const randomOn = /random:\s*on/i.test(st);
      const repeatOn = /repeat:\s*on/i.test(st);
      const consumeOn = /consume:\s*on/i.test(st);
      const cfText = String(cfOut || '').trim();
      const mCf = cfText.match(/crossfade:\s*([0-9]+(?:\.[0-9]+)?)/i);
      const crossfadeSec = mCf ? Math.max(0, Math.min(10, Math.round(Number(mCf[1] || 0)))) : 0;
      const playbackState = /\[playing\]/i.test(st)
        ? 'playing'
        : (/\[paused\]/i.test(st) ? 'paused' : 'stopped');

      const currentLine = String(cOut || '').split(/\r?\n/).map((ln) => ln.trim()).find(Boolean) || '';
      const [curArtistRaw = '', curTitleRaw = ''] = currentLine.split('\t');
      const curClean = cleanIheartQueueMeta(curArtistRaw, curTitleRaw);
      const curSplit = splitArtistDashTitle(curClean.title);
      const currentArtist = String(curClean.artist || (curSplit?.artist || '')).trim();
      const currentTitle = String(curSplit?.title || curClean.title || '').trim();

      let stationMap = new Map();
      let recentRadioMap = new Map();
      let logoAliases = {};
      try { stationMap = await loadRadioCatalogMap(); } catch {}
      try { recentRadioMap = await loadRadioQueueMap(); } catch {}
      try { logoAliases = await loadRadioLogoAliases(); } catch {}

      const lines = String(qOut || '').split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);
      const ytHint = (typeof getYoutubeNowPlayingHint === 'function') ? (getYoutubeNowPlayingHint() || {}) : {};
      const ytHintFresh = (Date.now() - Number(ytHint?.setAt || 0)) < (6 * 60 * 60 * 1000);
      const items = [];
      for (const ln of lines) {
        const [position = '', artist = '', title = '', album = '', file = '', name = ''] = ln.split('\t');
        const pos = Number(position || 0);
        const f = String(file || '').trim();
        let rating = 0;
        if (ratingsEnabled && f && typeof getRatingForFile === 'function') {
          try { rating = Number(await getRatingForFile(f)) || 0; } catch {}
        }
        const cleaned = cleanIheartQueueMeta(artist, title);
        let artistTxt = String(cleaned.artist || '').trim();
        let titleTxt = String(cleaned.title || '').trim();
        const albumTxt = String(album || '').trim();
        const fKey = stationKey(f);
        const fHost = stationHost(f);
        const queueMeta = recentRadioMap.get(f) || recentRadioMap.get(`key:${fKey}`) || recentRadioMap.get(`host:${fHost}`) || {};
        const catMetaDirect = stationMap.get(f) || {};
        const catMetaKey = stationMap.get(fKey) || {};
        const catMetaHost = stationMap.get(`host:${fHost}`) || {};

        const aliasName = String(logoAliases?.[fKey] || logoAliases?.[fHost] || '').trim();
        let stationNameTxt = String(name || '').trim()
          || String(queueMeta.stationName || '').trim()
          || String(catMetaDirect.stationName || '').trim()
          || String(catMetaKey.stationName || '').trim()
          || String(catMetaHost.stationName || '').trim()
          || aliasName;
        const stationGenreTxt = String(queueMeta.genre || '').trim()
          || String(catMetaDirect.genre || '').trim()
          || String(catMetaKey.genre || '').trim()
          || String(catMetaHost.genre || '').trim();
        const stationFavorite = !!(queueMeta.isFavorite || catMetaDirect.isFavorite || catMetaKey.isFavorite || catMetaHost.isFavorite);

        const isStream = isStreamUrl(f);
        if (isStream && !stationNameTxt) {
          stationNameTxt = stationHost(f) || stationKey(f);
        }
        if (isStream) {
          const split = splitArtistDashTitle(titleTxt);
          if (split) {
            if (!artistTxt) artistTxt = String(split.artist || '').trim();
            titleTxt = String(split.title || titleTxt).trim();
          }
          if (pos === headPos) {
            if (!artistTxt && currentArtist) artistTxt = currentArtist;
            if (!titleTxt && currentTitle) titleTxt = currentTitle;
          }
        }
        const podcastBlob = `${f}\n${artistTxt}\n${titleTxt}\n${albumTxt}`.toLowerCase();
        const isPodcast = /\bpodcast\b/.test(podcastBlob) || /\/podcasts?\//.test(podcastBlob);
        const streamLogoName = stationNameTxt || albumTxt;
        const logoLooksHost = !!streamLogoName && /\./.test(streamLogoName) && !/\s/.test(streamLogoName);
        const stationLogo = (streamLogoName && !logoLooksHost)
          ? stationLogoUrlFromAlbum(streamLogoName)
          : (f ? `/art/radio-logo.jpg?file=${encodeURIComponent(f)}&v=20260924-radio-art2` : '');
        const streamArtFallback = String(cleaned.artUrl || '').trim();
        const isHead = Number.isFinite(pos) && pos === headPos;
        const ytStream = !!(isStream && /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(f));
        if (ytStream) {
          const byFile = (typeof getYoutubeQueueHint === 'function') ? (getYoutubeQueueHint(f) || null) : null;
          const hTitle = String(byFile?.title || (ytHintFresh ? ytHint?.title : '') || '').trim();
          const hChan = String(byFile?.channel || (ytHintFresh ? ytHint?.channel : '') || '').trim();
          if (hTitle) titleTxt = hTitle;
          if (hChan) artistTxt = hChan;
          stationNameTxt = String(artistTxt || titleTxt || 'YouTube').trim();
        }

        const thumbUrl = ytStream
          ? (String(((typeof getYoutubeQueueHint === 'function') ? (getYoutubeQueueHint(f)?.thumbnail || '') : '') || (ytHintFresh ? ytHint?.thumbnail : '') || '').trim() || '/art/current.jpg')
          : (isStream
              ? (stationLogo || streamArtFallback || (isHead ? '/art/current.jpg' : ''))
              : (f ? `/art/track_640.jpg?file=${encodeURIComponent(f)}` : ''));
        items.push({
          position: pos,
          isHead,
          isStream,
          isYoutube: ytStream,
          artist: artistTxt,
          title: titleTxt,
          album: albumTxt,
          stationName: radioDisplayName(stationNameTxt),
          stationGenre: stationGenreTxt,
          isFavoriteStation: stationFavorite,
          file: f,
          isPodcast,
          rating: Math.max(0, Math.min(5, Math.round(Number(rating) || 0))),
          thumbUrl,
        });
      }
      const queueItems = await enrichQueueSourceAudio(items, getSourceAudio);
      const queueFiles = queueItems.map((item) => String(item?.file || '').trim());
      reconcileShuffleUndo(queueFiles);
      const undoAvailable = !!liveQueueShuffleUndo
        && queueFingerprint(queueFiles) === queueFingerprint(liveQueueShuffleUndo.shuffledFiles);
      // Present the active track as the logical first queue item. MPD keeps
      // its real positions unchanged so remove/move actions remain safe; the
      // client still receives each item's original `position` for mutations.
      const currentIndex = queueItems.findIndex((item) => item?.isHead === true);
      const displayItems = currentIndex > 0
        ? [queueItems[currentIndex], ...queueItems.slice(currentIndex + 1), ...queueItems.slice(0, currentIndex)]
        : queueItems;
      return res.json({ ok: true, count: queueItems.length, headPos, randomOn, repeatOn, consumeOn, crossfadeSec, playbackState, ratingsEnabled, undoAvailable, items: displayItems });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
