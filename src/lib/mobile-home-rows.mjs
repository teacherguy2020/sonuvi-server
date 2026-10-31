import {
  publicMobileAlbum,
  publicMobileArtist,
  publicMobileTrack,
} from './mobile-track-identity.mjs';

export const MOBILE_HOME_ROW_IDS = Object.freeze([
  'albums',
  'playlists',
  'podcasts',
  'radio',
  'queue',
  'lastfm-topalbums',
  'lastfm-topartists',
  'lastfm-toptracks',
  'lastfm-recenttracks',
  'local-topalbums',
  'local-topartists',
  'local-toptracks',
  'local-recenttracks',
]);

const DEFAULT_RECENT_ROWS = ['albums', 'playlists', 'podcasts', 'radio'];

const ROW_DEFINITIONS = Object.freeze({
  albums: { title: 'Recently Added Albums', provider: 'now-playing', kind: 'album' },
  playlists: { title: 'Recent Playlists', provider: 'now-playing', kind: 'playlist' },
  podcasts: { title: 'Recent Podcasts', provider: 'now-playing', kind: 'podcast' },
  radio: { title: 'Favorite Radio Stations', provider: 'now-playing', kind: 'radio' },
  queue: { title: 'Live Queue', provider: 'now-playing', kind: 'track' },
  'lastfm-topalbums': { title: 'Top Albums', provider: 'lastfm', kind: 'album' },
  'lastfm-topartists': { title: 'Top Artists', provider: 'lastfm', kind: 'artist' },
  'lastfm-toptracks': { title: 'Top Tracks', provider: 'lastfm', kind: 'track' },
  'lastfm-recenttracks': { title: 'Recently Played', provider: 'lastfm', kind: 'track' },
  'local-topalbums': { title: 'Local Top Albums', provider: 'local-history', kind: 'album' },
  'local-topartists': { title: 'Local Top Artists', provider: 'local-history', kind: 'artist' },
  'local-toptracks': { title: 'Local Top Tracks', provider: 'local-history', kind: 'track' },
  'local-recenttracks': { title: 'Local Recently Played', provider: 'local-history', kind: 'track' },
});

function text(value) {
  return String(value || '').trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase();
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

export function sanitizeMobileHomeProfile(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const requested = Array.isArray(source.recentRows)
    ? source.recentRows.map((value) => normalized(value)).filter(Boolean)
    : [];
  const recentRows = [];
  for (const row of requested) {
    if (!MOBILE_HOME_ROW_IDS.includes(row) || recentRows.includes(row)) continue;
    recentRows.push(row);
    if (recentRows.length >= 4) break;
  }
  for (const row of DEFAULT_RECENT_ROWS) {
    if (recentRows.length >= 4) break;
    if (!recentRows.includes(row)) recentRows.push(row);
  }

  const recentCount = Math.max(6, Math.min(30, integer(source.recentCount, 18)));
  return {
    devicePreset: text(source.devicePreset) || 'mobile',
    theme: text(source.theme) || 'auto',
    layout: text(source.layout) || 'home-rail',
    showRecent: source.showRecent !== false,
    recentCount,
    recentRows,
    colorPreset: text(source.colorPreset) || 'ocean',
  };
}

/// Orders Home rows so the four profile-selected shelves stay at the front,
/// while every other supported source remains discoverable below them.
export function orderedMobileHomeRowIDs(profile = {}) {
  const selected = sanitizeMobileHomeProfile(profile).recentRows;
  return [
    ...selected,
    ...MOBILE_HOME_ROW_IDS.filter((row) => !selected.includes(row)),
  ];
}

export function mobileHomeRowDefinition(source) {
  return ROW_DEFINITIONS[text(source).toLocaleLowerCase()] || null;
}

export function mobileHomeSourcePath(source, limit = 18) {
  const row = text(source).toLocaleLowerCase();
  const safeLimit = Math.max(1, Math.min(30, integer(limit, 18)));
  const paths = {
    albums: `/recent/albums?limit=${safeLimit}`,
    playlists: `/recent/playlists?limit=${safeLimit}`,
    podcasts: `/recent/podcasts?limit=${safeLimit}`,
    radio: `/recent/radio-favorites?limit=${safeLimit}`,
    'lastfm-topalbums': `/config/lastfm/top-albums?limit=${safeLimit}`,
    'lastfm-topartists': `/config/lastfm/top-artists?limit=${safeLimit}`,
    'lastfm-toptracks': `/config/lastfm/top-tracks?limit=${safeLimit}`,
    'lastfm-recenttracks': `/config/lastfm/recent-tracks?limit=${safeLimit}`,
    'local-topalbums': `/config/listening-history/top-albums?limit=${safeLimit}`,
    'local-topartists': `/config/listening-history/top-artists?limit=${safeLimit}`,
    'local-toptracks': `/config/listening-history/top-tracks?limit=${safeLimit}`,
    'local-recenttracks': `/config/listening-history/recent-tracks?limit=${safeLimit}`,
  };
  return paths[row] || '';
}

function sourceItems(payload, source) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : (Array.isArray(payload?.favorites) ? payload.favorites : []);
  if (source !== 'queue') return items;

  // The Home shelf is the upcoming portion of Live Queue. The full queue
  // remains available from the dedicated Live Queue destination.
  return items.filter((item) => {
    if (item?.isCurrent === true) return false;
    if (Number.isFinite(payload?.headPos) && Number.isFinite(item?.position)) {
      return item.position > payload.headPos;
    }
    return true;
  });
}

