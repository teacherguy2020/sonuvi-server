import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeStatePaths } from './runtime-state-paths.mjs';
import { CapabilityDeniedError, runtimeCapabilities } from './runtime-capabilities.mjs';

const execFileP = promisify(execFile);

export function parseMpdDuration(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) || 0;
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return 0;
}

function norm(s = '') {
  return String(s || '').trim().toLowerCase();
}

function parseTrackNo(track = '') {
  const n = Number.parseInt(String(track || '').replace(/[^0-9].*$/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function validRehearsalBrowseIndex(index) {
  const counts = index?.counts;
  return Boolean(
    index
      && typeof index === 'object'
      && index.schema === 'now-playing.browse-index.v2'
      && Array.isArray(index.artists)
      && Array.isArray(index.albums)
      && Array.isArray(index.tracks)
      && counts
      && Number(counts.artists) === index.artists.length
      && Number(counts.albums) === index.albums.length
      && Number(counts.tracks) === index.tracks.length
      && index.tracks.every((track) => typeof track?.file === 'string' && track.file.trim()),
  );
}

async function readRehearsalBrowseIndex({ fsApi, indexPath, rehearsalStateRoot }) {
  const root = String(rehearsalStateRoot || '').trim();
  if (!root || !path.isAbsolute(root)) throw new CapabilityDeniedError('browse-index.fixture');
  const resolvedRoot = path.resolve(root);
  const resolvedIndex = path.resolve(indexPath);
  if (!contained(resolvedRoot, resolvedIndex)) throw new CapabilityDeniedError('browse-index.fixture');

  try {
    const rootStat = await fsApi.lstat(resolvedRoot);
    const indexStat = await fsApi.lstat(resolvedIndex);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !indexStat.isFile() || indexStat.isSymbolicLink()) {
      throw new Error('invalid fixture metadata');
    }
    const realRoot = await fsApi.realpath(resolvedRoot);
    const realIndex = await fsApi.realpath(resolvedIndex);
    if (realRoot !== resolvedRoot || !contained(realRoot, realIndex)) throw new Error('fixture path escape');
    const parsed = JSON.parse(await fsApi.readFile(realIndex, 'utf8'));
    if (!validRehearsalBrowseIndex(parsed)) throw new Error('invalid fixture schema');
    return parsed;
  } catch (error) {
    if (error instanceof CapabilityDeniedError) throw error;
    throw new Error('rehearsal browse-index fixture is unavailable or invalid');
  }
}

/**
 * The production adapter retains its MPD freshness behavior. Rehearsal is a
 * distinct adapter mode: its checked synthetic v2 fixture is the sole catalog
 * authority, so no mpc child process, MPD connection, rebuild, or state write
 * can be reached from browse requests.
 */
export function createBrowseIndexAdapter({
  statePaths = runtimeStatePaths(),
  capabilities = runtimeCapabilities(),
  fsApi = fs,
  runExecFile = execFileP,
  rehearsalStateRoot = process.env.SONUVI_REHEARSAL_STATE_ROOT,
  now = () => Date.now(),
} = {}) {
  const indexPath = String(statePaths?.browseIndexPath || '').trim();
  if (!indexPath || !path.isAbsolute(indexPath)) throw new Error('browse index path must be absolute');
  let mem = { ts: 0, host: '', index: null, inflight: null, dbCheckTs: 0, dbUpdateIso: '' };

  async function getMpdDbUpdateIso(mpdHost = 'moode.local') {
    try {
      const { stdout } = await runExecFile('mpc', ['-h', String(mpdHost || 'moode.local'), 'stats'], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 8000,
      });
      const txt = String(stdout || '');
      // mpc usually emits: "DB Updated: Fri Mar 15 12:34 :56 2026"
      const m = txt.match(/^\s*DB Updated:\s*(.+)$/im);
      const raw = String(m?.[1] || '').trim();
      if (!raw) return '';
      const d = new Date(raw);
      if (!Number.isFinite(d.getTime())) return '';
      return d.toISOString();
    } catch {
      return '';
    }
  }

  async function buildBrowseIndex(mpdHost = 'moode.local') {
    if (capabilities?.rehearsal) throw new CapabilityDeniedError('browse-index.mpd-refresh');
    const dbUpdateAt = await getMpdDbUpdateIso(mpdHost);
    const fmt = '%file%\t%artist%\t%albumartist%\t%album%\t%title%\t%track%\t%genre%\t%time%\t%MUSICBRAINZ_TRACKID%\t%MUSICBRAINZ_ALBUMID%\t%MUSICBRAINZ_ARTISTID%';
    const { stdout } = await runExecFile('mpc', ['-h', String(mpdHost || 'moode.local'), '-f', fmt, 'listall'], {
      maxBuffer: 96 * 1024 * 1024,
    });

    const artists = new Map();
    const albums = new Map();
    const tracks = [];
    let id = 0;

    for (const ln of String(stdout || '').split(/\r?\n/)) {
      if (!ln) continue;
      const [file = '', artistRaw = '', albumArtistRaw = '', albumRaw = '', titleRaw = '', trackRaw = '', genreRaw = '', timeRaw = '', mbTrackRaw = '', mbAlbumRaw = '', mbArtistRaw = ''] = ln.split('\t');
      const filePath = String(file || '').trim();
      if (!filePath) continue;

      const artist = String(artistRaw || albumArtistRaw || '').trim();
      const albumArtist = String(albumArtistRaw || artistRaw || '').trim();
      const album = String(albumRaw || '').trim();
      const title = String(titleRaw || '').trim() || (filePath.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
      const track = String(trackRaw || '').trim();
      const genre = String(genreRaw || '').trim();
      const durationSec = parseMpdDuration(timeRaw);

      const artistKey = norm(artist || albumArtist);
      const albumKey = `${norm(albumArtist || artist)}|${norm(album)}`;

      if (artistKey) {
        if (!artists.has(artistKey)) artists.set(artistKey, { key: artistKey, name: artist || albumArtist, albumCount: 0, trackCount: 0, sampleFile: filePath });
        const ar = artists.get(artistKey);
        ar.trackCount += 1;
        if (!ar.sampleFile) ar.sampleFile = filePath;
      }

      if (album && albumKey !== '|') {
        if (!albums.has(albumKey)) {
          albums.set(albumKey, {
            key: albumKey,
            album,
            artist: albumArtist || artist,
            sampleFile: filePath,
            trackCount: 0,
            durationSec: 0,
            genre,
          });
          if (artistKey && artists.has(artistKey)) artists.get(artistKey).albumCount += 1;
        }
        const a = albums.get(albumKey);
        a.trackCount += 1;
        a.durationSec += durationSec;
        if (!a.sampleFile) a.sampleFile = filePath;
      }

      tracks.push({
        id: ++id,
        file: filePath,
        artist,
        albumArtist,
        album,
        title,
        track,
        trackNo: parseTrackNo(track),
        genre,
        durationSec,
        albumKey,
        artistKey,
        mbTrackId: String(mbTrackRaw || '').trim(),
        mbAlbumId: String(mbAlbumRaw || '').trim(),
        mbArtistId: String(mbArtistRaw || '').trim(),
        rating: 0,
      });
    }

    const index = {
      schema: 'now-playing.browse-index.v2',
      builtAt: new Date().toISOString(),
      dbUpdateAt,
      mpdHost: String(mpdHost || ''),
      counts: { artists: artists.size, albums: albums.size, tracks: tracks.length },
      artists: Array.from(artists.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      albums: Array.from(albums.values()).sort((a, b) => (`${a.artist} ${a.album}`).localeCompare(`${b.artist} ${b.album}`, undefined, { sensitivity: 'base' })),
      tracks,
    };

    await fsApi.mkdir(path.dirname(indexPath), { recursive: true });
    await fsApi.writeFile(indexPath, JSON.stringify(index), 'utf8');
    return index;
  }

  async function getBrowseIndex(mpdHost = 'moode.local', { force = false } = {}) {
    const host = String(mpdHost || 'moode.local');
    if (capabilities?.rehearsal) {
      if (force) throw new CapabilityDeniedError('browse-index.mpd-refresh');
      const index = await readRehearsalBrowseIndex({ fsApi, indexPath, rehearsalStateRoot });
      mem = { ts: now(), host, index, inflight: null, dbCheckTs: 0, dbUpdateIso: String(index.dbUpdateAt || '') };
      return index;
    }

    const timestamp = now();
    const sameHost = mem.host === host;

    // Fast memory return unless forced. Keep this very cheap.
    if (!force && mem.index && sameHost && (timestamp - mem.ts) < 60_000) return mem.index;
    if (mem.inflight) return mem.inflight;

    mem.inflight = (async () => {
      let idx = null;

      if (!force) {
        if (mem.index && sameHost) {
          idx = mem.index;
        } else {
          try {
            const raw = await fsApi.readFile(indexPath, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && (parsed.schema === 'now-playing.browse-index.v1' || parsed.schema === 'now-playing.browse-index.v2')) idx = parsed;
          } catch {}
        }
      }

      // Lightweight staleness check against MPD DB update time every ~30s.
      if (!force && idx) {
        const shouldCheckDb = !sameHost || (timestamp - Number(mem.dbCheckTs || 0)) > 30_000;
        if (shouldCheckDb) {
          const dbUpdateIso = await getMpdDbUpdateIso(host);
          const idxDb = String(idx?.dbUpdateAt || '').trim();
          const idxBuilt = String(idx?.builtAt || '').trim();
          const marker = idxDb || idxBuilt;

          if (dbUpdateIso && marker) {
            const dbMs = Date.parse(dbUpdateIso);
            const idxMs = Date.parse(marker);
            if (Number.isFinite(dbMs) && Number.isFinite(idxMs) && dbMs > idxMs) {
              idx = null; // stale; force rebuild below
            }
          }

          mem.dbCheckTs = now();
          mem.dbUpdateIso = dbUpdateIso || mem.dbUpdateIso || '';
        }
      }

      if (!idx) idx = await buildBrowseIndex(host);

      mem = {
        ts: now(),
        host,
        index: idx,
        inflight: null,
        dbCheckTs: mem.dbCheckTs || now(),
        dbUpdateIso: mem.dbUpdateIso || String(idx?.dbUpdateAt || ''),
      };

      return idx;
    })();

    try {
      return await mem.inflight;
    } finally {
      mem.inflight = null;
    }
  }

  return Object.freeze({ getBrowseIndex, buildBrowseIndex });
}

const defaultBrowseIndexAdapter = createBrowseIndexAdapter();

export function buildBrowseIndex(mpdHost = 'moode.local') {
  return defaultBrowseIndexAdapter.buildBrowseIndex(mpdHost);
}

export function getBrowseIndex(mpdHost = 'moode.local', options = {}) {
  return defaultBrowseIndexAdapter.getBrowseIndex(mpdHost, options);
}
