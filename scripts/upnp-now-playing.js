/*
 * Source-aware transport bridge for the existing Now Playing controls.
 *
 * The main controller pages already own the card rendering and normal MPD
 * controls. This small capture-phase bridge only handles the controls while
 * the server reports `upnp-sonuvi`, routing them to the authenticated logical
 * UPnP queue instead of the MPD diagnostics endpoint. The server remains the
 * authority for ownership, revisions, and renderer safety.
 */
(function initSonuviUpnpNowPlaying(global) {
  if (!global || global.__sonuviUpnpNowPlayingInstalled) return;
  global.__sonuviUpnpNowPlayingInstalled = true;

  const pageUrl = new URL(global.location.href);
  const portless = !global.location.port || global.location.port === '80' || global.location.port === '443';
  const base = portless
    ? global.location.origin
    : String(pageUrl.searchParams.get('apiBase') || `${global.location.protocol}//${global.location.hostname || 'sonuvi.local'}:3101`).replace(/\/$/, '');
  let trackKey = '';
  let keyPromise = null;
  let refreshInFlight = null;
  let latest = { nowPlaying: null, queue: null, upnp: false };

  function headers(json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(trackKey ? { 'x-track-key': trackKey } : {}) };
  }

  async function ensureKey() {
    if (trackKey) return trackKey;
    if (keyPromise) return keyPromise;
    keyPromise = fetch(`${base}/config/runtime`, { cache: 'no-store' })
      .then((response) => response.json().catch(() => ({})))
      .then((data) => { trackKey = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim(); return trackKey; })
      .catch(() => '')
      .finally(() => { keyPromise = null; });
    return keyPromise;
  }

  async function getJson(path) {
    await ensureKey();
    const response = await fetch(`${base}${path}`, { cache: 'no-store', headers: headers(false) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const error = new Error(String(data?.error || `HTTP ${response.status}`));
      error.status = response.status;
      error.code = String(data?.code || 'UPNP_REQUEST_FAILED');
      throw error;
    }
    return data;
  }

  function isUpnpSource(payload) {
    return payload?.isUpnp === true
      || String(payload?.source || '').trim().toLowerCase() === 'upnp-sonuvi'
      || String(payload?.transport || '').trim().toLowerCase() === 'upnp'
      && String(payload?.controller || '').trim().toLowerCase() === 'sonuvi';
  }

  function queueOwnsUpnp(queue) {
    const state = String(queue?.playbackState || '').trim().toLowerCase();
    return Boolean(queue?.sessionId) && ['loaded', 'playing', 'paused'].includes(state);
  }

  function transportButtons() {
    return document.querySelectorAll(
      '#npCtrls button[data-np-act], #phone-controls button[id^="btn-"], #file-info button[id^="btn-seek"]',
    );
  }

  function buttonAction(button) {
    const explicit = String(button?.getAttribute?.('data-np-act') || '').trim().toLowerCase();
    if (explicit) return explicit;
    return ({
      'btn-prev': 'prev',
      'btn-play': 'toggle',
      'btn-next': 'next',
      'btn-repeat': 'repeat',
      'btn-shuffle': 'shuffle',
      'btn-seek-back': 'seek',
      'btn-seek-back-inline': 'seek',
      'btn-seek-fwd': 'seek',
      'btn-seek-fwd-inline': 'seek',
    }[String(button?.id || '').trim()] || '');
  }

  function syncUnsupportedButtons(upnp) {
    transportButtons().forEach((button) => {
      const action = buttonAction(button);
      if (!['shuffle', 'repeat', 'seek'].includes(action)) return;
      if (upnp) {
        if (!button.dataset.upnpManaged) {
          button.dataset.upnpManaged = '1';
          button.dataset.upnpDisabled = button.disabled ? '1' : '0';
          button.dataset.upnpTitle = button.title || '';
        }
        button.disabled = true;
        button.title = 'Not supported for the Sonuvi UPnP queue';
        button.style.opacity = '0.35';
      } else if (button.dataset.upnpManaged) {
        button.disabled = button.dataset.upnpDisabled === '1';
        button.title = button.dataset.upnpTitle || button.getAttribute('aria-label') || '';
        button.style.opacity = '';
        delete button.dataset.upnpManaged;
        delete button.dataset.upnpDisabled;
        delete button.dataset.upnpTitle;
      }
    });
    document.body.classList.toggle('upnp-sonuvi-active', upnp);
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let nowPlaying = null;
      let queue = null;
      let nowPlayingAvailable = false;
      let queueAvailable = false;
      try {
        nowPlaying = await getJson('/now-playing');
        nowPlayingAvailable = true;
      } catch {}
      try {
        queue = (await getJson('/upnp/queue')).queue || null;
        queueAvailable = true;
      } catch {}

      // A transient /now-playing failure must not release the UPnP control
      // guard for one poll. The logical queue is an independent, authenticated
      // source of ownership while it has an active session. Preserve the last
      // known state only when both reads fail; a successful stopped/empty queue
      // or non-UPnP Now Playing response is authoritative and releases it.
      const upnp = nowPlayingAvailable || queueAvailable
        ? isUpnpSource(nowPlaying) || queueOwnsUpnp(queue)
        : latest.upnp;
      latest = {
        nowPlaying: nowPlayingAvailable ? nowPlaying : latest.nowPlaying,
        queue: queueAvailable ? queue : latest.queue,
        upnp,
      };
      syncUnsupportedButtons(latest.upnp);
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  function queuePath(action) {
    const queueId = String(latest.queue?.queueId || '').trim();
    return queueId ? `/upnp/queues/${encodeURIComponent(queueId)}/${action}` : '';
  }

  async function dispatch(action, button) {
    if (!latest.upnp || !latest.queue) return;
    const path = queuePath(action);
    if (!path) return;
    button?.setAttribute('aria-busy', 'true');
    try {
      await ensureKey();
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ revision: latest.queue.revision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        if (response.status === 409) await refresh();
        throw new Error(String(data?.error || `HTTP ${response.status}`));
      }
      latest.queue = data.queue || latest.queue;
      syncUnsupportedButtons(true);
    } catch (error) {
      global.console?.warn?.('[upnp] transport command failed:', error?.message || String(error));
    } finally {
      button?.removeAttribute('aria-busy');
      setTimeout(() => refresh().catch(() => {}), 150);
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.(
      '#npCtrls button[data-np-act], #phone-controls button[id^="btn-"], #file-info button[id^="btn-seek"]',
    );
    if (!button || !latest.upnp) return;
    const requested = buttonAction(button);
    const state = String(latest.queue?.playbackState || latest.nowPlaying?.state || '').trim().toLowerCase();
    if (['shuffle', 'repeat', 'seek'].includes(requested)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const action = requested === 'toggle'
      ? (state === 'playing' || state === 'play' ? 'pause' : 'resume')
      : ({ prev: 'previous', previous: 'previous', next: 'next', play: 'resume', pause: 'pause' }[requested] || requested);
    if (!['previous', 'next', 'pause', 'resume', 'play'].includes(action)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    dispatch(action, button).catch(() => {});
  }, true);

  refresh().catch(() => {});
  global.setInterval(() => refresh().catch(() => {}), 3000);
  global.SonuviUpnpNowPlaying = { refresh };
}(window));
