import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';

const execFileP = promisify(execFile);

function sshArgsFor(user, host, extra = []) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', ...extra, `${user}@${host}`];
}

function shQuoteArg(s) {
  const v = String(s ?? '');
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

function mpdQuote(s = '') {
  return `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
}

async function resolveLocalMusicPath(pLike) {
  const raw = String(pLike || '').trim();
  const f = raw.replace(/^\/+/, '');
  if (!f || f === '(root)') return '';

  const candidates = [
    // absolute/local paths first
    raw.startsWith('/') ? raw : '',
    f.startsWith('/mnt/') ? f : '',
    f.startsWith('mnt/') ? '/' + f : '',

    // common moOde + MPD roots
    '/var/lib/mpd/music/' + f,
    '/media/' + f,

    // legacy mount aliases used across deployments
    f.startsWith('USB/SamsungMoode/') ? '/mnt/SamsungMoode/' + f.slice('USB/SamsungMoode/'.length) : '',
    f.startsWith('OSDISK/') ? '/mnt/OSDISK/' + f.slice('OSDISK/'.length) : '',
    '/mnt/SamsungMoode/' + f,
    '/mnt/OSDISK/' + f,
  ]
    .map((x) => String(x || '').replace(/\/+/g, '/').trim())
    .filter(Boolean);

  for (const c of candidates) {
    try { await fs.access(c); return c; } catch (_) {}
  }
  return '';
}

async function resolveLocalFolderPath(folder) {
  return resolveLocalMusicPath(folder);
}

async function sshBashLc({ user, host, script, timeoutMs = 20000, maxBuffer = 10 * 1024 * 1024 }) {
  return execFileP('ssh', [...sshArgsFor(user, host), 'bash', '-lc', shQuoteArg(String(script || ''))], {
    timeout: timeoutMs,
    maxBuffer,
  });
}

const LIB_HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;
const LIBRARY_GENRES_CACHE_TTL_MS = 15 * 60 * 1000;
const LIBRARY_THUMBS_CACHE_DIR =
  String(process.env.NOW_PLAYING_THUMBS_CACHE_DIR || '').trim()
  || runtimeStatePaths().libraryThumbsDir;
let libraryHealthCache = null;
let libraryHealthJob = null;
let libraryGenresCache = null;

async function computeLibraryHealthSnapshot({ sampleLimit, scanLimit, getRatingForFile, mpdStickerGetSong }) {
  const started = Date.now();
  const isAudio = (f) => /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff|alac|dsf|wv|ape)$/i.test(String(f || ''));
  const folderOf = (file) => {
    const s = String(file || '');
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : '(root)';
  };
  const pick = (arr, row) => { if (arr.length < sampleLimit) arr.push(row); };

  const mpdHost = String(MPD_HOST || 'moode.local');
  const fmt = '%file%\t%artist%\t%title%\t%album%\t%genre%\t%MUSICBRAINZ_TRACKID%';
  const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', fmt, 'listall'], { maxBuffer: 64 * 1024 * 1024 });
  const allFiles = String(stdout || '')
    .split(/\r?\n/)
    .map((ln) => {
      const [file = '', artist = '', title = '', album = '', genre = '', mbid = ''] = ln.split('\t');
      return {
        file: String(file || '').trim(),
        artist: String(artist || '').trim(),
        title: String(title || '').trim(),
        album: String(album || '').trim(),
        genres: String(genre || '').trim() ? [String(genre || '').trim()] : [],
        musicbrainz_trackid: String(mbid || '').trim(),
      };
    })
    .filter((x) => x.file && isAudio(x.file))
    .slice(0, Number.isFinite(scanLimit) ? scanLimit : undefined);

  const summary = {
    totalTracks: 0, totalAlbums: 0, missingArtwork: 0, unrated: 0, lowRated1: 0, missingMbid: 0, missingGenre: 0, christmasGenre: 0, podcastGenre: 0,
  };
  const genreSet = new Set();
  const genreCounts = new Map();
  const ratingCounts = new Map();
  const samples = { unrated: [], lowRated1: [], missingMbid: [], missingGenre: [] };

  let scanned = 0;
  for (const b0 of allFiles) {
    const file = String(b0?.file || '').trim();
    if (!file || !isAudio(file)) continue;
    if (scanned >= scanLimit) break;
    scanned += 1;

    summary.totalTracks += 1;
    const b = b0 || { file, genres: [] };
    const artist = String(b.artist || b.albumartist || '').trim();
    const title = String(b.title || '').trim();
    const album = String(b.album || '').trim();

    const genreVals = Array.isArray(b.genres) ? b.genres : [];
    for (const g of genreVals) {
      const raw = String(g || '').trim();
      if (!raw) continue;
      const splitVals = raw.split(/[;,|/]/).map((x) => String(x || '').trim()).filter(Boolean);
      const list = splitVals.length ? splitVals : [raw];
      for (const gg of list) {
        genreSet.add(gg);
        genreCounts.set(gg, Number(genreCounts.get(gg) || 0) + 1);
      }
    }
    const genreBlob = genreVals.join(' | ').trim();
    if (!genreBlob) { summary.missingGenre += 1; pick(samples.missingGenre, { file, artist, title, album }); }
    if (/christmas/i.test(genreBlob)) summary.christmasGenre += 1;
    if (/\bpodcast\b/i.test(genreBlob)) summary.podcastGenre += 1;

    const isPodcast = /\bpodcast\b/i.test(genreBlob);
    let rating = 0;
    try { rating = Number(await getRatingForFile(file)) || 0; } catch (_) {}
    const ratingBucket = Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.round(rating))) : 0;
    ratingCounts.set(String(ratingBucket), Number(ratingCounts.get(String(ratingBucket)) || 0) + 1);

    if (!isPodcast && rating <= 0) { summary.unrated += 1; pick(samples.unrated, { file, artist, title, album, rating }); }
    if (rating === 1) { summary.lowRated1 += 1; pick(samples.lowRated1, { file, artist, title, album, rating }); }

    const mbTag = String(b.musicbrainz_trackid || '').trim();
    let mbSticker = '';
    if (!mbTag) {
      try { mbSticker = String(await mpdStickerGetSong(file, 'mb_trackid') || '').trim(); } catch (_) {}
    }
    if (!mbTag && !mbSticker) { summary.missingMbid += 1; pick(samples.missingMbid, { file, artist, title, album }); }
  }

  const resolveLocalFolder = async (folder) => {
    const f = String(folder || '').trim().replace(/^\/+/, '');
    if (!f || f === '(root)') return '';
    const candidates = [
      f.startsWith('/mnt/') ? f : '',
      f.startsWith('mnt/') ? '/' + f : '',
      f.startsWith('USB/SamsungMoode/') ? '/mnt/SamsungMoode/' + f.slice('USB/SamsungMoode/'.length) : '',
      f.startsWith('OSDISK/') ? '/mnt/OSDISK/' + f.slice('OSDISK/'.length) : '',
      '/mnt/SamsungMoode/' + f,
      '/mnt/OSDISK/' + f,
    ].map((x) => String(x || '').replace(/\/+/g, '/')).filter(Boolean);
    for (const c of candidates) {
      try { await fs.access(c); return c; } catch (_) {}
    }
    return '';
  };

  const folderSet = new Set(allFiles.map((r) => folderOf(r.file)).filter((f) => f && f !== '(root)'));
  summary.totalAlbums = folderSet.size;
  for (const folder of folderSet) {
    const localFolder = await resolveLocalFolder(folder);
    if (!localFolder) { summary.missingArtwork += 1; continue; }
    const coverPath = path.join(localFolder, 'cover.jpg');
    try { await fs.access(coverPath); } catch (_) { summary.missingArtwork += 1; }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    summary,
    samples,
    genreCounts: Array.from(genreCounts.entries())
      .map(([genre, count]) => ({ genre, count: Number(count || 0) }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, undefined, { sensitivity: 'base' })),
    ratingCounts: [0, 1, 2, 3, 4, 5].map((r) => ({ rating: r, count: Number(ratingCounts.get(String(r)) || 0) })),
    genreOptions: Array.from(genreSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    sampleLimit,
    scanLimit,
    scannedTracks: summary.totalTracks,
  };
}

export function registerConfigLibraryHealthReadRoutes(app, deps) {
  const { requireTrackKey, mpdQueryRaw, getRatingForFile, mpdStickerGetSong } = deps;

  app.get('/config/library-health', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      if (
        typeof mpdQueryRaw !== 'function' ||
        typeof getRatingForFile !== 'function' ||
        typeof mpdStickerGetSong !== 'function'
      ) {
        return res.status(501).json({ ok: false, error: 'library-health dependencies not wired' });
      }

      const sampleLimit = Math.max(10, Math.min(500, Number(req.query?.sampleLimit || 100)));
      const scanLimit =
        req.query?.scanLimit != null
          ? Math.max(100, Math.min(200000, Number(req.query.scanLimit || 100)))
          : Number.MAX_SAFE_INTEGER;
      const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query?.refresh || '').toLowerCase());
      const cacheOnly = ['1', 'true', 'yes'].includes(String(req.query?.cacheOnly || '').toLowerCase());
      const now = Date.now();

      if (!forceRefresh && libraryHealthCache && (now - Number(libraryHealthCache.cachedAt || 0) < LIB_HEALTH_CACHE_TTL_MS)) {
        return res.json({
          ...libraryHealthCache.payload,
          cache: { hit: true, ageMs: now - Number(libraryHealthCache.cachedAt || 0), ttlMs: LIB_HEALTH_CACHE_TTL_MS },
          job: { running: !!libraryHealthJob },
        });
      }

      if (!forceRefresh && libraryHealthJob?.promise) {
        return res.json({
          ok: true,
          pending: true,
          message: 'Library health refresh in progress',
          cache: libraryHealthCache
            ? { hit: true, ageMs: now - Number(libraryHealthCache.cachedAt || 0), ttlMs: LIB_HEALTH_CACHE_TTL_MS, stale: true }
            : { hit: false, ttlMs: LIB_HEALTH_CACHE_TTL_MS },
          job: { running: true, startedAt: libraryHealthJob.startedAt },
          ...(libraryHealthCache?.payload || {}),
        });
      }

      if (cacheOnly) {
        return res.json({
          ok: true,
          cacheOnly: true,
          generatedAt: null,
          elapsedMs: 0,
          scannedTracks: 0,
          summary: {
            totalTracks: 0, totalAlbums: 0, missingArtwork: 0, unrated: 0, lowRated1: 0, missingMbid: 0, missingGenre: 0, christmasGenre: 0, podcastGenre: 0,
          },
          samples: { unrated: [], lowRated1: [], missingMbid: [], missingGenre: [] },
          genreCounts: [],
          ratingCounts: [0, 1, 2, 3, 4, 5].map((r) => ({ rating: r, count: 0 })),
          genreOptions: [],
          sampleLimit,
          scanLimit,
          cache: libraryHealthCache
            ? { hit: true, ageMs: now - Number(libraryHealthCache.cachedAt || 0), ttlMs: LIB_HEALTH_CACHE_TTL_MS, stale: true }
            : { hit: false, ttlMs: LIB_HEALTH_CACHE_TTL_MS },
          job: { running: !!libraryHealthJob, startedAt: libraryHealthJob?.startedAt || null },
        });
      }

      const payload = await computeLibraryHealthSnapshot({ sampleLimit, scanLimit, getRatingForFile, mpdStickerGetSong });
      libraryHealthCache = { payload, cachedAt: Date.now() };
      return res.json({
        ...payload,
        cache: { hit: false, ageMs: 0, ttlMs: LIB_HEALTH_CACHE_TTL_MS },
        job: { running: false },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/library-health/refresh', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      if (libraryHealthJob?.promise) {
        return res.json({ ok: true, started: false, running: true, startedAt: libraryHealthJob.startedAt });
      }
      const sampleLimit = Math.max(10, Math.min(500, Number(req.body?.sampleLimit || req.query?.sampleLimit || 100)));
      const scanLimit =
        req.body?.scanLimit != null || req.query?.scanLimit != null
          ? Math.max(100, Math.min(200000, Number(req.body?.scanLimit || req.query?.scanLimit || 100)))
          : Number.MAX_SAFE_INTEGER;

      const startedAt = new Date().toISOString();
      const promise = computeLibraryHealthSnapshot({ sampleLimit, scanLimit, getRatingForFile, mpdStickerGetSong })
        .then((payload) => {
          libraryHealthCache = { payload, cachedAt: Date.now() };
          return payload;
        })
        .finally(() => {
          libraryHealthJob = null;
        });

      libraryHealthJob = { startedAt, promise };
      return res.json({ ok: true, started: true, running: true, startedAt });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/job', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      return res.json({
        ok: true,
        running: !!libraryHealthJob,
        startedAt: libraryHealthJob?.startedAt || null,
        cache: libraryHealthCache
          ? {
              generatedAt: libraryHealthCache.payload?.generatedAt || null,
              cachedAt: new Date(Number(libraryHealthCache.cachedAt || 0)).toISOString(),
              ageMs: Date.now() - Number(libraryHealthCache.cachedAt || 0),
              ttlMs: LIB_HEALTH_CACHE_TTL_MS,
            }
          : null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/genres', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const now = Date.now();
      if (libraryGenresCache && (now - Number(libraryGenresCache.cachedAt || 0) < LIBRARY_GENRES_CACHE_TTL_MS)) {
        return res.json({
          ok: true,
          genres: libraryGenresCache.genres,
          cache: { hit: true, ageMs: now - Number(libraryGenresCache.cachedAt || 0), ttlMs: LIBRARY_GENRES_CACHE_TTL_MS },
        });
      }

      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, 'list', 'genre'], { maxBuffer: 8 * 1024 * 1024 });
      const genres = Array.from(
        new Set(
          String(stdout || '')
            .split(/\r?\n/)
            .map((x) => String(x || '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      libraryGenresCache = { genres, cachedAt: now };

      return res.json({
        ok: true,
        genres,
        cache: { hit: false, ageMs: 0, ttlMs: LIBRARY_GENRES_CACHE_TTL_MS },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/missing-artwork', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const isAudio = (f) => /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff|alac|dsf|wv|ape)$/i.test(String(f || ''));
      const folderOf = (file) => {
        const s = String(file || '');
        const i = s.lastIndexOf('/');
        return i > 0 ? s.slice(0, i) : '(root)';
      };
      const leafName = (p) => {
        const s = String(p || '');
        const i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
      };

      const resolveLocalFolder = async (folder) => {
        const f = String(folder || '').trim().replace(/^\/+/, '');
        if (!f || f === '(root)') return '';
        const candidates = [
          f.startsWith('/mnt/') ? f : '',
          f.startsWith('mnt/') ? '/' + f : '',
          f.startsWith('USB/SamsungMoode/') ? '/mnt/SamsungMoode/' + f.slice('USB/SamsungMoode/'.length) : '',
          f.startsWith('OSDISK/') ? '/mnt/OSDISK/' + f.slice('OSDISK/'.length) : '',
          '/mnt/SamsungMoode/' + f,
          '/mnt/OSDISK/' + f,
        ].map((x) => String(x || '').replace(/\/+/g, '/')).filter(Boolean);

        for (const c of candidates) {
          try { await fs.access(c); return c; } catch (_) {}
        }
        return '';
      };

      const resolveLocalPath = async (file) => {
        const f = String(file || '').trim().replace(/^\/+/, '');
        if (!f) return '';
        const candidates = [
          f.startsWith('/mnt/') ? f : '',
          f.startsWith('mnt/') ? '/' + f : '',
          f.startsWith('USB/SamsungMoode/') ? '/mnt/SamsungMoode/' + f.slice('USB/SamsungMoode/'.length) : '',
          f.startsWith('OSDISK/') ? '/mnt/OSDISK/' + f.slice('OSDISK/'.length) : '',
          '/mnt/SamsungMoode/' + f,
          '/mnt/OSDISK/' + f,
        ].map((x) => String(x || '').replace(/\/+/g, '/')).filter(Boolean);

        for (const c of candidates) {
          try { await fs.access(c); return c; } catch (_) {}
        }
        return '';
      };

      const hasEmbeddedArtwork = async (files) => {
        const sample = (Array.isArray(files) ? files : []).slice(0, 3);
        for (const f of sample) {
          const local = await resolveLocalPath(f);
          if (!local) continue;
          try {
            const { stdout } = await execFileP(
              'ffprobe',
              [
                '-v', 'error',
                '-show_entries', 'stream=codec_type:stream_disposition=attached_pic',
                '-of', 'json',
                local,
              ],
              { timeout: 1500 }
            );
            const txt = String(stdout || '');
            if (/"attached_pic"\s*:\s*1/.test(txt)) return true;
          } catch (_) {}
        }
        return false;
      };

      const onlyFolder = String(req.query?.folder || '').trim();

      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP(
        'mpc',
        ['-h', mpdHost, '-f', '%file%\t%album%\t%artist%\t%albumartist%', 'listall'],
        { maxBuffer: 64 * 1024 * 1024 }
      );

      const byFolder = new Map();

      for (const ln of String(stdout || '').split(/\r?\n/)) {
        if (!ln) continue;
        const [file = '', album = '', artist = '', albumArtist = ''] = ln.split('\t');
        const f = String(file || '').trim();
        if (!f || !isAudio(f)) continue;

        const folder = folderOf(f);
        if (!byFolder.has(folder)) byFolder.set(folder, { files: [], album: '', artists: new Set() });

        const row = byFolder.get(folder);
        row.files.push(f);

        const a = String(albumArtist || artist || '').trim();
        if (a) row.artists.add(a);

        if (!row.album) row.album = String(album || '').trim();
      }

      const missing = [];

      for (const [folder, row] of byFolder.entries()) {
        if (!folder || folder === '(root)') continue;
        if (onlyFolder && folder !== onlyFolder) continue;

        let hasCover = false;
        const localFolder = await resolveLocalFolder(folder);
        if (localFolder) {
          const coverPath = path.join(localFolder, 'cover.jpg');
          try { await fs.access(coverPath); hasCover = true; } catch (_) {}
        }

        if (!hasCover) {
          const hasEmbedded = await hasEmbeddedArtwork(row.files);
          if (!hasEmbedded) {
            const artists = Array.from(row.artists || []);
            missing.push({
              folder,
              album: row.album || leafName(folder),
              artist: artists.length === 1 ? artists[0] : (artists.length > 1 ? 'Various Artists' : 'Unknown Artist'),
              trackCount: row.files.length,
              files: row.files.slice(0, 200),
            });
          }
        }
      }

      missing.sort((a, b) =>
        `${a.artist} — ${a.album}`.localeCompare(`${b.artist} — ${b.album}`, undefined, { sensitivity: 'base' })
      );

      return res.json({ ok: true, totalMissing: missing.length, filterFolder: onlyFolder || null, albums: missing });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/album-thumb', async (req, res) => {
    try {
      const folder = String(req.query?.folder || '').trim();
      const file = String(req.query?.file || '').trim();
      if (!folder) return res.status(400).json({ ok: false, error: 'folder is required' });

      const cacheDir = LIBRARY_THUMBS_CACHE_DIR;
      const cacheName = Buffer.from(String(folder || '')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64) || 'thumb';
      const outPath = path.join(cacheDir, `${cacheName}.jpg`);
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        const cached = await fs.readFile(outPath);
        if (cached?.length) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(cached);
        }
      } catch (_) {}

      const localFolder = await resolveLocalFolderPath(folder);

      const candidates = ['cover.jpg', 'folder.jpg', 'front.jpg', 'cover.jpeg', 'folder.jpeg', 'front.jpeg', 'cover.png', 'folder.png', 'front.png'];
      if (localFolder) {
        for (const name of candidates) {
          const p = path.join(localFolder, name);
          try {
            await fs.access(p);
            const buf = await fs.readFile(p);
            const ct = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
            if (ct === 'image/jpeg') { try { await fs.writeFile(outPath, buf); } catch (_) {} }
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buf);
          } catch (_) {}
        }
      }

      // Remote fallback (Pi5 app + moOde library on another host):
      // try cover files over SSH from moOde host.
      try {
        const sshHost = String(MOODE_SSH_HOST || MPD_HOST || '').trim();
        const sshUser = String(MOODE_SSH_USER || 'moode').trim();
        if (sshHost) {
          const folderNorm = String(folder || '').trim().replace(/^\/+/, '');
          const remoteBases = [
            `/var/lib/mpd/music/${folderNorm}`,
            `/media/${folderNorm}`,
            folderNorm.startsWith('USB/SamsungMoode/') ? `/media/SamsungMoode/${folderNorm.slice('USB/SamsungMoode/'.length)}` : '',
          ].filter(Boolean);
          const pyList = JSON.stringify(candidates);
          const pyBases = JSON.stringify(remoteBases);
          const script = `python3 - <<'PY'\nimport os,base64,json\nfiles=json.loads(${shQuoteArg(pyList)})\nbases=json.loads(${shQuoteArg(pyBases)})\nfor b in bases:\n    for n in files:\n        p=os.path.join(b,n)\n        if os.path.isfile(p):\n            with open(p,'rb') as f: data=f.read()\n            ct='image/png' if n.lower().endswith('.png') else 'image/jpeg'\n            print('CT:'+ct)\n            print('B64:'+base64.b64encode(data).decode('ascii'))\n            raise SystemExit(0)\nprint('MISS')\nPY`;
          const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 }).catch(() => ({ stdout: '' }));
          const out = String(stdout || '');
          const ct = (out.match(/CT:([^\n]+)/) || [,''])[1].trim();
          const b64 = (out.match(/B64:([A-Za-z0-9+/=\n\r]+)/) || [,''])[1].replace(/\s+/g, '');
          if (ct && b64) {
            const buf = Buffer.from(b64, 'base64');
            if (buf?.length) {
              if (ct === 'image/jpeg') { try { await fs.writeFile(outPath, buf); } catch (_) {} }
              res.setHeader('Content-Type', ct);
              res.setHeader('Cache-Control', 'public, max-age=86400');
              return res.send(buf);
            }
          }
        }
      } catch (_) {}

      // Remote embedded-art fallback (when files are not local to this API host).
      try {
        const sshHost = String(MOODE_SSH_HOST || MPD_HOST || '').trim();
        const sshUser = String(MOODE_SSH_USER || 'moode').trim();
        const fileNorm = String(file || '').trim().replace(/^\/+/, '');
        if (sshHost && fileNorm) {
          const sampleCandidates = [
            `/var/lib/mpd/music/${fileNorm}`,
            `/media/${fileNorm}`,
            fileNorm.startsWith('USB/SamsungMoode/') ? `/media/SamsungMoode/${fileNorm.slice('USB/SamsungMoode/'.length)}` : '',
          ].filter(Boolean);
          const pySamples = JSON.stringify(sampleCandidates);
          const script = `python3 - <<'PY'\nimport os,base64,subprocess,json\nsamples=json.loads(${shQuoteArg(pySamples)})\nfor s in samples:\n    if not os.path.isfile(s):\n        continue\n    try:\n        p=subprocess.run(['ffmpeg','-v','error','-i',s,'-an','-vframes','1','-f','image2pipe','-vcodec','mjpeg','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)\n        b=bytes(p.stdout or b'')\n        if b:\n            print('CT:image/jpeg')\n            print('B64:'+base64.b64encode(b).decode('ascii'))\n            raise SystemExit(0)\n    except Exception:\n        pass\nprint('MISS')\nPY`;
          const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 15000 }).catch(() => ({ stdout: '' }));
          const out = String(stdout || '');
          const b64 = (out.match(/B64:([A-Za-z0-9+/=\n\r]+)/) || [,''])[1].replace(/\s+/g, '');
          if (b64) {
            const buf = Buffer.from(b64, 'base64');
            if (buf?.length) {
              try { await fs.writeFile(outPath, buf); } catch (_) {}
              res.setHeader('Content-Type', 'image/jpeg');
              res.setHeader('Cache-Control', 'public, max-age=86400');
              return res.send(buf);
            }
          }
        }
      } catch (_) {}

      // Fallback: attempt extracting embedded art from one sample track, cached to disk.
      const sample = await resolveLocalMusicPath(file);
      if (sample) {
        try {
          await execFileP('ffmpeg', ['-y', '-i', sample, '-an', '-vframes', '1', outPath], { timeout: 8000 });
          const buf = await fs.readFile(outPath);
          if (buf?.length) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buf);
          }
        } catch (_) {}
      }

      return res.status(404).end();
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/albums', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const isAudio = (f) => /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff|alac|dsf|wv|ape)$/i.test(String(f || ''));
      const folderOf = (file) => {
        const s = String(file || '');
        const i = s.lastIndexOf('/');
        return i > 0 ? s.slice(0, i) : '(root)';
      };

      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP(
        'mpc',
        ['-h', mpdHost, '-f', '%file%\t%artist%\t%albumartist%\t%album%', 'listall'],
        { maxBuffer: 64 * 1024 * 1024 }
      );

      const byFolder = new Map();
      let folderSeq = 0;
      for (const ln of String(stdout || '').split(/\r?\n/)) {
        if (!ln) continue;
        const [file = '', artist = '', albumartist = '', album = ''] = ln.split('\t');
        const f = String(file || '').trim();
        if (!f || !isAudio(f)) continue;
        const folder = folderOf(f);
        if (!folder || folder === '(root)') continue;

        if (!byFolder.has(folder)) {
          byFolder.set(folder, {
            folder,
            album: String(album || '').trim(),
            artists: new Set(),
            trackCount: 0,
            sampleFile: f,
            seq: folderSeq++,
          });
        }

        const row = byFolder.get(folder);
        row.trackCount += 1;
        const who = String(albumartist || artist || '').trim();
        if (who) row.artists.add(who);
        if (!row.album && String(album || '').trim()) row.album = String(album || '').trim();
      }

      const leafName = (p) => {
        const s = String(p || '');
        const i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
      };

      // Batch-resolve remote mtimes by sample file on moOde host (single SSH call)
      // so Oldest/Newest can be true date-based when library is remote.
      const remoteMtimeBySample = new Map();
      try {
        const sshHost = String(MOODE_SSH_HOST || MPD_HOST || '').trim();
        const sshUser = String(MOODE_SSH_USER || 'moode').trim();
        if (sshHost) {
          const sampleFiles = Array.from(byFolder.values())
            .map((r) => String(r?.sampleFile || '').trim())
            .filter(Boolean);
          if (sampleFiles.length) {
            const pySamples = JSON.stringify(sampleFiles);
            const script = `python3 - <<'PY'\nimport os,json\nsamples=json.loads(${shQuoteArg(pySamples)})\nfor f in samples:\n    s=str(f or '').strip().lstrip('/')\n    if not s:\n        continue\n    cands=[f'/var/lib/mpd/music/{s}', f'/media/{s}']\n    if s.startswith('USB/SamsungMoode/'):\n        cands.append('/media/SamsungMoode/' + s[len('USB/SamsungMoode/'):])\n    m=0\n    for c in cands:\n        try:\n            st=os.stat(c)\n            m=int(st.st_mtime*1000)\n            break\n        except Exception:\n            pass\n    print(f'{f}\t{m}')\nPY`;
            const r = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 30000 }).catch(() => ({ stdout: '' }));
            for (const ln of String(r?.stdout || '').split(/\r?\n/)) {
              if (!ln || !ln.includes('\t')) continue;
              const i = ln.lastIndexOf('\t');
              const f = ln.slice(0, i).trim();
              const n = Number(ln.slice(i + 1).trim());
              if (f && Number.isFinite(n) && n > 0) remoteMtimeBySample.set(f, n);
            }
          }
        }
      } catch (_) {}

      const albums = await Promise.all(Array.from(byFolder.values()).map(async (row) => {
        const artists = Array.from(row.artists || []);
        const artistLabel = artists.length === 1
          ? artists[0]
          : (artists.length > 1 ? 'Various Artists' : 'Unknown Artist');
        const albumName = String(row.album || '').trim() || leafName(row.folder);

        let addedTs = 0;
        try {
          const localFolder = await resolveLocalFolderPath(row.folder);
          if (localFolder) {
            const st = await fs.stat(localFolder);
            addedTs = Number(st?.birthtimeMs || st?.mtimeMs || 0) || 0;
          }
        } catch (_) {}

        if (!(Number.isFinite(addedTs) && addedTs > 0)) {
          const remoteTs = Number(remoteMtimeBySample.get(String(row.sampleFile || '').trim()) || 0);
          if (Number.isFinite(remoteTs) && remoteTs > 0) addedTs = remoteTs;
        }

        // Last fallback when timestamps are unavailable: preserve MPD discovery order.
        if (!(Number.isFinite(addedTs) && addedTs > 0)) {
          addedTs = Number(row.seq || 0);
        }

        return {
          folder: row.folder,
          artist: artistLabel,
          album: albumName,
          label: `${artistLabel} — ${albumName}`,
          trackCount: Number(row.trackCount || 0),
          addedTs,
          // Canonical local-cache-first album thumbnail endpoint.
          thumbUrl: `/config/library-health/album-thumb?folder=${encodeURIComponent(String(row.folder || '')).replace(/'/g,'%27')}&file=${encodeURIComponent(String(row.sampleFile || '')).replace(/'/g,'%27')}`,
        };
      }));

      albums.sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' }));
      return res.json({ ok: true, count: albums.length, albums });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/library-health/album-tracks', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const folderWanted = String(req.query?.folder || '').trim();
      if (!folderWanted) return res.status(400).json({ ok: false, error: 'folder is required' });

      const isAudio = (f) => /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff|alac|dsf|wv|ape)$/i.test(String(f || ''));
      const folderOf = (file) => {
        const s = String(file || '');
        const i = s.lastIndexOf('/');
        return i > 0 ? s.slice(0, i) : '(root)';
      };

      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP(
        'mpc',
        ['-h', mpdHost, '-f', '%file%\t%track%\t%title%\t%artist%\t%albumartist%\t%album%\t%date%\t%genre%', 'listall'],
        { maxBuffer: 64 * 1024 * 1024 }
      );

      const musicRoot = String(process.env.MPD_MUSIC_ROOT || '/var/lib/mpd/music').replace(/\/$/, '');

      const tracks = [];
      for (const ln of String(stdout || '').split(/\r?\n/)) {
        if (!ln) continue;
        const [file = '', track = '', title = '', artist = '', albumartist = '', album = '', date = '', genre = ''] = ln.split('\t');
        const f = String(file || '').trim();
        if (!f || !isAudio(f)) continue;
        const ff = folderOf(f);
        if (!(ff === folderWanted || ff.startsWith(`${folderWanted}/`))) continue;

        let rating = 0;
        try {
          const raw = await mpdQueryRaw(`sticker get song ${mpdQuote(f)} rating`);
          const m = String(raw || '').match(/sticker:\s*rating\s*=\s*([0-9]+)/i);
          rating = m ? (Number(m[1]) || 0) : 0;
        } catch {}

        let metaflac = '';
        let performerCurrent = [];
        try {
          if (/\.flac$/i.test(f)) {
            const remotePath = `${musicRoot}/${f}`;
            const pQ = shQuoteArg(remotePath);
            const script = `if [ -f ${pQ} ]; then metaflac --export-tags-to=- ${pQ} 2>/dev/null || true; fi`;
            const { stdout: mfOut } = await sshBashLc({
              user: String(MOODE_SSH_USER || 'moode'),
              host: String(MOODE_SSH_HOST || MPD_HOST || 'moode.local'),
              script,
              timeoutMs: 8000,
            });
            const rawTags = String(mfOut || '').split(/\r?\n/).map((ln) => String(ln || '').trim()).filter(Boolean);
            const sortedTags = rawTags.slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            metaflac = sortedTags.join('\n');
            performerCurrent = sortedTags
              .filter((ln) => /^performer=/i.test(ln))
              .map((ln) => `PERFORMER=${ln.split('=').slice(1).join('=').trim()}`);
          }
        } catch {}

        tracks.push({
          file: f,
          track: String(track || '').trim(),
          title: String(title || '').trim(),
          artist: String(artist || albumartist || '').trim(),
          albumArtist: String(albumartist || '').trim(),
          album: String(album || '').trim(),
          date: String(date || '').trim(),
          genre: String(genre || '').trim(),
          rating,
          performerCurrent,
          metaflac,
        });
      }

      tracks.sort((a, b) => {
        const ta = Number.parseInt(String(a.track || '').replace(/[^0-9].*$/, ''), 10);
        const tb = Number.parseInt(String(b.track || '').replace(/[^0-9].*$/, ''), 10);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, undefined, { sensitivity: 'base' });
      });

      return res.json({ ok: true, folder: folderWanted, count: tracks.length, tracks });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
