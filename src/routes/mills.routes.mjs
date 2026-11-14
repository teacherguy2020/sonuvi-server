import {
  jukeboxEntries,
  parsePlaylistFiles,
  persistJukeboxState,
  withJukeboxMutation,
} from './seeburg.routes.mjs';

let millsActive = false;
let lastTransition = null;
let transitionQueue = Promise.resolve();
let millsSession = null;
const MILLS_SELECTION_DEDUPE_MS = 5000;

function withMillsTransition(task) {
  const run = transitionQueue.then(task, task);
  transitionQueue = run.catch(() => {});
  return run;
}

function unescapeMpdValue(value) {
  return String(value ?? '').replace(/\\([\\"]|n|r|t)/g, (_, token) => {
    if (token === 'n') return '\n';
    if (token === 'r') return '\r';
    if (token === 't') return '\t';
    return token;
  });
}

function parseMpdBlocks(raw) {
  return String(raw || '')
    .split(/\r?\n(?=file:\s*)/i)
    .map((block) => {
      const out = {};
      String(block).split(/\r?\n/).forEach((line) => {
        const i = line.indexOf(':');
        if (i >= 0) out[line.slice(0, i).trim().toLowerCase()] = unescapeMpdValue(line.slice(i + 1).trim());
      });
      return out;
    })
    .filter((item) => item.file || item.id || item.pos);
}

function parseMpdNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isDuplicateMillsSelection(slot) {
  const lastSelectionAt = Number(millsSession?.selectionAtMs || 0);
  return millsSession?.selectionSlot === slot
    && millsSession?.displaySelected
    && Number.isFinite(lastSelectionAt)
    && Date.now() - lastSelectionAt < MILLS_SELECTION_DEDUPE_MS;
}

export function getMillsIntegrationState() {
  const metadata = millsSession?.metadata || null;
  return {
    active: millsActive,
    lastTransition,
    displayOnly: Boolean(millsActive),
    displayMode: millsActive ? 'mills' : null,
    showProgress: millsActive ? false : true,
    surrogateStarted: false,
    surrogateFile: null,
    mpdSongId: null,
    selectionSlot: millsSession?.selectionSlot || null,
    selectedFile: metadata?.file || null,
    metadata,
  };
}

export function registerMillsRoutes(app, deps) {
  const {
    requireTrackKey,
    switchDenonInput,
    mpdQueryRaw,
    mpdEscapeValue,
    mpdHasACK,
    parseMpdFirstBlock,
    millsPlaylistName = 'Mills Playlist',
  } = deps;

  function parseMpdId(raw) {
    const match = String(raw || '').match(/(?:^|\n)Id:\s*(\d+)/i);
    return match ? Number(match[1]) : 0;
  }

  function parseMillsSlot(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const slot = Number(text);
    return Number.isSafeInteger(slot) && slot >= 1 && slot <= 20 ? slot : null;
  }

  async function snapshotMpdSession() {
    const statusRaw = await mpdQueryRaw('status');
    if (!statusRaw || mpdHasACK(statusRaw)) throw new Error('MPD status snapshot failed');
    const status = parseMpdFirstBlock(statusRaw);
    const queueRaw = await mpdQueryRaw('playlistinfo');
    if (mpdHasACK(queueRaw)) throw new Error('MPD queue snapshot failed');
    const queue = parseMpdBlocks(queueRaw)
      .filter((item) => String(item.file || '').trim())
      .map((item) => ({
        file: String(item.file).trim(),
        mpdSongId: Number(item.id || 0) || 0,
        position: Number(item.pos || 0) || 0,
      }));
    const currentPos = Number(status.song ?? -1);
    const currentSongId = Number(status.songid || 0) || 0;
    const current = queue.find((item) => item.mpdSongId === currentSongId)
      || queue.find((item) => item.position === currentPos);
    return {
      state: String(status.state || 'stop').trim().toLowerCase() || 'stop',
      currentFile: current?.file || '',
      currentPos,
      currentSongId,
      elapsed: Math.max(0, parseMpdNumber(status.elapsed, 0)),
      queue,
    };
  }

  async function removeMillsSurrogates() {
    const queueRaw = await mpdQueryRaw('playlistinfo');
    if (mpdHasACK(queueRaw)) throw new Error('MPD queue inspection failed during Mills cleanup');
    const liveItems = parseMpdBlocks(queueRaw);
    const knownMillsIds = new Set(
      [...jukeboxEntries.entries()]
        .filter(([, entry]) => entry?.source === 'mills')
        .map(([id]) => Number(id)),
    );
    if (millsSession?.mpdSongId) knownMillsIds.add(Number(millsSession.mpdSongId));
    for (const item of liveItems) {
      const id = Number(item.id || 0);
      if (!knownMillsIds.has(id)) continue;
      const result = await mpdQueryRaw(`deleteid ${id}`);
      if (mpdHasACK(result)) throw new Error(`MPD rejected removing Mills surrogate ${id}`);
    }
    let metadataChanged = false;
    for (const [id, entry] of jukeboxEntries.entries()) {
      if (entry?.source !== 'mills') continue;
      jukeboxEntries.delete(id);
      metadataChanged = true;
    }
    if (metadataChanged || knownMillsIds.size) persistJukeboxState();
  }

  async function restoreMpdSession(snapshot) {
    if (!snapshot) return;
    const clear = await mpdQueryRaw('clear');
    if (mpdHasACK(clear)) throw new Error('MPD rejected clearing the Mills queue');

    const restoredIds = [];
    for (const item of snapshot.queue) {
      const add = await mpdQueryRaw(`addid ${mpdEscapeValue(item.file)}`);
      if (!add || mpdHasACK(add)) throw new Error(`MPD rejected restoring ${item.file}`);
      const id = parseMpdId(add);
      if (!id) throw new Error(`MPD did not return an ID while restoring ${item.file}`);
      restoredIds.push(id);
    }

    if (snapshot.state === 'stop' || !restoredIds.length) {
      const stop = await mpdQueryRaw('stop');
      if (mpdHasACK(stop)) throw new Error('MPD rejected restoring stopped state');
      return;
    }

    let restoreIndex = Number.isInteger(snapshot.currentPos) ? snapshot.currentPos : -1;
    if (restoreIndex < 0 || restoreIndex >= restoredIds.length) {
      restoreIndex = snapshot.currentFile
        ? snapshot.queue.findIndex((item) => item.file === snapshot.currentFile)
        : -1;
    }
    if (restoreIndex < 0 || restoreIndex >= restoredIds.length) {
      const stop = await mpdQueryRaw('stop');
      if (mpdHasACK(stop)) throw new Error('MPD rejected restoring state without a current track');
      return;
    }

    const currentId = restoredIds[restoreIndex];
    const play = await mpdQueryRaw(`playid ${currentId}`);
    if (mpdHasACK(play)) throw new Error('MPD rejected restoring the previous track');
    if (snapshot.elapsed > 0) {
      const seek = await mpdQueryRaw(`seekid ${currentId} ${snapshot.elapsed.toFixed(3)}`);
      if (mpdHasACK(seek)) throw new Error('MPD rejected restoring the previous position');
    }
    if (snapshot.state === 'pause') {
      const pause = await mpdQueryRaw('pause 1');
      if (mpdHasACK(pause)) throw new Error('MPD rejected restoring paused state');
    }
  }

  async function resolveMillsPlaylist() {
    const playlist = String(millsPlaylistName || 'Mills Playlist').trim();
    const rawPlaylist = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(playlist)}`);
    if (!rawPlaylist || mpdHasACK(rawPlaylist)) {
      const error = new Error(`Playlist not found or unavailable: ${playlist}`);
      error.statusCode = 404;
      throw error;
    }
    const files = parsePlaylistFiles(rawPlaylist);
    if (!files.length) {
      const error = new Error(`Playlist has no entries: ${playlist}`);
      error.statusCode = 404;
      throw error;
    }
    return { playlist, files };
  }

  function parseMillsMetadata(raw, file) {
    const item = parseMpdBlocks(raw)[0] || {};
    const text = (key) => String(item[key] || '').trim();
    return {
      file,
      title: text('title'),
      artist: text('artist'),
      album: text('album'),
      date: text('date') || text('originaldate'),
      encoded: text('encoded'),
      bitrate: text('bitrate'),
      outrate: text('outrate'),
      track: text('track'),
    };
  }

  async function loadMillsDisplaySelection(slot, file) {
    if (isDuplicateMillsSelection(slot)) {
      return { ...millsSession, duplicate: true, playbackStarted: false };
    }

    // Add only long enough to ask MPD for the selected file's tags. The
    // physical record is authoritative, so the digital file must never stay
    // in the queue or begin playback.
      const add = await mpdQueryRaw(`addid ${mpdEscapeValue(file)}`);
      if (!add || mpdHasACK(add)) throw new Error('MPD rejected the Mills display selection');
      const mpdSongId = parseMpdId(add);
      if (!mpdSongId) throw new Error('MPD did not return a song ID for the Mills display selection');

      let metadataRaw;
      let operationError = null;
      try {
        metadataRaw = await mpdQueryRaw(`playlistid ${mpdSongId}`);
        if (!metadataRaw || mpdHasACK(metadataRaw)) {
          throw new Error('MPD metadata lookup failed for the Mills selection');
        }
      } catch (error) {
        operationError = error;
      }

      const remove = await mpdQueryRaw(`deleteid ${mpdSongId}`);
      if (mpdHasACK(remove)) {
        throw new Error(`MPD rejected removing temporary Mills selection ${mpdSongId}`);
      }
      if (operationError) throw operationError;

      const metadata = parseMillsMetadata(metadataRaw, file);
      millsSession = {
        ...(millsSession || {}),
        metadata,
        selectionSlot: slot,
        selectionAtMs: Date.now(),
        displaySelected: true,
        surrogateStarted: false,
        playbackStarted: false,
      };
      return { ...millsSession, duplicate: false, playbackStarted: false, displayOnly: true };
  }

  async function pauseMpdForMills(snapshot) {
    if (snapshot?.state !== 'play') return;
    const pause = await mpdQueryRaw('pause 1');
    if (mpdHasACK(pause)) throw new Error('MPD rejected pausing for Mills display mode');
  }

  async function switchToMills(snapshot) {
    await switchDenonInput('phono');
    try {
      await pauseMpdForMills(snapshot);
    } catch (error) {
      await switchDenonInput('aux1').catch(() => {});
      throw error;
    }
  }

  app.post('/integrations/mills/start', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      return await withMillsTransition(async () => {
        if (millsActive) {
          return res.json({
            ok: true,
            active: true,
            duplicate: true,
            switched: false,
            surrogateStarted: false,
            displayOnly: true,
            showProgress: false,
            awaitingSelection: !millsSession?.displaySelected,
          });
        }
        const snapshot = await snapshotMpdSession();
        await switchToMills(snapshot);
        millsActive = true;
        millsSession = { active: true, snapshot, displaySelected: false, surrogateStarted: false };
        lastTransition = { state: 'active', at: new Date().toISOString(), input: 'Phono' };
        return res.json({
          ok: true,
          active: true,
          duplicate: false,
          switched: true,
          input: 'Phono',
          surrogateStarted: false,
          playbackStarted: false,
          displayOnly: true,
          showProgress: false,
          awaitingSelection: true,
        });
      });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/integrations/mills/stop', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      return await withMillsTransition(async () => {
        if (!millsActive && lastTransition?.state === 'idle' && lastTransition?.input === 'Aux 1') {
          return res.json({ ok: true, active: false, duplicate: true, switched: false });
        }
        await switchDenonInput('aux1');
        const hasPersistedMillsEntries = [...jukeboxEntries.values()].some((entry) => entry?.source === 'mills');
        if (millsActive || hasPersistedMillsEntries) {
          await withJukeboxMutation(async () => {
            await removeMillsSurrogates();
            const snapshot = millsSession?.snapshot;
            const current = await snapshotMpdSession();
            // Mills only paused MPD. A changed queue, selection, position or
            // resumed playback belongs to the user, not the old Mills snapshot.
            const expectedState = snapshot?.state === 'play' ? 'pause' : snapshot?.state;
            const unchanged = snapshot && current.state === expectedState
              && current.currentSongId === snapshot.currentSongId
              && Math.abs(current.elapsed - snapshot.elapsed) < 1
              && current.queue.length === snapshot.queue.length
              && current.queue.every((item, index) => item.file === snapshot.queue[index].file
                && item.mpdSongId === snapshot.queue[index].mpdSongId);
            if (unchanged) await restoreMpdSession(snapshot);
          });
        }
        millsActive = false;
        millsSession = null;
        lastTransition = { state: 'idle', at: new Date().toISOString(), input: 'Aux 1' };
        return res.json({ ok: true, active: false, duplicate: false, switched: true, input: 'Aux 1' });
      });
    } catch (error) {
      // Keep the active latch set when source restoration fails so a repeated
      // Shelly event can safely retry the consequential operation.
      return res.status(502).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/integrations/mills/selection', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const slot = parseMillsSlot(req.body?.slot);
      if (slot === null) {
        return res.status(400).json({ ok: false, error: 'slot must be an integer from 1 through 20' });
      }
      if (!millsActive) {
        return res.status(409).json({ ok: false, active: false, error: 'Mills session is not active' });
      }

      return await withMillsTransition(async () => {
        if (isDuplicateMillsSelection(slot)) {
          return res.json({
            ok: true,
            active: true,
            duplicate: true,
            switched: false,
            slot,
            file: millsSession.metadata?.file || null,
            mpdSongId: null,
            surrogateStarted: false,
            playbackStarted: false,
            displayOnly: true,
            showProgress: false,
            metadata: millsSession.metadata || null,
          });
        }
        const { files } = await resolveMillsPlaylist();
        const file = files[slot - 1] || '';
        if (!file) {
          return res.status(404).json({
            ok: false,
            active: true,
            error: `Selection ${slot} is outside the Mills Playlist (${files.length} tracks)`,
            playlistLength: files.length,
          });
        }
        const selection = await loadMillsDisplaySelection(slot, file);
        return res.json({
          ok: true,
          active: true,
          duplicate: false,
          switched: false,
          slot,
          file: selection.metadata?.file || null,
          mpdSongId: null,
          surrogateStarted: false,
          playbackStarted: false,
          displayOnly: true,
          showProgress: false,
          metadata: selection.metadata,
        });
      });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      return res.status(status).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.get('/integrations/mills/status', (req, res) => {
    if (!requireTrackKey(req, res)) return;
    return res.json({ ok: true, ...getMillsIntegrationState() });
  });
}
