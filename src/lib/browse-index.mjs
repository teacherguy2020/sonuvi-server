import fs from 'node:fs/promises';
import { musicLibraryCounts } from './music-library-counts.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeStatePaths } from './runtime-state-paths.mjs';
import { CapabilityDeniedError, runtimeCapabilities } from './runtime-capabilities.mjs';
import { mpdQueryRawAt } from '../services/mpd.service.mjs';
import {
  audioQualityIndexCounts,
  audioQualityNeedsEnrichment,
  audioQualitySummaryForTracks,
  failedAudioQuality,
  pendingAudioQuality,
  verifiedAudioQuality,
} from './browse-index-quality.mjs';

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
export function createEmptyBrowseIndex({ mpdHost = '', builtAt = new Date().toISOString() } = {}) {
  return Object.freeze({
    schema: 'now-playing.browse-index.v2', builtAt: String(builtAt), dbUpdateAt: '', mpdHost: String(mpdHost || ''),
    counts: Object.freeze({ artists: 0, albums: 0, tracks: 0 }), artists: Object.freeze([]), albums: Object.freeze([]), tracks: Object.freeze([]),
  });
}


function browseIndexStatus(index, { available = true, source = 'memory', refreshing = false } = {}) { const counts = musicLibraryCounts(index?.tracks) || {}; return Object.freeze({ available: Boolean(available), source: available ? source : 'unavailable', builtAt: String(index?.builtAt || '') || null, dbUpdateAt: String(index?.dbUpdateAt || '') || null, counts: { artists: Number.isFinite(Number(counts.artists)) ? Math.max(0, Number(counts.artists)) : null, albums: Number.isFinite(Number(counts.albums)) ? Math.max(0, Number(counts.albums)) : null, tracks: Number.isFinite(Number(counts.tracks)) ? Math.max(0, Number(counts.tracks)) : null }, refresh: { running: Boolean(refreshing) } }); }
function norm(s = '') {
  return String(s || '').trim().toLowerCase();
}

