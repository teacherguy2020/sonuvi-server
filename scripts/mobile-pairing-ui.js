/* Shared Now Playing display-side mobile pairing UI.
 *
 * The display token stays in memory only. It is never placed in the QR payload,
 * localStorage, the URL, or the visible pairing instructions.
 */
(() => {
  const root = document.querySelector('[data-mobile-pairing]');
  if (!root || root.dataset.mobilePairingReady === '1') return;
  root.dataset.mobilePairingReady = '1';

  const startButton = root.querySelector('[data-pair-start]');
  const cancelButton = root.querySelector('[data-pair-cancel]');
  const status = root.querySelector('[data-pair-status]');
  const qrWrap = root.querySelector('[data-pair-qr-wrap]');
  const qrImage = root.querySelector('[data-pair-qr]');
  const baseUrl = root.querySelector('[data-pair-base-url]');
  const expires = root.querySelector('[data-pair-expires]');
  const payload = root.querySelector('[data-pair-payload]');
  const requests = root.querySelector('[data-pair-requests]');

  const state = {
    displayToken: '',
    expiresAt: 0,
    timer: 0,
    pending: new Map(),
    busy: false,
  };

  function injectStyle() {
    if (document.getElementById('npMobilePairingUiStyle')) return;
    const style = document.createElement('style');
    style.id = 'npMobilePairingUiStyle';
    style.textContent = `
      .npMobilePairingIntro{max-width:780px;margin:0 0 10px}
      .npMobilePairingActions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
      .npMobilePairingStatus{margin-top:10px;min-height:1.4em}
      .npMobilePairingStatus[data-kind="error"]{color:#ffadad;opacity:1}
      .npMobilePairingStatus[data-kind="success"]{color:#a8f0bd;opacity:1}
      .npMobilePairingGrid{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px;align-items:start;margin-top:14px}
      .npMobilePairingQr{width:min(280px,100%);aspect-ratio:1;display:block;background:#fff;border:8px solid #fff;border-radius:10px;image-rendering:auto}
      .npMobilePairingMeta{display:grid;gap:8px;min-width:0}
      .npMobilePairingMeta code,.npMobilePairingPayload{overflow-wrap:anywhere;word-break:break-word}
      .npMobilePairingPayload{max-height:150px;overflow:auto;margin:6px 0 0;padding:8px;border:1px solid var(--field-border,rgba(255,255,255,.16));border-radius:8px;background:var(--field-bg,rgba(255,255,255,.06));font-size:11px;white-space:pre-wrap}
      .npMobilePairingRequests{display:grid;gap:8px;margin-top:14px}
      .npMobilePairingRequest{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--field-border,rgba(255,255,255,.16));border-radius:10px;background:var(--field-bg,rgba(255,255,255,.06))}
      .npMobilePairingRequest strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .npMobilePairingRequest small{display:block;color:var(--muted,#9eb3d6);margin-top:3px}
      .npMobilePairingCode{font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;color:var(--accent,#4aa8ff);white-space:nowrap}
      .npMobilePairingRequestActions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .npMobilePairingRequestActions button{font:inherit;padding:7px 10px;border:1px solid var(--field-border,rgba(255,255,255,.16));border-radius:8px;background:var(--field-bg,rgba(255,255,255,.06));color:var(--field-text,var(--text,#f3f6ff));cursor:pointer}
      .npMobilePairingRequestActions button[data-pair-action="approve"]{background:color-mix(in oklab,var(--accent,#4aa8ff) 28%, var(--field-bg,rgba(255,255,255,.06)));border-color:color-mix(in oklab,var(--accent,#4aa8ff) 65%, transparent)}
      @media (max-width:680px){.npMobilePairingGrid{grid-template-columns:1fr}.npMobilePairingQr{width:min(240px,100%);margin:0 auto}.npMobilePairingRequest{grid-template-columns:1fr}.npMobilePairingRequestActions{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function text(value) {
    return String(value ?? '').trim();
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[char]));
  }

  function resolveApiBase() {
    const params = new URL(location.href).searchParams;
    const configured = text(root.dataset.apiBase) || text(params.get('apiBase'));
    if (configured) return configured.replace(/\/+$/, '');
    return globalThis.NPArt.apiBase();
  }

  const apiBase = resolveApiBase();
  let cachedTrackKey = '';

  function localTrackKey() {
    const input = document.getElementById('configTrackKey');
    if (input?.value) return text(input.value);
    try {
      return text(localStorage.getItem('nowplaying.secret.trackKey'));
    } catch {
      return '';
    }
  }

  async function trackKey() {
    const local = localTrackKey();
    if (local) {
      cachedTrackKey = local;
      return local;
    }
    if (cachedTrackKey) return cachedTrackKey;
    try {
      const response = await fetch(`${apiBase}/config/runtime`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      cachedTrackKey = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
    } catch {}
    return cachedTrackKey;
  }

  function setStatus(message, kind = '') {
    if (!status) return;
    status.textContent = text(message);
    if (kind) status.dataset.kind = kind;
    else delete status.dataset.kind;
  }

  function displayHeaders(key, includeToken = true) {
    const headers = { 'x-track-key': key };
    if (includeToken && state.displayToken) {
      headers['X-Mobile-Pairing-Display-Token'] = state.displayToken;
    }
    return headers;
  }

  async function pairingRequest(path, options = {}, key = '') {
    const headers = {
      ...displayHeaders(key, options.includeDisplayToken !== false),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method || 'GET',
      cache: 'no-store',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      const error = text(body?.error) || `HTTP ${response.status}`;
      throw new Error(error);
    }
    return body;
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
  }

  function resetDisplay() {
    stopPolling();
    state.displayToken = '';
    state.expiresAt = 0;
    state.pending.clear();
    state.busy = false;
    if (startButton) startButton.hidden = false;
    if (cancelButton) cancelButton.hidden = true;
    if (qrWrap) qrWrap.hidden = true;
    if (requests) requests.replaceChildren();
  }

  function renderRequests(rows) {
    if (!requests) return;
    state.pending.clear();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = text(row?.requestId);
      if (id) state.pending.set(id, row);
    }
    if (!state.pending.size) {
      requests.innerHTML = '<div class="cfgHint">No device is waiting for approval.</div>';
      return;
    }
    requests.innerHTML = [...state.pending.values()].map((row) => {
      const name = escapeHtml(row.deviceName || 'Unnamed device');
      const model = escapeHtml(row.deviceModel || 'Unknown model');
      const code = escapeHtml(row.verificationCode || '------');
      const id = escapeHtml(row.requestId);
      return `<div class="npMobilePairingRequest" data-pair-request="${id}">
        <div><strong>${name}</strong><small>${model}<br>Verification code: <span class="npMobilePairingCode">${code}</span></small></div>
        <div class="npMobilePairingRequestActions"><button type="button" class="btn btnPrimary" data-pair-action="approve" data-pair-request="${id}">Approve</button><button type="button" class="btn" data-pair-action="reject" data-pair-request="${id}">Reject</button></div>
      </div>`;
    }).join('');
  }

  async function poll() {
    if (!state.displayToken || state.busy) return;
    if (state.expiresAt && Date.now() >= state.expiresAt) {
      stopPolling();
      if (cancelButton) cancelButton.hidden = true;
      setStatus('Pairing expired. Start a new pairing attempt.', 'error');
      return;
    }
    try {
      const key = await trackKey();
      const body = await pairingRequest('/v1/mobile/pairing/requests', { includeDisplayToken: true }, key);
      if (body.status && body.status !== 'waiting') {
        stopPolling();
        if (cancelButton) cancelButton.hidden = true;
        setStatus(`Pairing ${body.status}. Start a new pairing attempt.`, body.status === 'approved' ? 'success' : 'error');
        return;
      }
      renderRequests(body.requests);
    } catch (error) {
      if (state.displayToken) setStatus('Unable to check pairing status. The display authorization may have expired.', 'error');
    }
  }

  async function start() {
    if (state.busy) return;
    state.busy = true;
    resetDisplay();
    state.busy = true;
    setStatus('Creating a short-lived pairing challenge…');
    try {
      const key = await trackKey();
      if (!key) throw new Error('track_key_required');
      const body = await pairingRequest('/v1/mobile/pairing/challenges', { method: 'POST', includeDisplayToken: false }, key);
      state.displayToken = text(body.displayToken);
      state.expiresAt = Number(body.expiresAt || 0);
      if (!state.displayToken || !state.expiresAt) throw new Error('invalid_pairing_response');
      if (qrImage) {
        qrImage.src = text(body.qrDataUrl);
        qrImage.alt = `Pairing QR code for ${text(body.baseUrl)}`;
      }
      if (baseUrl) baseUrl.textContent = text(body.baseUrl);
      if (expires) expires.textContent = new Date(state.expiresAt).toLocaleTimeString();
      if (payload) payload.textContent = JSON.stringify(body.qrPayload || {}, null, 2);
      if (qrWrap) qrWrap.hidden = false;
      if (startButton) startButton.hidden = true;
      if (cancelButton) cancelButton.hidden = false;
      setStatus('Waiting for the iPhone to submit this device for approval…');
      await poll();
      state.timer = window.setInterval(poll, 1500);
    } catch (error) {
      resetDisplay();
      setStatus(error?.message === 'track_key_required'
        ? 'Enter your existing Server access key in Server access before starting pairing.'
        : 'Unable to start pairing. Check the Track Key and API connection.', 'error');
    } finally {
      state.busy = false;
    }
  }

  async function decide(action, requestId) {
    const request = state.pending.get(requestId);
    if (!request || state.busy) return;
    state.busy = true;
    setStatus(`${action === 'approve' ? 'Approving' : 'Rejecting'} ${request.deviceName || 'device'}…`);
    try {
      const key = await trackKey();
      await pairingRequest(`/v1/mobile/pairing/requests/${encodeURIComponent(requestId)}/${action}`, {
        method: 'POST',
        body: { verificationCode: request.verificationCode },
      }, key);
      stopPolling();
      if (cancelButton) cancelButton.hidden = true;
      setStatus(action === 'approve'
        ? 'Device approved. The iPhone can now finish pairing.'
        : 'Device rejected. Start a new pairing attempt if needed.', action === 'approve' ? 'success' : 'error');
      renderRequests([]);
    } catch {
      setStatus('That pairing request is no longer available or the verification code did not match.', 'error');
      await poll();
    } finally {
      state.busy = false;
    }
  }

  async function cancel() {
    if (!state.displayToken || state.busy) {
      resetDisplay();
      setStatus('Pairing cancelled.');
      return;
    }
    state.busy = true;
    try {
      const key = await trackKey();
      await pairingRequest('/v1/mobile/pairing/challenges/cancel', { method: 'POST' }, key);
    } catch {}
    resetDisplay();
    setStatus('Pairing cancelled.');
  }

  injectStyle();
  startButton?.addEventListener('click', start);
  cancelButton?.addEventListener('click', cancel);
  requests?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-pair-action]');
    if (!button) return;
    decide(text(button.dataset.pairAction), text(button.dataset.pairRequest));
  });
  window.addEventListener('pagehide', stopPolling, { once: true });
})();
