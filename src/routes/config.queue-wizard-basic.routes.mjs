import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MPD_HOST, MOODE_SSH_HOST, MOODE_SSH, MPD_PLAYLIST_DIR } from '../config.mjs';
import { getBrowseIndex } from '../lib/browse-index.mjs';
import { radioDisplayName } from '../lib/radio-display.mjs';
import { isPodcastPlaylist } from '../lib/playlist-classification.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { readMoodeRadioCatalog, filterRadioCatalog } from '../lib/moode-radio-catalog.mjs';

const execFileP = promisify(execFile);
const RADIO_DB_SEP = '__NPSEP__';
const STATE_PATHS = runtimeStatePaths();
const RADIO_PRESETS_PATH = STATE_PATHS.radioQueuePresetsPath;
const PLAYLISTS_CACHE_PATH = STATE_PATHS.playlistIndexPath;

const OPTIONS_CACHE_TTL_MS = 5 * 60_000;
const PLAYLISTS_CACHE_TTL_MS = 45_000;
let optionsCache = { ts: 0, host: '', payload: null, inflight: null };
let playlistsCache = { ts: 0, host: '', payload: null, inflight: null, diskLoaded: false };

function shQuoteArg(s) {
  const v = String(s ?? '');
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

async function loadPlaylistsCacheFromDisk() {
  if (playlistsCache.diskLoaded) return;
  playlistsCache.diskLoaded = true;
  try {
    const raw = await fs.readFile(PLAYLISTS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(String(raw || '{}'));
    const ts = Number(parsed?.ts || 0) || 0;
    const payload = parsed?.payload;
    if (ts > 0 && payload?.ok && Array.isArray(payload?.playlists)) {
      playlistsCache.ts = ts;
      playlistsCache.payload = payload;
    }
  } catch {}
}

async function savePlaylistsCacheToDisk(payload) {
  try {
    await fs.mkdir(path.dirname(PLAYLISTS_CACHE_PATH), { recursive: true });
    await fs.writeFile(PLAYLISTS_CACHE_PATH, JSON.stringify({ ts: Date.now(), payload }), 'utf8');
  } catch {}
}

function stationKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return s.replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

function stationHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { return String(new URL(s).hostname || '').toLowerCase(); } catch { return ''; }
}

function toHttpsUrl(v = '') {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

function parseIheartLiveUrl(v = '') {
  const s = toHttpsUrl(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    const host = String(u.hostname || '').toLowerCase();
    if (!/(^|\.)iheart\.com$/.test(host)) return null;
    const path = String(u.pathname || '').trim();
    if (!/^\/live\//i.test(path)) return null;

    const clean = path.replace(/\/+$/, '');
    const lastSeg = decodeURIComponent(clean.split('/').filter(Boolean).pop() || '');
    const m = lastSeg.match(/^(.*?)-(\d+)$/);
    const slug = String((m?.[1] || lastSeg || '')).replace(/-/g, ' ').trim();
    const stationId = Number(m?.[2] || 0) || 0;
    return { originalUrl: s, stationId, slug };
  } catch {
    return null;
  }
}

function parseIheartRevmaStationId(v = '') {
  const s = toHttpsUrl(v);
  if (!s) return 0;
  try {
    const u = new URL(s);
    const host = String(u.hostname || '').toLowerCase();
    if (!/(^|\.)revma\.ihrhls\.com$/.test(host)) return 0;
    const m = String(u.pathname || '').match(/\/zc(\d+)(?:\/|$)/i);
    return Number(m?.[1] || 0) || 0;
  } catch {
    return 0;
  }
}

async function fetchIheartStationById(id) {
  const n = Number(id || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = await fetch(`https://api.iheart.com/api/v2/content/liveStations/${n}`, {
    headers: { 'User-Agent': 'now-playing-radio-browser/1.0' },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const hit = Array.isArray(j?.hits) ? j.hits[0] : null;
  return hit && typeof hit === 'object' ? hit : null;
}

function listIheartStreamCandidates(st = null) {
  const streams = st?.streams && typeof st.streams === 'object' ? st.streams : {};
  const order = [
    // MPD/moOde tends to be most reliable with direct shoutcast endpoints first.
    'secure_shoutcast_stream',
    'shoutcast_stream',
    'secure_hls_stream',
    'hls_stream',
    'secure_pls_stream',
    'pls_stream',
    'stw_stream',
  ];
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const u = toHttpsUrl(raw || '');
    if (u && !seen.has(u)) { out.push(u); seen.add(u); }
  };
  for (const k of order) add(streams?.[k] || '');
  for (const v of Object.values(streams || {})) add(v || '');

  // Fallbacks: StreamTheWorld redirect endpoints by call letters.
  const calls = String(st?.callLetters || st?.callletters || '').trim().toUpperCase();
  const cc = calls.replace(/[^A-Z0-9]/g, '');
  const stwIds = [calls, cc]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .flatMap((x) => [x, `${x}FM`, `${x}AM`, `${x}AAC`, `${x}FMAAC`, `${x}AMAAC`]);
  const uniqueIds = Array.from(new Set(stwIds));
  for (const id of uniqueIds) {
    add(`https://playerservices.streamtheworld.com/api/livestream-redirect/${id}.aac`);
    add(`https://playerservices.streamtheworld.com/api/livestream-redirect/${id}.m3u8`);
    add(`https://playerservices.streamtheworld.com/api/livestream-redirect/${id}.pls`);
  }

  return out;
}

async function isLikelyReachableStream(url = '') {
  const u = toHttpsUrl(url);
  if (!u) return false;
  try {
    const head = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'now-playing-radio-browser/1.0' } });
    if (head.status >= 200 && head.status < 400) return true;
  } catch {}
  try {
    const get = await fetch(u, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'now-playing-radio-browser/1.0', Range: 'bytes=0-1' } });
    if (get.status >= 200 && get.status < 400) return true;
  } catch {}
  return false;
}

