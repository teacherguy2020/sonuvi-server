/*
 * Canonical now-playing art contract.
 *
 * Current-art surfaces should use this module instead of choosing between
 * albumArtUrl, altArtUrl, stationLogoUrl, and displayArtUrl independently.
 * The API remains the authority for resolving and caching the source, so the
 * foreground image and blurred background cannot silently choose different
 * fallbacks.
 */
(() => {
  const root = window;
  const MOTION_ART_STORAGE_KEY = 'nowplaying.ui.motionArtEnabled';
  const motionCache = root.__nowPlayingMotionCache || {
    local: new Map(),
    apple: new Map(),
    runtimeKey: '',
    runtimeKeyPromise: null,
  };
  root.__nowPlayingMotionCache = motionCache;

  function apiBase(explicit = '') {
    const provided = String(explicit || '').trim();
    if (provided) return provided.replace(/\/+$/, '');
    if (String(root.NP_API_BASE || '').trim()) return String(root.NP_API_BASE).trim().replace(/\/+$/, '');

    const protocol = location.protocol || 'http:';
    const host = location.hostname || 'sonuvi.local';
    const port = String(location.port || '');
    // TLS belongs to the reverse proxy, never to the plain-HTTP API port.
    if (protocol === 'https:' || !port || port === '80' || port === '443') return location.origin.replace(/\/+$/, '');
    if (port === '3101') return location.origin.replace(/\/+$/, '');
    const target = new URL(location.origin);
    target.port = port === '8000' ? '3000' : '3101';
    return target.origin;
  }

  function absolute(raw, base = '') {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(?:https?:|data:|blob:)/i.test(value)) return value;
    const api = apiBase(base);
    return `${api}${value.startsWith('/') ? value : `/${value}`}`;
  }

  function isRadio(data = {}) {
    const kind = String(data?.streamKind || data?.displayMode || '').trim().toLowerCase();
    return data?.isRadio === true || kind === 'radio' || kind === 'stream-radio';
  }

  function trackUrl(raw, file = '', base = '') {
    const value = String(raw || '').trim();
    const track = String(file || '').trim();
    // Proxy known-track HTTP artwork through the existing API on HTTPS pages.
    if (location.protocol === 'https:' && /^http:\/\//i.test(value) && track) {
      return `${apiBase(base)}/art/track_640.jpg?file=${encodeURIComponent(track)}`;
    }
    return absolute(value, base);
  }

  function isUpnp(data = {}) {
    const kind = String(data?.streamKind || '').trim().toLowerCase();
    const source = String(data?.source || data?.animatedArt?.source || '').trim().toLowerCase();
    return data?.isUpnp === true
      || kind === 'upnp'
      || source === 'upnp-sonuvi'
      || source === 'external-upnp';
  }

  function source(data = {}, options = {}) {
    const head = options.head || data?.__queueHead || null;
    const podcast = !!data?.isPodcast || /\/podcasts?\//i.test(String(data?.file || ''));
    const candidates = podcast && head?.thumbUrl
      ? [head.thumbUrl, data.displayArtUrl, data.albumArtUrl, data.altArtUrl, data.stationLogoUrl]
      : [data.displayArtUrl, data.albumArtUrl, data.altArtUrl, data.stationLogoUrl, head?.thumbUrl];
    return candidates.map((x) => String(x || '').trim()).find(Boolean) || '';
  }

  function currentUrl(raw, base = '') {
    const api = apiBase(base);
    const value = String(raw || '').trim();
    if (!value) return `${api}/art/current.jpg`;
    if (/^data:|^blob:/i.test(value)) return value;

    // Let the API proxy/cache every normal current-track source. This also
    // handles moOde-relative coverart, radio-logo?file=..., and external
    // Apple/RSS art consistently across all clients.
    return `${api}/art/current.jpg?v=${encodeURIComponent(value)}`;
  }

  function foreground(data = {}, options = {}) {
    const value = source(data, options);
    return currentUrl(value, options.base);
  }

  function background(data = {}, options = {}) {
    const api = apiBase(options.base);
    const value = source(data, options);
    return value
      ? `${api}/art/current_bg_640_blur.jpg?v=${encodeURIComponent(value)}`
      : `${api}/art/current_bg_640_blur.jpg`;
  }

  function stationLogo(data = {}, options = {}) {
    const api = apiBase(options.base);
    const file = String(data?.file || '').trim();
    if (isRadio(data) && file) {
      return `${api}/art/radio-logo.jpg?file=${encodeURIComponent(file)}&v=20260924-radio-art2`;
    }
    const value = String(data?.stationLogoUrl || (isRadio(data) ? data?.altArtUrl : '') || '').trim();
    return absolute(value, options.base);
  }

  function appleMusicUrl(data = {}) {
    return String(
      data?.radioAppleMusicUrl ||
      data?.shareUrl ||
      data?.radioTrackUrl ||
      data?.radioItunesUrl ||
      data?.itunesUrl ||
      data?.animatedArt?.appleMusicUrl ||
      data?.appleMusicUrl ||
      data?.appleUrl ||
      ''
    ).trim();
  }

  // Display-only normalization. Keep raw artist metadata untouched for
  // lookup/search purposes, but make all current-track surfaces agree when a
  // provider sends an all-caps or all-lowercase artist name.
  function titleCaseArtist(input) {
    const value = String(input || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) return '';

    const preserve = new Set([
      'AC/DC', 'ABBA', 'BTS', 'DJ', 'MC', 'M.C.', 'R.E.M.', 'SZA', 'U2', 'UB40',
      'NPR', 'BBC', 'PBS', 'CBS', 'NBC', 'ABC', 'CNN', 'ESPN', 'MLB', 'NFL', 'NBA',
    ]);
    const words = value.split(/(\s+)/);
    const needsNormalization = !(/[a-zà-öø-ÿ]/.test(value) && /[A-ZÀ-ÖØ-Þ]/.test(value)) ||
      !(/[A-ZÀ-ÖØ-Þ]/.test(value) && /[a-zà-öø-ÿ]/.test(value)) ||
      words.some((word) => /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’.-]{2,}$/.test(word));
    if (!needsNormalization) return value;

    const titleWord = (word) => {
      if (!word) return word;
      if (preserve.has(word.toUpperCase())) return word.toUpperCase();
      if (/^(?:[A-ZÀ-ÖØ-Þ]\.){2,}$/i.test(word)) return word.toUpperCase();

      const lower = word.toLocaleLowerCase();
      const cased = lower.replace(/(^|[-–—'’])([a-zà-öø-ÿ])/gi, (_, prefix, ch) => `${prefix}${ch.toLocaleUpperCase()}`);
      const digitLead = cased.replace(/^(\d+)([a-zà-öø-ÿ])/, (_, digits, ch) => `${digits}${ch.toLocaleUpperCase()}`);
      return digitLead.replace(/^mc([a-zà-öø-ÿ])/i, (_, ch) => `Mc${ch.toLocaleUpperCase()}`);
    };

    return words.map((word) => /^\s+$/.test(word) ? word : titleWord(word)).join('');
  }

  function motionArtEnabled() {
    try {
      const v = String(localStorage.getItem(MOTION_ART_STORAGE_KEY) || '').trim().toLowerCase();
      if (!v) return true;
      return !['0', 'false', 'off', 'no'].includes(v);
    } catch {
      return true;
    }
  }

  function normalizeAppleMusicUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    try {
      const u = new URL(value);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return value.split('?')[0].split('#')[0];
    }
  }

  async function runtimeKey(base = '') {
    if (motionCache.runtimeKey) return motionCache.runtimeKey;
    if (motionCache.runtimeKeyPromise) return motionCache.runtimeKeyPromise;
    const api = apiBase(base);
    motionCache.runtimeKeyPromise = fetch(`${api}/config/runtime`, { cache: 'no-store' })
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        motionCache.runtimeKey = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
        return motionCache.runtimeKey;
      })
      .catch(() => '')
      .finally(() => { motionCache.runtimeKeyPromise = null; });
    return motionCache.runtimeKeyPromise;
  }

  function cachedMotion(map, key) {
    const item = map.get(key);
    if (!item) return null;
    if (item.state === 'ready') return String(item.value || '');
    if (item.state === 'pending' && item.promise) return item.promise;
    if (item.state === 'none' && Number(item.retryAt || 0) > Date.now()) return '';
    map.delete(key);
    return null;
  }

  async function resolveLocalMotionMp4(artist, album, base = '') {
    const a = String(artist || '').trim();
    const b = String(album || '').trim();
    if (!a || !b) return '';
    const key = `${a.toLowerCase()}|${b.toLowerCase()}`;
    const cached = cachedMotion(motionCache.local, key);
    if (cached !== null) return cached;

    const api = apiBase(base);
    const promise = (async () => {
      try {
        const keyHeader = await runtimeKey(api);
        const headers = keyHeader ? { 'x-track-key': keyHeader } : {};
        const url = `${api}/config/library-health/animated-art/lookup?artist=${encodeURIComponent(a)}&album=${encodeURIComponent(b)}`;
        const r = await fetch(url, { headers, cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        const mp4 = String(j?.hit?.mp4 || '').trim();
        if (mp4) {
          motionCache.local.set(key, { state: 'ready', value: mp4 });
          return mp4;
        }
        motionCache.local.set(key, { state: 'none', retryAt: Date.now() + 30000 });
        return '';
      } catch {
        motionCache.local.set(key, { state: 'none', retryAt: Date.now() + 15000 });
        return '';
      }
    })();
    motionCache.local.set(key, { state: 'pending', promise });
    return promise;
  }

  async function resolveMotionMp4(appleUrl, base = '') {
    const normalized = normalizeAppleMusicUrl(appleUrl);
    if (!normalized) return '';
    const cached = cachedMotion(motionCache.apple, normalized);
    if (cached !== null) return cached;

    const promise = (async () => {
      let centralLookupFailed = false;
      try {
        const api = apiBase(base);
        const keyHeader = await runtimeKey(api);
        const headers = keyHeader ? { 'x-track-key': keyHeader } : {};
        const endpoint = `${api}/config/library-health/animated-art/radio-lookup?url=${encodeURIComponent(normalized)}`;
        const r = await fetch(endpoint, { headers, cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json().catch(() => ({}));
        const mp4 = String(j?.hit?.mp4 || '').trim();
        if (mp4) {
          motionCache.apple.set(normalized, { state: 'ready', value: mp4 });
          return mp4;
        }
        motionCache.apple.set(normalized, { state: 'none', retryAt: Date.now() + 30000 });
        return '';
      } catch {
        centralLookupFailed = true;
      }

      // Compatibility fallback for an unavailable/older API deployment. The
      // Pi-owned lookup remains the normal path; this prevents a transient
      // route failure from removing motion art while static art still works.
      if (centralLookupFailed) {
        try {
          const endpoint = `https://api.aritra.ovh/v1/covers?url=${encodeURIComponent(normalized)}`;
          const r = await fetch(endpoint, { cache: 'force-cache' });
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            const square = Array.isArray(j?.master_Streams?.square) ? j.master_Streams.square : [];
            const list = square.filter((x) => String(x?.uri || '').includes('.m3u8'));
            const preferred = list
              .map((x) => ({ uri: String(x?.uri || ''), width: Number(x?.width || 0), bw: Number(x?.bandwidth || 0) }))
              .filter((x) => x.uri)
              .sort((a, b) => (a.width - b.width) || (a.bw - b.bw));
            const choice = preferred.filter((x) => x.width >= 700 && x.width <= 1200).slice(-1)[0] || preferred.slice(-1)[0];
            const mp4 = String(choice?.uri || '').replace(/\.m3u8(?:\?.*)?$/i, '-.mp4');
            if (mp4 && mp4 !== choice?.uri) {
              motionCache.apple.set(normalized, { state: 'ready', value: mp4 });
              return mp4;
            }
          }
        } catch {}
      }
      motionCache.apple.set(normalized, { state: 'none', retryAt: Date.now() + 30000 });
      return '';
    })();
    motionCache.apple.set(normalized, { state: 'pending', promise });
    return promise;
  }

  async function resolveMotionFor(data = {}, options = {}) {
    if (!motionArtEnabled()) return '';
    const radio = isRadio(data);
    const upnp = isUpnp(data);
    const podcast = !!data?.isPodcast || /\/podcasts?\//i.test(String(data?.file || ''));
    const confirmedAppleUrl = String(data?.animatedArt?.appleMusicUrl || '').trim();
    if (confirmedAppleUrl) return resolveMotionMp4(confirmedAppleUrl, options.base);
    if (radio) return resolveMotionMp4(appleMusicUrl(data), options.base);
    if (podcast || data?.isAirplay || (data?.isStream && !upnp)) return '';
    return resolveLocalMotionMp4(
      data?.animatedArt?.artist || data?.artist || data?.displayArtist,
      data?.animatedArt?.album || data?.album,
      options.base,
    );
  }

  root.NPArt = Object.assign(root.NPArt || {}, {
    absolute,
    apiBase,
    appleMusicUrl,
    background,
    foreground,
    isRadio,
    isUpnp,
    motionArtEnabled,
    normalizeAppleMusicUrl,
    titleCaseArtist,
    resolveLocalMotionMp4,
    resolveMotionFor,
    resolveMotionMp4,
    source,
    stationLogo,
    trackUrl,
  });
})();
