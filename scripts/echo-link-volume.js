// Main Floor Echo Link volume control. This is intentionally separate from
// the local moOde/ALSA output control.
(() => {
  if (window.__echoLinkVolumeLoaded) return;
  window.__echoLinkVolumeLoaded = true;

  const apiOrigin = (!location.port || location.port === '80' || location.port === '443')
    ? location.origin
    : `${location.protocol}//${location.hostname || 'sonuvi.local'}:${location.port === '8101' ? '3101' : '3000'}`;
  let trackKey = '';
  let modeActive = false;
  let state = null;
  let busy = false;
  let errorMessage = '';
  let refreshTimer = 0;
  let errorTimer = 0;
  let pendingSliderValue = null;
  let lastSliderCommitValue = null;
  const SPEAKER_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.1-3.8v7.6a4.5 4.5 0 0 0 2.1-3.8zm0-8.5v2.1A8 8 0 0 1 20.5 12a8 8 0 0 1-4 6.4v2.1A10 10 0 0 0 22.5 12a10 10 0 0 0-6-8.5z"/></svg>';
  const SPEAKER_MUTED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm14.7 3 3.3-3.3-1.4-1.4-3.3 3.3-3.3-3.3-1.4 1.4 3.3 3.3-3.3 3.3 1.4 1.4 3.3-3.3 3.3 3.3 1.4-1.4-3.3-3.3z"/></svg>';

  function installStyles() {
    if (document.getElementById('echoLinkVolumeStyles')) return;
    const style = document.createElement('style');
    style.id = 'echoLinkVolumeStyles';
    style.textContent = `
      .echoLinkVolumeControl{display:inline-flex;align-items:center;gap:7px;margin:7px 0;padding:5px 8px;border:1px solid color-mix(in srgb,var(--theme-tab-border,var(--line,#1f2a3d)) 85%,var(--theme-tab-text,var(--text,#f3f6ff)) 15%);border-radius:9px;background:color-mix(in srgb,var(--theme-tab-bg,var(--surface,#0b111c)) 84%,var(--theme-tab-border,var(--line,#1f2a3d)) 16%);color:var(--theme-tab-text,var(--text,#f3f6ff));font-size:12px;line-height:1.1}
      .echoLinkVolumeControl[hidden],#webStreamToggle[hidden]{display:none !important}
      .echoLinkVolumeControl .echoLinkLabel{font-weight:650;white-space:nowrap}
      .echoLinkVolumeControl input[type=range]{width:116px;height:16px;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
      .echoLinkVolumeControl input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:999px;background:color-mix(in srgb,var(--theme-tab-active-bg,var(--accent,#4aa8ff)) 58%,transparent)}
      .echoLinkVolumeControl input[type=range]::-moz-range-track{height:3px;border-radius:999px;background:color-mix(in srgb,var(--theme-tab-active-bg,var(--accent,#4aa8ff)) 58%,transparent)}
      .echoLinkVolumeControl input[type=range]::-webkit-slider-thumb{width:14px;height:14px;margin-top:-5.5px;border:1px solid var(--theme-tab-active-bg,var(--accent,#4aa8ff));border-radius:50%;background:var(--theme-tab-text,var(--text,#f3f6ff));box-shadow:0 1px 4px color-mix(in srgb,var(--theme-rail-bg,var(--surface,#0b111c)) 70%,transparent);appearance:none;-webkit-appearance:none}
      .echoLinkVolumeControl input[type=range]::-moz-range-thumb{width:14px;height:14px;border:1px solid var(--theme-tab-active-bg,var(--accent,#4aa8ff));border-radius:50%;background:var(--theme-tab-text,var(--text,#f3f6ff));box-shadow:0 1px 4px color-mix(in srgb,var(--theme-rail-bg,var(--surface,#0b111c)) 70%,transparent)}
      .echoLinkVolumeControl .echoLinkValue{min-width:34px;text-align:right;color:var(--theme-text-secondary,var(--muted,#9eb3d6));font-variant-numeric:tabular-nums}
      .echoLinkVolumeControl button{border:1px solid color-mix(in srgb,var(--theme-tab-border,var(--line,#1f2a3d)) 85%,var(--theme-tab-text,var(--text,#f3f6ff)) 15%);border-radius:6px;padding:3px 6px;background:color-mix(in srgb,var(--theme-tab-bg,var(--surface,#0b111c)) 80%,var(--theme-tab-border,var(--line,#1f2a3d)) 20%);color:inherit;cursor:pointer;font:inherit}
      .echoLinkVolumeControl .echoLinkMute{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:3px}
      .echoLinkVolumeControl .echoLinkMute svg{display:block;width:15px;height:15px;fill:currentColor}
      .echoLinkVolumeControl button:disabled,.echoLinkVolumeControl input:disabled{cursor:not-allowed}
      .echoLinkVolumeControl.is-outside-mode{opacity:.54}
      .echoLinkVolumeControl.is-unavailable{opacity:.48}
      .echoLinkVolumeControl.is-busy{cursor:wait}
      .echoLinkVolumeControl .echoLinkState{min-width:0;max-width:96px;color:var(--theme-text-secondary,var(--muted,#9eb3d6));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .echoLinkVolumeControl .echoLinkSpinner{display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:echoLinkSpin .7s linear infinite}
      .echoLinkVolumeControl .echoLinkError{color:#f6b4b4}
      @keyframes echoLinkSpin{to{transform:rotate(360deg)}}
      @media (max-width:520px){.echoLinkVolumeControl{max-width:100%;gap:5px}.echoLinkVolumeControl input[type=range]{width:94px}.echoLinkVolumeControl .echoLinkLabel{font-size:11px}}
      @media (max-width:380px){.echoLinkVolumeControl.is-outside-mode{display:none}}
    `;
    document.head.appendChild(style);
  }

  async function ensureKey() {
    if (trackKey) return trackKey;
    try {
      const response = await fetch(`${apiOrigin}/config/runtime`, { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      trackKey = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
    } catch {}
    return trackKey;
  }

  async function getMode() {
    try {
      const response = await fetch(`${apiOrigin}/alexa/was-playing`, { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      return !!(json?.nowPlaying?.modeActive || json?.wasPlaying?.modeActive);
    } catch {
      return false;
    }
  }

  async function sidecar(path, method = 'GET', body = null) {
    const key = await ensureKey();
    const response = await fetch(`${apiOrigin}${path}`, {
      method,
      cache: 'no-store',
      headers: { ...(key ? { 'x-track-key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
    return json;
  }

  function findMount() {
    const appMount = document.getElementById('appEchoLinkVolumeMount');
    if (appMount) return { parent: appMount, before: null };
    const hero = document.getElementById('heroTransport');
    if (hero) {
      const controls = hero.querySelector('.alexaTransportControls');
      if (controls) return { parent: controls.parentElement || hero, before: controls.nextSibling };
    }
    const route = document.querySelector('[data-route-alexa]');
    const action = route?.closest('.webStreamComputerAction,.webStreamMobileAction,.tabletActionBar');
    if (action) return { parent: action, before: null };
    const line = document.getElementById('line2Wrap');
    if (line) return { parent: line, before: null };
    return null;
  }

  function ensureControl() {
    if (document.getElementById('echoLinkVolumeControl')) return document.getElementById('echoLinkVolumeControl');
    const mount = findMount();
    if (!mount) return null;
    installStyles();
    const control = document.createElement('div');
    control.id = 'echoLinkVolumeControl';
    control.className = 'echoLinkVolumeControl is-outside-mode';
    if (document.getElementById('tabletActionBar')) control.hidden = true;
    control.setAttribute('role', 'group');
    control.setAttribute('aria-label', 'Main Floor Echo Link volume');
    control.innerHTML = `
      <span class="echoLinkLabel">Echo Link</span>
      <input class="echoLinkSlider" type="range" min="0" max="100" step="1" value="50" aria-label="Echo Link volume">
      <span class="echoLinkValue" aria-live="polite">Unknown</span>
      <button class="echoLinkMute" type="button" aria-label="Mute Echo Link" title="Mute Echo Link">${SPEAKER_ON}</button>
      <span class="echoLinkState" aria-live="polite">Alexa off</span>`;
    mount.parent.insertBefore(control, mount.before || null);

    const slider = control.querySelector('.echoLinkSlider');
    const mute = control.querySelector('.echoLinkMute');
    const sendVolume = async (value) => {
      if (busy || !modeActive) return;
      busy = true;
      errorMessage = '';
      paint(control);
      try {
        state = await sidecar('/echo-link/volume', 'POST', { volume: Number(value) });
      } catch (error) {
        setError(control, error?.message || 'Echo Link unavailable');
      } finally {
        pendingSliderValue = null;
        busy = false;
        paint(control);
      }
    };
    const previewVolume = () => {
      pendingSliderValue = Number(slider.value);
      lastSliderCommitValue = null;
      paint(control);
    };
    const commitVolume = () => {
      if (busy || !modeActive) return;
      const value = Number(slider.value);
      pendingSliderValue = value;
      if (lastSliderCommitValue === value) return;
      lastSliderCommitValue = value;
      sendVolume(value);
    };
    const cancelPreview = () => {
      pendingSliderValue = null;
      lastSliderCommitValue = null;
      paint(control);
    };
    slider.addEventListener('input', previewVolume);
    slider.addEventListener('pointerup', commitVolume);
    slider.addEventListener('pointercancel', cancelPreview);
    slider.addEventListener('change', commitVolume);
    mute.addEventListener('click', async () => {
      if (busy || !modeActive) return;
      busy = true;
      errorMessage = '';
      paint(control);
      try {
        state = await sidecar('/echo-link/mute', 'POST', { mute: state?.muted !== true });
      } catch (error) {
        setError(control, error?.message || 'Echo Link unavailable');
      } finally {
        busy = false;
        paint(control);
      }
    });
    return control;
  }

  function setError(control, message) {
    errorMessage = String(message || 'Echo Link unavailable');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { errorMessage = ''; paint(control); }, 6000);
  }

  function paint(control) {
    if (!control) return;
    const slider = control.querySelector('.echoLinkSlider');
    const mute = control.querySelector('.echoLinkMute');
    const valueEl = control.querySelector('.echoLinkValue');
    const stateEl = control.querySelector('.echoLinkState');
    const tabletLayout = !!document.getElementById('tabletActionBar');
    const listenButton = tabletLayout ? document.getElementById('webStreamToggle') : null;
    const enabled = modeActive && state?.enabled !== false && state?.ready === true;
    const desired = Number.isInteger(state?.desiredVolume) ? state.desiredVolume : null;
    control.classList.toggle('is-outside-mode', !modeActive);
    control.classList.toggle('is-unavailable', modeActive && !enabled);
    control.classList.toggle('is-busy', busy);
    if (tabletLayout) {
      control.hidden = !modeActive;
      if (listenButton) listenButton.hidden = modeActive;
    }
    slider.disabled = !enabled || busy;
    mute.disabled = !enabled || busy;
    const displayedVolume = pendingSliderValue != null ? pendingSliderValue : desired;
    if (displayedVolume != null) slider.value = String(displayedVolume);
    valueEl.textContent = displayedVolume == null ? 'Unknown' : `${displayedVolume}%`;
    mute.innerHTML = state?.muted === true ? SPEAKER_MUTED : SPEAKER_ON;
    mute.title = state?.muted === true ? 'Unmute Echo Link' : 'Mute Echo Link';
    mute.setAttribute('aria-label', mute.title);
    stateEl.classList.toggle('echoLinkError', !!errorMessage);
    if (busy) stateEl.innerHTML = '<span class="echoLinkSpinner" aria-hidden="true"></span>';
    else if (errorMessage) stateEl.textContent = errorMessage;
    else if (!modeActive) stateEl.textContent = 'Alexa off';
    else if (!state?.ready) stateEl.textContent = state?.authRequired ? 'Auth needed' : 'Unavailable';
    else if (desired == null) stateEl.textContent = 'Set volume';
    else stateEl.textContent = '';
  }

  async function refresh() {
    const control = ensureControl();
    if (!control) return;
    modeActive = await getMode();
    if (modeActive) {
      try {
        state = await sidecar('/echo-link/status');
        if (state?.ready) errorMessage = '';
      } catch (error) {
        state = { ready: false, error: error?.message || 'Echo Link unavailable' };
        setError(control, state.error);
      }
    } else {
      state = state || { ready: false };
    }
    paint(control);
  }

  function boot() {
    ensureControl();
    refresh().catch(() => {});
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refresh().catch(() => {}), 4000);
  }

  window.addEventListener('heroTransport:update', () => { ensureControl(); refresh().catch(() => {}); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 80), { once: true });
  else setTimeout(boot, 80);
})();