function deriveIheartGenre(st = null) {
  const parts = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) parts.push(s);
  };
  const tags = st?.genres || st?.genre || st?.tags || '';
  if (Array.isArray(tags)) tags.forEach(push);
  else String(tags || '').split(/[;,|/]/).forEach(push);
  push(st?.description || '');

  const text = parts.join(' ').toLowerCase();
  const pick = (...keys) => keys.some((k) => text.includes(k));
  if (pick('top 40', 'chr', 'hit music', 'contemporary hit', 'pop')) return 'Pop / Top 40';
  if (pick('country')) return 'Country';
  if (pick('classic rock', 'alt rock', 'alternative', 'rock')) return 'Rock';
  if (pick('hip hop', 'r&b', 'urban', 'rap')) return 'Hip-Hop / R&B';
  if (pick('jazz', 'smooth jazz')) return 'Jazz';
  if (pick('news', 'talk', 'sports')) return 'Talk / News';

  const first = String(parts[0] || '').trim();
  return normalizeGenreLabel(first) || '';
}

async function resolveIheartLivePage(rawUrl = '', fallbackName = '') {
  const parsed = parseIheartLiveUrl(rawUrl);
  if (!parsed) return null;

  let station = null;
  if (parsed.stationId > 0) {
    station = await fetchIheartStationById(parsed.stationId);
  }

  if (!station) {
    const keywords = String(fallbackName || parsed.slug || '').trim();
    if (keywords) {
      const sUrl = new URL('https://api.iheart.com/api/v1/catalog/searchAll');
      sUrl.searchParams.set('keywords', keywords);
      const r = await fetch(sUrl.toString(), { headers: { 'User-Agent': 'now-playing-radio-browser/1.0' } });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const first = Array.isArray(j?.stations) ? j.stations[0] : null;
        if (first?.id) station = await fetchIheartStationById(first.id);
      }
    }
  }

  if (!station) {
    throw new Error('Could not resolve iHeart page to a playable stream URL');
  }

  const candidates = listIheartStreamCandidates(station);
  if (!candidates.length) throw new Error('iHeart station has no exposed direct stream URL');
  let streamUrl = '';
  for (const c of candidates) {
    if (await isLikelyReachableStream(c)) { streamUrl = c; break; }
  }
  if (!streamUrl) streamUrl = candidates[0] || '';
  if (!streamUrl) throw new Error('iHeart station has no usable direct stream URL');

  const home = toHttpsUrl(station?.website || station?.social?.website || parsed.originalUrl);
  const favicon = toHttpsUrl(station?.logo || station?.newlogo || station?.image || '');
  const genre = deriveIheartGenre(station);

  return {
    resolved: true,
    originalUrl: parsed.originalUrl,
    station: {
      name: String(station?.name || fallbackName || parsed.slug || 'iHeart Station').trim(),
      url: streamUrl,
      homepage: home,
      favicon,
      genre,
    },
  };
}

