/*
 * Browser-side operator credential accessor.
 *
 * `/config/runtime` no longer distributes the Track Key. Pages that need an
 * already-authorized operator capability may read a key the operator stored in
 * this browser through Config; this helper never makes a network request and
 * never writes a key. Keeping that distinction here prevents a future client
 * convenience fallback from recreating the server-side disclosure.
 */
(function installSonuviRuntimeAuth(global) {
  if (!global || global.SonuviRuntimeAuth) return;

  const STORAGE_KEYS = [
    'nowplaying.trackkey',
    'nowplaying.secret.trackKey',
    'np_track_key',
  ];

  function trackKey() {
    try {
      for (const storageKey of STORAGE_KEYS) {
        const value = String(global.localStorage?.getItem(storageKey) || '').trim();
        if (value) return value;
      }
    } catch {}
    return '';
  }

  global.SonuviRuntimeAuth = Object.freeze({
    contract: 'sonuvi.browser-runtime-auth.v1',
    trackKey,
  });
})(globalThis);
