import { spawn } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

import { runtimeCapabilities } from './runtime-capabilities.mjs';
import { normalizeSourceAudioProbe } from './source-audio.mjs';

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 2;
const MAX_URL_LENGTH = 4_096;
const MAX_FFPROBE_OUTPUT_BYTES = 128 * 1024;

function text(value) {
  return String(value ?? '').trim();
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function boundedPositiveInt(value, fallback, minimum, maximum) {
  const number = positiveInt(value);
  if (!number) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function normalizedIpAddress(value) {
  return text(value).toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
}

function isPublicIpv4(address) {
  const octets = String(address || '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function ipv4Hextets(value) {
  const octets = String(value || '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return [((octets[0] << 8) | octets[1]), ((octets[2] << 8) | octets[3])];
}

function ipv6Hextets(value) {
  let raw = normalizedIpAddress(value);
  if (!raw) return null;
  if (raw.includes('.')) {
    const separator = raw.lastIndexOf(':');
    const converted = ipv4Hextets(raw.slice(separator + 1));
    if (separator < 0 || !converted) return null;
    raw = `${raw.slice(0, separator + 1)}${converted[0].toString(16)}:${converted[1].toString(16)}`;
  }
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const toParts = (half) => half ? half.split(':').map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    return Number.parseInt(part, 16);
  }) : [];
  const left = toParts(halves[0]);
  const right = toParts(halves[1]);
  if (left.includes(null) || right.includes(null)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  return omitted >= 1 ? [...left, ...Array(omitted).fill(0), ...right] : null;
}

/** True only for routable, non-loopback/non-private Internet addresses. */
export function isPublicInternetAddress(value) {
  const address = normalizedIpAddress(value);
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const parts = ipv6Hextets(address);
  if (!parts) return false;
  if (parts.every((part) => part === 0)) return false;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return false;
  if ((parts[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((parts[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((parts[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false; // documentation

  const embeddedV4 = parts.slice(6).flatMap((part) => [(part >> 8) & 0xff, part & 0xff]).join('.');
  if (parts.slice(0, 6).every((part) => part === 0)
    || (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff)) {
    return isPublicIpv4(embeddedV4);
  }
  return true;
}

function normalizedHostname(value) {
  return text(value).toLowerCase().replace(/\.$/, '');
}

/**
 * Normalize a candidate stream URL without doing network I/O. A caller still
 * must validate the destination before fetching it.
 */
export function normalizeLiveRadioStreamUrl(value) {
  const raw = text(value);
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || !url.hostname
      || url.port === '0') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

/**
 * Validate a radio upstream before making a server-side request. It permits
 * public HTTP(S) stations, while rejecting loopback, local-network, link-local,
 * multicast, documentation, and unresolved destinations.
 */
export async function validateLiveRadioStreamUrl(rawUrl, { lookup = dnsLookup } = {}) {
  const url = rawUrl instanceof URL
    ? normalizeLiveRadioStreamUrl(rawUrl.toString())
    : normalizeLiveRadioStreamUrl(rawUrl);
  if (!url) throw new Error('Live radio URL is invalid');

  const hostname = normalizedHostname(url.hostname);
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home')
    || hostname.endsWith('.internal')) {
    throw new Error('Live radio URL is not publicly routable');
  }

  if (net.isIP(hostname)) {
    if (!isPublicInternetAddress(hostname)) throw new Error('Live radio URL is not publicly routable');
    return url;
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Live radio URL hostname could not be resolved safely');
  }
  if (!Array.isArray(records)
    || records.length === 0
    || records.some((record) => !isPublicInternetAddress(record?.address))) {
    throw new Error('Live radio URL does not resolve exclusively to public addresses');
  }
  return url;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return text(headers.get(name));
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return text(value);
  }
  return '';
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) ? status : 0;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function isSuccessfulStreamResponse(status) {
  return status >= 200 && status < 300;
}

function parseContentLength(value) {
  const number = Number(text(value));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function readBoundedBody(response, maxBytes) {
  const limit = boundedPositiveInt(maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  const contentLength = parseContentLength(headerValue(response?.headers, 'content-length'));
  if (contentLength != null && contentLength > limit) {
    try { await response?.body?.cancel?.(); } catch {}
    return Buffer.alloc(0);
  }

  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size < limit) {
        const part = await reader.read();
        if (part?.done) break;
        const chunk = Buffer.from(part?.value || []);
        if (!chunk.length) continue;
        const remaining = limit - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        if (chunk.length >= remaining) break;
      }
    } catch {
      // Headers remain independently useful even if a live body aborts.
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return Buffer.concat(chunks, size);
  }

  if (typeof response?.arrayBuffer === 'function') {
    try {
      return Buffer.from(await response.arrayBuffer()).subarray(0, limit);
    } catch {}
  }
  return Buffer.alloc(0);
}

function codecFromContentType(value) {
  const contentType = text(value).toLowerCase().split(';', 1)[0].trim();
  switch (contentType) {
    case 'audio/aac':
    case 'audio/aacp':
    case 'audio/aac-plus':
    case 'audio/x-aac':
      return { codec: 'AAC', codecKind: 'lossy', bitDepthStatus: 'not-applicable' };
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/x-mpeg':
      return { codec: 'MP3', codecKind: 'lossy', bitDepthStatus: 'not-applicable' };
    case 'audio/opus':
      return { codec: 'OPUS', codecKind: 'lossy', bitDepthStatus: 'not-applicable' };
    case 'audio/vorbis':
      return { codec: 'VORBIS', codecKind: 'lossy', bitDepthStatus: 'not-applicable' };
    case 'audio/flac':
    case 'audio/x-flac':
      return { codec: 'FLAC', codecKind: 'lossless' };
    case 'audio/ogg':
    case 'application/ogg':
      return { container: 'OGG' };
    case 'audio/mp4':
    case 'audio/x-m4a':
      return { container: 'M4A' };
    default:
      return {};
  }
}

function parseIcyBitrateBps(value) {
  const raw = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return null;
  const bps = number <= 10_000 ? Math.round(number * 1_000) : Math.round(number);
  return bps <= 100_000_000 ? bps : null;
}

function rateLabel(sampleRateHz) {
  const rate = positiveInt(sampleRateHz);
  if (!rate) return '';
  const khz = rate / 1_000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

function channelsLabel(channels) {
  const count = positiveInt(channels);
  if (!count) return '';
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  return `${count} ch`;
}

function liveStreamFormat(evidence = {}) {
  const parts = [text(evidence.codec), rateLabel(evidence.sampleRateHz), channelsLabel(evidence.channels)].filter(Boolean);
  return parts.join(' · ') || 'Live stream';
}

function headerEvidence(response) {
  const codec = codecFromContentType(headerValue(response?.headers, 'content-type'));
  const bitrate = parseIcyBitrateBps(
    headerValue(response?.headers, 'icy-br') || headerValue(response?.headers, 'ice-bitrate'),
  );
  const evidence = {
    ...codec,
    ...(codec.codec ? { codecStatus: 'reported' } : {}),
    ...(bitrate ? {
      encodedBitrateBps: bitrate,
      encodedBitrateStatus: 'reported',
      encodedBitrateProvenance: 'icy.header',
    } : {}),
    provenance: 'live-upstream-headers',
    valueType: 'live-stream',
    live: true,
    measured: false,
    verified: false,
  };
  evidence.format = liveStreamFormat(evidence);
  return Object.keys(codec).length || bitrate ? evidence : null;
}

function normalizeFfprobeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = normalizeSourceAudioProbe(value);
  return normalized?.codec ? normalized : null;
}

function mergeLiveEvidence(headers, ffprobe) {
  const probed = normalizeFfprobeResult(ffprobe);
  if (!probed) return headers;

  const merged = {
    ...(headers || {}),
    ...probed,
    codecStatus: 'verified',
    provenance: 'live-upstream-probe',
    valueType: 'live-stream',
    live: true,
    measured: false,
    verified: true,
  };
  if (headers?.encodedBitrateBps) {
    merged.encodedBitrateBps = headers.encodedBitrateBps;
    merged.encodedBitrateStatus = headers.encodedBitrateStatus;
    merged.encodedBitrateProvenance = headers.encodedBitrateProvenance;
  }
  merged.format = liveStreamFormat(merged);
  return merged;
}

async function fetchBoundedLiveStream({
  initialUrl,
  fetchImpl,
  validateUrl,
  maxBytes,
  maxRedirects,
  timeoutMs,
}) {
  let current = initialUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current.toString(), {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        headers: {
          accept: 'audio/*, application/ogg;q=0.9, */*;q=0.1',
          // Do not ask the server to interleave ICY title blocks into the
          // bounded audio bytes handed to ffprobe. The ICY headers still
          // independently expose stream metadata such as bitrate.
          'icy-metadata': '0',
          range: `bytes=0-${maxBytes - 1}`,
          'user-agent': 'Sonuvi-Live-Radio-AudioInfo/1.0',
        },
        signal: controller.signal,
      });
      const status = responseStatus(response);
      if (isRedirectStatus(status)) {
        const location = headerValue(response?.headers, 'location');
        try { await response?.body?.cancel?.(); } catch {}
        if (!location || redirects >= maxRedirects) return null;
        let target;
        try {
          target = new URL(location, current);
        } catch {
          return null;
        }
        try {
          current = await validateUrl(target.toString());
        } catch {
          return null;
        }
        continue;
      }
      if (!isSuccessfulStreamResponse(status)) return null;
      const bytes = await readBoundedBody(response, maxBytes);
      return { response, bytes };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Run ffprobe only against an already-bounded byte sample, never a network URL. */
export function probeLiveRadioBytes({
  ffprobePath = process.env.FFPROBE || '/usr/bin/ffprobe',
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const probeTimeoutMs = boundedPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS, 100, 10_000);
  const inputLimit = boundedPositiveInt(maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  return async (bytes) => new Promise((resolve) => {
    const input = Buffer.from(bytes || []).subarray(0, inputLimit);
    if (!input.length) {
      resolve(null);
      return;
    }

    let child;
    try {
      child = spawnImpl(ffprobePath, [
        '-v', 'error',
        '-probesize', String(input.length),
        '-analyzeduration', '1000000',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,profile,sample_rate,channels,bits_per_raw_sample,bits_per_sample,bit_rate:format=format_name,format_long_name,bit_rate',
        '-of', 'json',
        '-i', 'pipe:0',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    let finished = false;
    let stdout = '';
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(null);
    }, probeTimeoutMs);

    child.once?.('error', () => finish(null));
    child.stdout?.on?.('data', (chunk) => {
      if (finished) return;
      stdout += String(chunk || '');
      if (Buffer.byteLength(stdout) > MAX_FFPROBE_OUTPUT_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish(null);
      }
    });
    child.once?.('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch {
        finish(null);
      }
    });
    child.stdin?.on?.('error', () => {});
    try {
      child.stdin?.end?.(input);
    } catch {
      finish(null);
    }
  });
}

function trustedActiveRadio(value) {
  if (!value || value.owner !== 'server-mpd-current' || value.active !== true || value.kind !== 'radio') return null;
  const url = normalizeLiveRadioStreamUrl(value.url);
  if (!url) return null;
  const streamKey = text(value.streamKey).slice(0, 512) || url.toString();
  return { url, streamKey };
}

function copyEvidence(value) {
  return value && typeof value === 'object' ? { ...value } : null;
}

/**
 * Probe only the currently active, server-owned MPD radio URL. The brief
 * in-memory cache avoids re-probing a station on every diagnostics refresh,
 * while a track/stream identity change clears it immediately.
 */
export function createLiveRadioAudioProbe({
  fetchImpl = globalThis.fetch,
  validateUrl = validateLiveRadioStreamUrl,
  probeBytes = null,
  capabilities = runtimeCapabilities(),
  lookup = dnsLookup,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  const requestTimeoutMs = boundedPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS, 100, 10_000);
  const byteLimit = boundedPositiveInt(maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  const ttlMs = boundedPositiveInt(cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1, 60_000);
  const redirects = Math.max(0, Math.min(5, Number(maxRedirects) || 0));
  const inspectBytes = typeof probeBytes === 'function'
    ? probeBytes
    : probeLiveRadioBytes({ timeoutMs: requestTimeoutMs, maxBytes: byteLimit });
  const cache = new Map();
  const inflight = new Map();
  let activeStreamIdentity = '';
  let activeGeneration = 0;

  const checkedUrl = async (value) => validateUrl(value, { lookup });

  const get = async (playback) => {
    const active = trustedActiveRadio(playback);
    if (!active || typeof fetchImpl !== 'function') return null;

    const streamIdentity = `${active.streamKey}\n${active.url.toString()}`;
    if (activeStreamIdentity !== streamIdentity) {
      cache.clear();
      activeStreamIdentity = streamIdentity;
      activeGeneration += 1;
    }

    const key = active.url.toString();
    const generation = activeGeneration;
    const inflightKey = `${generation}\n${key}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return copyEvidence(cached.value);
    if (inflight.has(inflightKey)) return inflight.get(inflightKey).then(copyEvidence);

    const task = (async () => {
      let initialUrl;
      try {
        initialUrl = await checkedUrl(active.url.toString());
      } catch {
        return null;
      }

      try {
        capabilities?.assertExternalRead?.('live-radio-audio.probe');
      } catch {
        return null;
      }

      const sample = await fetchBoundedLiveStream({
        initialUrl,
        fetchImpl,
        validateUrl: checkedUrl,
        maxBytes: byteLimit,
        maxRedirects: redirects,
        timeoutMs: requestTimeoutMs,
      });
      if (!sample) return null;

      const headers = headerEvidence(sample.response);
      let ffprobe = null;
      if (sample.bytes.length) {
        try { ffprobe = await inspectBytes(sample.bytes); } catch {}
      }
      return mergeLiveEvidence(headers, ffprobe);
    })().then((value) => {
      if (activeGeneration === generation) {
        cache.set(key, { expiresAt: now() + ttlMs, value: copyEvidence(value) });
      }
      return value;
    }).finally(() => inflight.delete(inflightKey));

    inflight.set(inflightKey, task);
    return task.then(copyEvidence);
  };

  return { get };
}
