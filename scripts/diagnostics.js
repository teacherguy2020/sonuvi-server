(() => {
  const $ = (id) => document.getElementById(id);
  const dbg = () => {};
  let ratingsEnabled = true;
  let queuePlayPauseMode = 'play';
  let queueLoadInFlight = false;

  const ENDPOINTS_FALLBACK = [
    // Auto-expanded endpoint catalog
    { name: '/art/current.jpg', method: 'GET', path: '/art/current.jpg' },
    { name: '/art/current_320.jpg', method: 'GET', path: '/art/current_320.jpg' },
    { name: '/art/current_640.jpg', method: 'GET', path: '/art/current_640.jpg' },
    { name: '/art/current_bg_640_blur.jpg', method: 'GET', path: '/art/current_bg_640_blur.jpg' },
    { name: '/art/track_640.jpg', method: 'GET', path: '/art/track_640.jpg' },
    { name: '/config/album-alias-suggestion', method: 'POST', path: '/config/album-alias-suggestion', body: {} },
    { name: '/config/alexa-heard-album', method: 'POST', path: '/config/alexa-heard-album', body: {} },
    { name: '/config/alexa-heard-artist', method: 'POST', path: '/config/alexa-heard-artist', body: {} },
    { name: '/config/alexa-heard-playlist', method: 'POST', path: '/config/alexa-heard-playlist', body: {} },
    { name: '/config/alexa/check-domain', method: 'POST', path: '/config/alexa/check-domain', body: { domain: "" } },
    { name: '/config/artist-alias-suggestion', method: 'POST', path: '/config/artist-alias-suggestion', body: {} },
    { name: '/config/diagnostics/playback', method: 'POST', path: '/config/diagnostics/playback', body: { action: "play" } },
    { name: '/config/diagnostics/queue', method: 'GET', path: '/config/diagnostics/queue' },
    { name: '/config/library-health', method: 'GET', path: '/config/library-health' },
    { name: '/config/library-health/album-art', method: 'GET', path: '/config/library-health/album-art' },
    { name: '/config/library-health/album-art', method: 'POST', path: '/config/library-health/album-art', body: {} },
    { name: '/config/library-health/album-genre', method: 'GET', path: '/config/library-health/album-genre' },
    { name: '/config/library-health/album-genre', method: 'POST', path: '/config/library-health/album-genre', body: {} },
    { name: '/config/library-health/animated-art/discovery', method: 'GET', path: '/config/library-health/animated-art/discovery' },
    { name: '/config/library-health/animated-art/lookup', method: 'GET', path: '/config/library-health/animated-art/lookup' },
    { name: '/config/library-health/animated-art/job', method: 'GET', path: '/config/library-health/animated-art/job' },
    { name: '/config/library-health/animated-art/discover', method: 'POST', path: '/config/library-health/animated-art/discover', body: { force: false } },
    { name: '/config/library-health/animated-art/build', method: 'POST', path: '/config/library-health/animated-art/build', body: { album: "", artist: "", sourceUrl: "" } },
    { name: '/config/library-health/animated-art/suppress', method: 'POST', path: '/config/library-health/animated-art/suppress', body: { album: "", artist: "", suppressed: true } },
    { name: '/config/library-health/animated-art/clear', method: 'POST', path: '/config/library-health/animated-art/clear', body: { album: "", artist: "" } },
    { name: '/config/library-health/album-performers-apply', method: 'POST', path: '/config/library-health/album-performers-apply', body: {} },
    { name: '/config/library-health/album-performers-suggest', method: 'GET', path: '/config/library-health/album-performers-suggest' },
    { name: '/config/library-health/album-tracks', method: 'GET', path: '/config/library-health/album-tracks' },
    { name: '/config/library-health/albums', method: 'GET', path: '/config/library-health/albums' },
    { name: '/config/library-health/genre-batch', method: 'POST', path: '/config/library-health/genre-batch', body: {} },
    { name: '/config/library-health/genre-folders', method: 'GET', path: '/config/library-health/genre-folders' },
    { name: '/config/library-health/missing-artwork', method: 'GET', path: '/config/library-health/missing-artwork' },
    { name: '/config/library-health/rating-batch', method: 'POST', path: '/config/library-health/rating-batch', body: {} },
    { name: '/config/playlist-alias-suggestion', method: 'POST', path: '/config/playlist-alias-suggestion', body: {} },
    { name: '/config/queue-wizard/apply', method: 'POST', path: '/config/queue-wizard/apply', body: { mode: "append", keepNowPlaying: false, tracks: [""], shuffle: false } },
    { name: '/config/queue-wizard/collage-preview', method: 'POST', path: '/config/queue-wizard/collage-preview', body: {} },
    { name: '/config/queue-wizard/load-playlist', method: 'POST', path: '/config/queue-wizard/load-playlist', body: { playlist: "", mode: "replace", play: true } },
    { name: '/config/queue-wizard/options', method: 'GET', path: '/config/queue-wizard/options' },
    { name: '/config/browse/stats', method: 'GET', path: '/config/browse/stats' },
    { name: '/config/browse/artists', method: 'GET', path: '/config/browse/artists' },
    { name: '/config/browse/albums', method: 'GET', path: '/config/browse/albums' },
    { name: '/config/browse/artist-albums', method: 'GET', path: '/config/browse/artist-albums' },
    { name: '/config/browse/album-tracks', method: 'GET', path: '/config/browse/album-tracks' },
    { name: '/config/browse/rebuild', method: 'POST', path: '/config/browse/rebuild', body: { force: true } },
    { name: '/config/queue-wizard/playlist-preview', method: 'GET', path: '/config/queue-wizard/playlist-preview' },
    { name: '/config/queue-wizard/playlists', method: 'GET', path: '/config/queue-wizard/playlists' },
    { name: '/config/queue-wizard/preview', method: 'POST', path: '/config/queue-wizard/preview', body: { genres: [], artists: [], albums: [], excludeGenres: [], minRating: 0, maxTracks: 25 } },
    { name: '/config/queue-wizard/vibe-cancel/<jobId>', method: 'POST', path: '/config/queue-wizard/vibe-cancel/<jobId>', body: {} },
    { name: '/config/queue-wizard/vibe-nowplaying', method: 'GET', path: '/config/queue-wizard/vibe-nowplaying' },
    { name: '/config/queue-wizard/vibe-nowplaying', method: 'POST', path: '/config/queue-wizard/vibe-nowplaying', body: { targetQueue: 50, minRating: 0 } },
    { name: '/config/queue-wizard/vibe-start', method: 'POST', path: '/config/queue-wizard/vibe-start', body: { targetQueue: 50, minRating: 0 } },
    { name: '/config/queue-wizard/vibe-seed-start', method: 'POST', path: '/config/queue-wizard/vibe-seed-start', body: { seedArtist: "John Mayer", seedTitle: "Gravity", targetQueue: 12 } },
    { name: '/config/queue-wizard/vibe-status/<jobId>', method: 'GET', path: '/config/queue-wizard/vibe-status/<jobId>' },
    { name: '/config/queue-wizard/radio-options', method: 'GET', path: '/config/queue-wizard/radio-options' },
    { name: '/config/queue-wizard/radio-favorites', method: 'GET', path: '/config/queue-wizard/radio-favorites' },
    { name: '/config/radio-browser/search', method: 'GET', path: '/config/radio-browser/search' },
    { name: '/config/radio-browser/preview', method: 'POST', path: '/config/radio-browser/preview', body: { url: "" } },
    { name: '/config/radio-browser/add', method: 'POST', path: '/config/radio-browser/add', body: { station: "", name: "", genre: "" } },
    { name: '/config/ratings/sticker-backup', method: 'POST', path: '/config/ratings/sticker-backup', body: {} },
    { name: '/config/ratings/sticker-backups', method: 'GET', path: '/config/ratings/sticker-backups' },
    { name: '/config/ratings/sticker-restore', method: 'POST', path: '/config/ratings/sticker-restore', body: {} },
    { name: '/config/ratings/sticker-status', method: 'GET', path: '/config/ratings/sticker-status' },
    { name: '/config/restart-api', method: 'POST', path: '/config/restart-api', body: {} },
    { name: '/config/restart-services', method: 'POST', path: '/config/restart-services', body: {} },
    { name: '/config/runtime', method: 'GET', path: '/config/runtime' },
    { name: '/config/runtime', method: 'POST', path: '/config/runtime', body: { mpdHost: "", sshHost: "", trackKey: "" } },
    { name: '/config/runtime-meta', method: 'GET', path: '/config/runtime-meta' },
    { name: '/config/runtime/check-env', method: 'POST', path: '/config/runtime/check-env', body: { mpdHost: "", mpdPort: 6600, sshHost: "", sshUser: "moode", paths: {} } },
    { name: '/config/runtime/ensure-podcast-root', method: 'POST', path: '/config/runtime/ensure-podcast-root', body: {} },
    { name: '/config/runtime/resolve-host', method: 'POST', path: '/config/runtime/resolve-host', body: {} },
    { name: '/config/services/mpdscribble/status', method: 'GET', path: '/config/services/mpdscribble/status' },
    { name: '/config/services/mpdscribble/action', method: 'POST', path: '/config/services/mpdscribble/action', body: { action: 'restart' } },
    { name: '/config/lastfm/top-tracks', method: 'GET', path: '/config/lastfm/top-tracks' },
    { name: '/config/lastfm/recent-tracks', method: 'GET', path: '/config/lastfm/recent-tracks' },
    { name: '/config/lastfm/top-artists', method: 'GET', path: '/config/lastfm/top-artists' },
    { name: '/config/lastfm/top-albums', method: 'GET', path: '/config/lastfm/top-albums' },
    { name: '/mpd/album-alias-suggestion', method: 'POST', path: '/mpd/album-alias-suggestion', body: {} },
    { name: '/mpd/alexa-heard-album', method: 'POST', path: '/mpd/alexa-heard-album', body: {} },
    { name: '/mpd/alexa-heard-artist', method: 'POST', path: '/mpd/alexa-heard-artist', body: {} },
    { name: '/mpd/alexa-heard-playlist', method: 'POST', path: '/mpd/alexa-heard-playlist', body: {} },
    { name: '/mpd/artist-alias-suggestion', method: 'POST', path: '/mpd/artist-alias-suggestion', body: {} },
    { name: '/mpd/playlist-alias-suggestion', method: 'POST', path: '/mpd/playlist-alias-suggestion', body: {} },
    { name: '/next-up', method: 'GET', path: '/next-up' },
    { name: '/now-playing', method: 'GET', path: '/now-playing' },
    { name: '/podcasts', method: 'GET', path: '/podcasts' },
    { name: '/podcasts/_debug/rebuild-local', method: 'POST', path: '/podcasts/_debug/rebuild-local', body: {} },
    { name: '/podcasts/build-playlist', method: 'POST', path: '/podcasts/build-playlist', body: { items: [] } },
    { name: '/podcasts/cleanup-older-than', method: 'POST', path: '/podcasts/cleanup-older-than', body: { days: 30 } },
    { name: '/podcasts/download-latest', method: 'POST', path: '/podcasts/download-latest', body: { rss: "", scanLimit: 100, downloadCount: 5 } },
    { name: '/podcasts/download-one', method: 'POST', path: '/podcasts/download-one', body: { rss: "", guid: "" } },
    { name: '/podcasts/episodes/delete', method: 'POST', path: '/podcasts/episodes/delete', body: { rss: "", guid: "" } },
    { name: '/podcasts/episodes/list', method: 'POST', path: '/podcasts/episodes/list', body: { rss: "", scanLimit: 100, downloadedOnly: false } },
    { name: '/podcasts/episodes/status', method: 'GET', path: '/podcasts/episodes/status' },
    { name: '/podcasts/list', method: 'GET', path: '/podcasts/list' },
    { name: '/podcasts/nightly-retention', method: 'POST', path: '/podcasts/nightly-retention', body: { enabled: true, days: 30 } },
    { name: '/podcasts/nightly-status', method: 'GET', path: '/podcasts/nightly-status' },
    { name: '/podcasts/refresh', method: 'GET', path: '/podcasts/refresh' },
    { name: '/podcasts/refresh', method: 'POST', path: '/podcasts/refresh', body: { limit: 50 } },
    { name: '/podcasts/refresh-one', method: 'GET', path: '/podcasts/refresh-one' },
    { name: '/podcasts/refresh-one', method: 'POST', path: '/podcasts/refresh-one', body: { rss: "", limit: 50 } },
    { name: '/podcasts/subscribe', method: 'POST', path: '/podcasts/subscribe', body: { rss: "", downloadCount: 5, scanLimit: 50 } },
    { name: '/podcasts/subscription/settings', method: 'POST', path: '/podcasts/subscription/settings', body: { rss: "", downloadCount: 5, limit: 50 } },
    { name: '/podcasts/unsubscribe', method: 'POST', path: '/podcasts/unsubscribe', body: { rss: "" } },
    { name: '/config/moode/display/status', method: 'GET', path: '/config/moode/display/status' },
    { name: '/config/moode/display', method: 'POST', path: '/config/moode/display', body: { mode: "on" } },
    { name: '/config/moode/browser-url/status', method: 'GET', path: '/config/moode/browser-url/status' },
    { name: '/config/moode/browser-url', method: 'POST', path: '/config/moode/browser-url', body: { url: "http://sonuvi.local:8101/display.html" } },
    { name: '/peppy/last-profile', method: 'GET', path: '/peppy/last-profile' },
    { name: '/peppy/last-profile', method: 'POST', path: '/peppy/last-profile', body: { displayMode: "peppy" } },
    { name: '/queue/advance', method: 'POST', path: '/queue/advance', body: { count: 1 } },
    { name: '/queue/mix', method: 'POST', path: '/queue/mix', body: { target: 50 } },
    { name: '/rating', method: 'GET', path: '/rating' },
    { name: '/rating', method: 'POST', path: '/rating', body: { file: "", rating: 3 } },
    { name: '/rating/current', method: 'GET', path: '/rating/current' },
    { name: '/rating/current', method: 'POST', path: '/rating/current', body: { rating: 3 } },
    { name: '/track', method: 'GET', path: '/track' },
  ];

  let endpointList = ENDPOINTS_FALLBACK.slice();
  let visibleEndpoints = [];
  const FAV_KEY = 'diagnostics:favorites:v1';
  const FILTER_KEY = 'diagnostics:endpointFilter:v1';
  const LAST_ENDPOINT_KEY = 'diagnostics:lastEndpoint:v1';
  const STATE_KEY = 'diagnostics:requestState:v1';
  const LIVE_COLLAPSED_KEY = 'diagnostics:liveCardCollapsed:v1';
  const PLAYER_COLLAPSED_KEY = 'diagnostics:playerCardCollapsed:v1';
  const PEPPY_COLLAPSED_KEY = 'diagnostics:peppyCardCollapsed:v1';
  const MOBILE_COLLAPSED_KEY = 'diagnostics:mobileCardCollapsed:v1';
  const KIOSK_COLLAPSED_KEY = 'diagnostics:kioskCardCollapsed:v1';

  function loadFavorites(){
    try {
      const raw = localStorage.getItem(FAV_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.map((x) => String(x || '')) : []);
    } catch (_) { return new Set(); }
  }

  function saveFavorites(set){
    try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
  }

  function endpointKey(e){
    return `${String(e?.method || 'GET').toUpperCase()} ${String(e?.path || '')}`;
  }

  function loadLastEndpointKey(){
    try { return String(localStorage.getItem(LAST_ENDPOINT_KEY) || ''); } catch (_) { return ''; }
  }

  function saveLastEndpointKey(v){
    try { localStorage.setItem(LAST_ENDPOINT_KEY, String(v || '')); } catch (_) {}
  }

  function loadFilterText(){
    try { return String(localStorage.getItem(FILTER_KEY) || ''); } catch (_) { return ''; }
  }

  function saveFilterText(v){
    try { localStorage.setItem(FILTER_KEY, String(v || '')); } catch (_) {}
  }

  function loadRequestState(){
    try {
      const raw = localStorage.getItem(STATE_KEY);
      const j = raw ? JSON.parse(raw) : {};
      return (j && typeof j === 'object') ? j : {};
    } catch (_) { return {}; }
  }

  function saveRequestState(patch = {}){
    const cur = loadRequestState();
    const next = { ...cur, ...patch };
    try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch (_) {}
  }

  async function loadEndpointCatalog(){
    const base = String($('apiBase')?.value || apiBaseDefault()).replace(/\/$/, '');
    const key = String($('key')?.value || '').trim();
    try {
      const r = await fetch(`${base}/config/diagnostics/endpoints`, {
        headers: key ? { 'x-track-key': key } : {},
        cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok || !Array.isArray(j.endpoints) || !j.endpoints.length) return;
      const serverList = j.endpoints.map((e) => ({
        name: String(e?.name || e?.path || '').trim(),
        method: String(e?.method || 'GET').toUpperCase(),
        path: String(e?.path || '').trim(),
        body: (e && typeof e.body === 'object') ? e.body : undefined,
        group: String(e?.group || 'Other').trim(),
      })).filter((e) => e.path);

      // Merge server + fallback so newly-added client-only endpoints still appear
      // even if the running API build has an older diagnostics catalog.
      const byKey = new Map();
      [...serverList, ...ENDPOINTS_FALLBACK].forEach((e) => {
        const k = `${String(e?.method || 'GET').toUpperCase()} ${String(e?.path || '')}`;
        if (!byKey.has(k)) byKey.set(k, e);
      });
      endpointList = Array.from(byKey.values());
    } catch (_) {
      // fallback stays in place
    }
  }

  function setPillState(pillId, state){
    const map = { ok:{c:'#22c55e',b:'rgba(34,197,94,.55)'}, warn:{c:'#f59e0b',b:'rgba(245,158,11,.55)'}, bad:{c:'#ef4444',b:'rgba(239,68,68,.55)'}, off:{c:'#64748b',b:'rgba(100,116,139,.45)'} };
    const s = map[state] || map.off;
    const pill = $(pillId); if (!pill) return;
    const dot = pill.querySelector('.dot');
    if (dot) { dot.style.background = s.c; dot.style.boxShadow = `0 0 0 6px ${s.b.replace('.55','.20')}`; }
    pill.style.borderColor = s.b;
  }

  function apiBaseDefault(){
    return globalThis.NPArt.apiBase();
  }

  function isCollapsed(key){
    try { return localStorage.getItem(String(key || '')) === '1'; } catch (_) { return false; }
  }

  function setCollapsed({ key, bodyId, btnId, on }){
    const collapsed = !!on;
    const body = $(bodyId);
    const btn = $(btnId);
    if (body) body.style.display = collapsed ? 'none' : '';
    if (btn) btn.textContent = collapsed ? 'Expand' : 'Collapse';
    try { localStorage.setItem(String(key || ''), collapsed ? '1' : '0'); } catch (_) {}
  }

  function isLiveCollapsed(){ return isCollapsed(LIVE_COLLAPSED_KEY); }
  function setLiveCollapsed(on){ return setCollapsed({ key: LIVE_COLLAPSED_KEY, bodyId: 'liveCardBody', btnId: 'liveToggleBtn', on }); }
  function isPlayerCollapsed(){ return isCollapsed(PLAYER_COLLAPSED_KEY); }
  function setPlayerCollapsed(on){ return setCollapsed({ key: PLAYER_COLLAPSED_KEY, bodyId: 'playerCardBody', btnId: 'playerToggleBtn', on }); }
  function isPeppyCollapsed(){ return isCollapsed(PEPPY_COLLAPSED_KEY); }
  function setPeppyCollapsed(on){ return setCollapsed({ key: PEPPY_COLLAPSED_KEY, bodyId: 'peppyCardBody', btnId: 'peppyToggleBtn', on }); }
  function isMobileCollapsed(){ return isCollapsed(MOBILE_COLLAPSED_KEY); }
  function setMobileCollapsed(on){ return setCollapsed({ key: MOBILE_COLLAPSED_KEY, bodyId: 'mobileCardBody', btnId: 'mobileToggleBtn', on }); }
  function isKioskCollapsed(){ return isCollapsed(KIOSK_COLLAPSED_KEY); }
  function setKioskCollapsed(on){ return setCollapsed({ key: KIOSK_COLLAPSED_KEY, bodyId: 'kioskCardBody', btnId: 'kioskToggleBtn', on }); }

  function applyZoom(prefix, baseW, baseH, fallback = 55){
    const z = Number($(prefix + 'Zoom')?.value || fallback);
    const scale = Math.max(0.35, Math.min(1, z / 100));
    const wrap = $(prefix + 'FrameScaleWrap');
    const label = $(prefix + 'ZoomLabel');
    const viewport = $(prefix + 'FrameViewport');
    if (wrap) {
      wrap.style.transform = `scale(${scale})`;
      wrap.style.width = `${Math.round(baseW * scale)}px`;
      wrap.style.height = `${Math.round(baseH * scale)}px`;
    }
    if (viewport) viewport.style.minHeight = `${Math.round(baseH * scale) + 16}px`;
    if (label) label.textContent = `${Math.round(scale * 100)}%`;
  }

  function applyLiveZoom(){ applyZoom('live', 1920, 1080, 55); }
  function applyPlayerZoom(){ applyZoom('player', 1280, 400, 45); }
  function applyPeppyZoom(){ applyZoom('peppy', 1280, 400, 60); }
  function applyMobileZoom(){ applyZoom('mobile', 430, 932, 65); }
  function applyKioskZoom(){ applyZoom('kiosk', 1280, 400, 55); }

  function refreshPreviewFrame({ name, frameId, linkId, page, uiPort = 8101, applyZoom }){
    dbg(`refresh${name}Frame(uiPort=${uiPort})`);
    const sameOriginUrl = new URL(page, location.href).toString();
    const fr = $(frameId);
    const a = $(linkId);

    const url = sameOriginUrl;
    const target = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;

    if (fr) {
      fr.onload = () => {
        try {
          const title = String(fr.contentDocument?.title || '');
          const href = String(fr.contentWindow?.location?.href || fr.src || '');
          dbg(`${frameId} onload | title="${title}" | href=${href}`);
        } catch (e) {
          dbg(`${frameId} onload | (inaccessible) | src=${fr.src} | err=${e?.message || e}`);
        }
      };
      fr.onerror = () => {
        dbg(`${frameId} onerror | src=${fr.src}`);
      };
      fr.src = target;
      dbg(`loading ${target}`);
    } else {
      dbg(`${frameId} missing in DOM`);
    }
    if (a) a.href = url;
    if (typeof applyZoom === 'function') applyZoom();
  }

  function refreshLiveFrame(uiPort = 8101){
    refreshPreviewFrame({ name: 'Live', frameId: 'liveFrame', linkId: 'openLiveLink', page: 'index.html', uiPort, applyZoom: applyLiveZoom });
  }

  function refreshPlayerFrame(uiPort = 8101){
    refreshPreviewFrame({ name: 'Player', frameId: 'playerFrame', linkId: 'openPlayerLink', page: 'player.html', uiPort, applyZoom: applyPlayerZoom });
  }

  function refreshPeppyFrame(uiPort = 8101){
    refreshPreviewFrame({ name: 'Peppy', frameId: 'peppyFrame', linkId: 'openPeppyLink', page: 'peppy.html?kiosk=1', uiPort, applyZoom: applyPeppyZoom });
  }

  function refreshMobileFrame(uiPort = 8101){
    refreshPreviewFrame({ name: 'Mobile', frameId: 'mobileFrame', linkId: 'openMobileLink', page: 'controller.html', uiPort, applyZoom: applyMobileZoom });
  }

  function refreshKioskFrame(uiPort = 8101){
    refreshPreviewFrame({ name: 'Kiosk', frameId: 'kioskFrame', linkId: 'openKioskLink', page: 'kiosk.html', uiPort, applyZoom: applyKioskZoom });
  }

  async function loadRuntime(){
    const host = location.hostname || 'sonuvi.local';
    dbg('loadRuntime start');
    try {
      const r = await fetch(`${apiBaseDefault()}/config/runtime`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error('runtime unavailable');
      const cfg = j.config || {};
      const apiPort = Number(cfg?.ports?.api || 3101);
      const uiPort = Number(cfg?.ports?.ui || 8101);
      const base = apiBaseDefault();
      if ($('apiBase')) $('apiBase').value = base;
      if ($('key') && !String($('key').value || '').trim()) {
        // Reuse the operator's existing browser credential; runtime config
        // need not disclose it, and refresh must not erase a manually entered key.
        try {
          $('key').value = String(globalThis.SonuviRuntimeAuth?.trackKey?.()
            || ['nowplaying.trackkey', 'nowplaying.secret.trackKey', 'np_track_key']
              .map((name) => localStorage.getItem(name)).find((value) => String(value || '').trim())
            || '').trim();
        } catch {}
      }
      if ($('apiHint')) $('apiHint').textContent = `${host}:${apiPort}`;
      if ($('webHint')) $('webHint').textContent = `${host}:${uiPort}`;
      const axEnabled = !!cfg?.alexa?.enabled;
      const axDomain = String(cfg?.alexa?.publicDomain || '').trim();
      const moodeHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || cfg?.mpdHost || '').trim();
      ratingsEnabled = Boolean(cfg?.features?.ratings ?? true);
      if ($('alexaHint')) $('alexaHint').textContent = !axEnabled ? 'disabled' : (axDomain ? 'moode.••••••••.com' : 'missing domain');
      if ($('moodeHint')) $('moodeHint').textContent = moodeHost ? `confirmed (${moodeHost})` : 'not verified';
      setPillState('apiPill','ok'); setPillState('webPill','ok'); setPillState('alexaPill', !axEnabled ? 'off' : (axDomain ? 'ok' : 'warn')); setPillState('moodePill', moodeHost ? 'ok' : 'warn');
      dbg(`loadRuntime ok api=${apiPort} ui=${uiPort}`);
      refreshLiveFrame(uiPort);
      refreshPlayerFrame(uiPort);
      refreshPeppyFrame(uiPort);
      refreshMobileFrame(uiPort);
      refreshKioskFrame(uiPort);
      loadQueue();
    } catch (e) {
      dbg(`loadRuntime error: ${e?.message || e}`);
      if ($('apiBase')) $('apiBase').value = apiBaseDefault();
      if ($('apiHint')) $('apiHint').textContent = String($('apiBase')?.value || apiBaseDefault()).replace(/^https?:\/\//,'');
      if ($('webHint')) $('webHint').textContent = `${host}:8101`;
      if ($('alexaHint')) $('alexaHint').textContent = 'unknown';
      if ($('moodeHint')) $('moodeHint').textContent = 'not verified';
      setPillState('apiPill','bad'); setPillState('webPill','warn'); setPillState('alexaPill','warn'); setPillState('moodePill','warn');
      refreshLiveFrame(8101);
      refreshPlayerFrame(8101);
      refreshPeppyFrame(8101);
      refreshMobileFrame(8101);
      loadQueue();
    }
  }

  function updateShuffleBtn(){
    const btn = $('shuffleBtn');
    if (!btn) return;
    btn.textContent = 'Shuffle queue';
    btn.style.borderColor = '';
  }

  async function sendPlayback(action, extra = null, opts = null){
    const base = String($('apiBase').value || apiBaseDefault()).replace(/\/$/,'');
    const key = String($('key').value || '').trim();
    const payload = Object.assign({ action }, extra || {});
    const refreshQueue = opts?.refreshQueue !== false;
    const r = await fetch(`${base}/config/diagnostics/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-track-key': key },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    updateShuffleBtn();
    $('status').textContent = `Playback: ${action}`;
    if (refreshQueue) await loadQueue();
    return j;
  }

  function isPodcastLike(x){
    if (x?.isPodcast === true) return true;
    const file = String(x?.file || '').toLowerCase();
    const album = String(x?.album || '').toLowerCase();
    const artist = String(x?.artist || '').toLowerCase();
    const title = String(x?.title || '').toLowerCase();
    return /\bpodcast\b/.test(`${album} ${artist} ${title}`) || /\/podcasts?\//.test(file);
  }

  function starsHtml(file, rating){
    if (!ratingsEnabled) return '';
    const raw = String(file || '');
    if (raw.includes('://')) return '';
    const f = encodeURIComponent(raw);
    const r = Math.max(0, Math.min(5, Number(rating) || 0));
    let out = '<div style="display:flex;gap:2px;align-items:center;">';
    for (let i = 1; i <= 5; i += 1) {
      const on = i <= r;
      out += `<button type="button" data-rate-file="${f}" data-rate-val="${i}" class="rateStar ${on?'on':'off'}" title="Rate ${i} star${i>1?'s':''}" style="padding:0 2px;border:0;background:transparent;font-size:15px;line-height:1;cursor:pointer;">★</button>`;
    }
    out += '</div>';
    return out;
  }

  function queueControlIcon(name = '') {
    const n = String(name || '').toLowerCase();
    if (n === 'play') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    if (n === 'pause') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
    if (n === 'prev') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3 6 9-6v12z"/></svg>';
    if (n === 'next') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM7 18V6l9 6z"/></svg>';
    if (n === 'repeat') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H6a3 3 0 0 0-3 3v3h2V8a1 1 0 0 1 1-1zm10 10H7v-3l-4 4 4 4v-3h11a3 3 0 0 0 3-3v-3h-2v2a1 1 0 0 1-1 1z"/></svg>';
    if (n === 'shuffle') return '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M24.414,16.586L30.828,23l-6.414,6.414l-2.828-2.828L23.172,25H22c-3.924,0-6.334-2.289-8.173-4.747c0.987-1.097,1.799-2.285,2.516-3.36C18.109,19.46,19.521,21,22,21h1.172l-1.586-1.586L24.414,16.586z M22,11h1.172l-1.586,1.586l2.828,2.828L30.828,9l-6.414-6.414l-2.828,2.828L23.172,7H22c-5.07,0-7.617,3.82-9.664,6.891C10.224,17.059,8.788,19,6,19H2v4h4c5.07,0,7.617-3.82,9.664-6.891C17.776,12.941,19.212,11,22,11z M10.212,15.191c0.399-0.539,1.957-2.848,2.322-3.365C10.917,10.216,8.86,9,6,9H2v4h4C7.779,13,9.007,13.797,10.212,15.191z"/></svg>';
    return '';
  }

  async function loadQueue(){
    if (queueLoadInFlight) return;
    queueLoadInFlight = true;
    const base = String($('apiBase').value || apiBaseDefault()).replace(/\/$/,'');
    const key = String($('key').value || '').trim();
    const wrap = $('queueWrap');
    if (!wrap) { queueLoadInFlight = false; return; }
    if (!wrap.innerHTML.trim()) wrap.innerHTML = 'Loading queue…';
    try {
      const r = await fetch(`${base}/config/diagnostics/queue`, { headers: { 'x-track-key': key } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      updateShuffleBtn();
      if (typeof j?.ratingsEnabled === 'boolean') ratingsEnabled = j.ratingsEnabled;
      const items = Array.isArray(j.items) ? j.items : [];

      // Head stream fallback: prefer now-playing enriched art (e.g., iTunes) over moOde question-mark art.
      try {
        const head = items.find((x) => !!x?.isHead);
        const isHeadStream = !!head && (head.isStream || String(head.file || '').includes('://'));
        if (isHeadStream) {
          const nr = await fetch(`${base}/now-playing`, { headers: { 'x-track-key': key } });
          const nj = await nr.json().catch(() => ({}));
          const npArt = String(nj?.albumArtUrl || '').trim();
          if (npArt && /^https?:\/\//i.test(npArt)) {
            head.thumbUrl = npArt;
          }
        }
      } catch {}

      if (!items.length) { wrap.innerHTML = '<div class="muted">Queue is empty.</div>'; return; }
      wrap.innerHTML = items.slice(0, 80).map((x) => {
        const thumbSrc = x.thumbUrl ? (String(x.thumbUrl).startsWith('http') ? String(x.thumbUrl) : `${base}${x.thumbUrl}`) : '';
        const thumb = thumbSrc ? `<img src="${thumbSrc}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid #2a3a58;background:#111;" />` : '<div style="width:36px;height:36px"></div>';
        const head = !!x.isHead;
        const isStream = !!x.isStream || String(x.file || '').includes('://');
        const pos = Number(x.position || 0);
        const stars = isPodcastLike(x) ? '' : starsHtml(x.file, Number(x.rating || 0));
        const starsRow = stars ? `<div style="margin-top:2px;">${stars}</div>` : '';

        const stationName = String(x.stationName || x.album || '').trim() || 'Radio Stream';
        const stationGenre = String(x.stationGenre || '').trim();
        const isYoutube = !!x.isYoutube || /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(String(x.file || ''));
        const favBtn = (isStream && !isYoutube)
          ? `<button type="button" data-queue-fav-file="${encodeURIComponent(String(x.file || ''))}" data-queue-fav-state="${x.isFavoriteStation ? '1' : '0'}" title="${x.isFavoriteStation ? 'Unfavorite station' : 'Favorite station'}" style="margin-left:6px;border:0;background:transparent;cursor:pointer;font-size:16px;line-height:1;color:${x.isFavoriteStation ? '#ef4444' : '#7f8fae'}">♥</button>`
          : '';
        const displayArtist = isStream
          ? (isYoutube ? (String(x.title || '').trim() || 'YouTube Audio Stream') : stationName)
          : String(x.artist || '');
        const displayTitle = isStream ? String(x.title || '').trim() : String(x.title || '');
        const detailLine = isStream
          ? (isYoutube
              ? (String(x.artist || '').trim() || 'YouTube')
              : ((head && displayTitle)
                  ? `${displayTitle}${stationGenre ? ` • ${stationGenre}` : ''}`
                  : (stationGenre || '')))
          : (displayTitle ? `${displayTitle} ${x.album ? `• ${String(x.album)}` : ''}` : '');

        const moveBtns = `<div style="display:flex;gap:4px;margin-left:auto;"><button type="button" data-move-pos="${pos}" data-move-dir="up" title="Move up">↑</button><button type="button" data-move-pos="${pos}" data-move-dir="down" title="Move down">↓</button><button type="button" data-remove-pos="${pos}" title="Remove from queue">Remove</button></div>`;
        return `<div data-queue-play-pos="${pos}" style="display:flex;gap:8px;align-items:center;padding:6px 6px;border-bottom:1px dashed #233650;cursor:pointer;${head?'background:rgba(34,197,94,.15);border-radius:8px;':''}">${thumb}<div style="min-width:0;flex:1 1 auto;"><div><b>${String(x.position||0)}</b>. ${head?'▶️ ':''}${displayArtist}${favBtn}</div><div class="muted">${detailLine}</div>${starsRow}</div>${moveBtns}</div>`;
      }).join('');
    } catch (e) {
      wrap.innerHTML = `<div class="muted">Queue load failed: ${e?.message || e}</div>`;
    } finally {
      queueLoadInFlight = false;
    }
  }

  function hydrateEndpoints(){
    const sel = $('endpoint');
    const filterTxtRaw = String($('endpointFilter')?.value || '');
    const filterTxt = filterTxtRaw.trim().toLowerCase();
    const favs = loadFavorites();

    const source = Array.isArray(endpointList) && endpointList.length ? endpointList : ENDPOINTS_FALLBACK;
    const list = source.filter((e) => {
      if (!filterTxt) return true;
      const blob = `${String(e.group || '')} ${String(e.method || '')} ${String(e.name || '')} ${String(e.path || '')}`.toLowerCase();
      return blob.includes(filterTxt);
    });

    const favorites = list.filter((e) => favs.has(endpointKey(e))).sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
    const nonFavs = list.filter((e) => !favs.has(endpointKey(e)));

    const byGroup = new Map();
    for (const e of nonFavs) {
      const g = String(e.group || 'Other');
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(e);
    }

    const flat = [];
    const html = [];

    if (favorites.length) {
      html.push('<optgroup label="⭐ Favorites">');
      for (const e of favorites) {
        flat.push(e);
        html.push(`<option value="${flat.length - 1}">${String(e.method || 'GET').toUpperCase()} ${String(e.name || e.path || '')}</option>`);
      }
      html.push('</optgroup>');
    }

    for (const [group, arr] of byGroup.entries()) {
      html.push(`<optgroup label="${group}">`);
      for (const e of arr) {
        flat.push(e);
        html.push(`<option value="${flat.length - 1}">${String(e.method || 'GET').toUpperCase()} ${String(e.name || e.path || '')}</option>`);
      }
      html.push('</optgroup>');
    }

    visibleEndpoints = flat;
    sel.innerHTML = html.join('') || '<option value="0">(no matches)</option>';

    const lastKey = loadLastEndpointKey();
    const hitIdx = visibleEndpoints.findIndex((e) => endpointKey(e) === lastKey);
    if (hitIdx >= 0) sel.value = String(hitIdx);

    const apply = () => {
      const e = visibleEndpoints[Number(sel.value) || 0] || { method: 'GET', path: '/' };
      saveLastEndpointKey(endpointKey(e));
      const state = loadRequestState();
      const eKey = endpointKey(e);
      $('method').value = String(state?.overrides?.[eKey]?.method || e.method || 'GET').toUpperCase();
      $('path').value = String(state?.overrides?.[eKey]?.path || e.path || '/');
      $('body').value = JSON.stringify(state?.overrides?.[eKey]?.body ?? e.body ?? {}, null, 2);
      $('bodyWrap').style.display = ($('method').value === 'POST') ? '' : 'none';
      const isFav = favs.has(endpointKey(e));
      const fb = $('favBtn');
      if (fb) fb.textContent = isFav ? '⭐ Favorited' : '⭐ Favorite';
    };

    sel.onchange = apply;
    $('method').onchange = () => $('bodyWrap').style.display = ($('method').value === 'POST') ? '' : 'none';
    apply();
  }

  async function run(){
    const base = String($('apiBase').value || apiBaseDefault()).replace(/\/$/,'');
    const path = String($('path').value || '').trim();
    const method = String($('method').value || 'GET');
    const useKey = !!$('useTrackKey').checked;
    const key = String($('key').value || '').trim();
    const out = $('out');
    const st = $('status');
    const meta = $('meta');
    const imageWrap = $('imageWrap');
    const imageOut = $('imageOut');
    const outputCard = $('outputCard');
    const requestCard = $('requestCard');

    if (!path) return;
    const url = `${base}${path.startsWith('/') ? path : '/' + path}`;
    const headers = {};
    if (useKey && key) headers['x-track-key'] = key;
    let body;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      try { body = JSON.stringify(JSON.parse($('body').value || '{}')); }
      catch (e) { out.textContent = `Invalid JSON body: ${e.message}`; return; }
    }

    st.innerHTML = '<span class="spin"></span>Running…';
    if (outputCard) outputCard.style.display = '';
    if (outputCard && requestCard && outputCard.previousElementSibling !== requestCard) {
      requestCard.insertAdjacentElement('afterend', outputCard);
    }
    if (imageWrap) imageWrap.style.display = 'none';
    if (imageOut) imageOut.removeAttribute('src');
    outputCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const t0 = performance.now();
    try {
      const r = await fetch(url, { method, headers, body });
      const ms = Math.round(performance.now() - t0);
      const ctype = String(r.headers.get('content-type') || '').toLowerCase();

      if (ctype.startsWith('image/')) {
        const blob = await r.blob();
        const objUrl = URL.createObjectURL(blob);
        if (imageOut) imageOut.src = objUrl;
        if (imageWrap) imageWrap.style.display = '';
        out.textContent = `[image response: ${ctype}, ${blob.size} bytes]`;
      } else {
        const txt = await r.text();
        let parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch {}
        out.textContent = parsed ? JSON.stringify(parsed, null, 2) : txt;
      }

      meta.textContent = `${method} ${url}  •  HTTP ${r.status}  •  ${ms} ms`;
      st.textContent = r.ok ? 'Done.' : 'Completed with errors.';
    } catch (e) {
      meta.textContent = `${method} ${url}`;
      out.textContent = `Request failed: ${e?.message || e}`;
      st.textContent = 'Request failed.';
    }
  }

  $('runBtn')?.addEventListener('click', () => run());
  $('reloadLiveBtn')?.addEventListener('click', () => loadRuntime());
  $('reloadPlayerBtn')?.addEventListener('click', () => loadRuntime());
  $('reloadPeppyBtn')?.addEventListener('click', () => loadRuntime());
  $('reloadMobileBtn')?.addEventListener('click', () => loadRuntime());
  $('reloadKioskBtn')?.addEventListener('click', () => loadRuntime());
  $('liveZoom')?.addEventListener('input', applyLiveZoom);
  $('playerZoom')?.addEventListener('input', applyPlayerZoom);
  $('peppyZoom')?.addEventListener('input', applyPeppyZoom);
  $('mobileZoom')?.addEventListener('input', applyMobileZoom);
  $('kioskZoom')?.addEventListener('input', applyKioskZoom);
  $('liveToggleBtn')?.addEventListener('click', () => setLiveCollapsed(!isLiveCollapsed()));
  $('playerToggleBtn')?.addEventListener('click', () => setPlayerCollapsed(!isPlayerCollapsed()));
  $('peppyToggleBtn')?.addEventListener('click', () => setPeppyCollapsed(!isPeppyCollapsed()));
  $('mobileToggleBtn')?.addEventListener('click', () => setMobileCollapsed(!isMobileCollapsed()));
  $('kioskToggleBtn')?.addEventListener('click', () => setKioskCollapsed(!isKioskCollapsed()));
  $('queueWrap')?.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;

    const playbackBtn = el ? el.closest('button[data-queue-playback]') : null;
    if (playbackBtn) {
      ev.preventDefault();
      playbackBtn.classList.add('clicked');
      setTimeout(() => playbackBtn.classList.remove('clicked'), 140);
      const raw = String(playbackBtn.getAttribute('data-queue-playback') || '').trim().toLowerCase();
      const action = raw === 'togglepp' ? (queuePlayPauseMode === 'play' ? 'play' : 'pause') : raw;
      playbackBtn.disabled = true;
      sendPlayback(action)
        .then(() => {
          if (raw === 'togglepp') queuePlayPauseMode = action === 'play' ? 'pause' : 'play';
        })
        .catch((e) => { $('status').textContent = String(e?.message || e); })
        .finally(() => { playbackBtn.disabled = false; });
      return;
    }

    const favBtn = el ? el.closest('button[data-queue-fav-file]') : null;
    if (favBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const base = String($('apiBase').value || apiBaseDefault()).replace(/\/$/, '');
      const key = String($('key').value || '').trim();
      const file = decodeURIComponent(String(favBtn.getAttribute('data-queue-fav-file') || ''));
      const curr = String(favBtn.getAttribute('data-queue-fav-state') || '0') === '1';
      if (!file) return;
      favBtn.disabled = true;
      fetch(`${base}/config/queue-wizard/radio-favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-track-key': key },
        body: JSON.stringify({ station: file, favorite: !curr }),
      })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok || !j?.ok) throw new Error(j?.error || 'favorite update failed');
          $('status').textContent = j.favorite ? 'Station favorited.' : 'Station unfavorited.';
          return loadQueue();
        })
        .catch((e) => { $('status').textContent = String(e?.message || e); })
        .finally(() => { favBtn.disabled = false; });
      return;
    }

    const rowPlayEl = el ? el.closest('[data-queue-play-pos]') : null;
    if (rowPlayEl && !el.closest('button')) {
      ev.preventDefault();
      const pos = Number(rowPlayEl.getAttribute('data-queue-play-pos') || 0);
      if (Number.isFinite(pos) && pos > 0) {
        sendPlayback('playpos', { position: pos })
          .then(() => loadQueue())
          .then(() => { $('status').textContent = `Playing queue position ${pos}.`; })
          .catch((e) => { $('status').textContent = String(e?.message || e); });
      }
      return;
    }

    const rateBtn = el ? el.closest('button[data-rate-file][data-rate-val]') : null;
    if (rateBtn) {
      if (!ratingsEnabled) return;
      ev.preventDefault();
      ev.stopPropagation();
      const encFile = String(rateBtn.getAttribute('data-rate-file') || '');
      const file = decodeURIComponent(encFile || '');
      const rating = Number(rateBtn.getAttribute('data-rate-val') || 0);
      if (!file || !Number.isFinite(rating) || rating < 0 || rating > 5) return;

      const row = rateBtn.closest('div');
      if (row) {
        const stars = row.querySelectorAll('button[data-rate-file][data-rate-val]');
        stars.forEach((s) => {
          const v = Number(s.getAttribute('data-rate-val') || 0);
          s.classList.toggle('on', v <= rating);
          s.classList.toggle('off', v > rating);
        });
      }

      rateBtn.disabled = true;
      sendPlayback('rate', { file, rating }, { refreshQueue: false })
        .then(() => { $('status').textContent = `Rated: ${rating} star${rating===1?'':'s'}`; })
        .catch((e) => { $('status').textContent = String(e?.message || e); })
        .finally(() => { rateBtn.disabled = false; });
      return;
    }

    const moveBtn = el ? el.closest('button[data-move-pos][data-move-dir]') : null;
    if (moveBtn) {
      const fromPosition = Number(moveBtn.getAttribute('data-move-pos') || 0);
      const dir = String(moveBtn.getAttribute('data-move-dir') || '');
      if (!Number.isFinite(fromPosition) || fromPosition <= 0) return;
      const toPosition = dir === 'up' ? (fromPosition - 1) : (fromPosition + 1);
      if (toPosition <= 0) return;
      moveBtn.disabled = true;
      sendPlayback('move', { fromPosition, toPosition })
        .then(() => { $('status').textContent = `Moved queue item ${fromPosition} ${dir}.`; })
        .catch((e) => { $('status').textContent = String(e?.message || e); })
        .finally(() => { moveBtn.disabled = false; });
      return;
    }

    const btn = el ? el.closest('button[data-remove-pos]') : null;
    if (!btn) return;
    const pos = Number(btn.getAttribute('data-remove-pos') || 0);
    if (!Number.isFinite(pos) || pos <= 0) return;
    btn.disabled = true;
    sendPlayback('remove', { position: pos })
      .then(() => { $('status').textContent = `Removed track at position ${pos}`; })
      .catch((e) => { $('status').textContent = String(e?.message || e); })
      .finally(() => { btn.disabled = false; });
  });
  // Transport controls are rendered inside queueWrap and handled via event delegation.
  async function copyTextSmart(text){
    const txt = String(text || '');
    if (!txt) return false;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(txt);
        return true;
      }
    } catch {}

    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  async function copyResponse(){
    const ok = await copyTextSmart($('out').textContent || '');
    $('status').textContent = ok ? 'Response copied.' : 'Copy failed.';
  }

  async function copyAsCurl(){
    try {
      const base = String($('apiBase').value || apiBaseDefault()).replace(/\/$/, '');
      const path = String($('path').value || '').trim();
      const method = String($('method').value || 'GET').toUpperCase();
      const useKey = !!$('useTrackKey').checked;
      const key = String($('key').value || '').trim();
      const url = `${base}${path.startsWith('/') ? path : '/' + path}`;
      const parts = [`curl -s -X ${method}`];
      if (useKey && key) parts.push(`-H 'x-track-key: ${key.replace(/'/g, "'\\''")}'`);
      if (method === 'POST') {
        const bodyObj = JSON.parse($('body').value || '{}');
        const bodyTxt = JSON.stringify(bodyObj);
        parts.push(`-H 'Content-Type: application/json'`);
        parts.push(`-d '${bodyTxt.replace(/'/g, "'\\''")}'`);
      }
      parts.push(`'${url.replace(/'/g, "'\\''")}'`);
      const ok = await copyTextSmart(parts.join(' '));
      $('status').textContent = ok ? 'Copied as curl.' : 'Copy as curl failed.';
    } catch (e) {
      $('status').textContent = `Copy as curl failed: ${e?.message || e}`;
    }
  }

  function toggleFavorite(){
    const e = visibleEndpoints[Number($('endpoint')?.value || 0)] || null;
    if (!e) return;
    const favs = loadFavorites();
    const k = endpointKey(e);
    if (favs.has(k)) favs.delete(k); else favs.add(k);
    saveFavorites(favs);
    hydrateEndpoints();
  }

  $('copyBtn')?.addEventListener('click', copyResponse);
  $('copyBtnCard')?.addEventListener('click', copyResponse);
  $('copyCurlBtn')?.addEventListener('click', copyAsCurl);
  $('favBtn')?.addEventListener('click', toggleFavorite);
  $('endpointFilter')?.addEventListener('input', () => {
    saveFilterText($('endpointFilter')?.value || '');
    hydrateEndpoints();
  });
  $('useTrackKey')?.addEventListener('change', () => {
    saveRequestState({ useTrackKey: !!$('useTrackKey')?.checked });
  });
  const saveEndpointOverride = () => {
    const e = visibleEndpoints[Number($('endpoint')?.value || 0)] || null;
    if (!e) return;
    const key = endpointKey(e);
    let bodyObj = {};
    try { bodyObj = JSON.parse($('body')?.value || '{}'); } catch { bodyObj = {}; }
    const state = loadRequestState();
    const overrides = { ...(state.overrides || {}) };
    overrides[key] = {
      method: String($('method')?.value || 'GET').toUpperCase(),
      path: String($('path')?.value || '').trim(),
      body: bodyObj,
    };
    saveRequestState({ overrides });
  };
  $('method')?.addEventListener('change', saveEndpointOverride);
  $('path')?.addEventListener('change', saveEndpointOverride);
  $('body')?.addEventListener('change', saveEndpointOverride);

  (async () => {
    const filterEl = $('endpointFilter');
    if (filterEl) filterEl.value = loadFilterText();
    const state = loadRequestState();
    if (typeof state.useTrackKey === 'boolean' && $('useTrackKey')) {
      $('useTrackKey').checked = state.useTrackKey;
    }
    setLiveCollapsed(isLiveCollapsed());
    setPlayerCollapsed(isPlayerCollapsed());
    setPeppyCollapsed(isPeppyCollapsed());
    setMobileCollapsed(isMobileCollapsed());
    setKioskCollapsed(isKioskCollapsed());
    // Prime previews immediately, even if runtime fetch is slow/failing.
    try { refreshLiveFrame(8101); } catch (e) { dbg(`prime live refresh error: ${e?.message || e}`); }
    try { refreshPlayerFrame(8101); } catch (e) { dbg(`prime player refresh error: ${e?.message || e}`); }
    try { refreshPeppyFrame(8101); } catch (e) { dbg(`prime peppy refresh error: ${e?.message || e}`); }
    try { refreshMobileFrame(8101); } catch (e) { dbg(`prime mobile refresh error: ${e?.message || e}`); }
    try { refreshKioskFrame(8101); } catch (e) { dbg(`prime kiosk refresh error: ${e?.message || e}`); }
    await loadRuntime();
    await loadEndpointCatalog();
    hydrateEndpoints();

  })();

  window.addEventListener('heroTransport:update', () => {
    if (document.hidden) return;
    loadQueue().catch(() => {});
  });
})();
