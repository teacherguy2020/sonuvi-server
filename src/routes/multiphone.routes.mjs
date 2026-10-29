import path from 'node:path';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import {
  jukeboxEntries,
  beginJukeboxSession,
  getJukeboxInsertionPosition,
  loadJukeboxState,
  isJukeboxCurrent,
  isJukeboxItem,
  nextJukeboxSequence,
  parsePlaylistFiles,
  persistJukeboxState,
  recoverJukeboxEntries,
  reconcileJukeboxState,
  withJukeboxMutation,
} from './seeburg.routes.mjs';

const MAX_SELECTION = 1000;

function parseSelectionNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_SELECTION ? number : null;
}

function parseMpdBlocks(raw) {
  return String(raw || '').split(/\r?\n(?=file:\s*)/i).map((block) => {
    const out = {};
    String(block).split(/\r?\n/).forEach((line) => {
      const i = line.indexOf(':');
      if (i >= 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }).filter((x) => x.file || x.id || x.pos);
}

function parseMpdId(raw) {
  const match = String(raw || '').match(/(?:^|\n)Id:\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function registerMultiphoneRoutes(app, deps) {
  const { requireTrackKey, mpdQueryRaw, mpdEscapeValue, mpdHasACK, parseMpdFirstBlock,
    multiphonePlaylistName = 'Multiphone Playlist',
    jukeboxStatePath = (process.env.NODE_TEST_CONTEXT || process.argv.includes('--test')) ? null : runtimeStatePaths().jukeboxStatePath } = deps;
  const playlistName = String(multiphonePlaylistName || 'Multiphone Playlist').trim();
  loadJukeboxState(jukeboxStatePath);
  const entries = (process.env.NODE_TEST_CONTEXT || process.argv.includes('--test')) ? new Map() : jukeboxEntries;

  async function resolve(number) {
    const raw = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(playlistName)}`);
    if (!raw || mpdHasACK(raw)) {
      const error = new Error(`Playlist not found or unavailable: ${playlistName}`);
      error.statusCode = 404; throw error;
    }
    const files = parsePlaylistFiles(raw);
    const file = files[number - 1] || '';
    if (!file) {
      const error = new Error(`Selection ${number} is outside the playlist (${files.length} tracks)`);
      error.statusCode = 404; error.playlistLength = files.length; throw error;
    }
    return { files, file };
  }

  app.post('/integrations/multiphone/selection', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const rawNumber = typeof req.body === 'number' ? req.body : req.body?.number;
      const playNow = req.body?.playNow === true;
      const deferPlayback = !playNow && req.body?.deferPlayback === true;
      const number = parseSelectionNumber(rawNumber);
      if (number === null || number > MAX_SELECTION) {
        return res.status(400).json({ ok: false, error: 'number must be an integer from 1 through 1000' });
      }
      const resolved = await resolve(number);
      const dryRun = req.body?.dryRun === true;
      const result = { ok: true, number, playlist: playlistName, playlistLength: resolved.files.length, file: resolved.file, dryRun };
      if (dryRun) return res.json(result);

      return await withJukeboxMutation(async () => {
      const before = await mpdQueryRaw('status');
      if (mpdHasACK(before)) throw new Error('MPD status failed');
      const status = parseMpdFirstBlock(before);
      const wasPlaying = String(status.state || '').trim().toLowerCase() === 'play';
      const currentPos = Number(status.song ?? -1);
      const currentId = Number(status.songid || 0);
      const items = parseMpdBlocks(await mpdQueryRaw('playlistinfo'));
      if (currentPos >= 0 && !items.some((item) => Number(item.id || 0) === currentId)) {
        const currentInfo = parseMpdBlocks(await mpdQueryRaw(`playlistinfo ${currentPos}:${currentPos + 1}`));
        items.unshift(...currentInfo.filter((item) => !items.some((existing) => Number(existing.id || 0) === Number(item.id || 0))));
      }
      reconcileJukeboxState(items, jukeboxStatePath, entries);
      recoverJukeboxEntries(items, jukeboxStatePath, entries);
      // A paused/stopped session is idle for selection purposes. Only an
      // actively playing jukebox track should protect the pending segment.
      const currentItem = items.find((item) => Number(item.id || 0) === currentId);
      const currentIsJukebox = wasPlaying && isJukeboxCurrent(currentItem, items, entries);
      const queueWasCleared = !wasPlaying && !currentIsJukebox;
      if (queueWasCleared) {
        beginJukeboxSession({ source: 'multiphone', files: resolved.files, fresh: true });
        persistJukeboxState(jukeboxStatePath);
      }
      if (queueWasCleared) {
        const clear = await mpdQueryRaw('clear');
        if (mpdHasACK(clear)) throw new Error('MPD rejected clearing the queue');
      }
      const pending = items.filter((item) => Number(item.pos || -1) > currentPos && isJukeboxItem(item, entries))
        .sort((a, b) => (entries.get(Number(a.id))?.sequence || Number(a.pos) || 0) - (entries.get(Number(b.id))?.sequence || Number(b.pos) || 0));
      const priorityItems = items.filter((item) => isJukeboxItem(item, entries));
      console.info(`[multiphone] selection=${number} currentId=${currentId} currentPos=${currentPos} state=${status.state || ''} currentIsJukebox=${currentIsJukebox} pending=${pending.length} playNow=${playNow}`);

      // A caller may explicitly promote the selection they just made. Reuse
      // the existing pending item instead of adding a duplicate.
      if (playNow) {
        // Match by file as a recovery path too. Metadata is intentionally
        // server-owned and may be rebuilt after a restart, but the pending
        // MPD item itself still identifies the record to promote.
        const existing = items
          .filter((item) => Number(item.pos || -1) > currentPos)
          .find((item) => item.file === resolved.file || entries.get(Number(item.id))?.file === resolved.file);
        if (existing) {
          const position = currentPos + 1;
          const move = await mpdQueryRaw(`moveid ${Number(existing.id)} ${position}`);
          if (mpdHasACK(move)) throw new Error('MPD rejected promoting the selected track');
          const play = await mpdQueryRaw(`play ${position}`);
          if (mpdHasACK(play)) throw new Error('MPD rejected starting the promoted track');
          if (!entries.has(Number(existing.id))) {
            entries.set(Number(existing.id), {
              source: 'multiphone', priority: 'jukebox', sequence: nextJukeboxSequence(), file: existing.file,
              selectionNumber: number,
            });
          } else {
            const existingEntry = entries.get(Number(existing.id));
            entries.set(Number(existing.id), { ...existingEntry, selectionNumber: number });
          }
          {
            persistJukeboxState(jukeboxStatePath);
          }
          const after = await mpdQueryRaw('status');
          if (mpdHasACK(after)) throw new Error('MPD status failed after promoting the selection');
          const afterStatus = parseMpdFirstBlock(after);
          return res.json({ ...result, queued: true, queueLength: Number(afterStatus.playlistlength),
            playbackStarted: true, queueWasCleared: false, source: 'multiphone', priority: 'jukebox',
            mpdSongId: Number(existing.id), artist: existing.artist || '', title: existing.title || '',
            queuedBehindJukebox: false, jukeboxQueueLength: pending.length + 1,
            playNow: true, promotedExisting: true });
        }
      }
      const add = await mpdQueryRaw(`addid ${mpdEscapeValue(resolved.file)}`);
      if (!add || mpdHasACK(add)) throw new Error('MPD rejected the selected track');
      const id = parseMpdId(add);
      if (!id) throw new Error('MPD did not return a song ID for the selected track');
      // A new customer selection pre-empts ordinary playback by going
      // immediately before the current song. Once a jukebox song is active,
      // keep the customer selections together as a mini-queue immediately
      // behind the current priority song and ahead of ordinary playback.
      const position = getJukeboxInsertionPosition({
        currentPos,
        currentIsJukebox,
        priorityItems,
        queueWasCleared,
      });
      const move = await mpdQueryRaw(`moveid ${id} ${position}`);
      if (mpdHasACK(move)) throw new Error('MPD rejected positioning the selected track');
      // playlistinfo takes a queue position/range; playlistid takes an MPD
      // song ID, which is what addid returned above.
      const trackInfo = parseMpdBlocks(await mpdQueryRaw(`playlistid ${id}`))[0] || {};
      entries.set(id, {
        source: 'multiphone',
        priority: 'jukebox',
        sequence: nextJukeboxSequence(),
        file: resolved.file,
        selectionNumber: number,
      });
      persistJukeboxState(jukeboxStatePath);
      let playbackStarted = false;
      const playbackDeferred = deferPlayback && (queueWasCleared || !currentIsJukebox);
      if ((queueWasCleared || !currentIsJukebox) && !deferPlayback) {
        const play = await mpdQueryRaw(`play ${position}`);
        if (mpdHasACK(play)) throw new Error('MPD rejected starting the selected track');
        playbackStarted = true;
      }
      console.info(`[multiphone] selection=${number} insertedId=${id} playbackStarted=${playbackStarted} queueWasCleared=${queueWasCleared} queuedBehindJukebox=${currentIsJukebox}`);
      const after = await mpdQueryRaw('status');
      if (mpdHasACK(after)) throw new Error('MPD status failed after queueing');
      const afterStatus = parseMpdFirstBlock(after);
      return res.json({ ...result, queued: true, queueLength: Number(afterStatus.playlistlength), playbackStarted,
        queueWasCleared, source: 'multiphone', priority: 'jukebox', mpdSongId: id,
        artist: trackInfo.artist || '', title: trackInfo.title || '',
        queuedBehindJukebox: currentIsJukebox,
        interruptedNormalPlayback: wasPlaying && !currentIsJukebox,
        jukeboxQueueLength: currentIsJukebox ? pending.length + 2 : 1,
        playbackDeferred,
        decision: { currentSongId: currentId, currentPos, currentIsJukebox, pendingJukeboxCount: pending.length },
        playNow });
      });
    } catch (e) {
      const status = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
      return res.status(status).json({ ok: false, error: e?.message || String(e), ...(e?.playlistLength !== undefined ? { playlistLength: e.playlistLength } : {}) });
    }
  });

  app.get('/integrations/multiphone/playlist', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const raw = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(playlistName)}`);
      if (!raw || mpdHasACK(raw)) return res.status(404).json({ ok: false, error: `Playlist not found or unavailable: ${playlistName}` });
      const files = parsePlaylistFiles(raw);
      return res.json({ ok: true, playlist: playlistName, count: files.length, tracks: files.map((file, i) => ({ number: i + 1, file })) });
    } catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
}
