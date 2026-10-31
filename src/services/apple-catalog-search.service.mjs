const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_POSITIVE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_NEGATIVE_TTL_MS = 1000 * 60 * 10;
const DEFAULT_BACKOFF_MS = 1000 * 60;
const MAX_BACKOFF_MS = 1000 * 60 * 45;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_INPUT_LENGTH = 256;

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(value) {
  return normalized(String(value || '').split(/\bfeat\.?\b|\bfeaturing\b|\bwith\b|,|&|\band\b|\bx\b|\+/i)[0]);
}

function titleTokens(value) {
  return new Set(normalized(value).split(' ').filter((token) => token.length > 2));
}

function structuralTitleNumbers(value) {
  const source = text(value).toLowerCase();
  const values = new Set();
  const pattern = /\b(?:no\.?|number|op\.?|opus|part|movement)\s*(\d+|i{1,3}|iv|v|vi{0,3}|ix|x)\b/gi;
  let match;
  while ((match = pattern.exec(source))) values.add(match[1].toLowerCase());
  return values;
}

function safeStorefront(value) {
  const storefront = text(value).toLowerCase();
  return /^[a-z]{2}$/.test(storefront) ? storefront : 'us';
}

function safeAppleMusicUrl(value) {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname !== 'music.apple.com' && !parsed.hostname.endsWith('.music.apple.com')) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function safeArtworkUrl(value) {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname !== 'mzstatic.com' && !parsed.hostname.endsWith('.mzstatic.com')) return '';
    return parsed.toString()
      .replace(/\{w\}|%7bw%7d/gi, '600')
      .replace(/\{h\}|%7bh%7d/gi, '600')
      .replace(/\{f\}|%7bf%7d/gi, 'jpg');
  } catch {
    return '';
  }
}

function retryAfterMs(value, nowMs) {
  const raw = text(value);
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}

function catalogCandidate(item) {
  const attributes = item && typeof item === 'object' ? item.attributes || {} : {};
  const album = item?.relationships?.albums?.data?.[0]?.attributes || {};
  const trackUrl = safeAppleMusicUrl(attributes.url);
  const albumUrl = safeAppleMusicUrl(album.url);
  const artwork = safeArtworkUrl(attributes.artwork?.url);
  const released = text(attributes.releaseDate);
  return {
    url: artwork,
    album: text(attributes.albumName),
    year: /^\d{4}/.test(released) ? released.slice(0, 4) : '',
    trackUrl,
    albumUrl,
    matchedArtist: text(attributes.artistName),
    matchedTitle: text(attributes.name),
    reason: 'ok:catalog-search',
    matched: Boolean(trackUrl || artwork),
  };
}

function empty(reason) {
  return {
    url: '',
    album: '',
    year: '',
    trackUrl: '',
    albumUrl: '',
    matchedArtist: '',
    matchedTitle: '',
    reason,
    matched: false,
  };
}

/**
 * Conservatively compare the primary credited artist while allowing common
 * feature/ensemble suffixes. The Catalog result still must separately pass
 * title matching before Sonuvi can display it as an accepted radio identity.
 */