function remoteArtwork(raw, { baseUrl, artworkUrlFor }) {
  const value = text(raw);
  if (!value || typeof artworkUrlFor !== 'function') return null;
  let reference = value;
  try {
    reference = new URL(value, `${String(baseUrl || '').replace(/\/+$/, '')}/`).toString();
  } catch {}
  return artworkUrlFor({ kind: 'remote', reference });
}

function itemId(makeItemId, source, kind, identity, fallback) {
  if (typeof makeItemId === 'function') return makeItemId({ source, kind, identity });
  return `${source}:${kind}:${identity || fallback || 'item'}`;
}

function catalogAlbumFor(catalog, { catalogTrack, album, artist } = {}) {
  if (catalogTrack?.albumId) {
    const direct = catalog?.byAlbumId?.get(catalogTrack.albumId);
    if (direct) return direct;
  }

  const albumName = normalized(album);
  if (!albumName) return null;
  const artistName = normalized(artist);
  const albums = Array.from(catalog?.albums || []);
  return albums.find((candidate) => (
    normalized(candidate.album) === albumName
    && (!artistName || normalized(candidate.artist) === artistName)
  )) || albums.find((candidate) => normalized(candidate.album) === albumName) || null;
}

function catalogArtistFor(catalog, { catalogTrack, artist } = {}) {
  if (catalogTrack?.artistId) {
    const direct = catalog?.byArtistId?.get(catalogTrack.artistId);
    if (direct) return direct;
  }

  const artistName = normalized(artist);
  if (!artistName) return null;
  return Array.from(catalog?.artists || []).find((candidate) => (
    normalized(candidate.artist) === artistName
  )) || null;
}

function catalogTrackFor(catalog, { catalogTrack, title, artist, album } = {}) {
  if (catalogTrack) return catalogTrack;

  const titleName = normalized(title);
  const artistName = normalized(artist);
  const albumName = normalized(album);
  if (!titleName || !artistName) return null;
  const tracks = Array.from(catalog?.tracks || []);
  return tracks.find((candidate) => (
    normalized(candidate.title) === titleName
    && normalized(candidate.artist || candidate.albumArtist) === artistName
    && (!albumName || normalized(candidate.album) === albumName)
  )) || tracks.find((candidate) => (
    normalized(candidate.title) === titleName
    && normalized(candidate.artist || candidate.albumArtist) === artistName
  )) || null;
}

function firstCatalogTrack(catalog, artist) {
  return artist?.albumIds
    ?.flatMap((albumId) => catalog?.byAlbumId?.get(albumId)?.trackIds || [])
    .map((trackId) => catalog?.byTrackId?.get(trackId))
    .find(Boolean) || null;
}

function trackItem({ source, provider, raw, catalog, baseUrl, makeItemId, artworkUrlFor, index }) {
  const file = text(raw?.file);
  const fileTrack = file ? catalog?.byFile?.get(file) : null;
  const sourceTitle = text(raw?.title || raw?.track);
  const sourceArtist = text(raw?.artist);
  const sourceAlbum = text(raw?.album);
  const catalogTrack = catalogTrackFor(catalog, {
    catalogTrack: fileTrack,
    title: sourceTitle,
    artist: sourceArtist,
    album: sourceAlbum,
  });
  const track = catalogTrack ? publicMobileTrack(catalogTrack, { baseUrl }) : null;
  const artist = text(catalogTrack?.artist || sourceArtist);
  const album = text(catalogTrack?.album || sourceAlbum);
  const albumRecord = catalogAlbumFor(catalog, {
    catalogTrack,
    album,
    artist: text(catalogTrack?.albumArtist || raw?.albumArtist || artist),
  });
  const albumItem = albumRecord ? publicMobileAlbum(albumRecord, catalog, { baseUrl }) : null;
  const title = text(catalogTrack?.title || sourceTitle) || '(track)';
  const art = track?.artworkUrl
    || text(raw?.artworkUrl)
    || remoteArtwork(raw?.art, { baseUrl, artworkUrlFor });
  const identity = text(raw?.id) || catalogTrack?.id || `${artist}|${title}|${album}|${file}`;
  return {
    id: itemId(makeItemId, source, 'track', identity, index),
    kind: 'track',
    title,
    subtitle: [artist, album].filter(Boolean).join(' · '),
    artist,
    album,
    provider,
    source,
    // The Home row ID is a display/navigation identity. Queue rows also
    // carry the server-issued queue handle so native actions can mutate the
    // exact queued instance without guessing from the catalog track ID.
    queueItemId: source === 'queue' ? (text(raw?.id) || null) : null,
    artworkUrl: art,
    track,
    albumItem,
    artistItem: null,
    playlist: null,
    podcastId: null,
    radioStationName: null,
  };
}

