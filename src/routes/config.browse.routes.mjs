import { RadioCatalogUnavailableError } from '../lib/moode-radio-catalog.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST, TRACK_KEY, PORT, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { getBrowseIndex } from '../lib/browse-index.mjs';

const execFileP = promisify(execFile);

const recentAlbumsFastCache = { ts: 0, items: [], inflight: null };
const recentPodcastsCache = { ts: 0, items: [], inflight: null };
const recentPlaylistsCache = { ts: 0, items: [], inflight: null };
const recentRadioCache = { ts: 0, items: [], inflight: null };

async function localApi(pathname, { timeoutMs = 8000 } = {}) {
  const url = `http://127.0.0.1:${Number(PORT || 3101)}${pathname}`;
  const r = await fetch(url, {
    cache: 'no-store',
    headers: TRACK_KEY ? { 'x-track-key': String(TRACK_KEY) } : {},
    signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 8000)),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!r.ok, json: j, status: Number(r.status || 0) || 0 };
}

async function refreshRecentAlbumsFastCache() {
  if (recentAlbumsFastCache.inflight) return recentAlbumsFastCache.inflight;
  recentAlbumsFastCache.inflight = (async () => {
    try {
      const resp = await localApi('/config/library-health/albums', { timeoutMs: 16000 });
      const albums = (resp.ok && resp?.json?.ok && Array.isArray(resp.json.albums)) ? resp.json.albums : [];
      const items = albums
        .filter((a) => {
          const f = String(a?.folder || '').trim().toLowerCase();
          return !(f.startsWith('usb/samsungmoode/podcasts/') || f.includes('/podcasts/'));
        })
        .sort((a, b) => Number(b?.addedTs || 0) - Number(a?.addedTs || 0))
        .map((a) => ({
          kind: 'album',
          album: String(a?.album || '').trim(),
          artist: String(a?.artist || '').trim(),
          file: String(a?.sampleFile || '').trim(),
          folder: String(a?.folder || '').trim(),
          maxId: Number(a?.addedTs || 0) || 0,
          art: String(a?.thumbUrl || '').trim() || `/art/track_640.jpg?file=${encodeURIComponent(String(a?.sampleFile || '')).replace(/'/g,'%27')}`,
        }));
      if (items.length) {
        recentAlbumsFastCache.ts = Date.now();
        recentAlbumsFastCache.items = items;
      }
    } catch {
    } finally {
      recentAlbumsFastCache.inflight = null;
    }
    return recentAlbumsFastCache.items;
  })();
  return recentAlbumsFastCache.inflight;
}

async function refreshRecentPodcastsCache() {
  if (recentPodcastsCache.inflight) return recentPodcastsCache.inflight;
  recentPodcastsCache.inflight = (async () => {
    try {
      const resp = await localApi('/podcasts', { timeoutMs: 7000 });
      const rows = (resp.ok && resp?.json?.ok && Array.isArray(resp.json.items)) ? resp.json.items : [];
      const items = rows.map((s) => ({
        kind: 'podcast',
        title: String(s?.title || s?.rss || '(podcast)').trim(),
        rss: String(s?.rss || '').trim(),
        art: String(s?.imageUrl || '').trim() || '/art/current.jpg',
      }));
      if (items.length) { recentPodcastsCache.ts = Date.now(); recentPodcastsCache.items = items; }
    } catch {
    } finally { recentPodcastsCache.inflight = null; }
    return recentPodcastsCache.items;
  })();
  return recentPodcastsCache.inflight;
}

async function refreshRecentRadioCache() {
  if (recentRadioCache.inflight) return recentRadioCache.inflight;
  recentRadioCache.inflight = (async () => {
    try {
      const resp = await localApi('/config/queue-wizard/radio-favorites', { timeoutMs: 7000 });
      if (!resp.ok || resp?.json?.ok !== true || !Array.isArray(resp.json.favorites)) throw new RadioCatalogUnavailableError();
      const rows = resp.json.favorites;
      const items = rows.map((x) => {
        const title = String(x?.stationName || x?.file || '(station)').trim();
        return { kind: 'radio', title, url: String(x?.file || '').trim(), art: `/art/radio-logo.jpg?name=${encodeURIComponent(title)}` };
      });
      recentRadioCache.ts = Date.now(); recentRadioCache.items = items;
    } catch {
      throw new RadioCatalogUnavailableError();
    } finally { recentRadioCache.inflight = null; }
    return recentRadioCache.items;
  })();
  return recentRadioCache.inflight;
}

