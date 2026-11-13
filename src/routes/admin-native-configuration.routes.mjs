import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerSonuviRestartRoutes} from '../lib/sonuvi-service-control.mjs';
import { projectNativeDlnaStatus } from '../lib/native-configuration-workspace.mjs';
import { registerConfigurationWorkspaceRoutes } from './admin-configuration-workspace.routes.mjs';
import { requireAdministratorAuthorization } from '../lib/sonuvi-admin-authority.mjs';
import { registerMasterConfigurationRoutes } from './master-configuration.routes.mjs';
import { createLastfmPluginAdministration } from '../lib/lastfm-plugin-admin.mjs';
import { registerConfigQobuzAccountRoutes } from './config.qobuz-account.routes.mjs';
import {createPluginCredentialAdministration} from '../lib/plugin-credentials.mjs';
import { createMasterConfigurationStore } from '../lib/master-configuration.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { normalizeMoodeBaseUrl } from '../lib/moode-url.mjs';
import { assertImmutableRuntimeConfig } from '../lib/runtime-config-security.mjs';
import {
  mergeRuntimeConfig,
  projectRuntimeAdminConfig,
  sanitizeRuntimeConfigUpdate,
  validateRuntimeConfigShape,
} from '../lib/runtime-config-projection.mjs';

export const NATIVE_ADMIN_CONFIGURATION_CONTRACT = 'sonuvi.admin.configuration.v1';
export const NATIVE_ADMIN_CONFIGURATION_UPDATE_CONTRACT = 'sonuvi.admin.configuration-update.v1';
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

