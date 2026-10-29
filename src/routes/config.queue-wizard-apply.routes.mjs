import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { saveStoredPlaylist } from '../lib/mpd-stored-playlist.mjs';

const execFileP = promisify(execFile);

function safePlaylistName(name = '') {
  return String(name || '')
    .replace(/[^A-Za-z0-9 _.\-]/g, '')
    .trim();
}

export function registerConfigQueueWizardApplyRoute(app, deps) {
  const { requireTrackKey, mpdQueryRaw } = deps;

  app.post('/config/queue-wizard/add-to-playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const rawName = String(req.body?.playlistName || '').trim();
      const playlistName = safePlaylistName(rawName);
      if (!playlistName || playlistName !== rawName) {
        return res.status(400).json({ ok: false, error: 'playlistName is required and may contain only letters, numbers, spaces, _, ., or -' });
      }
      const tracks = Array.isArray(req.body?.tracks)
        ? req.body.tracks.map((x) => String(x || '').trim().replace(/[\\/]+$/g, '')).filter(Boolean)
        : [];
      if (!tracks.length) return res.status(400).json({ ok: false, error: 'tracks[] is required' });

      const mpdHost = String(MPD_HOST || 'moode.local');

      // Add directly to MPD's saved playlist. Reading and rewriting the m3u
      // file is racy and, on moOde, can replace the playlist when the read
      // command is unsupported. MPD's addplaylist command appends each entry
      // to an existing playlist and creates it when needed.
      for (const track of tracks) {
        await execFileP('mpc', ['-h', mpdHost, 'addplaylist', playlistName, track], { timeout: 15000 });
      }

      return res.json({ ok: true, playlistName, added: tracks.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // --- apply route ---
  app.post('/config/queue-wizard/apply', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const mode = String(req.body?.mode || 'replace').trim().toLowerCase();
      const saveOnly = Boolean(req.body?.saveOnly);
      if (!['replace', 'append'].includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode must be replace|append' });
      }

      const shuffle = Boolean(req.body?.shuffle);
      const forceRandomOff = Boolean(req.body?.forceRandomOff);
      const fastStart = req.body?.fastStart !== false;
      const shouldPlay = !(
        req.body?.play === false
        || String(req.body?.play || '').trim().toLowerCase() === 'false'
      );
      const generateCollage = Boolean(req.body?.generateCollage);
      const previewCoverBase64 = String(req.body?.previewCoverBase64 || '').trim();
      const previewCoverMimeType = String(req.body?.previewCoverMimeType || 'image/jpeg').trim().toLowerCase();

      const keepNowPlaying =
        req.body?.keepNowPlaying === true ||
        req.body?.crop === true ||
        String(req.body?.keepNowPlaying || '').toLowerCase() === 'true' ||
        String(req.body?.crop || '').toLowerCase() === 'true';

      const tracks = Array.isArray(req.body?.tracks)
        ? req.body.tracks
            .map((x) => String(x || '').trim())
            .map((f) => f.replace(/[\\/]+$/g, ''))
            .filter(Boolean)
        : [];
      const trackMeta = Array.isArray(req.body?.trackMeta) ? req.body.trackMeta : [];

      const playlistName = String(req.body?.playlistName || '').trim();
      if (saveOnly && !playlistName) return res.status(400).json({ ok: false, playlistSaved: false, error: 'playlistName is required' });
      if (!tracks.length) return res.status(400).json({ ok: false, error: 'tracks[] is required' });

      const mpdHost = String(MPD_HOST || 'moode.local');

      let didCrop = false;
      let didClear = false;
      let randomTurnedOff = false;

      let added = 0;
      let playStarted = false;
      const failedFiles = [];
      const addedFiles = [];

      if (!saveOnly) {
        if (mode === 'replace') {
          if (keepNowPlaying) {
            await execFileP('mpc', ['-h', mpdHost, 'crop']);
            didCrop = true;
          } else {
            await execFileP('mpc', ['-h', mpdHost, 'clear']);
            didClear = true;
          }

          // Always disable random before building a deterministic queue.
          try {
            await execFileP('mpc', ['-h', mpdHost, 'random', 'off']);
            randomTurnedOff = true;
          } catch (_) {}
        }

        if (forceRandomOff && !randomTurnedOff) {
          try {
            await execFileP('mpc', ['-h', mpdHost, 'random', 'off']);
            randomTurnedOff = true;
          } catch (_) {}
        }

        let startIdx = 0;
        if (mode === 'replace' && !didCrop && shouldPlay && fastStart && tracks.length) {
          const first = String(tracks[0] || '').trim();
          if (first) {
            try {
              await execFileP('mpc', ['-h', mpdHost, 'add', first]);
              added += 1;
              addedFiles.push(first);
              startIdx = 1;
              try {
                await execFileP('mpc', ['-h', mpdHost, 'play']);
                playStarted = true;
              } catch (_) {}
            } catch (_) {
              failedFiles.push(first);
              startIdx = 1;
            }
          }
        }

        for (const file of tracks.slice(startIdx)) {
          try {
            await execFileP('mpc', ['-h', mpdHost, 'add', file]);
            added += 1;
            addedFiles.push(file);
          } catch (_) {
            failedFiles.push(file);
          }
        }
      }

      // Persist lightweight station hint map for radio queue rows.
      try {
        const metaByFile = new Map();
        for (const m of trackMeta) {
          const f = String(m?.file || '').trim();
          const stationName = String(m?.stationName || m?.artist || '').trim();
          const genre = String(m?.genre || '').trim();
          if (f && (stationName || genre)) metaByFile.set(f, { stationName, genre });
        }
        if (metaByFile.size && addedFiles.length) {
          const entries = addedFiles
            .map((f) => ({ file: f, ...(metaByFile.get(f) || {}) }))
            .filter((x) => x.file && (x.stationName || x.genre));
          if (entries.length) {
            const outPath = runtimeStatePaths().radioQueueMapPath;
            await fs.mkdir(path.dirname(outPath), { recursive: true });
            await fs.writeFile(outPath, JSON.stringify({ ts: Date.now(), entries }, null, 2), 'utf8');
          }
        }
      } catch {}

      // Only auto-play when we replaced the queue and did NOT crop (crop keeps playing).
      if (!saveOnly && shouldPlay && mode === 'replace' && !didCrop && added > 0 && !playStarted) {
        try {
          await execFileP('mpc', ['-h', mpdHost, 'play']);
          playStarted = true;
        } catch (_) {}
      }

      let shuffled = false;
      if (!saveOnly && shuffle) {
        try {
          // Shuffle is a physical queue operation. Never enable MPD random
          // mode, which would make the visible queue disagree with playback.
          if (!randomTurnedOff) {
            await execFileP('mpc', ['-h', mpdHost, 'random', 'off']);
            randomTurnedOff = true;
          }
          await execFileP('mpc', ['-h', mpdHost, 'shuffle']);
          shuffled = true;
        } catch (_) {}
      }

      let playlistSaved = false;
      let playlistError = '';
      let playlistWarnings = [];
      let recoveryPlaylists = [];
      if (playlistName) {
        if (saveOnly) {
          try {
            const result = await saveStoredPlaylist({ query: mpdQueryRaw, playlistName, tracks });
            playlistSaved = result.playlistSaved;
            playlistWarnings = result.warnings;
            recoveryPlaylists = result.recoveryPlaylists;
          } catch (e) {
            return res.status(e.status || 502).json({
              ok: false, playlistSaved: false, playlistError: e.message,
              error: e.message, code: e.code || 'PLAYLIST_SAVE_FAILED',
              recoveryPlaylists: e.recoveryPlaylists || [],
              added: 0, playStarted: false, didCrop: false, didClear: false,
            });
          }
        } else {
          try {
            await execFileP('mpc', ['-h', mpdHost, 'rm', playlistName]);
          } catch (_) {}
          try {
            await execFileP('mpc', ['-h', mpdHost, 'save', playlistName]);
            playlistSaved = true;
          } catch (e) {
            playlistError = e?.message || String(e);
          }
        }
      }

      let collageGenerated = false;
      let collageError = '';
      if (saveOnly && generateCollage && playlistSaved) {
        collageError = 'Playlist saved; remote cover upload is unavailable. The existing cover was left unchanged.';
      }
      if (!saveOnly && generateCollage && playlistName && playlistSaved) {
        const moodeUser = String(MOODE_SSH_USER || 'moode');
        const moodeHost = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
        const coverDir = String(process.env.MOODE_PLAYLIST_COVER_DIR || '/var/local/www/imagesw/playlist-covers');

        // Prefer promoting the exact preview image the user saw.
        const canPromotePreview = previewCoverBase64 && previewCoverMimeType.includes('jpeg');
        if (canPromotePreview) {
          const coverName = String(playlistName || '').trim();
          const localTmp = path.join('/tmp', `qw-preview-cover-${process.pid}-${Date.now()}.jpg`);
          const remoteTmp = `/tmp/qw-preview-cover-${process.pid}-${Date.now()}.jpg`;
          const remoteDst = `${coverDir}/${coverName}.jpg`;

          try {
            const imgBuf = Buffer.from(previewCoverBase64, 'base64');
            if (!imgBuf.length) throw new Error('preview image empty');
            await fs.writeFile(localTmp, imgBuf);

            await execFileP('scp', [
              '-q',
              '-o', 'BatchMode=yes',
              '-o', 'ConnectTimeout=6',
              localTmp,
              `${moodeUser}@${moodeHost}:${remoteTmp}`,
            ], { timeout: 20000 });

            const sudoCmd = `sudo -n bash -lc 'set -euo pipefail; mkdir -p -- ${JSON.stringify(coverDir)}; mv -f -- ${JSON.stringify(remoteTmp)} ${JSON.stringify(remoteDst)}; chmod 0644 -- ${JSON.stringify(remoteDst)} 2>/dev/null || true'`;
            const nonSudoCmd = `bash -lc 'set -euo pipefail; mkdir -p -- ${JSON.stringify(coverDir)}; mv -f -- ${JSON.stringify(remoteTmp)} ${JSON.stringify(remoteDst)}; chmod 0644 -- ${JSON.stringify(remoteDst)} 2>/dev/null || true'`;

            try {
              await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${moodeUser}@${moodeHost}`, sudoCmd], { timeout: 20000 });
            } catch (_) {
              await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${moodeUser}@${moodeHost}`, nonSudoCmd], { timeout: 20000 });
            }

            collageGenerated = true;
          } catch (e) {
            collageError = e?.message || String(e);
          } finally {
            await fs.unlink(localTmp).catch(() => {});
            await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${moodeUser}@${moodeHost}`, `rm -f -- ${JSON.stringify(remoteTmp)} >/dev/null 2>&1 || true`], { timeout: 10000 }).catch(() => {});
          }
        }

        if (!collageGenerated && !collageError) {
          collageError = 'No preview cover provided. Generate collage preview first.';
        }
      }

      // Ensure cover filename matches exact playlist name (spaces/case), even if fallback scripts wrote underscore/sanitized names.
      if (playlistName && playlistSaved && collageGenerated) {
        try {
          const moodeUser = String(MOODE_SSH_USER || 'moode');
          const moodeHost = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
          const coverDir = String(process.env.MOODE_PLAYLIST_COVER_DIR || '/var/local/www/imagesw/playlist-covers');
          const raw = String(playlistName || '').trim();
          const exact = `${coverDir}/${raw}.jpg`;
          const safe = `${coverDir}/${safePlaylistName(playlistName)}.jpg`;
          const underscored = `${coverDir}/${raw.replace(/\s+/g, '_')}.jpg`;

          const syncCmd = `bash -lc 'set -euo pipefail; mkdir -p -- ${JSON.stringify(coverDir)}; src=""; for c in ${JSON.stringify(exact)} ${JSON.stringify(safe)} ${JSON.stringify(underscored)}; do if [ -s "$c" ]; then src="$c"; break; fi; done; if [ -n "$src" ]; then for d in ${JSON.stringify(exact)} ${JSON.stringify(safe)} ${JSON.stringify(underscored)}; do [ "$src" = "$d" ] && continue; cp -f -- "$src" "$d"; done; chmod 0644 -- ${JSON.stringify(exact)} ${JSON.stringify(safe)} ${JSON.stringify(underscored)} >/dev/null 2>&1 || true; fi'`;
          const syncSudoCmd = `sudo -n ${syncCmd}`;

          try {
            await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${moodeUser}@${moodeHost}`, syncSudoCmd], { timeout: 20000 });
          } catch {
            await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${moodeUser}@${moodeHost}`, syncCmd], { timeout: 20000 });
          }
        } catch (e) {
          if (!collageError) collageError = e?.message || String(e);
        }
      }

      return res.json({
        ok: true,
        mode,
        keepNowPlaying,
        didCrop,
        didClear,
        shuffle,
        forceRandomOff,
        fastStart,
        randomTurnedOff,
        shuffled,
        generateCollage,
        requested: tracks.length,
        added,
        failedFiles: failedFiles.slice(0, 50),
        playStarted,
        playlistSaved,
        playlistError,
        playlistWarnings,
        recoveryPlaylists,
        collageGenerated,
        collageError,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
