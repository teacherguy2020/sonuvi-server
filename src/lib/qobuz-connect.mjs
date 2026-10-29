import { createHash } from 'node:crypto';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const DEFAULT_META_TIMEOUT_MS = 1200;
const DEFAULT_STALE_MS = 15000;

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function normalizeState(value) {
  switch (text(value).toLowerCase()) {
    case 'play':
    case 'playing':
    case 'resume':
    case 'resumed':
      return 'play';
    case 'pause':
    case 'paused':
      return 'pause';
    case 'stop':
    case 'stopped':
      return 'stop';
    default:
      return '';
  }
}

function isRenderableState(value) {
  return value === 'play' || value === 'pause';
}

function safeArtworkUrl(value) {
  const raw = text(value);
  if (!/^https?:\/\//i.test(raw)) return '';

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    // Artwork is fetched server-side. Dropping a query string prevents a
    // signed/private query token from crossing the Now Playing contract.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function artworkVersion(value) {
  const normalized = text(value);
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function isQobuzCurrentArtReference(value) {
  try {
    const url = new URL(String(value || '').trim(), 'http://sonuvi.invalid');
    return /^\/art\/current(?:_320)?\.jpg$/i.test(url.pathname) &&
      /^[a-f0-9]{16}$/i.test(url.searchParams.get('qobuz') || '');
  } catch {
    return false;
  }
}

// A stopped or paused MPD session cannot prove that Qobuz ownership ended.
// Playing state plus a current file is the minimum independent evidence that
// ordinary MPD playback has resumed after an unknown Qobuz receiver state.
export function hasVerifiedMpdPlaybackEvidence({ state, file } = {}) {
  return text(state).toLowerCase() === 'play' && Boolean(text(file));
}

export function parseQobuzFormat(value) {
  const format = text(value);
  if (!format) return { format: '', codec: '', bitDepth: null, sampleRateHz: null, channels: null };

  const resolution = format.match(/(?:^|\s)(\d{1,2})\s*\/\s*(\d+(?:\.\d+)?)\s*(?:kHz)?\b/i);
  const channelMatch = format.match(/(?:^|[,\s])(\d+(?:\.\d+)?)\s*ch\b/i);
  const codec = (format.match(/^([A-Za-z0-9][A-Za-z0-9+._-]*)/) || [])[1] || '';

  const bitDepth = resolution ? positiveNumber(resolution[1], null) : null;
  const rate = resolution ? positiveNumber(resolution[2], null) : null;
  const sampleRateHz = rate === null ? null : (rate < 1000 ? rate * 1000 : rate);
  const channels = channelMatch ? positiveNumber(channelMatch[1], null) : null;

  return {
    format,
    codec,
    bitDepth,
    sampleRateHz,
    channels,
  };
}

export function normalizeQobuzMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const title = text(raw.title);
  const artist = text(raw.artist);
  const album = text(raw.album);
  if (!title && !artist && !album) return null;

  const sourceFormat = text(raw.sformat || raw.source_format || raw.sourceFormat);
  const outputFormat = text(raw.oformat || raw.output_format || raw.outputFormat);
  const sourceDetails = parseQobuzFormat(sourceFormat);
  const outputDetails = parseQobuzFormat(outputFormat);
  const durationSec = positiveNumber(raw.duration ?? raw.duration_secs, 0);
  const elapsedSec = positiveNumber(raw.elapsed ?? raw.elapsed_secs ?? raw.position, null);
  const state = normalizeState(raw.playstate || raw.state);
  const artworkUrl = safeArtworkUrl(raw.cover_url || raw.coverUrl || raw.artwork_url || raw.artworkUrl);

  return {
    title,
    artist,
    album,
    durationSec,
    ...(elapsedSec === null ? {} : { elapsedSec }),
    state,
    artworkUrl,
    sourceFormat,
    outputFormat,
    sourceFormatDetails: sourceDetails,
    outputFormatDetails: outputDetails,
  };
}

function isSuccessfulResponse(response) {
  if (!response || response.ok === false) return false;
  const status = Number(response.status || 0);
  return !status || (status >= 200 && status < 400);
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  if (typeof response?.json === 'function') return JSON.stringify(await response.json());
  return '';
}

function inactive(reason, { suppressMpdHistory = false } = {}) {
  return {
    active: false,
    source: 'qobuz-connect',
    stale: false,
    suppressMpdHistory,
    reason,
  };
}

export function createQobuzConnectSource({
  metaUrl,
  fetchImpl = globalThis.fetch,
  capabilities = runtimeCapabilities(),
  timeoutMs = DEFAULT_META_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
  now = () => Date.now(),
} = {}) {
  const endpoint = text(metaUrl);
  const requestTimeoutMs = Math.max(100, finiteNumber(timeoutMs, DEFAULT_META_TIMEOUT_MS));
  const maxStaleMs = Math.max(0, finiteNumber(staleMs, DEFAULT_STALE_MS));
  let lastGood = null;
  let lastSuccessAt = 0;

  async function get() {
    const attemptAt = now();

    try {
      if (!endpoint || typeof fetchImpl !== 'function') throw new Error('Qobuz metadata endpoint is unavailable');
      capabilities.assertExternalRead('qobuz.metadata');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          cache: 'no-store',
          redirect: 'follow',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!isSuccessfulResponse(response)) throw new Error(`Qobuz metadata HTTP ${response?.status || 0}`);
      const body = text(await responseText(response));
      if (!body) {
        lastGood = null;
        lastSuccessAt = 0;
        return inactive('stopped');
      }

      let raw;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new Error('Qobuz metadata was not JSON');
      }

      const normalized = normalizeQobuzMeta(raw);
      if (!normalized) throw new Error('Qobuz metadata was incomplete');

      if (normalized.state === 'stop') {
        lastGood = null;
        lastSuccessAt = 0;
        return inactive('stopped');
      }

      // moOde's qbzmeta cache can retain the last track after the Qobuz app
      // hands the renderer back to the device. In that state Pibuz reports
      // an empty playstate and an output such as "Not playing". A metadata
      // record without an explicit playing/paused state is therefore not
      // sufficient to claim renderer ownership.
      if (!isRenderableState(normalized.state)) {
        lastGood = null;
        lastSuccessAt = 0;
        return inactive('not-rendering');
      }

      lastGood = normalized;
      lastSuccessAt = attemptAt;
      return {
        active: true,
        source: 'qobuz-connect',
        stale: false,
        staleAgeMs: 0,
        suppressMpdHistory: true,
        ...normalized,
      };
    } catch (error) {
      const ageMs = lastGood ? Math.max(0, attemptAt - lastSuccessAt) : Infinity;
      if (lastGood && ageMs <= maxStaleMs) {
        return {
          active: true,
          source: 'qobuz-connect',
          stale: true,
          staleAgeMs: ageMs,
          suppressMpdHistory: true,
          reason: 'transport-error',
          ...lastGood,
        };
      }

      const hadLastGood = !!lastGood;
      lastGood = null;
      lastSuccessAt = 0;
      return inactive(hadLastGood ? 'stale-expired' : 'unavailable', {
        suppressMpdHistory: hadLastGood,
      });
    }
  }

  return {
    get,
    reset() {
      lastGood = null;
      lastSuccessAt = 0;
    },
  };
}