function normalizeGenreLabel(v = '') {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const keepUpper = new Set(['r&b', 'edm', 'dj', 'am', 'fm']);
  return lower
    .split(/\s+/)
    .map((w) => {
      if (keepUpper.has(w)) return w.toUpperCase();
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function isGenericStationName(v = '') {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return true;
  if (s === 'custom station') return true;
  if (s === 'stream revma ihrhls') return true;
  if (/^zc\d+$/i.test(s)) return true;
  if (/^stream\s+[a-z0-9.-]+$/i.test(s)) return true;
  return false;
}

function guessStationNameFromUrl(streamUrl = '') {
  const s = toHttpsUrl(streamUrl);
  if (!s) return '';
  try {
    const u = new URL(s);
    const host = String(u.hostname || '').replace(/^www\./i, '').toLowerCase();
    const pathBits = String(u.pathname || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
    const mount = String(pathBits[pathBits.length - 1] || '').toLowerCase();

    // Host-aware improvements
    if (host.includes('somafm.com') && mount) {
      const channel = mount
        .replace(/\.(mp3|aac|ogg|opus|m3u|pls)$/i, '')
        .replace(/[-_]?\d+\s*(k|kbps)?$/i, '')
        .replace(/[-_](mp3|aac|ogg|opus)$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (channel) {
        const pretty = channel
          .split(/\s+/)
          .map((w) => w ? (w.charAt(0).toUpperCase() + w.slice(1)) : '')
          .join(' ')
          .replace(/\bFm\b/g, 'FM');
        return `SomaFM: ${pretty}`;
      }
      return 'SomaFM';
    }

    // Generic mountpoint-based fallback (often better than hostname)
    if (mount) {
      const cleanMount = mount
        .replace(/\.(mp3|aac|ogg|opus|m3u|pls)$/i, '')
        .replace(/[-_]?\d+\s*(k|kbps)?$/i, '')
        .replace(/[-_](mp3|aac|ogg|opus)$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleanMount && cleanMount.length >= 3) {
        return cleanMount
          .split(/\s+/)
          .map((w) => w ? (w.charAt(0).toUpperCase() + w.slice(1)) : '')
          .join(' ')
          .replace(/\bFm\b/g, 'FM');
      }
    }

    const stem = host.split('.').slice(0, -1).join('.') || host;
    return stem
      .split(/[-_.]+/)
      .map((w) => w ? (w.charAt(0).toUpperCase() + w.slice(1)) : '')
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

function guessFaviconFromUrl(streamUrl = '', homepage = '') {
  const hp = toHttpsUrl(homepage);
  if (hp) {
    try {
      const hu = new URL(hp);
      return `${hu.origin}/favicon.ico`;
    } catch {}
  }
  const s = toHttpsUrl(streamUrl);
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.origin}/favicon.ico`;
  } catch {
    return '';
  }
}

async function readRadioPresetsFile() {
  try {
    const raw = await fs.readFile(RADIO_PRESETS_PATH, 'utf8');
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeRadioPresetsFile(list = []) {
  const arr = Array.isArray(list) ? list : [];
  await fs.mkdir(path.dirname(RADIO_PRESETS_PATH), { recursive: true });
  const tmp = `${RADIO_PRESETS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf8');
  await fs.rename(tmp, RADIO_PRESETS_PATH);
}

async function queryMoodeRadioDb(sql) {
  const host = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
  const dbPath = '/var/local/www/db/moode-sqlite3.db';
  const remoteCmd = `sqlite3 -separator ${RADIO_DB_SEP} ${dbPath} ${shQuoteArg(String(sql || ''))}`;
  const { stdout } = await execFileP('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    `moode@${host}`,
    remoteCmd,
  ], {
    timeout: 12000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout || '');
}

async function saveMoodeRadioLogo({ stationName, faviconUrl }) {
  const name = String(stationName || '').trim();
  const fav = toHttpsUrl(faviconUrl || '');
  if (!name || !fav) return { ok: false, reason: 'missing name or favicon' };

  const host = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
  const localTmpDir = runtimeStatePaths().temporaryDir;
  await fs.mkdir(localTmpDir, { recursive: true });

  const base = `rb_logo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const srcPath = path.join(localTmpDir, `${base}.img`);
  const jpgPath = path.join(localTmpDir, `${base}.jpg`);
  const remoteTmp = `/tmp/${base}.jpg`;
  const remoteFinal = `/var/local/www/imagesw/radio-logos/${name}.jpg`;
  const remoteThumb = `/var/local/www/imagesw/radio-logos/thumbs/${name}.jpg`;
  const remoteThumbSm = `/var/local/www/imagesw/radio-logos/thumbs/${name}_sm.jpg`;

  try {
    const r = await fetch(fav, { headers: { 'User-Agent': 'now-playing-radio-browser/1.0' } });
    if (!r.ok) return { ok: false, reason: `favicon http ${r.status}` };
    const ab = await r.arrayBuffer();
    await fs.writeFile(srcPath, Buffer.from(ab));

    await execFileP('ffmpeg', ['-y', '-i', srcPath, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-q:v', '3', jpgPath], {
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
    });

    await execFileP('scp', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      jpgPath,
      `moode@${host}:${remoteTmp}`,
    ], {
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
    });

    await execFileP('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      `moode@${host}`,
      `sudo mkdir -p /var/local/www/imagesw/radio-logos /var/local/www/imagesw/radio-logos/thumbs && ` +
      `sudo mv ${shQuoteArg(remoteTmp)} ${shQuoteArg(remoteFinal)} && ` +
      `sudo cp -f ${shQuoteArg(remoteFinal)} ${shQuoteArg(remoteThumb)} && ` +
      `sudo cp -f ${shQuoteArg(remoteFinal)} ${shQuoteArg(remoteThumbSm)} && ` +
      `sudo chmod 644 ${shQuoteArg(remoteFinal)} ${shQuoteArg(remoteThumb)} ${shQuoteArg(remoteThumbSm)} && ` +
      `sudo chown root:root ${shQuoteArg(remoteFinal)} ${shQuoteArg(remoteThumb)} ${shQuoteArg(remoteThumbSm)}`,
    ], {
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
    });

    return { ok: true, path: remoteThumb };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    await fs.unlink(srcPath).catch(() => {});
    await fs.unlink(jpgPath).catch(() => {});
  }
}

export function registerConfigQueueWizardBasicRoutes(app, deps) {
  const { requireTrackKey, readRadioCatalog = readMoodeRadioCatalog } = deps;
  const catalogUnavailable = res => res.status(503).json({ ok: false, code: 'RADIO_CATALOG_UNAVAILABLE', error: 'Radio catalog unavailable. Check the moOde connection and retry.' });

  // --- queue wizard options (artists/genres) ---
  app.get('/config/queue-wizard/options', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const now = Date.now();
      if (optionsCache.payload && optionsCache.host === mpdHost && (now - optionsCache.ts) < OPTIONS_CACHE_TTL_MS) {
        return res.json(optionsCache.payload);
      }
      if (optionsCache.inflight && optionsCache.host === mpdHost) {
        const payload = await optionsCache.inflight;
        return res.json(payload);
      }

      optionsCache.host = mpdHost;
      optionsCache.inflight = (async () => {
        const idx = await getBrowseIndex(mpdHost);
        const genres = new Set();
        for (const t of Array.isArray(idx?.tracks) ? idx.tracks : []) {
          for (const g of String(t?.genre || '').split(/[;,|/]/).map((x)=>String(x||'').trim()).filter(Boolean)) genres.add(g);
        }
        const albums = (Array.isArray(idx?.albums) ? idx.albums : []).map((a)=>({
          value: String(a?.album || ''),
          label: String(a?.artist || '').trim() ? `${String(a.artist)} — ${String(a.album || '')}` : String(a?.album || ''),
        }));
        const tracks = (Array.isArray(idx?.tracks) ? idx.tracks : []).map((t)=>({
          // Use the file as the value so identical title tags remain distinct and actionable.
          value: String(t?.file || ''),
          label: String(t?.title || '').trim(),
          artist: String(t?.artist || t?.albumArtist || '').trim(),
          album: String(t?.album || '').trim(),
        })).filter((t)=>t.value && t.label);

        return {
          ok: true,
          moodeHost: String(MOODE_SSH_HOST || MPD_HOST || 'moode.local'),
          genres: Array.from(genres).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
          artists: (Array.isArray(idx?.artists) ? idx.artists : []).map((a)=>String(a?.name || '')).filter(Boolean),
          albums,
          tracks,
          browseIndex: { builtAt: String(idx?.builtAt || ''), counts: idx?.counts || {} },
        };
      })();

      const payload = await optionsCache.inflight;
      optionsCache.payload = payload;
      optionsCache.ts = Date.now();
      optionsCache.inflight = null;
      return res.json(payload);
    } catch (e) {
      optionsCache.inflight = null;
      if (optionsCache.payload && optionsCache.host === String(MPD_HOST || 'moode.local')) {
        return res.json({ ...optionsCache.payload, stale: true, staleReason: e?.message || String(e) });
      }
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/queue-wizard/playlists', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      await loadPlaylistsCacheFromDisk();
      if (!playlistsCache.host) playlistsCache.host = mpdHost;
      const now = Date.now();
      if (playlistsCache.payload && playlistsCache.host === mpdHost && (now - playlistsCache.ts) < PLAYLISTS_CACHE_TTL_MS) {
        return res.json(playlistsCache.payload);
      }
      if (playlistsCache.inflight && playlistsCache.host === mpdHost) {
        const payload = await playlistsCache.inflight;
        return res.json(payload);
      }

      playlistsCache.host = mpdHost;
      playlistsCache.inflight = (async () => {
        const { stdout } = await execFileP('mpc', ['-h', mpdHost, 'lsplaylists']);
        const names = String(stdout || '')
          .split(/\r?\n/)
          .map((x) => String(x || '').trim())
          .filter(Boolean);

        const kept = [];
        for (const name of names) {
          if (isPodcastPlaylist(name)) continue;
          let skip = false;
          try {
            const r = await execFileP('mpc', ['-h', mpdHost, '-f', '%file%', 'playlist', name], { maxBuffer: 8 * 1024 * 1024 });
            const files = String(r?.stdout || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
            if (isPodcastPlaylist(name, files)) skip = true;
          } catch (_) {
            // if inspection fails, keep name rather than hiding unexpectedly
          }
          if (!skip) kept.push(name);
        }

        const withTs = await Promise.all(kept.map(async (name) => {
          const filePath = path.join(MPD_PLAYLIST_DIR, `${String(name || '').trim()}.m3u`);
          try {
            const st = await fs.stat(filePath);
            const tsLocal = Number(st?.mtimeMs || 0) || 0;
            if (tsLocal > 0) return { name, ts: tsLocal };
          } catch {}

          // Fallback: try moOde playlist-cover mtime over SSH when local m3u timestamp is unavailable.
          // This helps Recent Playlists ordering on hosts where playlists live remotely.
          try {
            const sshHost = String(MOODE_SSH || MOODE_SSH_HOST || mpdHost || '').trim();
            if (!sshHost) return { name, ts: 0 };
            const raw = String(name || '').trim();
            const safe = raw.replace(/\s+/g, '_');
            const c1 = `/var/local/www/imagesw/playlist-covers/${raw}.jpg`;
            const c2 = `/var/local/www/imagesw/playlist-covers/${safe}.jpg`;
            const cmd = `bash -lc 'set -e; p1=${shQuoteArg(c1)}; p2=${shQuoteArg(c2)}; ts=0; if [ -f "$p1" ]; then ts=$(stat -c %Y "$p1" 2>/dev/null || stat -f %m "$p1" 2>/dev/null || echo 0); fi; if [ "$ts" = "0" ] && [ -f "$p2" ]; then ts=$(stat -c %Y "$p2" 2>/dev/null || stat -f %m "$p2" 2>/dev/null || echo 0); fi; echo "$ts"'`;
            const r = await execFileP('ssh', ['-o', 'BatchMode=yes', sshHost, cmd], { timeout: 2200, maxBuffer: 256 * 1024 });
            const sec = Number(String(r?.stdout || '').trim()) || 0;
            return { name, ts: sec > 0 ? sec * 1000 : 0 };
          } catch {
            return { name, ts: 0 };
          }
        }));

        const playlists = withTs
          .sort((a, b) => {
            if (b.ts !== a.ts) return b.ts - a.ts; // reverse-chrono by mtime
            return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
          })
          .map((x) => x.name);

        return { ok: true, count: playlists.length, playlists };
      })();

      const payload = await playlistsCache.inflight;
      playlistsCache.payload = payload;
      playlistsCache.ts = Date.now();
      playlistsCache.inflight = null;
      await savePlaylistsCacheToDisk(payload);
      return res.json(payload);
    } catch (e) {
      playlistsCache.inflight = null;
      if (playlistsCache.payload && playlistsCache.host === String(MPD_HOST || 'moode.local')) {
        return res.json({ ...playlistsCache.payload, stale: true, staleReason: e?.message || String(e) });
      }
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/queue-wizard/load-playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const playlist = String(req.body?.playlist || '').trim();
      const mode = String(req.body?.mode || 'replace').trim().toLowerCase();
      const play = req.body?.play !== false;
      if (!playlist) return res.status(400).json({ ok: false, error: 'playlist is required' });
      if (!['replace', 'append'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be replace|append' });

      const trackKey = String(req.headers['x-track-key'] || '').trim();
      const sshHost = String(MOODE_SSH_HOST || mpdHost || 'moode.local').trim();
      const manifestName = `${playlist}.youtube.json`;
      let manifest = null;
      try {
        const cmd = `cat ${shQuoteArg(`${MPD_PLAYLIST_DIR}/${manifestName}`)}`;
        const { stdout } = await execFileP('ssh', [`moode@${sshHost}`, cmd], { timeout: 15000, maxBuffer: 3 * 1024 * 1024 });
        const parsed = JSON.parse(String(stdout || '{}'));
        if (parsed && Array.isArray(parsed.entries) && parsed.entries.length) manifest = parsed;
      } catch {}

      if (mode === 'replace') {
        await execFileP('mpc', ['-h', mpdHost, 'clear']);
      }

      let usedManifest = false;
      let rebuiltYoutube = 0;
      let startedPlaybackEarly = false;
      if (manifest?.entries?.length) {
        usedManifest = true;
        for (const ent of manifest.entries) {
          const t = String(ent?.type || '').trim().toLowerCase();
          const f = String(ent?.file || '').trim();
          const src = String(ent?.sourceUrl || '').trim();
          if (t === 'youtube' && src) {
            const ytMode = (!startedPlaybackEarly && play && mode === 'replace') ? 'replace' : 'append';
            const r = await fetch('http://127.0.0.1:3101/youtube/queue', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(trackKey ? { 'x-track-key': trackKey } : {}) },
              body: JSON.stringify({ url: src, mode: ytMode }),
            });
            const j = await r.json().catch(() => ({}));
            if (r.ok && j?.ok) {
              rebuiltYoutube += 1;
              if (ytMode === 'replace') startedPlaybackEarly = true;
            }
            continue;
          }
          if (f) {
            try {
              if (!startedPlaybackEarly && play && mode === 'replace') {
                await execFileP('mpc', ['-h', mpdHost, 'add', f]);
                await execFileP('mpc', ['-h', mpdHost, 'play']);
                startedPlaybackEarly = true;
              } else {
                await execFileP('mpc', ['-h', mpdHost, 'add', f]);
              }
            } catch {}
          }
        }
      } else {
        await execFileP('mpc', ['-h', mpdHost, 'load', playlist]);
      }

      if (play && !startedPlaybackEarly) {
        await execFileP('mpc', ['-h', mpdHost, 'play']);
      }
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, 'playlist']);
      const added = String(stdout || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean).length;
      return res.json({ ok: true, playlist, mode, play, added, usedManifest, rebuiltYoutube });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/queue-wizard/delete-playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const playlist = String(req.body?.playlist || '').trim();
      if (!playlist) return res.status(400).json({ ok: false, error: 'playlist is required' });

      await execFileP('mpc', ['-h', mpdHost, 'rm', playlist]);
      playlistsCache.ts = 0;
      playlistsCache.payload = null;
      return res.json({ ok: true, deleted: playlist });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/queue-wizard/playlist-preview', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const playlist = String(req.query?.playlist || '').trim();
      if (!playlist) return res.status(400).json({ ok: false, error: 'playlist is required' });

      const fmt = '%artist%\t%title%\t%album%\t%file%';
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', fmt, 'playlist', playlist]);
      const tracks = String(stdout || '')
        .split(/\r?\n/)
        .map((ln) => String(ln || '').trim())
        .filter(Boolean)
        .map((ln) => {
          const [artist = '', title = '', album = '', file = ''] = ln.split('\t');
          const f = String(file || '').trim();
          const t = String(title || '').trim() || (f ? path.basename(f) : '');
          return {
            artist: String(artist || '').trim(),
            title: t,
            album: String(album || '').trim(),
            file: f,
          };
        })
        .filter((x) => x.file);

      return res.json({ ok: true, playlist, count: tracks.length, tracks });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/radio-browser/search', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const q = String(req.query?.q || '').trim();
      const country = String(req.query?.country || '').trim();
      const tag = String(req.query?.tag || '').trim();
      const tagNorm = tag.toLowerCase();
      const codec = String(req.query?.codec || '').trim();
      const hqOnly = ['1', 'true', 'yes'].includes(String(req.query?.hqOnly || '').toLowerCase());
      const excludeExisting = ['1', 'true', 'yes'].includes(String(req.query?.excludeExisting || '').toLowerCase());
      const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 30)));
      const apiLimit = Math.max(limit, Math.min(300, hqOnly ? limit * 4 : limit));

      const useTagFastPath = !q && !!tagNorm && !country && !codec;
      const u = useTagFastPath
        ? new URL(`https://de1.api.radio-browser.info/json/stations/bytag/${encodeURIComponent(tagNorm)}`)
        : new URL('https://de1.api.radio-browser.info/json/stations/search');
      if (q) u.searchParams.set('name', q);
      if (country) u.searchParams.set('countrycode', country);
      if (tagNorm && !useTagFastPath) u.searchParams.set('tag', tagNorm);
      if (codec) u.searchParams.set('codec', codec);
      u.searchParams.set('hidebroken', 'true');
      u.searchParams.set('order', 'votes');
      u.searchParams.set('reverse', 'true');
      u.searchParams.set('limit', String(apiLimit));

      const r = await fetch(u.toString(), { headers: { 'User-Agent': 'now-playing-radio-browser/1.0' } });
      const arr = await r.json().catch(() => ([]));
      if (!r.ok) return res.status(502).json({ ok: false, error: `radio-browser HTTP ${r.status}` });

      const isHq = (codecVal, bitrateVal) => {
        const fmt = String(codecVal || '').toUpperCase();
        const br = Number(bitrateVal || 0) || 0;
        const isLossless = /(FLAC|ALAC|WAV|AIFF|PCM)/i.test(fmt);
        if (isLossless) return true;
        if (/OPUS/i.test(fmt)) return br >= 128;
        if (/(MP3|AAC)/i.test(fmt)) return br >= 320;
        return br >= 320;
      };

      let stations = (Array.isArray(arr) ? arr : []).map((s) => ({
        id: String(s?.stationuuid || ''),
        name: String(s?.name || '').trim(),
        url: toHttpsUrl(String(s?.url_resolved || s?.url || '')),
        homepage: toHttpsUrl(String(s?.homepage || '')),
        favicon: toHttpsUrl(String(s?.favicon || '')),
        country: String(s?.countrycode || s?.country || '').trim(),
        tags: String(s?.tags || '').split(',').map((x) => String(x || '').trim()).filter(Boolean),
        codec: String(s?.codec || '').trim(),
        bitrate: Number(s?.bitrate || 0) || 0,
        votes: Number(s?.votes || 0) || 0,
        source: 'radiobrowser',
      }))
        .filter((s) => s.url && s.name)
        .filter((s) => !hqOnly || isHq(s.codec, s.bitrate));

      if (excludeExisting) {
        const existingRows = (await readRadioCatalog()).map(({ station, name }) => ({
          station: station.trim(), name: name.trim().toLowerCase(), key: stationKey(station), host: stationHost(station),
        }));

        const keySet = new Set(existingRows.map((r) => r.key).filter(Boolean));
        const hostNameSet = new Set(existingRows.map((r) => `${r.host}::${r.name}`).filter((x) => !x.startsWith('::')));

        stations = stations.filter((s) => {
          const sKey = stationKey(s.url);
          if (sKey && keySet.has(sKey)) return false;
          const sHost = stationHost(s.url);
          const sName = String(s.name || '').trim().toLowerCase();
          if (sHost && sName && hostNameSet.has(`${sHost}::${sName}`)) return false;
          return true;
        });
      }

      stations = stations.slice(0, limit);
      return res.json({ ok: true, count: stations.length, stations });
    } catch (e) {
      if (e?.code === 'RADIO_CATALOG_UNAVAILABLE') return catalogUnavailable(res);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/radio-browser/probe', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const rawUrl = toHttpsUrl(req.body?.url || req.body?.file || '');
      if (!rawUrl) return res.status(400).json({ ok: false, error: 'valid url is required' });
      const requestedName = String(req.body?.name || '').trim();

      const iheartResolved = await resolveIheartLivePage(rawUrl, requestedName).catch((err) => ({ error: err }));
      if (iheartResolved?.error) {
        return res.status(400).json({ ok: false, error: iheartResolved.error?.message || 'Could not resolve iHeart URL' });
      }

      let station = iheartResolved?.resolved
        ? iheartResolved.station
        : {
            name: requestedName || guessStationNameFromUrl(rawUrl) || 'Custom Station',
            url: rawUrl,
            homepage: toHttpsUrl(req.body?.homepage || ''),
            favicon: toHttpsUrl(req.body?.favicon || ''),
          };

      // If user pasted a direct iHeart revma URL, enrich name/logo via station id.
      if (!iheartResolved?.resolved) {
        const sid = parseIheartRevmaStationId(rawUrl);
        if (sid > 0) {
          const meta = await fetchIheartStationById(sid).catch(() => null);
          if (meta) {
            const resolvedName = String(meta?.name || '').trim();
            const keepUserName = requestedName && !isGenericStationName(requestedName);
            station = {
              name: keepUserName ? requestedName : (resolvedName || station.name),
              url: station.url,
              homepage: toHttpsUrl(meta?.website || station.homepage || ''),
              favicon: toHttpsUrl(meta?.logo || meta?.newlogo || station.favicon || ''),
              genre: String(station?.genre || deriveIheartGenre(meta) || '').trim(),
            };
          }
        }
      }

      const homepage = toHttpsUrl(station?.homepage || '');
      const guessedFavicon = toHttpsUrl(station?.favicon || '') || guessFaviconFromUrl(station?.url || '', homepage);
      return res.json({
        ok: true,
        station: {
          name: String(station?.name || '').trim() || 'Custom Station',
          url: toHttpsUrl(station?.url || ''),
          homepage,
          favicon: guessedFavicon,
          genre: String(station?.genre || '').trim(),
        },
        adapted: !!iheartResolved?.resolved,
        adaptedFrom: iheartResolved?.originalUrl || '',
        adaptedTo: String(station?.url || ''),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/radio-browser/preview', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const url = toHttpsUrl(req.body?.url || req.body?.file || '');
      if (!url) return res.status(400).json({ ok: false, error: 'valid url is required' });
      const mpdHost = String(MPD_HOST || 'moode.local');
      await execFileP('mpc', ['-h', mpdHost, 'clear']);
      await execFileP('mpc', ['-h', mpdHost, 'add', url]);
      await execFileP('mpc', ['-h', mpdHost, 'play']);
      return res.json({ ok: true, url, playing: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/radio-browser/add', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const station = toHttpsUrl(req.body?.url || req.body?.station || '');
      const name = String(req.body?.name || '').trim();
      if (!station || !name) return res.status(400).json({ ok: false, error: 'name and valid url required' });
      const genre = String((Array.isArray(req.body?.tags) ? req.body.tags.join(', ') : req.body?.genre) || '').trim();
      const bitrate = String(req.body?.bitrate || '').trim();
      const format = String(req.body?.codec || req.body?.format || '').trim();
      const favorite = !!req.body?.favorite;
      const homepage = toHttpsUrl(req.body?.homepage || '');
      const favicon = toHttpsUrl(req.body?.favicon || '') || guessFaviconFromUrl(station, homepage);

      const check = await queryMoodeRadioDb(`select rowid,station,name,type,genre from cfg_radio where station=${shQuoteArg(station)} limit 1;`);
      let row = String(check || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';

      if (!row) {
        const all = await queryMoodeRadioDb('select rowid,station,name,type,genre from cfg_radio;');
        const wantedKey = stationKey(station);
        const wantedHost = stationHost(station);
        const rows = String(all || '').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean).map((ln) => {
          const [rowid='', st='', nm='', type='', genreDb=''] = ln.split(RADIO_DB_SEP);
          return { rowid: Number(rowid)||0, station: String(st||''), name: String(nm||''), type: String(type||''), genre: String(genreDb||'') };
        }).filter((r) => r.rowid > 0 && r.station);

        const exactKey = rows.find((r) => stationKey(r.station) === wantedKey);
        let chosen = exactKey || null;
        if (!chosen && wantedHost) {
          const byHost = rows.filter((r) => stationHost(r.station) === wantedHost);
          if (byHost.length === 1) chosen = byHost[0];
        }
        if (chosen) row = `${chosen.rowid}${RADIO_DB_SEP}${chosen.station}${RADIO_DB_SEP}${chosen.name}${RADIO_DB_SEP}${chosen.type}${RADIO_DB_SEP}${chosen.genre || ''}`;
      }

      if (row) {
        const [rowid='', foundStation='', foundName='', oldType='', foundGenre=''] = row.split(RADIO_DB_SEP);
        const rowNum = Number(rowid) || 0;

        // Keep existing entries fresh: if caller has a better resolved name, update it.
        const incomingName = String(name || '').trim();
        const existingName = String(foundName || '').trim();
        if (rowNum > 0 && incomingName && incomingName.toLowerCase() !== existingName.toLowerCase()) {
          await queryMoodeRadioDb(`update cfg_radio set name=${shQuoteArg(incomingName)} where rowid=${rowNum};`);
        }

        const incomingGenre = String(genre || '').trim();
        const existingGenre = String(foundGenre || '').trim();
        if (rowNum > 0 && incomingGenre && incomingGenre.toLowerCase() !== existingGenre.toLowerCase()) {
          await queryMoodeRadioDb(`update cfg_radio set genre=${shQuoteArg(incomingGenre)} where rowid=${rowNum};`);
        }

        if (favorite && String(oldType || '').toLowerCase() !== 'f') {
          await queryMoodeRadioDb(`update cfg_radio set type='f' where rowid=${rowNum};`);
        }

        const effectiveName = incomingName || existingName || name;
        // Save logo under both the existing and effective names to survive rename/caching gaps.
        const logoTargets = Array.from(new Set([String(effectiveName || '').trim(), String(existingName || '').trim()].filter(Boolean)));
        let logoOk = false;
        let logoInfo = '';
        for (const nm of logoTargets) {
          const lg = await saveMoodeRadioLogo({ stationName: nm, faviconUrl: favicon });
          logoOk = logoOk || !!lg?.ok;
          if (!logoInfo) logoInfo = String(lg?.reason || lg?.path || '');
        }
        if (rowNum > 0 && logoOk) {
          await queryMoodeRadioDb(`update cfg_radio set logo='local' where rowid=${rowNum};`);
        }
        return res.json({ ok: true, added: false, alreadyExists: true, station: String(foundStation||station), stationName: effectiveName, favorite: favorite || String(oldType||'').toLowerCase()==='f', logoSaved: logoOk, logoInfo });
      }

      const type = favorite ? 'f' : 'r';
      await queryMoodeRadioDb(`insert into cfg_radio(station,name,genre,bitrate,format,type) values(${shQuoteArg(station)},${shQuoteArg(name)},${shQuoteArg(genre)},${shQuoteArg(bitrate)},${shQuoteArg(format)},${shQuoteArg(type)});`);
      const logoTargets = Array.from(new Set([
        String(name || '').trim(),
        String(name || '').replace(/\s+/g, ' ').trim(),
      ].filter(Boolean)));
      let logoOk = false;
      let logoInfo = '';
      for (const nm of logoTargets) {
        const lg = await saveMoodeRadioLogo({ stationName: nm, faviconUrl: favicon });
        logoOk = logoOk || !!lg?.ok;
        if (!logoInfo) logoInfo = String(lg?.reason || lg?.path || '');
      }
      if (logoOk) {
        await queryMoodeRadioDb(`update cfg_radio set logo='local' where station=${shQuoteArg(station)};`);
      }
      return res.json({ ok: true, added: true, station, name, favorite: type === 'f', logoSaved: logoOk, logoInfo });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/queue-wizard/radio-options', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const catalog = await readRadioCatalog();
      const genresByKey = new Map();
      for (const row of catalog) {
        const gRaw = row.genre.trim();
        if (!gRaw) continue;
        for (const g of gRaw.split(/[;,|/]/).map((x) => String(x || '').trim()).filter(Boolean)) {
          const key = String(g || '').toLowerCase();
          if (!key) continue;
          if (!genresByKey.has(key)) genresByKey.set(key, normalizeGenreLabel(g));
        }
      }
      return res.json({
        ok: true,
        genres: Array.from(genresByKey.values()).sort((a,b)=>a.localeCompare(b, undefined, { sensitivity:'base'})),
      });
    } catch (e) {
      return catalogUnavailable(res);
    }
  });

  app.get('/config/queue-wizard/radio-favorites', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const favorites = (await readRadioCatalog()).filter(row => row.type.toLowerCase() === 'f').map(({ station, name, genre, bitrate, format, type }) => {
        return {
          file: String(station || '').trim(),
          stationName: radioDisplayName(name),
          genre: String(genre || '').trim(),
          bitrate: String(bitrate || '').trim(),
          format: String(format || '').trim(),
          radioType: String(type || '').trim(),
        };
      }).filter((x)=>x.file);
      return res.json({ ok: true, count: favorites.length, favorites });
    } catch (e) {
      return catalogUnavailable(res);
    }
  });

  app.post('/config/queue-wizard/radio-delete', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const station = String(req.body?.station || req.body?.file || '').trim();
      if (!station) return res.status(400).json({ ok: false, error: 'station is required' });

      let out = await queryMoodeRadioDb(`select rowid,station,name from cfg_radio where station=${shQuoteArg(station)} limit 1;`);
      let row = String(out || '').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean)[0] || '';

      if (!row) {
        out = await queryMoodeRadioDb('select rowid,station,name from cfg_radio;');
        const wantedKey = stationKey(station);
        const wantedHost = stationHost(station);
        const rows = String(out || '').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean).map((ln) => {
          const [rowid='', st='', name=''] = ln.split(RADIO_DB_SEP);
          return { rowid: Number(rowid)||0, station: String(st||''), name: String(name||'') };
        }).filter((r) => r.rowid > 0 && r.station);
        const exactKey = rows.find((r) => stationKey(r.station) === wantedKey);
        let chosen = exactKey || null;
        if (!chosen && wantedHost) {
          const byHost = rows.filter((r) => stationHost(r.station) === wantedHost);
          if (byHost.length === 1) chosen = byHost[0];
        }
        if (chosen) row = `${chosen.rowid}${RADIO_DB_SEP}${chosen.station}${RADIO_DB_SEP}${chosen.name}`;
      }

      if (!row) return res.status(404).json({ ok: false, error: 'station not found in cfg_radio' });
      const [rowid='', foundStation='', name=''] = row.split(RADIO_DB_SEP);
      await queryMoodeRadioDb(`delete from cfg_radio where rowid=${Number(rowid)||0};`);
      return res.json({ ok: true, deleted: true, station: String(foundStation||station), stationName: String(name||'').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/queue-wizard/radio-favorite', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const station = String(req.body?.station || req.body?.file || '').trim();
      const favorite = req.body?.favorite !== false;
      if (!station) return res.status(400).json({ ok: false, error: 'station is required' });

      let row = '';
      let out = await queryMoodeRadioDb(`select rowid,station,name,type from cfg_radio where station=${shQuoteArg(station)} limit 1;`);
      row = String(out || '').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean)[0] || '';

      if (!row) {
        out = await queryMoodeRadioDb('select rowid,station,name,type from cfg_radio;');
        const wantedKey = stationKey(station);
        const wantedHost = stationHost(station);
        const rows = String(out || '').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean).map((ln) => {
          const [rowid='', st='', name='', type=''] = ln.split(RADIO_DB_SEP);
          return { rowid: Number(rowid)||0, station: String(st||''), name: String(name||''), type: String(type||'') };
        }).filter((r) => r.rowid > 0 && r.station);

        const exactKey = rows.find((r) => stationKey(r.station) === wantedKey);
        let chosen = exactKey || null;
        if (!chosen && wantedHost) {
          const byHost = rows.filter((r) => stationHost(r.station) === wantedHost);
          if (byHost.length === 1) chosen = byHost[0];
        }
        if (chosen) row = `${chosen.rowid}${RADIO_DB_SEP}${chosen.station}${RADIO_DB_SEP}${chosen.name}${RADIO_DB_SEP}${chosen.type}`;
      }

      if (!row) return res.status(404).json({ ok: false, error: 'station not found in cfg_radio' });
      const [rowid='', foundStation='', name='', oldType=''] = row.split(RADIO_DB_SEP);
      const oldT = String(oldType || '').trim().toLowerCase();
      let nextType = oldT || 'r';
      if (favorite) nextType = 'f';
      else nextType = (oldT === 'f') ? 'r' : (oldT || 'r');
      await queryMoodeRadioDb(`update cfg_radio set type=${shQuoteArg(nextType)} where rowid=${Number(rowid)||0};`);
      return res.json({ ok: true, station: String(foundStation||station), stationName: String(name||'').trim(), favorite: nextType === 'f', oldType: oldT, newType: nextType });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/queue-wizard/radio-preview', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const genres = Array.isArray(req.body?.genres) ? req.body.genres.map((x)=>String(x||'').trim()).filter(Boolean) : [];
      const favoritesOnly = !!req.body?.favoritesOnly;
      const hqOnly = !!req.body?.hqOnly;
      const maxStations = Math.max(1, Math.min(2000, Number(req.body?.maxStations || 500)));

      const favoriteStations = Array.isArray(req.body?.favoriteStations)
        ? req.body.favoriteStations.map(x => String(x || '').trim()).filter(Boolean) : [];
      const catalog = filterRadioCatalog(await readRadioCatalog(), { genres, favoritesOnly, hqOnly, favoriteStations, maxStations });
      const tracks = catalog.map(({ station, name, genre, bitrate, format, type }) => {
        const logoName = String(name || '').trim();
        const stationName = radioDisplayName(logoName) || 'Radio Station';
        const file = String(station || '').trim();
        return {
          artist: stationName,
          title: '',
          album: stationName,
          stationName,
          // Keep the provider/catalog spelling for logo lookup. The display
          // name intentionally strips prefixes such as "iHeart", but moOde
          // stores those prefixes in the corresponding logo filename.
          logoName: logoName || stationName,
          genre: String(genre || '').trim(),
          bitrate: String(bitrate || '').trim(),
          format: String(format || '').trim(),
          radioType: String(type || '').trim(),
          isFavoriteStation: String(type || '').trim().toLowerCase() === 'f',
          file,
          isStream: true,
        };
      }).filter((x)=>x.file);

      return res.json({ ok: true, count: tracks.length, tracks });
    } catch (e) {
      return catalogUnavailable(res);
    }
  });

  app.get('/config/queue-wizard/radio-presets', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const presets = await readRadioPresetsFile();
      return res.json({ ok: true, presets });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/queue-wizard/radio-presets', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const name = String(req.body?.name || '').trim();
      const stationsIn = Array.isArray(req.body?.stations) ? req.body.stations : [];
      if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

      const stations = stationsIn
        .map((s) => {
          if (s && typeof s === 'object') {
            const file = String(s.file || '').trim();
            const stationName = String(s.stationName || s.artist || '').trim();
            if (!file) return null;
            return { file, stationName };
          }
          const file = String(s || '').trim();
          if (!file) return null;
          return { file, stationName: '' };
        })
        .filter(Boolean);

      if (!stations.length) return res.status(400).json({ ok: false, error: 'stations are required' });

      let presets = await readRadioPresetsFile();
      if (!Array.isArray(presets)) presets = [];

      const entry = {
        id: 
          'rp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        createdAt: Date.now(),
        stations,
      };

      presets.unshift(entry);
      if (presets.length > 60) presets = presets.slice(0, 60);
      await writeRadioPresetsFile(presets);

      return res.json({ ok: true, preset: entry, count: presets.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
