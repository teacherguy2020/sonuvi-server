import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isQobuzCurrentArtReference } from '../lib/qobuz-connect.mjs';

async function fetchMoodeCoverBytes(ref, deps) {
  const { agentForUrl, normalizeCoverUrl, MOODE_BASE_URL, dispatcherForUrl } = deps;

  const s = String(ref || '').trim();
  if (!s) throw new Error('empty cover ref');

  if (/^https?:\/\//i.test(s)) {
    const resp = await fetch(s, { agent: agentForUrl(s), cache: 'no-store' });
    if (!resp.ok) throw new Error(`cover fetch failed: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  const url = normalizeCoverUrl(s.startsWith('/') ? s : `/${s}`, MOODE_BASE_URL);
  const resp = await fetch(url, { dispatcher: dispatcherForUrl(url), cache: 'no-store' });
  if (!resp.ok) throw new Error(`cover fetch failed: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function sendJpeg(res, buf, max) {
  const out = max
    ? await sharp(buf)
      .rotate()
      .resize(max, max, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
    : await sharp(buf)
      .rotate()
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.status(200).send(out);
}

async function serveCachedOrResizedSquare(res, best, size, cachePathForKey, deps) {
  const out = await readCachedOrResizedSquare(best, size, cachePathForKey, deps);
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(out);
}

async function readCachedOrResizedSquare(best, size, cachePathForKey, deps) {
  const { normalizeArtKey, updateArtCacheIfNeeded, safeIsFile } = deps;

  const key = normalizeArtKey(best);
  if (key) {
    await updateArtCacheIfNeeded(best);

    const p = cachePathForKey(key);
    if (safeIsFile(p)) {
      return fs.promises.readFile(p);
    }
  }

  const buf = await fetchMoodeCoverBytes(best, deps);
  return sharp(buf)
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

async function serveCachedOrBlurredBg(res, best, size, cacheBgPathForKey, deps) {
  const { normalizeArtKey, updateArtCacheIfNeeded, safeIsFile } = deps;

  const key = normalizeArtKey(best);
  if (key) {
    await updateArtCacheIfNeeded(best);

    const p = cacheBgPathForKey(key);
    if (safeIsFile(p)) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(await fs.promises.readFile(p));
    }
  }

  const buf = await fetchMoodeCoverBytes(best, deps);
  const out = await sharp(buf)
    .rotate()
    .resize(size, size, { fit: 'cover' })
    .blur(18)
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();

  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(out);
}

// Mobile clients identify tracks with opaque IDs. This helper keeps the
// MPD-relative file path inside the server while reusing the existing cover
// resolver/cache for an already-authorized local track.
export async function readTrackArtwork(file, deps, size = 640) {
  const sourceFile = String(file || '').trim();
  if (!sourceFile) return null;
  const source = `/coverart.php/${encodeURIComponent(sourceFile)}`;
  const body = await readCachedOrResizedSquare(
    source,
    Math.max(64, Math.min(1024, Number(size) || 640)),
    deps.artPath640ForKey,
    deps,
  );
  return Object.freeze({ body, contentType: 'image/jpeg' });
}

export async function serveTrackArtwork(res, file, deps, size = 640) {
  const artwork = await readTrackArtwork(file, deps, size);
  if (!artwork?.body?.length) return res.status(404).end();
  res.set('Content-Type', artwork.contentType);
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(artwork.body);
}

export function registerArtRoutes(app, deps) {
  const {
    MOODE_BASE_URL,
    fetchJson,
    fetchCurrentSong,
    fetchCurrentStatus,
    getQobuzNowPlaying,
    resolveBestArtForCurrentSong,
    normalizeArtKey,
    updateArtCacheIfNeeded,
    artPath640ForKey,
    artPathBgForKey,
    safeIsFile,
  } = deps;

  const resolveCurrentBestArt = async () => {
    try {
      const qobuz = await getQobuzNowPlaying?.();
      if (qobuz?.active && qobuz.artworkUrl) return qobuz.artworkUrl;
      if (qobuz?.suppressMpdHistory) return '';
    } catch {}

    const song = await (typeof fetchCurrentSong === 'function'
      ? fetchCurrentSong()
      : fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`));
    const statusRaw = await (typeof fetchCurrentStatus === 'function'
      ? fetchCurrentStatus()
      : fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`));
    return song ? await resolveBestArtForCurrentSong(song, statusRaw) : '';
  };

  app.get('/art/thumb.jpg', async (req, res) => {
    try {
      const folder = String(req.query.folder || '').trim();
      const file = String(req.query.file || '').trim();
      if (!folder) return res.status(400).send('Missing ?folder=');
      const qs = new URLSearchParams({ folder, ...(file ? { file } : {}) }).toString();
      return res.redirect(302, `/config/library-health/album-thumb?${qs}`);
    } catch {
      return res.status(404).end();
    }
  });

  app.get('/art/track_640.jpg', async (req, res) => {
    try {
      const file = String(req.query.file || '').trim();
      const heal = ['1','true','yes'].includes(String(req.query.heal || '').toLowerCase());
      let src = String(req.query.src || '').trim();

      if (file) {
        const srcCover = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(file)}`;
        const i = file.lastIndexOf('/');
        const folder = i > 0 ? file.slice(0, i) : '';
        if (folder) {
          try {
            const origin = `${req.protocol}://${req.get('host')}`;
            const qs = new URLSearchParams({ folder, file }).toString();
            const rr = await fetch(`${origin}/config/library-health/album-thumb?${qs}`, { cache: 'no-store' });
            if (rr.ok) {
              const buf = Buffer.from(await rr.arrayBuffer());
              // Cache-fill: write this resolved art into the shared 640 cache key for this file cover src.
              try {
                const key = normalizeArtKey(srcCover);
                if (key) {
                  const p640 = artPath640ForKey(key);
                  await fs.promises.mkdir(path.dirname(p640), { recursive: true }).catch(() => {});
                  const out = await sharp(buf)
                    .rotate()
                    .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 82, mozjpeg: true })
                    .toBuffer();
                  await fs.promises.writeFile(p640, out).catch(() => {});
                }
              } catch (_) {}
              return sendJpeg(res, buf, 640);
            }
          } catch (_) {}
        }
        src = srcCover;
      }
      if (!src) return res.status(400).send('Missing ?file= or ?src=');

      try {
        if (heal) {
          const buf = await fetchMoodeCoverBytes(src, deps);
          return await sendJpeg(res, buf, 640);
        }
        return await serveCachedOrResizedSquare(res, src, 640, artPath640ForKey, deps);
      } catch (_) {
        // Global self-heal fallback: if direct file art misses, use current-resolved art,
        // cache it, then return it so UI surfaces don't show blanks.
        const song = await (typeof fetchCurrentSong === 'function'
          ? fetchCurrentSong()
          : fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`)).catch(() => null);
        const statusRaw = await (typeof fetchCurrentStatus === 'function'
          ? fetchCurrentStatus()
          : fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`)).catch(() => null);
        const best = song ? await resolveBestArtForCurrentSong(song, statusRaw) : '';
        if (best) {
          await updateArtCacheIfNeeded(best).catch(() => {});
          return await serveCachedOrResizedSquare(res, best, 640, artPath640ForKey, deps);
        }
        throw new Error('art unresolved');
      }
    } catch (e) {
      console.warn('[art/track_640] failed:', e?.message || String(e));
      return res.status(404).end();
    }
  });

  const handleCurrentArt = async (req, res) => {
    try {
      const v = String(req.query.v || '').trim();
      if (v) {
        // Qobuz payloads use an opaque fingerprint on the mediated current-art
        // URL so browsers repaint when albums change. Resolve that reference
        // through the live source; never treat the public current-art URL as
        // the image source itself (which would re-cache the first Qobuz cover).
        if (isQobuzCurrentArtReference(v)) {
          const best = await resolveCurrentBestArt();
          if (!best) return res.status(404).end();
          return await serveCachedOrResizedSquare(res, best, 640, artPath640ForKey, deps);
        }

        const key = normalizeArtKey(v);
        if (!key) return res.status(404).end();

        // Older index/player clients stripped the file query from the
        // file-aware station-logo URL. Resolve that generic key against the
        // current song instead of returning a stale/shared logo or 404.
        if (/\/art\/radio-logo\.jpg$/i.test(key)) {
          const best = await resolveCurrentBestArt();
          if (best && normalizeArtKey(best) !== key) {
            return await serveCachedOrResizedSquare(res, best, 640, artPath640ForKey, deps);
          }
        }

        await updateArtCacheIfNeeded(v);

        const p640 = artPath640ForKey(key);
        if (safeIsFile(p640)) {
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-store');
          return res.status(200).send(await fs.promises.readFile(p640));
        }

        const buf = await fetchMoodeCoverBytes(key, deps);
        return sendJpeg(res, buf, 640);
      }

      const best = await resolveCurrentBestArt();
      if (!best) return res.status(404).end();

      return await serveCachedOrResizedSquare(res, best, 640, artPath640ForKey, deps);
    } catch (e) {
      console.warn('[art/current] failed:', e?.message || String(e));
      return res.status(404).end();
    }
  };

  app.get('/art/current.jpg', handleCurrentArt);
  app.get('/art/current_320.jpg', handleCurrentArt);

  app.get('/art/current_640.jpg', async (req, res) => {
    try {
      const best = await resolveCurrentBestArt();
      if (!best) return res.status(404).end();

      const key = normalizeArtKey(best);
      if (key) {
        await updateArtCacheIfNeeded(best);
        const p640 = artPath640ForKey(key);
        if (safeIsFile(p640)) {
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-store');
          return res.status(200).send(await fs.promises.readFile(p640));
        }
      }

      const buf = await fetchMoodeCoverBytes(best, deps);
      const out640 = await sharp(buf)
        .rotate()
        .resize(640, 640, { fit: 'cover' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(out640);
    } catch (e) {
      console.warn('[art/current_640] failed:', e?.message || String(e));
      return res.status(404).end();
    }
  });

  app.get('/art/current_bg_640_blur.jpg', async (req, res) => {
    try {
      const v = String(req.query.v || '').trim();
      if (v) {
        if (isQobuzCurrentArtReference(v)) {
          const best = await resolveCurrentBestArt();
          if (!best) return res.status(404).end();
          return await serveCachedOrBlurredBg(res, best, 640, artPathBgForKey, deps);
        }

        const key = normalizeArtKey(v);
        if (!key) return res.status(404).end();

        if (/\/art\/radio-logo\.jpg$/i.test(key)) {
          const best = await resolveCurrentBestArt();
          if (best && normalizeArtKey(best) !== key) {
            return await serveCachedOrBlurredBg(res, best, 640, artPathBgForKey, deps);
          }
        }

        await updateArtCacheIfNeeded(v);

        const pbg = artPathBgForKey(key);
        if (safeIsFile(pbg)) {
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-store');
          return res.status(200).send(await fs.promises.readFile(pbg));
        }

        return await serveCachedOrBlurredBg(res, key, 640, artPathBgForKey, deps);
      }

      const best = await resolveCurrentBestArt();
      if (!best) return res.status(404).end();

      return await serveCachedOrBlurredBg(res, best, 640, artPathBgForKey, deps);
    } catch (e) {
      console.warn('[art/current_bg] failed:', e?.message || String(e));
      return res.status(404).end();
    }
  });
}
