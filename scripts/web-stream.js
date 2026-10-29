// Browser-local moOde listener.
// Keep one persistent audio element and start it directly from the user tap.
(() => {
  const STREAM_URL = 'http://10.0.0.254:8000';
  const BUTTON_ID = 'webStreamToggle';

  function installStyles() {
    if (document.getElementById('webStreamStyles')) return;
    const style = document.createElement('style');
    style.id = 'webStreamStyles';
    style.textContent = `
      .webStreamToggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:145px;min-width:145px;white-space:nowrap}
      .webStreamToggle .webStreamIcon{font-size:15px;line-height:1}
      .webStreamToggle.is-on,.alexaRouteButton.is-on{border-color:#55c98a !important;box-shadow:0 0 0 1px rgba(85,201,138,.28) inset;color:#b9ffd8 !important}
      .webStreamToggle.is-busy{opacity:.72;cursor:wait}
      .webStreamSpinner{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:webStreamSpin .7s linear infinite}
      #npCtrls button.alexa-control-loading{position:relative;opacity:.72;cursor:wait;pointer-events:none}
      #npCtrls button.alexa-control-loading::after{content:'';position:absolute;right:4px;top:4px;width:9px;height:9px;border-radius:999px;border:2px solid rgba(255,255,255,.35);border-top-color:#9fd2ff;animation:webStreamSpin .8s linear infinite}
      @keyframes webStreamSpin{to{transform:rotate(360deg)}}
      .webStreamMobileAction,.webStreamComputerAction{position:relative;display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin:8px 0}
      .webStreamMobileAction .webStreamToggle,.webStreamComputerAction .webStreamToggle{border:1px solid rgba(160,180,220,.35);border-radius:8px;padding:7px 12px;background:rgba(12,22,40,.78);color:#dbe7ff;font:inherit;cursor:pointer}
      .tabletActionBar{gap:6px !important;justify-content:flex-end !important}
      .tabletTopCards{grid-template-columns:minmax(0,1fr) minmax(300px,1.1fr) !important}
      .tabletActionBar .queuePos{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis}
      .tabletActionBar .webStreamToggle{padding:5px 7px;font-size:12px;flex:0 0 145px}
      .tabletActionBar #tabletAudioInfoBtn{padding:5px 7px;font-size:12px;flex:0 0 auto}
      .webStreamDebugAudio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
      .webStreamStatus{position:absolute;left:0;top:calc(100% + 4px);z-index:20;max-width:min(360px,calc(100vw - 28px));padding:5px 8px;border:1px solid rgba(160,180,220,.35);border-radius:7px;background:rgba(8,14,26,.94);color:#dbe7ff;font-size:12px;line-height:1.25;white-space:normal;box-shadow:0 6px 18px rgba(0,0,0,.35)}
      .webStreamErrorModal{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.68)}
      .webStreamErrorCard{width:min(420px,100%);padding:20px;border:1px solid rgba(160,180,220,.45);border-radius:14px;background:#0b111c;color:#f3f6ff;box-shadow:0 12px 36px rgba(0,0,0,.55)}
      .webStreamErrorCard h2{margin:0 0 10px;font-size:18px}
      .webStreamErrorCard p{margin:0 0 16px;color:#c9d7ef;line-height:1.4}
      .webStreamErrorCard button{display:block;margin-left:auto;border:1px solid rgba(160,180,220,.45);border-radius:8px;padding:8px 14px;background:#15233b;color:#f3f6ff;font:inherit}
    `;
    document.head.appendChild(style);
  }

  function init() {
    const button = document.getElementById(BUTTON_ID);
    const localOutputButton = document.getElementById('npLocalOutputBtn');
    if (!button && !localOutputButton) return;
    installStyles();
    // The public HTTPS host proxies the API on the same origin. Direct UI
    // pages served from :8101 still need to address the API on :3101.
    const controlOrigin = (!location.port || location.port === '80' || location.port === '443')
      ? location.origin
      : `${location.protocol}//${location.hostname || 'sonuvi.local'}:3101`;
    let alexaModeActive = false;
    let alexaControlBusy = false;
    let autoMutedLocalOutput = false;
    let autoMuteInFlight = false;
    let streamSession = 0;

    const audio = document.createElement('audio');
    audio.id = 'webStreamAudio';
    audio.className = 'webStreamDebugAudio';
    audio.controls = false;
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('crossorigin', 'anonymous');
    document.body.appendChild(audio);

    const log = (...args) => console.log('[Listen on Device]', ...args);
    let streamActive = false;
    let currentTrack = null;
    const mediaSessionSupported = () => 'mediaSession' in navigator && typeof window.MediaMetadata === 'function';
    const normalizeCurrentTrack = (value) => {
      if (!value || typeof value !== 'object') return null;
      const track = {
        title: String(value.title || '').trim(),
        artist: String(value.artist || '').trim(),
        album: String(value.album || '').trim(),
        artwork: String(value.artwork || '').trim(),
      };
      return track.title || track.artist || track.album || track.artwork ? track : null;
    };
    const clearMediaSessionMetadata = () => {
      if (!mediaSessionSupported()) return;
      try { navigator.mediaSession.metadata = null; } catch {}
    };
    const updateMediaSessionMetadata = () => {
      if (!streamActive || !mediaSessionSupported()) return;
      if (!currentTrack) {
        clearMediaSessionMetadata();
        return;
      }
      let artworkSrc = '';
      try {
        artworkSrc = currentTrack.artwork ? new URL(currentTrack.artwork, location.href).href : '';
      } catch {}
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: currentTrack.title || '(unknown track)',
          artist: currentTrack.artist,
          album: currentTrack.album,
          artwork: artworkSrc ? [{ src: artworkSrc, sizes: '512x512' }] : [],
        });
      } catch (error) {
        log('MediaSession metadata update failed', error?.message || error);
      }
    };
    const setCurrentTrack = (value) => {
      currentTrack = normalizeCurrentTrack(value);
      updateMediaSessionMetadata();
    };
    setCurrentTrack(window.__npCurrentTrack);
    window.addEventListener('np-current-track-change', (event) => setCurrentTrack(event.detail));

    const getTrackKey = async () => {
      const runtime = await fetch(`${controlOrigin}/config/runtime`, { cache: 'no-store' });
      const runtimeJson = await runtime.json().catch(() => ({}));
      return String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
    };
    const controlRequest = async (path, method = 'GET', body = undefined) => {
      const key = await getTrackKey();
      const response = await fetch(`${controlOrigin}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'x-track-key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`);
      return result;
    };
    const outputRequest = (method, body) => controlRequest('/mpd/local-output', method, body);
    let refreshLocalOutputStatus = () => Promise.resolve();
    const playbackRequest = (action) => controlRequest('/config/diagnostics/playback', 'POST', { action });
    const notifyLocalOutputState = (enabled) => {
      try {
        window.dispatchEvent(new CustomEvent('np-local-output-change', { detail: { enabled: enabled === true } }));
      } catch {}
    };
    const preferenceEnabled = (key) => {
      try {
        const stored = JSON.parse(localStorage.getItem('nowplaying.clientSettings.v1') || 'null');
        if (stored && Object.prototype.hasOwnProperty.call(stored, key)) return stored[key] === true;
      } catch {}
      return window.NPClientPreferences?.get?.(key, false) === true;
    };

    const muteLocalOutputForSession = async (session) => {
      if (!preferenceEnabled('webStreamAutoMuteAlsa') || autoMutedLocalOutput || autoMuteInFlight) return;
      if (session !== streamSession || audio.paused || !audio.currentSrc) return;
      autoMuteInFlight = true;
      try {
        const status = await outputRequest('GET');
        if (session !== streamSession || audio.paused || !audio.currentSrc) return;
        if (status?.output?.enabled) {
          const result = await outputRequest('POST', { enabled: false });
          notifyLocalOutputState(result?.output?.enabled === true);
          if (session === streamSession && !audio.paused && audio.currentSrc) autoMutedLocalOutput = true;
        }
      } catch (error) {
        log('automatic local ALSA mute failed', error?.message || error);
      } finally {
        autoMuteInFlight = false;
      }
    };
    const restoreLocalOutput = async (force = false) => {
      if (!force && !autoMutedLocalOutput) return;
      autoMutedLocalOutput = false;
      try {
        const result = await outputRequest('POST', { enabled: true });
        notifyLocalOutputState(result?.output?.enabled === true);
      } catch (error) {
        log('automatic local ALSA unmute failed', error?.message || error);
      }
    };
    const runStopActions = async () => {
      const actions = [];
      if (preferenceEnabled('webStreamAutoMuteAlsa') || autoMutedLocalOutput) {
        actions.push(restoreLocalOutput(true));
      }
      if (preferenceEnabled('webStreamStopMpd')) {
        actions.push(playbackRequest('stop').catch((error) => log('automatic mpc stop failed', error?.message || error)));
      }
      await Promise.all(actions);
    };
    const startMpdForWebStream = async (session) => {
      if (session !== streamSession) return;
      try {
        await playbackRequest('play');
        log('MPD play requested for Listen on Device');
      } catch (error) {
        log('automatic MPD play failed', error?.message || error);
      }
    };
    ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled'].forEach((eventName) => {
      audio.addEventListener(eventName, () => log(`AUDIO ${eventName}`, {
        readyState: audio.readyState,
        networkState: audio.networkState,
        currentSrc: audio.currentSrc,
      }));
    });
    audio.addEventListener('error', () => {
      log('AUDIO error', audio.error);
      streamActive = false;
      clearMediaSessionMetadata();
      showErrorModal(`AUDIO error${audio.error?.code ? ` (code ${audio.error.code})` : ''}. See Safari Web Inspector console.`);
    });

    let statusTimer = 0;
    let connectTimer = 0;
    let playResolved = false;
    const setStatus = (message = '') => {
      let status = document.getElementById('webStreamStatus');
      if (!message) {
        status?.remove();
        return;
      }
      if (!status) {
        status = document.createElement('div');
        status.id = 'webStreamStatus';
        status.className = 'webStreamStatus';
        button.parentElement?.appendChild(status);
      }
      status.textContent = message;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status?.remove(), 5000);
    };
    const showErrorModal = (message) => {
      document.getElementById('webStreamErrorModal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'webStreamErrorModal';
      modal.className = 'webStreamErrorModal';
      modal.setAttribute('role', 'alertdialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = `<div class="webStreamErrorCard"><h2>Webstream diagnostic</h2><p>${String(message || '')}</p><button type="button">Dismiss</button></div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelector('button')?.addEventListener('click', close);
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    };
    if (localOutputButton) {
      const speakerOn = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.1-3.8v7.6a4.5 4.5 0 0 0 2.1-3.8zm0-8.5v2.1A8 8 0 0 1 20.5 12a8 8 0 0 1-4 6.4v2.1A10 10 0 0 0 22.5 12a10 10 0 0 0-6-8.5z"/></svg>';
      const speakerMuted = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm14.7 3 3.3-3.3-1.4-1.4-3.3 3.3-3.3-3.3-1.4 1.4 3.3 3.3-3.3 3.3 1.4 1.4 3.3-3.3 3.3 3.3 1.4-1.4-3.3-3.3z"/></svg>';
      let localOutputEnabled = null;
      const paintLocalOutput = (enabled) => {
        localOutputEnabled = !!enabled;
        localOutputButton.innerHTML = localOutputEnabled ? speakerOn : speakerMuted;
        localOutputButton.setAttribute('aria-label', localOutputEnabled ? 'Mute local moOde output' : 'Unmute local moOde output');
        localOutputButton.title = localOutputEnabled ? 'Mute local moOde output' : 'Unmute local moOde output';
        localOutputButton.setAttribute('aria-pressed', localOutputEnabled ? 'false' : 'true');
      };
      window.addEventListener('np-local-output-change', (event) => {
        paintLocalOutput(event?.detail?.enabled === true);
      });
      let localOutputRefreshInFlight = false;
      const refreshLocalOutput = async (initial = false) => {
        if (localOutputRefreshInFlight) return;
        localOutputRefreshInFlight = true;
        try {
          const result = await outputRequest('GET');
          paintLocalOutput(result?.output?.enabled);
          localOutputButton.disabled = false;
        } catch (error) {
          if (initial) {
            console.error('[Local Output] initial status failed', error?.message || error);
            localOutputEnabled = true;
            paintLocalOutput(true);
            localOutputButton.disabled = false;
            localOutputButton.title = 'Local output status unavailable; tap to retry';
          }
        } finally {
          localOutputRefreshInFlight = false;
        }
      };
      refreshLocalOutputStatus = refreshLocalOutput;
      void refreshLocalOutput(true);
      const localOutputTimer = setInterval(() => {
        if (!document.hidden) void refreshLocalOutput();
      }, 3000);
      window.addEventListener('pagehide', () => clearInterval(localOutputTimer), { once: true });
      localOutputButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (localOutputEnabled === null) {
          return;
        }
        const previous = localOutputEnabled;
        localOutputButton.disabled = true;
        try {
          const result = await outputRequest('POST', { enabled: !previous });
          paintLocalOutput(result?.output?.enabled ?? !previous);
        } catch (error) {
          showErrorModal(String(error?.message || error || 'Could not change local moOde output.'));
        } finally {
          localOutputButton.disabled = false;
        }
      });
    }
    if (!button || button.dataset.webStreamBound === '1') return;
    button.dataset.webStreamBound = '1';
    const paint = (state = 'off') => {
      const on = state === 'on';
      const busy = state === 'busy';
      button.classList.toggle('is-on', on);
      button.classList.toggle('is-busy', busy);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
      button.disabled = false;
      button.innerHTML = busy
        ? '<span class="webStreamSpinner" aria-hidden="true"></span><span>Connecting</span>'
        : `<span class="webStreamIcon" aria-hidden="true">🎧</span><span>${on ? 'Playing on Device' : 'Listen on Device'}</span>`;
    };

    audio.addEventListener('playing', () => {
      clearTimeout(connectTimer);
      streamActive = true;
      updateMediaSessionMetadata();
      paint('on');
      setStatus('Playing on this device');
      void muteLocalOutputForSession(streamSession);
    });
    audio.addEventListener('pause', () => {
      if (!audio.currentSrc) {
        streamActive = false;
        clearMediaSessionMetadata();
        paint('off');
      }
    });

    button.addEventListener('click', () => {
      if (!audio.paused) {
        log('STOP requested');
        clearTimeout(connectTimer);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        streamSession += 1;
        streamActive = false;
        clearMediaSessionMetadata();
        paint('off');
        void runStopActions();
        return;
      }

      // Critical diagnostic path: no async work before play().
      clearTimeout(connectTimer);
      const session = ++streamSession;
      playResolved = false;
      paint('busy');
      log('CLICK; assigning direct source', STREAM_URL);
      audio.src = STREAM_URL;
      const playPromise = audio.play();
      // Start the optional control request only after play() has been invoked.
      // This preserves the iOS user-gesture path while not depending on a
      // delayed continuous-stream playing/play-promise callback.
      void startMpdForWebStream(session);
      void muteLocalOutputForSession(session);
      log('play() returned', playPromise);
      connectTimer = setTimeout(() => {
        if (audio.paused || playResolved) return;
        log('CONNECTION TIMEOUT', { readyState: audio.readyState, networkState: audio.networkState });
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        streamSession += 1;
        streamActive = false;
        clearMediaSessionMetadata();
        paint('off');
        setStatus('Webstream unavailable');
        showErrorModal('The webstream did not begin playing within 12 seconds. Check that moOde HTTP Server output is enabled.');
      }, 12000);
      playPromise.then(() => {
        playResolved = true;
        clearTimeout(connectTimer);
        log('play() RESOLVED');
        streamActive = true;
        updateMediaSessionMetadata();
        paint('on');
        setStatus('Playing on Device');
        void muteLocalOutputForSession(session);
      }).catch((error) => {
        clearTimeout(connectTimer);
        streamSession += 1;
        log('play() REJECTED', error.name, error.message, error);
        streamActive = false;
        clearMediaSessionMetadata();
        paint('off');
        const detail = [error?.name, error?.message].filter(Boolean).join(': ');
        setStatus(`Webstream unavailable${detail ? ` (${detail})` : ''}`);
        showErrorModal(`play() rejected${detail ? `: ${detail}` : ''}. See Safari Web Inspector console.`);
      });
    });
    document.querySelectorAll('[data-route-alexa]').forEach((routeButton) => {
      if (routeButton.dataset.routeAlexaBound === '1') return;
      routeButton.dataset.routeAlexaBound = '1';
      let alexaActive = false;
      let alexaPendingTarget = null;
      let alexaPendingTimer = 0;
      const isAlexaModeConfirmed = (value) => !!value && (
        value.modeActive === true
        || (value.active === true && String(value.playbackMode || '').trim().toLowerCase() === 'alexa')
      );
      const paintAlexa = (active, busy = false) => {
        alexaActive = !!active;
        alexaModeActive = alexaActive;
        if (alexaPendingTarget !== null) {
          if (alexaActive === alexaPendingTarget) {
            alexaPendingTarget = null;
            clearTimeout(alexaPendingTimer);
            alexaPendingTimer = 0;
          } else {
            busy = true;
          }
        }
        routeButton.classList.toggle('is-on', alexaActive);
        routeButton.classList.toggle('is-busy', busy);
        routeButton.disabled = !!busy;
        routeButton.setAttribute('aria-pressed', alexaActive ? 'true' : 'false');
        routeButton.setAttribute('aria-busy', busy ? 'true' : 'false');
        routeButton.title = alexaActive ? 'Stop Alexa playback' : 'Start playback on Alexa';
        routeButton.innerHTML = busy
          ? `<span class="webStreamSpinner" aria-hidden="true"></span><span>${alexaActive ? 'Stopping…' : 'Starting…'}</span>`
          : `<span>${alexaActive ? 'Stop on Alexa' : 'Start on Alexa'}</span>`;
      };
      const refreshAlexa = async () => {
        try {
          const response = await fetch(`${controlOrigin}/alexa/was-playing`, { cache: 'no-store' });
          const result = await response.json().catch(() => ({}));
          const active = isAlexaModeConfirmed(result?.wasPlaying) || isAlexaModeConfirmed(result?.nowPlaying);
          paintAlexa(active);
          void refreshLocalOutputStatus();
        } catch {}
      };
      paintAlexa(false);
      refreshAlexa();
      const alexaTimer = setInterval(() => { if (!document.hidden) refreshAlexa(); }, 3000);
      window.addEventListener('pagehide', () => clearInterval(alexaTimer), { once: true });
      routeButton.addEventListener('click', async () => {
        const action = alexaActive ? 'stopalexa' : 'routealexa';
        alexaPendingTarget = !alexaActive;
        clearTimeout(alexaPendingTimer);
        alexaPendingTimer = setTimeout(() => {
          if (alexaPendingTarget === null) return;
          alexaPendingTarget = null;
          paintAlexa(alexaActive);
          showErrorModal('Alexa did not confirm the requested state change.');
        }, 20000);
        paintAlexa(alexaActive, true);
        try {
          const runtime = await fetch(`${controlOrigin}/config/runtime`, { cache: 'no-store' });
          const runtimeJson = await runtime.json().catch(() => ({}));
          const key = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
          const response = await fetch(`${controlOrigin}/config/diagnostics/playback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { 'x-track-key': key } : {}) },
            body: JSON.stringify({ action }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`);
        } catch (error) {
          alexaPendingTarget = null;
          clearTimeout(alexaPendingTimer);
          alexaPendingTimer = 0;
          paintAlexa(alexaActive);
          showErrorModal(String(error?.message || error || `${action} failed.`));
        } finally {
          await refreshAlexa();
        }
      });
    });

    const readAlexaSnapshot = async () => {
      const response = await fetch(`${controlOrigin}/alexa/was-playing`, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      const nowPlaying = result?.nowPlaying || {};
      const wasPlaying = result?.wasPlaying || {};
      const payload = nowPlaying.file ? nowPlaying : wasPlaying;
      return {
        modeActive: !!(nowPlaying.modeActive || wasPlaying.modeActive),
        active: !!payload?.active,
        file: String(payload?.file || '').trim(),
        updatedAt: Number(payload?.updatedAt || wasPlaying?.updatedAt || nowPlaying?.updatedAt || 0) || 0,
      };
    };

    const waitForAlexaControl = async (control, before) => {
      const started = Date.now();
      while ((Date.now() - started) < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const current = await readAlexaSnapshot();
        if (!current.modeActive) throw new Error('Alexa Mode is no longer active.');
        const changed = current.updatedAt > before.updatedAt || current.file !== before.file;
        if (control === 'pause' && !current.active && (changed || !before.active)) return current;
        if (control === 'resume' && current.active && (changed || !before.active)) return current;
        if (control === 'next' && current.active && changed) return current;
      }
      throw new Error(`Alexa did not confirm ${control}.`);
    };

    // In Alexa Mode, redirect transport buttons to the Homebridge → Alexa
    // routine bridge. Capture the click before each page's normal MPD handler.
    document.addEventListener('click', async (event) => {
      const btn = event.target?.closest?.('#npCtrls button[data-np-act]');
      if (!btn || !alexaModeActive || alexaControlBusy) return;
      const act = String(btn.getAttribute('data-np-act') || '').trim().toLowerCase();
      if (!['toggle', 'play', 'pause', 'next'].includes(act)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      alexaControlBusy = true;
      btn.disabled = true;
      btn.classList.add('alexa-control-loading');
      try {
        const before = await readAlexaSnapshot();
        const control = act === 'toggle' ? (before.active ? 'pause' : 'resume') : (act === 'play' ? 'resume' : act);
        const runtime = await fetch(`${controlOrigin}/config/runtime`, { cache: 'no-store' });
        const runtimeJson = await runtime.json().catch(() => ({}));
        const key = String(globalThis.SonuviRuntimeAuth?.trackKey?.() || '').trim();
        const response = await fetch(`${controlOrigin}/config/diagnostics/playback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { 'x-track-key': key } : {}) },
          body: JSON.stringify({ action: `${control}alexa` }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`);
        await waitForAlexaControl(control, before);
        btn.classList.add('confirm');
        setTimeout(() => btn.classList.remove('confirm'), 560);
        window.dispatchEvent(new CustomEvent('np-alexa-control-confirmed', { detail: { control } }));
      } catch (error) {
        showErrorModal(String(error?.message || error || 'Alexa control was not confirmed.'));
      } finally {
        btn.classList.remove('alexa-control-loading');
        btn.disabled = false;
        alexaControlBusy = false;
      }
    }, true);
    paint('off');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