export function appleCatalogArtistMatches(expected, candidate) {
  const left = primaryArtist(expected);
  const right = primaryArtist(candidate);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

/** Accept exact title matches and unambiguous edit/subtitle extensions only. */
export function appleCatalogTitleMatches(expected, candidate) {
  const left = normalized(expected);
  const right = normalized(candidate);
  if (!left || !right) return false;
  const leftStructure = structuralTitleNumbers(expected);
  const rightStructure = structuralTitleNumbers(candidate);
  if (leftStructure.size && rightStructure.size
    && [...leftStructure].some((number) => !rightStructure.has(number))) return false;
  if (leftStructure.size && rightStructure.size
    && [...rightStructure].some((number) => !leftStructure.has(number))) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (leftTokens.size < 2 || rightTokens.size < 2) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(leftTokens.size, rightTokens.size) >= 0.75;
}

/**
 * Resolve a server-owned radio artist/title through Apple's authenticated
 * Catalog API. It accepts no caller-provided host or URL and exposes only
 * explicitly validated Apple Music/artwork links.
 */
export function createAppleCatalogSearchService({
  developerToken = '',
  tokenProvider = null,
  storefront = 'us',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  positiveTtlMs = DEFAULT_POSITIVE_TTL_MS,
  negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
  defaultBackoffMs = DEFAULT_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const staticToken = text(developerToken);
  const catalogStorefront = safeStorefront(storefront);
  let backoffUntil = 0;
  let backoffReason = '';

  const getCached = (key, nowMs) => {
    const cached = cache.get(key);
    if (!cached) return null;
    const ttl = cached.result.matched ? positiveTtlMs : negativeTtlMs;
    if (nowMs - cached.ts >= Math.max(0, Number(ttl) || 0)) {
      cache.delete(key);
      return null;
    }
    return { ...cached.result };
  };

  const cacheResult = (key, result, nowMs) => {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { ts: nowMs, result: { ...result } });
  };

  const getToken = async () => {
    if (staticToken) return staticToken;
    if (typeof tokenProvider !== 'function') return '';
    return text(await tokenProvider().catch(() => ''));
  };

  const resolveUncached = async ({ artist, title, key, nowMs }) => {
    const token = await getToken();
    if (!token || typeof fetchImpl !== 'function') return empty('catalog-unconfigured');

    const url = new URL(`https://api.music.apple.com/v1/catalog/${encodeURIComponent(catalogStorefront)}/search`);
    url.searchParams.set('term', `${artist} ${title}`);
    url.searchParams.set('types', 'songs');
    url.searchParams.set('limit', '10');

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) : null;
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        ...(controller ? { signal: controller.signal } : {}),
        cache: 'no-store',
        redirect: 'error',
      });
      if (response?.status === 429) {
        const requested = retryAfterMs(response.headers?.get?.('retry-after'), nowMs);
        const waitMs = Math.min(
          Math.max(1_000, requested || Math.max(1_000, Number(defaultBackoffMs) || DEFAULT_BACKOFF_MS)),
          Math.max(1_000, Number(maxBackoffMs) || MAX_BACKOFF_MS),
        );
        backoffUntil = Math.max(backoffUntil, nowMs + waitMs);
        backoffReason = '429';
        return empty('catalog-rate-limited');
      }
      if (!response?.ok) return empty('catalog-unavailable');
      const payload = await response.json().catch(() => null);
      const candidates = Array.isArray(payload?.results?.songs?.data) ? payload.results.songs.data : [];
      const matched = candidates.find((item) => appleCatalogArtistMatches(artist, item?.attributes?.artistName)
        && appleCatalogTitleMatches(title, item?.attributes?.name));
      const result = matched ? catalogCandidate(matched) : empty('catalog-no-strict-match');
      cacheResult(key, result, nowMs);
      backoffUntil = 0;
      backoffReason = '';
      return { ...result };
    } catch (error) {
      return empty(error?.name === 'AbortError' ? 'catalog-timeout' : 'catalog-unavailable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const lookup = async ({ artist = '', title = '' } = {}) => {
    const normalizedArtist = text(artist);
    const normalizedTitle = text(title);
    if (!normalizedArtist || !normalizedTitle || normalizedArtist.length > MAX_INPUT_LENGTH || normalizedTitle.length > MAX_INPUT_LENGTH) {
      return empty('catalog-invalid-input');
    }
    const key = `${normalized(normalizedArtist)}|${normalized(normalizedTitle)}`;
    const nowMs = Number(now());
    const cached = getCached(key, nowMs);
    if (cached) return cached;
    if (backoffUntil > nowMs) {
      const seconds = Math.max(1, Math.ceil((backoffUntil - nowMs) / 1000));
      return empty(`catalog-backoff-active:${seconds}s:${backoffReason || 'rate-limited'}`);
    }
    if (pending.has(key)) return pending.get(key);
    const work = resolveUncached({ artist: normalizedArtist, title: normalizedTitle, key, nowMs });
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };

  return {
    lookup,
    clear: () => {
      cache.clear();
      backoffUntil = 0;
      backoffReason = '';
    },
    getState: () => ({ cacheEntries: cache.size, pending: pending.size, backoffUntil }),
  };
}
