function closeResource(resource) {
  if (!resource || typeof resource.close !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (resource.close.length > 0) resource.close(() => resolve());
      else Promise.resolve(resource.close()).then(resolve, resolve);
    } catch { resolve(); }
  });
}

/**
 * Own the two independent DLNA resources as one lifecycle. The media listener
 * is never reported as running until SSDP has also started successfully.
 */
export function createDlnaRuntime({ enabled = false, listen, initialize, startSsdp, log = console } = {}) {
  let listener = null;
  let ssdp = null;
  let startOperation = null;
  let state = enabled ? 'starting' : 'disabled';
  let error = '';

  const snapshot = () => Object.freeze({
    enabled: Boolean(enabled),
    status: state,
    ...(error ? { reason: error } : {}),
  });

  async function stop() {
    const currentSsdp = ssdp;
    const currentListener = listener;
    ssdp = null;
    listener = null;
    await closeResource(currentSsdp);
    await closeResource(currentListener);
    if (enabled && state !== 'error') state = 'disabled';
  }

  async function start() {
    if (!enabled) return false;
    if (state === 'running') return true;
    if (startOperation) return startOperation;
    state = 'starting';
    error = '';
    startOperation = (async () => {
      try {
        if (typeof listen !== 'function' || typeof initialize !== 'function' || typeof startSsdp !== 'function') {
          throw new Error('DLNA runtime dependencies are unavailable');
        }
        listener = await listen();
        const udn = await initialize();
        ssdp = await startSsdp(udn);
        state = 'running';
        return true;
      } catch (cause) {
        error = String(cause?.message || cause || 'DLNA startup failed');
        await stop();
        state = 'error';
        log.warn?.('[dlna] MediaServer startup failed', error);
        return false;
      } finally {
        startOperation = null;
      }
    })();
    return startOperation;
  }

  return Object.freeze({ start, stop, status: snapshot });
}
