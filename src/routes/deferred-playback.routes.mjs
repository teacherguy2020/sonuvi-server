import { jukeboxEntries, withJukeboxMutation } from './seeburg.routes.mjs';

// Mabel's spoken acknowledgement has a second playback request. It must obey
// the same physical-source hold and FIFO ownership as the selection itself.
export function registerDeferredPlaybackRoutes(app, {
  requireTrackKey, mpdQueryRaw, mpdHasACK, parseMpdFirstBlock,
  getMillsIntegrationState, entries = jukeboxEntries,
}) {
  for (const target of ['song', 'queue']) {
    app.post(`/mpd/start-${target}`, async (req, res) => {
      try {
        if (!requireTrackKey(req, res)) return;
        const songId = target === 'song' ? Number(req.body?.songId) : null;
        if (target === 'song' && (!Number.isSafeInteger(songId) || songId < 0)) {
          return res.status(400).json({ ok: false, error: 'songId must be a non-negative integer' });
        }
        return await withJukeboxMutation(async () => {
          const held = reason => res.json({ ok: true, playbackStarted: false,
            playbackDeferred: true, playbackHold: reason, ...(songId !== null ? { songId } : {}) });
          if (getMillsIntegrationState().active) return held('mills');
          if (target === 'song') {
            const raw = await mpdQueryRaw('status');
            if (!raw || mpdHasACK(raw)) throw Error('MPD status unavailable');
            const current = parseMpdFirstBlock(raw);
            const currentId = Number(current.songid);
            if (currentId === songId && current.state === 'play') {
              // A delayed/repeated callback must not restart a request at zero.
              return res.json({ ok: true, playbackStarted: true, alreadyPlaying: true, songId });
            }
            if (entries.has(songId) && entries.has(currentId) && currentId !== songId) {
              return held('priority');
            }
          }
          const raw = await mpdQueryRaw(target === 'song' ? `playid ${songId}` : 'play 0');
          if (!raw || mpdHasACK(raw)) return res.status(409).json({ ok: false, error: 'MPD rejected starting playback' });
          return res.json({ ok: true, playbackStarted: true, ...(songId !== null ? { songId } : {}) });
        });
      } catch (error) {
        return res.status(500).json({ ok: false, error: error?.message || String(error) });
      }
    });
  }
}
