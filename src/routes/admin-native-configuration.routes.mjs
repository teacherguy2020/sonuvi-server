import { requireAdministratorAuthorization } from '../lib/sonuvi-admin-authority.mjs';
import { projectRuntimeAdminConfig } from '../lib/runtime-config-projection.mjs';

export const NATIVE_ADMIN_CONFIGURATION_CONTRACT = 'sonuvi.admin.configuration.v1';
export const NATIVE_ADMIN_LIBRARY_STATUS_CONTRACT = 'sonuvi.admin.library-status.v1';
export const NATIVE_ADMIN_DLNA_CONTRACT = 'sonuvi.admin.dlna.v1';

function text(value, fallback = '') {
  const candidate = String(value ?? '').trim();
  return candidate || fallback;
}

function isoTimestamp(value) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
    && Number.isFinite(Date.parse(candidate))
    ? candidate
    : null;
}

function nonNegativeNumber(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
}

function bearerToken(req) {
  const raw = text(req?.headers?.authorization);
  const match = raw.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : '';
}

function errorResponse(res, status, code) {
  return res.status(status).json({ ok: false, code });
}

function safeBrowseStatus(value) {
  const source = value && typeof value === 'object' ? value : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const refresh = source.refresh && typeof source.refresh === 'object' ? source.refresh : {};
  return Object.freeze({
    available: source.available === true,
    source: ['memory', 'persisted', 'rehearsal-fixture', 'fresh-install-empty'].includes(text(source.source))
      ? text(source.source)
      : 'unavailable',
    builtAt: isoTimestamp(source.builtAt),
    dbUpdateAt: isoTimestamp(source.dbUpdateAt),
    counts: {
      artists: nonNegativeNumber(counts.artists),
      albums: nonNegativeNumber(counts.albums),
      tracks: nonNegativeNumber(counts.tracks),
    },
    refresh: { running: refresh.running === true },
  });
}

function safeLibraryHealthStatus(value) {
  const source = value && typeof value === 'object' ? value : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const refresh = source.refresh && typeof source.refresh === 'object' ? source.refresh : {};
  const cache = source.cache && typeof source.cache === 'object' ? source.cache : null;
  return Object.freeze({
    available: source.available === true,
    lastSuccessfulAt: isoTimestamp(source.lastSuccessfulAt),
    cache: cache ? {
      ageMs: nonNegativeNumber(cache.ageMs),
      ttlMs: nonNegativeNumber(cache.ttlMs),
    } : null,
    counts: {
      albums: nonNegativeNumber(counts.albums),
      tracks: nonNegativeNumber(counts.tracks),
    },
    refresh: {
      running: refresh.running === true,
      startedAt: isoTimestamp(refresh.startedAt),
    },
  });
}

function nativeConfigurationCapabilities(config) {
  const features = config?.features && typeof config.features === 'object' ? config.features : {};
  return Object.freeze({
    configuration: { read: true, write: false },
    library: { status: true, scan: false, refresh: false },
    dlna: { status: true, installed: false },
    features: {
      podcasts: features.podcasts === true,
      ratings: features.ratings === true,
      radio: features.radio === true,
      albumPersonnel: features.albumPersonnel === true,
      lastfm: features.lastfm === true,
    },
  });
}

function nativeServerIdentity(value, config) {
  const source = value && typeof value === 'object' ? value : {};
  const releaseId = /^sonuvi-[a-f0-9]{64}$/.test(text(source.releaseId)) ? text(source.releaseId) : null;
  return Object.freeze({
    name: 'Sonuvi Server',
    projectName: text(config?.projectName, 'now-playing'),
    version: releaseId || 'unversioned',
    release: {
      mode: ['immutable-release', 'legacy-checkout'].includes(text(source.mode)) ? text(source.mode) : 'legacy-checkout',
      releaseId,
    },
  });
}

function editability(config) {
  const managed = Array.isArray(config?.deployment?.environmentManaged)
    ? config.deployment.environmentManaged
    : [];
  return Object.freeze({
    configuration: 'read-only',
    mutationsAvailable: false,
    environmentManaged: managed
      .map((id) => text(id))
      .filter(Boolean)
      .map((id) => Object.freeze({ id, editable: false, source: 'environment' })),
  });
}

/**
 * Native-only, administrator-authorized read endpoints. They consume the
 * existing configuration projection and status providers; no web endpoint is
 * called, and none of these handlers starts a scan, refresh, or host action.
 */
export function registerNativeAdministratorConfigurationRoutes(app, {
  administratorAuthority = null,
  readConfig = null,
  runtimeProjectionOptions = {},
  getServerIdentity = () => ({}),
  getBrowseIndexStatus = async () => ({}),
  getLibraryHealthStatus = async () => ({}),
} = {}) {
  const available = administratorAuthority
    && typeof administratorAuthority.verifyAccessToken === 'function'
    && typeof readConfig === 'function';

  const authorize = async (req, res) => {
    if (!available) {
      errorResponse(res, 404, 'administrator_api_unavailable');
      return false;
    }
    try {
      await requireAdministratorAuthorization({ authority: administratorAuthority, bearerToken: bearerToken(req) });
      return true;
    } catch {
      errorResponse(res, 401, 'administrator_authorization_required');
      return false;
    }
  };

  app.get('/v1/admin/configuration', async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const configuration = projectRuntimeAdminConfig(await readConfig(), runtimeProjectionOptions);
      return res.json({
        ok: true,
        contract: NATIVE_ADMIN_CONFIGURATION_CONTRACT,
        server: nativeServerIdentity(await getServerIdentity(), configuration),
        configuration,
        editability: editability(configuration),
        capabilities: nativeConfigurationCapabilities(configuration),
      });
    } catch {
      return errorResponse(res, 503, 'administrator_configuration_unavailable');
    }
  });

  app.get('/v1/admin/library/status', async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const [browseIndex, libraryHealth] = await Promise.all([
        getBrowseIndexStatus(),
        getLibraryHealthStatus(),
      ]);
      const browse = safeBrowseStatus(browseIndex);
      const health = safeLibraryHealthStatus(libraryHealth);
      return res.json({
        ok: true,
        contract: NATIVE_ADMIN_LIBRARY_STATUS_CONTRACT,
        available: browse.available || health.available,
        counts: {
          artists: browse.counts.artists,
          albums: browse.counts.albums ?? health.counts.albums,
          tracks: browse.counts.tracks ?? health.counts.tracks,
        },
        indexing: {
          lastSuccessfulAt: browse.builtAt || health.lastSuccessfulAt,
          databaseUpdatedAt: browse.dbUpdateAt,
          running: browse.refresh.running || health.refresh.running,
        },
        browseIndex: browse,
        libraryHealth: health,
      });
    } catch {
      return errorResponse(res, 503, 'administrator_library_status_unavailable');
    }
  });

  app.get('/v1/admin/dlna', async (req, res) => {
    if (!(await authorize(req, res))) return;
    return res.json({
      ok: true,
      contract: NATIVE_ADMIN_DLNA_CONTRACT,
      status: 'unavailable',
      installed: false,
      enabled: false,
      reason: 'not_installed_in_gate_c',
    });
  });
}
