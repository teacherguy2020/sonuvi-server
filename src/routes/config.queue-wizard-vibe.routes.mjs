import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn as spawnNative } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST } from '../config.mjs';
import { runtimeCapabilities } from '../lib/runtime-capabilities.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { loadProtectedLastfmEnvironment } from '../lib/protected-runtime-secrets.mjs';

const nativeExecFileP = promisify(execFile);
const execFileP = (...args) => {
  const command = path.basename(String(args[0] || 'external-command'));
  runtimeCapabilities().assertExternalMutation(`process.${command}`);
  return nativeExecFileP(...args);
};
const spawn = (...args) => {
  const command = path.basename(String(args[0] || 'external-command'));
  runtimeCapabilities().assertExternalMutation(`process.${command}`);
  return spawnNative(...args);
};

function makeVibeJobId() {
  return `vibe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const VIBE_FAILURE_MESSAGES = Object.freeze({
  LASTFM_UNAVAILABLE: 'Vibe recommendations are temporarily unavailable',
  LASTFM_MALFORMED_RESPONSE: 'Vibe recommendations are temporarily unavailable',
  LASTFM_UPSTREAM_REJECTED: 'Vibe recommendations are unavailable for this seed',
  VIBE_DEADLINE_EXCEEDED: 'Vibe planning timed out',
  VIBE_NO_LOCAL_MATCHES: 'No Vibe recommendations match the local library',
  VIBE_NO_RECOMMENDATIONS: 'No Vibe recommendations are available for this seed',
});

function safeVibeFailure(code) {
  const failureCode = String(code || '').trim();
  return {
    code: Object.prototype.hasOwnProperty.call(VIBE_FAILURE_MESSAGES, failureCode) ? failureCode : 'VIBE_UNAVAILABLE',
    message: VIBE_FAILURE_MESSAGES[failureCode] || 'Vibe recommendations are unavailable',
  };
}

function plannerFailure(data) {
  const code = String(data?.failure_code || '').trim();
  return code ? safeVibeFailure(code) : null;
}

function plannerPartial(data) {
  if (data?.partial !== true) return null;
  const code = String(data?.warning_code || data?.warning || '').trim();
  // Python emits allowlisted codes; never expose arbitrary subprocess output.
  if (!Object.prototype.hasOwnProperty.call(VIBE_FAILURE_MESSAGES, code)) return null;
  return safeVibeFailure(code);
}

function safePlannerSummary(data) {
  const partial = plannerPartial(data);
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const outcome = ['ok', 'partial', 'error'].includes(String(data?.outcome || ''))
    ? String(data.outcome)
    : (partial ? 'partial' : 'ok');
  // This is a subprocess boundary. Keep the public summary deliberately small
  // so arbitrary planner fields (including an accidental future secret) cannot
  // reach config or the native adapter.
  return {
    planner: String(data?.planner || '') === 'v2' ? 'v2' : 'legacy',
    targetQueue: number(data?.target_queue),
    finalQueue: number(data?.final_queue),
    recommendationCount: number(data?.recommendation_count),
    localMatchCount: number(data?.local_match_count),
    partial: !!partial,
    outcome,
    ...(partial ? { warningCode: partial.code, warning: partial.message } : {}),
  };
}

export function registerConfigQueueWizardVibeRoutes(app, deps) {
  const {
    requireTrackKey,
    getRatingForFile,
    mpdQueryRaw,
    mpdHasACK,
    parseMpdKeyVals,
    parseMpdFirstBlock,
    log,
  } = deps;
  const previewExecFile = deps.execFile || execFileP;
  const previewFs = deps.fs || fs;
  const capabilities = runtimeCapabilities();
  const statePaths = runtimeStatePaths();
  const releaseRoot = statePaths.releaseRoot;
  const vibeJobs = new Map();
  const configPath = statePaths.configPath;
  const endlessVibeSettingsPath = process.env.NOW_PLAYING_ENDLESS_VIBE_PATH
    || statePaths.endlessVibePath;
  const endlessVibePollMs = Math.max(5000, Number(process.env.ENDLESS_VIBE_POLL_MS || 15000) || 15000);
  const endlessVibeRetryMs = Math.max(endlessVibePollMs, Number(process.env.ENDLESS_VIBE_RETRY_MS || 60000) || 60000);
  let endlessVibeTickBusy = false;
  let endlessVibeActiveJobId = '';
  let endlessVibeLastSeedKey = '';
  let endlessVibeLastAttemptAt = 0;

  function releaseScript(name) {
    return path.join(releaseRoot, name);
  }

  function vibeProcessEnvironment() {
    return { ...process.env, VIBE_LOG: statePaths.vibePythonLogPath };
  }

  async function createVibeTemporaryJson(prefix) {
    await fs.mkdir(statePaths.temporaryDir, { recursive: true });
    return path.join(statePaths.temporaryDir, `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`);
  }

  function previewTimeoutError() {
    const error = new Error('VIBE_DEADLINE_EXCEEDED');
    error.code = 'VIBE_DEADLINE_EXCEEDED';
    return error;
  }

  function isProcessDeadline(error) {
    return error?.code === 'ETIMEDOUT'
      || error?.code === 'VIBE_DEADLINE_EXCEEDED'
      || error?.killed === true
      || error?.signal === 'SIGTERM';
  }

  async function runVibePreview({ prefix, lastfmApiKey, vibeIndexPath, seedArtist, seedTitle, targetQueue, mpdHost }) {
    const jsonTmp = await createPreviewJson(prefix);
    const pyPath = releaseScript('lastfm_vibe_radio.py');
    const pyArgs = [
      pyPath, '--api-key', lastfmApiKey, '--index', vibeIndexPath,
      '--seed-artist', seedArtist, '--seed-title', seedTitle,
      '--target-queue', String(targetQueue), '--json-out', jsonTmp,
      '--mode', 'load', '--host', mpdHost, '--port', '6600', '--dry-run',
      '--debug-trace', '--max-seconds', '16',
    ];
    try {
      await previewExecFile('python3', pyArgs, {
        env: vibeProcessEnvironment(), timeout: 21000, killSignal: 'SIGTERM',
      });
      return JSON.parse(await previewFs.readFile(jsonTmp, 'utf8'));
    } catch (error) {
      if (isProcessDeadline(error)) throw previewTimeoutError();
      throw error;
    } finally {
      await previewFs.unlink(jsonTmp).catch(() => {});
    }
  }

  async function resolveLastfmApiKey() {
    try{
      const master=JSON.parse(await fs.readFile(configPath,'utf8'));
      if(master.format==='sonuvi-master-configuration'&&(!master.plugins.lastfm.enabled||!master.plugins.lastfm.metadataEnabled))return '';
    }catch{/* Legacy fixtures may have no configuration file. */}
    const envKey = loadProtectedLastfmEnvironment({ statePaths }).LASTFM_API_KEY;
    if (envKey) return envKey;
    if (statePaths.sharedStateEnabled) return '';
    try {
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      return String(cfg?.lastfm?.apiKey || '').trim();
    } catch {
      return '';
    }
  }

  async function resolveVibeIndexPath() {
    const configured = String(process.env.MOODE_LIBRARY_INDEX || '').trim();
    if (configured) return configured;
    if (statePaths.sharedStateEnabled) return statePaths.vibeLibraryIndexPath;
    const candidates = [statePaths.vibeLibraryIndexPath, '/opt/now-playing/moode_library_index.json', '/home/moode/moode_library_index.json'];
    for (const p of candidates) {
      try { await fs.access(p); return p; } catch {}
    }
    return statePaths.vibeLibraryIndexPath;
  }
  const createPreviewJson = deps.createVibeTemporaryJson || createVibeTemporaryJson;
  const resolveLastfmKey = deps.resolveLastfmApiKey || resolveLastfmApiKey;
  const resolveVibeIndex = deps.resolveVibeIndexPath || resolveVibeIndexPath;

  const vibeLogDir = statePaths.vibeLogDir;
  async function appendVibeJobLog(job, event, detail = {}) {
    try {
      const rec = {
        ts: new Date().toISOString(),
        jobId: String(job?.id || ''),
        event: String(event || 'event'),
        detail: detail && typeof detail === 'object' ? detail : { message: String(detail || '') },
      };
      const line = `${JSON.stringify(rec)}\n`;
      await fs.mkdir(vibeLogDir, { recursive: true });
      const fp = String(job?.logPath || path.join(vibeLogDir, `${String(job?.id || 'vibe')}.jsonl`));
      await fs.appendFile(fp, line, 'utf8');
    } catch {}
  }

  async function ensureVibeIndexReady(job, vibeIndexPath, mpdHost) {
    const staleMs = Number(process.env.VIBE_INDEX_MAX_AGE_MS || 12 * 60 * 60 * 1000);
    let needsBuild = false;
    try {
      const st = await fs.stat(vibeIndexPath);
      const ageMs = Date.now() - Number(st.mtimeMs || 0);
      if (!Number.isFinite(st.size) || st.size < 256 || ageMs > staleMs) needsBuild = true;
    } catch {
      needsBuild = true;
    }
    if (!needsBuild) return true;

    job.phase = 'creating index file please wait';
    job.updatedAt = Date.now();
    const buildPy = releaseScript('build_moode_index.py');
    job.logs.push(`[index] building local index: ${vibeIndexPath}`);
    appendVibeJobLog(job, 'index-build-start', { vibeIndexPath, mpdHost, buildPy }).catch(() => {});

    try {
      const { stdout, stderr } = await execFileP('python3', [buildPy], {
        env: {
          ...process.env,
          INDEX_PATH: vibeIndexPath,
          MPD_HOST: String(mpdHost || 'moode.local'),
          MPD_PORT: '6600',
          VIBE_LOG: statePaths.vibePythonLogPath,
        },
      });
      const out = String(stdout || '').trim();
      const err = String(stderr || '').trim();
      if (out) {
        out.split(/\r?\n/).forEach((ln) => { if (ln) job.logs.push(`[index] ${ln}`); });
      }
      if (err) {
        err.split(/\r?\n/).forEach((ln) => { if (ln) job.logs.push(`[index][stderr] ${ln}`); });
      }
      appendVibeJobLog(job, 'index-build-complete', { ok: true }).catch(() => {});
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
      job.error = `Index build failed: ${msg}`;
      job.phase = 'error';
      job.status = 'error';
      job.done = true;
      job.updatedAt = Date.now();
      job.logs.push(`[index] ERROR ${msg}`);
      appendVibeJobLog(job, 'index-build-complete', { ok: false, error: msg }).catch(() => {});
      return false;
    }
  }

  async function applyVibePlanToMpd(job, { mpdHost, playNow, keepPlaying, resumePlayback = false }) {
    const tracks = (Array.isArray(job?.tracks) ? job.tracks : [])
      .map((track) => ({ ...track, file: String(track?.file || '').trim() }))
      .filter((track) => track.file);
    if (!tracks.length) return { added: [], failed: [] };

    // The Vibe planner must finish before this point. Cropping is intentionally
    // delayed until a non-empty plan exists so a failed discovery request never
    // leaves the listener with an empty queue.
    job.phase = 'applying planned queue';
    job.updatedAt = Date.now();
    job.logs.push(`[apply] cropping current queue and adding ${tracks.length} planned track(s)`);
    appendVibeJobLog(job, 'apply-start', { requested: tracks.length, playNow, keepPlaying }).catch(() => {});

    await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'crop']);
    try { await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'random', 'off']); } catch (_) {}

    const added = [];
    const failed = [];
    for (const track of tracks) {
      try {
        await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'add', track.file]);
        added.push(track);
      } catch (error) {
        failed.push({ file: track.file, error: error?.message || String(error) });
      }
    }

    if (playNow && added.length) {
      try { await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'play']); } catch (_) {}
    } else if (resumePlayback && added.length) {
      // A slow plan can finish after the final seed has naturally ended. In
      // Endless Vibe that means resume the just-extended queue, but do not
      // force playback for ordinary queue-building requests.
      try {
        const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'status']);
        if (!/\[playing\]/i.test(String(stdout || ''))) {
          await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'play']);
        }
      } catch (_) {}
    }

    job.tracks = added;
    job.builtCount = added.length;
    for (const track of added) {
      job.added.push({
        eventId: job.nextEventId++,
        artist: String(track.artist || ''),
        title: String(track.title || ''),
        method: String(track.method || 'planner-v2'),
      });
    }
    if (job.added.length > 500) job.added = job.added.slice(-500);
    job.debug.appliedCount = added.length;
    job.debug.applyFailures = failed;
    job.logs.push(`[apply] added ${added.length}/${tracks.length} planned track(s)`);
    appendVibeJobLog(job, 'apply-complete', { added: added.length, failed, playNow, keepPlaying, resumePlayback }).catch(() => {});
    return { added, failed };
  }

  async function readEndlessVibeEnabled() {
    try {
      const raw = await fs.readFile(endlessVibeSettingsPath, 'utf8');
      return JSON.parse(raw || '{}')?.enabled === true;
    } catch {
      return false;
    }
  }

  function isPodcastLikeSong(song = {}) {
    const blob = [song.file, song.genre, song.album, song.artist, song.title]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /(?:^|[\\/])podcasts?(?:[\\/]|$)/i.test(String(song.file || '')) || /\bpodcasts?\b/i.test(blob);
  }

  async function getEndlessVibeSeed() {
    if (typeof mpdQueryRaw !== 'function' || typeof parseMpdKeyVals !== 'function' || typeof parseMpdFirstBlock !== 'function') return null;

    const statusRaw = await mpdQueryRaw('status');
    if (!statusRaw || (typeof mpdHasACK === 'function' && mpdHasACK(statusRaw))) return null;
    const status = parseMpdKeyVals(statusRaw);
    const songPos = Number(status?.song);
    const playlistLength = Number(status?.playlistlength);
    if (!Number.isInteger(songPos) || songPos < 0 || !Number.isInteger(playlistLength) || playlistLength <= 0) return null;
    if (songPos !== playlistLength - 1) return null;

    const currentRaw = await mpdQueryRaw('currentsong');
    if (!currentRaw || (typeof mpdHasACK === 'function' && mpdHasACK(currentRaw))) return null;
    const song = parseMpdFirstBlock(currentRaw) || {};
    const file = String(song.file || '').trim();
    const artist = String(song.artist || '').trim();
    const title = String(song.title || song.name || '').trim();
    if (!file || !artist || !title || file.includes('://') || isPodcastLikeSong(song)) return null;

    return {
      file,
      artist,
      title,
      seedKey: `${file}|${artist}|${title}`,
      mpdState: String(status?.state || '').trim().toLowerCase(),
    };
  }

  function hasActiveVibeJob() {
    for (const job of vibeJobs.values()) {
      if (job && !job.done && job.status === 'running') return true;
    }
    return false;
  }

  function getEndlessVibeJob() {
    const active = endlessVibeActiveJobId ? vibeJobs.get(endlessVibeActiveJobId) : null;
    if (active?.debug?.endless) return active;
    const jobs = Array.from(vibeJobs.values()).reverse();
    return jobs.find((job) => job?.debug?.endless && !job.done) || null;
  }

  function summarizeEndlessVibeJob(job) {
    const latest = Array.isArray(job?.added) && job.added.length
      ? job.added[job.added.length - 1]
      : null;
    return {
      ok: true,
      active: !!job && !job.done,
      done: !!job?.done,
      jobId: String(job?.id || ''),
      status: String(job?.status || ''),
      phase: String(job?.phase || ''),
      error: String(job?.error || ''),
      targetQueue: Number(job?.targetQueue || 0),
      builtCount: Number(job?.builtCount || 0),
      rawBuiltCount: Number(job?.rawBuiltCount || 0),
      partial: job?.partial === true,
      ...(job?.warningCode ? { warningCode: String(job.warningCode) } : {}),
      ...(job?.warning ? { warning: String(job.warning) } : {}),
      seedArtist: String(job?.seedArtist || ''),
      seedTitle: String(job?.seedTitle || ''),
      latest,
      lastLine: String(job?.lastLine || ''),
      updatedAt: Number(job?.updatedAt || 0),
    };
  }

  // --- Vibe from now playing (Queue Wizard) ---
  app.post('/config/queue-wizard/vibe-start', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const targetQueueRaw = req.body?.targetQueue;
      const targetQueue = Math.max(10, Math.min(200, Number(targetQueueRaw) || 12));
      const minRating = Math.max(0, Math.min(5, Number(req.body?.minRating || 0)));
      const excludeGenre = String(req.body?.excludeGenre || 'christmas').trim().toLowerCase();
      const playNow = !!req.body?.playNow;
      const keepPlaying = !!req.body?.keepPlaying;
      const mpdHost = String(MPD_HOST || 'moode.local');

      let artist = '';
      let title = '';
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%artist%\t%title%', 'current']);
      const line = String(stdout || '').trim();
      if (line) {
        const [a = '', t = ''] = line.split('\t');
        artist = String(a || '').trim();
        title = String(t || '').trim();
      }

      if (!artist || !title) return res.status(404).json({ ok: false, error: 'No current track (artist/title empty)' });
      const lastfmApiKey = await resolveLastfmKey();
      if (!lastfmApiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });

      const jobId = makeVibeJobId();
      const pyPath = releaseScript('lastfm_vibe_radio.py');
      const jsonTmp = await createVibeTemporaryJson(jobId);
      const vibeIndexPath = await resolveVibeIndex();

      const isSmallQueue = targetQueue <= 15;
      const pyArgs = [
        '--api-key', lastfmApiKey,
        '--index', vibeIndexPath,
        '--seed-artist', artist,
        '--seed-title', title,
        '--target-queue', String(targetQueue),
        '--json-out', jsonTmp,
        '--mode', 'load',
        '--similar-limit', isSmallQueue ? '100' : '150',
        '--planner-v2',
        '--planner-max-expansions', '3',
        '--max-seconds', isSmallQueue ? '18' : '45',
        '--host', mpdHost,
        '--port', '6600',
        '--debug-trace',
        '--dry-run',
      ];
      if (excludeGenre === 'christmas') pyArgs.push('--exclude-christmas');
      else if (excludeGenre === 'none') pyArgs.push('--include-christmas');
      // The Python process is dry-run only, but this tells planner v2 that
      // the active seed will be retained when this route applies the plan.
      // That keeps targetQueue equal to the final queue size.
      if (playNow || keepPlaying) pyArgs.push('--crop');

      const job = {
        id: jobId,
        status: 'running',
        phase: 'starting',
        targetQueue,
        minRating,
        excludeGenre,
        seedArtist: artist,
        seedTitle: title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        builtCount: 0,
        rawBuiltCount: 0,
        added: [],
        tracks: [],
        logs: [],
        debug: {
          planner: 'v2',
          fallbackUsed: false,
          fallbackCount: 0,
          previewResponseCount: 0,
          indexPath: vibeIndexPath,
        },
        nextEventId: 1,
        error: '',
        done: false,
        jsonTmp,
        logPath: path.join(vibeLogDir, `${jobId}.jsonl`),
        proc: null,
      };

      vibeJobs.set(jobId, job);
      appendVibeJobLog(job, 'start', {
        seedArtist: artist,
        seedTitle: title,
        targetQueue,
        minRating,
        excludeGenre,
        playNow,
        keepPlaying,
        mpdHost,
        indexPath: vibeIndexPath,
        pyPath,
      }).catch(() => {});

      const indexReady = await ensureVibeIndexReady(job, vibeIndexPath, mpdHost);
      if (!indexReady) {
        await fs.unlink(jsonTmp).catch(() => {});
        return res.status(500).json({ ok: false, error: job.error || 'Index build failed', jobId });
      }

      let child;
      try {
        child = spawn('python3', [pyPath, ...pyArgs], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: vibeProcessEnvironment(),
        });
      } catch (error) {
        await fs.unlink(jsonTmp).catch(() => {});
        throw error;
      }
      job.proc = child;
      const childDeadlineTimer = setTimeout(() => {
        if (!job.done) {
          job.error = 'VIBE_DEADLINE_EXCEEDED';
          job.warningCode = job.error;
          job.warning = safeVibeFailure(job.error).message;
          terminateChild();
        }
      }, (isSmallQueue ? 18 : 45) * 1000 + 5000);
      childDeadlineTimer.unref?.();
      let childKillTimer = null;
      const terminateChild = () => {
        if (!job.done) {
          try { child.kill('SIGTERM'); } catch {}
          childKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
          childKillTimer.unref?.();
        }
      };
      child.on('error', async () => {
        clearTimeout(childDeadlineTimer);
        clearTimeout(childKillTimer);
        if (job.done) return;
        job.error = 'VIBE_UNAVAILABLE';
        job.warningCode = job.error;
        job.warning = safeVibeFailure(job.error).message;
        job.done = true;
        job.status = 'error';
        job.phase = 'error';
        job.updatedAt = Date.now();
        await fs.unlink(jsonTmp).catch(() => {});
      });
      appendVibeJobLog(job, 'run', {
        seedArtist: artist,
        seedTitle: title,
        targetQueue,
        minRating,
        excludeGenre,
        playNow,
        keepPlaying,
        mpdHost,
        indexPath: vibeIndexPath,
        pyPath,
      }).catch(() => {});

      const onLine = (lineIn = '') => {
        const line = String(lineIn || '').trim();
        if (!line) return;
        job.updatedAt = Date.now();
        job.lastLine = line;
        job.logs.push(line);
        if (job.logs.length > 300) job.logs.shift();
        appendVibeJobLog(job, 'line', { line }).catch(() => {});

        if (/Last\.fm get similar/i.test(line)) job.phase = 'querying last.fm';
        const candidateMatch = line.match(/pick from\s+(\d+)\s+similar/i);
        if (candidateMatch) job.phase = `matching local library (${candidateMatch[1]} Last.fm candidates)`;

        const m = line.match(/^\[hop\s+\d+\]\s+Added:\s+(.+?)\s+\(([^)]+)\)/i)
          || line.match(/^\[simple\]\s+Added:\s+(.+?)\s+\(([^)]+)\)/i);
        if (m) {
          const label = String(m[1] || '').trim();
          const method = String(m[2] || '').trim();
          const parts = label.split(' — ');
          const titleX = parts[0] || label;
          const artistX = parts.length > 1 ? parts.slice(1).join(' — ') : '';

          job.added.push({
            eventId: job.nextEventId++,
            artist: artistX,
            title: titleX,
            method,
          });
          if (job.added.length > 500) job.added = job.added.slice(-500);
          job.builtCount += 1;
          job.phase = 'adding tracks';
        }

        const pm = line.match(/^\[simple\]\s+pass\s+(\d+)\s+added\s+(\d+)\s+track/i);
        if (pm) {
          const p = Number(pm[1] || 0);
          const n = Number(pm[2] || 0);
          job.phase = `simple pass ${p} complete (+${n})`;
        }
      };

      let outBuf = '';
      child.stdout.on('data', (buf) => {
        outBuf += String(buf || '');
        const lines = outBuf.split(/\r?\n/);
        outBuf = lines.pop() || '';
        lines.forEach(onLine);
      });

      let errBuf = '';
      child.stderr.on('data', (buf) => {
        errBuf += String(buf || '');
        const lines = errBuf.split(/\r?\n/);
        errBuf = lines.pop() || '';
        lines.forEach(() => onLine('stderr: subprocess output omitted'));
      });

      child.on('close', async (code) => {
        clearTimeout(childDeadlineTimer);
        clearTimeout(childKillTimer);
        if (job.done) return;
        if (outBuf.trim()) onLine(outBuf.trim());
        if (errBuf.trim()) onLine('stderr: subprocess output omitted');

        try {
          const jsonOut = await fs.readFile(jsonTmp, 'utf8');
          const data = JSON.parse(jsonOut);
          const baseTracks = Array.isArray(data?.tracks) ? data.tracks : [];
          const failure = plannerFailure(data);
          const partial = plannerPartial(data);
          job.rawBuiltCount = baseTracks.length;
          job.tracks = baseTracks;
          if (partial) {
            job.partial = true;
            job.warningCode = partial.code;
            job.warning = partial.message;
          }
          if (failure) {
            job.warningCode = failure.code;
            job.warning = failure.message;
            if (baseTracks.length) job.partial = true;
            else job.error = failure.code;
          }

          // A local artist fallback is valid only after a successful empty/no-match discovery.
          if (!job.error && !job.tracks.length) {
            try {
              const body = {
                genres: [],
                artists: job.seedArtist ? [job.seedArtist] : [],
                albums: [],
                excludeGenres: job.excludeGenre === 'christmas' ? ['christmas'] : [],
                minRating: Number(job.minRating || 0),
                maxTracks: Number(job.targetQueue || 50),
              };
              const resp = await fetch('http://127.0.0.1:3101/config/queue-wizard/preview', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(String(req.headers?.['x-track-key'] || '').trim() ? { 'x-track-key': String(req.headers['x-track-key']).trim() } : {}),
                },
                body: JSON.stringify(body),
              });
              const pj = await resp.json().catch(() => ({}));
              const items = Array.isArray(pj?.tracks) ? pj.tracks : [];
              job.debug.previewResponseCount = Number(items.length || 0);
              if (items.length) {
                job.tracks = items.slice(0, Number(job.targetQueue || 50)).map((t) => {
                  if (typeof t === 'string') return { file: String(t || '').trim() };
                  return {
                    file: String(t?.file || '').trim(),
                    artist: String(t?.artist || '').trim(),
                    title: String(t?.title || '').trim(),
                    album: String(t?.album || '').trim(),
                    genre: String(t?.genre || '').trim(),
                    rating: Math.max(0, Math.min(5, Number(t?.rating || 0) || 0)),
                  };
                }).filter((x) => x.file);
                job.phase = 'fallback: artist local matches';
                job.debug.fallbackUsed = true;
                job.debug.fallbackCount = Number(job.tracks.length || 0);
                job.logs.push(`fallback: local artist preview produced ${job.tracks.length} track(s)`);
                appendVibeJobLog(job, 'fallback', {
                  seedArtist: job.seedArtist,
                  previewCount: Number(items.length || 0),
                  keptCount: Number(job.tracks.length || 0),
                  sample: job.tracks.slice(0, 5).map((t) => ({ artist: t.artist || '', title: t.title || '', album: t.album || '', file: t.file || '' })),
                }).catch(() => {});
              }
            } catch (e2) {
              job.logs.push('fallback error');
              appendVibeJobLog(job, 'fallback-error', { error: 'VIBE_UNAVAILABLE' }).catch(() => {});
            }
          }

          // Rating is now applied before any MPD operation. An empty filtered
          // plan is an honest result, not permission to enqueue low-rated rows.
          if (job.minRating > 0 && typeof getRatingForFile === 'function') {
            const plannedBeforeRating = job.tracks.length;
            const kept = [];
            for (const t of job.tracks) {
              const f = String(t?.file || '').trim();
              let rating = 0;
              try { rating = Number(await getRatingForFile(f)) || 0; } catch {}
              if (rating >= job.minRating) kept.push({ ...t, rating });
            }
            job.tracks = kept;
            job.debug.ratingFilter = {
              minRating: job.minRating,
              before: plannedBeforeRating,
              kept: kept.length,
            };
            if (!kept.length && plannedBeforeRating) {
              job.logs.push(`[rating] no planned tracks met minimum rating ${job.minRating}`);
            }
          }

          job.builtCount = job.tracks.length || 0;
        } catch (e) {
          if (!job.error) {
            job.error = 'VIBE_UNAVAILABLE';
            job.warningCode = job.error;
            job.warning = safeVibeFailure(job.error).message;
          }
        } finally {
          await fs.unlink(jsonTmp).catch(() => {});
        }

        if (code !== 0 && !job.error) {
          job.error = 'VIBE_UNAVAILABLE';
          job.warningCode = job.error;
          job.warning = safeVibeFailure(job.error).message;
        }
        if (!job.error && (playNow || keepPlaying) && job.tracks.length) {
          try {
            await applyVibePlanToMpd(job, { mpdHost, playNow, keepPlaying });
          } catch (applyError) {
            job.error = 'VIBE_UNAVAILABLE';
            job.warningCode = job.error;
            job.warning = safeVibeFailure(job.error).message;
          }
        }
        job.done = true;
        job.status = job.error ? 'error' : 'done';
        job.phase = job.error ? 'error' : 'complete';
        job.updatedAt = Date.now();
        appendVibeJobLog(job, 'complete', {
          exitCode: Number(code || 0),
          status: job.status,
          phase: job.phase,
          error: job.error || '',
          rawBuiltCount: Number(job.rawBuiltCount || 0),
          builtCount: Number(job.builtCount || 0),
          fallbackUsed: !!job.debug?.fallbackUsed,
          fallbackCount: Number(job.debug?.fallbackCount || 0),
          sample: (Array.isArray(job.tracks) ? job.tracks : []).slice(0, 8).map((t) => ({ artist: t.artist || '', title: t.title || '', album: t.album || '', file: t.file || '' })),
        }).catch(() => {});
      });

      return res.json({ ok: true, jobId, targetQueue, minRating, seedArtist: artist, seedTitle: title });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  app.get('/config/queue-wizard/vibe-status/:jobId', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const jobId = String(req.params?.jobId || '');
      const job = vibeJobs.get(jobId);
      if (!job) return res.status(404).json({ ok: false, error: 'Unknown vibe job' });

      const since = Math.max(0, Number(req.query?.since || 0));
      const added = job.added.filter((x) => Number(x.eventId || 0) > since);
      const nextSince = job.added.length ? Number(job.added[job.added.length - 1].eventId || since) : since;

      return res.json({
        ok: true,
        jobId,
        status: job.status,
        phase: job.phase,
        done: !!job.done,
        error: job.error || '',
        partial: job.partial === true,
        warningCode: job.warningCode || null,
        warning: job.warning || null,
        targetQueue: job.targetQueue,
        minRating: Number(job.minRating || 0),
        builtCount: Number(job.builtCount || 0),
        rawBuiltCount: Number(job.rawBuiltCount || 0),
        seedArtist: job.seedArtist,
        seedTitle: job.seedTitle,
        excludeGenre: String(job.excludeGenre || ''),
        debug: job.debug || {},
        logPath: String(job.logPath || ''),
        logs: Array.isArray(job.logs) ? job.logs.slice(-120) : [],
        added,
        nextSince,
        tracks: job.done ? (Array.isArray(job.tracks) ? job.tracks : []) : [],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  // Endless Vibe is started by the backend watcher, so a controller does not
  // have a job ID to poll. Expose the current backend-owned job separately so
  // the Live Queue surface can show what the Last.fm/local-library worker is
  // doing without taking ownership of the job lifecycle.
  app.get('/config/queue-wizard/endless-vibe-status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const job = getEndlessVibeJob();
      return res.json(job ? summarizeEndlessVibeJob(job) : { ok: true, active: false, done: false });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  app.get('/config/queue-wizard/vibe-debug/:jobId', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const jobId = String(req.params?.jobId || '');
      const job = vibeJobs.get(jobId);
      if (!job) return res.status(404).json({ ok: false, error: 'Unknown vibe job' });

      let fileLogs = [];
      try {
        const raw = await fs.readFile(String(job.logPath || ''), 'utf8');
        fileLogs = String(raw || '').split(/\r?\n/).filter(Boolean).slice(-200).map((ln) => {
          try { return JSON.parse(ln); } catch { return { raw: ln }; }
        });
      } catch {}

      return res.json({
        ok: true,
        jobId,
        status: job.status,
        phase: job.phase,
        done: !!job.done,
        seedArtist: job.seedArtist,
        seedTitle: job.seedTitle,
        targetQueue: Number(job.targetQueue || 0),
        minRating: Number(job.minRating || 0),
        excludeGenre: String(job.excludeGenre || ''),
        builtCount: Number(job.builtCount || 0),
        rawBuiltCount: Number(job.rawBuiltCount || 0),
        debug: job.debug || {},
        inMemoryLogs: Array.isArray(job.logs) ? job.logs.slice(-200) : [],
        fileLogPath: String(job.logPath || ''),
        fileLogs,
        sampleTracks: (Array.isArray(job.tracks) ? job.tracks : []).slice(0, 25),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  app.post('/config/queue-wizard/vibe-cancel/:jobId', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const jobId = String(req.params?.jobId || '');
      const job = vibeJobs.get(jobId);
      if (!job) return res.status(404).json({ ok: false, error: 'Unknown vibe job' });

      if (!job.done && job.proc?.pid) {
        try { process.kill(job.proc.pid, 'SIGTERM'); } catch (_) {}
      }

      job.done = true;
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.error = '';
      job.updatedAt = Date.now();

      return res.json({ ok: true, jobId, cancelled: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  // Backward-compatible one-shot endpoint
  app.get('/config/queue-wizard/vibe-nowplaying', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const targetQueue = Math.max(10, Math.min(200, Number(req.query?.targetQueue) || 50));
      // Use direct invoke path by spawning inline (kept simple for compatibility)
      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%artist%\t%title%', 'current']);
      const line = String(stdout || '').trim();
      const [artist = '', title = ''] = line.split('\t');
      if (!artist || !title) return res.status(404).json({ ok: false, error: 'No current track (artist/title empty)' });
      const lastfmApiKey = await resolveLastfmKey();
      if (!lastfmApiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      const vibeIndexPath = await resolveVibeIndex();
      const data = await runVibePreview({ prefix: 'vibe-np', lastfmApiKey, vibeIndexPath, seedArtist: artist, seedTitle: title, targetQueue, mpdHost });
      const failure = plannerFailure(data);
      if (failure) return res.status(502).json({ ok: false, error: failure.message, code: failure.code });
      return res.json({ ok: true, tracks: data?.tracks || [], summary: safePlannerSummary(data), targetQueue, seedArtist: artist, seedTitle: title });
    } catch (e) {
      if (e?.code === 'VIBE_DEADLINE_EXCEEDED') return res.status(504).json({ ok: false, error: safeVibeFailure(e.code).message, code: e.code });
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  app.post('/config/queue-wizard/vibe-nowplaying', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const targetQueue = Math.max(10, Math.min(200, Number(req.body?.targetQueue) || 50));
      const mpdHost = String(MPD_HOST || 'moode.local');
      const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%artist%\t%title%', 'current']);
      const line = String(stdout || '').trim();
      const [artist = '', title = ''] = line.split('\t');
      if (!artist || !title) return res.status(404).json({ ok: false, error: 'No current track (artist/title empty)' });
      const lastfmApiKey = await resolveLastfmKey();
      if (!lastfmApiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      const vibeIndexPath = await resolveVibeIndex();
      const data = await runVibePreview({ prefix: 'vibe-np', lastfmApiKey, vibeIndexPath, seedArtist: artist, seedTitle: title, targetQueue, mpdHost });
      const failure = plannerFailure(data);
      if (failure) return res.status(502).json({ ok: false, error: failure.message, code: failure.code });
      return res.json({ ok: true, tracks: data?.tracks || [], summary: safePlannerSummary(data), targetQueue, seedArtist: artist, seedTitle: title });
    } catch (e) {
      if (e?.code === 'VIBE_DEADLINE_EXCEEDED') return res.status(504).json({ ok: false, error: safeVibeFailure(e.code).message, code: e.code });
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  async function startSeededVibeJob({ targetQueue: targetQueueRaw, playNow = false, keepPlaying = false, endless = false, seedArtist: seedArtistRaw, seedTitle: seedTitleRaw }) {
    const targetQueue = Math.max(1, Math.min(200, Number(targetQueueRaw) || 12));
    const seedArtist = String(seedArtistRaw || '').trim();
    const seedTitle = String(seedTitleRaw || '').trim();
    if (!seedArtist || !seedTitle) throw new Error('Missing seedArtist/seedTitle');
    // Endless Vibe must use the same plan-before-mutation path as normal Vibe.
    // Other seeded callers retain their established behavior for now.
    const usePlannerV2 = endless === true;

    const lastfmApiKey = await resolveLastfmKey();
    if (!lastfmApiKey) throw new Error('Last.fm API key is not configured');

    const mpdHost = String(MPD_HOST || 'moode.local');
    const pyPath = releaseScript('lastfm_vibe_radio.py');
    const jobId = makeVibeJobId();
    const jsonTmp = usePlannerV2 ? await createVibeTemporaryJson(jobId) : '';

    // Ensure deterministic queue order for seeded vibe starts.
    if (!usePlannerV2 && (playNow || keepPlaying)) {
      try { await execFileP('mpc', ['-h', mpdHost, '-p', '6600', 'random', 'off']); } catch (_) {}
    }

    const vibeIndexPath = await resolveVibeIndex();
    const job = {
      id: jobId,
      status: 'running',
      phase: 'starting',
      targetQueue,
      minRating: 0,
      excludeGenre: 'none',
      seedArtist,
      seedTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      builtCount: 0,
      rawBuiltCount: 0,
      added: [],
      tracks: [],
      logs: [],
      debug: {
        planner: usePlannerV2 ? 'v2' : 'legacy',
        fallbackUsed: false,
        fallbackCount: 0,
        previewResponseCount: 0,
        indexPath: vibeIndexPath,
        seededStart: true,
        playNow: !!playNow,
        keepPlaying: !!keepPlaying,
        endless: !!endless,
      },
      nextEventId: 1,
      error: '',
      done: false,
      jsonTmp,
      logPath: path.join(vibeLogDir, `${jobId}.jsonl`),
      proc: null,
    };
    vibeJobs.set(jobId, job);
    if (endless) endlessVibeActiveJobId = jobId;
    appendVibeJobLog(job, 'start', {
      seedArtist,
      seedTitle,
      targetQueue,
      playNow,
      keepPlaying,
      endless,
      mpdHost,
      indexPath: vibeIndexPath,
      pyPath,
      seededStart: true,
    }).catch(() => {});

    const indexReady = await ensureVibeIndexReady(job, vibeIndexPath, mpdHost);
    if (!indexReady) {
      if (jsonTmp) await fs.unlink(jsonTmp).catch(() => {});
      return { ok: false, error: job.error || 'Index build failed', jobId, job };
    }

    const pyArgs = [
      pyPath,
      '--api-key', lastfmApiKey,
      '--index', vibeIndexPath,
      '--seed-artist', seedArtist,
      '--seed-title', seedTitle,
      '--target-queue', String(targetQueue),
      '--mode', usePlannerV2 ? 'load' : (playNow ? 'play' : 'load'),
      '--host', mpdHost,
      '--port', '6600',
      '--debug-trace',
    ];
    if (usePlannerV2) {
      // Run the planner against the current final queue item, but leave MPD
      // untouched until its completed local-file plan has been read back.
      pyArgs.push(
        '--planner-v2',
        '--planner-max-expansions', '3',
        '--max-seconds', '18',
        '--exclude-christmas',
        '--json-out', jsonTmp,
        '--dry-run',
      );
    } else {
      pyArgs.push('--shuffle-top', '25', '--reseed-random', '--max-misses', '12', '--max-seconds', '18');
    }
    if (playNow || keepPlaying || endless) pyArgs.push('--crop');
    if (!usePlannerV2 && endless) pyArgs.push('--endless');
    if (!usePlannerV2 && keepPlaying && !playNow) pyArgs.push('--no-final-stop');

    let child;
    try {
      child = spawn('python3', pyArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: vibeProcessEnvironment(),
      });
    } catch (error) {
      if (jsonTmp) await fs.unlink(jsonTmp).catch(() => {});
      job.error = 'VIBE_UNAVAILABLE';
      job.warningCode = job.error;
      job.warning = safeVibeFailure(job.error).message;
      job.done = true;
      job.status = 'error';
      job.phase = 'error';
      job.updatedAt = Date.now();
      job.logs.push('spawn error');
      appendVibeJobLog(job, 'spawn-error', { error: 'VIBE_UNAVAILABLE' }).catch(() => {});
      throw error;
    }
    job.proc = child;
    let childKillTimer = null;
    const terminateChild = () => {
      try { child.kill('SIGTERM'); } catch {}
      childKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
      childKillTimer.unref?.();
    };
    const childDeadlineTimer = setTimeout(() => {
      if (!job.done) {
        job.error = 'VIBE_DEADLINE_EXCEEDED';
        job.warningCode = job.error;
        job.warning = safeVibeFailure(job.error).message;
        terminateChild();
      }
    }, 21000);
    childDeadlineTimer.unref?.();
    child.on('error', async () => {
      clearTimeout(childDeadlineTimer);
      clearTimeout(childKillTimer);
      if (job.done) return;
      job.error = 'VIBE_UNAVAILABLE';
      job.warningCode = job.error;
      job.warning = safeVibeFailure(job.error).message;
      job.done = true;
      job.status = 'error';
      job.phase = 'error';
      job.updatedAt = Date.now();
      if (jsonTmp) await fs.unlink(jsonTmp).catch(() => {});
    });
    appendVibeJobLog(job, 'run', {
      seedArtist,
      seedTitle,
      targetQueue,
      playNow,
      keepPlaying,
      endless,
      mpdHost,
      indexPath: vibeIndexPath,
      pyPath,
      seededStart: true,
    }).catch(() => {});

    const onLine = (lineIn = '') => {
      const line = String(lineIn || '').trim();
      if (!line) return;
      job.updatedAt = Date.now();
      job.lastLine = line;
      job.logs.push(line);
      if (job.logs.length > 300) job.logs.shift();
      appendVibeJobLog(job, 'line', { line }).catch(() => {});

      if (/Last\.fm get similar/i.test(line)) job.phase = 'querying last.fm';
      const candidateMatch = line.match(/pick from\s+(\d+)\s+similar/i);
      if (candidateMatch) job.phase = `matching local library (${candidateMatch[1]} Last.fm candidates)`;
      if (/^\[v2\]\s+pass\s+\d+:/i.test(line)) job.phase = 'matching local library';
      if (/^\[v2\]\s+selected\s+\d+/i.test(line)) job.phase = 'planning diverse queue';

      const m = line.match(/^\[hop\s+\d+\]\s+Added:\s+(.+?)\s+\(([^)]+)\)/i)
        || line.match(/^\[simple\]\s+Added:\s+(.+?)\s+\(([^)]+)\)/i);
      if (m) {
        const label = String(m[1] || '').trim();
        const method = String(m[2] || '').trim();
        const parts = label.split(' — ');
        const titleX = parts[0] || label;
        const artistX = parts.length > 1 ? parts.slice(1).join(' — ') : '';
        job.added.push({
          eventId: job.nextEventId++,
          artist: artistX,
          title: titleX,
          method,
        });
        if (job.added.length > 500) job.added = job.added.slice(-500);
        job.builtCount += 1;
        job.phase = 'adding tracks';
      }

      const pm = line.match(/^\[simple\]\s+pass\s+(\d+)\s+added\s+(\d+)\s+track/i);
      if (pm) {
        const p = Number(pm[1] || 0);
        const n = Number(pm[2] || 0);
        job.phase = `simple pass ${p} complete (+${n})`;
      }
    };

    let outBuf = '';
    let errBuf = '';
    child.stdout.on('data', (buf) => {
      outBuf += String(buf || '');
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop() || '';
      lines.filter(Boolean).forEach(onLine);
    });
    child.stderr.on('data', (buf) => {
      errBuf += String(buf || '');
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop() || '';
      lines.filter(Boolean).forEach(() => onLine('stderr: subprocess output omitted'));
    });
    child.on('close', async (code) => {
      clearTimeout(childDeadlineTimer);
      clearTimeout(childKillTimer);
      if (job.done) return;
      if (outBuf.trim()) onLine(outBuf.trim());
      if (errBuf.trim()) onLine('stderr: subprocess output omitted');
      if (code !== 0 && !job.error) {
        job.error = 'VIBE_UNAVAILABLE';
        job.warningCode = job.error;
        job.warning = safeVibeFailure(job.error).message;
      }

      if (usePlannerV2) {
        try {
          if (!job.error) {
            const data = JSON.parse(await fs.readFile(jsonTmp, 'utf8'));
            const failure = plannerFailure(data);
            const partial = plannerPartial(data);
            const plannedTracks = Array.isArray(data?.tracks) ? data.tracks : [];
            if (failure) {
              job.warningCode = failure.code;
              job.warning = failure.message;
              if (plannedTracks.length) job.partial = true;
              else job.error = failure.code;
            }
            if (partial) {
              job.partial = true;
              job.warningCode = partial.code;
              job.warning = partial.message;
            }
            job.tracks = plannedTracks;
            job.rawBuiltCount = plannedTracks.length;
            job.builtCount = plannedTracks.length;

            if (plannedTracks.length) {
              await applyVibePlanToMpd(job, {
                mpdHost,
                playNow,
                keepPlaying,
                resumePlayback: endless,
              });
            } else {
              job.logs.push('[planner-v2] no usable local plan; MPD queue left unchanged');
              appendVibeJobLog(job, 'plan-empty', { planner: 'v2' }).catch(() => {});
            }
          }
        } catch (error) {
          if (!job.error) {
            job.error = 'VIBE_UNAVAILABLE';
            job.warningCode = job.error;
            job.warning = safeVibeFailure(job.error).message;
          }
          job.logs.push('planner-v2 apply error');
          appendVibeJobLog(job, 'planner-v2-apply-error', { error: 'VIBE_UNAVAILABLE' }).catch(() => {});
        } finally {
          await fs.unlink(jsonTmp).catch(() => {});
        }
      }

      job.done = true;
      job.status = job.error ? 'error' : 'done';
      job.phase = job.error ? 'error' : 'complete';
      job.updatedAt = Date.now();
      appendVibeJobLog(job, 'complete', {
        exitCode: Number(code || 0),
        status: job.status,
        phase: job.phase,
        error: job.error || '',
        builtCount: Number(job.builtCount || 0),
        rawBuiltCount: Number(job.rawBuiltCount || 0),
        planner: usePlannerV2 ? 'v2' : 'legacy',
        seededStart: true,
        endless: !!endless,
      }).catch(() => {});
    });

    return { ok: true, jobId, targetQueue, seedArtist, seedTitle, job };
  }

  // Bearer-authenticated mobile adapter. The mobile queue surface must not
  // receive the Track Key or call this admin route over HTTP. Reuse the same
  // server-side Vibe builder, but derive the seed from MPD here and return
  // only the opaque job handle needed for progress polling by a future client.
  async function startMobileVibe(body = {}) {
    const mpdHost = String(MPD_HOST || 'moode.local');
    const { stdout } = await execFileP('mpc', ['-h', mpdHost, '-f', '%artist%\t%title%', 'current']);
    const [artistRaw = '', titleRaw = ''] = String(stdout || '').trim().split('\t');
    const seedArtist = String(artistRaw || '').trim();
    const seedTitle = String(titleRaw || '').trim();
    if (!seedArtist || !seedTitle) throw new Error('No current track (artist/title empty)');

    const result = await startSeededVibeJob({
      targetQueue: body?.targetQueue,
      playNow: body?.playNow === true,
      keepPlaying: body?.keepPlaying === true,
      seedArtist,
      seedTitle,
    });
    if (!result?.ok) throw new Error(result?.error || 'Vibe could not be started');
    return {
      accepted: true,
      jobId: result.jobId,
      targetQueue: result.targetQueue,
      seedArtist: result.seedArtist,
      seedTitle: result.seedTitle,
    };
  }

  // Fire-and-forget seeded start for Alexa "vibe here" mode and backend Endless Vibe.
  // Returns immediately after spawning the builder process, but also registers a
  // status/debug job so controller UI can surface progress and failures.
  app.post('/config/queue-wizard/vibe-seed-start', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const seedArtist = String(req.body?.seedArtist || '').trim();
      const seedTitle = String(req.body?.seedTitle || '').trim();
      if (!seedArtist || !seedTitle) return res.status(400).json({ ok: false, error: 'Missing seedArtist/seedTitle' });
      if (!await resolveLastfmKey()) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });

      const result = await startSeededVibeJob({
        targetQueue: req.body?.targetQueue,
        playNow: !!req.body?.playNow,
        keepPlaying: !!req.body?.keepPlaying,
        endless: !!req.body?.endless,
        seedArtist,
        seedTitle,
      });
      if (!result.ok) return res.status(500).json({ ok: false, error: result.error, jobId: result.jobId });
      return res.status(202).json({
        ok: true,
        accepted: true,
        jobId: result.jobId,
        targetQueue: result.targetQueue,
        seedArtist: result.seedArtist,
        seedTitle: result.seedTitle,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  async function endlessVibeTick() {
    if (endlessVibeTickBusy) return;
    endlessVibeTickBusy = true;
    try {
      if (endlessVibeActiveJobId) {
        const active = vibeJobs.get(endlessVibeActiveJobId);
        if (active && !active.done) return;
        endlessVibeActiveJobId = '';
      }

      if (hasActiveVibeJob()) return;

      const enabled = await readEndlessVibeEnabled();
      if (!enabled) {
        endlessVibeLastSeedKey = '';
        endlessVibeLastAttemptAt = 0;
        return;
      }

      const seed = await getEndlessVibeSeed();
      if (!seed) return;

      const now = Date.now();
      if (seed.seedKey === endlessVibeLastSeedKey && (now - endlessVibeLastAttemptAt) < endlessVibeRetryMs) return;
      endlessVibeLastSeedKey = seed.seedKey;
      endlessVibeLastAttemptAt = now;

      const result = await startSeededVibeJob({
        targetQueue: 12,
        playNow: false,
        keepPlaying: true,
        endless: true,
        seedArtist: seed.artist,
        seedTitle: seed.title,
      });
      if (!result.ok) {
        log?.warn?.('[endless-vibe] start failed:', result.error || 'unknown error');
        return;
      }

      endlessVibeActiveJobId = result.jobId;
      log?.info?.('[endless-vibe] extending queue', {
        jobId: result.jobId,
        seedArtist: seed.artist,
        seedTitle: seed.title,
        mpdState: seed.mpdState,
      });
    } catch (error) {
      log?.debug?.('[endless-vibe] watcher failed:', error?.message || String(error));
    } finally {
      endlessVibeTickBusy = false;
    }
  }

  if (!capabilities.rehearsal && typeof mpdQueryRaw === 'function') {
    const initialTick = setTimeout(() => { endlessVibeTick().catch(() => {}); }, 2000);
    initialTick.unref?.();
    const endlessVibeTimer = setInterval(() => { endlessVibeTick().catch(() => {}); }, endlessVibePollMs);
    endlessVibeTimer.unref?.();
  }

  // Seeded one-shot endpoint for Alexa/Echo mode (when MPD current is not the Echo track)
  app.post('/config/queue-wizard/vibe-seed', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const targetQueue = Math.max(1, Math.min(200, Number(req.body?.targetQueue) || 12));
      const seedArtist = String(req.body?.seedArtist || '').trim();
      const seedTitle = String(req.body?.seedTitle || '').trim();
      if (!seedArtist || !seedTitle) return res.status(400).json({ ok: false, error: 'Missing seedArtist/seedTitle' });

      const lastfmApiKey = await resolveLastfmKey();
      if (!lastfmApiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });

      const mpdHost = String(MPD_HOST || 'moode.local');
      const vibeIndexPath = await resolveVibeIndex();
      const data = await runVibePreview({ prefix: 'vibe-seed', lastfmApiKey, vibeIndexPath, seedArtist, seedTitle, targetQueue, mpdHost });
      const failure = plannerFailure(data);
      if (failure) return res.status(502).json({ ok: false, error: failure.message, code: failure.code });
      return res.json({ ok: true, tracks: data?.tracks || [], summary: safePlannerSummary(data), targetQueue, seedArtist, seedTitle });
    } catch (e) {
      if (e?.code === 'VIBE_DEADLINE_EXCEEDED') return res.status(504).json({ ok: false, error: safeVibeFailure(e.code).message, code: e.code });
      return res.status(500).json({ ok: false, error: 'Vibe request failed', code: 'VIBE_UNAVAILABLE' });
    }
  });

  return { startMobileVibe };
}
