import fs from 'node:fs';
import path from 'node:path';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';

const MIN_SELECTION = 1;
const MAX_SELECTION = 100;

// Shared by all external jukebox integrations so Seeburg and Multiphone
// requests participate in one FIFO priority segment.
export const jukeboxEntries = new Map();
let jukeboxSequence = 0;
export function nextJukeboxSequence() { return ++jukeboxSequence; }

// A completed paid request is consumed from the active MPD queue. Keep the
// source playlist intact, but remove the matching priority marker immediately
// so it cannot be mistaken for a still-active customer track after completion.
export function removeJukeboxEntry(mpdSongId, statePath = loadedStatePath) {
  const id = Number(mpdSongId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const removed = jukeboxEntries.delete(id);
  if (removed) persistJukeboxState(statePath || undefined);
  return removed;
}

let loadedStatePath = '';
let jukeboxMutation = Promise.resolve();
let jukeboxSession = null;

export function withJukeboxMutation(task) {
  const run = jukeboxMutation.then(task, task);
  jukeboxMutation = run.catch(() => {});
  return run;
}
const isTestRuntime = Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes('--test');
const defaultJukeboxStatePath = isTestRuntime
  ? null
  : runtimeStatePaths().jukeboxStatePath;

export function loadJukeboxState(statePath = runtimeStatePaths().jukeboxStatePath) {
  if (!statePath) return;
  const resolvedPath = path.resolve(statePath);
  if (loadedStatePath === resolvedPath) return;
  loadedStatePath = resolvedPath;
  jukeboxEntries.clear();
  jukeboxSequence = 0;
  jukeboxSession = null;
  try {
    const saved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    jukeboxSession = saved?.session && typeof saved.session === 'object' ? saved.session : null;
    for (const entry of Array.isArray(saved?.entries) ? saved.entries : []) {
      const id = Number(entry?.mpdSongId);
      const sequence = Number(entry?.sequence);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(sequence) || sequence <= 0 || !entry.file) continue;
      jukeboxEntries.set(id, {
        source: String(entry.source || 'jukebox'),
        priority: String(entry.priority || 'jukebox'),
        sequence,
        file: String(entry.file),
        selectionNumber: Number.isSafeInteger(Number(entry.selectionNumber))
          ? Number(entry.selectionNumber)
          : null,
      });
      jukeboxSequence = Math.max(jukeboxSequence, sequence);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Unable to load jukebox state: ${error.message}`);
  }
}

export function persistJukeboxState(statePath = loadedStatePath || runtimeStatePaths().jukeboxStatePath) {
  if (!statePath) return;
  const resolvedPath = path.resolve(statePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const entries = [...jukeboxEntries.entries()].map(([mpdSongId, entry]) => ({ mpdSongId, ...entry }));
  const tempPath = `${resolvedPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ version: 2, sequence: jukeboxSequence, session: jukeboxSession, entries }, null, 2)}\n`);
  fs.renameSync(tempPath, resolvedPath);
}

export function beginJukeboxSession({ source, files, fresh }) {
  const sourceFiles = new Set([...(jukeboxSession?.files || []), ...(files || [])].filter(Boolean));
  jukeboxSession = {
    active: true,
    fresh: Boolean(jukeboxSession?.fresh || fresh),
    source: String(jukeboxSession?.source || source || 'jukebox'),
    files: [...sourceFiles],
    startedAt: jukeboxSession?.startedAt || new Date().toISOString(),
  };
}

export function recoverJukeboxEntries(items, statePath, entries = jukeboxEntries) {
  if (!jukeboxSession?.active || !jukeboxSession.fresh || !jukeboxSession.files?.length) return;
  const known = items.filter((item) => entries.has(Number(item.id || 0)));
  if (!known.length) return;
  const firstKnownPos = Math.min(...known.map((item) => Number(item.pos)).filter(Number.isFinite));
  const minSequence = Math.min(...known.map((item) => Number(entries.get(Number(item.id))?.sequence || 0)).filter((n) => n > 0));
  if (!Number.isFinite(firstKnownPos) || !Number.isFinite(minSequence)) return;
  const recovered = items
    .filter((item) => Number(item.pos) >= 0 && Number(item.pos) < firstKnownPos && jukeboxSession.files.includes(item.file) && !entries.has(Number(item.id)))
    .sort((a, b) => Number(a.pos) - Number(b.pos));
  if (!recovered.length) return;
  let sequence = minSequence - recovered.length;
  for (const item of recovered) {
    entries.set(Number(item.id), { source: jukeboxSession.source, priority: 'jukebox', sequence: sequence++, file: item.file });
  }
  persistJukeboxState(statePath);
}

export function isJukeboxCurrent(item, items, entries = jukeboxEntries) {
  const id = Number(item?.id || 0);
  // Current-track priority must be based on the stable MPD song ID recorded
  // when Mabel or Seeburg inserted the item. A session-level filename match
  // is useful for recovering pending queue entries, but it can misclassify
  // unrelated house music that happens to use the same file.
  return id > 0 && entries.has(id);
}

export function isJukeboxItem(item, entries = jukeboxEntries) {
  const id = Number(item?.id || 0);
  // Pending priority status must be based on the stable MPD song ID recorded
  // when the integration inserted the item. A session's source-file list is
  // only a recovery aid; ordinary queue tracks can legitimately use the same
  // files and must not be counted as pending jukebox entries.
  return id > 0 && entries.has(id);
}

// Return the insertion point for a new Seeburg/Multiphone selection.
// Ordinary playback is pre-empted at the current position. Once a priority
// item is active, new selections go after the entire live priority block,
// regardless of which integration created the earlier items.
export function getJukeboxInsertionPosition({
  currentPos = -1,
  currentIsJukebox = false,
  priorityItems = [],
  queueWasCleared = false,
} = {}) {
  if (queueWasCleared || currentPos < 0) return 0;
  if (!currentIsJukebox) return currentPos;
  const livePositions = priorityItems
    .map((item) => Number(item?.pos))
    .filter((position) => Number.isSafeInteger(position) && position >= currentPos);
  return Math.max(currentPos, ...livePositions) + 1;
}

export function reconcileJukeboxState(items, statePath, entries = jukeboxEntries) {
  const liveIds = new Set(items.map((item) => Number(item.id || 0)).filter((id) => id > 0));
  let changed = false;
  for (const id of entries.keys()) {
    if (!liveIds.has(id)) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) persistJukeboxState(statePath);
}

export function parsePlaylistFiles(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^file:\s*(.*)$/i);
      return match ? match[1].trim() : '';
    })
    .filter(Boolean);
}

export function parseSelectionNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= MIN_SELECTION && number <= MAX_SELECTION
    ? number
    : null;
}

function parseMpdBlocks(raw) {
  // MPD normally separates playlist records with a blank line, but moOde
  // versions/proxies can collapse that separator. Every record begins with
  // a file field, so split on that boundary as a robust fallback.
  return String(raw || '').split(/\r?\n(?=file:\s*)/i).map((block) => {
    const out = {};
    String(block).split(/\r?\n/).forEach((line) => {
      const i = line.indexOf(':');
      if (i < 0) return;
      out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }).filter((x) => x.file || x.id || x.pos);
}

function parseMpdId(raw) {
  const match = String(raw || '').match(/(?:^|\n)Id:\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function registerSeeburgRoutes(app, deps) {
  const {
    requireTrackKey,
    mpdQueryRaw,
    mpdEscapeValue,
    mpdHasACK,
    parseMpdFirstBlock,
    seeburgPlaylistName = 'Seeburg Playlist',
    jukeboxStatePath = defaultJukeboxStatePath,
  } = deps;

  loadJukeboxState(jukeboxStatePath);
  // Node's test runner executes files concurrently. Keep test fixtures
  // isolated while production integrations continue sharing one FIFO map.
  const entries = isTestRuntime ? new Map() : jukeboxEntries;

  async function resolveSelection(number) {
    const playlist = String(seeburgPlaylistName || 'Seeburg Playlist').trim();
    const raw = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(playlist)}`);
    if (!raw || mpdHasACK(raw)) {
      const error = new Error(`Playlist not found or unavailable: ${playlist}`);
      error.statusCode = 404;
      throw error;
    }

    const files = parsePlaylistFiles(raw);
    const file = files[number - 1] || '';
    if (!file) {
      const error = new Error(`Selection ${number} is outside the playlist (${files.length} tracks)`);
      error.statusCode = 404;
      error.playlistLength = files.length;
      throw error;
    }

    return { playlist, files, file };
  }

  app.post('/integrations/seeburg/selection', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const rawNumber = typeof req.body === 'number' ? req.body : req.body?.number;
      const number = parseSelectionNumber(rawNumber);
      if (number === null) {
        return res.status(400).json({
          ok: false,
          error: 'number must be an integer from 1 through 100',
        });
      }

      const resolved = await resolveSelection(number);
      const dryRun = req.body?.dryRun === true;
      const result = {
        ok: true,
        number,
        playlist: resolved.playlist,
        playlistLength: resolved.files.length,
        file: resolved.file,
        dryRun,
      };

      if (dryRun) return res.json(result);

      return await withJukeboxMutation(async () => {
      const before = await mpdQueryRaw('status');
      if (mpdHasACK(before)) throw new Error('MPD status failed');

      const beforeStatus = parseMpdFirstBlock(before);
      const wasPlaying = String(beforeStatus.state || '').trim().toLowerCase() === 'play';
      const beforeItems = parseMpdBlocks(await mpdQueryRaw('playlistinfo'));
      const currentSongId = Number(beforeStatus.songid || 0) || 0;
      const currentPos = Number(beforeStatus.song || -1);
      if (currentPos >= 0 && !beforeItems.some((item) => Number(item.id || 0) === currentSongId)) {
        const currentInfo = parseMpdBlocks(await mpdQueryRaw(`playlistinfo ${currentPos}:${currentPos + 1}`));
        beforeItems.unshift(...currentInfo.filter((item) => !beforeItems.some((existing) => Number(existing.id || 0) === Number(item.id || 0))));
      }
      reconcileJukeboxState(beforeItems, jukeboxStatePath, entries);
      // A paused/stopped session is idle for selection purposes. Only an
      // actively playing jukebox track should protect the pending segment.
      recoverJukeboxEntries(beforeItems, jukeboxStatePath, entries);
      const currentItem = beforeItems.find((item) => Number(item.id || 0) === currentSongId);
      const currentIsJukebox = wasPlaying && isJukeboxCurrent(currentItem, beforeItems, entries);
      const priorityItems = beforeItems.filter((item) => isJukeboxItem(item, entries));
      const pendingJukebox = beforeItems
        .filter((item) => Number(item.id || 0) > 0 && Number(item.pos || -1) > currentPos && isJukeboxItem(item, entries))
        .sort((a, b) => Number(entries.get(Number(a.id))?.sequence || Number(a.pos) || 0) - Number(entries.get(Number(b.id))?.sequence || Number(b.pos) || 0));

      const addResult = await mpdQueryRaw(`addid ${mpdEscapeValue(resolved.file)}`);
      if (!addResult || mpdHasACK(addResult)) throw new Error('MPD rejected the selected track');
      const insertedSongId = parseMpdId(addResult);
      if (!insertedSongId) throw new Error('MPD did not return a song ID for the selected track');

      // Pre-empt ordinary playback by inserting immediately before the
      // current track. Once a customer-priority track is active, keep new
      // selections together behind it and ahead of ordinary playback.
      // MPD positions are zero-based.
      const insertionPos = getJukeboxInsertionPosition({
        currentPos,
        currentIsJukebox,
        priorityItems,
      });
      const moveResult = await mpdQueryRaw(`moveid ${insertedSongId} ${insertionPos}`);
      if (mpdHasACK(moveResult)) throw new Error('MPD rejected positioning the selected track');
      const sequence = nextJukeboxSequence();
      entries.set(insertedSongId, {
        source: 'seeburg',
        priority: 'jukebox',
        sequence,
        file: resolved.file,
        selectionNumber: number,
      });
      persistJukeboxState(jukeboxStatePath);

      let playbackStarted = false;
      if (!currentIsJukebox) {
        const playResult = await mpdQueryRaw(`play ${insertionPos}`);
        if (mpdHasACK(playResult)) throw new Error('MPD rejected starting the selected track');
        playbackStarted = true;
      }

      const after = await mpdQueryRaw('status');
      if (mpdHasACK(after)) throw new Error('MPD status failed after queueing');

      const afterStatus = parseMpdFirstBlock(after);
      const expectedQueueLength = Number(beforeStatus.playlistlength) + 1;
      const queued = Number(afterStatus.playlistlength) === expectedQueueLength;
      if (!queued) throw new Error('MPD did not report the selected track as queued');

      return res.json({
        ...result,
        queued: true,
        queueLength: Number(afterStatus.playlistlength),
        playbackStarted,
        queueWasCleared: false,
        source: 'seeburg',
        priority: 'jukebox',
        interruptedNormalPlayback: !currentIsJukebox && wasPlaying,
        queuedBehindJukebox: currentIsJukebox,
        jukeboxQueueLength: currentIsJukebox ? pendingJukebox.length + 2 : 1,
        mpdSongId: insertedSongId,
      });
      });
    } catch (e) {
      const status = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
      return res.status(status).json({
        ok: false,
        error: e?.message || String(e),
        ...(e?.playlistLength !== undefined ? { playlistLength: e.playlistLength } : {}),
      });
    }
  });

  // Read-only mapping endpoint for commissioning and playlist verification.
  app.get('/integrations/seeburg/playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const playlist = String(seeburgPlaylistName || 'Seeburg Playlist').trim();
      const raw = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(playlist)}`);
      if (!raw || mpdHasACK(raw)) {
        return res.status(404).json({ ok: false, error: `Playlist not found or unavailable: ${playlist}` });
      }
      const files = parsePlaylistFiles(raw);
      return res.json({
        ok: true,
        playlist,
        count: files.length,
        tracks: files.map((file, index) => ({ number: index + 1, file })),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
