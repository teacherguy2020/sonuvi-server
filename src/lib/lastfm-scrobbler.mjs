import crypto from 'node:crypto';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';

function text(value) {
  return String(value ?? '').trim();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

export function lastfmScrobbleThreshold(durationSec, {
  minTrackDurationSec = 30,
  minPlayedSec = 30,
  completionFraction = 0.5,
  maxCompletionWaitSec = 240,
} = {}) {
  const duration = Math.max(0, number(durationSec));
  if (duration > 0 && duration < minTrackDurationSec) return Infinity;
  if (duration > 0) return Math.max(minPlayedSec, Math.min(duration * completionFraction, maxCompletionWaitSec));
  return maxCompletionWaitSec;
}

export function qualifiesLastfmScrobble({ artist, title, elapsedSec, durationSec } = {}, options = {}) {
  const elapsed = Math.max(0, number(elapsedSec));
  const threshold = lastfmScrobbleThreshold(durationSec, options);
  return !!text(artist) && !!text(title) && Number.isFinite(threshold) && elapsed >= threshold;
}

export function createLastfmScrobbler({
  apiKey = process.env.LASTFM_API_KEY || '',
  apiSecret = process.env.LASTFM_API_SECRET || '',
  sessionKey = process.env.LASTFM_SESSION_KEY || '',
  fetchImpl = globalThis.fetch,
  capabilities = runtimeCapabilities(),
  endpoint = ENDPOINT,
  log = null,
} = {}) {
  const configured = !!(text(apiKey) && text(apiSecret) && text(sessionKey) && typeof fetchImpl === 'function');

  async function submit(event) {
    const artist = text(event?.artist || event?.albumArtist);
    const track = text(event?.title);
    const duration = Math.max(0, Math.floor(number(event?.durationSec)));
    const timestamp = Math.max(0, Math.floor(number(event?.startedAtMs, Date.now()) / 1000));
    if (!configured) return { state: 'not-configured', attempted: false };
    if (!qualifiesLastfmScrobble({ artist, title: track, elapsedSec: event?.elapsedSec, durationSec: duration })) {
      return { state: 'ineligible', attempted: false };
    }
    capabilities.assertExternalMutation('lastfm.scrobble');

    const params = {
      api_key: text(apiKey),
      artist,
      method: 'track.scrobble',
      sk: text(sessionKey),
      timestamp: String(timestamp),
      track,
    };
    if (text(event?.album)) params.album = text(event.album);
    if (duration > 0) params.duration = String(duration);
    const signature = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('') + text(apiSecret);
    params.api_sig = md5(signature);
    params.format = 'json';

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(params),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.error) {
        return { state: 'failed', attempted: true, error: text(body?.message) || `HTTP ${response.status}` };
      }
      return { state: 'submitted', attempted: true };
    } catch (error) {
      log?.warn?.('[lastfm] non-MPD scrobble failed:', error?.message || String(error));
      return { state: 'failed', attempted: true, error: text(error?.message) || String(error) };
    }
  }

  return { configured, submit };
}