function baseUrl(value) {
  const base = text(value).replace(/\/+$/, '');
  return base || '';
}

export function buildQobuzNowPlayingPayload({
  qobuz,
  mpdSong = {},
  mpdStatus = {},
  publicBaseUrl = '',
} = {}) {
  const q = qobuz && typeof qobuz === 'object' ? qobuz : {};
  const base = baseUrl(publicBaseUrl);
  const artVersion = artworkVersion(q.artworkUrl);
  const currentArtUrl = `${base}/art/current.jpg${artVersion ? `?qobuz=${artVersion}` : ''}` || '/art/current.jpg';
  const songpos = text(mpdStatus.song);
  const songid = text(mpdStatus.songid);
  const nativeQueueTotal = positiveNumber(q.queueLength);
  const queueTotal = Math.max(0, Math.floor(nativeQueueTotal || positiveNumber(mpdStatus.playlistlength, 0)));
  const queuePosition = Number(songpos);
  const nativeQueuePosition = Number.isInteger(Number(q.currentIndex)) && Number(q.currentIndex) >= 0
    ? Number(q.currentIndex)
    : null;
  const queueTrack = nativeQueuePosition !== null
    ? nativeQueuePosition + 1
    : (Number.isFinite(queuePosition) && queuePosition >= 0 ? queuePosition + 1 : 0);
  const sourceFormat = text(q.sourceFormat);
  const outputFormat = text(q.outputFormat);
  const state = text(q.state);
  const volume = q.volume === null || q.volume === undefined || q.volume === ''
    ? text(mpdSong.volume || '0')
    : text(q.volume);

  return {
    artist: text(q.artist),
    title: text(q.title),
    album: text(q.album),
    file: 'qobuz-connect',
    playbackUrl: '',

    songpos,
    songid,
    queueTrack,
    queueTotal,
    queueLabel: queueTrack > 0 && queueTotal > 0 ? `Track ${queueTrack} of ${queueTotal}` : '',

    albumArtUrl: q.artworkUrl ? currentArtUrl : '',
    aplArtUrl: currentArtUrl,
    altArtUrl: '',
    stationLogoUrl: '',
    stationName: '',
    radioStationName: '',

    displayMode: 'track',
    displayArtist: text(q.artist),
    displayTitle: text(q.title),
    displayLine3: text(q.album),
    displayStationName: '',
    displayArtUrl: q.artworkUrl ? currentArtUrl : '',
    displayConfidence: 'track',

    radioAlbum: '',
    radioYear: '',
    radioLabel: '',
    radioComposer: '',
    radioWork: '',
    radioPerformers: '',
    radioItunesUrl: '',
    radioTrackUrl: '',
    radioAlbumUrl: '',
    shareUrl: '',
    radioLookupReason: '',
    radioLookupTerm: '',

    source: 'qobuz-connect',
    isQobuz: true,
    qobuzConnect: true,
    qobuzOwnershipState: text(q.ownershipState),
    playbackOwner: text(q.owner || 'moode-qbzmeta'),
    outputDevice: text(q.output || 'moode'),
    qobuzSessionActive: typeof q.sessionActive === 'boolean' ? q.sessionActive : null,
    qobuzReceiverActive: typeof q.receiverActive === 'boolean' ? q.receiverActive : null,
    qobuzConnectionState: text(q.connectionState),
    qobuzTrackId: text(q.qobuzTrackId),
    qobuzAlbumId: text(q.qobuzAlbumId),
    qobuzArtistId: text(q.qobuzArtistId),
    qobuzVersion: text(q.qobuzVersion),
    sourceFormat,
    outputFormat,
    sourceFormatDetails: q.sourceFormatDetails || null,
    outputFormatDetails: q.outputFormatDetails || null,
    outputSampleRateHz: q.outputSampleRateHz ?? null,
    bitPerfectMode: q.bitPerfectMode ?? null,
    format: sourceFormat,
    state,
    random: q.shuffle === null || q.shuffle === undefined ? text(mpdStatus.random) : (q.shuffle ? '1' : '0'),
    repeat: text(q.repeat || mpdStatus.repeat),
    elapsed: q.elapsedSec ?? null,
    duration: q.durationSec > 0 ? q.durationSec : null,
    percent: q.elapsedSec !== undefined && q.durationSec > 0
      ? Math.max(0, Math.min(100, Math.round((q.elapsedSec / q.durationSec) * 100)))
      : null,
    progressAvailable: q.elapsedSec !== undefined,
    showProgress: q.elapsedSec !== undefined,

    year: '',
    label: '',
    producer: '',
    personnel: [],

    encoded: sourceFormat,
    bitrate: '',
    outrate: outputFormat,
    volume,
    mute: text(mpdSong.mute || '0'),
    track: '',
    date: '',

    isStream: true,
    isRadio: false,
    isAirplay: false,
    isYoutube: false,
    isPodcast: false,
    streamKind: 'qobuz-connect',
    isUpnp: false,

    isFavorite: false,
    rating: 0,
    ratingDisabled: true,
    ratingFile: '',

    ...(q.stale ? { qobuzStale: true, qobuzStaleAgeMs: q.staleAgeMs } : {}),
  };
}

export const qobuzConnectDefaults = {
  metaTimeoutMs: DEFAULT_META_TIMEOUT_MS,
  staleMs: DEFAULT_STALE_MS,
};
