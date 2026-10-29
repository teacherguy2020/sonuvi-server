import { createHash } from 'node:crypto';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_STALE_MS = 8000;
const DEFAULT_MAX_JSON_BYTES = 512 * 1024;
const DEFAULT_MAX_ART_BYTES = 2 * 1024 * 1024;
const DEFAULT_EVENT_RETRY_MS = 1000;
const MAX_EVENT_RETRY_MS = 30000;
const DEFAULT_EVENT_STABLE_MS = 30000;
const DEFAULT_EVENT_JITTER_RATIO = 0.2;
const DEFAULT_TRACK_TRANSITION_VERIFY_MS = 1200;
const DEFAULT_TRACK_TRANSITION_POLL_MS = 100;
const MAX_TEXT = 512;

class PibuzEventError extends Error {
  constructor(reason, { stable = false, cause } = {}) {
    super(reason, cause ? { cause } : undefined);
    this.name = 'PibuzEventError';
    this.reason = reason;
    this.stable = stable;
  }
}

function isAbortError(error) {
  return String(error?.name || '').toLowerCase() === 'aborterror'
    || String(error?.code || '').toUpperCase() === 'ABORT_ERR';
}

function text(value, max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = positiveNumber(value);
  return number !== null && Number.isSafeInteger(Math.round(number)) ? Math.round(number) : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && Number.isSafeInteger(Math.round(number)) ? Math.round(number) : null;
}

function booleanOrNull(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || /^true$/i.test(String(value || '').trim())) return true;
  if (value === 0 || value === '0' || /^false$/i.test(String(value || '').trim())) return false;
  return null;
}

function qobuzId(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return /^\d{1,32}$/.test(raw) ? raw : null;
}

function sampleRateHz(value) {
  const number = positiveNumber(value);
  if (number === null) return null;
  return number < 1000 ? Math.round(number * 1000) : Math.round(number);
}

