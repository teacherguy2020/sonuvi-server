import path from 'node:path';
import { isMusicLibraryTrack } from './music-library-counts.mjs';
import { createMobileTrackId } from './mobile-auth.mjs';
import { audioQualitySummaryForTracks, sourceAudioFromQuality } from './browse-index-quality.mjs';

function norm(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function clean(value) {
  return String(value || '').trim();
}

function parseTrackNumber(value) {
  const match = String(value || '').match(/^\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function extension(file) {
  return path.extname(String(file || '')).replace(/^\./, '').toLowerCase();
}

function isRemoteOrPseudoFile(file) {
  const value = clean(file).toLowerCase();
  return !value
    || /^https?:\/\//.test(value)
    || /^rtmp:|^rtsp:|^mms:|^spotify:|^airplay:|^upnp:/.test(value);
}

function safeQualityReason(value) {
  const reason = clean(value);
  return new Set([
    'not-yet-analyzed', 'source-revision-changed', 'source-unavailable',
    'probe-failed', 'unrecognized-audio',
  ]).has(reason) ? reason : null;
}

function publicAudioQuality(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const positive = (item) => Number.isInteger(Number(item)) && Number(item) > 0 ? Number(item) : null;
  const finite = (item) => Number.isFinite(Number(item)) && Number(item) >= 0 ? Number(item) : null;
  const revision = value.sourceRevision && typeof value.sourceRevision === 'object' && !Array.isArray(value.sourceRevision)
    ? {
      sizeBytes: positive(value.sourceRevision.sizeBytes),
      modifiedMs: finite(value.sourceRevision.modifiedMs),
      mpdLastModified: clean(value.sourceRevision.mpdLastModified) || null,
      probeVersion: positive(value.sourceRevision.probeVersion),
    }
    : null;
  return {
    status: clean(value.status) || 'pending',
    verificationStatus: clean(value.verificationStatus) || clean(value.status) || 'pending',
    reason: safeQualityReason(value.reason),
    provenance: clean(value.provenance) || 'library-maintenance',
    badgeEligibility: ['hi-res', 'lossless'].includes(clean(value.badgeEligibility)) ? clean(value.badgeEligibility) : 'none',
    codec: clean(value.codec) || null,
    codecKind: ['lossless', 'lossy', 'unknown'].includes(clean(value.codecKind)) ? clean(value.codecKind) : 'unknown',
    container: clean(value.container) || null,
    bitDepth: positive(value.bitDepth),
    bitDepthStatus: clean(value.bitDepthStatus) || null,
    sampleRateHz: positive(value.sampleRateHz),
    channels: positive(value.channels),
    encodedBitrateBps: positive(value.encodedBitrateBps),
    encodedBitrateStatus: clean(value.encodedBitrateStatus) || null,
    encodedBitrateProvenance: clean(value.encodedBitrateProvenance) || null,
    ...(clean(value.verifiedAt) ? { verifiedAt: clean(value.verifiedAt) } : {}),
    ...(clean(value.retryAfter) ? { retryAfter: clean(value.retryAfter) } : {}),
    ...(revision ? { sourceRevision: revision } : {}),
  };
}

function publicAlbumAudioQuality(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nonNegative = (item) => Number.isInteger(Number(item)) && Number(item) >= 0 ? Number(item) : 0;
  return {
    trackCount: nonNegative(value.trackCount),
    verifiedTrackCount: nonNegative(value.verifiedTrackCount),
    pendingTrackCount: nonNegative(value.pendingTrackCount),
    failedTrackCount: nonNegative(value.failedTrackCount),
    lossyTrackCount: nonNegative(value.lossyTrackCount),
    losslessTrackCount: nonNegative(value.losslessTrackCount),
    hiResTrackCount: nonNegative(value.hiResTrackCount),
    unknownTrackCount: nonNegative(value.unknownTrackCount),
    verificationStatus: clean(value.verificationStatus) || 'incomplete',
    badgeEligibility: ['hi-res', 'lossless'].includes(clean(value.badgeEligibility)) ? clean(value.badgeEligibility) : 'none',
  };
}

function albumIdentity(track) {
  const mbAlbumId = clean(track?.mbAlbumId);
  const file = clean(track?.file);
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : file;
  if (mbAlbumId) return `mbalbum:${mbAlbumId}|folder:${norm(folder)}`;

  // The parent folder remains server-side and differentiates duplicate
  // masterings/editions that share artist and album tags.
  return [
    'album',
    norm(track?.albumArtist || track?.artist),
    norm(track?.album),
    norm(folder),
  ].join('|');
}

function artistIdentity(track) {
  const mbArtistId = clean(track?.mbArtistId);
  if (mbArtistId) return `mbartist:${mbArtistId}`;
  return `artist:${norm(track?.albumArtist || track?.artist)}`;
}

function trackIdentity(track) {
  const mbTrackId = clean(track?.mbTrackId);
  if (mbTrackId) return `mbtrack:${mbTrackId}|album:${albumIdentity(track)}`;

  return [
    'track',
    clean(track?.file),
    norm(track?.artist),
    norm(track?.albumArtist),
    norm(track?.album),
    norm(track?.title),
    parseTrackNumber(track?.track),
  ].join('|');
}

function trackSort(a, b) {
  const album = `${norm(a?.albumArtist || a?.artist)}|${norm(a?.album)}`
    .localeCompare(`${norm(b?.albumArtist || b?.artist)}|${norm(b?.album)}`);
  if (album) return album;
  const trackNo = parseTrackNumber(a?.track) - parseTrackNumber(b?.track);
  if (trackNo) return trackNo;
  return norm(a?.title).localeCompare(norm(b?.title));
}

export function buildMobileCatalog(index, { trackIdSecret } = {}) {
  const secret = String(trackIdSecret || '');
  if (!secret) throw new Error('mobile track ID secret is not configured');

  const rows = Array.isArray(index?.tracks) ? index.tracks : [];
  const tracks = [];
  const musicTrackIDs = new Set();
  const byTrackId = new Map();
  const byFile = new Map();
  const albumsById = new Map();
  const artistsById = new Map();

  for (const source of rows) {
    const file = clean(source?.file);
    if (isRemoteOrPseudoFile(file)) continue;

    const trackId = createMobileTrackId({ secret, trackIdentity: trackIdentity(source) });
    const albumId = createMobileTrackId({ secret, trackIdentity: albumIdentity(source) }).replace(/^trk_/, 'alb_');
    const artistId = createMobileTrackId({ secret, trackIdentity: artistIdentity(source) }).replace(/^trk_/, 'art_');
    const indexedSourceAudio = sourceAudioFromQuality(source?.audioQuality);
    const record = {
      id: trackId,
      albumId,
      artistId,
      title: clean(source?.title),
      artist: clean(source?.artist || source?.albumArtist),
      albumArtist: clean(source?.albumArtist || source?.artist),
      album: clean(source?.album),
      trackNumber: parseTrackNumber(source?.track),
      track: clean(source?.track),
      genre: clean(source?.genre),
      durationSec: Number(source?.durationSec || 0) || 0,
      ...(source?.audioQuality && typeof source.audioQuality === 'object'
        ? { audioQuality: source.audioQuality }
        : {}),
      ...(source?.sourceAudio && typeof source.sourceAudio === 'object'
        ? { sourceAudio: source.sourceAudio }
        : (indexedSourceAudio ? { sourceAudio: indexedSourceAudio } : {})),
      format: extension(file),
      musicBrainz: {
        trackId: clean(source?.mbTrackId),
        albumId: clean(source?.mbAlbumId),
        artistId: clean(source?.mbArtistId),
      },
      file,
    };

    tracks.push(record);
    if (isMusicLibraryTrack(source)) musicTrackIDs.add(record.id);
    byTrackId.set(trackId, record);
    byFile.set(file, record);

    if (!albumsById.has(albumId)) {
      albumsById.set(albumId, {
        id: albumId,
        album: record.album,
        artist: record.albumArtist || record.artist,
        artistId,
        genre: record.genre,
        durationSec: 0,
        trackIds: [],
      });
    }
    const album = albumsById.get(albumId);
    album.durationSec += record.durationSec;
    album.trackIds.push(trackId);

    if (!artistsById.has(artistId)) {
      artistsById.set(artistId, {
        id: artistId,
        artist: record.albumArtist || record.artist,
        albumIds: new Set(),
        trackCount: 0,
      });
    }
    const artist = artistsById.get(artistId);
    artist.albumIds.add(albumId);
    artist.trackCount += 1;
  }

  tracks.sort(trackSort);

  const albums = Array.from(albumsById.values())
    .map((album) => ({
      ...album,
      trackIds: album.trackIds.sort((a, b) => (byTrackId.get(a)?.trackNumber || 0) - (byTrackId.get(b)?.trackNumber || 0)),
      trackCount: album.trackIds.length,
      audioQuality: audioQualitySummaryForTracks(album.trackIds.map((trackId) => byTrackId.get(trackId)).filter(Boolean)),
    }))
    .sort((a, b) => `${a.artist}|${a.album}`.localeCompare(`${b.artist}|${b.album}`));

  const artists = Array.from(artistsById.values())
    .map((artist) => ({ ...artist, albumIds: Array.from(artist.albumIds).sort() }))
    .sort((a, b) => norm(a.artist).localeCompare(norm(b.artist)));

  const musicTracks = tracks.filter(track => musicTrackIDs.has(track.id));
  return {
    builtAt: String(index?.builtAt || ''),
    counts: { tracks: musicTracks.length,
      albums: new Set(musicTracks.map(track => track.albumId)).size,
      artists: new Set(musicTracks.map(track => track.artistId)).size },
    tracks,
    albums,
    artists,
    byTrackId,
    byFile,
    byAlbumId: new Map(albums.map((album) => [album.id, album])),
    byArtistId: new Map(artists.map((artist) => [artist.id, artist])),
  };
}

export function publicMobileTrack(record, { baseUrl = '' } = {}) {
  if (!record) return null;
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return {
    id: record.id,
    title: record.title,
    artist: record.artist,
    albumArtist: record.albumArtist,
    album: record.album,
    albumId: record.albumId,
    artistId: record.artistId,
    trackNumber: record.trackNumber,
    genre: record.genre,
    durationSec: record.durationSec,
    ...(publicAudioQuality(record.audioQuality) ? { audioQuality: publicAudioQuality(record.audioQuality) } : {}),
    ...(record.sourceAudio ? { sourceAudio: record.sourceAudio } : {}),
    format: record.format,
    musicBrainz: record.musicBrainz,
    availability: { remote: true, local: false },
    artworkUrl: `${root}/v1/mobile/artwork/${encodeURIComponent(record.id)}`,
  };
}

export function publicMobileAlbum(album, catalog, { baseUrl = '' } = {}) {
  if (!album) return null;
  const firstTrack = catalog?.byTrackId?.get(album.trackIds?.[0]);
  return {
    id: album.id,
    album: album.album,
    artist: album.artist,
    artistId: album.artistId,
    genre: album.genre,
    durationSec: album.durationSec,
    trackCount: album.trackCount,
    ...(publicAlbumAudioQuality(album.audioQuality) ? { audioQuality: publicAlbumAudioQuality(album.audioQuality) } : {}),
    addedAt: Number.isFinite(Number(album.addedAt)) && Number(album.addedAt) > 0
      ? Number(album.addedAt)
      : null,
    artworkUrl: firstTrack
      ? `${String(baseUrl || '').replace(/\/+$/, '')}/v1/mobile/artwork/${encodeURIComponent(firstTrack.id)}`
      : '',
  };
}

export function publicMobileArtist(artist) {
  if (!artist) return null;
  return {
    id: artist.id,
    artist: artist.artist,
    albumCount: artist.albumIds?.length || 0,
    trackCount: artist.trackCount || 0,
  };
}

// Queue positions and MPD song IDs are mutable/server-side details. The
// native client gets an opaque handle for the current queue snapshot and
// sends that handle back for mutations; it never receives the MPD file path.
export function createMobileQueueItemId({ secret, file, songId, position } = {}) {
  const normalizedSongId = Number.isSafeInteger(Number(songId)) ? Number(songId) : 0;
  const normalizedPosition = Number.isSafeInteger(Number(position)) ? Number(position) : 0;
  const identity = `queue:${normalizedSongId}:${normalizedPosition}:${String(file || '')}`;
  return createMobileTrackId({ secret, trackIdentity: identity }).replace(/^trk_/, 'que_');
}
