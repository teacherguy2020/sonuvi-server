import {
  readBearerToken,
  verifyMobileToken,
} from './lib/mobile-auth.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authenticatedPrincipal({ headers, secret, now, verify }) {
  const token = readBearerToken({ headers });
  const claims = verify(token, { secret, scope: 'mobile-api', now });
  return text(claims?.deviceId) || null;
}

/**
 * Framework-neutral route wrapper for:
 * POST /v1/mobile/qobuz-connect/saved-queues/:id/play
 * GET  /v1/mobile/qobuz-connect/saved-queues/operations/:operationId
 *
 * The real route should pass the already verified Server mobile session
 * convention here.  This wrapper accepts no track vector, host, path, shell,
 * key, or operation-submission transport from the mobile request.
 */
export function createMobileSavedQueuePlayRoute({
  service,
  secret,
  now = Date.now,
  verify = verifyMobileToken,
  sessionRegistry,
} = {}) {
  if (!service || typeof service.play !== 'function' || typeof service.status !== 'function') {
    throw new Error('saved queue play route service is incomplete');
  }
  if (!text(secret)) throw new Error('mobile session secret is required');

  function auth(headers) {
    try {
      return authenticatedPrincipal({ headers, secret, now: now(), verify: (token, options) => verify(token, { ...options, sessionRegistry }) });
    } catch {
      return null;
    }
  }

  async function play({ headers = {}, params = {}, body = {} } = {}) {
    const userId = auth(headers);
    if (!userId) return { status: 401, errorCode: 'MOBILE_AUTH_REQUIRED' };
    if (!isObject(body)) return { status: 400, errorCode: 'SAVED_QUEUE_REQUEST_INVALID' };
    if (Object.keys(body).some((key) => !new Set(['confirm', 'startIndex']).has(key))) {
      return { status: 400, errorCode: 'SAVED_QUEUE_REQUEST_INVALID' };
    }
    return service.play({
      userId,
      input: {
        savedQueueId: text(params.id),
        confirm: body.confirm,
        startIndex: body.startIndex === undefined ? 0 : body.startIndex,
      },
    });
  }

  async function status({ headers = {}, params = {} } = {}) {
    const userId = auth(headers);
    if (!userId) return { status: 401, errorCode: 'MOBILE_AUTH_REQUIRED' };
    return service.status({ userId, operationId: params.operationId });
  }

  return { play, status };
}
