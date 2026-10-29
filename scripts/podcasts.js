  const statusEl   = document.getElementById('status');
  const statusWrap = document.getElementById('statusWrap');
  const listEl     = document.getElementById('list');
  const subCountEl = document.getElementById('subCount');

  const rssEl      = document.getElementById('rss');
  const dlEl       = document.getElementById('download');
  const limitEl    = document.getElementById('limit');
  const logEl      = document.getElementById('log');

  const btnSub     = document.getElementById('btnSub');
  const btnRefresh = document.getElementById('btnRefresh');
  const nightlyStatusEl = document.getElementById('nightlyStatus');
  const retentionEnabledEl = document.getElementById('retentionEnabled');
  const retentionDaysEl = document.getElementById('retentionDays');
  const saveRetentionBtn = document.getElementById('saveRetentionBtn');
  const runCleanupBtn = document.getElementById('runCleanupBtn');
  const queueWrapEl = document.getElementById('queueWrap');

  let API_BASE = (() => {
    const q = new URLSearchParams(window.location.search);
    const override = (q.get('api') || '').trim();
    if (override) return override.replace(/\/$/, '');

    const host = window.location.hostname || 'sonuvi.local';
    return `http://${host}:3101`;
  })();
  let runtimeTrackKey = '';
  let nightlyAutomationReady = false;
  let nightlyStatusState = {};

  function currentKey(){
    return String(runtimeTrackKey || '').trim();
  }

  function nightlyCronCommand(){
    const k = currentKey() || 'YOUR_TRACK_KEY';
    return `15 2 * * * /usr/bin/curl -fsS -m 3300 -X POST http://127.0.0.1:3101/podcasts/nightly-run -H "content-type: application/json" -H "x-track-key: ${k}" --data "{}" >> /opt/now-playing/var/podcasts/nightly-cron.log 2>&1`;
  }

  function syncRetentionUiGate(){
    const ready = !!nightlyAutomationReady;
    const disabled = !ready;
    if (retentionEnabledEl) retentionEnabledEl.disabled = disabled;
    if (retentionDaysEl) retentionDaysEl.disabled = disabled;
    if (saveRetentionBtn) saveRetentionBtn.disabled = disabled;
  }

  function setPillState(pillId, state){
    const map = {
      ok: { c:'#22c55e', b:'rgba(34,197,94,.55)' },
      warn: { c:'#f59e0b', b:'rgba(245,158,11,.55)' },
      bad: { c:'#ef4444', b:'rgba(239,68,68,.55)' },
      off: { c:'#64748b', b:'rgba(100,116,139,.45)' },
    };
    const s = map[state] || map.off;
    const pill = document.getElementById(pillId);
    if (!pill) return;
    const dot = pill.querySelector('.dot');
    if (dot) { dot.style.background = s.c; dot.style.boxShadow = `0 0 0 6px ${s.b.replace('.55','.20')}`; }
    pill.style.borderColor = s.b;
  }

  async function loadRuntimeHints(){
    const apiHintEl = document.getElementById('apiHint');
    const webHintEl = document.getElementById('webHint');
    const alexaHintEl = document.getElementById('alexaHint');
    const moodeHintEl = document.getElementById('moodeHint');
    try {
      const r = await fetch(`${API_BASE}/config/runtime`, { cache:'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        const apiPort = Number(j?.config?.ports?.api || 3101);
        const uiPort = Number(j?.config?.ports?.ui || 8101);
        const proto = location.protocol || 'http:';
        const host = location.hostname || 'sonuvi.local';
        API_BASE = `${proto}//${host}:${apiPort}`;
        if (apiHintEl) apiHintEl.textContent = `${host}:${apiPort}`;
        if (webHintEl) webHintEl.textContent = `${host}:${uiPort}`;
        const k = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
        if (k) runtimeTrackKey = k;

        const axEnabled = !!j?.config?.alexa?.enabled;
        const axDomain = String(j?.config?.alexa?.publicDomain || '').trim();
        if (alexaHintEl) alexaHintEl.textContent = !axEnabled ? 'disabled' : (axDomain ? 'moode.••••••••.com' : 'missing domain');
        const moodeHost = String(j?.config?.moode?.sshHost || j?.config?.mpd?.host || j?.config?.mpdHost || '').trim();
        if (moodeHintEl) moodeHintEl.textContent = moodeHost ? `confirmed (${moodeHost})` : 'not verified';
        setPillState('apiPill','ok');
        setPillState('webPill','ok');
        setPillState('alexaPill', !axEnabled ? 'off' : (axDomain ? 'ok' : 'warn'));
        setPillState('moodePill', moodeHost ? 'ok' : 'warn');
        return;
      }
    } catch {}
    const host = location.hostname || 'sonuvi.local';
    if (apiHintEl) apiHintEl.textContent = API_BASE.replace(/^https?:\/\//, '');
    if (webHintEl) webHintEl.textContent = `${host}:8101`;
    if (alexaHintEl) alexaHintEl.textContent = 'unknown';
    if (moodeHintEl) moodeHintEl.textContent = 'not verified';
    setPillState('apiPill','bad');
    setPillState('webPill','warn');
    setPillState('alexaPill','warn');
    setPillState('moodePill','warn');
  }

  // =========================
  // Modal
  // =========================
  const modalOverlay = document.getElementById('modalOverlay');
  const modalClose   = document.getElementById('modalClose');
  const modalTitle   = document.getElementById('modalTitle');
  const modalSub     = document.getElementById('modalSub');
  const modalHint    = document.getElementById('modalHint');
  const epList       = document.getElementById('epList');
  const modalCount   = document.getElementById('modalCount');
  const modalThumb   = document.getElementById('modalThumb');

  const modalRefresh          = document.getElementById('modalRefresh');
  const modalSelectAll        = document.getElementById('modalSelectAll');
  const modalDownloadSelected = document.getElementById('modalDownloadSelected');
  const modalDeleteSelected   = document.getElementById('modalDeleteSelected');

  let modalCtx = null;     // { rss, title, imageUrl, mapJson, limit }
  let lastEpisodes = [];   // list currently rendered
  
  
  
  function openModal(ctx, anchorEl = null) {
    modalCtx = ctx || null;

    try {
      // Anchor modal vertically near clicked card while guaranteeing on-screen visibility.
      const modalEl = modalOverlay.querySelector('.modal');
      if (modalEl) {
        modalEl.style.removeProperty('margin');
        if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
          const r = anchorEl.getBoundingClientRect();
          const desired = Math.round((r.top + (r.height * 0.5)) - 180);
          const minTop = 12;
          const maxTop = Math.max(12, Math.round(window.innerHeight - 420));
          const top = Math.max(minTop, Math.min(maxTop, desired));
          // Override podcasts.html margin shorthand !important.
          modalEl.style.setProperty('margin', `${top}px auto 14px`, 'important');
        } else {
          modalEl.style.setProperty('margin', `18px auto 14px`, 'important');
        }
      }
    } catch {}

    modalTitle.textContent = (ctx && ctx.title) ? ctx.title : 'Podcast';
    modalSub.textContent   = (ctx && ctx.rss) ? ctx.rss : '';

    modalThumb.src = (ctx && ctx.imageUrl)
      ? ctx.imageUrl
      : placeholderSvgDataUri(modalTitle.textContent);

    modalHint.textContent = 'Loading…';
    epList.innerHTML = '';
    modalCount.textContent = '';

    modalOverlay.classList.add('open');
    document.body.classList.add('modal-open');
    modalOverlay.setAttribute('aria-hidden', 'false');

    updateModalActionState();
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    document.body.classList.remove('modal-open');
    modalOverlay.setAttribute('aria-hidden', 'true');
    const modalEl = modalOverlay.querySelector('.modal');
    if (modalEl) modalEl.style.removeProperty('margin');
    modalCtx = null;
    lastEpisodes = [];
  }
  
  const modalBusy = document.getElementById('modalBusy');

  function setModalBusy(on, hintText = '') {
    if (modalBusy) modalBusy.classList.toggle('on', !!on);

    // optional hint text update
    if (hintText) modalHint.textContent = hintText;

    // disable modal buttons while busy
    if (modalRefresh) modalRefresh.disabled = !!on;
    if (modalSelectAll) modalSelectAll.disabled = !!on;
    if (modalDeleteSelected) modalDeleteSelected.disabled = !!on;
    if (modalDownloadSelected) modalDownloadSelected.disabled = !!on;
  }

  modalClose.addEventListener('click', closeModal);

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.classList.contains('open')) closeModal();
  });

  // =========================
  // Helpers
  // =========================
  function setStatus(msg, cls='muted') {
    statusEl.className = 'statusText' + (cls === 'ok' ? ' ok' : cls === 'err' ? ' err' : '');
    statusEl.textContent = msg;
  }

  function setBusy(isBusy) {
    statusWrap.classList.toggle('busy', !!isBusy);

    btnSub.disabled = !!isBusy;
    btnRefresh.disabled = !!isBusy;
    rssEl.disabled = !!isBusy;
    dlEl.disabled = !!isBusy;
    limitEl.disabled = !!isBusy;
  }

  function log(msg, obj) {
    const line = (obj !== undefined)
      ? `${msg} ${JSON.stringify(obj, null, 2)}`
      : msg;

    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])
    );
  }

  function placeholderSvgDataUri(label = "Podcast") {
    const text = String(label || "Podcast").slice(0, 18).replace(/[&<>"]/g, '');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="112" height="112">
        <defs>
          <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stop-color="#1b2a4a"/>
            <stop offset="1" stop-color="#2b174a"/>
          </linearGradient>
        </defs>
        <rect width="112" height="112" rx="18" fill="url(#g)"/>
        <circle cx="84" cy="28" r="10" fill="rgba(125,211,252,.35)"/>
        <circle cx="28" cy="86" r="12" fill="rgba(167,139,250,.28)"/>
        <text x="56" y="62" text-anchor="middle"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
              font-size="14" fill="rgba(255,255,255,.90)">${text}</text>
      </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  async function apiGet(path) {
    const key = currentKey();
    const r = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      headers: key ? { 'x-track-key': key } : {}
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function apiPost(path, body) {
    const key = currentKey();
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', ...(key ? { 'x-track-key': key } : {}) },
      body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function loadQueueCard() {
    if (!queueWrapEl) return;
    try {
      const j = await apiGet('/config/diagnostics/queue');
      const items = Array.isArray(j?.items) ? j.items.slice(0, 60) : [];
      if (!items.length) { queueWrapEl.innerHTML = '<div class="muted">Queue is empty.</div>'; return; }
      queueWrapEl.innerHTML = items.map((x) => {
        const pos = Number(x.position || 0);
        const head = !!x.isHead;
        const thumbSrc = x.thumbUrl ? (String(x.thumbUrl).startsWith('http') ? String(x.thumbUrl) : `${API_BASE}${x.thumbUrl}`) : '';
        const thumb = thumbSrc ? `<img src="${thumbSrc}" style="width:34px;height:34px;object-fit:cover;border-radius:6px;border:1px solid #2a3a58;background:#111;" />` : '<div style="width:34px;height:34px"></div>';
        const artist = String(x.stationName || x.artist || x.album || '').trim();
        const title = String(x.title || '').trim();
        const detail = title ? title : String(x.album || '').trim();
        return `<div data-queue-play-pos="${pos}" style="display:flex;gap:8px;align-items:center;padding:6px 6px;border-bottom:1px dashed #233650;cursor:pointer;${head?'background:rgba(34,197,94,.14);border-radius:8px;':''}">${thumb}<div style="min-width:0;flex:1 1 auto;"><div><b>${pos}</b>. ${head?'▶️ ':''}${esc(artist)}</div><div class="muted">${esc(detail)}</div></div><div style="display:flex;gap:4px;margin-left:auto;"><button type="button" data-move-pos="${pos}" data-move-dir="up" title="Move up">↑</button><button type="button" data-move-pos="${pos}" data-move-dir="down" title="Move down">↓</button><button type="button" data-remove-pos="${pos}" title="Remove from queue">Remove</button></div></div>`;
      }).join('');
    } catch (e) {
      queueWrapEl.innerHTML = `<div class="muted">Queue load failed: ${esc(e?.message || e)}</div>`;
    }
  }

  async function sendQueueAction(action, payload = {}) {
    await apiPost('/config/diagnostics/playback', { action, ...payload });
  }

  function canonicalEpisodeIdFromKeyOrUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';

    const idMatch = s.match(/^id:([A-Za-z]+[0-9]+)/);
    if (idMatch) return idMatch[1];

    const nprMatch = s.match(/(NPR[0-9]{6,})/);
    if (nprMatch) return nprMatch[1];

    try {
      const u = new URL(s);
      const last = (u.pathname.split('/').pop() || '').replace(/\.mp3$/i, '');
      if (last) return last;
    } catch (_) {}

    return s;
  }

function updateModalActionState() {
  const checked = Array.from(epList.querySelectorAll('input.epChk:checked'));

  const anyDownloadedChecked = checked.some(
    b => b.dataset.downloaded === '1'
  );

  // Only enable Download Selected if at least one checked item is NOT downloaded
  // AND has a valid enclosure URL we can actually download.
  const anyDownloadableChecked = checked.some(
    b =>
      b.dataset.downloaded !== '1' &&
      /^https?:\/\//i.test(String(b.dataset.url || '').trim())
  );

  modalDeleteSelected.disabled = !anyDownloadedChecked;
  modalDownloadSelected.disabled = !anyDownloadableChecked;
}
  // =========================
  // Episodes UI
  // =========================


function renderEpisodes(eps) {
  epList.innerHTML = '';

  if (!eps || !eps.length) {
    modalHint.textContent = 'No episodes found.';
    modalCount.textContent = '0 episode(s)';
    updateModalActionState();
    return;
  }

  modalHint.textContent = '';
  modalCount.textContent = `${eps.length} episode(s)`;

  for (const ep of eps) {
    const row = document.createElement('div');
    row.className = 'epRow';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'epChk';

    // Prefer explicit id; fall back to key "id:xxxx" if needed
    const id =
      String(ep.id || '').trim() ||
      String(ep.key || '').trim().replace(/^id:/i, '');

    const enclosure = String(ep.enclosure || '').trim();
    const title = String(ep.title || '').trim();
    const date = String(ep.date || '').trim();
    const filename = String(ep.filename || '').trim();
    const downloaded = !!ep.downloaded;

    const imageUrl = String(ep.imageUrl || ep.image || '').trim();
    chk.dataset.imageUrl = imageUrl;

    chk.dataset.epid = id;
    chk.dataset.url = enclosure;
    chk.dataset.title = title;
    chk.dataset.date = date;
    chk.dataset.downloaded = downloaded ? '1' : '0';
    chk.dataset.image = imageUrl;

    chk.addEventListener('change', updateModalActionState);

    const main = document.createElement('div');
    main.className = 'epMain';

    const t = document.createElement('div');
    t.className = 'epTitle';
    t.textContent = title || '(untitled)';

    const m = document.createElement('div');
    m.className = 'epMeta';
    m.textContent = downloaded
      ? (filename || 'Downloaded')
      : 'Not downloaded';

    if (downloaded) {
      row.classList.add('epDownloaded');
    }

    main.appendChild(t);
    main.appendChild(m);

    const right = document.createElement('div');
    right.className = 'epRight';

    // Date always shows
    const dateEl = document.createElement('div');
    dateEl.className = 'epDate';
    dateEl.textContent = date || '';
    right.appendChild(dateEl);

    // ▶️ Play button only when downloaded AND we have a path to play
    // Prefer ep.mpdPath (best), else fall back to constructing it if filename exists.
    const mpdPath = String(ep.mpdPath || '').trim() ||
                    (filename ? `${String(modalCtx?.mpdPrefix || '').trim()}/${filename}` : '');

    if (downloaded && mpdPath) {
      const btnPlay = document.createElement('button');
      btnPlay.type = 'button';
      btnPlay.className = 'epPlayBtn';
      btnPlay.title = 'Play now';
      btnPlay.setAttribute('aria-label', 'Play episode now');
      btnPlay.dataset.tip = 'Play now';
      btnPlay.dataset.file = mpdPath;

      btnPlay.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M8 5v14l11-7z"></path>
        </svg>
      `;

      const btnQueue = document.createElement('button');
      btnQueue.type = 'button';
      btnQueue.className = 'epQueueBtn';
      btnQueue.title = 'Add to queue';
      btnQueue.setAttribute('aria-label', 'Add episode to queue');
      btnQueue.dataset.tip = 'Add to queue';
      btnQueue.dataset.file = mpdPath;
      btnQueue.textContent = '+';

      right.appendChild(btnQueue);
      right.appendChild(btnPlay);
    }

    const rowThumb = document.createElement('img');
    rowThumb.className = 'epThumb';
    rowThumb.alt = '';
    rowThumb.loading = 'lazy';
    rowThumb.decoding = 'async';
    rowThumb.src = imageUrl || String(modalCtx?.imageUrl || '').trim() || placeholderSvgDataUri(title || modalTitle.textContent || 'Episode');
    rowThumb.addEventListener('error', () => {
      rowThumb.src = String(modalCtx?.imageUrl || '').trim() || placeholderSvgDataUri(title || modalTitle.textContent || 'Episode');
    }, { once: true });

    row.appendChild(chk);
    row.appendChild(rowThumb);
    row.appendChild(main);
    row.appendChild(right);

    epList.appendChild(row);
  }

  updateModalActionState();
}

// Play button handler (event delegation)
epList.addEventListener('click', async (e) => {
  const queueBtn = e.target.closest('.epQueueBtn');
  if (queueBtn) {
    const file = String(queueBtn.dataset.file || '').trim();
    if (!file) return;
    try {
      queueBtn.disabled = true;
      await apiPost('/mpd/add-file', { file });
      await loadQueueCard();
      const row = queueBtn.closest('.epRow');
      const epTitle = String(row?.querySelector('.epTitle')?.textContent || '').trim();
      modalHint.textContent = epTitle ? `Added to queue: ${epTitle}` : 'Added to queue.';

      const prevText = queueBtn.textContent;
      queueBtn.textContent = '✓';
      queueBtn.classList.add('epBtnDone');
      setTimeout(() => {
        queueBtn.textContent = prevText || '+';
        queueBtn.classList.remove('epBtnDone');
      }, 1400);
    } catch (err) {
      console.error('add-file failed:', err);
      alert(`Add to queue failed: ${err?.message || err}`);
    } finally {
      queueBtn.disabled = false;
    }
    return;
  }

  const btn = e.target.closest('.epPlayBtn');
  if (!btn) return;

  const file = String(btn.dataset.file || '').trim();
  if (!file) return;

  try {
    btn.disabled = true;
    await apiPost('/mpd/play-file', { file });
    modalHint.textContent = 'Playing episode…';
  } catch (err) {
    console.error('play-file failed:', err);
    alert(`Play failed: ${err?.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

async function loadEpisodes() {
  try {
    if (!modalCtx?.rss) {
      modalHint.textContent = 'Missing rss for this subscription.';
      return;
    }

    setModalBusy(true, 'Loading…');
    epList.innerHTML = '';
    modalCount.textContent = '';
    updateModalActionState();

    const limit = Number(modalCtx.limit || limitEl.value || 50);

    // Fetch merged feed+disk view
    const j = await apiPost('/podcasts/episodes/list', {
      rss: modalCtx.rss,
      limit
    });

    const raw = Array.isArray(j?.episodes) ? j.episodes : [];

    const eps = raw.map(ep => {
      const downloaded =
        ep?.downloaded === true ||
        ep?.downloaded === 1 ||
        ep?.downloaded === '1' ||
        ep?.downloaded === 'true';

      // IMPORTANT: mpdPath is what we will POST to /mpd/play-file
      // Prefer ep.mpdPath if the API provides it; otherwise fall back to building it.
      // (If your server always returns mpdPath, this fallback won’t be used.)
      const mpdPath =
        String(ep?.mpdPath || '').trim() ||
        (modalCtx?.mpdPrefix && ep?.id
          ? `${String(modalCtx.mpdPrefix).replace(/\/$/, '')}/${String(ep.id).trim().toLowerCase()}.mp3`
          : '');

      return {
        ...ep,
        downloaded,
        enclosure: String(ep?.enclosure || ''),
        imageUrl: String(ep?.imageUrl || ep?.image || ''),
        filename: String(ep?.filename || ''),
        date: String(ep?.date || ''),
        mpdPath
      };
    });

    renderEpisodes(eps);
    modalHint.textContent = '';
  } catch (e) {
    modalHint.textContent = `Error loading episodes: ${e?.message || String(e)}`;
  } finally {
    setModalBusy(false);
  }
}

  // Modal Refresh: rebuild map/playlist, no downloads
  modalRefresh.addEventListener('click', async () => {
    if (!modalCtx?.rss) return;

    try {
      modalHint.textContent = 'Refreshing…';

      // If your API has a dedicated "refresh map" endpoint, use it instead.
      // For now, call subscribe with download=0 to rebuild map/m3u coherently.
      const limit = Number(modalCtx.limit || limitEl.value || 50);

      await apiPost('/podcasts/subscribe', {
        rss: modalCtx.rss,
        download: 0,
        limit
      });

      await loadEpisodes();
      modalHint.textContent = '';
    } catch (e) {
      modalHint.textContent = `Refresh failed: ${e.message || String(e)}`;
    }
  });

  modalSelectAll.addEventListener('click', () => {
    const boxes = Array.from(epList.querySelectorAll('input.epChk'));
    if (!boxes.length) return;

    const allChecked = boxes.every(b => b.checked);
    for (const b of boxes) b.checked = !allChecked;

    updateModalActionState();
  });

  modalDownloadSelected.addEventListener('click', async () => {
  if (!modalCtx?.rss) return;

  const checked = Array.from(epList.querySelectorAll('input.epChk:checked'));

  // Only download ones not already downloaded, and that have a feed enclosure URL
  // IMPORTANT: include the episode id so download-one can trust UI's stem
  const jobs = checked
    .filter(b => b.dataset.downloaded !== '1')
    .map(b => ({
      id: String(b.dataset.epid || '').trim().toLowerCase(),
      enclosure: String(b.dataset.url || '').trim(),
      title: String(b.dataset.title || '').trim(),
      date: String(b.dataset.date || '').trim(),
      imageUrl: String(b.dataset.imageUrl || '').trim()   // ✅ add this
    }))
    .filter(j => /^[a-f0-9]{12}$/i.test(j.id) && /^https?:\/\//i.test(j.enclosure));
  
  if (!jobs.length) {
    modalHint.textContent = 'Nothing to download (selected items are already downloaded or missing URL).';
    return;
  }

  const ok = confirm(`Download ${jobs.length} episode(s)?`);
  if (!ok) return;

  try {
    setModalBusy(true, `Downloading ${jobs.length}…`);

    let done = 0;
    for (const j of jobs) {
      await apiPost('/podcasts/download-one', {
        rss: modalCtx.rss,
        id: j.id,
        enclosure: j.enclosure,
        title: j.title,
        date: j.date,
        imageUrl: j.imageUrl || "",
      });
      done++;
      setModalBusy(true, `Downloading… ${done}/${jobs.length}`);
    }

    // Make the phase change explicit so "stuck" reports are diagnosable.
    setModalBusy(true, 'Refreshing…');

    await loadEpisodes();
    modalHint.textContent = '';
  } catch (e) {
    modalHint.textContent = `Download failed: ${e.message || String(e)}`;
  } finally {
    setModalBusy(false);
    updateModalActionState();
  }
});

  modalDeleteSelected.addEventListener('click', async () => {
    if (!modalCtx?.rss) {
      modalHint.textContent = 'Delete failed: Missing rss';
      return;
  }

  const checked = Array.from(epList.querySelectorAll('input.epChk:checked'));

  // Only delete ones that are downloaded
  const episodeUrls = checked
    .filter(b => b.dataset.downloaded === '1')
    .map(b => {
      const k = String(b.dataset.key || '').trim();
      if (k) return k; // preferred: "id:xxxxxxxxxxxx"
      const id = String(b.dataset.epid || '').trim();
      return /^[a-f0-9]{12}$/i.test(id) ? `id:${id.toLowerCase()}` : '';
    })
    .filter(Boolean);

  const uniq = Array.from(new Set(episodeUrls));
  if (!uniq.length) {
    modalHint.textContent = 'Select at least one downloaded episode to delete.';
    return;
  }

  const ok = confirm(`Delete ${uniq.length} episode(s)?`);
  if (!ok) return;

  try {
    setModalBusy(true, `Deleting ${uniq.length}…`);

    await apiPost('/podcasts/episodes/delete', {
      rss: modalCtx.rss,
      episodeUrls: uniq
    });

    await loadEpisodes();
    modalHint.textContent = '';
  } catch (e) {
    modalHint.textContent = `Delete failed: ${e.message || String(e)}`;
  } finally {
    setModalBusy(false);
    updateModalActionState();
  }
});

  // =========================
  // Subscription list UI
  // =========================
  function renderSubscriptions(items) {
    listEl.innerHTML = '';
    const n = (items || []).length;
    subCountEl.textContent = String(n);

    if (!items || !items.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.innerHTML = `<div class="empty">No subscriptions yet.</div>`;
      listEl.appendChild(empty);
      return;
    }

    for (const p of items) {
      const title = esc(p.title || '(untitled)');
      const rssRaw = String(p.rss || '');
      const rss   = esc(rssRaw);
      const autoDownload = (p?.autoDownload === true) || (p?.autoLatest === true);

      const built = p.lastBuilt ? esc(p.lastBuilt) : '';
      const itemsCount = (typeof p.items === 'number') ? p.items : null;
      const downloadedCount = (typeof p.downloadedCount === 'number') ? p.downloadedCount : null;

      const imgUrlRaw = String(p.imageUrl || '').trim();
      const imgSrc = imgUrlRaw ? esc(imgUrlRaw) : placeholderSvgDataUri(p.title || 'Podcast');

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="cardHead">
          <img class="thumb" src="${imgSrc}" alt="" loading="lazy" decoding="async" />
          <div class="cardTitleWrap">
            <div class="cardTitle">${title}</div>
            <div class="cardSub">${rss}</div>
          </div>
          <button class="btn btnDanger" data-unsub="${rss}" title="Remove subscription" type="button">Unsubscribe</button>
        </div>

        <div class="cardBody">
          ${built ? `<div class="metaLine"><span class="metaKey">Built</span> <span>${built}</span></div>` : ``}
          ${itemsCount !== null ? `<div class="metaLine"><span class="metaKey">Items</span> <span>${itemsCount}</span></div>` : ``}
          ${downloadedCount !== null ? `<div class="metaLine"><span class="metaKey">Files</span> <span>${downloadedCount}</span></div>` : ``}
          <div class="metaLine autoDlLine">
            <span class="metaKey">Auto</span>
            <label class="autoDlWrap" title="Automatically download new episodes during scheduled runs">
              <input type="checkbox" data-auto-download="${rss}" ${autoDownload ? 'checked' : ''} />
              <span>Download new episodes</span>
            </label>
          </div>
        </div>
      `;

      const img = card.querySelector('img.thumb');
      img.addEventListener('error', () => {
        img.src = placeholderSvgDataUri(p.title || 'Podcast');
      }, { once: true });

      card.addEventListener('click', (e) => {
        if (e.target.closest('button, input, label.autoDlWrap')) return;

        openModal({
          title: p.title || '(untitled)',
          rss: p.rss || '',
          imageUrl: String(p.imageUrl || '').trim(),
          mapJson: p.mapJson || '',
          limit: Number(p.limit || 0) || null
        }, card);

        loadEpisodes();
      });

      listEl.appendChild(card);
    }

    listEl.querySelectorAll('button[data-unsub]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const rss = btn.getAttribute('data-unsub');
        if (!rss) return;

        setBusy(true);
        logEl.textContent = '';

        try {
          setStatus('Unsubscribing…');
          log('→ POST /podcasts/unsubscribe');
          log('Payload:', { rss });

          const res = await apiPost('/podcasts/unsubscribe', { rss });

          log('✓ Unsubscribed');
          log('Response:', res);

          setStatus('Unsubscribed.', 'ok');
          await boot();
        } catch (err) {
          log('✗ Error:', { message: err.message });
          setStatus(`Error: ${err.message}`, 'err');
        } finally {
          setBusy(false);
        }
      });
    });

    listEl.querySelectorAll('input[data-auto-download]').forEach(chk => {
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', async (e) => {
        e.stopPropagation();

        const rss = chk.getAttribute('data-auto-download');
        if (!rss) return;

        const autoDownload = !!chk.checked;
        chk.disabled = true;

        try {
          setStatus('Saving auto-download preference…');
          await apiPost('/podcasts/subscription/settings', { rss, autoDownload });
          if (autoDownload && !nightlyAutomationReady) {
            setStatus(`Auto-download enabled, but nightly cron has not run yet. Install cron on API host: ${nightlyCronCommand()}`, 'err');
          } else {
            setStatus(autoDownload ? 'Auto-download enabled.' : 'Auto-download disabled.', 'ok');
          }
        } catch (err) {
          chk.checked = !autoDownload;
          setStatus(`Error: ${err.message || String(err)}`, 'err');
        } finally {
          chk.disabled = false;
        }
      });
    });
  }

  async function loadNightlyStatus(){
    if (!nightlyStatusEl) return;
    try {
      const j = await apiGet('/podcasts/nightly-status');
      const st = j.state || {};
      nightlyStatusState = st;
      if (retentionEnabledEl) retentionEnabledEl.checked = !!st.retentionEnabled;
      if (retentionDaysEl && Number(st.retentionDays || 0) > 0) retentionDaysEl.value = String(Number(st.retentionDays));
      const when = st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : 'never';
      nightlyAutomationReady = !!st.lastRunAt;
      if (nightlyAutomationReady) {
        nightlyStatusEl.textContent = `Nightly cron: last run ${when}${st.lastRunType ? ` • ${st.lastRunType}` : ''}${Number.isFinite(Number(st.lastRunDeleted)) ? ` • deleted ${Number(st.lastRunDeleted)}` : ''}`;
      } else {
        nightlyStatusEl.textContent = `Nightly cron: no run recorded yet. Auto-download needs cron on API host. Install:\n${nightlyCronCommand()}`;
      }
      syncRetentionUiGate();
    } catch (e) {
      nightlyAutomationReady = false;
      syncRetentionUiGate();
      nightlyStatusEl.textContent = `Nightly cron status unavailable: ${e.message || e}. Install cron:\n${nightlyCronCommand()}`;
    }
  }

  async function saveNightlyRetention(){
    const enabled = !!retentionEnabledEl?.checked;
    const days = Math.max(1, Number(retentionDaysEl?.value || 30));
    await apiPost('/podcasts/nightly-retention', { enabled, days });
    await loadNightlyStatus();
    setStatus('Nightly retention settings saved.', 'ok');
  }

  async function runCleanupNow(){
    const days = Math.max(1, Number(retentionDaysEl?.value || 30));
    const prevLabel = runCleanupBtn ? runCleanupBtn.textContent : '';
    try {
      setBusy(true);
      if (runCleanupBtn) {
        runCleanupBtn.disabled = true;
        runCleanupBtn.textContent = '⏳ Checking…';
      }
      setStatus(`Scanning podcast files for episodes older than ${days} days…`);
      const preview = await apiPost('/podcasts/cleanup-older-than', { days, dryRun: true });
      const scanned = Number(preview.scanned || 0);
      const wouldDelete = Number(preview.wouldDelete || 0);
      if (wouldDelete <= 0) {
        setStatus(`Cleanup preview: 0 files to delete (scanned ${scanned}).`, 'ok');
        return;
      }

      const ok = window.confirm(`Cleanup will delete ${wouldDelete} episode file(s) older than ${days} days (scanned ${scanned}). Continue?`);
      if (!ok) {
        setStatus('Cleanup cancelled.', 'muted');
        return;
      }

      if (runCleanupBtn) runCleanupBtn.textContent = '⏳ Cleaning…';
      const j = await apiPost('/podcasts/cleanup-older-than', { days });
      await loadNightlyStatus();
      setStatus(`Cleanup done: deleted ${Number(j.deleted || 0)} file(s) (scanned ${Number(j.scanned || 0)}).`, 'ok');
    } finally {
      setBusy(false);
      if (runCleanupBtn) {
        runCleanupBtn.disabled = false;
        runCleanupBtn.textContent = prevLabel || 'Run cleanup now';
      }
    }
  }

  async function boot() {
    setBusy(true);
    try {
      setStatus('Refreshing subscription state…');
      logEl.textContent = '';

      log('→ GET /podcasts/refresh');
      const j = await apiGet('/podcasts/refresh');

      renderSubscriptions(j.items || []);
      log('✓ Loaded subscriptions', { count: (j.items || []).length });

      setStatus(`Loaded ${(j.items || []).length} subscription(s).`, 'muted');
    } catch (e) {
      setStatus(`Error: ${e.message}`, 'err');
      listEl.innerHTML = '';
      log('✗ Error:', { message: e.message });
    } finally {
      setBusy(false);
    }
  }

  // =========================
  // Queue card actions
  // =========================
  queueWrapEl?.addEventListener('click', async (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;

    const moveBtn = el.closest('button[data-move-pos][data-move-dir]');
    if (moveBtn) {
      ev.preventDefault();
      const fromPosition = Number(moveBtn.getAttribute('data-move-pos') || 0);
      const dir = String(moveBtn.getAttribute('data-move-dir') || '');
      const toPosition = dir === 'up' ? (fromPosition - 1) : (fromPosition + 1);
      if (!fromPosition || toPosition <= 0) return;
      moveBtn.disabled = true;
      try {
        await sendQueueAction('move', { fromPosition, toPosition });
        setStatus(`Moved queue item ${fromPosition} ${dir}.`, 'ok');
        await loadQueueCard();
      } catch (e) {
        setStatus(`Error: ${e?.message || e}`, 'err');
      } finally {
        moveBtn.disabled = false;
      }
      return;
    }

    const removeBtn = el.closest('button[data-remove-pos]');
    if (removeBtn) {
      ev.preventDefault();
      const position = Number(removeBtn.getAttribute('data-remove-pos') || 0);
      if (!position) return;
      removeBtn.disabled = true;
      try {
        await sendQueueAction('remove', { position });
        setStatus(`Removed queue item ${position}.`, 'ok');
        await loadQueueCard();
      } catch (e) {
        setStatus(`Error: ${e?.message || e}`, 'err');
      } finally {
        removeBtn.disabled = false;
      }
      return;
    }

    const row = el.closest('[data-queue-play-pos]');
    if (row && !el.closest('button')) {
      ev.preventDefault();
      const position = Number(row.getAttribute('data-queue-play-pos') || 0);
      if (!position) return;
      try {
        await sendQueueAction('playpos', { position });
        setStatus(`Playing queue position ${position}.`, 'ok');
        await loadQueueCard();
      } catch (e) {
        setStatus(`Error: ${e?.message || e}`, 'err');
      }
    }
  });

  // =========================
  // Hero actions
  // =========================
  btnRefresh.addEventListener('click', boot);
  saveRetentionBtn?.addEventListener('click', () => saveNightlyRetention().catch((e) => setStatus(`Error: ${e.message || e}`, 'err')));
  runCleanupBtn?.addEventListener('click', () => runCleanupNow().catch((e) => setStatus(`Error: ${e.message || e}`, 'err')));

  btnSub.addEventListener('click', async () => {
    const rss = rssEl.value.trim();
    if (!rss) return;

    const download = Number(dlEl.value) || 0;
    const limit    = Number(limitEl.value) || 50;

    logEl.textContent = '';
    setBusy(true);

    const payload = { rss, download, limit };

    try {
      setStatus(`Subscribing (download ${download}, feed scan ${limit})…`, 'muted');

      log('→ POST /podcasts/subscribe');
      log('Payload:', payload);

      const res = await apiPost('/podcasts/subscribe', payload);

      log('✓ Subscribe complete');
      log('Response:', res);

      // Your API now returns work.sync in the updated flow
      if (res.work?.sync) log('Sync:', res.work.sync);

      setStatus('Subscribed.', 'ok');
      rssEl.value = '';
      await boot();
    } catch (e) {
      log('✗ Error:', { message: e.message });
      setStatus(`Error: ${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener('heroTransport:update', () => { loadQueueCard().catch(() => {}); });

  loadRuntimeHints().finally(() => { boot(); loadNightlyStatus(); loadQueueCard(); });
