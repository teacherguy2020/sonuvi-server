import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { MPD_HOST, MPD_PORT, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { writeJsonAtomically } from '../lib/atomic-file.mjs';

export function registerPodcastDownloadRoutes(app, deps) {
  const { capabilities } = deps;
  const assertMutation = (capability) => capabilities?.assertExternalMutation(`podcasts.${capability}`);
  const NIGHTLY_STATE_PATH = runtimeStatePaths().podcastsNightlyStatePath;
  const readNightlyState = async () => {
    try { return JSON.parse(await fsp.readFile(NIGHTLY_STATE_PATH, 'utf8')); } catch { return {}; }
  };
  const writeNightlyState = async (patch) => {
    capabilities?.assertStateWrite(NIGHTLY_STATE_PATH);
    const prev = await readNightlyState();
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    await writeJsonAtomically(NIGHTLY_STATE_PATH, next);
    return next;
  };

  const {
    normUrl,
    readSubs,
    makePodcastId,
    podcastRoot,
    ensureDir,
    safeFileName,
    downloadToFile,
    embedArtWithFfmpeg,
    hasAttachedPic,
    replaceFileAtomic,
    safeUnlink,
    fetchPodcastRSS,
    downloadCoverForSub,
    stripQueryHash,
    downloadWithFetch,
    tagAudioFileWithFfmpeg,
    yyyyMmDd,
    getLocalItemsForSub,
    buildPodcastMapFromLocalItems,
    buildLocalPlaylistForRss,
  } = deps;

  const runMpcUpdate = async (targetPath = '') => {
    assertMutation('mpd-update');
    const p = String(targetPath || '').trim();
    if (!p) return;
    await new Promise((resolve, reject) => {
      execFile('mpc', ['-h', String(MPD_HOST || 'moode.local'), '-p', String(MPD_PORT || 6600), 'update', p], { timeout: 15000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  };

  const configuredPodcastRoot = String(podcastRoot || process.env.PODCAST_ROOT || process.env.PODCAST_SHOWS_DIR || '').trim();
  const assertPodcastRootWritable = async () => {
    capabilities?.assertStateWrite(configuredPodcastRoot);
    if (!configuredPodcastRoot) throw new Error('Podcast root is not configured (paths.podcastRoot).');
    await fsp.mkdir(configuredPodcastRoot, { recursive: true });
    await fsp.access(configuredPodcastRoot, fs.constants.W_OK);
    return configuredPodcastRoot;
  };
  const assertSubDirWithinRoot = (subDir) => {
    const rootReal = path.resolve(configuredPodcastRoot) + path.sep;
    const dirReal = path.resolve(String(subDir || '')) + path.sep;
    if (!dirReal.startsWith(rootReal)) {
      throw new Error(`Subscription dir is outside configured podcastRoot: ${subDir}`);
    }
  };

  app.get('/podcasts/nightly-status', async (_req, res) => {
    try {
      const state = await readNightlyState();
      return res.json({ ok: true, state });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/nightly-retention', async (req, res) => {
    try {
      assertMutation('nightly-retention');
      const enabled = !!req.body?.enabled;
      const days = Math.max(1, Math.min(3650, Number(req.body?.days || 30)));
      const state = await writeNightlyState({ retentionEnabled: enabled, retentionDays: days });
      return res.json({ ok: true, state });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/cleanup-older-than', async (req, res) => {
    try {
      assertMutation('cleanup');
      const days = Math.max(1, Math.min(3650, Number(req.body?.days || 30)));
      const dryRun = req.body?.dryRun === true;
      const cutoff = Date.now() - days * 86400000;
      const subs = readSubs();
      let scanned = 0;
      let deleted = 0;
      let wouldDelete = 0;
      const exts = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.flac', '.wav', '.mp4']);
      for (const sub of subs) {
        const dir = String(sub?.dir || '').trim();
        if (!dir) continue;
        let names = [];
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const name of names) {
          const ext = path.extname(name).toLowerCase();
          if (!exts.has(ext)) continue;
          const full = path.join(dir, name);
          try {
            const st = await fsp.stat(full);
            if (!st.isFile()) continue;
            scanned += 1;
            if ((st.mtimeMs || 0) < cutoff) {
              wouldDelete += 1;
              if (!dryRun) {
                await fsp.unlink(full).catch(() => {});
                deleted += 1;
              }
            }
          } catch {}
        }
      }

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, days, scanned, wouldDelete, targets: subs.length });
      }

      const state = await writeNightlyState({
        lastRunAt: new Date().toISOString(),
        lastRunType: 'cleanup-older-than',
        retentionDays: days,
        lastRunScanned: scanned,
        lastRunDeleted: deleted,
      });
      return res.json({ ok: true, days, scanned, deleted, wouldDelete, targets: subs.length, state });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/build-playlist', async (req, res) => {
    try {
      assertMutation('build-playlist');
      const rss = normUrl(req.body?.rss);
      const newestFirst = req.body?.newestFirst !== false;
      const limit = Math.max(1, Math.min(5000, Number(req.body?.limit || 500)));

      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });

      const items = readSubs();
      const sub = items.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

      const dir = String(sub.dir || '').trim();
      const mpdPrefix = String(sub.mpdPrefix || '').trim();
      if (!dir || !mpdPrefix) {
        return res.status(400).json({
          ok: false,
          error: 'Subscription missing dir/mpdPrefix (download folder). Re-subscribe or fix subscriptions.json.',
          rss,
          dir: dir || null,
          mpdPrefix: mpdPrefix || null,
        });
      }

      const base =
        String(req.body?.name || '').trim() ||
        String(sub.slug || '').trim() ||
        makePodcastId(rss);

      const playlistName = `${base}-local`;
      const playlistFile = `/var/lib/mpd/playlists/${playlistName}.m3u`;

      const exts = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.flac', '.wav']);
      const entries = [];

      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = [];
      }

      for (const name of names) {
        if (!exts.has(path.extname(name).toLowerCase())) continue;

        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          entries.push({ name, full, mtimeMs: st.mtimeMs || 0 });
        } catch {}
      }

      if (!entries.length) {
        return res.json({
          ok: true,
          rss,
          playlistName,
          wrote: false,
          reason: 'No local audio files found in dir yet',
          dir,
          mpdPrefix,
          count: 0,
        });
      }

      entries.sort((a, b) =>
        newestFirst ? (b.mtimeMs - a.mtimeMs) : (a.mtimeMs - b.mtimeMs)
      );

      const chosen = entries.slice(0, limit);
      const lines = chosen.map(x => `${mpdPrefix}/${x.name}`).join('\n') + '\n';

      const MOODE_HOST = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
      const MOODE_USER = String(MOODE_SSH_USER || 'moode');
      const MPD_PORT_NUM = Number(MPD_PORT || 6600);

      const execFileP = (cmd, args, opts = {}) =>
        new Promise((resolve, reject) => {
          const child = execFile(cmd, args, { ...opts }, (err, stdout, stderr) => {
            if (err) {
              err.stdout = stdout;
              err.stderr = stderr;
              return reject(err);
            }
            resolve({ stdout, stderr });
          });

          if (opts.input != null) child.stdin.end(opts.input);
        });

      await execFileP(
        'ssh',
        [`${MOODE_USER}@${MOODE_HOST}`, 'sudo', 'tee', playlistFile],
        { input: lines, maxBuffer: 10 * 1024 * 1024 }
      );

      await execFileP('mpc', ['-h', MOODE_HOST, '-p', String(MPD_PORT_NUM), 'update', mpdPrefix]);

      return res.json({
        ok: true,
        rss,
        playlistName,
        playlistFile,
        dir,
        mpdPrefix,
        newestFirst,
        limit,
        count: chosen.length,
        sample: chosen.slice(0, 5).map(x => x.name),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/download-one', async (req, res) => {
    try {
      assertMutation('download-one');
      const rss = normUrl(req.body?.rss);
      const id = String(req.body?.id || '').trim().toLowerCase();
      const enclosure = String(req.body?.enclosure || '').trim();
      const imageUrl = String(req.body?.imageUrl || '').trim();

      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });
      if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ ok: false, error: 'Missing/invalid id' });
      if (!/^https?:\/\//i.test(enclosure)) return res.status(400).json({ ok: false, error: 'Missing/invalid enclosure' });

      const subs = readSubs();
      const sub = subs.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });

      if (!sub.dir || !sub.mpdPrefix) {
        return res.status(400).json({ ok: false, error: 'Subscription missing required fields (dir/mpdPrefix)', rss });
      }
      try {
        await assertPodcastRootWritable();
        assertSubDirWithinRoot(sub.dir);
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e), podcastRoot: configuredPodcastRoot, dir: String(sub.dir || '') });
      }

      const rawTitle = String(req.body?.title || '').trim();
      const rawDate = String(req.body?.date || '').trim();
      const show = String(sub?.title || sub?.name || 'Podcast').trim();

      const dateTag = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';
      const yearTag =
        /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate.slice(0, 4) :
          /^\d{4}$/.test(rawDate) ? rawDate :
            '';

      const finalName = `${id}.mp3`;
      const finalPath = path.join(sub.dir, finalName);
      await ensureDir(finalPath);

      const destDir = path.dirname(finalPath);
      const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

      const mp3Tmp = path.join(destDir, `.${finalName}.${nonce}.dl.tmp.mp3`);
      const jpgTmp = path.join(destDir, `.${id}.${nonce}.tmp.jpg`);
      const outTmp = path.join(destDir, `.${finalName}.${nonce}.tagged.tmp.mp3`);

      let embeddedArt = false;

      try {
        await downloadToFile(enclosure, mp3Tmp, { retries: 3 });

        let toInstall = mp3Tmp;

        if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
          await downloadToFile(imageUrl, jpgTmp, { retries: 3 });

          await embedArtWithFfmpeg({
            mp3In: mp3Tmp,
            imgIn: jpgTmp,
            mp3Out: outTmp,
            title: rawTitle,
            show,
            date: dateTag,
            year: yearTag,
          });

          const ok = await hasAttachedPic(outTmp);
          if (ok) {
            toInstall = outTmp;
            embeddedArt = true;
          } else {
            toInstall = mp3Tmp;
            embeddedArt = false;
          }
        }

        await replaceFileAtomic(toInstall, finalPath);

        let playlistSync = { ok: false };
        try {
          await buildLocalPlaylistForRss({ rss: sub.rss });
          playlistSync = { ok: true };
        } catch (e) {
          playlistSync = { ok: false, error: e?.message || String(e) };
        }

        let mpdUpdate = { ok: false };
        try {
          await runMpcUpdate(String(sub.mpdPrefix || '').trim());
          mpdUpdate = { ok: true, path: String(sub.mpdPrefix || '').trim() };
        } catch (e) {
          mpdUpdate = { ok: false, error: e?.message || String(e), path: String(sub.mpdPrefix || '').trim() };
        }

        return res.json({
          ok: true,
          rss,
          id,
          filename: finalName,
          mpdPath: `${sub.mpdPrefix}/${finalName}`,
          embeddedArt,
          playlistSync,
          mpdUpdate,
        });
      } finally {
        await safeUnlink(mp3Tmp);
        await safeUnlink(jpgTmp);
        await safeUnlink(outTmp);
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const runDownloadLatestForSubscription = async (sub, requestedCount = 5) => {
    const rss = normUrl(sub?.rss);
    const count = Math.max(0, Math.min(50, Number(requestedCount ?? 5)));

    if (!rss) throw new Error('Missing/invalid rss');
    if (!sub?.dir || !sub?.mpdPrefix || !sub?.outM3u || !sub?.mapJson) {
      throw new Error('Subscription missing required fields (dir/mpdPrefix/outM3u/mapJson)');
    }

    await assertPodcastRootWritable();
    assertSubDirWithinRoot(sub.dir);
    await fsp.mkdir(sub.dir, { recursive: true });

    const limit = Number(sub.limit || 200);
    const scanN = Math.max(count, Math.min(limit, 200));

    const feed = await fetchPodcastRSS(rss, scanN);
    await downloadCoverForSub(sub, feed);
    const feedItems = Array.isArray(feed?.items) ? feed.items : [];
    const episodes = feedItems.slice(0, count);

    const existing = new Set();
    try {
      for (const f of fs.readdirSync(sub.dir)) existing.add(f);
    } catch {}

    const results = [];

    for (const ep of episodes) {
      const rawUrl = String(ep?.enclosure || '').trim();
      if (!rawUrl) continue;

      // Keep signed query params for actual download requests.
      // Use a normalized URL only for stable local IDs.
      const canonUrl = stripQueryHash(rawUrl);

      const guid = String(ep?.guid || '').trim();
      const seed = guid || canonUrl;
      const id = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);

      let ext = '.mp3';
      try {
        const u = new URL(rawUrl);
        const base = path.basename(u.pathname) || '';
        const m = base.toLowerCase().match(/\.(mp3|m4a|aac|mp4)$/);
        if (m) ext = `.${m[1]}`;
      } catch {}

      const filename = safeFileName(`${id}${ext}`, `episode${ext}`);

      if (existing.has(filename)) {
        results.push({ ok: true, skipped: true, id, filename });
        continue;
      }

      const outPath = path.join(sub.dir, filename);
      await downloadWithFetch(rawUrl, outPath);
      existing.add(filename);

      try {
        await tagAudioFileWithFfmpeg(outPath, {
          title: String(ep?.title || '').trim() || id,
          album: String(sub.title || '').trim() || 'Podcast',
          artist: String(sub.title || '').trim() || 'Podcast',
          date: yyyyMmDd(ep?.isoDate || ep?.pubDate || ep?.published || ep?.date || ''),
          genre: 'Podcast',
          comment: rawUrl,
        });
      } catch {}

      results.push({
        ok: true,
        skipped: false,
        id,
        filename,
        saved: { path: outPath, mpdPath: `${sub.mpdPrefix}/${filename}` },
      });
    }

    const metaByStem = Object.create(null);
    for (const ep of feedItems) {
      const rawUrl = String(ep?.enclosure || '').trim();
      if (!rawUrl) continue;
      const canonUrl = stripQueryHash(rawUrl);
      const guid = String(ep?.guid || '').trim();
      const seed = guid || canonUrl;
      const id = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
      metaByStem[id] = {
        title: String(ep?.title || '').trim(),
        date: yyyyMmDd(ep?.isoDate || ep?.pubDate || ep?.published || ep?.date || ''),
      };
    }

    const localItems = await getLocalItemsForSub(sub, metaByStem);
    const mapRes = await buildPodcastMapFromLocalItems({
      sub,
      items: localItems,
      outM3u: sub.outM3u,
      mapJson: sub.mapJson,
    });

    try { await buildLocalPlaylistForRss({ rss: sub.rss }); } catch {}
    try { await runMpcUpdate(String(sub.mpdPrefix || '').trim()); } catch {}

    return {
      ok: true,
      rss,
      requested: count,
      processed: results.length,
      downloaded: results.filter((r) => r && r.ok && !r.skipped).length,
      skipped: results.filter((r) => r && r.ok && r.skipped).length,
      results,
      map: mapRes,
    };
  };

  app.post('/podcasts/download-latest', async (req, res) => {
    try {
      assertMutation('download-latest');
      const rss = normUrl(req.body?.rss);
      const count = Math.max(0, Math.min(50, Number(req.body?.count ?? 5)));
      if (!rss) return res.status(400).json({ ok: false, error: 'Missing/invalid rss' });
      const subs = readSubs();
      const sub = subs.find(it => normUrl(it?.rss) === rss);
      if (!sub) return res.status(404).json({ ok: false, error: 'Subscription not found', rss });
      const out = await runDownloadLatestForSubscription(sub, count);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/podcasts/nightly-run', async (_req, res) => {
    try {
      assertMutation('nightly-run');
      const subs = readSubs();
      const targets = subs.filter((s) => (s?.autoDownload === true) || (s?.autoLatest === true));

      const results = [];
      let downloaded = 0;
      let skipped = 0;
      let failed = 0;

      for (const sub of targets) {
        try {
          const count = Math.max(0, Math.min(50, Number(sub?.download ?? 5)));
          const out = await runDownloadLatestForSubscription(sub, count);
          downloaded += Number(out?.downloaded || 0);
          skipped += Number(out?.skipped || 0);
          results.push({ ok: true, rss: out?.rss || normUrl(sub?.rss), downloaded: out?.downloaded || 0, skipped: out?.skipped || 0, processed: out?.processed || 0 });
        } catch (e) {
          failed += 1;
          results.push({ ok: false, rss: normUrl(sub?.rss), error: e?.message || String(e) });
        }
      }

      const stateBefore = await readNightlyState();
      let retentionDeleted = 0;
      if (stateBefore?.retentionEnabled) {
        const days = Math.max(1, Math.min(3650, Number(stateBefore?.retentionDays || 30)));
        const cutoff = Date.now() - days * 86400000;
        const exts = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.flac', '.wav', '.mp4']);
        for (const sub of subs) {
          const dir = String(sub?.dir || '').trim();
          if (!dir) continue;
          let names = [];
          try { names = await fsp.readdir(dir); } catch { continue; }
          for (const name of names) {
            const ext = path.extname(name).toLowerCase();
            if (!exts.has(ext)) continue;
            const full = path.join(dir, name);
            try {
              const st = await fsp.stat(full);
              if (!st.isFile()) continue;
              if ((st.mtimeMs || 0) < cutoff) {
                await fsp.unlink(full).catch(() => {});
                retentionDeleted += 1;
              }
            } catch {}
          }
        }
      }

      const state = await writeNightlyState({
        lastRunAt: new Date().toISOString(),
        lastRunType: 'nightly-auto-download',
        lastRunTargets: targets.length,
        lastRunDownloaded: downloaded,
        lastRunSkipped: skipped,
        lastRunFailed: failed,
        lastRunDeleted: retentionDeleted,
      });

      return res.json({ ok: true, targets: targets.length, downloaded, skipped, failed, retentionDeleted, results, state });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
