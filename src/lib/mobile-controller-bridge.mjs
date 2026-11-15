import { validNativeControllerTarget, validNativeControllerBody } from './controller-browser-dispatch.mjs';

/** Forward an already-authenticated native controller through the same bounded
 * loopback authorization as the browser. Never attach operator credentials. */
export function createMobileControllerBridge({ port, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid controller port');
  return async (pathname, options = {}, token = '') => {
    const method = String(options.method || 'GET').toUpperCase();
    if (!token || /[\r\n]/.test(token) || !validNativeControllerTarget(pathname, method)
        || !validNativeControllerBody({ method, pathname, body: options.body })) {
      return { ok: false, status: 403, json: { error: 'Controller dispatch rejected' } };
    }
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}${pathname}`, {
      method, cache: 'no-store', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'x-sonuvi-controller-dispatch': 'native-mobile-session',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { ok: response.ok, status: response.status, json: await response.json().catch(() => ({})) };
  };
}
