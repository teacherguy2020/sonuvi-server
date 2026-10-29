import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';

export function registerPodcastSubscriptionRoutes(app, deps) {
  const {
    capabilities,
    normUrl,
    readSubs,
    writeSubs,
    makePodcastId,
    fetchPodcastRSS,
    downloadCoverForSub,
    syncSubscriptionInitial,
    execFileP,
    musicLibraryRoot,
    podcastRoot,
  } = deps;
  const assertMutation = (capability) => capabilities?.assertExternalMutation(`podcasts.${capability}`);

  const parseAutoDownload = (value, fallback = false) => {
    if (value === undefined || value === null) return !!fallback;
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return !!fallback;
  };

  app.get('/podcasts', async (req, res) => {
    const items = readSubs();

    const enriched = items.map(it => {
      let n = null;
      let lastBuilt = '';
      try {
        if (it.mapJson && fs.existsSync(it.mapJson)) {
          const st = fs.statSync(it.mapJson);
          lastBuilt = st.mtime.toISOString();
          const j = JSON.parse(fs.readFileSync(it.mapJson, 'utf8'));
          const keys = j?.itemsByUrl ? Object.keys(j.itemsByUrl) : [];
          n = keys.length;
        }
      } catch {}
      return { ...it, items: n, lastBuilt };
    });

    res.json({ ok: true, items: enriched });
  });

  app.get('/podcasts/list', (req, res) => {
    req.url = '/podcasts';
    return app._router.handle(req, res, () => {});
  });

  app.post('/podcasts/subscribe', async (req, res) => {
    const reqId = `sub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const t0 = Date.now();

    const logp = (msg, obj) => console.log(`[subscribe][${reqId}] ${msg}`, obj || '');
    const errp = (msg, obj) => console.error(`[subscribe][${reqId}] ${msg}`, obj || '');

    let aborted = false;

    req.on('aborted', () => {
      aborted = true;
      errp('CLIENT ABORTED', { ms: Date.now() - t0 });
    });

    res.on('close', () => {
      logp('RES CLOSE', {
        ms: Date.now() - t0,
        headersSent: res.headersSent,
        finished: res.writableEnded,
        aborted,
      });
    });

    res.on('finish', () => {
      logp('RES FINISH', { ms: Date.now() - t0 });
    });

    logp('BEGIN', { body: req.body });

    try {
      assertMutation('subscribe');
      const rss = normUrl(req.body?.rss);
      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });

      const limit = Math.max(1, Math.min(500, Number(req.body?.limit || 200)));
      const downloadCount = Math.max(0, Math.min(50, Number(req.body?.download ?? 5)));

      const id = makePodcastId(rss);
      const podcastMapDir = runtimeStatePaths().podcastMapDir;
      await fsp.mkdir(podcastMapDir, { recursive: true });
      const outM3u = path.join(podcastMapDir, `${id}.m3u`);
      const mapJson = path.join(podcastMapDir, `${id}.json`);

      const items = readSubs();
      const idx = items.findIndex(it => normUrl(it?.rss) === rss);
      const prev = idx >= 0 ? (items[idx] || {}) : {};
      const requestedAutoDownload = parseAutoDownload(req.body?.autoDownload, prev?.autoDownload ?? prev?.autoLatest ?? false);

      logp('INPUTS', { rss, limit, downloadCount, id, existed: idx >= 0, autoDownload: requestedAutoDownload });

      function safeFolderNameKeepSpaces(s, fallback = 'Podcast') {
        let t = String(s || '').trim();
        if (!t) return fallback;

        t = t
          .replace(/[\u0000-\u001F\u007F]/g, '')
          .replace(/[\/\\:*?"<>|]/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!t || t === '.' || t === '..') return fallback;
        if (t.length > 80) t = t.slice(0, 80).trim();
        return t || fallback;
      }

      function safePlaylistCoverName(title, fallback = 'Podcast') {
        const base = safeFolderNameKeepSpaces(title, fallback);
        return `${base}.jpg`;
      }

      function moodePathFromPi4Mount(p) {
        const s = String(p || '');
        if (s.startsWith('/mnt/SamsungMoode/')) return s.replace('/mnt/SamsungMoode/', '/media/SamsungMoode/');
        return s;
      }

      async function pushPlaylistCoverToMoode(sub) {
        const showTitle = String(sub?.title || '').trim() || 'Podcast';
        const coverName = safePlaylistCoverName(showTitle, 'Podcast');

        const srcOnMoode = moodePathFromPi4Mount(path.join(sub.dir, 'cover.jpg'));
        const dstOnMoode = path.posix.join('/var/local/www/imagesw/playlist-covers', coverName);

        const cmd = [
          'bash',
          '-lc',
          [
            'set -e',
            `test -f "${srcOnMoode}"`,
            `sudo cp -f "${srcOnMoode}" "${dstOnMoode}"`,
            `sudo chmod 644 "${dstOnMoode}"`,
            `sudo chown root:root "${dstOnMoode}"`,
          ].join(' && '),
        ];

        logp('COVER PUSH start', { srcOnMoode, dstOnMoode });
        await execFileP('ssh', ['moode@moode.local', ...cmd]);
        logp('COVER PUSH ok', { srcOnMoode, dstOnMoode });

        return { ok: true, srcOnMoode, dstOnMoode, coverName };
      }

      let feedTitleRaw = String(prev?.title || '').trim();
      let feedImageUrl = String(prev?.imageUrl || '').trim();
      let feedForArt = null;

      if (!feedTitleRaw || feedTitleRaw === rss || !feedImageUrl) {
        try {
          logp('RSS LIGHT fetch start', { wantItems: Math.max(1, Math.min(3, downloadCount || 1)) });

          const feed = await fetchPodcastRSS(rss, Math.max(1, Math.min(3, downloadCount || 1)));
          feedForArt = feed;

          const t = String(feed?.title || '').trim();
          if (t) feedTitleRaw = t;

          const img =
            String(feed?.imageUrl || '').trim() ||
            String(feed?.items?.[0]?.image || '').trim() ||
            '';

          if (img) feedImageUrl = img;

          logp('RSS LIGHT ok', {
            title: feedTitleRaw || null,
            imageUrl: feedImageUrl ? '[set]' : '',
            itemCount: Array.isArray(feed?.items) ? feed.items.length : null,
          });
        } catch (e) {
          errp('RSS LIGHT failed', { rss, err: e?.message || String(e) });
        }
      } else {
        logp('RSS LIGHT skip (have prev)', { feedTitleRaw: !!feedTitleRaw, feedImageUrl: !!feedImageUrl });
      }

      let folder =
        (prev?.dir ? path.basename(String(prev.dir)) : '') ||
        safeFolderNameKeepSpaces(feedTitleRaw, '');

      if (!folder) {
        folder = safeFolderNameKeepSpaces(
          (() => {
            try {
              const u = new URL(rss);
              const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
              return last.replace(/\.(rss|xml)$/i, '');
            } catch {
              return 'Podcast';
            }
          })(),
          'Podcast'
        );
      }

      folder = safeFolderNameKeepSpaces(folder, 'Podcast');

      const configuredPodcastRoot = String(
        podcastRoot ||
        process.env.PODCAST_ROOT ||
        process.env.PODCAST_SHOWS_DIR ||
        (musicLibraryRoot ? path.join(String(musicLibraryRoot), 'Podcasts') : '')
      ).trim();
      if (!configuredPodcastRoot) {
        return res.status(500).json({ ok: false, error: 'Podcast root is not configured. Set paths.podcastRoot in now-playing.config.json.' });
      }

      try {
        await fsp.mkdir(configuredPodcastRoot, { recursive: true });
        await fsp.access(configuredPodcastRoot, fs.constants.W_OK);
      } catch (e) {
        return res.status(500).json({
          ok: false,
          error: `Podcast root is not writable: ${configuredPodcastRoot}`,
          detail: e?.message || String(e),
          podcastRoot: configuredPodcastRoot,
        });
      }

      const dir = String(prev?.dir || '').trim() || path.join(configuredPodcastRoot, folder);
      const mpdPrefix = String(prev?.mpdPrefix || '').trim() || `USB/SamsungMoode/Podcasts/${folder}`;

      const rootReal = path.resolve(configuredPodcastRoot) + path.sep;
      const dirReal = path.resolve(dir) + path.sep;
      if (!dirReal.startsWith(rootReal)) {
        return res.status(400).json({
          ok: false,
          error: 'Subscription dir is outside configured podcastRoot. Please update subscription path.',
          dir,
          podcastRoot: configuredPodcastRoot,
        });
      }

      logp('PATHS', { folder, dir, mpdPrefix, outM3u, mapJson, podcastRoot: configuredPodcastRoot });

      await fsp.mkdir(dir, { recursive: true });

      const title = feedTitleRaw || String(prev?.title || '').trim() || rss;

      const sub = {
        ...prev,
        title,
        rss,
        dir,
        mpdPrefix,
        outM3u,
        mapJson,
        limit,
        download: Math.max(0, Math.min(50, Number(req.body?.download ?? prev?.download ?? 5))),
        imageUrl: feedImageUrl || String(prev?.imageUrl || '').trim() || '',
        autoDownload: requestedAutoDownload,
      };

      if (idx >= 0) items[idx] = sub;
      else items.unshift(sub);
      writeSubs(items);

      logp('SUB SAVED', { title: sub.title, dir: sub.dir });

      let coverWork = { ok: false };

      try {
        logp('COVER start', {});

        const feed = feedForArt || (await fetchPodcastRSS(rss, 1));
        const cov = await downloadCoverForSub(sub, feed);

        if (cov?.ok) {
          const pushed = await pushPlaylistCoverToMoode(sub);
          coverWork = { ok: true, cover: cov, playlist: pushed };
          logp('COVER ok', { playlist: pushed?.ok === true });
        } else {
          coverWork = { ok: false, cover: cov };
          errp('COVER no/failed', { cov });
        }
      } catch (e) {
        coverWork = { ok: false, error: e?.message || String(e) };
        errp('COVER step failed', { rss, error: e?.message || String(e) });
      }

      const work = { sync: null };

      try {
        logp('SYNC start', { limit, downloadCount });

        const r = await syncSubscriptionInitial({ sub, limit, downloadCount });

        work.sync = {
          ok: true,
          downloaded: r.downloaded || 0,
          skipped: r.skipped || 0,
          failed: r.failed || 0,
          mapCount: r.mapCount || 0,
          m3uCount: r.m3uCount || 0,
        };

        logp('SYNC ok', work.sync);
      } catch (e) {
        work.sync = { ok: false, error: e?.message || String(e) };
        errp('SYNC failed', work.sync);
      }

      const elapsedMs = Date.now() - t0;

      logp('RESPONDING', {
        ms: elapsedMs,
        title: sub.title,
        rss: sub.rss,
        syncOk: work?.sync?.ok === true,
        mapCount: work?.sync?.mapCount,
        m3uCount: work?.sync?.m3uCount,
        coverOk: coverWork?.ok === true,
      });

      logp(
        `SUMMARY title="${sub.title}" downloaded=${work?.sync?.downloaded ?? 0} skipped=${work?.sync?.skipped ?? 0} failed=${work?.sync?.failed ?? 0} map=${work?.sync?.mapCount ?? 0} m3u=${work?.sync?.m3uCount ?? 0} cover=${coverWork?.ok === true ? 'ok' : 'no'} ms=${elapsedMs}`
      );

      return res.json({ ok: true, subscription: sub, work, coverWork });

    } catch (e) {
      errp('FATAL', { error: e?.message || String(e), stack: e?.stack, ms: Date.now() - t0 });
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/subscription/settings', async (req, res) => {
    assertMutation('subscription-settings');
    const rss = normUrl(req.body?.rss);
    if (!rss) return res.status(400).json({ ok: false, error: 'rss required' });

    const items = readSubs();
    const idx = items.findIndex(x => normUrl(x?.rss) === rss);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

    const prev = items[idx] || {};
    const autoDownload = parseAutoDownload(req.body?.autoDownload, prev?.autoDownload ?? prev?.autoLatest ?? false);

    items[idx] = {
      ...prev,
      autoDownload,
    };

    writeSubs(items);
    return res.json({ ok: true, rss, autoDownload, subscription: items[idx] });
  });

  app.post('/podcasts/unsubscribe', async (req, res) => {
    assertMutation('unsubscribe');
    const rss = normUrl(req.body?.rss);
    if (!rss) return res.status(400).json({ ok: false, error: 'rss required' });

    const items = readSubs();
    const next = items.filter(x => normUrl(x.rss) !== rss);

    if (next.length === items.length) {
      return res.json({ ok: true, removed: false });
    }

    writeSubs(next);
    res.json({ ok: true, removed: true });
  });
}
