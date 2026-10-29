import fsp from 'node:fs/promises';

export function registerPodcastRefreshRoutes(app, deps) {
  const { capabilities, readSubs, normUrl, buildPodcastMap, writeSubs } = deps;
  const assertMutation = (capability) => capabilities?.assertExternalMutation(`podcasts.${capability}`);

  app.post('/podcasts/refresh', async (req, res) => {
    try {
      assertMutation('refresh');
      const items = readSubs();
      const results = [];

      for (const it of items) {
        const rss = normUrl(it.rss);
        const outM3u = String(it.outM3u || '').trim();
        const limit = Number(it.limit || 200);

        if (!rss || !outM3u) continue;

        try {
          const r = await buildPodcastMap({ rss, outM3u, limit });
          results.push({
            ok: true,
            rss,
            outM3u: r.outM3u,
            outJson: r.outJson,
            m3uItems: r.m3uCount,
            mapKeys: r.keyCount,
          });
        } catch (e) {
          results.push({
            ok: false,
            rss,
            outM3u,
            error: e?.message || String(e),
          });
        }
      }

      res.json({
        ok: true,
        refreshed: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/podcasts/refresh', async (req, res) => {
    try {
      assertMutation('refresh-legacy-get');
      const items = readSubs();

      const next = await Promise.all(items.map(async (s) => {
        const dir = String(s?.dir || '').trim();
        let downloadedCount = 0;

        if (dir) {
          try {
            const names = await fsp.readdir(dir);
            downloadedCount = names.filter(n => /\.(mp3|m4a|aac|mp4)$/i.test(n)).length;
          } catch {}
        }

        const autoDownload = (typeof s?.autoDownload === 'boolean')
          ? s.autoDownload
          : (s?.autoLatest === true);

        return { ...s, downloadedCount, autoDownload };
      }));

      // Safety: never overwrite subscriptions with an empty array during a transient path/config issue.
      if (next.length > 0) {
        writeSubs(next);
      }
      res.json({ ok: true, items: next, persisted: next.length > 0 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/refresh-one', async (req, res) => {
    try {
      assertMutation('refresh-one');
      const items = readSubs();

      const rssIn = normUrl(req.body?.rss || req.query?.rss);
      const outM3uIn = String(req.body?.outM3u || req.query?.outM3u || '').trim();

      if (!rssIn && !outM3uIn) {
        return res.status(400).json({ ok: false, error: 'Provide rss or outM3u' });
      }

      const it = items.find(x => {
        const rss = normUrl(x?.rss);
        const outM3u = String(x?.outM3u || '').trim();
        return (rssIn && rss && rss === rssIn) || (outM3uIn && outM3u && outM3u === outM3uIn);
      });

      if (!it) {
        return res.status(404).json({
          ok: false,
          error: 'Subscription not found',
          rss: rssIn || null,
          outM3u: outM3uIn || null,
        });
      }

      const rss = normUrl(it.rss);
      const outM3u = it.outM3u;
      const limit = Number(it.limit || 200);

      if (!rss || !outM3u) {
        return res.status(400).json({ ok: false, error: 'Subscription missing rss/outM3u' });
      }

      const r = await buildPodcastMap({ rss, outM3u, limit });

      const result = {
        rss,
        outM3u: r.outM3u,
        outJson: r.outJson,
        m3uItems: r.m3uCount,
        mapKeys: r.keyCount,
      };

      res.json({ ok: true, refreshed: 1, results: [result] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/podcasts/refresh-one', async (req, res) => {
    try {
      assertMutation('refresh-one-legacy-get');
      const outM3u = String(req.query.outM3u || '').trim();
      if (!outM3u) {
        return res.status(400).json({ ok: false, error: 'Missing outM3u', rss: null, outM3u: null });
      }

      const items = readSubs();
      const sub = items.find((it) => String(it?.outM3u || '').trim() === outM3u);

      if (!sub) {
        return res.status(404).json({ ok: false, error: 'Subscription not found', rss: null, outM3u });
      }

      const rss = normUrl(sub.rss);
      const limit = Number(sub.limit || 200);

      if (!rss) {
        return res.status(400).json({ ok: false, error: 'Subscription has invalid rss', rss: null, outM3u });
      }

      const r = await buildPodcastMap({ rss, outM3u, limit });

      return res.json({
        ok: true,
        refreshed: 1,
        results: [{
          rss,
          outM3u: r.outM3u,
          outJson: r.outJson,
          m3uItems: r.m3uCount,
          mapKeys: r.keyCount,
        }],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
