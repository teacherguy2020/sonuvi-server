import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function registerPodcastEpisodeRoutes(app, deps) {
  const {
    capabilities,
    normUrl,
    readSubs,
    rebuildPodcastLocalIndex,
    fetchPodcastRSS,
    downloadCoverForSub,
    resolveFinalUrl,
    stripQueryHash,
    yyyyMmDd,
  } = deps;
  const assertMutation = (capability) => capabilities?.assertExternalMutation(`podcasts.${capability}`);
  const assertRead = (capability) => capabilities?.assertExternalRead(`podcasts.${capability}`);

  app.post('/podcasts/_debug/rebuild-local', async (req, res) => {
    try {
      assertMutation('rebuild-local');
      const rss = normUrl(req.body?.rss);
      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });

      const subs = readSubs();
      const sub = subs.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

      const out = await rebuildPodcastLocalIndex(sub, { limit: 300 });

      return res.json({ ok: true, rss, dir: sub.dir, mapJson: sub.mapJson, outM3u: sub.outM3u, ...out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/podcasts/episodes/status', async (req, res) => {
    try {
      assertMutation('episode-status');
      const rss = normUrl(req.query?.rss);
      const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 100)));

      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });

      const subs = readSubs();
      const sub = subs.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

      const localByStem = Object.create(null);
      try {
        const names = await fsp.readdir(sub.dir);
        for (const name of names) {
          const m = String(name).match(/^([a-f0-9]{12})\.(mp3|m4a|aac|mp4)$/i);
          if (!m) continue;
          const full = path.join(sub.dir, name);
          try {
            const st = await fsp.stat(full);
            if (!st.isFile()) continue;
            localByStem[m[1].toLowerCase()] = name;
          } catch {}
        }
      } catch {}

      const feed = await fetchPodcastRSS(rss, limit);
      await downloadCoverForSub(sub, feed);
      const items = Array.isArray(feed?.items) ? feed.items : [];

      const episodes = [];
      for (const ep of items) {
        const rawUrl = String(ep?.enclosure || '').trim();
        if (!rawUrl) continue;

        const finalUrl = await resolveFinalUrl(rawUrl);
        const canonUrl = stripQueryHash(finalUrl || rawUrl);

        const guid = String(ep?.guid || '').trim();
        const seed = guid || canonUrl;
        const id = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12).toLowerCase();

        const filename = localByStem[id] || '';
        episodes.push({
          id,
          title: String(ep?.title || '').trim(),
          date: yyyyMmDd(ep?.isoDate || ep?.pubDate || ep?.published || ep?.date || ''),
          enclosure: rawUrl,
          downloaded: !!filename,
          filename,
        });
      }

      return res.json({ ok: true, rss, limit, episodes });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/episodes/list', async (req, res) => {
    try {
      assertRead('episode-list');
      const rss = normUrl(req.body?.rss);
      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });

      const subs = readSubs();
      const sub = subs.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

      if (!sub.dir || !sub.mpdPrefix) {
        return res.status(400).json({ ok: false, error: 'Subscription missing required fields (dir/mpdPrefix)', rss });
      }

      const scanLimit = Math.max(1, Math.min(200, Number(req.body?.limit ?? sub.limit ?? 100)));
      const feed = await fetchPodcastRSS(rss, scanLimit);
      const feedItems = Array.isArray(feed?.items) ? feed.items : [];
      const showImageUrl = String(feed?.imageUrl || feed?.titleImage || '').trim();

      const AUDIO_RE = /\.(mp3|m4a|aac|mp4|ogg|flac)$/i;
      const localByStem = Object.create(null);
      try {
        const names = await fsp.readdir(sub.dir);
        for (const name of names) {
          if (!AUDIO_RE.test(name)) continue;
          const stem = String(name).replace(/\.[^.]+$/, '').trim().toLowerCase();
          if (!stem) continue;
          const full = path.join(sub.dir, name);
          try {
            const st = await fsp.stat(full);
            if (!st.isFile()) continue;
            localByStem[stem] = { filename: name, path: full, mtimeMs: st.mtimeMs, size: st.size };
          } catch {}
        }
      } catch {}

      const titleByStem = Object.create(null);
      try {
        const raw = await fsp.readFile(sub.mapJson, 'utf8');
        const map = JSON.parse(raw || '{}');
        const itemsByUrl = (map && typeof map.itemsByUrl === 'object' && map.itemsByUrl) ? map.itemsByUrl : {};
        for (const v of Object.values(itemsByUrl)) {
          const fn = String(v?.filename || '').trim();
          if (!fn) continue;
          const stem = fn.replace(/\.[^.]+$/, '').trim().toLowerCase();
          if (!stem) continue;
          const t = String(v?.title || '').trim();
          if (t && !titleByStem[stem]) titleByStem[stem] = t;
        }
      } catch {}

      async function idStemForFeedItem(ep) {
        const guid = String(ep?.guid || '').trim();
        if (guid) return crypto.createHash('sha1').update(guid).digest('hex').slice(0, 12).toLowerCase();
        const rawUrl = String(ep?.enclosure || '').trim();
        if (!rawUrl) return '';
        let seed = '';
        try {
          const finalUrl = await resolveFinalUrl(rawUrl);
          seed = stripQueryHash(finalUrl || rawUrl);
        } catch {
          seed = stripQueryHash(rawUrl);
        }
        if (!seed) return '';
        return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12).toLowerCase();
      }

      const epImgByEnc = new Map();
      for (const it of feedItems) {
        const enc = String(it?.enclosure || '').trim();
        if (!enc) continue;
        const img = String(it?.image || it?.imageUrl || '').trim();
        if (!img) continue;
        epImgByEnc.set(stripQueryHash(enc), img);
      }

      const episodes = [];
      const seenStems = new Set();

      const parsePublishedMs = (ep = {}) => {
        if (typeof ep?.published === 'number' && Number.isFinite(ep.published)) return ep.published;
        const d = new Date(ep?.isoDate || ep?.pubDate || ep?.date || '');
        const t = d.getTime();
        return Number.isFinite(t) ? t : null;
      };
      const cleanTitle = (v = '') => {
        const t = String(v || '').trim();
        if (!t) return '';
        const n = t.toLowerCase();
        if (n === '(untitled)' || n === 'untitled' || n === '(downloaded episode)') return '';
        return t;
      };

      for (const ep of feedItems) {
        const enclosure = String(ep?.enclosure || '').trim();
        const stem = await idStemForFeedItem(ep);
        if (!stem) continue;

        seenStems.add(stem);
        const local = localByStem[String(stem).toLowerCase()] || null;
        const downloaded = !!(local && Number(local?.size || 0) > 65536);

        const title = cleanTitle(ep?.title) || cleanTitle(titleByStem[String(stem).toLowerCase()]) || '';
        const date = yyyyMmDd(ep?.isoDate || ep?.pubDate || ep?.published || ep?.date || '');
        const published = parsePublishedMs(ep);

        // Skip malformed feed rows with no usable metadata.
        if (!title && !date) continue;

        const episodeImageUrl =
          (enclosure ? (epImgByEnc.get(stripQueryHash(enclosure)) || '') : '') ||
          String(ep?.image || ep?.imageUrl || '').trim() ||
          showImageUrl || '';

        episodes.push({
          id: stem,
          key: `id:${stem}`,
          title: title || '(untitled)',
          date: date || '',
          published,
          downloadedAt: downloaded ? (Number(local?.mtimeMs || 0) || null) : null,
          enclosure,
          imageUrl: episodeImageUrl,
          downloaded,
          filename: downloaded ? local.filename : '',
          mpdPath: downloaded ? `${sub.mpdPrefix}/${local.filename}` : '',
        });
      }

      const titleFromLocalFilename = (name = '') => {
        let raw = String(name || '').trim();
        if (!raw) return '';
        raw = raw.replace(/\.[^.]+$/, '');
        try { raw = decodeURIComponent(raw); } catch {}
        raw = raw
          .replace(/[._]+/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/^\d{4}[-_\s]?\d{2}[-_\s]?\d{2}[-_\s]*/i, '')
          .replace(/^\d+[-_\s]+/, '')
          .trim();
        if (/^[a-f0-9]{12}$/i.test(raw)) return '';
        return raw;
      };

      for (const stem of Object.keys(localByStem)) {
        if (seenStems.has(stem)) continue;
        const local = localByStem[stem];
        const knownTitle = cleanTitle(titleByStem[String(stem).toLowerCase()]) || '';

        // Hide orphaned local files with no trustworthy metadata.
        // These are usually stale hash files and should not appear with play buttons.
        if (!knownTitle) continue;

        episodes.push({
          id: stem,
          key: `id:${stem}`,
          title: knownTitle,
          date: '',
          published: null,
          downloadedAt: Number(local?.mtimeMs || 0) || null,
          enclosure: '',
          imageUrl: showImageUrl || '',
          downloaded: !!(local && Number(local?.size || 0) > 65536),
          filename: local.filename,
          mpdPath: `${sub.mpdPrefix}/${local.filename}`,
        });
      }

      episodes.sort((a, b) => {
        const ap = (typeof a.published === 'number') ? a.published : -1;
        const bp = (typeof b.published === 'number') ? b.published : -1;
        if (bp !== ap) return bp - ap;
        if (a.published === null && b.published !== null) return 1;
        if (b.published === null && a.published !== null) return -1;
        return String(a.title).localeCompare(String(b.title));
      });

      return res.json({
        ok: true,
        rss,
        scanLimit,
        downloadedCount: Object.keys(localByStem).length,
        showImageUrl,
        episodes,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/episodes/delete', async (req, res) => {
    const reqId = `del-${Date.now().toString(36)}`;
    const logp = (...a) => console.log(`[episodes/delete][${reqId}]`, ...a);
    const errp = (...a) => console.error(`[episodes/delete][${reqId}]`, ...a);

    try {
      assertMutation('episode-delete');
      const { rss, episodeUrls } = req.body || {};
      if (!rss || !Array.isArray(episodeUrls) || episodeUrls.length === 0) {
        return res.status(400).json({ ok: false, error: 'Missing rss or episodeUrls[]' });
      }

      const subs = readSubs();
      const rssNorm = normUrl(rss);
      const sub = subs.find(s => normUrl(s?.rss) === rssNorm);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found' });

      const mapPath = sub.mapJson;
      const m3uPath = sub.outM3u;
      const dirPath = sub.dir;

      const raw = await fs.promises.readFile(mapPath, 'utf8');
      const map = JSON.parse(raw);
      const itemsByUrl = map.itemsByUrl || {};

      const deleted = [];
      const missing = [];
      const fileErrors = [];

      const localByStem = Object.create(null);
      try {
        const names = await fs.promises.readdir(dirPath);
        for (const name of names) {
          const stem = String(name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
          if (!stem) continue;
          localByStem[stem] = path.join(dirPath, name);
        }
      } catch {}

      for (const url of episodeUrls) {
        let lookupKey = String(url || '').trim();
        let it = itemsByUrl[lookupKey];

        // Support deleting by id:<stem> even when map keys are enclosure URLs.
        if (!it && /^id:[a-f0-9]{12}$/i.test(lookupKey)) {
          const stem = lookupKey.slice(3).toLowerCase();
          const foundKey = Object.keys(itemsByUrl).find((k) => {
            const v = itemsByUrl[k] || {};
            const fileName = String(v.filename || v.file || '').trim();
            const base = path.basename(fileName).replace(/\.[^.]+$/, '').toLowerCase();
            const p = String(v.path || '').trim();
            const pbase = path.basename(p).replace(/\.[^.]+$/, '').toLowerCase();
            return base === stem || pbase === stem;
          });
          if (foundKey) {
            lookupKey = foundKey;
            it = itemsByUrl[lookupKey];
          }
        }

        if (!it) {
          // Fallback: delete directly from local folder by id stem.
          if (/^id:[a-f0-9]{12}$/i.test(lookupKey)) {
            const stem = lookupKey.slice(3).toLowerCase();
            const fallbackPath = localByStem[stem] || '';
            if (fallbackPath) {
              try {
                await fs.promises.unlink(fallbackPath);
                deleted.push(url);
                continue;
              } catch (e) {
                fileErrors.push({ url, lookupKey, filePath: fallbackPath, error: e?.message || String(e) });
                continue;
              }
            }
          }

          missing.push(url);
          continue;
        }

        let filePath = '';
        if (it?.path) filePath = String(it.path).trim();
        else if (it?.file) {
          const base = path.basename(String(it.file).trim());
          if (base) filePath = path.join(dirPath, base);
        }

        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch (e) {
            errp('File delete failed', { url, lookupKey, filePath, error: e?.message || String(e) });
            fileErrors.push({ url, lookupKey, filePath, error: e?.message || String(e) });
          }
        } else {
          fileErrors.push({ url, lookupKey, filePath: '(none)', error: 'No file/path in map item' });
        }

        delete itemsByUrl[lookupKey];
        deleted.push(url);
      }

      map.itemsByUrl = itemsByUrl;
      await fs.promises.writeFile(mapPath, JSON.stringify(map, null, 2) + '\n', 'utf8');

      const eps = Object.entries(itemsByUrl).map(([enclosureUrl, it]) => ({ enclosureUrl, ...it }));
      eps.sort((a, b) => (b.published || 0) - (a.published || 0));

      const lines = [];
      for (const ep of eps) {
        if (ep.mpdPath) lines.push(ep.mpdPath);
        else if (ep.file) lines.push(path.posix.join(sub.mpdPrefix || '', ep.file));
      }

      await fs.promises.writeFile(m3uPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

      // Rebuild index from disk so map/m3u stay authoritative even if delete used fallback path.
      try {
        await rebuildPodcastLocalIndex(sub, { limit: Math.max(1, Math.min(500, Number(sub?.limit || 200))) });
      } catch (e) {
        errp('rebuild after delete failed', e?.message || String(e));
      }

      return res.json({
        ok: true,
        deletedCount: deleted.length,
        missingCount: missing.length,
        fileErrorsCount: fileErrors.length,
        deleted,
        missing,
        fileErrors,
      });
    } catch (e) {
      errp('FATAL ERROR', e);
      return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
    }
  });
}