function albumItem({ source, provider, raw, catalog, baseUrl, makeItemId, artworkUrlFor, index }) {
  const file = text(raw?.file);
  const catalogTrack = file ? catalog?.byFile?.get(file) : null;
  const albumName = text(raw?.album || raw?.title);
  const artistName = text(raw?.artist || raw?.albumArtist);
  const albumRecord = catalogAlbumFor(catalog, {
    catalogTrack,
    album: text(catalogTrack?.album || albumName),
    artist: text(catalogTrack?.albumArtist || artistName),
  });
  const album = albumRecord ? publicMobileAlbum(albumRecord, catalog, { baseUrl }) : null;
  const title = text(album?.album || albumName) || '(album)';
  const artist = text(album?.artist || artistName);
  const art = album?.artworkUrl || remoteArtwork(raw?.art, { baseUrl, artworkUrlFor });
  const identity = album?.id || `${artist}|${title}|${file}`;
  return {
    id: itemId(makeItemId, source, 'album', identity, index),
    kind: 'album',
    title,
    subtitle: artist,
    artist,
    album: title,
    provider,
    source,
    artworkUrl: art,
    track: null,
    albumItem: album,
    artistItem: null,
    playlist: null,
    podcastId: null,
    radioStationName: null,
  };
}

function artistItem({ source, provider, raw, catalog, baseUrl, makeItemId, artworkUrlFor, index }) {
  const file = text(raw?.file);
  const catalogTrack = file ? catalog?.byFile?.get(file) : null;
  const requestedArtist = text(raw?.artist || raw?.artistName || raw?.name || raw?.title);
  const artistRecord = catalogArtistFor(catalog, {
    catalogTrack,
    artist: text(catalogTrack?.albumArtist || requestedArtist),
  });
  const artist = artistRecord ? publicMobileArtist(artistRecord) : null;
  const artistTrack = catalogTrack || firstCatalogTrack(catalog, artistRecord);
  const title = text(artist?.artist || requestedArtist) || '(artist)';
  const art = artistTrack
    ? `${String(baseUrl || '').replace(/\/+$/, '')}/v1/mobile/artwork/${encodeURIComponent(artistTrack.id)}`
    : remoteArtwork(raw?.art, { baseUrl, artworkUrlFor });
  const identity = artist?.id || title;
  return {
    id: itemId(makeItemId, source, 'artist', identity, index),
    kind: 'artist',
    title,
    subtitle: artist ? `${artist.albumCount} albums · ${artist.trackCount} tracks` : '',
    artist: title,
    album: '',
    provider,
    source,
    artworkUrl: art,
    track: null,
    albumItem: null,
    artistItem: artist,
    playlist: null,
    podcastId: null,
    radioStationName: null,
  };
}

function playlistItem({ source, provider, raw, playlistByName, baseUrl, makeItemId, artworkUrlFor, index }) {
  const name = text(raw?.playlist || raw?.title);
  const playlist = playlistByName.get(normalized(name)) || null;
  const art = playlist?.artworkUrl || remoteArtwork(raw?.art, { baseUrl, artworkUrlFor });
  const identity = playlist?.id || name;
  return {
    id: itemId(makeItemId, source, 'playlist', identity, index),
    kind: 'playlist',
    title: text(playlist?.name || name) || '(playlist)',
    subtitle: playlist ? `${playlist.trackCount} tracks` : '',
    artist: '',
    album: '',
    provider,
    source,
    artworkUrl: art,
    track: null,
    albumItem: null,
    artistItem: null,
    playlist,
    podcastId: null,
    radioStationName: null,
  };
}

