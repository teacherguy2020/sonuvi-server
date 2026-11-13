import {
  qobuzConnectReleaseDefaults,
  waitForQobuzRelease,
} from '../lib/qobuz-connect-release.mjs';

const QOBUZ_ROOT_ID = '0$qobuz$';
const DEFAULT_STATUS_PROBE_TIMEOUT_MS = 5200;
const DEFAULT_RELEASE_TIMEOUT_MS = qobuzConnectReleaseDefaults.timeoutMs;
const DEFAULT_RELEASE_POLL_MS = qobuzConnectReleaseDefaults.pollMs;

function boolQuery(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function isMediaServer(device) {
  return Array.isArray(device?.roles) && device.roles.includes('media-server');
}

function hasQobuzRoot(result) {
  return Array.isArray(result?.items)
    && result.items.some((item) => String(item?.id || '').trim() === QOBUZ_ROOT_ID);
}

function publicQobuzMediaServer(device) {
  return {
    discovered: true,
    id: String(device?.id || ''),
    udn: String(device?.udn || ''),
    friendlyName: String(device?.friendlyName || 'Qobuz MediaServer'),
    contentDirectory: true,
    rootBrowse: true,
  };
}

/**
 * Convert root-browse probes into a safe account-status response.
 * Seeing the Qobuz container proves only that the MediaServer is advertised;
 * it is deliberately not treated as account authentication.
 */
export function buildQobuzAccountStatus({ probes = [], checkedAt = new Date().toISOString(), checkError = false } = {}) {
  const match = (Array.isArray(probes) ? probes : []).find((probe) => hasQobuzRoot(probe?.root));
  if (match) {
    return {
      ok: true,
      state: 'not_connected',
      reason: 'The Qobuz MediaServer is available, but Qobuz account authorization has not been verified.',
      checkedAt,
      mediaServer: publicQobuzMediaServer(match.device),
      authentication: {
        state: 'not_verified',
        verified: false,
        lastVerifiedAt: null,
      },
    };
  }

  return {
    ok: true,
    state: 'connection_unavailable',
    reason: checkError
      ? 'Qobuz MediaServer status could not be checked. Try again later.'
      : 'A Qobuz MediaServer was not discovered on the trusted LAN.',
    checkedAt,
    mediaServer: {
      discovered: false,
      id: '',
      udn: '',
      friendlyName: '',
      contentDirectory: false,
      rootBrowse: false,
    },
    authentication: {
      state: 'unknown',
      verified: false,
      lastVerifiedAt: null,
    },
  };
}

async function boundedRootBrowse(controlPoint, deviceId, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      controlPoint.browse(deviceId, {
        objectId: '0',
        browseFlag: 'BrowseDirectChildren',
        filter: '*',
        startingIndex: 0,
        requestedCount: 100,
        sortCriteria: '',
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Qobuz status probe timed out');
          error.code = 'UPNP_STATUS_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function inspectQobuzMediaServer({ controlPoint, force = false, timeoutMs = DEFAULT_STATUS_PROBE_TIMEOUT_MS }) {
  const discovery = await controlPoint.discover({ force });
  const devices = (Array.isArray(discovery?.devices) ? discovery.devices : []).filter(isMediaServer);
  const probes = await Promise.all(devices.map(async (device) => {
    try {
      const root = await boundedRootBrowse(controlPoint, device.id, timeoutMs);
      return { device, root };
    } catch (error) {
      return { device, errorCode: String(error?.code || 'UPNP_STATUS_PROBE_FAILED') };
    }
  }));
  return buildQobuzAccountStatus({ probes });
}

export function registerConfigQobuzAccountRoutes(app, {
  controlPoint,
  requireTrackKey,
  authorize,
  routePrefix = '/config/qobuz',
  statusProbeTimeoutMs = Number(process.env.QOBUZ_STATUS_PROBE_TIMEOUT_MS || DEFAULT_STATUS_PROBE_TIMEOUT_MS),
  releaseQobuzConnect,
  getQobuzNowPlaying,
  releaseTimeoutMs = Number(process.env.QOBUZ_RELEASE_TIMEOUT_MS || DEFAULT_RELEASE_TIMEOUT_MS),
  releasePollMs = Number(process.env.QOBUZ_RELEASE_POLL_MS || DEFAULT_RELEASE_POLL_MS),
} = {}) {
  if (!app || !controlPoint) throw new Error('Qobuz account routes require an app and UPnP control point');

  app.get(`${routePrefix}/account/status`, async (req, res) => {
    if (authorize ? !await authorize(req,res) : typeof requireTrackKey === 'function' && !requireTrackKey(req, res)) return;
    try {
      const result = await inspectQobuzMediaServer({
        controlPoint,
        force: boolQuery(req.query?.refresh),
        timeoutMs: Math.max(1000, Number(statusProbeTimeoutMs) || DEFAULT_STATUS_PROBE_TIMEOUT_MS),
      });
      return res.json(result);
    } catch {
      return res.json(buildQobuzAccountStatus({ checkError: true }));
    }
  });

  app.post(`${routePrefix}/session/release`, async (req, res) => {
    if (authorize ? !await authorize(req,res) : typeof requireTrackKey === 'function' && !requireTrackKey(req, res)) return;
    if (typeof releaseQobuzConnect !== 'function') {
      return res.status(503).json({
        ok: false,
        error: 'Qobuz session release is unavailable.',
        code: 'QOBUZ_RELEASE_UNAVAILABLE',
      });
    }

    let releaseResult;
    try {
      releaseResult = await releaseQobuzConnect();
      if (releaseResult?.accepted !== true) throw new Error('release was not accepted');
    } catch {
      return res.status(502).json({
        ok: false,
        error: 'The Qobuz session could not be released.',
        code: 'QOBUZ_RELEASE_FAILED',
      });
    }

    const released = releaseResult?.confirmed === true
      ? true
      : await waitForQobuzRelease(getQobuzNowPlaying, {
        timeoutMs: releaseTimeoutMs,
        pollMs: releasePollMs,
      });
    if (!released) {
      return res.status(409).json({
        ok: false,
        error: 'The Qobuz session release was not confirmed.',
        code: 'QOBUZ_RELEASE_UNCONFIRMED',
      });
    }

    return res.json({
      ok: true,
      state: 'released',
      mutationExecuted: true,
    });
  });

  return {
    paths: [
      '/config/qobuz/account/status',
      '/config/qobuz/session/release',
    ],
  };
}

