import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

const STATE_PATHS = runtimeStatePaths();
const DEFAULT_EVENT_PATH = STATE_PATHS.listeningHistoryPath;
const DEFAULT_STATE_PATH = STATE_PATHS.listeningHistoryStatePath;

function text(value) {
  return String(value ?? '').trim();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalize(value) {
  return text(value)
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function positiveInteger(value, fallback) {
  const n = Math.floor(number(value, fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function periodToWindowDays(period) {
  switch (text(period).toLocaleLowerCase()) {
    case '7day':
    case '7days':
    case 'week':
      return 7;
    case '1month':
    case 'month':
      return 31;
    case '3month':
    case 'quarter':
      return 93;
    case '6month':
      return 186;
    case '12month':
    case 'year':
      return 366;
    default:
      return 0;
  }
}

function parseDuration(value) {
  const raw = text(value);
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return number(raw, 0);
  const parts = raw.split(':').map((part) => number(part, 0));
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return 0;
}

function eventFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = text(raw.file);
  const title = text(raw.title);
  const artist = text(raw.artist);
  if (!file || (!title && !artist)) return null;

  return {
    schema: 'now-playing.listening-event.v1',
    sessionId: text(raw.sessionId) || crypto.randomUUID(),
    playedAtMs: Math.max(0, number(raw.playedAtMs, Date.now())),
    playedAt: text(raw.playedAt) || new Date(Math.max(0, number(raw.playedAtMs, Date.now()))).toISOString(),
    startedAtMs: Math.max(0, number(raw.startedAtMs, number(raw.playedAtMs, Date.now()))),
    file,
    artist,
    albumArtist: text(raw.albumArtist),
    album: text(raw.album),
    title,
    track: text(raw.track),
    genre: text(raw.genre),
    durationSec: Math.max(0, number(raw.durationSec, 0)),
    elapsedSec: Math.max(0, number(raw.elapsedSec, 0)),
    source: text(raw.source) || 'mpd',
    trackKey: text(raw.trackKey),
    localPlayQualified: raw.localPlayQualified !== false,
    lastfmEligible: !!raw.lastfmEligible,
    lastfmScrobbleState: text(raw.lastfmScrobbleState) || 'not-requested',
    lastfmScrobbleError: text(raw.lastfmScrobbleError),
  };
}

function artUrlFor(file, baseUrl = '', trackKey = '') {
  const f = text(file);
  if (!f) return '/icons/icon-192.png';

  const relative = `/art/track_640.jpg?file=${encodeURIComponent(f)}${trackKey ? `&k=${encodeURIComponent(trackKey)}` : ''}`;
  const base = text(baseUrl);
  if (!base) return relative;
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

function publicItem(event, kind, playcount, { baseUrl = '', trackKey = '' } = {}) {
  const count = Math.max(1, Math.floor(number(playcount, 1)));
  const artist = text(event.artist || event.albumArtist);
  const album = text(event.album);
  const title = text(event.title || event.file.split('/').pop()?.replace(/\.[a-z0-9]+$/i, ''));

  if (kind === 'artists') {
    return {
      kind: 'lastfm-artist',
      title: artist || '(artist)',
      artist,
      album: '',
      track: '',
      file: text(event.file),
      playcount: count,
      playedAt: text(event.playedAt),
      url: '',
      art: artUrlFor(event.file, baseUrl, trackKey),
      source: 'local-history',
    };
  }

  if (kind === 'albums') {
    return {
      kind: 'lastfm-album',
      title: album || '(album)',
      album,
      artist,
      track: '',
      file: text(event.file),
      playcount: count,
      playedAt: text(event.playedAt),
      url: '',
      art: artUrlFor(event.file, baseUrl, trackKey),
      source: 'local-history',
    };
  }

  return {
    kind: 'lastfm-track',
    title: title || '(track)',
    track: title,
    artist,
    album,
    file: text(event.file),
    playcount: count,
    playedAt: text(event.playedAt),
    url: '',
    art: artUrlFor(event.file, baseUrl, trackKey),
    source: 'local-history',
  };
}

export function createListeningHistoryStore({
  eventPath = DEFAULT_EVENT_PATH,
  statePath = DEFAULT_STATE_PATH,
  minTrackDurationSec = 30,
  minPlayedSec = 30,
  completionFraction = 0.5,
  maxCompletionWaitSec = 240,
  onQualified = null,
  now = () => Date.now(),
  log = null,
} = {}) {
  const events = [];
  let active = null;
  let loaded = false;
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const queueWrite = (work) => {
    const result = writeChain.then(work, work);
    writeChain = result.catch(() => {});
    return result;
  };

  async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  }

  async function persistState() {
    const state = active
      ? {
          schema: 'now-playing.listening-state.v1',
          identity: text(active.identity),
          sessionId: text(active.sessionId),
          startedAtMs: number(active.startedAtMs, 0),
          recorded: !!active.recorded,
          file: text(active.file),
        }
      : null;
    await queueWrite(() => writeJsonAtomic(statePath, state));
  }

  async function load() {
    if (loaded) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const raw = await fs.readFile(eventPath, 'utf8').catch(() => '');
      for (const line of String(raw || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = eventFromRaw(JSON.parse(line));
          if (event) events.push(event);
        } catch {
          // Keep one damaged history line from preventing the service booting.
        }
      }

      try {
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (state && typeof state === 'object' && text(state.identity) && text(state.sessionId)) {
          active = {
            identity: text(state.identity),
            sessionId: text(state.sessionId),
            startedAtMs: Math.max(0, number(state.startedAtMs, 0)),
            recorded: !!state.recorded,
            file: text(state.file),
            lastElapsedSec: 0,
            metadata: null,
          };
        }
      } catch {
        active = null;
      }

      loaded = true;
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function thresholdFor(durationSec) {
    const duration = Math.max(0, number(durationSec, 0));
    if (duration > 0) return Math.min(duration * completionFraction, maxCompletionWaitSec);
    return maxCompletionWaitSec;
  }

  function qualifies(elapsedSec, durationSec) {
    const elapsed = Math.max(0, number(elapsedSec, 0));
    const duration = Math.max(0, number(durationSec, 0));
    if (duration > 0 && duration < minTrackDurationSec) return false;
    if (elapsed < minPlayedSec) return false;
    return elapsed >= thresholdFor(duration);
  }

  async function appendEvent(event) {
    await queueWrite(async () => {
      await fs.mkdir(path.dirname(eventPath), { recursive: true });
      await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
    });
    events.push(event);
  }

  async function updateEvent(sessionId, patch = {}) {
    await load();
    const id = text(sessionId);
    const index = events.findIndex((item) => item.sessionId === id);
    if (index < 0) return null;
    events[index] = { ...events[index], ...patch };
    await queueWrite(async () => {
      await fs.mkdir(path.dirname(eventPath), { recursive: true });
      const temporary = eventPath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temporary, events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
      await fs.rename(temporary, eventPath);
    });
    return events[index];
  }

  async function observe({
    status = {},
    song = {},
    sessionId = '',
    startedAtMs = 0,
    eligible = true,
    source = 'mpd',
    lastfmMode = 'disabled',
    atMs = now(),
  } = {}) {
    await load();

    const file = text(song.file);
    if (!file) {
      if (active) {
        active = null;
        await persistState().catch(() => {});
      }
      return { recorded: false, reason: 'no-track' };
    }

    const songId = text(status.songid || status.songId || song.songid);
    const identity = `${songId || 'file'}|${file}`;
    const elapsedSec = Math.max(0, number(status.elapsedSec ?? status.elapsed, 0));
    const durationSec = Math.max(0, parseDuration(song.durationSec ?? song.duration ?? song.time));

    if (!active || active.identity !== identity || (active.recorded && elapsedSec + 10 < number(active.lastElapsedSec, elapsedSec))) {
      active = {
        identity,
          sessionId: text(sessionId) || crypto.randomUUID(),
          startedAtMs: Math.max(0, number(startedAtMs, atMs)) || atMs,
        recorded: false,
        file,
        lastElapsedSec: elapsedSec,
        metadata: null,
      };
      await persistState().catch(() => {});
    }

    active.lastElapsedSec = elapsedSec;
    active.file = file;
    const previousMetadata = active.metadata || {};
    active.metadata = {
      file,
      artist: text(song.artist) || text(previousMetadata.artist),
      albumArtist: text(song.albumArtist || song.albumartist) || text(previousMetadata.albumArtist),
      album: text(song.album) || text(previousMetadata.album),
      title: text(song.title) || text(previousMetadata.title),
      track: text(song.track) || text(previousMetadata.track),
      genre: text(song.genre) || text(previousMetadata.genre),
      durationSec: durationSec || number(previousMetadata.durationSec, 0),
      trackKey: text(song.trackKey) || text(previousMetadata.trackKey),
    };

    const effectiveDurationSec = number(active.metadata.durationSec, durationSec);

    if (!eligible || active.recorded || !qualifies(elapsedSec, effectiveDurationSec)) {
      return {
        recorded: false,
        reason: !eligible ? 'ineligible' : active.recorded ? 'already-recorded' : 'below-threshold',
        elapsedSec,
        thresholdSec: thresholdFor(effectiveDurationSec),
      };
    }

    const metadata = active.metadata || { file };
    const shadowMpd = source === 'mpd' && lastfmMode === 'shadow';
    const activeMpd = source === 'mpd' && lastfmMode === 'active';
    const event = eventFromRaw({
      ...metadata,
      sessionId: active.sessionId,
      playedAtMs: atMs,
      startedAtMs: active.startedAtMs,
      elapsedSec,
      source,
      trackKey: metadata.trackKey,
      localPlayQualified: true,
      lastfmEligible: source !== 'mpd' || shadowMpd || activeMpd,
      lastfmScrobbleState: source === 'mpd'
        ? (shadowMpd ? 'mpd-shadow-pending' : 'mpdscribble-authoritative')
        : 'pending',
    });
    if (!event) return { recorded: false, reason: 'missing-metadata' };

    const alreadyPresent = events.some((item) => item.sessionId === event.sessionId);
    if (!alreadyPresent) await appendEvent(event);
    active.recorded = true;
    await persistState().catch(() => {});
    if (!alreadyPresent && (source !== 'mpd' || shadowMpd || activeMpd) && typeof onQualified === 'function') {
      Promise.resolve()
        .then(() => onQualified(event, { updateEvent }))
        .catch((error) => log?.warn?.('[listening-history] qualified-event hook failed:', error?.message || String(error)));
    }
    return { recorded: true, event };
  }

  async function getItems(kind, {
    limit = 18,
    period = 'overall',
    windowDays = 0,
    baseUrl = '',
    trackKey = '',
  } = {}) {
    await load();
    const max = Math.max(1, Math.min(50, positiveInteger(limit, 18)));
    const explicitDays = number(windowDays, 0);
    const days = explicitDays > 0 ? Math.min(3660, Math.floor(explicitDays)) : periodToWindowDays(period);
    const cutoff = days > 0 ? now() - (days * 24 * 60 * 60 * 1000) : 0;
    const filtered = events
      .filter((event) => !cutoff || Number(event.playedAtMs || 0) >= cutoff)
      .sort((a, b) => Number(b.playedAtMs || 0) - Number(a.playedAtMs || 0));

    const mode = text(kind).toLocaleLowerCase();
    if (mode === 'recent' || mode === 'recent-tracks' || mode === 'tracks-recent') {
      return filtered.slice(0, max).map((event) => publicItem(event, 'tracks', 1, { baseUrl, trackKey }));
    }

    const groups = new Map();
    for (const event of filtered) {
      const artist = text(event.artist || event.albumArtist);
      const album = text(event.album);
      const title = text(event.title);
      let key = '';
      if (mode === 'artists' || mode === 'top-artists') key = normalize(artist);
      else if (mode === 'albums' || mode === 'top-albums') key = `${normalize(event.albumArtist || artist)}|${normalize(album)}`;
      else key = `${normalize(artist)}|${normalize(title)}`;
      if (!key || key === '|' || key.endsWith('|')) continue;

      const current = groups.get(key);
      if (!current) {
        groups.set(key, { event, count: 1 });
      } else {
        current.count += 1;
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => b.count - a.count || Number(b.event.playedAtMs || 0) - Number(a.event.playedAtMs || 0))
      .slice(0, max)
      .map(({ event, count }) => publicItem(event, mode.includes('artist') ? 'artists' : mode.includes('album') ? 'albums' : 'tracks', count, { baseUrl, trackKey }));
  }

  async function getEvents({ limit = 50 } = {}) {
    await load();
    const max = Math.max(1, Math.min(500, positiveInteger(limit, 50)));
    return events
      .slice()
      .sort((a, b) => Number(b.playedAtMs || 0) - Number(a.playedAtMs || 0))
      .slice(0, max)
      .map((event) => ({ ...event }));
  }

  return {
    load,
    observe,
    getItems,
    getEvents,
    updateEvent,
    thresholdFor,
    get eventPath() { return eventPath; },
    get statePath() { return statePath; },
    get size() { return events.length; },
  };
}

export { artUrlFor, periodToWindowDays };
