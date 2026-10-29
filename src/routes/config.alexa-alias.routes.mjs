import fs from 'node:fs/promises';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { writeJsonAtomically } from '../lib/atomic-file.mjs';

export function registerConfigAlexaAliasRoutes(app, deps) {
  const { requireTrackKey } = deps;
  const configPath = runtimeStatePaths().configPath;

  async function handleArtistAliasSuggestion(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const artist = String(req.body?.artist || '').trim();
      if (!artist) return res.status(400).json({ ok: false, error: 'Missing artist' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = artist.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');

      const unresolved = Array.isArray(current?.alexa?.unresolvedArtists) ? current.alexa.unresolvedArtists : [];
      const idx = unresolved.findIndex((x) => String(x?.key || '').trim() === key);

      if (idx >= 0) {
        const prev = unresolved[idx] || {};
        unresolved[idx] = {
          ...prev,
          artist,
          key,
          count: Number(prev.count || 1) + 1,
          updatedAt: now,
          lastSource: source,
        };
      } else {
        unresolved.unshift({
          artist,
          key,
          count: 1,
          createdAt: now,
          updatedAt: now,
          lastSource: source,
        });
      }

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          unresolvedArtists: unresolved.slice(0, 200),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, queued: artist, total: unresolved.slice(0, 200).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  async function handleAlexaHeardArtist(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const artist = String(req.body?.artist || '').trim();
      if (!artist) return res.status(400).json({ ok: false, error: 'Missing artist' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = artist.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');
      const status = String(req.body?.status || 'attempt');

      const heard = Array.isArray(current?.alexa?.heardArtists) ? current.alexa.heardArtists : [];
      heard.unshift({ artist, key, source, status, at: now });

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          heardArtists: heard.slice(0, 400),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, logged: artist, total: heard.slice(0, 400).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  async function handleAlbumAliasSuggestion(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const album = String(req.body?.album || '').trim();
      if (!album) return res.status(400).json({ ok: false, error: 'Missing album' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = album.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');

      const unresolved = Array.isArray(current?.alexa?.unresolvedAlbums) ? current.alexa.unresolvedAlbums : [];
      const idx = unresolved.findIndex((x) => String(x?.key || '').trim() === key);
      if (idx >= 0) {
        const prev = unresolved[idx] || {};
        unresolved[idx] = { ...prev, album, key, count: Number(prev.count || 1) + 1, updatedAt: now, lastSource: source };
      } else {
        unresolved.unshift({ album, key, count: 1, createdAt: now, updatedAt: now, lastSource: source });
      }

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          unresolvedAlbums: unresolved.slice(0, 200),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, queued: album, total: unresolved.slice(0, 200).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  async function handleAlexaHeardAlbum(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const album = String(req.body?.album || '').trim();
      if (!album) return res.status(400).json({ ok: false, error: 'Missing album' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = album.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');
      const status = String(req.body?.status || 'attempt');
      const resolvedTo = String(req.body?.resolvedTo || '').trim();

      const heard = Array.isArray(current?.alexa?.heardAlbums) ? current.alexa.heardAlbums : [];
      heard.unshift({ album, key, source, status, resolvedTo, at: now });

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          heardAlbums: heard.slice(0, 400),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, logged: album, total: heard.slice(0, 400).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  async function handlePlaylistAliasSuggestion(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const playlist = String(req.body?.playlist || '').trim();
      if (!playlist) return res.status(400).json({ ok: false, error: 'Missing playlist' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = playlist.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');

      const unresolved = Array.isArray(current?.alexa?.unresolvedPlaylists) ? current.alexa.unresolvedPlaylists : [];
      const idx = unresolved.findIndex((x) => String(x?.key || '').trim() === key);
      if (idx >= 0) {
        const prev = unresolved[idx] || {};
        unresolved[idx] = { ...prev, playlist, key, count: Number(prev.count || 1) + 1, updatedAt: now, lastSource: source };
      } else {
        unresolved.unshift({ playlist, key, count: 1, createdAt: now, updatedAt: now, lastSource: source });
      }

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          unresolvedPlaylists: unresolved.slice(0, 200),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, queued: playlist, total: unresolved.slice(0, 200).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  async function handleAlexaHeardPlaylist(req, res) {
    try {
      if (!requireTrackKey(req, res)) return;
      const playlist = String(req.body?.playlist || '').trim();
      if (!playlist) return res.status(400).json({ ok: false, error: 'Missing playlist' });

      let current = {};
      try { current = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}

      const now = new Date().toISOString();
      const key = playlist.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const source = String(req.body?.source || 'alexa');
      const status = String(req.body?.status || 'attempt');
      const resolvedTo = String(req.body?.resolvedTo || '').trim();

      const heard = Array.isArray(current?.alexa?.heardPlaylists) ? current.alexa.heardPlaylists : [];
      heard.unshift({ playlist, key, source, status, resolvedTo, at: now });

      const next = {
        ...current,
        alexa: {
          ...(current.alexa || {}),
          heardPlaylists: heard.slice(0, 400),
        },
      };

      await writeJsonAtomically(configPath, next);
      return res.json({ ok: true, logged: playlist, total: heard.slice(0, 400).length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }

  app.post('/config/artist-alias-suggestion', handleArtistAliasSuggestion);
  app.post('/mpd/artist-alias-suggestion', handleArtistAliasSuggestion);
  app.post('/config/album-alias-suggestion', handleAlbumAliasSuggestion);
  app.post('/mpd/album-alias-suggestion', handleAlbumAliasSuggestion);

  app.post('/config/alexa-heard-artist', handleAlexaHeardArtist);
  app.post('/mpd/alexa-heard-artist', handleAlexaHeardArtist);
  app.post('/config/alexa-heard-album', handleAlexaHeardAlbum);
  app.post('/mpd/alexa-heard-album', handleAlexaHeardAlbum);
  app.post('/config/alexa-heard-playlist', handleAlexaHeardPlaylist);
  app.post('/mpd/alexa-heard-playlist', handleAlexaHeardPlaylist);
  app.post('/config/playlist-alias-suggestion', handlePlaylistAliasSuggestion);
  app.post('/mpd/playlist-alias-suggestion', handlePlaylistAliasSuggestion);
}