function nativeConfigurationCapabilities(config, writeAvailable = false) {
  const features = config?.features && typeof config.features === 'object' ? config.features : {};
  return Object.freeze({
    configuration: { read: true, write: writeAvailable },
    library: { status: true, scan: false, refresh: false },
    dlna: { status: true, installed: true },
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

function editability(config, writeAvailable = false) {
  const managed = Array.isArray(config?.deployment?.environmentManaged)
    ? config.deployment.environmentManaged
    : [];
  return Object.freeze({
    configuration: writeAvailable ? 'administrator-editable' : 'read-only',
    mutationsAvailable: writeAvailable,
    environmentManaged: managed
      .map((id) => text(id))
      .filter(Boolean)
      .map((id) => Object.freeze({ id, editable: false, source: 'environment' })),
  });
}

const NATIVE_EDITABLE_FIELDS = Object.freeze({
  mpd: new Set(['host', 'port']),
  moode: new Set(['sshHost', 'sshUser', 'baseUrl']),
  paths: new Set(['musicLibraryRoot', 'moodeUsbMount', 'piMountBase', 'podcastRoot']),
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nativeConfigurationUpdate(value) {
  const source = object(value);
  const envelopeKeys = Object.keys(source);
  if (hasOwn(source, 'configuration')) {
    if (envelopeKeys.some((key) => key !== 'configuration')) {
      return { error: 'administrator_configuration_field_not_editable' };
    }
  }
  const incoming = hasOwn(source, 'configuration') ? source.configuration : source;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { error: 'administrator_configuration_update_invalid' };
  }
  if (!Object.keys(incoming).length) return { error: 'administrator_configuration_update_invalid' };
  const unsupported = [];
  for (const [section, fields] of Object.entries(NATIVE_EDITABLE_FIELDS)) {
    if (!hasOwn(incoming, section)) continue;
    if (!incoming[section] || typeof incoming[section] !== 'object' || Array.isArray(incoming[section])) {
      unsupported.push(section);
      continue;
    }
    for (const [field, fieldValue] of Object.entries(incoming[section])) {
      if (!fields.has(field)) {
        unsupported.push(`${section}.${field}`);
        continue;
      }
      if (field === 'port') {
        if (!Number.isInteger(fieldValue) || fieldValue < 1 || fieldValue > 65535) {
          return { error: 'administrator_configuration_update_invalid' };
        }
      } else if (typeof fieldValue !== 'string' || fieldValue.length > 1024) {
        return { error: 'administrator_configuration_update_invalid' };
      }
    }
  }
  for (const section of Object.keys(incoming)) {
    if (!Object.hasOwn(NATIVE_EDITABLE_FIELDS, section)) unsupported.push(section);
  }
  if (unsupported.length) return { error: 'administrator_configuration_field_not_editable', fields: [...new Set(unsupported)].sort() };
  return { value: incoming };
}

function nativeFieldIDs(incoming) {
  const ids = [];
  if (hasOwn(incoming.mpd || {}, 'host')) ids.push('mpdHost');
  if (hasOwn(incoming.mpd || {}, 'port')) ids.push('mpdPort');
  if (hasOwn(incoming.moode || {}, 'sshHost')) ids.push('moodeSshHost');
  if (hasOwn(incoming.moode || {}, 'sshUser')) ids.push('moodeSshUser');
  if (hasOwn(incoming.moode || {}, 'baseUrl')) ids.push('moodeBaseUrl');
  for (const field of ['musicLibraryRoot', 'moodeUsbMount', 'piMountBase', 'podcastRoot']) {
    if (hasOwn(incoming.paths || {}, field)) ids.push(`path${field[0].toUpperCase()}${field.slice(1)}`);
  }
  return ids;
}

/**
 * Native-only, administrator-authorized read endpoints. They consume the
 * existing configuration projection and status providers; no web endpoint is
 * called, and none of these handlers starts a scan, refresh, or host action.
 */
export function registerNativeAdministratorConfigurationRoutes(app, {
  administratorAuthority = null,
  qobuz = null,
  readConfig = null,
  writeConfig = null,
  runtimeProjectionOptions = {},
  getServerIdentity = () => ({}),
  getBrowseIndexStatus = async () => ({}),
  getLibraryHealthStatus = async () => ({}),
  refreshIndex = null,
  scanLibrary = null,
  checkEnvironment = null,
  getWebAccess = () => ({}),
  getDlnaStatus = async () => ({ installed: true, enabled: false, status: 'disabled', reason: 'operator_configuration_required' }),
} = {}) {
  registerConfigurationWorkspaceRoutes(app, { administratorAuthority, readConfig, writeConfig, runtimeProjectionOptions, getBrowseIndexStatus, getLibraryHealthStatus, getDlnaStatus, refreshIndex, scanLibrary, checkEnvironment, getWebAccess });
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

  registerSonuviRestartRoutes(app, {requireTrackKey:authorize, execFileP:promisify(execFile),
    statusPath:'/v1/admin/configuration/master/restart/status', restartPaths:['/v1/admin/configuration/master/restart']});
  registerMasterConfigurationRoutes(app, {
    authorize,
    store: createMasterConfigurationStore(runtimeStatePaths().configPath),
    lastfm: createLastfmPluginAdministration({statePaths:runtimeStatePaths()}),
    credentials: createPluginCredentialAdministration({statePaths:runtimeStatePaths()}),
  });
  if(qobuz)registerConfigQobuzAccountRoutes(app,{...qobuz,authorize,routePrefix:'/v1/admin/configuration/master/plugins/qobuz'});

  app.get('/v1/admin/configuration', async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const configuration = projectRuntimeAdminConfig(await readConfig(), runtimeProjectionOptions);
      return res.json({
        ok: true,
        contract: NATIVE_ADMIN_CONFIGURATION_CONTRACT,
        server: nativeServerIdentity(await getServerIdentity(), configuration),
        configuration,
        editability: editability(configuration, typeof writeConfig === 'function'),
        capabilities: nativeConfigurationCapabilities(configuration, typeof writeConfig === 'function'),
      });
    } catch {
      return errorResponse(res, 503, 'administrator_configuration_unavailable');
    }
  });

  app.patch('/v1/admin/configuration', async (req, res) => {
    if (!(await authorize(req, res))) return;
    if (typeof writeConfig !== 'function') return errorResponse(res, 404, 'administrator_configuration_mutation_unavailable');
    try {
      const candidate = nativeConfigurationUpdate(req.body);
      if (candidate.error) return errorResponse(res, 400, candidate.error);
      const incoming = candidate.value;
      const current = await readConfig();
      const projected = projectRuntimeAdminConfig(current, runtimeProjectionOptions);
      const managed = new Set(projected?.deployment?.environmentManaged || []);
      const managedIDs = nativeFieldIDs(incoming).filter((id) => managed.has(id));
      if (managedIDs.length) return res.status(409).json({ ok: false, code: 'administrator_configuration_field_managed' });
      const sanitized = sanitizeRuntimeConfigUpdate(incoming);
      const next = mergeRuntimeConfig(current, sanitized);
      if (Object.hasOwn(incoming.moode || {}, 'baseUrl')) {
        const moodeHost = String(next.moode?.sshHost || next.mpd?.host || runtimeProjectionOptions?.defaults?.moodeHost || 'moode.local').trim();
        const moodeBaseRaw = String(next.moode?.baseUrl || '').trim();
        next.moode = { ...next.moode, baseUrl: moodeBaseRaw ? normalizeMoodeBaseUrl(moodeBaseRaw, moodeHost) : '' };
      }
      const errors = validateRuntimeConfigShape(next);
      if (errors.length) return errorResponse(res, 400, 'administrator_configuration_update_invalid');
      if (runtimeProjectionOptions?.environment?.SONUVI_STATE_ROOT || process.env.SONUVI_STATE_ROOT) {
        assertImmutableRuntimeConfig(next, { context: 'native administrator configuration update' });
      }
      await writeConfig(next);
      const configuration = projectRuntimeAdminConfig(next, runtimeProjectionOptions);
      return res.json({
        ok: true,
        contract: NATIVE_ADMIN_CONFIGURATION_UPDATE_CONTRACT,
        changed: true,
        restartRequired: true,
        server: nativeServerIdentity(await getServerIdentity(), configuration),
        configuration,
        editability: editability(configuration, true),
        capabilities: nativeConfigurationCapabilities(configuration, true),
      });
    } catch (error) {
      if (error?.name === 'SecretConfigFieldError') return errorResponse(res, 400, 'administrator_configuration_field_not_editable');
      if (error?.name === 'ImmutableConfigSchemaError') return errorResponse(res, 400, 'administrator_configuration_update_invalid');
      return errorResponse(res, 503, 'administrator_configuration_update_failed');
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
          albums: browse.available ? browse.counts.albums : null,
          tracks: browse.available ? browse.counts.tracks : null,
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
    const status = await getDlnaStatus().catch(() => null);
    return res.json({ ok: true, contract: NATIVE_ADMIN_DLNA_CONTRACT, ...projectNativeDlnaStatus(status) });
  });
}
