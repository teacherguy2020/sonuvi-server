import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST } from '../config.mjs';
import { getBrowseIndex } from '../lib/browse-index.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';

const execFileP = promisify(execFile);

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickVarietyTracks(candidates, maxTracks) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  if (candidates.length <= maxTracks) return candidates.slice();

  const buckets = new Map();
  for (const t of candidates) {
    const artistKey = String(t.albumartist || t.artist || '').trim().toLowerCase();
    const albumKey = String(t.album || '').trim().toLowerCase();
    const file = String(t.file || '').trim().toLowerCase();
    const key = (artistKey || albumKey)
      ? `${artistKey}|${albumKey}`
      : (() => {
          const i = file.lastIndexOf('/');
          return i > 0 ? `dir:${file.slice(0, i)}` : `file:${file}`;
        })();

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }

  const groups = Array.from(buckets.values()).map((g) => shuffleInPlace(g.slice()));
  shuffleInPlace(groups);

  const out = [];
  while (out.length < maxTracks) {
    let progressed = false;
    for (const g of groups) {
      if (out.length >= maxTracks) break;
      if (!g.length) continue;
      out.push(g.shift());
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

export function registerConfigQueueWizardPreviewRoute(app, deps) {
  const { requireTrackKey, getRatingForFile } = deps;
  const configPath = runtimeStatePaths().configPath;

  async function isRatingsEnabled() {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      return Boolean(cfg?.features?.ratings ?? true);
    } catch {
      return true;
    }
  }

  app.post('/config/queue-wizard/preview', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const wantedGenres = Array.isArray(req.body?.genres)
        ? req.body.genres.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const wantedArtists = Array.isArray(req.body?.artists)
        ? req.body.artists.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const wantedAlbums = Array.isArray(req.body?.albums)
        ? req.body.albums.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const excludeGenres = Array.isArray(req.body?.excludeGenres)
        ? req.body.excludeGenres.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
        : [];

      const ratingsEnabled = await isRatingsEnabled();
      const minRatingRaw = Math.max(0, Math.min(5, Number(req.body?.minRating || 0)));
      const minRating = ratingsEnabled ? minRatingRaw : 0;
      const maxTracks = Math.max(1, Math.min(5000, Number(req.body?.maxTracks || 250)));
      const varietyMode = req.body?.varietyMode !== false;

      const mpdHost = String(MPD_HOST || 'moode.local');

      let rows = [];
      try {
        const idx = await getBrowseIndex(mpdHost);
        rows = Array.isArray(idx?.tracks) ? idx.tracks : [];
      } catch {
        rows = [];
      }

      // Fallback for safety if index is unavailable.
      if (!rows.length) {
        const fmt = '%file%\t%artist%\t%title%\t%album%\t%albumartist%\t%genre%';
        const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', fmt, 'listall'], {
          maxBuffer: 64 * 1024 * 1024,
        });
        rows = String(stdout || '').split(/\r?\n/).filter(Boolean).map((ln) => {
          const [file = '', artist = '', title = '', album = '', albumartist = '', genreRaw = ''] = String(ln || '').split('\t');
          return { file, artist, title, album, albumartist, genre: genreRaw };
        });
      }

      const candidates = [];

      for (const t of rows) {
        const f = String(t?.file || '').trim();
        if (!f) continue;

        const artist = String(t?.artist || '').trim();
        const title = String(t?.title || '').trim();
        const album = String(t?.album || '').trim();
        const albumartist = String(t?.albumartist || t?.albumArtist || '').trim();
        const genreRaw = String(t?.genre || '').trim();

        const genreTokens = genreRaw
          .split(/[;,|/]/)
          .map((x) => String(x || '').trim().toLowerCase())
          .filter(Boolean);

        const a = artist.toLowerCase();
        const aa = albumartist.toLowerCase();
        const alb = album.toLowerCase();

        if (wantedGenres.length && !wantedGenres.some((g) => genreTokens.includes(g))) continue;
        if (wantedArtists.length && !(wantedArtists.includes(a) || wantedArtists.includes(aa))) continue;
        if (wantedAlbums.length && !wantedAlbums.includes(alb)) continue;
        if (excludeGenres.length && excludeGenres.some((g) => genreTokens.includes(g))) continue;

        let rating = 0;
        if (typeof getRatingForFile === 'function' && (minRating > 0 || ratingsEnabled)) {
          try {
            rating = Number(await getRatingForFile(f)) || 0;
          } catch (_) {}
        }
        if (minRating > 0 && rating < minRating) continue;

        candidates.push({
          file: f,
          artist,
          title,
          album,
          albumartist,
          genre: genreRaw,
          rating: Math.max(0, Math.min(5, Math.round(Number(rating) || 0))),
        });
      }

      const tracks = varietyMode
        ? pickVarietyTracks(candidates, maxTracks)
        : candidates.slice(0, maxTracks);

      return res.json({ ok: true, count: tracks.length, tracks, varietyMode });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