async function refreshRecentPlaylistsCache() {
  if (recentPlaylistsCache.inflight) return recentPlaylistsCache.inflight;
  recentPlaylistsCache.inflight = (async () => {
    try {
      const resp = await localApi('/config/queue-wizard/playlists', { timeoutMs: 7000 });
      const names = (resp.ok && resp?.json?.ok && Array.isArray(resp.json.playlists)) ? resp.json.playlists : [];
      const host = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
      const user = String(MOODE_SSH_USER || 'moode').trim();
      const safeNames = names.map((n) => String(n || '').trim()).filter(Boolean);
      const py = JSON.stringify(safeNames);
      let byName = new Map();
      try {
        const script = `python3 - <<'PY'\nimport os,json\nnames=json.loads(${JSON.stringify(py)})\nroots=['/var/local/www/imagesw/playlist-covers','/var/www/imagesw/playlist-covers']\nfor name in names:\n  safe='_'.join(str(name).split())\n  files=[f'{name}.jpg', f'{safe}.jpg']\n  m=0\n  hit=''\n  for root in roots:\n    for fn in files:\n      p=f'{root}/{fn}'\n      try:\n        st=os.stat(p)\n        t=int(st.st_mtime*1000)\n        if t>m:\n          m=t; hit=fn\n      except Exception:\n        pass\n  print(f"{name}\t{m}\t{hit}")\nPY`;
        const { stdout } = await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${user}@${host}`, 'bash', '-lc', script], { timeout: 14000, maxBuffer: 4 * 1024 * 1024 });
        byName = new Map(String(stdout || '').split(/\r?\n/).filter(Boolean).map((ln) => {
          const [n = '', ts = '0'] = ln.split('\t');
          return [String(n || '').trim(), Number(ts || 0) || 0];
        }));
      } catch {}

      const items = safeNames.map((title) => {
        const safe = title.replace(/\s+/g, '_');
        return {
          kind: 'playlist',
          title,
          playlist: title,
          coverTs: Number(byName.get(title) || 0) || 0,
          art: `http://${host}/imagesw/playlist-covers/${encodeURIComponent(title)}.jpg`,
          artAlt: `http://${host}/imagesw/playlist-covers/${encodeURIComponent(safe)}.jpg`,
        };
      }).sort((a, b) => Number(b.coverTs || 0) - Number(a.coverTs || 0));

      if (items.length) { recentPlaylistsCache.ts = Date.now(); recentPlaylistsCache.items = items; }
    } catch {
    } finally { recentPlaylistsCache.inflight = null; }
    return recentPlaylistsCache.items;
  })();
  return recentPlaylistsCache.inflight;
}