function rateLabel(value) {
  const rate = sampleRateHz(value);
  if (!rate) return '';
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} kHz`;
}

function normalizeHost(value) {
  const raw = text(value, 255);
  if (!raw) throw new Error('PiBuZ host is required');
  const candidate = raw.includes('://') ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('PiBuZ host is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !parsed.hostname) {
    throw new Error('PiBuZ host is invalid');
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
  };
}

function normalizePort(value) {
  const port = Number(value || 8182);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PiBuZ port is invalid');
  return port;
}

function safeArtworkUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const allowed = host === 'qobuz.com'
      || host.endsWith('.qobuz.com')
      || host === 'qobuz.net'
      || host.endsWith('.qobuz.net');
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !allowed
      || parsed.username
      || parsed.password) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function artworkRefFor(url) {
  const value = safeArtworkUrl(url);
  return value ? `qobuz-${createHash('sha256').update(value).digest('hex').slice(0, 24)}` : '';
}

function normalizeTrack(raw, rememberArtwork) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const artworkUrl = safeArtworkUrl(raw.artwork_url || raw.artworkUrl || raw.cover_url || raw.coverUrl);
  const artworkRef = artworkRefFor(artworkUrl);
  if (artworkRef && typeof rememberArtwork === 'function') rememberArtwork(artworkRef, artworkUrl);
  const trackId = qobuzId(raw.id ?? raw.track_id ?? raw.trackId);
  const sampleRate = sampleRateHz(raw.sample_rate ?? raw.sampleRate);
  const bitDepth = positiveInteger(raw.bit_depth ?? raw.bitDepth);
  const durationSec = positiveNumber(raw.duration_secs ?? raw.duration ?? raw.durationSec);
  const title = text(raw.title);
  const artist = text(raw.artist);
  const album = text(raw.album);
  if (!trackId && !title && !artist && !album) return null;
  return {
    qobuzTrackId: trackId,
    title,
    artist,
    album,
    qobuzAlbumId: qobuzId(raw.album_id ?? raw.albumId),
    qobuzArtistId: qobuzId(raw.artist_id ?? raw.artistId),
    durationSec,
    artworkRef: artworkRef || null,
    sampleRateHz: sampleRate,
    bitDepth,
    hires: raw.hires === true,
    version: text(raw.version || raw.album_version || raw.albumVersion),
  };
}

function normalizeState(playback = {}) {
  const explicit = text(playback.state || playback.play_state || playback.playState).toLowerCase();
  if (['play', 'playing', 'resume', 'resumed'].includes(explicit)) return 'play';
  if (['pause', 'paused'].includes(explicit)) return 'pause';
  if (['stop', 'stopped'].includes(explicit)) return 'stop';
  if (booleanOrNull(playback.is_playing ?? playback.isPlaying) === true) return 'play';
  return 'pause';
}

function normalizeStatus(raw) {
  const qconnect = raw?.qconnect && typeof raw.qconnect === 'object' ? raw.qconnect : {};
  const playback = raw?.playback && typeof raw.playback === 'object' ? raw.playback : {};
  return {
    sessionActive: booleanOrNull(qconnect.session_active ?? raw?.session_active),
    receiverActive: booleanOrNull(qconnect.is_active) === true,
    connectionState: text(qconnect.state, 64) || 'unknown',
    deviceName: text(qconnect.device_name, 128),
    enabled: booleanOrNull(qconnect.enabled),
    playback: {
      state: text(playback.state, 32).toLowerCase(),
      isPlaying: booleanOrNull(playback.is_playing ?? playback.isPlaying),
      positionSec: finiteNumber(playback.position),
      durationSec: positiveNumber(playback.duration),
      outputSampleRateHz: sampleRateHz(playback.output_sample_rate ?? playback.outputSampleRate),
      sampleRateHz: sampleRateHz(playback.sample_rate ?? playback.sampleRate),
      bitDepth: positiveInteger(playback.bit_depth ?? playback.bitDepth),
      bitPerfectMode: booleanOrNull(playback.bit_perfect_mode ?? playback.bitPerfectMode),
      volume: finiteNumber(playback.volume),
      muted: booleanOrNull(playback.muted),
      queueLength: nonNegativeInteger(playback.queue_len ?? playback.queueLength),
      shuffle: booleanOrNull(playback.shuffle),
      repeat: text(playback.repeat, 32),
      trackId: qobuzId(playback.track_id ?? playback.trackId),
    },
  };
}

function normalizePlaybackObservation(status, nowPlayingRaw, rememberArtwork) {
  const rawPlayback = nowPlayingRaw?.playback && typeof nowPlayingRaw.playback === 'object'
    ? nowPlayingRaw.playback
    : {};
  const rawTrack = nowPlayingRaw?.track || nowPlayingRaw?.current_track || null;
  const track = normalizeTrack(rawTrack, rememberArtwork);
  const nowPlayingTrackId = qobuzId(rawPlayback.track_id ?? rawPlayback.trackId);
  const trackId = track?.qobuzTrackId || nowPlayingTrackId || status.playback.trackId || null;
  const positionSec = finiteNumber(rawPlayback.position) ?? status.playback.positionSec;
  const playbackDurationSec = positiveNumber(rawPlayback.duration) ?? status.playback.durationSec;
  const trackDurationSec = track?.durationSec ?? null;
  const identityCoherent = Boolean(trackId)
    && [status.playback.trackId, nowPlayingTrackId]
      .filter(Boolean)
      .every((id) => id === trackId);
  const durationCoherent = trackDurationSec === null
    || playbackDurationSec === null
    || Math.abs(trackDurationSec - playbackDurationSec) <= 1;
  const playback = {
    ...status.playback,
    positionSec,
    durationSec: playbackDurationSec ?? trackDurationSec,
    outputSampleRateHz: sampleRateHz(rawPlayback.output_sample_rate)
      || status.playback.outputSampleRateHz,
    sampleRateHz: sampleRateHz(rawPlayback.sample_rate) || status.playback.sampleRateHz,
    bitDepth: positiveInteger(rawPlayback.bit_depth) || status.playback.bitDepth || track?.bitDepth,
    isPlaying: booleanOrNull(rawPlayback.is_playing) ?? status.playback.isPlaying,
    queueLength: nonNegativeInteger(rawPlayback.queue_len) ?? status.playback.queueLength,
    shuffle: booleanOrNull(rawPlayback.shuffle) ?? status.playback.shuffle,
    repeat: text(rawPlayback.repeat, 32) || status.playback.repeat,
    volume: finiteNumber(rawPlayback.volume) ?? status.playback.volume,
  };
  return {
    status,
    nowPlayingRaw,
    track,
    trackId,
    trackDurationSec,
    playbackDurationSec,
    timingCoherent: identityCoherent && durationCoherent,
    playback,
  };
}

function timingObservationsAgree(previous, current) {
  if (!previous?.timingCoherent || !current?.timingCoherent) return false;
  if (!previous.trackId || previous.trackId !== current.trackId) return false;
  if (previous.trackDurationSec !== null && current.trackDurationSec !== null
    && Math.abs(previous.trackDurationSec - current.trackDurationSec) > 1) return false;
  if (previous.playbackDurationSec !== null && current.playbackDurationSec !== null
    && Math.abs(previous.playbackDurationSec - current.playbackDurationSec) > 1) return false;
  return true;
}

function normalizeQueue(raw, rememberArtwork) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const normalizeList = (value) => (Array.isArray(value)
    ? value.map((item) => normalizeTrack(item, rememberArtwork)).filter(Boolean)
    : []);
  const currentIndex = Number.isSafeInteger(raw.current_index)
    ? raw.current_index
    : (Number.isSafeInteger(Number(raw.currentIndex)) ? Number(raw.currentIndex) : null);
  const totalTracks = Number.isSafeInteger(raw.total_tracks)
    ? raw.total_tracks
    : (Number.isSafeInteger(Number(raw.totalTracks)) ? Number(raw.totalTracks) : null);
  return {
    available: true,
    currentIndex,
    totalTracks,
    repeat: text(raw.repeat, 32) || 'off',
    shuffle: raw.shuffle === true,
    stopAfterTrackId: qobuzId(raw.stop_after_track_id ?? raw.stopAfterTrackId),
    currentTrack: normalizeTrack(raw.current_track || raw.currentTrack, rememberArtwork),
    history: normalizeList(raw.history),
    upcoming: normalizeList(raw.upcoming),
  };
}

function sourceFormat(track) {
  if (!track) return '';
  const quality = track.bitDepth && track.sampleRateHz
    ? `${track.bitDepth}-bit / ${rateLabel(track.sampleRateHz)}`
    : rateLabel(track.sampleRateHz);
  return quality ? `Qobuz ${quality}` : '';
}

function outputFormat(status) {
  const rate = rateLabel(status?.playback?.outputSampleRateHz || status?.playback?.sampleRateHz);
  return rate ? `PCM / ${rate}` : '';
}

async function readLimited(response, maxBytes) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    try {
      const chunks = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value || []);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error('PiBuZ response exceeded the size limit');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
  }
  if (typeof response?.arrayBuffer === 'function') {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error('PiBuZ response exceeded the size limit');
    return body;
  }
  if (typeof response?.text === 'function') {
    const body = Buffer.from(await response.text(), 'utf8');
    if (body.length > maxBytes) throw new Error('PiBuZ response exceeded the size limit');
    return body;
  }
  return Buffer.alloc(0);
}

function eventLineHandler(state, onEvent, line) {
  const trimmed = String(line || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch {}
    if (parsed !== null) onEvent('message', parsed);
    return;
  }
  if (line === '') {
    if (!state.data.length) {
      state.event = 'message';
      return;
    }
    const data = state.data.join('\n');
    state.data = [];
    const event = state.event || 'message';
    state.event = 'message';
    let parsed = null;
    try { parsed = JSON.parse(data); } catch {}
    onEvent(event, parsed);
    return;
  }
  if (line.startsWith(':')) return;
  const separator = line.indexOf(':');
  const field = separator >= 0 ? line.slice(0, separator) : line;
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
  if (field === 'event') state.event = text(value, 64) || 'message';
  if (field === 'data') state.data.push(value);
}

export function createPibuzQobuzAdapter({
  host,
  port = 8182,
  baseUrl = '',
  fetchImpl = globalThis.fetch,
  capabilities = runtimeCapabilities(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
  maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  maxArtworkBytes = DEFAULT_MAX_ART_BYTES,
  trackTransitionVerifyMs = DEFAULT_TRACK_TRANSITION_VERIFY_MS,
  trackTransitionPollMs = DEFAULT_TRACK_TRANSITION_POLL_MS,
  now = () => Date.now(),
  eventRetryBaseMs = DEFAULT_EVENT_RETRY_MS,
  eventRetryMaxMs = MAX_EVENT_RETRY_MS,
  eventStableMs = DEFAULT_EVENT_STABLE_MS,
  eventJitterRatio = DEFAULT_EVENT_JITTER_RATIO,
  randomImpl = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('PiBuZ fetch implementation is unavailable');
  const parsedHost = baseUrl ? normalizeHost(baseUrl) : normalizeHost(host);
  const parsedPort = normalizePort(port);
  const base = `${parsedHost.protocol}//${parsedHost.hostname.includes(':') ? `[${parsedHost.hostname}]` : parsedHost.hostname}:${parsedPort}`;
  const requestTimeoutMs = Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxStaleMs = Math.max(0, Number(staleMs) || DEFAULT_STALE_MS);
  const responseLimit = Math.max(1024, Number(maxJsonBytes) || DEFAULT_MAX_JSON_BYTES);
  const artworkLimit = Math.max(1024, Number(maxArtworkBytes) || DEFAULT_MAX_ART_BYTES);
  const trackTransitionLimitMs = Math.min(
    5000,
    Math.max(0, Number(trackTransitionVerifyMs) || DEFAULT_TRACK_TRANSITION_VERIFY_MS),
  );
  const trackTransitionIntervalMs = Math.min(
    1000,
    Math.max(25, Number(trackTransitionPollMs) || DEFAULT_TRACK_TRANSITION_POLL_MS),
  );
  const retryBaseMsValue = Number(eventRetryBaseMs);
  const retryBaseMs = Number.isFinite(retryBaseMsValue) && retryBaseMsValue > 0
    ? Math.round(retryBaseMsValue)
    : DEFAULT_EVENT_RETRY_MS;
  const retryMaxMsValue = Number(eventRetryMaxMs);
  const retryMaxMs = Math.max(
    retryBaseMs,
    Number.isFinite(retryMaxMsValue) && retryMaxMsValue > 0
      ? Math.round(retryMaxMsValue)
      : MAX_EVENT_RETRY_MS,
  );
  const stableDurationValue = Number(eventStableMs);
  const stableDurationMs = Number.isFinite(stableDurationValue) && stableDurationValue >= 0
    ? Math.round(stableDurationValue)
    : DEFAULT_EVENT_STABLE_MS;
  const jitterValue = Number(eventJitterRatio);
  const jitterRatio = Number.isFinite(jitterValue)
    ? Math.min(1, Math.max(0, jitterValue))
    : DEFAULT_EVENT_JITTER_RATIO;
  const random = typeof randomImpl === 'function' ? randomImpl : Math.random;
  const artworkByRef = new Map();
  let lastAuthoritative = null;
  let lastAuthoritativeAt = 0;
  let lastStableTrackId = null;
  let eventTask = null;
  let eventAbort = null;
  let eventReader = null;
  let eventConnectedAtMs = null;
  let stopped = false;
  let eventRetryMs = retryBaseMs;
  const eventState = {
    connected: false,
    activeConnections: 0,
    connectionAttempts: 0,
    reconnects: 0,
    revision: 0,
    lastEventAt: null,
    lastEventType: '',
    lastDisconnectAt: null,
    lastDisconnectReason: '',
    lastConnectionAgeMs: 0,
    backoffMs: 0,
  };

  function rememberArtwork(ref, url) {
    if (!ref || !url) return;
    artworkByRef.set(ref, url);
    while (artworkByRef.size > 256) artworkByRef.delete(artworkByRef.keys().next().value);
  }

  async function request(pathname, { accept = 'application/json', signal, retainSignal = false } = {}) {
    const allowedPath = ['/api/status', '/api/now-playing', '/api/queue', '/api/events'].includes(pathname);
    if (!allowedPath) throw new Error('PiBuZ endpoint is not allowed');
    capabilities.assertExternalRead('pibuz.read');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    let response;
    try {
      if (signal?.aborted) controller.abort();
      response = await fetchImpl(`${base}${pathname}`, {
        cache: 'no-store',
        redirect: 'error',
        headers: { accept },
        signal: controller.signal,
      });
      return retainSignal
        ? { response, cleanup: () => signal?.removeEventListener?.('abort', abort) }
        : response;
    } catch (error) {
      signal?.removeEventListener?.('abort', abort);
      if (timedOut) {
        const timeoutError = new Error('PiBuZ request timed out', { cause: error });
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!retainSignal) signal?.removeEventListener?.('abort', abort);
    }
  }

  function timestampMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function timestampIso(value) {
    try { return new Date(value).toISOString(); } catch { return null; }
  }

  function markConnected() {
    eventConnectedAtMs = timestampMs();
    eventState.connected = true;
    eventState.activeConnections = 1;
    return eventConnectedAtMs;
  }

  function markDisconnected(reason) {
    const disconnectedAt = timestampMs();
    eventState.lastConnectionAgeMs = eventConnectedAtMs === null
      ? 0
      : Math.max(0, disconnectedAt - eventConnectedAtMs);
    eventConnectedAtMs = null;
    eventState.connected = false;
    eventState.activeConnections = 0;
    eventState.lastDisconnectAt = timestampIso(disconnectedAt);
    eventState.lastDisconnectReason = text(reason, 32);
  }

  function eventStateSnapshot() {
    const current = timestampMs();
    return {
      ...eventState,
      connectionAgeMs: eventConnectedAtMs === null
        ? 0
        : Math.max(0, current - eventConnectedAtMs),
      connectedAt: timestampIso(eventConnectedAtMs),
    };
  }

  function retryDelayMs(delayMs) {
    const bounded = Math.max(1, Math.min(retryMaxMs, Math.round(delayMs)));
    if (!jitterRatio) return bounded;
    const randomValue = Number(random());
    const unit = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
    return Math.max(1, Math.min(
      retryMaxMs,
      Math.round(bounded * (1 + ((unit * 2 - 1) * jitterRatio))),
    ));
  }

  function stableConnection(startedAt) {
    return startedAt !== null && Math.max(0, timestampMs() - startedAt) >= stableDurationMs;
  }

  async function requestJson(pathname) {
    const response = await request(pathname);
    if (!response?.ok || (Number(response.status) && (response.status < 200 || response.status >= 300))) {
      throw new Error(`PiBuZ ${pathname} returned HTTP ${response?.status || 0}`);
    }
    const body = await readLimited(response, responseLimit);
    if (!body.length) throw new Error(`PiBuZ ${pathname} returned an empty response`);
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error(`PiBuZ ${pathname} returned invalid JSON`);
    }
  }

  function inactive(status, reason = 'inactive') {
    return {
      authoritative: true,
      available: true,
      active: false,
      ownershipState: 'confirmed-inactive',
      source: 'qobuz-connect',
      owner: 'pibuz',
      output: 'moode',
      sessionActive: status.sessionActive,
      receiverActive: status.receiverActive,
      connectionState: status.connectionState,
      reason,
      suppressMpdHistory: false,
      eventStream: eventStateSnapshot(),
    };
  }

  function remember(value, timestamp) {
    lastAuthoritative = value;
    lastAuthoritativeAt = timestamp;
    return value;
  }

  function unavailable(timestamp, error) {
    const ageMs = lastAuthoritative ? Math.max(0, timestamp - lastAuthoritativeAt) : Infinity;
    if (lastAuthoritative && ageMs <= maxStaleMs) {
      return {
        ...lastAuthoritative,
        authoritative: true,
        available: true,
        ownershipState: lastAuthoritative.ownershipState
          || (lastAuthoritative.active ? 'confirmed-active' : 'confirmed-inactive'),
        stale: true,
        staleAgeMs: ageMs,
        suppressMpdHistory: Boolean(lastAuthoritative.active),
        reason: 'transport-error',
        errorCode: text(error?.message, 80),
        eventStream: eventStateSnapshot(),
      };
    }
    if (lastAuthoritative) {
      return {
        authoritative: true,
        available: false,
        active: false,
        ownershipState: 'unknown',
        source: 'qobuz-connect',
        owner: 'pibuz',
        output: 'moode',
        sessionActive: null,
        receiverActive: null,
        connectionState: 'unreachable',
        deviceName: '',
        state: 'unknown',
        title: '',
        artist: '',
        album: '',
        durationSec: null,
        artworkUrl: '',
        sourceFormat: '',
        outputFormat: '',
        sourceFormatDetails: null,
        outputFormatDetails: null,
        qobuzTrackId: null,
        qobuzAlbumId: null,
        qobuzArtistId: null,
        qobuzVersion: '',
        artworkRef: null,
        sampleRateHz: null,
        bitDepth: null,
        hires: false,
        outputSampleRateHz: null,
        bitPerfectMode: null,
        queueLength: null,
        currentIndex: null,
        shuffle: null,
        repeat: '',
        volume: null,
        muted: null,
        stale: true,
        staleAgeMs: ageMs,
        suppressMpdHistory: true,
        reason: 'ownership-unknown',
        lastKnownOwnership: lastAuthoritative.ownershipState
          || (lastAuthoritative.active ? 'confirmed-active' : 'confirmed-inactive'),
        errorCode: text(error?.message, 80),
        eventStream: eventStateSnapshot(),
      };
    }
    return {
      authoritative: false,
      available: false,
      active: false,
      ownershipState: 'unknown',
      source: 'qobuz-connect',
      reason: 'unavailable',
      errorCode: text(error?.message, 80),
      eventStream: eventStateSnapshot(),
    };
  }

  async function readPlaybackObservation() {
    const statusRaw = await requestJson('/api/status');
    const status = normalizeStatus(statusRaw);
    if (!status.receiverActive) return { status, inactive: true };

    let nowPlayingRaw = null;
    let nowPlayingError = null;
    try {
      nowPlayingRaw = await requestJson('/api/now-playing');
    } catch (error) {
      nowPlayingError = error;
    }
    return {
      ...normalizePlaybackObservation(status, nowPlayingRaw, rememberArtwork),
      nowPlayingError,
      inactive: false,
    };
  }

  async function settlePlaybackObservation(initial) {
    if (initial.inactive) return { ...initial, timingStable: false };
    if (initial.trackId && initial.timingCoherent
      && (!lastStableTrackId || lastStableTrackId === initial.trackId)) {
      lastStableTrackId = initial.trackId;
      return { ...initial, timingStable: true, transitionPending: false };
    }

    let candidate = initial;
    let targetTrackId = initial.trackId;
    let previousCoherent = null;
    const deadline = Date.now() + trackTransitionLimitMs;
    while (true) {
      if (candidate.inactive) return { ...candidate, timingStable: false };
      if (candidate.trackId !== targetTrackId) {
        targetTrackId = candidate.trackId;
        previousCoherent = null;
      }
      if (candidate.trackId && candidate.trackId === targetTrackId && candidate.timingCoherent) {
        if (previousCoherent && timingObservationsAgree(previousCoherent, candidate)) {
          lastStableTrackId = candidate.trackId;
          return { ...candidate, timingStable: true, transitionPending: false };
        }
        previousCoherent = candidate;
      } else {
        previousCoherent = null;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, trackTransitionIntervalMs));
      try {
        candidate = await readPlaybackObservation();
      } catch {
        break;
      }
    }
    return {
      ...(candidate.trackId === initial.trackId ? candidate : initial),
      timingStable: false,
      transitionPending: true,
    };
  }

  async function getSnapshot({ includeQueue = false } = {}) {
    const timestamp = now();
    let observation;
    try {
      observation = await readPlaybackObservation();
    } catch (error) {
      return { ...unavailable(timestamp, error), queue: null };
    }

    if (observation.inactive) {
      const result = inactive(observation.status);
      lastAuthoritative = result;
      lastAuthoritativeAt = timestamp;
      return { ...result, queue: null };
    }

    observation = await settlePlaybackObservation(observation);
    if (observation.inactive) {
      const result = inactive(observation.status);
      lastAuthoritative = result;
      lastAuthoritativeAt = timestamp;
      return { ...result, queue: null };
    }
    const {
      status,
      track,
      playback,
      nowPlayingError,
      timingStable,
      transitionPending,
    } = observation;
    const result = {
      authoritative: true,
      available: true,
      active: true,
      ownershipState: 'confirmed-active',
      source: 'qobuz-connect',
      owner: 'pibuz',
      output: 'moode',
      sessionActive: status.sessionActive,
      receiverActive: status.receiverActive,
      connectionState: status.connectionState,
      deviceName: status.deviceName,
      state: normalizeState(playback),
      title: track?.title || '',
      artist: track?.artist || '',
      album: track?.album || '',
      durationSec: timingStable ? playback.durationSec : null,
      ...(timingStable && playback.positionSec !== null
        ? { elapsedSec: Math.max(0, playback.positionSec) }
        : {}),
      artworkUrl: track?.artworkRef ? artworkByRef.get(track.artworkRef) || '' : '',
      sourceFormat: sourceFormat(track),
      outputFormat: outputFormat({ playback }),
      sourceFormatDetails: {
        format: sourceFormat(track),
        codec: '',
        bitDepth: track?.bitDepth || null,
        sampleRateHz: track?.sampleRateHz || null,
        channels: null,
        provenance: 'pibuz-track',
      },
      outputFormatDetails: {
        format: outputFormat({ playback }),
        codec: 'PCM',
        bitDepth: null,
        sampleRateHz: playback.outputSampleRateHz || null,
        channels: null,
        provenance: 'pibuz-playback',
      },
      qobuzTrackId: track?.qobuzTrackId || null,
      qobuzAlbumId: track?.qobuzAlbumId || null,
      qobuzArtistId: track?.qobuzArtistId || null,
      qobuzVersion: track?.version || '',
      artworkRef: track?.artworkRef || null,
      sampleRateHz: track?.sampleRateHz || null,
      bitDepth: track?.bitDepth || null,
      hires: track?.hires === true,
      outputSampleRateHz: playback.outputSampleRateHz,
      bitPerfectMode: playback.bitPerfectMode,
      queueLength: playback.queueLength,
      currentIndex: null,
      shuffle: playback.shuffle,
      repeat: playback.repeat,
      volume: playback.volume,
      muted: playback.muted,
      suppressMpdHistory: true,
      stale: false,
      staleAgeMs: 0,
      timingStable,
      transitionPending: transitionPending === true,
      ...(nowPlayingError ? { reason: 'metadata-unavailable', errorCode: text(nowPlayingError.message, 80) } : {}),
      eventStream: eventStateSnapshot(),
    };
    remember(result, timestamp);

    if (includeQueue) {
      try {
        const queueRaw = await requestJson('/api/queue');
        result.queue = normalizeQueue(queueRaw, rememberArtwork) || {
          available: false,
          reason: 'malformed',
        };
      } catch (error) {
        result.queue = {
          available: false,
          reason: 'unavailable',
          errorCode: text(error?.message, 80),
        };
      }
    } else {
      result.queue = null;
    }
    return result;
  }

  async function getNowPlaying() {
    return getSnapshot({ includeQueue: false });
  }

  async function getQueue() {
    const snapshot = await getSnapshot({ includeQueue: true });
    return {
      ...snapshot,
      queue: snapshot.active ? snapshot.queue : null,
    };
  }

  async function fetchArtwork(ref) {
    const artworkRef = text(ref, 80);
    const url = artworkByRef.get(artworkRef);
    if (!url) return null;
    const response = await requestArtwork(url);
    return response;
  }

  async function requestArtwork(url) {
    capabilities.assertExternalRead('pibuz.artwork');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        redirect: 'error',
        headers: { accept: 'image/*' },
        signal: controller.signal,
      });
      if (!response?.ok || (Number(response.status) && (response.status < 200 || response.status >= 300))) {
        throw new Error(`Qobuz artwork returned HTTP ${response?.status || 0}`);
      }
      const contentType = text(response.headers?.get?.('content-type') || 'image/jpeg', 80).split(';')[0].toLowerCase();
      if (!contentType.startsWith('image/')) throw new Error('Qobuz artwork was not an image');
      const body = await readLimited(response, artworkLimit);
      return { body, contentType };
    } finally {
      clearTimeout(timer);
    }
  }

  async function consumeEvents() {
    const signal = eventAbort?.signal;
    if (stopped || signal?.aborted) throw new PibuzEventError('stopped');

    // Only the connection/headers phase is bounded by request(); once the
    // SSE body is established, an idle stream is healthy and must not be
    // closed by the ordinary JSON request timeout.
    eventState.connectionAttempts += 1;
    eventState.activeConnections = 1;

    let requestResult;
    try {
      requestResult = await request('/api/events', {
        accept: 'text/event-stream',
        signal,
        retainSignal: true,
      });
    } catch (error) {
      const reason = stopped || signal?.aborted
        ? 'stopped'
        : (error?.code === 'ETIMEDOUT'
          ? 'request-timeout'
          : (isAbortError(error) ? 'request-aborted' : 'request-error'));
      markDisconnected(reason);
      throw new PibuzEventError(reason, { cause: error });
    }

    const response = requestResult.response;
    const cleanup = requestResult.cleanup;
    let reader = null;
    let connectionStartedAt = null;
    let disconnectReason = 'eof';
    try {
      if (!response?.ok || (Number(response.status) && (response.status < 200 || response.status >= 300))) {
        throw new PibuzEventError('http-error');
      }
      if (!response.body?.getReader) throw new PibuzEventError('body-unavailable');
      if (stopped || signal?.aborted) {
        disconnectReason = 'stopped';
        return { stopped: true };
      }

      reader = response.body.getReader();
      eventReader = reader;
      connectionStartedAt = markConnected();
      const decoder = new TextDecoder();
      let buffer = '';
      const state = { event: 'message', data: [] };
      const onEvent = (event) => {
        eventState.revision += 1;
        eventState.lastEventAt = timestampIso(timestampMs());
        eventState.lastEventType = text(event, 64);
      };

      while (true) {
        if (stopped || signal?.aborted) {
          disconnectReason = 'stopped';
          return { stopped: true };
        }
        let next;
        try {
          next = await reader.read();
        } catch (error) {
          if (stopped || signal?.aborted) {
            disconnectReason = 'stopped';
            return { stopped: true };
          }
          disconnectReason = 'reader-error';
          throw new PibuzEventError(disconnectReason, {
            stable: stableConnection(connectionStartedAt),
            cause: error,
          });
        }
        if (next.done) {
          disconnectReason = 'eof';
          throw new PibuzEventError(disconnectReason, {
            stable: stableConnection(connectionStartedAt),
          });
        }
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) eventLineHandler(state, onEvent, line);
      }
    } catch (error) {
      if (stopped || signal?.aborted) {
        disconnectReason = 'stopped';
        return { stopped: true };
      }
      if (error instanceof PibuzEventError) {
        disconnectReason = error.reason;
        throw error;
      }
      disconnectReason = 'reader-error';
      throw new PibuzEventError(disconnectReason, {
        stable: stableConnection(connectionStartedAt),
        cause: error,
      });
    } finally {
      if (reader) {
        try { await reader.cancel?.(); } catch {}
      } else {
        try { await response?.body?.cancel?.(); } catch {}
      }
      try { reader?.releaseLock?.(); } catch {}
      if (eventReader === reader) eventReader = null;
      cleanup?.();
      markDisconnected(disconnectReason);
    }
  }

  async function eventLoop() {
    const waitForRetry = (delayMs) => new Promise((resolve) => {
      const signal = eventAbort?.signal;
      let timer = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', done);
        eventState.backoffMs = 0;
        resolve();
      };
      if (signal?.aborted) {
        done();
        return;
      }
      signal?.addEventListener?.('abort', done, { once: true });
      timer = setTimeout(done, delayMs);
      timer.unref?.();
    });
    while (!stopped) {
      try {
        await consumeEvents();
      } catch (error) {
        if (stopped || error?.reason === 'stopped') break;
        // Do not reset backoff merely because headers arrived. A receiver
        // that immediately closes the body would otherwise reconnect forever
        // at the one-second base delay.
        if (error?.stable) eventRetryMs = retryBaseMs;
        eventState.reconnects += 1;
        const delay = retryDelayMs(eventRetryMs);
        eventState.backoffMs = delay;
        await waitForRetry(delay);
        if (stopped) break;
        eventRetryMs = Math.min(retryMaxMs, eventRetryMs * 2);
      }
    }
    if (eventState.connected || eventState.activeConnections > 0) markDisconnected('stopped');
    eventState.backoffMs = 0;
  }

  return {
    getSnapshot,
    getNowPlaying,
    getQueue,
    fetchArtwork,
    getEventState: eventStateSnapshot,
    startEvents() {
      if (eventTask) return eventTask;
      stopped = false;
      eventRetryMs = retryBaseMs;
      eventState.backoffMs = 0;
      eventAbort = new AbortController();
      eventTask = eventLoop().finally(() => {
        eventTask = null;
        eventAbort = null;
        eventReader = null;
        eventState.backoffMs = 0;
      });
      eventTask.catch(() => {});
      return eventTask;
    },
    async stopEvents() {
      const task = eventTask;
      stopped = true;
      eventAbort?.abort();
      try { await eventReader?.cancel?.(); } catch {}
      await task?.catch(() => {});
      if (eventTask === task) eventTask = null;
      if (!eventTask) eventAbort = null;
      eventState.connected = false;
      eventState.activeConnections = 0;
      eventState.backoffMs = 0;
    },
    endpoint: `${base}/api`,
  };
}

export const pibuzQobuzDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  staleMs: DEFAULT_STALE_MS,
  maxJsonBytes: DEFAULT_MAX_JSON_BYTES,
  maxArtworkBytes: DEFAULT_MAX_ART_BYTES,
  eventRetryBaseMs: DEFAULT_EVENT_RETRY_MS,
  eventRetryMaxMs: MAX_EVENT_RETRY_MS,
  eventStableMs: DEFAULT_EVENT_STABLE_MS,
  eventJitterRatio: DEFAULT_EVENT_JITTER_RATIO,
};
