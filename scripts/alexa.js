(() => {
  const $ = (id) => document.getElementById(id);
  const TRACK_KEY_STORAGE = 'np_track_key';
  let runtimeConfig = null;

  function apiBaseDefault(){
    const host = location.hostname || 'sonuvi.local';
    return `${location.protocol}//${host}:3101`;
  }

  function status(msg){
    const el = $('status');
    if (el) el.textContent = msg;
  }

  function setPillState(pillId, state){
    const map = {
      ok:{c:'#22c55e',b:'rgba(34,197,94,.55)'},
      warn:{c:'#f59e0b',b:'rgba(245,158,11,.55)'},
      bad:{c:'#ef4444',b:'rgba(239,68,68,.55)'},
      off:{c:'#64748b',b:'rgba(100,116,139,.45)'}
    };
    const s = map[state] || map.off;
    const pill = $(pillId); if (!pill) return;
    const dot = pill.querySelector('.dot');
    if (dot) { dot.style.background = s.c; dot.style.boxShadow = `0 0 0 6px ${s.b.replace('.55','.20')}`; }
    pill.style.borderColor = s.b;
  }

  function updateServicePillsFromConfig(cfg){
    const c = cfg || {};
    const host = location.hostname || 'sonuvi.local';
    const ports = c.ports || {};
    const apiPort = Number(ports.api || 3101);
    const uiPort = Number(ports.ui || 8101);
    const ax = c.alexa || {};
    const axEnabled = !!ax.enabled;
    const axDomain = String(ax.publicDomain || '').trim();
    const moodeHost = String(c?.moode?.sshHost || c?.mpd?.host || c?.mpdHost || c?.moodeSshHost || '').trim();

    if ($('apiHint')) $('apiHint').textContent = `${host}:${apiPort}`;
    if ($('webHint')) $('webHint').textContent = `${host}:${uiPort}`;
    if ($('alexaHint')) $('alexaHint').textContent = !axEnabled ? 'disabled' : (axDomain ? 'moode.••••••••.com' : 'missing domain');
    if ($('moodeHint')) $('moodeHint').textContent = moodeHost ? `confirmed (${moodeHost})` : 'not verified';

    setPillState('apiPill','ok');
    setPillState('webPill','ok');
    setPillState('alexaPill', !axEnabled ? 'off' : (axDomain ? 'ok' : 'warn'));
    setPillState('moodePill', moodeHost ? 'ok' : 'warn');
  }

  function setAliasesSaveNote(msg, ok = true) {
    const el = $('aliasesSaveNote');
    if (!el) return;
    el.textContent = String(msg || '');
    el.style.color = ok ? '#86efac' : '#fca5a5';
  }

  async function withButtonFeedback(btn, action, opts = {}) {
    if (!btn) return action();
    const idle = String(opts.idle || btn.dataset.idleText || btn.textContent || 'Save');
    const busy = String(opts.busy || 'Saving…');
    const done = String(opts.done || 'Saved ✓');

    btn.dataset.idleText = idle;
    btn.disabled = true;
    btn.textContent = busy;
    btn.style.opacity = '0.85';

    try {
      const out = await action();
      btn.textContent = done;
      btn.style.background = '#14532d';
      setTimeout(() => {
        btn.textContent = idle;
        btn.style.background = '';
        btn.style.opacity = '';
        btn.disabled = false;
      }, 900);
      return out;
    } catch (e) {
      btn.textContent = 'Save failed';
      btn.style.background = '#7f1d1d';
      setTimeout(() => {
        btn.textContent = idle;
        btn.style.background = '';
        btn.style.opacity = '';
        btn.disabled = false;
      }, 1200);
      throw e;
    }
  }

  function pretty(obj){ return JSON.stringify(obj || {}, null, 2); }

  function parseJsonField(id){
    const raw = String($(id)?.value || '').trim();
    if (!raw) return {};
    const out = JSON.parse(raw);
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(`${id} must be a JSON object`);
    return out;
  }

  function aliasKey(s){ return String(s || '').trim().toLowerCase(); }

  function readAliasMap(id){
    try {
      const obj = parseJsonField(id);
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (_) {
      return {};
    }
  }

  function renderHeard(id, rows, field, type){
    const host = $(id);
    if (!host) return;

    const mapId = type === 'album' ? 'albumAliases' : (type === 'playlist' ? 'playlistAliases' : 'artistAliases');
    const aliases = readAliasMap(mapId);

    const all = (Array.isArray(rows) ? rows : [])
      .filter((r) => {
        const what = String(r?.[field] || '').trim();
        return !!what;
      });

    // If an item has an error row, hide its attempt rows to reduce noise.
    const hasErrorByKey = new Set();
    for (const r of all) {
      const what = String(r?.[field] || '').trim();
      const st = String(r?.status || 'seen').trim().toLowerCase();
      const isError = /(^|[^a-z])(error|failed|failure|not[\s_-]?found|no[\s_-]?match)([^a-z]|$)/.test(st);
      if (what && isError) hasErrorByKey.add(aliasKey(what));
    }

    const list = all
      .filter((r) => {
        const what = String(r?.[field] || '').trim();
        const st = String(r?.status || 'seen').trim().toLowerCase();
        const isAttempt = st === 'attempt';
        if (isAttempt && hasErrorByKey.has(aliasKey(what))) return false;
        return true;
      })
      .slice(0, 20);

    if (!list.length) { host.innerHTML = '<div>None</div>'; return; }

    host.innerHTML = list.map((r, idx) => {
      const what = String(r?.[field] || '').trim() || '(blank)';
      const st = String(r?.status || 'seen').trim().toLowerCase();
      const srcRaw = String(r?.source || '').trim().toLowerCase();
      const src = srcRaw.replace(/^alexa-?/, '');
      const safeWhat = what.replace(/</g,'&lt;');
      const isError = /(^|[^a-z])(error|failed|failure|not[\s_-]?found|no[\s_-]?match)([^a-z]|$)/.test(st);
      const isOk = ['ok', 'success', 'matched', 'played'].includes(st);
      const meta = src ? `${st} · ${src}` : st;
      const mapped = String(aliases[aliasKey(what)] || '').trim();
      const hasMapping = !!mapped;
      const showFix = isError && !hasMapping;
      const chipStyle = isError
        ? 'display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid #7f1d1d;background:#3f1212;color:#fecaca;font-size:12px;'
        : (isOk
            ? 'display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid #14532d;background:#052e16;color:#bbf7d0;font-size:12px;'
            : 'display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid #2a3a58;background:#16233f;color:#c7d2fe;font-size:12px;');
      const mapChip = hasMapping
        ? ` <span style="display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid #14532d;background:#052e16;color:#bbf7d0;font-size:12px;">→ ${mapped.replace(/</g,'&lt;')}</span>`
        : '';
      return `<div style="margin:4px 0;">• <code>${safeWhat}</code> <span style="${chipStyle}">${meta}</span>${mapChip}${showFix ? ` <button type="button" data-fix-type="${type}" data-heard="${encodeURIComponent(what)}" data-row="${idx}" style="margin-left:6px;">Fix</button>` : ''}</div>`;
    }).join('');
  }

  async function load(){
    const base = apiBaseDefault();
    const key = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || localStorage.getItem(TRACK_KEY_STORAGE) || '').trim();
    if (!key) throw new Error('Track key is required to load Alexa administration settings. Enter it in Config first.');
    const r = await fetch(`${base}/config/runtime/admin`, {
      cache: 'no-store',
      headers: { 'x-track-key': key },
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    runtimeConfig = j.config || {};
    localStorage.setItem(TRACK_KEY_STORAGE, key);

    const ax = runtimeConfig.alexa || {};
    $('alexaEnabled').checked = !!ax.enabled;
    $('publicDomain').value = String(ax.publicDomain || '');
    $('artistAliases').value = pretty(ax.artistAliases || {});
    $('albumAliases').value = pretty(ax.albumAliases || {});
    $('playlistAliases').value = pretty(ax.playlistAliases || {});

    renderHeard('heardArtists', ax.heardArtists, 'artist', 'artist');
    renderHeard('heardAlbums', ax.heardAlbums, 'album', 'album');
    renderHeard('heardPlaylists', ax.heardPlaylists, 'playlist', 'playlist');
    updateServicePillsFromConfig(runtimeConfig);

    status('Loaded.');
  }

  async function postRuntime(nextAlexa){
    const base = apiBaseDefault();
    const key = String(localStorage.getItem(TRACK_KEY_STORAGE) || '').trim();
    if (!key) throw new Error('Missing track key. Open Config once to load it.');

    const payload = { config: { alexa: nextAlexa } };
    const r = await fetch(`${base}/config/runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-track-key': key },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  }

  async function saveSettings(){
    if (!runtimeConfig) throw new Error('Runtime config not loaded yet');
    const ax = runtimeConfig.alexa || {};
    const nextAlexa = {
      ...ax,
      enabled: !!$('alexaEnabled').checked,
      publicDomain: String($('publicDomain').value || '').trim(),
    };
    await postRuntime(nextAlexa);
    status('Saved Alexa settings.');
    await load();
  }

  async function saveAliases(){
    if (!runtimeConfig) throw new Error('Runtime config not loaded yet');
    const ax = runtimeConfig.alexa || {};
    const nextAlexa = {
      ...ax,
      artistAliases: parseJsonField('artistAliases'),
      albumAliases: parseJsonField('albumAliases'),
      playlistAliases: parseJsonField('playlistAliases'),
    };
    await postRuntime(nextAlexa);
    const when = new Date().toLocaleTimeString();
    setAliasesSaveNote(`Saved at ${when}.`, true);
    status('Saved Alexa corrections.');
    await load();
  }

  async function clearHeard(kind){
    if (!runtimeConfig) throw new Error('Runtime config not loaded yet');
    const ax = runtimeConfig.alexa || {};
    const nextAlexa = { ...ax };
    if (kind === 'artist') nextAlexa.heardArtists = [];
    if (kind === 'album') nextAlexa.heardAlbums = [];
    if (kind === 'playlist') nextAlexa.heardPlaylists = [];
    await postRuntime(nextAlexa);
    status(`Cleared recently heard ${kind}s.`);
    await load();
  }

  $('saveSettingsBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    try {
      await withButtonFeedback(btn, () => saveSettings(), { busy: 'Saving…', done: 'Saved ✓' });
    } catch (e) {
      status(`Error: ${e.message || e}`);
    }
  });

  $('clearHeardArtistsBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!confirm('Clear recently heard artists list?')) return;
    try { await withButtonFeedback(btn, () => clearHeard('artist'), { idle: 'Clear', busy: 'Clearing…', done: 'Cleared ✓' }); }
    catch (e) { status(`Error: ${e.message || e}`); }
  });
  $('clearHeardAlbumsBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!confirm('Clear recently heard albums list?')) return;
    try { await withButtonFeedback(btn, () => clearHeard('album'), { idle: 'Clear', busy: 'Clearing…', done: 'Cleared ✓' }); }
    catch (e) { status(`Error: ${e.message || e}`); }
  });
  $('clearHeardPlaylistsBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!confirm('Clear recently heard playlists list?')) return;
    try { await withButtonFeedback(btn, () => clearHeard('playlist'), { idle: 'Clear', busy: 'Clearing…', done: 'Cleared ✓' }); }
    catch (e) { status(`Error: ${e.message || e}`); }
  });

  $('saveAliasesBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    try {
      setAliasesSaveNote('');
      await withButtonFeedback(btn, () => saveAliases(), { busy: 'Saving…', done: 'Saved ✓' });
    } catch (e) {
      setAliasesSaveNote(`Save failed: ${e.message || e}`, false);
      status(`Error: ${e.message || e}`);
    }
  });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-fix-type]') : null;
    if (!btn) return;
    const type = String(btn.getAttribute('data-fix-type') || '').trim();
    const heard = decodeURIComponent(String(btn.getAttribute('data-heard') || ''));
    if (!heard || heard === '(blank)') return;

    const mapId = type === 'album' ? 'albumAliases' : (type === 'playlist' ? 'playlistAliases' : 'artistAliases');
    const label = type === 'album' ? 'album' : (type === 'playlist' ? 'playlist' : 'artist');
    const map = readAliasMap(mapId);
    const suggested = String(map[aliasKey(heard)] || heard).trim();
    const corrected = window.prompt(`Correct ${label} for "${heard}"`, suggested);
    if (corrected === null) return;
    const out = String(corrected || '').trim();
    if (!out) return;

    map[aliasKey(heard)] = out;
    $(mapId).value = pretty(map);
    try {
      await saveAliases();
      status(`Saved correction: ${heard} → ${out}`);
    } catch (e) {
      status(`Error: ${e.message || e}`);
    }
  });

  load().catch((e) => {
    if ($('apiHint')) $('apiHint').textContent = (apiBaseDefault() || '').replace(/^https?:\/\//, '');
    if ($('webHint')) $('webHint').textContent = `${location.hostname || 'sonuvi.local'}:8101`;
    if ($('alexaHint')) $('alexaHint').textContent = 'unknown';
    if ($('moodeHint')) $('moodeHint').textContent = 'not verified';
    setPillState('apiPill','bad');
    setPillState('webPill','warn');
    setPillState('alexaPill','warn');
    setPillState('moodePill','warn');
    status(`Error: ${e.message || e}`);
  });
})();