function podcastItem({ source, provider, raw, baseUrl, makeItemId, artworkUrlFor, podcastIdFor, index }) {
  const title = text(raw?.title || raw?.name || raw?.rss) || '(podcast)';
  const rss = text(raw?.rss);
  const podcastId = typeof podcastIdFor === 'function'
    ? text(podcastIdFor(rss))
    : '';
  return {
    id: itemId(makeItemId, source, 'podcast', rss || title, index),
    kind: 'podcast',
    title,
    subtitle: 'Podcast',
    artist: '',
    album: '',
    provider,
    source,
    artworkUrl: remoteArtwork(raw?.art || raw?.imageUrl, { baseUrl, artworkUrlFor }),
    track: null,
    albumItem: null,
    artistItem: null,
    playlist: null,
    podcastId: podcastId || itemId(makeItemId, source, 'podcast-reference', rss || title, index),
    radioStationName: null,
  };
}

function radioItem({ source, provider, raw, baseUrl, makeItemId, artworkUrlFor, radioStationIdFor, index }) {
  const file = text(raw?.file || raw?.url || raw?.streamUrl);
  const title = text(raw?.stationName || raw?.title || raw?.name || file) || '(station)';
  const radioStationId = typeof radioStationIdFor === 'function'
    ? text(radioStationIdFor(file))
    : '';
  return {
    id: itemId(makeItemId, source, 'radio', file || title, index),
    kind: 'radio',
    title,
    subtitle: text(raw?.genre),
    artist: '',
    album: '',
    provider,
    source,
    artworkUrl: artworkUrlFor?.({ kind: 'radio', reference: title }) || remoteArtwork(raw?.art, { baseUrl, artworkUrlFor }),
    track: null,
    albumItem: null,
    artistItem: null,
    playlist: null,
    podcastId: null,
    radioStationName: title,
    radioStationId: radioStationId || null,
  };
}

function mapItem(source, raw, context, index) {
  const definition = mobileHomeRowDefinition(source);
  if (!definition) return null;
  const args = { source, provider: definition.provider, raw, ...context, index };
  if (definition.kind === 'album') return albumItem(args);
  if (definition.kind === 'artist') return artistItem(args);
  if (definition.kind === 'track') return trackItem(args);
  if (definition.kind === 'playlist') return playlistItem(args);
  if (definition.kind === 'podcast') return podcastItem(args);
  if (definition.kind === 'radio') return radioItem(args);
  return null;
}

function buildMobileHomeRow(source, result, context) {
  const definition = mobileHomeRowDefinition(source);
  if (!definition) return null;
  const items = sourceItems(result?.payload, source)
    .map((raw, index) => mapItem(source, raw, context, index))
    .filter(Boolean);
  return {
    id: source,
    title: definition.title,
    provider: definition.provider,
    source,
    available: result?.ok !== false,
    items,
  };
}

/// A bounded local-history payload for native features that need recent
/// tracks but must not depend on whether the corresponding Home shelf is
/// visible in the user's controller profile.
export function buildMobileLocalRecentHistory({
  sourcePayload,
  catalog,
  playlistSummaries = [],
  baseUrl = '',
  makeItemId,
  artworkUrlFor,
  podcastIdFor,
  radioStationIdFor,
} = {}) {
  const playlistByName = new Map(
    (Array.isArray(playlistSummaries) ? playlistSummaries : [])
      .filter((row) => row?.name)
      .map((row) => [normalized(row.name), row]),
  );
  return buildMobileHomeRow('local-recenttracks', sourcePayload, {
    catalog,
    playlistByName,
    baseUrl,
    makeItemId,
    artworkUrlFor,
    podcastIdFor,
    radioStationIdFor,
  });
}

export function buildMobileHomeRows({
  profile,
  sourcePayloads = new Map(),
  catalog,
  playlistSummaries = [],
  baseUrl = '',
  makeItemId,
  artworkUrlFor,
  podcastIdFor,
  radioStationIdFor,
} = {}) {
  const safeProfile = sanitizeMobileHomeProfile(profile);
  const playlistByName = new Map(
    (Array.isArray(playlistSummaries) ? playlistSummaries : [])
      .filter((row) => row?.name)
      .map((row) => [normalized(row.name), row]),
  );
  const context = {
    catalog,
    playlistByName,
    baseUrl,
    makeItemId,
    artworkUrlFor,
    podcastIdFor,
    radioStationIdFor,
  };

  const rows = safeProfile.showRecent
    ? orderedMobileHomeRowIDs(safeProfile)
      .map((source) => buildMobileHomeRow(source, sourcePayloads.get(source) || { ok: false, payload: {} }, context))
      .filter(Boolean)
    : [];

  return { profile: safeProfile, rows };
}
