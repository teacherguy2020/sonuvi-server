(() => {
  const $ = (id) => document.getElementById(id);
  const host = location.hostname;
  const apiPort = (location.port === '8101') ? '3101' : '3000';
  const apiBase = (!location.port || location.port === '80' || location.port === '443')
    ? location.origin
    : `${location.protocol}//${host}:${apiPort}`;

  function escHtml(v = '') {
    return String(v || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function expandInstrumentAbbrevs(input) {
    let s = String(input || '');
    if (!s) return s;

    // Targeted classical metadata shorthand: ", h;" -> ", harp;"
    s = s.replace(/,\s*h(?=\s*(?:[;,)\]]|\-|$))/gi, ', harp');

    const reps = [
      ['vc', 'cello'], ['db', 'double bass'], ['cb', 'double bass'], ['p', 'piano'], ['hp', 'harp'],
      ['ob', 'oboe'], ['eh', 'english horn'], ['cl', 'clarinet'], ['bcl', 'bass clarinet'], ['fl', 'flute'], ['f', 'flute'],
      ['hn', 'horn'], ['fh', 'horn'], ['tpt', 'trumpet'], ['tp', 'trumpet'], ['tbn', 'trombone'],
      ['tb', 'trombone'], ['tba', 'tuba'], ['perc', 'percussion'], ['timp', 'timpani'], ['vln', 'violin'],
      ['vn', 'violin'], ['vla', 'viola'], ['va', 'viola'], ['sop', 'soprano'], ['mez', 'mezzo-soprano'],
      ['ten', 'tenor'], ['bar', 'baritone'], ['bs', 'bass'],
    ];
    for (const [abbr, full] of reps) {
      const re = new RegExp(`(^|[\\s,;])${abbr}(?=\\s*(?:[;,)\\]]|\\-|$))`, 'gi');
      s = s.replace(re, `$1${full}`);
    }
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  function icon(name) {
    if (name === 'play') return '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    if (name === 'pause') return '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
    if (name === 'prev') return '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3 6 9-6v12z"/></svg>';
    if (name === 'next') return '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM7 18V6l9 6z"/></svg>';
    if (name === 'repeat') return '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H6a3 3 0 0 0-3 3v3h2V8a1 1 0 0 1 1-1zm10 10H7v-3l-4 4 4 4v-3h11a3 3 0 0 0 3-3v-3h-2v2a1 1 0 0 1-1 1z"/></svg>';
    if (name === 'shuffle') return '<svg viewBox="0 0 32 32"><path fill="currentColor" d="M24.414,16.586L30.828,23l-6.414,6.414l-2.828-2.828L23.172,25H22c-3.924,0-6.334-2.289-8.173-4.747c0.987-1.097,1.799-2.285,2.516-3.36C18.109,19.46,19.521,21,22,21h1.172l-1.586-1.586L24.414,16.586z M22,11h1.172l-1.586,1.586l2.828,2.828L30.828,9l-6.414-6.414l-2.828,2.828L23.172,7H22c-5.07,0-7.617,3.82-9.664,6.891C10.224,17.059,8.788,19,6,19H2v4h4c5.07,0,7.617-3.82,9.664-6.891C17.776,12.941,19.212,11,22,11z M10.212,15.191c0.399-0.539,1.957-2.848,2.322-3.365C10.917,10.216,8.86,9,6,9H2v4h4C7.779,13,9.007,13.797,10.212,15.191z"/></svg>';
    return '';
  }

  let runtimeTrackKey = '';
  let runtimeKeyLastAttemptMs = 0;
  const motionArtCache = new Map();
  const localMotionCache = new Map();
  const MOTION_ART_STORAGE_KEY = 'nowplaying.ui.motionArtEnabled';
  let lastMotionIdentity = '';
  let lastMotionMp4 = '';
  let lastMotionFile = '';
  let lastKnownNowFile = '';
  let lastKnownSongId = '';
  let lastVisibleMotionSrc = '';
  let lastVisibleMotionFile = '';
  let lastMotionTrackKey = '';
  let lastRenderedTrackKey = '';
  const motionLockByTrack = new Map();
  // Shared latest queue/now-playing snapshots (used by drawer + hero refresh paths).
  let lastQ = null;
  let lastNp = null;
  const HERO_ART_BG_STORAGE_KEY = 'nowplaying.hero.artbg.v1';
  let heroArtBgEnabled = (() => {
    try { return String(localStorage.getItem(HERO_ART_BG_STORAGE_KEY) || '0') === '1'; } catch { return false; }
  })();
  function applyHeroArtBackground(trackKey = '', artSource = '', isAlexaMode = false) {
    const hostEl = document.getElementById('heroTransport');
    if (!hostEl) return;
    if (!heroArtBgEnabled) {
      try {
        hostEl.style.removeProperty('background-image');
        hostEl.style.removeProperty('background-size');
        hostEl.style.removeProperty('background-position');
        hostEl.style.removeProperty('background-repeat');
      } catch {}
      return;
    }
    const source = String(artSource || '').trim();
    // Controller pages preserve Alexa's full art URL, including its file
    // query, because the blur route needs that identity to resolve the art.
    // Normalizing it here would strip the query and lose the Alexa image.
    const artKey = (isAlexaMode && source)
      ? source
      : (artworkMediaIdentity(source) || String(trackKey || '').trim() || String(Date.now()));
    // Use the supplied art key for both normal and Alexa playback. The API
    // blurs that source server-side; this keeps Alexa's background artwork
    // correct without losing the hero's softened treatment.
    const artUrl = globalThis.NPArt?.background({ displayArtUrl: source }, { base: apiBase }) ||
      `${apiBase}/art/current_bg_640_blur.jpg?v=${encodeURIComponent(artKey)}`;
    try {
      hostEl.style.setProperty('background-image', `linear-gradient(rgba(5,10,18,0.28), rgba(5,10,18,0.28)), url("${artUrl}")`, 'important');
      hostEl.style.setProperty('background-size', 'cover', 'important');
      hostEl.style.setProperty('background-position', 'center', 'important');
      hostEl.style.setProperty('background-repeat', 'no-repeat', 'important');
    } catch {}
  }

  function currentKey() {
    // Prefer runtime-fetched key over any stale UI field value.
    return runtimeTrackKey || String($('key')?.value || '').trim();
  }

  async function ensureRuntimeKey(force = false) {
    if (!force && currentKey()) return;
    const now = Date.now();
    if (!force && runtimeKeyLastAttemptMs && (now - runtimeKeyLastAttemptMs) < 3000) return;
    runtimeKeyLastAttemptMs = now;
    try {
      const r = await fetch(`${apiBase}/config/runtime`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      const k = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
      if (k) runtimeTrackKey = k;
    } catch {}
  }

  async function playback(action, key, payload = {}) {
    const r = await fetch(`${apiBase}/config/diagnostics/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-track-key': key } : {}) },
      body: JSON.stringify({ action, ...(payload || {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  }

  async function loadQueueState(key) {
    const r = await fetch(`${apiBase}/config/diagnostics/queue`, { headers: key ? { 'x-track-key': key } : {} });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  }

  async function loadNowPlaying(key) {
    const r = await fetch(`${apiBase}/now-playing`, { headers: key ? { 'x-track-key': key } : {} });
    if (!r.ok) return {};
    return await r.json().catch(() => ({}));
  }

  async function loadAlexaWasPlaying() {
    try {
      // Use the rich lifecycle payload here: the semantic alias is intentionally
      // lightweight and does not carry albumArtUrl/displayArtUrl.
      const r = await fetch(`${apiBase}/alexa/was-playing?maxAgeMs=21600000`, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } catch {
      return null;
    }
  }

  async function readAlexaControlSnapshot() {
    const result = await loadAlexaWasPlaying();
    const nowPlaying = result?.nowPlaying || {};
    const wasPlaying = result?.wasPlaying || {};
    const payload = nowPlaying.file ? nowPlaying : wasPlaying;
    return {
      modeActive: !!(nowPlaying.modeActive || wasPlaying.modeActive),
      active: !!payload?.active,
      file: String(payload?.file || '').trim(),
      updatedAt: Number(payload?.updatedAt || wasPlaying?.updatedAt || nowPlaying?.updatedAt || 0) || 0,
    };
  }

  async function waitForAlexaControl(control, before) {
    const started = Date.now();
    while ((Date.now() - started) < 20000) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const current = await readAlexaControlSnapshot();
      if (!current.modeActive) throw new Error('Alexa Mode is no longer active.');
      const changed = current.updatedAt > before.updatedAt || current.file !== before.file;
      if (control === 'pause' && !current.active && (changed || !before.active)) return current;
      if (control === 'resume' && current.active && (changed || !before.active)) return current;
      if (control === 'next' && current.active && changed) return current;
    }
    throw new Error('Alexa did not confirm ' + control + '.');
  }

  function normalizeAppleMusicUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return s.split('?')[0].split('#')[0];
    }
  }

  function stripUrlNoise(s) {
    if (!s) return '';
    try {
      const u = new URL(s, window.location.href);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return String(s).split('?')[0].split('#')[0];
    }
  }

  function canonicalMediaSrc(s) {
    const clean = stripUrlNoise(s);
    if (!clean) return '';
    try {
      const u = new URL(clean, window.location.href);
      return `${u.origin}${u.pathname}`;
    } catch {
      return clean;
    }
  }

  // Qobuz artwork is served through the current-art proxy with an opaque
  // fingerprint. Preserve that marker in display identity checks so a new
  // cover triggers a repaint even when the proxy path and MPD song id stay
  // the same.
  function artworkMediaIdentity(source) {
    const value = String(source || '').trim();
    if (!value) return '';
    try {
      const outer = new URL(value, window.location.href);
      const isCurrentArt = (url) => /^\/art\/current(?:_320)?\.jpg$/i.test(url.pathname);
      const marker = (url) => {
        if (!isCurrentArt(url)) return '';
        const version = String(url.searchParams.get('qobuz') || '').trim();
        return /^[a-f0-9]{16}$/i.test(version) ? version.toLowerCase() : '';
      };
      let qobuzVersion = marker(outer);
      if (!qobuzVersion && isCurrentArt(outer)) {
        const nestedReference = outer.searchParams.get('v');
        if (nestedReference) {
          qobuzVersion = marker(new URL(nestedReference, outer.origin));
        }
      }
      const base = canonicalMediaSrc(value);
      return qobuzVersion ? `${base}?qobuz=${qobuzVersion}` : base;
    } catch {
      return canonicalMediaSrc(value);
    }
  }

  function motionArtEnabled() {
    try {
      const v = String(localStorage.getItem(MOTION_ART_STORAGE_KEY) || '').trim().toLowerCase();
      if (!v) return true;
      return !(['0', 'false', 'off', 'no'].includes(v));
    } catch {
      return true;
    }
  }

  function motionTrackKey(file = '', songid = '', identity = '') {
    const explicit = String(identity || '').trim();
    if (explicit) return `a:${explicit}`;
    const f = String(file || '').trim();
    if (f) return `f:${f}`;
    const s = String(songid || '').trim();
    if (s) return `s:${s}`;
    return '';
  }

  async function resolveLocalMotionMp4(artist, album, key) {
    if (globalThis.NPArt?.resolveLocalMotionMp4) {
      return globalThis.NPArt.resolveLocalMotionMp4(artist, album, apiBase);
    }
    const a = String(artist || '').trim();
    const b = String(album || '').trim();
    const k = `${a.toLowerCase()}|${b.toLowerCase()}`;
    if (!a || !b) return '';
    if (localMotionCache.has(k)) return String(localMotionCache.get(k) || '');
    try {
      const url = `${apiBase}/config/library-health/animated-art/lookup?artist=${encodeURIComponent(a)}&album=${encodeURIComponent(b)}`;
      const requestKey = currentKey();
      const r = await fetch(url, { headers: requestKey ? { 'x-track-key': requestKey } : {} });
      const j = await r.json().catch(() => ({}));
      const mp4 = String(j?.hit?.mp4 || '').trim();
      // Cache only positive hits so transient misses/auth races can retry on next refresh.
      if (mp4) localMotionCache.set(k, mp4);
      return mp4;
    } catch {
      return '';
    }
  }

  async function resolveMotionMp4(appleUrl) {
    if (globalThis.NPArt?.resolveMotionMp4) {
      return globalThis.NPArt.resolveMotionMp4(appleUrl);
    }
    const normalized = normalizeAppleMusicUrl(appleUrl);
    if (!normalized) return '';
    const cached = motionArtCache.get(normalized);
    if (cached?.state === 'ready') return String(cached.mp4 || '');
    if (cached?.state === 'none') return '';
    if (cached?.state === 'pending' && cached.promise) return cached.promise;

    const p = (async () => {
      try {
        const endpoint = `https://api.aritra.ovh/v1/covers?url=${encodeURIComponent(normalized)}`;
        const r = await fetch(endpoint, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json().catch(() => ({}));
        const square = Array.isArray(j?.master_Streams?.square) ? j.master_Streams.square : [];
        const list = square.filter((x) => String(x?.uri || '').includes('.m3u8'));
        if (!list.length) {
          motionArtCache.set(normalized, { state: 'none' });
          return '';
        }

        // Prefer mid/high square sizes (avoid huge 2k+ assets by default).
        const preferred = list
          .map((x) => ({
            uri: String(x?.uri || ''),
            width: Number(x?.width || 0),
            bw: Number(x?.bandwidth || 0),
          }))
          .filter((x) => x.uri)
          .sort((a, b) => (a.width - b.width) || (a.bw - b.bw));
        const choice = preferred.filter((x) => x.width >= 700 && x.width <= 1200).slice(-1)[0] || preferred.slice(-1)[0];
        const mp4 = String(choice?.uri || '').replace(/\.m3u8(?:\?.*)?$/i, '-.mp4');
        if (!mp4 || mp4 === choice.uri) {
          motionArtCache.set(normalized, { state: 'none' });
          return '';
        }
        motionArtCache.set(normalized, { state: 'ready', mp4 });
        return mp4;
      } catch {
        motionArtCache.set(normalized, { state: 'none' });
        return '';
      }
    })();

    motionArtCache.set(normalized, { state: 'pending', promise: p });
    return p;
  }

  function updateHeroDynamic(el, q, np = {}) {
    const state = String(q?.playbackState || '').toLowerCase();
    const pp = state === 'playing' ? 'pause' : 'play';
    const randomOn = !!q?.randomOn;
    const repeatOn = !!q?.repeatOn;

    const big = el.querySelector('.heroTransportControls .tbtnBig');
    if (big) {
      big.classList.toggle('on', state === 'playing');
      big.setAttribute('data-a', pp);
      big.setAttribute('title', pp);
      big.innerHTML = icon(pp);
      if (state === 'playing') big.style.setProperty('--spin-delay', `-${Date.now() % 5600}ms`);
      else big.style.removeProperty('--spin-delay');
    }
    const shuf = el.querySelector('.heroTransportControls .tbtnFar[data-a="shuffle"]');
    if (shuf) shuf.classList.toggle('on', randomOn);
    const rep = el.querySelector('.heroTransportControls .tbtnFar[data-a="repeat"]');
    if (rep) rep.classList.toggle('on', repeatOn);

    const isRadioOrStream = !!np?.isRadio || !!np?.isStream;
    const elapsed = Number(np?.elapsed ?? q?.elapsed ?? q?.elapsedSec ?? 0);
    const duration = Number(np?.duration ?? q?.duration ?? q?.durationSec ?? 0);
    const showProgress = !isAlexaMode && !isRadioOrStream && Number.isFinite(duration) && duration > 0;
    const pct = showProgress ? Math.max(0, Math.min(100, (elapsed / duration) * 100)) : 0;
    const bar = el.querySelector('.progress-bar-wrapper');
    if (bar) {
      bar.classList.toggle('is-hidden', !showProgress);
      bar.setAttribute('data-seekable', showProgress ? '1' : '0');
      const fill = bar.querySelector('.progress-fill');
      if (fill) fill.style.transform = `scaleX(${pct / 100})`;
      const handle = bar.querySelector('.progress-handle');
      if (handle) handle.style.left = `${pct}%`;
      const tip = bar.querySelector('.progress-tip');
      if (tip) tip.style.left = `${pct}%`;
    }
  }

  function renderAlexaTransportControls(np, randomOn) {
    const alexaPlaying = np?.active !== false;
    const alexaAction = alexaPlaying ? 'pause' : 'play';
    return '<div class="heroTransportControls alexaTransportControls" style="margin-top:4px;">' +
      '<button class="tbtn tbtnFar" data-a="shuffle" title="Shuffle queue">' + icon('shuffle') + '</button>' +
      '<button class="tbtn tbtnBig ' + (alexaPlaying ? 'on' : '') + '" data-a="' + alexaAction + '" title="' + alexaAction + '">' + icon(alexaAction) + '</button>' +
      '<button class="tbtn tbtnNear" data-a="next" title="Next">' + icon('next') + '</button>' +
      '</div>';
  }

  function render(el, q, np = {}) {
    const prevVid = el.querySelector('.heroArtVid');
    const prevVidSrc = prevVid ? String(prevVid.currentSrc || prevVid.src || '').trim() : '';
    const prevVidTime = prevVid ? Number(prevVid.currentTime || 0) : 0;
    const prevArtNode = el.querySelector('.heroArt');
    const prevArtMedia = prevArtNode?.querySelector?.('video.heroArtVid, img:not(.heroArtFallback)');
    const prevArtSrc = prevArtMedia ? artworkMediaIdentity(String(prevArtMedia.currentSrc || prevArtMedia.src || '').trim()) : '';
    const prevArtTrackKey = String(prevArtNode?.getAttribute?.('data-track-key') || '').trim();
    const prevArtAlbumKey = String(prevArtNode?.getAttribute?.('data-album-key') || '').trim();

    const items = Array.isArray(q?.items) ? q.items : [];
    const head = items.find((x) => !!x?.isHead) || items[0] || null;
    const state = String(q?.playbackState || '').toLowerCase();
    const pp = state === 'playing' ? 'pause' : 'play';
    const randomOn = !!q?.randomOn;
    const repeatOn = !!q?.repeatOn;

    const npArt = globalThis.NPArt?.source(np, { head }) ||
      String(np?.albumArtUrl || np?.altArtUrl || np?.stationLogoUrl || '').trim();
    const headArt = String(head?.thumbUrl || '').trim();
    const rawThumb = npArt || headArt;
    const incomingTrackKey = String(np?.songid || np?.file || head?.file || '').trim();
    const thumb = rawThumb
      ? (npArt
          ? (globalThis.NPArt?.foreground(np, { base: apiBase, head }) || (rawThumb.startsWith('http') ? rawThumb : `${apiBase}${rawThumb}`))
          : (rawThumb.startsWith('http') ? rawThumb : `${apiBase}${rawThumb}`))
      : ((incomingTrackKey && prevArtTrackKey && incomingTrackKey === prevArtTrackKey && prevArtSrc)
          ? prevArtSrc
          : '');
    const motionMp4 = String(np?._motionMp4 || '').trim();

    const isAlexaMode = !!np?.alexaMode;
    const isYoutube = !!(np?.isYoutube || head?.isYoutube || /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(String(np?.file || head?.file || '')));
    const isRadioOrStream = !!np?.isRadio || (!!np?.isStream && !isYoutube) || (!!head?.isStream && !isYoutube) || isAlexaMode;
    let displayArtist = String(np?._radioDisplay?.artist || np?.displayArtist || np?.radioArtist || np?.artist || head?.artist || '').trim();
    let displayTitle = String(np?._radioDisplay?.title || np?.radioTitle || np?.title || head?.title || '').trim();
    if (!displayTitle) {
      const fileRaw = String(np?.file || head?.file || '').trim();
      const base = fileRaw ? fileRaw.split('/').pop() || '' : '';
      const noExt = base.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
      if (noExt) displayTitle = noExt;
    }

    if (isRadioOrStream) {
      const isGenericArtist = /^(radio\s*station|unknown|stream)$/i.test(displayArtist);
      const lookupReason = String(np?.radioLookupReason || '').toLowerCase();

      if (isGenericArtist && lookupReason.includes('talk-news-sports')) {
        displayArtist = 'Talk radio';
      }

      // Avoid "Radio station • Radio station ..." duplication.
      if (isGenericArtist) {
        displayTitle = displayTitle.replace(/^radio\s*station\s*/i, '').trim();
      }

      if (!isAlexaMode) {
        // If iTunes album text got echoed into title, trim it from the end.
        const radioAlbumForTrim = String(np?.radioAlbum || np?.album || '').trim();
        if (radioAlbumForTrim) {
          const esc = radioAlbumForTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          displayTitle = displayTitle.replace(new RegExp(`([\\s,;:-]*)${esc}$`, 'i'), '').trim();
        }

        // Strip trailing year-like tails from title (year is shown separately when needed).
        displayTitle = displayTitle.replace(/[\s•\-–—,;:]*((19|20)\d{2})\s*$/i, '').trim();
      }
    }

    displayArtist = expandInstrumentAbbrevs(displayArtist);
    displayTitle = expandInstrumentAbbrevs(displayTitle);
    displayArtist = globalThis.NPArt?.titleCaseArtist
      ? globalThis.NPArt.titleCaseArtist(displayArtist)
      : displayArtist;

    const appleUrl = globalThis.NPArt?.appleMusicUrl(np) || String(np?.shareUrl || np?.radioTrackUrl || np?.radioItunesUrl || np?.itunesUrl || np?.radioAppleMusicUrl || '').trim();
    const isPodcast = !!np?.isPodcast;
    const text = isPodcast
      ? (displayTitle || displayArtist || 'Nothing playing')
      : ((displayArtist || displayTitle)
        ? `${displayArtist}${displayArtist && displayTitle ? ' • ' : ''}${displayTitle}`
        : 'Nothing playing');
    const isLibraryTrack = ((!np?.isStream && !np?.isRadio && !isPodcast) || isAlexaMode);
    const modalAlbum = String(np?.album || head?.album || '').trim();
    const modalArtist = String(np?.artist || head?.artist || '').trim();
    const artAlbumKey = (!isRadioOrStream && modalAlbum)
      ? `${String(modalArtist || '').trim().toLowerCase()}|${String(modalAlbum || '').trim().toLowerCase()}`
      : '';
    const modalArtRaw = globalThis.NPArt?.source(np, { head }) ||
      String(np?.albumArtUrl || np?.altArtUrl || head?.thumbUrl || '').trim();
    const modalArt = modalArtRaw
      ? (globalThis.NPArt?.foreground(np, { base: apiBase, head }) || (modalArtRaw.startsWith('http') ? modalArtRaw : `${apiBase}${modalArtRaw}`))
      : '';
    const canOpenAlbumModal = !appleUrl && isLibraryTrack && !isRadioOrStream && !!modalAlbum;
    const rating = Math.max(0, Math.min(5, Number(np?.rating ?? head?.rating ?? 0) || 0));
    const ratingFile = String(np?.ratingFile || np?.file || head?.file || '').trim();
    const currentPlaylistBtn = (isLibraryTrack && ratingFile)
      ? `<button type="button" class="heroCurrentPlaylistBtn" data-hero-current-playlist="1" data-hero-current-playlist-file="${encodeURIComponent(ratingFile)}" title="Add currently playing track to playlist" aria-label="Add currently playing track to playlist"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2zm13-1v-3h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/></svg></button>`
      : '';
    const starsRow = (isLibraryTrack && ratingFile)
      ? `<div class="heroRating" aria-label="Rating">${[1,2,3,4,5].map((i)=>`<button type="button" class="heroRateStar ${i<=rating?'on':'off'}" data-hero-rate-file="${encodeURIComponent(ratingFile)}" data-hero-rate-val="${i}" title="Rate ${i} star${i>1?'s':''}">★</button>`).join('')}${currentPlaylistBtn}</div>`
      : '';

    const radioAlbum = String(np?.radioAlbum || np?.album || '').trim();
    let radioYear = String(np?.radioYear || np?.year || '').trim();
    if (!radioYear && isAlexaMode) {
      const d = String(np?.date || '').trim();
      const m = d.match(/^(\d{4})/);
      if (m) radioYear = m[1];
    }
    const stationNameLive = String(np?._stationName || np?.stationName || np?.radioStationName || head?.stationName || '').trim();
    const airplaySource = String(np?.airplaySource || np?.airplaySourceName || np?.airplaySender || '').trim();
    const isAirplay = !!np?.isAirplay;
    const liveLabel = isAlexaMode
      ? 'Alexa Mode'
      : (isAirplay ? (airplaySource ? `AirPlay • ${airplaySource}` : 'AirPlay') : (isYoutube ? 'YouTube Audio Stream' : (stationNameLive || 'Radio')));
    const albumYearText = radioAlbum
      ? `${radioAlbum}${radioYear ? ` (${radioYear})` : ''}`
      : '';
    const metaRow = starsRow
      ? starsRow
      : (albumYearText ? `<div class="heroSubline" style="color:var(--theme-text-secondary,#9fb1d9)">${albumYearText}</div>` : '');

    const fmt = String(np?.encoded || np?.format || '').toUpperCase();
    const brRaw = String(np?.bitrate || '').trim();
    const brMatch = brRaw.match(/(\d+(?:\.\d+)?)/);
    const kbps = brMatch ? Number(brMatch[1]) : 0;
    const isLossless = /(FLAC|ALAC|WAV|AIFF|PCM)/i.test(fmt);
    const isOpus = /OPUS/i.test(fmt);
    const isMp3Aac = /(MP3|AAC)/i.test(fmt);
    const isHq = isLossless || (isOpus ? kbps >= 128 : (isMp3Aac ? kbps >= 320 : kbps >= 320));
    const liveBadge = isLossless ? 'Lossless' : (isHq ? 'HQ' : '');

    const elapsed = Number(np?.elapsed ?? q?.elapsed ?? q?.elapsedSec ?? head?.elapsed ?? head?.elapsedSec ?? 0);
    const duration = Number(np?.duration ?? q?.duration ?? q?.durationSec ?? head?.duration ?? head?.durationSec ?? 0);
    const showProgress = !isAlexaMode && !isRadioOrStream && Number.isFinite(duration) && duration > 0;
    const progressPct = showProgress ? Math.max(0, Math.min(100, (elapsed / duration) * 100)) : 0;
    const spinPeriodMs = 5600;
    const spinDelayStyle = state === 'playing' ? ` style="--spin-delay:-${Date.now() % spinPeriodMs}ms;"` : '';
    const artTrackKey = String(np?.songid || np?.file || `${displayArtist}|${displayTitle}` || '').trim();
    el.innerHTML =
      `${appleUrl
        ? `<a class="heroArt heroArtLink" data-track-key="${escHtml(artTrackKey)}" data-album-key="${escHtml(artAlbumKey)}" data-art-src="${escHtml(thumb || '')}" href="${escHtml(appleUrl)}" target="_blank" rel="noopener noreferrer" title="Open in Apple Music">${motionMp4
            ? `${thumb ? `<img class="heroArtFallback" src="${thumb}" alt="">` : '<div class="heroArtPh heroArtFallback"></div>'}<video class="heroArtVid" src="${motionMp4}" data-fallback-src="${thumb}" autoplay muted loop playsinline preload="metadata"></video>`
            : (thumb ? `<img src="${thumb}" alt="">` : '<div class="heroArtPh"></div>')}</a>`
        : `<div class="heroArt" data-track-key="${escHtml(artTrackKey)}" data-album-key="${escHtml(artAlbumKey)}" data-art-src="${escHtml(thumb || '')}">${motionMp4
            ? `${thumb ? `<img class="heroArtFallback" src="${thumb}" alt="">` : '<div class="heroArtPh heroArtFallback"></div>'}<video class="heroArtVid" src="${motionMp4}" data-fallback-src="${thumb}" autoplay muted loop playsinline preload="metadata"></video>`
            : (thumb ? `<img src="${thumb}" alt="">` : '<div class="heroArtPh"></div>')}</div>`}` +
      `<div class="heroMain">` +
        `<div class="np">` +
          (appleUrl
            ? `<a class="txt txtLink" href="${appleUrl}" target="_blank" rel="noopener noreferrer" title="Open in Apple Music">${text}</a>`
            : `<div class="txt"${canOpenAlbumModal ? ` data-hero-open-album="1" data-hero-album="${encodeURIComponent(modalAlbum)}" data-hero-artist="${encodeURIComponent(modalArtist)}" data-hero-art="${encodeURIComponent(modalArt)}" title="Open album" style="cursor:pointer;"` : ''}>${text}</div>`) +
          `${metaRow}` +
          `${isAlexaMode
            ? renderAlexaTransportControls(np, randomOn)
            : (`<div class="heroTransportControls">` +
                (isPodcast ? `<button class="tbtn tbtnSeek" data-a="seekback15" title="Back 15 seconds"><span style="font-size:13px;font-weight:700;">↺15</span></button>` : '') +
                (!isRadioOrStream ? `<button class="tbtn tbtnFar ${repeatOn ? 'on' : ''}" data-a="repeat" title="Repeat">${icon('repeat')}</button>` : '') +
                `<button class="tbtn tbtnNear" data-a="previous" title="Previous">${icon('prev')}</button>` +
                `<button class="tbtn tbtnBig ${state === 'playing' ? 'on' : ''}" data-a="${pp}" title="${pp}"${spinDelayStyle}>${icon(pp)}</button>` +
                `<button class="tbtn tbtnNear" data-a="next" title="Next">${icon('next')}</button>` +
                (!isRadioOrStream ? `<button class="tbtn tbtnFar" data-a="shuffle" title="Shuffle queue">${icon('shuffle')}</button>` : '') +
                (isPodcast ? `<button class="tbtn tbtnSeek" data-a="seekfwd30" title="Forward 30 seconds"><span style="font-size:13px;font-weight:700;">30↻</span></button>` : '') +
              `</div>` )}` +
          `<div class="progress-bar-wrapper${showProgress ? '' : ' is-hidden'}" data-seekable="${showProgress ? '1' : '0'}"><div class="progress-fill" style="transform:scaleX(${progressPct / 100})"></div><div class="progress-handle" style="left:${progressPct}%;"></div><div class="progress-tip" style="left:${progressPct}%">Drag to seek</div></div>` +
          `${(!showProgress && (isRadioOrStream || isYoutube)) ? `<div class="heroLiveLine" style="order:5;font-size:12px;line-height:1.1;color:var(--theme-text-secondary,#9fb1d9);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;margin-top:6px;">${(state === 'playing' && !isAlexaMode) ? `<span class="heroLivePulse">${isYoutube ? 'Streaming' : 'Live'}</span> • ` : ''}${escHtml(liveLabel)}${liveBadge ? ` <span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;border:1px solid rgba(251,191,36,.75);color:#fbbf24;background:rgba(251,191,36,.14);font-size:11px;font-weight:700;vertical-align:1px;">${liveBadge}</span>` : ''}</div>` : ''}` +
        `</div>` +
      `</div>`;

    applyHeroArtBackground(artTrackKey, thumb, isAlexaMode);
    pruneHeroTransportDuplicates(el);

    // Preserve already-loaded art node when source is effectively unchanged
    // (prevents visible flash on delayed repaint after tab wake / Alexa settle).
    try {
      const nextArtNode = el.querySelector('.heroArt');
      const nextArtMedia = nextArtNode?.querySelector?.('video.heroArtVid, img:not(.heroArtFallback)');
      const nextArtSrc = nextArtMedia ? artworkMediaIdentity(String(nextArtMedia.currentSrc || nextArtMedia.src || '').trim()) : '';
      const nextArtTrackKey = String(nextArtNode?.getAttribute?.('data-track-key') || '').trim();
      const nextArtAlbumKey = String(nextArtNode?.getAttribute?.('data-album-key') || '').trim();
      const prevHasMotion = !!prevArtNode?.querySelector?.('.heroArtVid');
      const nextHasMotion = !!nextArtNode?.querySelector?.('.heroArtVid');
      // Preserve art when either:
      // 1) exact same track+src, or
      // 2) same album and we already have motion but this render temporarily does not.
      //    (Do NOT block static -> motion upgrades.)
      const sameTrackSameSrc = !!(prevArtNode && nextArtNode && prevArtSrc && nextArtSrc && prevArtSrc === nextArtSrc && prevArtTrackKey && nextArtTrackKey && prevArtTrackKey === nextArtTrackKey);
      const sameAlbumRun = !!(prevArtNode && nextArtNode && prevArtAlbumKey && nextArtAlbumKey && prevArtAlbumKey === nextArtAlbumKey);
      const keepPriorMotionOnMiss = !!(sameAlbumRun && prevHasMotion && !nextHasMotion);
      if (sameTrackSameSrc || keepPriorMotionOnMiss) {
        nextArtNode.replaceWith(prevArtNode);
      }
    } catch {}

    // Preserve motion-video playback position across periodic re-renders.
    try {
      const nextVid = el.querySelector('.heroArtVid');
      if (nextVid && prevVidSrc && prevVidTime > 0.2) {
        const nextSrc = String(nextVid.currentSrc || nextVid.src || '').trim();
        if (nextSrc && nextSrc === prevVidSrc) {
          const seek = () => {
            try {
              if (Number.isFinite(nextVid.duration) && nextVid.duration > 0) {
                nextVid.currentTime = Math.min(prevVidTime, Math.max(0, nextVid.duration - 0.1));
              } else {
                nextVid.currentTime = prevVidTime;
              }
            } catch {}
          };
          if (nextVid.readyState >= 1) seek();
          else nextVid.addEventListener('loadedmetadata', seek, { once: true });
        }
      }
    } catch {}
  }

  function armVideoFallback(el) {
    const vid = el.querySelector('.heroArtVid');
    if (!(vid instanceof HTMLVideoElement)) return;
    const fb = el.querySelector('.heroArtFallback');
    const src = String(vid.currentSrc || vid.src || '').trim();

    // Keep fallback visible until video actually renders; never blank hero art.
    if (fb) fb.style.display = '';
    vid.style.display = '';

    const showFallback = () => { try { if (fb) fb.style.display = ''; vid.style.display = 'none'; } catch {} };
    const hideFallback = () => { try { if (fb) fb.style.display = 'none'; vid.style.display = ''; } catch {} };
    vid.addEventListener('loadeddata', hideFallback, { once: true });
    vid.addEventListener('playing', hideFallback, { once: true });
    vid.addEventListener('error', showFallback, { once: true });

    try {
      const p = (typeof vid.play === 'function') ? vid.play() : null;
      if (p && typeof p.catch === 'function') p.catch(() => showFallback());
    } catch { showFallback(); }

    if (src) {
      lastVisibleMotionSrc = src;
      if (lastKnownNowFile) lastVisibleMotionFile = lastKnownNowFile;
      lastMotionMp4 = src;
      if (lastKnownNowFile) lastMotionFile = lastKnownNowFile;
      const k = motionTrackKey(lastKnownNowFile, lastKnownSongId);
      if (k) {
        lastMotionTrackKey = k;
        motionLockByTrack.set(k, src);
        if (motionLockByTrack.size > 100) {
          const firstKey = motionLockByTrack.keys().next().value;
          if (firstKey) motionLockByTrack.delete(firstKey);
        }
      }
    }
  }

  const HERO_FAV_DRAWER_OPEN_KEY = 'nowplaying.heroFavDrawerOpen.v1';
  let heroDrawerOpen = (() => {
    try { return String(localStorage.getItem(HERO_FAV_DRAWER_OPEN_KEY) || '') === '1'; } catch { return false; }
  })();
  let heroDrawerLastSidePx = 168;
  let heroDrawerAppliedSidePx = 0;
  let heroDrawerSizedReady = false;
  let heroDrawerRevealTimer = null;
  const HERO_FAV_LIST_KEY = 'nowplaying.heroFavList.v1';

  function applyFavTabSize(tab, sidePx) {
    if (!tab) return;
    const s = Math.max(120, Number(sidePx || heroDrawerLastSidePx || 168));
    const fs = Math.max(12, Math.min(22, Math.round(s * 0.09)));
    tab.style.setProperty('font-size', `${fs}px`, 'important');
    tab.style.setProperty('line-height', '1', 'important');
    tab.style.setProperty('padding', `${Math.max(7, Math.round(fs * 0.72))}px ${Math.max(5, Math.round(fs * 0.58))}px`, 'important');
  }

  function setHeroDrawerOpen(next) {
    heroDrawerOpen = !!next;
    try { localStorage.setItem(HERO_FAV_DRAWER_OPEN_KEY, heroDrawerOpen ? '1' : '0'); } catch {}
  }
  const HERO_FAV_LAST_KEY = 'nowplaying.heroFavLastStation.v1';
  let heroFavoriteList = (() => {
    try {
      const raw = localStorage.getItem(HERO_FAV_LIST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  })();
  let pendingLiveStationKey = '';
  let pendingLiveStationUntilMs = 0;
  let stickyLiveStationKey = '';
  let loadingStationKey = '';
  let loadingStationUntilMs = 0;

  function syncDrawerOpenState() {
    const wrap = document.getElementById('heroRadioDrawerWrap');
    const drawer = document.getElementById('heroRadioDrawer');
    if (!wrap || !drawer) return;

    // Keep handle visible even before first art-based sizing pass;
    // only keep the drawer panel itself hidden until sizing settles.
    if (!heroDrawerSizedReady) {
      wrap.style.setProperty('opacity', '1', 'important');
      wrap.style.setProperty('visibility', 'visible', 'important');
      wrap.classList.remove('open');
      document.getElementById('heroTransport')?.classList.remove('hasFavDrawerOpen');
      drawer.style.setProperty('border-left', '0', 'important');
      drawer.style.setProperty('opacity', '0', 'important');
      drawer.style.setProperty('visibility', 'hidden', 'important');
      drawer.style.setProperty('pointer-events', 'none', 'important');
      drawer.style.setProperty('transform', 'translateX(-10px)', 'important');
      return;
    }

    wrap.style.setProperty('opacity', '1', 'important');
    wrap.style.setProperty('visibility', 'visible', 'important');
    wrap.classList.toggle('open', !!heroDrawerOpen);
    document.getElementById('heroTransport')?.classList.toggle('hasFavDrawerOpen', !!heroDrawerOpen);

    if (heroDrawerOpen) {
      drawer.style.setProperty('border-left', '1px solid #2a3a58', 'important');
      drawer.style.setProperty('opacity', '1', 'important');
      drawer.style.setProperty('visibility', 'visible', 'important');
      drawer.style.setProperty('pointer-events', 'auto', 'important');
      drawer.style.setProperty('transform', 'translateX(0)', 'important');
    } else {
      drawer.style.setProperty('border-left', '0', 'important');
      drawer.style.setProperty('opacity', '0', 'important');
      drawer.style.setProperty('visibility', 'hidden', 'important');
      drawer.style.setProperty('pointer-events', 'none', 'important');
      drawer.style.setProperty('transform', 'translateX(-10px)', 'important');
    }
  }

  function ensureRadioDrawer() {
    let drawer = document.getElementById('heroRadioDrawer');
    if (drawer) return drawer;

    if (!document.getElementById('heroRadioDrawerStyle')) {
      const st = document.createElement('style');
      st.id = 'heroRadioDrawerStyle';
      st.textContent = `
#heroTransport{position:relative;overflow:visible}
.heroTransportRow{position:relative}
#heroRadioDrawerWrap{position:absolute;right:6px;top:50%;transform:translateY(-50%);z-index:12;display:flex;align-items:center;transition:transform .18s ease;--drawer-w:168px;opacity:0;visibility:hidden}
#heroRadioDrawerWrap.open{transform:translate(calc(-1 * var(--drawer-w)),-50%)}
.heroFavTab{border:1px solid #2a3a58;border-right:0;border-radius:10px 0 0 10px;padding:8px 6px;background:#0f1a31;color:#dbe7ff;cursor:pointer;font-size:12px;line-height:1;writing-mode:vertical-rl;text-orientation:mixed;user-select:none;z-index:13}
.heroFavTab:hover{background:#132241}
#heroRadioDrawer{position:absolute;left:100%;top:0;height:100%;width:var(--drawer-w);background:#0f1a31;border-left:0;box-shadow:-8px 0 24px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;border-radius:0 10px 10px 0;transform:translateX(-10px);opacity:0;visibility:hidden;pointer-events:none;transition:transform .18s ease,opacity .14s ease,visibility 0s linear .18s}
#heroRadioDrawerWrap.open #heroRadioDrawer{transform:translateX(0);opacity:1;visibility:visible;pointer-events:auto;border-left:1px solid #2a3a58;transition:transform .18s ease,opacity .14s ease}
#heroRadioDrawer .grid{padding:6px;display:grid;grid-template-columns:repeat(3,1fr);gap:5px;width:100%}
#heroRadioDrawer .tile{position:relative;width:100%;aspect-ratio:1/1;border:1px solid #2a3a58;border-radius:7px;background:#0a1222;display:flex;align-items:center;justify-content:center;padding:0;overflow:hidden;cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease,transform .08s ease}
#heroRadioDrawer .tile:hover{border-color:#8bd3ff;box-shadow:0 0 0 1px rgba(139,211,255,.35) inset}
#heroRadioDrawer .tile:active{transform:scale(.97)}
#heroRadioDrawer .tile.isLive{border-color:#22c55e !important;border-width:2px !important;box-shadow:0 0 0 2px rgba(34,197,94,.48) inset,0 0 18px rgba(34,197,94,.34)}
#heroRadioDrawer .tile img{width:100%;height:100%;object-fit:cover}
#heroRadioDrawer .tile .tileSpinner{position:absolute;inset:auto;right:5px;top:5px;width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#7dd3fc;display:none;pointer-events:none;animation:heroTileSpin .75s linear infinite}
#heroRadioDrawer .tile.isLoading .tileSpinner{display:block}
@keyframes heroTileSpin{to{transform:rotate(360deg)}}
#heroTransport .heroMain{transform:none !important;padding-right:0 !important}
#heroTransport .heroLivePulse{color:#ef4444;animation:heroLivePulse 2.2s ease-in-out infinite}
#heroTransport button.alexa-control-loading{position:relative;opacity:.72;cursor:wait;pointer-events:none}
#heroTransport button.alexa-control-loading::after{content:'';position:absolute;right:2px;top:2px;width:8px;height:8px;border-radius:999px;border:2px solid rgba(255,255,255,.35);border-top-color:#9fd2ff;animation:heroTileSpin .8s linear infinite}

/* legacy half-width mode removed; dynamic art-relative scaling is source-of-truth */

@media (max-width:480px){
  #heroTransport .heroMain{position:static;left:auto;top:auto;width:100%;transform:none !important;padding-right:0 !important}
  #heroTransport .np{transform:none !important}
}
@keyframes heroLivePulse{0%,100%{opacity:1;text-shadow:0 0 0 rgba(239,68,68,0)}50%{opacity:.45;text-shadow:0 0 10px rgba(239,68,68,.45)}}
`;
      document.head.appendChild(st);
    }

    const host = document.getElementById('heroTransport');

    let wrap = document.getElementById('heroRadioDrawerWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'heroRadioDrawerWrap';
      wrap.innerHTML = `<button type="button" class="heroFavTab" data-a="radio-favs" title="Favorite stations">♥ Favorites</button>`;
      wrap.style.setProperty('--drawer-w', `${heroDrawerLastSidePx}px`, 'important');
      wrap.style.setProperty('height', `${heroDrawerLastSidePx}px`, 'important');
      host?.appendChild(wrap);
    }
    applyFavTabSize(wrap.querySelector('.heroFavTab'), heroDrawerLastSidePx);

    drawer = document.createElement('aside');
    drawer.id = 'heroRadioDrawer';
    const emptyGrid = Array.from({ length: 9 }).map(() => '<div class="tile" aria-hidden="true" style="opacity:.25"></div>').join('');
    drawer.innerHTML = `<div class="grid">${emptyGrid}</div>`;
    drawer.style.setProperty('width', `${heroDrawerLastSidePx}px`, 'important');
    drawer.style.setProperty('height', '100%', 'important');
    wrap.appendChild(drawer);

    // On any hero re-render, repopulate immediately from cached favorite list to avoid blank flashes.
    try { renderRadioDrawerGrid(drawer.querySelector('.grid'), heroFavoriteList); } catch {}

    syncDrawerOpenState();

    return drawer;
  }

  async function loadRadioFavoritesList() {
    const run = async () => {
      const k = currentKey();
      const url = `${apiBase}/config/queue-wizard/radio-favorites${k ? `?k=${encodeURIComponent(k)}` : ''}`;
      const r = await fetch(url, { headers: k ? { 'x-track-key': k } : {}, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const err = new Error(j?.error || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return Array.isArray(j.favorites) ? j.favorites : [];
    };

    try {
      return await run();
    } catch (e) {
      if (Number(e?.status) === 401 || Number(e?.status) === 403) {
        try { await ensureRuntimeKey(true); } catch {}
        return await run();
      }
      throw e;
    }
  }

  async function sendStationToQueue(file, mode = 'append', keepNowPlaying = false, playNow = false) {
    const run = async () => {
      const r = await fetch(`${apiBase}/config/queue-wizard/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(currentKey() ? { 'x-track-key': currentKey() } : {}) },
        body: JSON.stringify({ mode, keepNowPlaying, tracks: [String(file || '')], forceRandomOff: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const err = new Error(j?.error || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return j;
    };

    let j;
    try {
      j = await run();
    } catch (e) {
      if (Number(e?.status) === 401 || Number(e?.status) === 403) {
        try { await ensureRuntimeKey(true); } catch {}
        j = await run();
      } else {
        throw e;
      }
    }

    if (playNow) {
      try {
        await fetch(`${apiBase}/config/diagnostics/playback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(currentKey() ? { 'x-track-key': currentKey() } : {}) },
          body: JSON.stringify({ action: 'play' }),
        });
      } catch {}
    }

    return j;
  }

  async function toggleFavoriteStation(file, favorite) {
    const run = async () => {
      const r = await fetch(`${apiBase}/config/queue-wizard/radio-favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(currentKey() ? { 'x-track-key': currentKey() } : {}) },
        body: JSON.stringify({ station: String(file || ''), favorite: !!favorite }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const err = new Error(j?.error || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return j;
    };

    try {
      return await run();
    } catch (e) {
      if (Number(e?.status) === 401 || Number(e?.status) === 403) {
        try { await ensureRuntimeKey(true); } catch {}
        return await run();
      }
      throw e;
    }
  }

  function stationKey(v=''){
    const raw = String(v || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      return `${String(u.hostname || '').toLowerCase()}${String(u.pathname || '').replace(/\/+$/, '').toLowerCase()}`;
    } catch {
      return raw.toLowerCase().replace(/\?.*$/, '').replace(/\/+$/, '');
    }
  }

  function renderRadioDrawerGrid(grid, favs = []) {
    if (!grid) return;
    const top = (Array.isArray(favs) ? favs : []).slice(0, 9);
    let lastPicked = '';
    try { lastPicked = String(localStorage.getItem(HERO_FAV_LAST_KEY) || ''); } catch {}
    const headItem = Array.isArray(lastQ?.items) ? (lastQ.items.find((x)=>!!x?.isHead) || lastQ.items[0] || null) : null;
    const radioContext = !!(lastNp?.isRadio || lastNp?.isStream || headItem?.isStream);
    const liveFile = String(lastNp?.file || headItem?.file || '').trim();
    const liveStationName = String(
      lastNp?._stationName ||
      lastNp?.stationName ||
      lastNp?.radioStationName ||
      headItem?.stationName ||
      headItem?.name ||
      headItem?.artist ||
      ''
    ).trim();
    const lastPickedKey = stationKey(lastPicked);
    const liveKey = stationKey(liveFile);
    const liveNameKey = stationKey(liveStationName);
    const hasLiveIdentity = !!(liveKey || liveNameKey);
    const nowMs = Date.now();
    const pendingKeyActive = !!(pendingLiveStationKey && nowMs < pendingLiveStationUntilMs);
    if (pendingKeyActive && ((liveKey && liveKey === pendingLiveStationKey) || (liveNameKey && liveNameKey === pendingLiveStationKey))) {
      pendingLiveStationKey = '';
      pendingLiveStationUntilMs = 0;
    }

    let confirmedLiveKey = '';
    if (radioContext && hasLiveIdentity) {
      const found = top.find((f) => {
        const k = stationKey(String(f.file || '').trim());
        const nk = stationKey(String(f.stationName || '').trim());
        return (k && liveKey && k === liveKey) || (nk && liveNameKey && nk === liveNameKey);
      });
      confirmedLiveKey = stationKey(String(found?.file || ''));
      if (confirmedLiveKey) stickyLiveStationKey = confirmedLiveKey;
    }
    if (loadingStationKey) {
      const loadingExpired = Date.now() >= loadingStationUntilMs;
      const loadingConfirmed = !!(confirmedLiveKey && confirmedLiveKey === loadingStationKey);
      if (loadingExpired || loadingConfirmed) {
        loadingStationKey = '';
        loadingStationUntilMs = 0;
      }
    }

    const fallbackKey = pendingKeyActive
      ? pendingLiveStationKey
      : ((confirmedLiveKey ? '' : (stickyLiveStationKey || lastPickedKey)) || ((!radioContext || !hasLiveIdentity) ? (stickyLiveStationKey || lastPickedKey) : ''));

    const rows = top.map((f) => {
      const file = String(f.file || '').trim();
      const name = String(f.stationName || file || 'Station');
      const key = stationKey(file);
      const nameKey = stationKey(name);
      const liveMatch = !!(
        (key && liveKey && key === liveKey) ||
        (nameKey && liveNameKey && nameKey === liveNameKey)
      );
      const fallbackPickedMatch = !!(fallbackKey && key && key === fallbackKey);
      const on = radioContext && (pendingKeyActive
        ? !!(key && key === pendingLiveStationKey)
        : (confirmedLiveKey
            ? !!(key && key === confirmedLiveKey)
            : !!(liveMatch || fallbackPickedMatch)));
      const isLoading = !!(radioContext && loadingStationKey && Date.now() < loadingStationUntilMs && key && key === loadingStationKey);
      return { file, name, on, isLoading };
    });

    const existingBtns = Array.from(grid.querySelectorAll('button[data-station-tile]'));
    const sameStructure = existingBtns.length === rows.length && rows.every((r, i) => {
      const ex = existingBtns[i];
      const exFile = decodeURIComponent(String(ex.getAttribute('data-station-tile') || ''));
      return exFile === r.file;
    });

    if (sameStructure && rows.length) {
      rows.forEach((r, i) => {
        existingBtns[i].classList.toggle('isLive', !!r.on);
        existingBtns[i].classList.toggle('isLoading', !!r.isLoading);
      });
      // keep placeholders if already present; no full redraw needed
      return;
    }

    const cells = rows.map((r) => {
      const logo = `${apiBase}/art/radio-logo.jpg?name=${encodeURIComponent(r.name)}`;
      return `<button class="tile ${r.on ? 'isLive' : ''} ${r.isLoading ? 'isLoading' : ''}" data-station-tile="${encodeURIComponent(r.file)}" title="${r.name}"><img src="${logo}" alt="${r.name}"><span class="tileSpinner" aria-hidden="true"></span></button>`;
    });

    while (cells.length < 9) cells.push('<div class="tile" aria-hidden="true" style="opacity:.25"></div>');
    grid.innerHTML = cells.join('');
  }

  function loadRadioFavoritesFromFrameDom() {
    try {
      const frame = document.getElementById('appFrame');
      const doc = frame?.contentDocument || frame?.contentWindow?.document;
      if (!doc) return [];
      const hearts = Array.from(doc.querySelectorAll('button.heartBtn.on[data-fav]'));
      const out = hearts.map((btn) => {
        const file = decodeURIComponent(String(btn.getAttribute('data-fav') || '')).trim();
        const card = btn.closest('.stationCard');
        const name = String(card?.querySelector('.stationName')?.textContent || '').trim();
        return { file, stationName: name || file };
      }).filter((x) => x.file);
      return out;
    } catch {
      return [];
    }
  }

  async function openRadioDrawer(opts = {}) {
    const drawer = ensureRadioDrawer();
    const grid = drawer.querySelector('.grid');
    if (!grid) return;
    setHeroDrawerOpen(true);
    syncDrawerOpenState();

    const shouldFetch = opts.fetch !== false;

    // Immediate render from last known favorite list (if any).
    renderRadioDrawerGrid(grid, heroFavoriteList);
    if (!shouldFetch) return;

    try {
      await ensureRuntimeKey(true);
      const favs = await loadRadioFavoritesList();
      let next = Array.isArray(favs) ? favs : [];
      if (!next.length) {
        // Fallback: if radio page is open and already has favorites rendered, mirror those.
        next = loadRadioFavoritesFromFrameDom();
      }
      // Guard against transient empty responses while playback/metadata flips.
      // Keep last known non-empty list unless we intentionally have no favorites at all.
      if (!next.length && Array.isArray(heroFavoriteList) && heroFavoriteList.length) {
        next = heroFavoriteList;
      }
      heroFavoriteList = next;
      try { localStorage.setItem(HERO_FAV_LIST_KEY, JSON.stringify(heroFavoriteList)); } catch {}
      renderRadioDrawerGrid(grid, heroFavoriteList);
    } catch {
      const fromFrame = loadRadioFavoritesFromFrameDom();
      if (fromFrame.length) {
        heroFavoriteList = fromFrame;
        try { localStorage.setItem(HERO_FAV_LIST_KEY, JSON.stringify(heroFavoriteList)); } catch {}
        renderRadioDrawerGrid(grid, heroFavoriteList);
      }
      // Otherwise keep last known rendered list.
    }
  }

  function ensureHeroGridResetStyle() {
    if (document.getElementById('heroGridResetStyle')) return;
    const st = document.createElement('style');
    st.id = 'heroGridResetStyle';
    st.textContent = `
#heroTransport.heroGridMode{
  display:grid !important;
  grid-template-columns:25% 50% 25% !important;
  column-gap:0 !important;
  align-items:center !important;
}
#heroTransport.heroGridMode .heroArt{

  display:block !important;  grid-column:1 !important;
  justify-self:stretch !important;
  align-self:center !important;
  width:100% !important;
  max-width:none !important;
  padding:0 !important;
  position:relative !important;
  overflow:hidden !important;
  aspect-ratio:1/1 !important;
}
#heroTransport.heroGridMode .heroArt img,
#heroTransport.heroGridMode .heroArt .heroArtPh{
  display:block !important;
  width:100% !important;
  max-width:none !important;
  height:100% !important;
  aspect-ratio:1/1 !important;
}
#heroTransport.heroGridMode .heroArt .heroArtVid{
  position:absolute !important;
  inset:0 !important;
  display:block !important;
  width:100% !important;
  height:100% !important;
  max-width:none !important;
  object-fit:cover !important;
  aspect-ratio:1/1 !important;
}
#heroTransport.heroGridMode .heroMain{
  grid-column:2 !important;
  position:static !important;
  transform:none !important;
  width:100% !important;
  max-width:100% !important;
  padding-left:3% !important;
  padding-right:3% !important;
  display:flex !important;
  align-items:stretch !important;
  justify-content:center !important;
}
#heroTransport.heroGridMode .np{
  width:100% !important;
  max-width:100% !important;
  height:100% !important;
  display:flex !important;
  flex-direction:column !important;
  justify-content:space-between !important;
  align-items:center !important;
}
#heroTransport.heroGridMode .np .txt{
  white-space:nowrap !important;
  overflow:hidden !important;
  text-overflow:ellipsis !important;
  display:block !important;
  color:var(--theme-text, #e7eefc) !important;
  -webkit-line-clamp:unset !important;
  -webkit-box-orient:unset !important;
}
#heroTransport.heroGridMode .np .txt,
#heroTransport.heroGridMode .np .heroRating,
#heroTransport.heroGridMode .np .heroTransportControls,
#heroTransport.heroGridMode .np .progress-bar-wrapper{
  margin-top:0 !important;
  margin-bottom:0 !important;
}
`;
    document.head.appendChild(st);
  }

  const HERO_GRID_COL2_KEY = 'nowplaying.heroGridCol2Pct.v1';
  let heroGridCol2 = (() => {
    try {
      const v = Number(localStorage.getItem(HERO_GRID_COL2_KEY));
      return Number.isFinite(v) ? Math.max(50, Math.min(80, Math.round(v))) : 70;
    } catch {
      return 70;
    }
  })();

  function getHeroCols() {
    const c2 = Math.max(50, Math.min(80, Number(heroGridCol2) || 70));
    const side = (100 - c2) / 2;
    return { c1: side, c2, c3: side };
  }

  function setHeroCol2(next) {
    heroGridCol2 = Math.max(50, Math.min(80, Math.round(Number(next) || 70)));
    try { localStorage.setItem(HERO_GRID_COL2_KEY, String(heroGridCol2)); } catch {}
    const el = document.getElementById('heroTransport');
    if (el) applyHeroViewportCentering(el);
    refreshHeroGridTuner();
  }

  function ensureHeroGridTuner(el) {
    if (!el || document.getElementById('heroGridTuner')) return;
    const wrap = document.createElement('div');
    wrap.id = 'heroGridTuner';
    wrap.style.cssText = 'position:absolute;left:1px;top:50%;transform:translateY(-50%);z-index:70;display:flex;flex-direction:column;align-items:center;gap:8px;opacity:.50;transition:opacity .15s ease;';

    const mkDot = (col1Pct) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'heroGridDot';
      b.dataset.col1 = String(col1Pct);
      b.title = `${col1Pct}/${100 - (col1Pct * 2)}/${col1Pct}`;
      b.setAttribute('aria-label', `Set hero layout ${b.title}`);
      b.style.cssText = 'width:9px;height:9px;border-radius:999px;border:1px solid rgba(159,177,217,.65);background:rgba(159,177,217,.22);padding:0;cursor:pointer;';
      b.addEventListener('click', () => {
        const c1 = Number(b.dataset.col1 || '20');
        const c2 = 100 - (c1 * 2);
        setHeroCol2(c2);
        refreshHeroGridTuner();
      });
      return b;
    };

    const top = mkDot(22);
    const mid = mkDot(18);
    const bot = mkDot(15);

    wrap.appendChild(top);
    wrap.appendChild(mid);
    wrap.appendChild(bot);

    wrap.addEventListener('mouseenter', () => { wrap.style.opacity = '.95'; });
    wrap.addEventListener('mouseleave', () => { wrap.style.opacity = '.50'; });

    el.appendChild(wrap);
    refreshHeroGridTuner();
  }

  function refreshHeroGridTuner() {
    const wrap = document.getElementById('heroGridTuner');
    if (!wrap) return;
    const c1 = Math.round((100 - heroGridCol2) / 2);
    wrap.querySelectorAll('.heroGridDot').forEach((dot) => {
      const on = Number(dot.dataset.col1 || '0') === c1;
      dot.style.background = on ? 'rgba(125,211,252,.95)' : 'rgba(159,177,217,.22)';
      dot.style.borderColor = on ? 'rgba(125,211,252,1)' : 'rgba(159,177,217,.65)';
      dot.style.boxShadow = on ? '0 0 0 2px rgba(125,211,252,.22)' : 'none';
    });
    const lbl = document.getElementById('heroGridTuneLabel');
    if (lbl) {
      const { c1, c2, c3 } = getHeroCols();
      lbl.textContent = `${Math.round(c1)}/${Math.round(c2)}/${Math.round(c3)}`;
    }
  }

  function applyHeroViewportCentering(el) {
    try {
      if (!el?.classList) return;
      ensureHeroGridTuner(el);
      el.classList.add('heroGridMode');
      const { c1, c2, c3 } = getHeroCols();
      el.style.setProperty('--hero-col1', `${c1}%`);
      el.style.setProperty('--hero-col2', `${c2}%`);
      el.style.setProperty('--hero-col3', `${c3}%`);
      // Dynamic inline enforce
      el.style.setProperty('display', 'grid', 'important');
      el.style.setProperty('grid-template-columns', `${c1}% ${c2}% ${c3}%`, 'important');
      el.style.setProperty('column-gap', '0', 'important');
      el.style.setProperty('position', 'relative', 'important');


      const np = el.querySelector('.np');
      const main = el.querySelector('.heroMain');
      if (np) {
        np.style.position = 'relative';
        np.style.zIndex = '2';
      }

      // Scale title text relative to artwork height.
      try {
        const artVisual = el.querySelector('.heroArt img, .heroArt .heroArtVid, .heroArt .heroArtPh');
        const artEl = el.querySelector('.heroArt');
        const txt = el.querySelector('.np .txt');

        // Re-apply sizing once artwork media has fully loaded (avoids late shrink from placeholder metrics).
        if (artVisual && artVisual.tagName === 'IMG' && !artVisual.complete && !artVisual.dataset.heroSizeHooked) {
          artVisual.dataset.heroSizeHooked = '1';
          artVisual.addEventListener('load', () => {
            try { applyHeroViewportCentering(el); } catch {}
          }, { once: true });
        }
        const artRectVisual = artVisual?.getBoundingClientRect?.();
        const artH = Math.max(0, Number(artRectVisual?.height || 0));
        const artW = Math.max(0, Number(artRectVisual?.width || 0));
        const artVisualSide = Math.max(0, Math.round(Math.min(artW, artH)));
        const artRect = artEl?.getBoundingClientRect?.();
        const artSide = Math.max(0, Math.round(Math.min(Number(artRect?.width || 0), Number(artRect?.height || 0))));
        const mainRect = main?.getBoundingClientRect?.();
        const col2W = Math.max(0, Number(mainRect?.width || 0));
        // Button fit curve: much gentler for half-width iPad.
        let fitK = 1;
        if (col2W > 0) {
          if (col2W >= 600) fitK = 1;
          else if (col2W <= 420) fitK = 0.86;
          else fitK = 0.86 + ((col2W - 420) / 180) * 0.14;
        }
        // Gentler, text-only fit curve: hold near 1.0 until col2 is tighter.
        let textFitK = 1;
        if (col2W > 0) {
          if (col2W >= 620) textFitK = 1;
          else if (col2W <= 420) textFitK = 0.82;
          else textFitK = 0.82 + ((col2W - 420) / 200) * 0.18;
        }
        if (txt && artH > 0) {
          const fs = Math.max(12, Math.min(40, Math.round(artH * 0.12 * textFitK)));
          txt.style.fontSize = `${fs}px`;
          txt.style.lineHeight = '1.15';
          txt.style.whiteSpace = 'nowrap';
          txt.style.overflow = 'hidden';
          txt.style.textOverflow = 'ellipsis';
          txt.style.display = 'block';
        }

        // Constrain center stack to artwork height so top/bottom rows stay within art bounds.
        if (np && artH > 0) {
          const packH = Math.round(artH);
          np.style.setProperty('height', `${packH}px`, 'important');
          np.style.setProperty('min-height', `${packH}px`, 'important');
          np.style.setProperty('max-height', `${packH}px`, 'important');
          np.style.setProperty('justify-content', 'space-between', 'important');
          np.style.setProperty('overflow', 'hidden', 'important');

          const controls = el.querySelector('.np .heroTransportControls');
          const isTight = artH < 128;
          if (controls) {
            controls.style.setProperty('gap', isTight ? '6px' : '8px', 'important');
            controls.style.setProperty('margin', '0', 'important');
          }
          const sub = el.querySelector('.np .heroSubline');
          const live = el.querySelector('.np .heroLiveLine');
          if (sub) sub.style.setProperty('margin', isTight ? '0' : '1px 0', 'important');
          if (live) live.style.setProperty('margin', isTight ? '0' : '1px 0', 'important');
        }

        // Radio-mode text sizing tied to artwork height so it always scales with layout.
        if (artH > 0) {
          const albumPx = Math.max(11, Math.min(33, Math.round(artH * 0.098 * textFitK))); // ~= title(0.12) * 0.82
          const livePx = Math.max(10, Math.min(30, Math.round(artH * 0.089 * textFitK)));  // ~= title(0.12) * 0.74
          const albumEl = el.querySelector('.np .heroSubline');
          const liveEl = el.querySelector('.np .heroLiveLine');
          if (albumEl) albumEl.style.setProperty('font-size', `${albumPx}px`, 'important');
          if (liveEl) {
            liveEl.style.setProperty('font-size', `${livePx}px`, 'important');
            const badge = liveEl.querySelector('span[style*="border-radius:999px"]');
            if (badge) badge.style.setProperty('font-size', `${Math.max(9, Math.round(livePx * 0.72))}px`, 'important');
          }
        }

        const stars = Array.from(el.querySelectorAll('.heroRateStar'));
        if (stars.length && artH > 0) {
          const starPx = Math.max(11, Math.min(34, Math.round(artH * 0.14 * fitK)));
          stars.forEach((s) => { s.style.fontSize = `${starPx}px`; });
        }

        // Scale transport controls from art height.
        const btns = Array.from(el.querySelectorAll('.heroTransportControls .tbtn'));
        if (btns.length && artH > 0) {
          // Single-source sizing to preserve proportions at all widths.
          let normalPx = Math.max(20, Math.min(60, Math.round(artH * 0.29 * fitK)));
          let bigPx = Math.round(normalPx * 1.08);
          let seekPx = Math.max(18, Math.round(normalPx * 0.82));

          // Ensure one-row fit in tighter widths (esp. podcasts with seek buttons).
          const controlsEl = el.querySelector('.np .heroTransportControls');
          const gapPx = Number((controlsEl && getComputedStyle(controlsEl).gap || '8').replace('px', '')) || 8;
          const availW = Math.max(180, Math.round(col2W * 0.94));
          const totalW = () => btns.reduce((sum, b) => {
            const isBig = b.classList.contains('tbtnBig');
            const isSeek = b.classList.contains('tbtnSeek');
            return sum + (isSeek ? seekPx : (isBig ? bigPx : normalPx));
          }, 0) + (Math.max(0, btns.length - 1) * gapPx);

          const need = totalW();
          if (need > availW) {
            const s = Math.max(0.82, availW / need);
            normalPx = Math.max(22, Math.round(normalPx * s));
            bigPx = Math.max(24, Math.round(bigPx * s));
            seekPx = Math.max(20, Math.round(seekPx * s));
          }

          if (controlsEl) controlsEl.style.setProperty('flex-wrap', 'nowrap', 'important');

          btns.forEach((b) => {
            const isBig = b.classList.contains('tbtnBig');
            const isSeek = b.classList.contains('tbtnSeek');
            const px = isSeek ? seekPx : (isBig ? bigPx : normalPx);
            b.style.width = `${px}px`;
            b.style.height = `${px}px`;
          });

          // Also scale SVG/icon sizes with button size.
          btns.forEach((b) => {
            const isBig = b.classList.contains('tbtnBig');
            const isSeek = b.classList.contains('tbtnSeek');
            const px = isSeek ? seekPx : (isBig ? bigPx : normalPx);
            const iconPx = Math.max(12, Math.round(px * (isSeek ? 0.50 : 0.57)));
            const svgs = b.querySelectorAll('svg');
            svgs.forEach((s) => {
              s.style.width = `${iconPx}px`;
              s.style.height = `${iconPx}px`;
            });
            const spans = b.querySelectorAll('span');
            spans.forEach((sp) => {
              if (!isSeek) return;
              sp.style.fontSize = `${Math.max(10, Math.round(px * 0.30))}px`;
              const tightSeek = fitK < 0.86 || col2W < 560;
              const full = String(sp.dataset.fullText || sp.textContent || '').trim();
              if (!sp.dataset.fullText) sp.dataset.fullText = full;
              if (tightSeek) {
                if (full.includes('15')) sp.textContent = '↺';
                else if (full.includes('30')) sp.textContent = '↻';
              } else {
                sp.textContent = sp.dataset.fullText || full;
              }
            });
          });
        }

        // Scale radio favorites drawer from art size; tiles/icons scale from drawer width.
        const drawerWrap = document.getElementById('heroRadioDrawerWrap');
        const drawer = document.getElementById('heroRadioDrawer');
        const favTab = drawerWrap?.querySelector('.heroFavTab');
        if (drawerWrap && drawer && (artH > 0 || artSide > 0)) {
          // Match drawer square to rendered artwork square.
          const measuredSide = Math.max(artVisualSide || 0, artSide || 0, Math.round(artH || 0));
          const side = Math.max(120, Math.min(420, measuredSide));
          heroDrawerLastSidePx = side;
          const drawerW = side;
          const pad = Math.max(5, Math.min(14, Math.round(drawerW * 0.04)));
          const gap = Math.max(4, Math.min(12, Math.round(drawerW * 0.03)));
          const tabFs = Math.max(11, Math.min(18, Math.round(side * 0.08)));

          drawerWrap.style.setProperty('--drawer-w', `${drawerW}px`, 'important');
          drawerWrap.style.setProperty('height', `${side}px`, 'important');
          drawer.style.setProperty('width', `${drawerW}px`, 'important');
          drawer.style.setProperty('height', '100%', 'important');

          // Avoid periodic drawer flicker: only re-hide/reveal when size actually changes.
          const sideChanged = Math.abs(Number(heroDrawerAppliedSidePx || 0) - Number(side || 0)) > 2;
          if (!heroDrawerSizedReady || sideChanged) {
            heroDrawerSizedReady = false;
            syncDrawerOpenState();
            try { if (heroDrawerRevealTimer) clearTimeout(heroDrawerRevealTimer); } catch {}
            heroDrawerRevealTimer = setTimeout(() => {
              heroDrawerAppliedSidePx = side;
              heroDrawerSizedReady = true;
              syncDrawerOpenState();
            }, 220);
          } else {
            heroDrawerAppliedSidePx = side;
          }

          const grid = drawer.querySelector('.grid');
          if (grid) {
            grid.style.setProperty('padding', `${pad}px`, 'important');
            grid.style.setProperty('gap', `${gap}px`, 'important');
          }

          // Keep tile icon sizing stable to avoid visible resize pops when switching tabs/pages.
          // Per-image runtime resizing removed; CSS handles tile image fit consistently.

          if (favTab) {
            applyFavTabSize(favTab, side);
          }
        }
      } catch {}
    

      // Scale progress bar by column-2 dimensions.
      try {
        const mainRect = main?.getBoundingClientRect?.();
        const col2W = Math.max(0, Number(mainRect?.width || 0));
        const col2H = Math.max(0, Number(mainRect?.height || 0));
        const prog = el.querySelector('.np .progress-bar-wrapper');
        const progFill = el.querySelector('.np .progress-fill');
        if (prog && col2W > 0) {
          const w = Math.max(180, Math.min(680, Math.round(col2W * 0.72)));
          const h = Math.max(3, Math.min(10, Math.round(col2H * 0.03)));
          prog.style.width = `${w}px`;
          prog.style.height = `${h}px`;
          if (progFill) progFill.style.height = `${h}px`;
        }
      } catch {}
} catch {}
  }

  function renderShell(el, status = 'loading') {
    const msg = status === 'unavailable' ? 'Now Playing · unavailable' : 'Now Playing · loading…';
    el.innerHTML =
      `<div class="heroArt"><div class="heroArtPh"></div></div>` +
      `<div class="heroMain">` +
        `<div class="np">` +
          `<div class="txt">${msg}</div>` +
          `<div class="heroTransportControls">` +
            `<button class="tbtn" disabled title="Repeat">${icon('repeat')}</button>` +
            `<button class="tbtn" disabled title="Previous">${icon('prev')}</button>` +
            `<button class="tbtn tbtnBig" disabled title="Play">${icon('play')}</button>` +
            `<button class="tbtn" disabled title="Next">${icon('next')}</button>` +
            `<button class="tbtn" disabled title="Shuffle queue">${icon('shuffle')}</button>` +
          `</div>` +
          `<div class="progress-bar-wrapper is-hidden"><div class="progress-fill" style="transform:scaleX(0)"></div></div>` +
        `</div>` +
      `</div>`;
  }

  const HERO_CENTER_OFFSET_PX = 0;

  function pruneHeroTransportDuplicates(el) {
    if (!el) return;
    const keepLast = (sel) => {
      const nodes = Array.from(el.querySelectorAll(sel));
      if (nodes.length <= 1) return;
      nodes.slice(0, -1).forEach((n) => { try { n.remove(); } catch {} });
    };
    keepLast('.heroArt');
    keepLast('.heroMain');
    keepLast('#heroGridTuner');
    keepLast('#heroRadioDrawerWrap');
    keepLast('#heroRadioDrawer');
  }

  function init() {
    const el = $('heroTransport');
    if (!el) return;
    let busy = false;
    let busyWatchdog = null;
    const setBusy = (on) => {
      busy = !!on;
      if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
      if (busy) busyWatchdog = setTimeout(() => { busy = false; busyWatchdog = null; }, 5500);
    };
    lastQ = null;
    lastNp = null;
    let lastRenderSignature = '';

  function heroMotionDebugEnabled() {
    try {
      const v = String(localStorage.getItem('nowplaying.debug.hero') || '').trim().toLowerCase();
      return ['1', 'true', 'on', 'yes'].includes(v);
    } catch {
      return false;
    }
  }

  function heroMotionLog(...args) {
    if (!heroMotionDebugEnabled()) return;
    try { console.log('[hero-motion]', ...args); } catch {}
  }

    const cloneObj = (v) => {
      try { return JSON.parse(JSON.stringify(v || {})); } catch { return (v && typeof v === 'object') ? { ...v } : {}; }
    };

    const renderOptimistic = (action) => {
      if (!lastQ || !lastNp) return;
      const q = cloneObj(lastQ);
      const np = cloneObj(lastNp);
      const a = String(action || '').toLowerCase();
      if (a === 'play') q.playbackState = 'playing';
      else if (a === 'pause') q.playbackState = 'paused';
      else if (a === 'shuffle') q.randomOn = false;
      else if (a === 'repeat') q.repeatOn = !q.repeatOn;
      else if (a === 'seekback15') {
        const e = Number(np?.elapsed ?? q?.elapsed ?? 0) || 0;
        const n = Math.max(0, e - 15);
        np.elapsed = n; q.elapsed = n;
      } else if (a === 'seekfwd30') {
        const e = Number(np?.elapsed ?? q?.elapsed ?? 0) || 0;
        const d = Number(np?.duration ?? q?.duration ?? 0) || 0;
        const n = d > 0 ? Math.min(d, e + 30) : (e + 30);
        np.elapsed = n; q.elapsed = n;
      }
      render(el, q, np);
      applyHeroViewportCentering(el);
      armVideoFallback(el);
      try { ensureRadioDrawer(); } catch {}
    };

    let refreshSeq = 0;
    let reflowTimerA = null;
    let reflowTimerB = null;
    let reflowRaf = 0;
    const scheduleHeroReflow = () => {
      try { if (reflowRaf) cancelAnimationFrame(reflowRaf); } catch {}
      try { if (reflowTimerA) clearTimeout(reflowTimerA); } catch {}
      try { if (reflowTimerB) clearTimeout(reflowTimerB); } catch {}
      reflowRaf = requestAnimationFrame(() => {
        try { applyHeroViewportCentering(el); } catch {}
      });
      // Late settle passes for art-size transitions that finish after initial paint.
      reflowTimerA = setTimeout(() => { try { applyHeroViewportCentering(el); } catch {} }, 120);
      reflowTimerB = setTimeout(() => { try { applyHeroViewportCentering(el); } catch {} }, 320);
    };

    const refresh = async () => {
      try {
        await ensureRuntimeKey();
        const key = currentKey();
        const [qRes, npRes, awRes] = await Promise.allSettled([
          loadQueueState(key),
          loadNowPlaying(key),
          loadAlexaWasPlaying(),
        ]);

        const q = (qRes.status === 'fulfilled' && qRes.value) ? qRes.value : (lastQ || { items: [], playbackState: '' });
        let np = (npRes.status === 'fulfilled' && npRes.value) ? npRes.value : (lastNp || {});
        const alexaWas = (awRes.status === 'fulfilled') ? awRes.value : null;

        if (!(qRes.status === 'fulfilled' || npRes.status === 'fulfilled' || awRes.status === 'fulfilled')) {
          throw new Error('all refresh sources failed');
        }
        const aw = alexaWas || null;
        const awNp = aw?.nowPlaying || null;
        const awWp = aw?.wasPlaying || null;
        const awModeActive = !!((awNp && awNp.modeActive) || (awWp && awWp.modeActive));
        const awFresh = !!aw?.fresh;
        const awPayload = (awNp && awNp.file) ? awNp : ((awWp && awWp.file) ? awWp : null);
        if (awFresh && awModeActive && awPayload) {
          const baseNp = np;
          np = { ...np, ...awPayload, alexaMode: true };
          // Preserve rating context from primary now-playing when Alexa payload lacks it.
          if (!String(np?.ratingFile || '').trim() && String(baseNp?.ratingFile || '').trim()) np.ratingFile = String(baseNp.ratingFile).trim();
          if ((Number(np?.rating || 0) <= 0) && Number(baseNp?.rating || 0) > 0) np.rating = Number(baseNp.rating || 0);
        }

        lastQ = cloneObj(q);
        lastNp = cloneObj(np);
        const seq = ++refreshSeq;

        const appleUrl = String(np?.radioItunesUrl || np?.radioTrackUrl || np?.itunesUrl || np?.radioAppleMusicUrl || '').trim();
        const motionEnabled = motionArtEnabled();
        const head = (Array.isArray(q?.items) ? (q.items.find((x) => !!x?.isHead) || q.items[0]) : null) || null;
        const isYoutube = !!(np?.isYoutube || head?.isYoutube || /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(String(np?.file || head?.file || '')));
        const isRadioOrStream = !!np?.isRadio || (!!np?.isStream && !isYoutube) || (!!head?.isStream && !isYoutube);
        const isUpnp = !!np?.isUpnp
          || String(np?.source || np?.animatedArt?.source || '').trim().toLowerCase() === 'upnp-sonuvi'
          || String(np?.source || np?.animatedArt?.source || '').trim().toLowerCase() === 'external-upnp'
          || String(np?.streamKind || '').trim().toLowerCase() === 'upnp';
        const isMotionRadioOrStream = !!np?.isRadio
          || (!!np?.isStream && !isYoutube && !isUpnp)
          || (!!head?.isStream && !isYoutube && !head?.isUpnp);
        const artist = String(np?.artist || '').trim();
        const album = String(np?.album || '').trim();
        const radioTitle = String(np?.title || np?.radioTitle || head?.title || '').trim();
        const motionIdentity = `${isMotionRadioOrStream ? 'r' : 'l'}|${appleUrl || ''}|${artist}|${album}|${isMotionRadioOrStream ? radioTitle : ''}`;
        const currentFile = String(np?.file || head?.file || '').trim();
        const currentSongId = String(np?.songid || head?.songid || '').trim();
        if (currentFile) lastKnownNowFile = currentFile;
        if (currentSongId) lastKnownSongId = currentSongId;
        const effectiveFile = currentFile || lastKnownNowFile;
        const effectiveSongId = currentSongId || lastKnownSongId;
        const baseTrackKey = motionTrackKey(
          effectiveFile,
          effectiveSongId,
          np?.animatedArt?.identity || np?.upnpItem?.id || np?.generation,
        );
        const localAlbumContinuityKey = (!isMotionRadioOrStream && album)
          ? `album|${artist.toLowerCase()}|${album.toLowerCase()}`
          : '';
        const effectiveTrackKey = isMotionRadioOrStream
          ? `radio|${String(appleUrl || '').trim().toLowerCase()}|${artist.toLowerCase()}|${album.toLowerCase()}|${radioTitle.toLowerCase()}`
          : (localAlbumContinuityKey || baseTrackKey);

        // Render immediately with cached motion if available; do not block on remote lookup.
        // "Motion is law": if track file is unchanged (or temporarily missing in payload), keep using known-good motion clip.
        let motionMp4 = '';
        const lockedMotion = effectiveTrackKey ? String(motionLockByTrack.get(effectiveTrackKey) || '').trim() : '';
        if (lockedMotion) {
          motionMp4 = lockedMotion;
        } else if (effectiveTrackKey && lastVisibleMotionSrc && effectiveTrackKey === lastMotionTrackKey) {
          motionMp4 = lastVisibleMotionSrc;
        } else if (!isRadioOrStream && effectiveFile && lastVisibleMotionSrc && effectiveFile === lastVisibleMotionFile) {
          motionMp4 = lastVisibleMotionSrc;
        } else if (lastMotionMp4 && ((motionIdentity === lastMotionIdentity) || (effectiveFile && effectiveFile === lastMotionFile))) {
          motionMp4 = lastMotionMp4;
        }

        // Hard render guard: if same track key is still active, keep currently visible motion src.
        if (!motionMp4) {
          const liveVid = el.querySelector('.heroArtVid');
          const liveSrc = String(liveVid?.currentSrc || liveVid?.src || '').trim();
          if (liveSrc && effectiveTrackKey && lastRenderedTrackKey && effectiveTrackKey === lastRenderedTrackKey) {
            motionMp4 = liveSrc;
          }
        }

        // If this track previously proved motion, NEVER render static fallback branch.
        const motionLockedForTrack = !!(effectiveTrackKey && (motionLockByTrack.get(effectiveTrackKey) || (effectiveTrackKey === lastMotionTrackKey && lastVisibleMotionSrc)));
        if (motionLockedForTrack && !motionMp4) {
          const fallbackMotion = String(motionLockByTrack.get(effectiveTrackKey) || lastVisibleMotionSrc || '').trim();
          if (fallbackMotion) motionMp4 = fallbackMotion;
        }

        np._motionMp4 = motionMp4;

        const sigIsRadio = !!np?.isRadio || (!!np?.isStream && !isYoutube) || (!!head?.isStream && !isYoutube);
        const renderSig = JSON.stringify({
          f: String(np?.file || head?.file || ''),
          // For local/static tracks, avoid full hero repaint on late metadata enrichment
          // (prevents one-time art flash a few seconds after page load).
          t: sigIsRadio ? String(np?.title || np?.radioTitle || head?.title || '') : '',
          a: sigIsRadio ? String(np?.artist || np?.radioArtist || head?.artist || '') : '',
          al: sigIsRadio ? String(np?.album || np?.radioAlbum || '') : '',
          art: artworkMediaIdentity(String(motionLockedForTrack ? '' : (globalThis.NPArt?.source(np, { head }) || np?.albumArtUrl || np?.altArtUrl || np?.stationLogoUrl || head?.thumbUrl || ''))),
          m: String(motionMp4 || ''),
          r: sigIsRadio,
          p: !!np?.isPodcast,
          x: !!np?.alexaMode,
        });

        if (renderSig !== lastRenderSignature) {
          heroMotionLog('renderSig changed', {
            trackKey: effectiveTrackKey,
            motionLockedForTrack,
            hasMotion: !!motionMp4,
            isAlexaMode: !!np?.alexaMode,
          });
          render(el, q, np);
          applyHeroViewportCentering(el);
          scheduleHeroReflow();
          armVideoFallback(el);
          lastRenderSignature = renderSig;
        } else {
          // If motion is locked for this track, avoid text-only update path that can repaint static art elsewhere.
          if (!motionLockedForTrack) updateHeroDynamic(el, q, np);
          applyHeroViewportCentering(el);
          scheduleHeroReflow();
        }
        if (effectiveTrackKey) lastRenderedTrackKey = effectiveTrackKey;

        try { ensureRadioDrawer(); } catch {}
        pruneHeroTransportDuplicates(el);
        try { window.dispatchEvent(new CustomEvent('heroTransport:update', { detail: { q, np } })); } catch {}

        // Background motion resolution (non-blocking)
        if (!motionEnabled) return;
        const shouldTryRemoteMotion = !!appleUrl && isMotionRadioOrStream;
        if (motionMp4) {
          heroMotionLog('skip motion resolve (already have motion)', { trackKey: effectiveTrackKey, src: canonicalMediaSrc(motionMp4) });
          return;
        }

        const resolved = shouldTryRemoteMotion
          ? await resolveMotionMp4(appleUrl).catch(() => '')
          : await (globalThis.NPArt?.resolveMotionFor
            ? globalThis.NPArt.resolveMotionFor(np, { base: apiBase })
            : resolveLocalMotionMp4(artist, album, currentKey())).catch(() => '');

        if (seq !== refreshSeq) {
          const stillSameTrack = !!(effectiveTrackKey && effectiveTrackKey === lastRenderedTrackKey);
          if (!stillSameTrack) {
            heroMotionLog('discard stale motion resolve', { trackKey: effectiveTrackKey });
            return; // stale refresh result
          }
          heroMotionLog('accept stale motion resolve (same track)', { trackKey: effectiveTrackKey });
        }
        if (!resolved) {
          heroMotionLog('motion resolve miss', { trackKey: effectiveTrackKey, remote: shouldTryRemoteMotion });
          // Do not clear known-good motion on transient lookup misses.
          return;
        }
        heroMotionLog('motion resolved', { trackKey: effectiveTrackKey, src: canonicalMediaSrc(resolved), remote: shouldTryRemoteMotion });

        lastMotionIdentity = motionIdentity;
        lastMotionMp4 = resolved;
        lastMotionFile = effectiveFile;
        if (effectiveTrackKey) {
          lastMotionTrackKey = effectiveTrackKey;
          motionLockByTrack.set(effectiveTrackKey, resolved);
        }

        const liveVid = el.querySelector('.heroArtVid');
        const liveSrc = String(liveVid?.currentSrc || liveVid?.src || '').trim();
        if (liveVid && liveSrc && canonicalMediaSrc(liveSrc) === canonicalMediaSrc(resolved)) {
          // Avoid one-time flash: do not rebuild hero DOM when the same motion clip is already visible.
          try {
            const fb = el.querySelector('.heroArtFallback');
            if (fb) fb.style.display = 'none';
            liveVid.style.display = '';
            const p = (typeof liveVid.play === 'function') ? liveVid.play() : null;
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }

        const npResolved = { ...np, _motionMp4: resolved };
        render(el, q, npResolved);
        applyHeroViewportCentering(el);
        scheduleHeroReflow();
        armVideoFallback(el);
        const head2 = (Array.isArray(q?.items) ? (q.items.find((x) => !!x?.isHead) || q.items[0]) : null) || null;
        const isYoutube2 = !!(npResolved?.isYoutube || head2?.isYoutube || /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(String(npResolved?.file || head2?.file || '')));
        const sig2IsRadio = !!npResolved?.isRadio || (!!npResolved?.isStream && !isYoutube2) || (!!head2?.isStream && !isYoutube2);
        lastRenderSignature = JSON.stringify({
          f: String(npResolved?.file || head2?.file || ''),
          t: sig2IsRadio ? String(npResolved?.title || npResolved?.radioTitle || head2?.title || '') : '',
          a: sig2IsRadio ? String(npResolved?.artist || npResolved?.radioArtist || head2?.artist || '') : '',
          al: sig2IsRadio ? String(npResolved?.album || npResolved?.radioAlbum || '') : '',
          art: artworkMediaIdentity(String(globalThis.NPArt?.source(npResolved, { head: head2 }) || npResolved?.albumArtUrl || npResolved?.altArtUrl || npResolved?.stationLogoUrl || head2?.thumbUrl || '')),
          m: String(resolved || ''),
          r: sig2IsRadio,
          p: !!npResolved?.isPodcast,
          x: !!npResolved?.alexaMode,
        });
        if (effectiveTrackKey) lastRenderedTrackKey = effectiveTrackKey;
        try { ensureRadioDrawer(); } catch {}
        if (heroDrawerOpen) {
          try { openRadioDrawer({ fetch: false }); } catch {}
        }
      } catch {
        // Never blank a previously good hero card on transient fetch/render failures.
        if (lastQ || lastNp) {
          try {
            render(el, lastQ || { items: [], playbackState: '' }, lastNp || {});
            applyHeroViewportCentering(el);
            scheduleHeroReflow();
            armVideoFallback(el);
            try { ensureRadioDrawer(); } catch {}
            if (heroDrawerOpen) {
              try { openRadioDrawer({ fetch: false }); } catch {}
            }
            return;
          } catch {}
        }
        renderShell(el, 'unavailable');
        applyHeroViewportCentering(el);
        scheduleHeroReflow();
        try { ensureRadioDrawer(); } catch {}
        if (heroDrawerOpen) {
          try { openRadioDrawer({ fetch: false }); } catch {}
        }
      }
    };

    ensureHeroGridResetStyle();
    renderShell(el, 'loading');
    applyHeroArtBackground('init');
    ensureHeroGridTuner(el);
    applyHeroViewportCentering(el);

    el.addEventListener('click', async (ev) => {
      const artHit = ev.target instanceof Element ? ev.target.closest('.heroArt') : null;
      if (artHit) {
        ev.preventDefault();
        ev.stopPropagation();
        heroArtBgEnabled = !heroArtBgEnabled;
        try { localStorage.setItem(HERO_ART_BG_STORAGE_KEY, heroArtBgEnabled ? '1' : '0'); } catch {}
        const tk = String(artHit.getAttribute('data-track-key') || '').trim();
        const artSrc = String(artHit.getAttribute('data-art-src') || '').trim()
          || String(artHit.querySelector('img')?.getAttribute('src') || '').trim();
        applyHeroArtBackground(tk || 'toggle', artSrc);
        return;
      }

      const albumHit = ev.target instanceof Element ? ev.target.closest('[data-hero-open-album]') : null;
      if (albumHit) {
        ev.preventDefault();
        const album = decodeURIComponent(String(albumHit.getAttribute('data-hero-album') || ''));
        const artist = decodeURIComponent(String(albumHit.getAttribute('data-hero-artist') || ''));
        const art = decodeURIComponent(String(albumHit.getAttribute('data-hero-art') || ''));
        if (album) {
          try {
            window.dispatchEvent(new CustomEvent('openclaw:hero-open-album-modal', { detail: { album, artist, art } }));
          } catch {}
        }
        return;
      }

      const rateBtn = ev.target instanceof Element ? ev.target.closest('button[data-hero-rate-file][data-hero-rate-val]') : null;
      if (rateBtn) {
        ev.preventDefault();
        const file = decodeURIComponent(String(rateBtn.getAttribute('data-hero-rate-file') || ''));
        const rating = Number(rateBtn.getAttribute('data-hero-rate-val') || 0);
        if (!file || !Number.isFinite(rating) || rating < 0 || rating > 5) return;

        // Optimistic UI update: fill immediately on click.
        const row = rateBtn.closest('.heroRating');
        if (row) {
          row.querySelectorAll('.heroRateStar[data-hero-rate-val]').forEach((s) => {
            const v = Number(s.getAttribute('data-hero-rate-val') || 0);
            s.classList.toggle('on', v <= rating);
            s.classList.toggle('off', v > rating);
          });
        }

        setBusy(true);
        try {
          try { await playback('rate', currentKey(), { file, rating }); } catch {}
          try { await refresh(); } catch {}
        } finally {
          setBusy(false);
        }
        return;
      }

      const btn = ev.target instanceof Element ? ev.target.closest('button[data-a]') : null;
      if (!btn || busy) return;
      const action = String(btn.getAttribute('data-a') || '').trim().toLowerCase();
      if (action === 'radio-favs') {
        ev.preventDefault();
        setHeroDrawerOpen(!heroDrawerOpen);
        syncDrawerOpenState();
        if (heroDrawerOpen) openRadioDrawer().catch(() => {});
        return;
      }
      const alexaModeActive = !!lastNp?.alexaMode;
      const alexaControl = action === 'play' ? 'resume' : action;
      if (alexaModeActive && ['pause', 'resume', 'next'].includes(alexaControl)) {
        ev.preventDefault();
        const before = await readAlexaControlSnapshot().catch(() => null);
        if (!before?.modeActive) {
          try { alert('Alexa Mode is not confirmed active.'); } catch {}
          return;
        }
        btn.classList.add('alexa-control-loading');
        btn.disabled = true;
        setBusy(true);
        try {
          await ensureRuntimeKey();
          await playback(alexaControl + 'alexa', currentKey());
          await waitForAlexaControl(alexaControl, before);
          btn.classList.add('confirm');
          setTimeout(() => btn.classList.remove('confirm'), 560);
        } catch (e) {
          try { alert(String(e?.message || e || 'Alexa control was not confirmed.')); } catch {}
        } finally {
          btn.classList.remove('alexa-control-loading');
          btn.disabled = false;
          setBusy(false);
          try { await refresh(); } catch {}
        }
        return;
      }
      renderOptimistic(action);
      setBusy(true);
      try {
        try {
          if (action === 'seekback15') await playback('seekrel', currentKey(), { seconds: -15 });
          else if (action === 'seekfwd30') await playback('seekrel', currentKey(), { seconds: 30 });
          else if (action === 'routealexa') await playback('routealexa', currentKey());
          else await playback(action, currentKey());
        } catch (e) {
          if (action === 'routealexa') {
            try { alert(String(e?.message || e || 'Route to Alexa failed')); } catch {}
          }
        }
        try { await refresh(); } catch {}
      } finally {
        setBusy(false);
      }
    });

    ensureRadioDrawer();
    document.addEventListener('click', async (ev) => {
      const tile = ev.target instanceof Element ? ev.target.closest('#heroRadioDrawer button[data-station-tile]') : null;
      if (!tile) return;
      ev.preventDefault();
      ev.stopPropagation();
      const file = decodeURIComponent(String(tile.getAttribute('data-station-tile') || ''));
      if (!file) return;
      try {
        await ensureRuntimeKey();
        const pickedKey = stationKey(file);
        try { localStorage.setItem(HERO_FAV_LAST_KEY, pickedKey); } catch {}
        pendingLiveStationKey = pickedKey;
        pendingLiveStationUntilMs = Date.now() + 8000;
        stickyLiveStationKey = pickedKey;
        loadingStationKey = pickedKey;
        loadingStationUntilMs = Date.now() + 12000;
        const drawerGrid = document.querySelector('#heroRadioDrawer .grid');
        if (drawerGrid) renderRadioDrawerGrid(drawerGrid, heroFavoriteList);
        await sendStationToQueue(file, 'replace', false, true);
        // Keep drawer state as user-chosen; do not force-close on station pick.
        await refresh();
        if (heroDrawerOpen) {
          // Keep UI stable immediately; hydrate favorites in background after station switch settles.
          try { openRadioDrawer({ fetch: false }); } catch {}
          setTimeout(() => { try { openRadioDrawer({ fetch: true }); } catch {} }, 850);
        }
        try { window.dispatchEvent(new CustomEvent('heroTransport:update')); } catch {}
      } catch (e) {
        pendingLiveStationKey = '';
        pendingLiveStationUntilMs = 0;
        loadingStationKey = '';
        loadingStationUntilMs = 0;
        console.warn('favorite station click failed', e);
      }
    });

    const hostEl = document.getElementById('heroTransport');
    let seeking = false;
    let seekBar = null;
    let seekPct = null;

    const calcSeekPct = (bar, clientX) => {
      const rect = bar.getBoundingClientRect();
      if (!rect.width) return null;
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      return Math.max(0, Math.min(100, (x / rect.width) * 100));
    };

    const paintSeekPct = (bar, pct) => {
      const fill = bar.querySelector('.progress-fill');
      if (fill) fill.style.transform = `scaleX(${pct / 100})`;
      const handle = bar.querySelector('.progress-handle');
      if (handle) handle.style.left = `${pct}%`;
      const tip = bar.querySelector('.progress-tip');
      if (tip) tip.style.left = `${pct}%`;
    };

    hostEl?.addEventListener('pointerdown', (ev) => {
      const bar = ev.target instanceof Element ? ev.target.closest('.progress-bar-wrapper[data-seekable="1"]') : null;
      if (!bar || busy) return;
      const pct = calcSeekPct(bar, ev.clientX);
      if (pct == null) return;
      seeking = true;
      seekBar = bar;
      seekPct = pct;
      paintSeekPct(bar, pct);
      try { ev.preventDefault(); } catch {}
    });

    hostEl?.addEventListener('pointermove', (ev) => {
      if (!seeking || !seekBar) return;
      const pct = calcSeekPct(seekBar, ev.clientX);
      if (pct == null) return;
      seekPct = pct;
      paintSeekPct(seekBar, pct);
    });

    window.addEventListener('pointerup', async () => {
      if (!seeking) return;
      seeking = false;
      const pct = seekPct;
      seekBar = null;
      seekPct = null;
      if (!Number.isFinite(pct) || busy) return;
      setBusy(true);
      try {
        try { await playback('seekpct', currentKey(), { percent: pct }); } catch {}
        try { await refresh(); } catch {}
      } finally {
        setBusy(false);
      }
    });

    let fastRefreshTimer = null;
    let lastFastRefreshAt = 0;
    const scheduleFastRefresh = (delayMs = 0) => {
      const now = Date.now();
      if ((now - lastFastRefreshAt) < 800) return;
      if (fastRefreshTimer) clearTimeout(fastRefreshTimer);
      fastRefreshTimer = setTimeout(() => {
        fastRefreshTimer = null;
        if (document.hidden) return;
        lastFastRefreshAt = Date.now();
        refresh();
      }, Math.max(0, Number(delayMs) || 0));
    };

    setTimeout(refresh, 150);
    if (heroDrawerOpen) {
      setTimeout(() => { try { openRadioDrawer(); } catch {} }, 260);
    }
    setInterval(() => { if (!document.hidden) refresh(); }, 6000);
    window.addEventListener('resize', () => { applyHeroViewportCentering(el); scheduleHeroReflow(); });

    // Catch art-size/layout transitions that do not emit window resize.
    try {
      const ro = new ResizeObserver(() => scheduleHeroReflow());
      ro.observe(el);
      const artNode = el.querySelector('.heroArt');
      if (artNode) ro.observe(artNode);
    } catch {}

    // Prioritize now-playing freshness when returning to this tab/PWA window.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleFastRefresh(20);
    });
    window.addEventListener('focus', () => scheduleFastRefresh(20));
    window.addEventListener('pageshow', () => scheduleFastRefresh(20));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