function parseTrackNo(track = '') {
  const n = Number.parseInt(String(track || '').replace(/[^0-9].*$/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseMpdFileRevisions(raw) {
  const revisions = new Map();
  let file = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'file') {
      file = value;
      continue;
    }
    if (key !== 'last-modified' || !file) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) revisions.set(file, new Date(parsed).toISOString());
  }
  return revisions;
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
      && (index.schema === 'now-playing.browse-index.v2' || index.schema === 'now-playing.browse-index.v3')
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
  getAudioQualityRecord = null,
  qualityBatchSize = 24,
  qualityBatchDelayMs = 1_000,
  schedule = setTimeout,
  mpdPort = 6600,
  readMpdRaw = mpdQueryRawAt,
} = {}) {
  const indexPath = String(statePaths?.browseIndexPath || '').trim();
  if (!indexPath || !path.isAbsolute(indexPath)) throw new Error('browse index path must be absolute');
  let mem = { ts: 0, host: '', index: null, inflight: null, dbCheckTs: 0, dbUpdateIso: '' };
  const qualityRecord = typeof getAudioQualityRecord === 'function' ? getAudioQualityRecord : null;
  const boundedBatchSize = Math.max(1, Math.min(100, Number(qualityBatchSize) || 24));
  const boundedBatchDelayMs = Math.max(100, Math.min(60_000, Number(qualityBatchDelayMs) || 1_000));
  let qualityTimer = null;
  let qualityRunning = false;

  const isoNow = () => new Date(Number(now())).toISOString();

  async function writeIndex(index) {
    await fsApi.mkdir(path.dirname(indexPath), { recursive: true });
    const temporary = indexPath + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
    await fsApi.writeFile(temporary, JSON.stringify(index) + '\n', 'utf8');
    await fsApi.rename(temporary, indexPath);
  }

  async function readPersistedIndex() {
    try {
      const parsed = JSON.parse(await fsApi.readFile(indexPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function qualityForRebuiltTrack(previousQuality, mpdLastModified) {
    const previous = previousQuality && typeof previousQuality === 'object' && !Array.isArray(previousQuality)
      ? previousQuality
      : null;
    const previousRevision = previous?.sourceRevision && typeof previous.sourceRevision === 'object'
      ? previous.sourceRevision
      : null;
    const oldMpdModified = String(previousRevision?.mpdLastModified || '').trim();
    if (previous && (!mpdLastModified || (oldMpdModified && oldMpdModified === mpdLastModified))) return previous;
    return pendingAudioQuality({
      sourceRevision: mpdLastModified ? { mpdLastModified } : null,
      reason: previous ? 'source-revision-changed' : 'not-yet-analyzed',
    });
  }

  function refreshQualityMetadata(index) {
    const tracks = Array.isArray(index?.tracks) ? index.tracks : [];
    const byAlbum = new Map();
    for (const track of tracks) {
      const key = String(track?.albumKey || '').trim();
      if (!key) continue;
      if (!byAlbum.has(key)) byAlbum.set(key, []);
      byAlbum.get(key).push(track);
    }
    for (const album of Array.isArray(index?.albums) ? index.albums : []) {
      album.audioQuality = audioQualitySummaryForTracks(byAlbum.get(String(album?.key || '')) || []);
    }
    const counts = audioQualityIndexCounts(tracks);
    index.audioQuality = {
      contract: 'now-playing.browse-index.audio-quality.v1',
      ...counts,
      updatedAt: isoNow(),
    };
    index.qualityMaintenance = {
      contract: 'now-playing.browse-index-quality-maintenance.v1',
      pendingTracks: counts.pendingTracks,
      failedTracks: counts.failedTracks,
      batchSize: boundedBatchSize,
      updatedAt: isoNow(),
    };
    return counts;
  }

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

  async function getMpdFileRevisions(mpdHost = 'moode.local') {
    try {
      const raw = await readMpdRaw('listallinfo', {
        host: String(mpdHost || 'moode.local'),
        port: Number(mpdPort) || 6600,
        timeoutMs: 60_000,
      });
      return parseMpdFileRevisions(raw);
    } catch {
      return new Map();
    }
  }

  async function buildBrowseIndex(mpdHost = 'moode.local', { previousIndex = null } = {}) {
    if (capabilities?.rehearsal) throw new CapabilityDeniedError('browse-index.mpd-refresh');
    const [dbUpdateAt, fileRevisions] = await Promise.all([
      getMpdDbUpdateIso(mpdHost),
      getMpdFileRevisions(mpdHost),
    ]);
    const fmt = '%file%\t%artist%\t%albumartist%\t%album%\t%title%\t%track%\t%genre%\t%time%\t%MUSICBRAINZ_TRACKID%\t%MUSICBRAINZ_ALBUMID%\t%MUSICBRAINZ_ARTISTID%';
    const { stdout } = await runExecFile('mpc', ['-h', String(mpdHost || 'moode.local'), '-f', fmt, 'listall'], {
      maxBuffer: 96 * 1024 * 1024,
    });
    const previousByFile = new Map((Array.isArray(previousIndex?.tracks) ? previousIndex.tracks : [])
      .map((track) => [String(track?.file || '').trim(), track?.audioQuality])
      .filter(([file]) => file));

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
      const mpdLastModified = String(fileRevisions.get(filePath) || '').trim();

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
        ...(mpdLastModified ? { mpdLastModified } : {}),
        audioQuality: qualityForRebuiltTrack(previousByFile.get(filePath), mpdLastModified),
        rating: 0,
      });
    }

    const index = {
      schema: 'now-playing.browse-index.v3',
      builtAt: isoNow(),
      dbUpdateAt,
      mpdHost: String(mpdHost || ''),
      counts: { artists: artists.size, albums: albums.size, tracks: tracks.length },
      artists: Array.from(artists.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      albums: Array.from(albums.values()).sort((a, b) => (`${a.artist} ${a.album}`).localeCompare(`${b.artist} ${b.album}`, undefined, { sensitivity: 'base' })),
      tracks,
    };

    refreshQualityMetadata(index);
    await writeIndex(index);
    return index;
  }

  async function runQualityBatch(mpdHost = 'moode.local', { limit = boundedBatchSize } = {}) {
    if (capabilities?.rehearsal || !qualityRecord) return { processed: 0, remaining: 0, counts: null };
    const host = String(mpdHost || 'moode.local');
    const index = await getBrowseIndex(host);
    if (index?.schema !== 'now-playing.browse-index.v3') return { processed: 0, remaining: 0, counts: null };
    const budget = Math.max(1, Math.min(boundedBatchSize, Number(limit) || boundedBatchSize));
    const candidates = (Array.isArray(index.tracks) ? index.tracks : [])
      .filter((track) => audioQualityNeedsEnrichment(track?.audioQuality, now()))
      .slice(0, budget);
    if (!candidates.length) return { processed: 0, remaining: 0, counts: index.audioQuality || null };

    const changedAlbums = new Set();
    for (const track of candidates) {
      let result;
      try {
        result = await qualityRecord(track.file);
      } catch {
        result = { status: 'failed', reason: 'probe-failed' };
      }
      const sourceRevision = {
        ...(result?.sourceRevision && typeof result.sourceRevision === 'object' ? result.sourceRevision : {}),
        ...(track.mpdLastModified ? { mpdLastModified: track.mpdLastModified } : {}),
      };
      track.audioQuality = result?.status === 'verified'
        ? verifiedAudioQuality({ sourceAudio: result.sourceAudio, sourceRevision, verifiedAt: isoNow() })
        : failedAudioQuality({ sourceRevision, reason: String(result?.reason || 'probe-failed'), retryAfter: result?.retryAfter });
      changedAlbums.add(String(track.albumKey || ''));
    }

    const tracksByAlbum = new Map();
    for (const track of index.tracks) {
      const key = String(track?.albumKey || '');
      if (!changedAlbums.has(key)) continue;
      if (!tracksByAlbum.has(key)) tracksByAlbum.set(key, []);
      tracksByAlbum.get(key).push(track);
    }
    for (const album of index.albums) {
      const key = String(album?.key || '');
      if (changedAlbums.has(key)) album.audioQuality = audioQualitySummaryForTracks(tracksByAlbum.get(key) || []);
    }
    const counts = refreshQualityMetadata(index);
    await writeIndex(index);
    mem = { ...mem, ts: now(), host, index };
    return { processed: candidates.length, remaining: counts.pendingTracks, counts };
  }

  function scheduleQualityEnrichment(mpdHost) {
    if (capabilities?.rehearsal || !qualityRecord || qualityTimer || qualityRunning) return;
    qualityTimer = schedule(async () => {
      qualityTimer = null;
      qualityRunning = true;
      let shouldContinue = false;
      try {
        const result = await runQualityBatch(mpdHost);
        shouldContinue = Number(result?.remaining || 0) > 0;
      } catch {
        // A later browse/index refresh retries; browsing itself remains read-only.
      } finally {
        qualityRunning = false;
      }
      if (shouldContinue) scheduleQualityEnrichment(mpdHost);
    }, boundedBatchDelayMs);
    qualityTimer?.unref?.();
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
    if (!force && mem.index && sameHost && (timestamp - mem.ts) < 60_000) {
      scheduleQualityEnrichment(host);
      return mem.index;
    }
    if (mem.inflight) return mem.inflight;

    mem.inflight = (async () => {
      let idx = null;
      let previousIndex = null;

      if (!force) {
        if (mem.index && sameHost) {
          idx = mem.index;
        } else {
          try {
            const raw = await fsApi.readFile(indexPath, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed?.schema === 'now-playing.browse-index.v3') idx = parsed;
            if (parsed?.schema === 'now-playing.browse-index.v2' && Array.isArray(parsed.tracks)) {
              idx = { ...parsed, schema: 'now-playing.browse-index.v3', tracks: parsed.tracks.map((track) => ({ ...track, audioQuality: track?.audioQuality || pendingAudioQuality() })) };
              refreshQualityMetadata(idx);
              await writeIndex(idx);
            }
          } catch {}
        }
      }
      if (idx) previousIndex = idx;

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
              previousIndex = idx;
              idx = null; // stale; force rebuild below
            }
          }

          mem.dbCheckTs = now();
          mem.dbUpdateIso = dbUpdateIso || mem.dbUpdateIso || '';
        }
      }

      if (!idx) {
        if (!previousIndex) previousIndex = await readPersistedIndex();
        idx = await buildBrowseIndex(host, { previousIndex });
      }

      mem = {
        ts: now(),
        host,
        index: idx,
        inflight: null,
        dbCheckTs: mem.dbCheckTs || now(),
        dbUpdateIso: mem.dbUpdateIso || String(idx?.dbUpdateAt || ''),
      };

      scheduleQualityEnrichment(host);
      return idx;
    })();

    try {
      return await mem.inflight;
    } finally {
      mem.inflight = null;
    }
  }

  async function getBrowseIndexStatus(mpdHost = 'moode.local') {
    if (capabilities?.rehearsal) { try { return browseIndexStatus(await readRehearsalBrowseIndex({ fsApi, indexPath, rehearsalStateRoot }), { source: 'rehearsal-fixture', refreshing: Boolean(mem.inflight) }); } catch { return browseIndexStatus(null, { available: false, refreshing: Boolean(mem.inflight) }); } }
    const host = String(mpdHost || 'moode.local'); const index = mem.host === host ? mem.index : await readPersistedIndex();
    return browseIndexStatus(index, { available: Boolean(index), source: mem.host === host && mem.index ? 'memory' : 'persisted', refreshing: Boolean(mem.inflight) });
  }
  return Object.freeze({ getBrowseIndex, buildBrowseIndex, runQualityBatch, getBrowseIndexStatus });
}

let defaultBrowseIndexAdapter = createBrowseIndexAdapter();

export function configureBrowseIndexQuality(options = {}) {
  defaultBrowseIndexAdapter = createBrowseIndexAdapter(options);
  return defaultBrowseIndexAdapter;
}

export function buildBrowseIndex(mpdHost = 'moode.local') {
  return defaultBrowseIndexAdapter.buildBrowseIndex(mpdHost);
}

export function getBrowseIndex(mpdHost = 'moode.local', options = {}) {
  return defaultBrowseIndexAdapter.getBrowseIndex(mpdHost, options);
}

export function getBrowseIndexStatus(mpdHost = 'moode.local') {
  return defaultBrowseIndexAdapter.getBrowseIndexStatus(mpdHost);
}