export function registerConfigBrowseRoutes(app, deps) {
  const { requireTrackKey } = deps;

  // Warm browse index in background shortly after API startup (non-blocking).
  setTimeout(() => {
    const mpdHost = String(MPD_HOST || 'moode.local');
    getBrowseIndex(mpdHost).catch(() => null);
  }, 1500);

  // Warm recent caches shortly after startup to reduce cold-start empties.
  setTimeout(() => {
    refreshRecentAlbumsFastCache().catch(() => null);
    refreshRecentPodcastsCache().catch(() => null);
    refreshRecentPlaylistsCache().catch(() => null);
    refreshRecentRadioCache().catch(() => null);
  }, 2200);

  app.get('/recent/albums', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(60, Number(req.query?.limit || 18) || 18));
      const now = Date.now();
      const fresh = Array.isArray(recentAlbumsFastCache.items) && recentAlbumsFastCache.items.length && (now - Number(recentAlbumsFastCache.ts || 0)) < 5 * 60 * 1000;

      if (fresh) {
        const items = recentAlbumsFastCache.items.slice(0, limit);
        return res.json({ ok: true, count: items.length, items, source: 'library-health-cache' });
      }

      await refreshRecentAlbumsFastCache();
      if ((!Array.isArray(recentAlbumsFastCache.items) || !recentAlbumsFastCache.items.length)) {
        // One short retry for cold-start races (e.g., first web-app launch).
        await new Promise((r) => setTimeout(r, 300));
        await refreshRecentAlbumsFastCache();
      }
      if (Array.isArray(recentAlbumsFastCache.items) && recentAlbumsFastCache.items.length) {
        const items = recentAlbumsFastCache.items.slice(0, limit);
        return res.json({ ok: true, count: items.length, items, source: 'library-health-cache' });
      }

      // Last-resort fallback (best effort) if cache is empty.
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      const tracks = Array.isArray(idx?.tracks) ? idx.tracks : [];
      const byAlbum = new Map();
      for (const t of tracks) {
        const album = String(t?.album || '').trim();
        const artist = String(t?.albumArtist || t?.artist || '').trim();
        const file = String(t?.file || '').trim();
        if (!album || !file) continue;
        const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
        const id = Number(t?.id || 0) || 0;
        if (!byAlbum.has(key) || id > Number(byAlbum.get(key)?.maxId || 0)) byAlbum.set(key, { album, artist, file, maxId: id });
      }
      const items = Array.from(byAlbum.values()).sort((a, b) => Number(b?.maxId || 0) - Number(a?.maxId || 0)).slice(0, limit).map((x) => ({
        kind: 'album', album: String(x?.album || '').trim(), artist: String(x?.artist || '').trim(), file: String(x?.file || '').trim(), folder: '', maxId: Number(x?.maxId || 0) || 0, art: `/art/track_640.jpg?file=${encodeURIComponent(String(x?.file || ''))}`,
      }));
      return res.json({ ok: true, count: items.length, items, source: 'browse-index-fallback' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/recent/podcasts', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(60, Number(req.query?.limit || 18) || 18));
      const fresh = Array.isArray(recentPodcastsCache.items) && recentPodcastsCache.items.length && (Date.now() - Number(recentPodcastsCache.ts || 0)) < 5 * 60 * 1000;
      if (!fresh) await refreshRecentPodcastsCache();
      const items = (recentPodcastsCache.items || []).slice(0, limit);
      return res.json({ ok: true, count: items.length, items, source: 'podcasts-cache' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/recent/playlists', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(60, Number(req.query?.limit || 18) || 18));
      const fresh = Array.isArray(recentPlaylistsCache.items) && recentPlaylistsCache.items.length && (Date.now() - Number(recentPlaylistsCache.ts || 0)) < 5 * 60 * 1000;
      if (!fresh) await refreshRecentPlaylistsCache();
      const items = (recentPlaylistsCache.items || []).slice(0, limit);
      return res.json({ ok: true, count: items.length, items, source: 'playlists-cache' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/recent/radio-favorites', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(60, Number(req.query?.limit || 18) || 18));
      const fresh = Array.isArray(recentRadioCache.items) && recentRadioCache.items.length && (Date.now() - Number(recentRadioCache.ts || 0)) < 5 * 60 * 1000;
      if (!fresh) await refreshRecentRadioCache();
      const items = (recentRadioCache.items || []).slice(0, limit);
      return res.json({ ok: true, count: items.length, items, source: 'radio-cache' });
    } catch (e) {
      return res.status(503).json({ ok: false, code: 'RADIO_CATALOG_UNAVAILABLE', error: 'Radio catalog unavailable. Please retry.' });
    }
  });

  app.get('/config/browse/stats', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      return res.json({ ok: true, builtAt: String(idx?.builtAt || ''), counts: idx?.counts || {} });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/browse/rebuild', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost, { force: true });
      return res.json({ ok: true, builtAt: String(idx?.builtAt || ''), counts: idx?.counts || {} });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/browse/artists', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const q = String(req.query?.q || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(5000, Number(req.query?.limit || 200) || 200));
      const offset = Math.max(0, Number(req.query?.offset || 0) || 0);
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      let artists = Array.isArray(idx?.artists) ? idx.artists : [];
      if (q) artists = artists.filter((a) => String(a?.name || '').toLowerCase().includes(q));
      const total = artists.length;
      artists = artists.slice(offset, offset + limit);
      return res.json({ ok: true, offset, limit, total, count: artists.length, artists });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/browse/albums', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const artist = String(req.query?.artist || '').trim().toLowerCase();
      const q = String(req.query?.q || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(10000, Number(req.query?.limit || 3000) || 3000));
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
      let albums = Array.isArray(idx?.albums) ? idx.albums : [];
      if (artist) albums = albums.filter((a) => String(a?.artist || '').trim().toLowerCase() === artist);
      if (q) albums = albums.filter((a) => (`${String(a?.artist || '')} ${String(a?.album || '')}`).toLowerCase().includes(q));
      albums = albums.slice(0, limit);
      return res.json({ ok: true, count: albums.length, albums });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/browse/artist-albums', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const artist = String(req.query?.artist || '').trim();
      if (!artist) return res.status(400).json({ ok: false, error: 'artist is required' });
      const artLc = artist.toLowerCase();
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
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

  app.get('/config/browse/album-tracks', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const album = String(req.query?.album || '').trim();
      const artist = String(req.query?.artist || '').trim();
      if (!album) return res.status(400).json({ ok: false, error: 'album is required' });
      const albLc = album.toLowerCase();
      const artLc = artist.toLowerCase();
      const mpdHost = String(MPD_HOST || 'moode.local');
      const idx = await getBrowseIndex(mpdHost);
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
        .filter((t) => !!t.file)
        .sort((a, b) => {
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
}
