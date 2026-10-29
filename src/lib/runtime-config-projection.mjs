import { normalizeMoodeBaseUrl } from './moode-url.mjs';
import { assertNoSecretConfigFields } from './runtime-config-security.mjs';

const MAX_COLLECTION_ITEMS = 400;
const MAX_TEXT_LENGTH = 1024;

function text(value, fallback = '') {
  const valueText = String(value ?? '').trim();
  return valueText.length > MAX_TEXT_LENGTH ? valueText.slice(0, MAX_TEXT_LENGTH) : (valueText || fallback);
}

function number(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= min && candidate <= max ? candidate : fallback;
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function immutableRuntime(environment) {
  return Boolean(text(environment?.SONUVI_STATE_ROOT || environment?.NOW_PLAYING_STATE_ROOT));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function limitedStringMap(value) {
  const result = {};
  for (const [key, item] of Object.entries(object(value)).slice(0, MAX_COLLECTION_ITEMS)) {
    const safeKey = text(key);
    const safeValue = text(item);
    if (safeKey && safeValue) result[safeKey] = safeValue;
  }
  return result;
}

function limitedRecords(value, fields) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => {
    const raw = object(item);
    const result = {};
    for (const field of fields) {
      if (field === 'count') {
        const count = number(raw.count, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
        if (count) result.count = count;
      } else {
        const safe = text(raw[field]);
        if (safe) result[field] = safe;
      }
    }
    return result;
  }).filter((item) => Object.keys(item).length > 0);
}

function projectedAlexa(cfg) {
  const alexa = object(cfg.alexa);
  return {
    enabled: bool(alexa.enabled, true),
    publicDomain: text(alexa.publicDomain),
    webhookPath: text(alexa.webhookPath, '/alexa'),
    artistAliases: limitedStringMap(alexa.artistAliases),
    albumAliases: limitedStringMap(alexa.albumAliases),
    playlistAliases: limitedStringMap(alexa.playlistAliases),
    unresolvedArtists: limitedRecords(alexa.unresolvedArtists, ['artist', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource']),
    heardArtists: limitedRecords(alexa.heardArtists, ['artist', 'key', 'source', 'status', 'at']),
    unresolvedAlbums: limitedRecords(alexa.unresolvedAlbums, ['album', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource']),
    heardAlbums: limitedRecords(alexa.heardAlbums, ['album', 'key', 'source', 'status', 'at']),
    unresolvedPlaylists: limitedRecords(alexa.unresolvedPlaylists, ['playlist', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource']),
    heardPlaylists: limitedRecords(alexa.heardPlaylists, ['playlist', 'key', 'source', 'status', 'at']),
  };
}

function projectedFeatures(cfg) {
  const features = object(cfg.features);
  return {
    podcasts: bool(features.podcasts, true),
    ratings: bool(features.ratings, true),
    radio: bool(features.radio, true),
    albumPersonnel: bool(features.albumPersonnel, true),
    showAboutWhenNoPersonnel: bool(features.showAboutWhenNoPersonnel, true),
    moodeDisplayTakeover: bool(features.moodeDisplayTakeover, true),
    lastfm: bool(features.lastfm, false),
  };
}

function projectedDisplay(cfg) {
  const display = object(cfg.display);
  return {
    idleBrandLine: text(display.idleBrandLine, 'Clem’s Place'),
    idleMessageLine: text(display.idleMessageLine, 'The record room is quiet'),
  };
}

function projectedPorts(cfg) {
  const ports = object(cfg.ports);
  return {
    api: number(ports.api, 3101, { min: 1, max: 65535 }),
    ui: number(ports.ui, 8101, { min: 1, max: 65535 }),
  };
}

function configuredLastfm(cfg, environment) {
  return Boolean(text(environment.LASTFM_API_KEY)
    || (!immutableRuntime(environment) && text(object(cfg.lastfm).apiKey)));
}

function configuredApns(apns, apnsCredentials) {
  const topic = text(apns.topic, text(apnsCredentials.topic, 'com.brianwis.sonuvi'));
  return {
    configured: Boolean(
      text(apnsCredentials.keyId)
      && text(apnsCredentials.teamId)
      && (text(apnsCredentials.privateKey) || text(apnsCredentials.privateKeyPath))
      && topic
    ),
    topic,
    environment: text(apns.environment, text(apnsCredentials.environment, 'auto')).toLowerCase(),
  };
}

function effectiveTrackNotify(cfg, environment) {
  const notify = object(object(cfg.notifications).trackNotify);
  const envEnabled = text(environment.TRACK_NOTIFY_ENABLED);
  return {
    enabled: envEnabled ? /^(1|true|yes|on)$/i.test(envEnabled) : bool(notify.enabled, false),
    pollMs: number(environment.TRACK_NOTIFY_POLL_MS || notify.pollMs, 3000, { min: 100, max: 3_600_000 }),
    dedupeMs: number(environment.TRACK_NOTIFY_DEDUPE_MS || notify.dedupeMs, 15000, { min: 0, max: 86_400_000 }),
    alexaMaxAgeMs: number(environment.TRACK_NOTIFY_ALEXA_MAX_AGE_MS || notify.alexaMaxAgeMs, 21600000, { min: 1000, max: 604_800_000 }),
  };
}

function projectedNodes(cfg) {
  const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
  return nodes.slice(0, 64).map((node) => {
    const source = object(node);
    const result = {};
    for (const field of ['name', 'ip', 'role', 'sshUser']) {
      const value = text(source[field]);
      if (value) result[field] = value;
    }
    return result;
  }).filter((node) => Object.keys(node).length > 0);
}

/**
 * The unauthenticated browser projection. Every field is literal and
 * intentional; this must never become a generic config serializer.
 */
export function projectRuntimePublicConfig(cfg, { environment = process.env } = {}) {
  const source = object(cfg);
  const alexa = object(source.alexa);
  return {
    contract: 'sonuvi.runtime-public-config.v1',
    projectName: text(source.projectName, 'now-playing'),
    environment: text(source.environment, 'home'),
    timezone: text(source.timezone, 'America/Chicago'),
    ports: projectedPorts(source),
    display: projectedDisplay(source),
    features: projectedFeatures(source),
    lastfm: { configured: configuredLastfm(source, environment) },
    alexa: { enabled: bool(alexa.enabled, true) },
  };
}

/**
 * Authenticated administrator projection. It includes operating settings that
 * the configuration UI needs, but intentionally never returns keys, tokens,
 * credential paths, private configuration blobs, or arbitrary future fields.
 * The four explicitly editable media folders are visible only in this
 * authenticated projection so a saved setting can be read back and verified.
 */
export function projectRuntimeAdminConfig(cfg, {
  environment = process.env,
  apnsCredentials = {},
  defaults = {},
} = {}) {
  const source = object(cfg);
  const notifications = object(source.notifications);
  const pushover = object(notifications.pushover);
  const mpd = object(source.mpd);
  const moode = object(source.moode);
  const lastfm = object(source.lastfm);
  const runtime = object(source.runtime);
  const paths = object(source.paths);
  const moodeHost = text(environment.MOODE_SSH_HOST || moode.sshHost || mpd.host || defaults.moodeHost || 'moode.local');
  const moodeBaseRaw = text(environment.MOODE_BASE_URL || moode.baseUrl);

  return {
    ...projectRuntimePublicConfig(source, { environment }),
    contract: 'sonuvi.runtime-admin-config.v1',
    deployment: {
      immutable: immutableRuntime(environment),
      credentials: 'operator-managed',
      sshRestricted: immutableRuntime(environment),
      environmentManaged: [
        ['mpdHost', 'MPD_HOST'], ['mpdPort', 'MPD_PORT'],
        ['moodeSshHost', 'MOODE_SSH_HOST'], ['moodeSshUser', 'MOODE_SSH_USER'],
        ['moodeBaseUrl', 'MOODE_BASE_URL'],
        ['notifyEnabled', 'TRACK_NOTIFY_ENABLED'], ['pollMs', 'TRACK_NOTIFY_POLL_MS'],
        ['dedupeMs', 'TRACK_NOTIFY_DEDUPE_MS'], ['alexaMaxAgeMs', 'TRACK_NOTIFY_ALEXA_MAX_AGE_MS'],
        ['pathPiMountBase', 'PI4_MOUNT_BASE'], ['pathPodcastRoot', 'PODCAST_ROOT'],
      ].filter(([, variable]) => text(environment[variable])).map(([id]) => id),
    },
    alexa: projectedAlexa(source),
    notifications: {
      trackNotify: effectiveTrackNotify(source, environment),
      pushover: {
        configured: Boolean(text(environment.PUSHOVER_TOKEN)
          || (!immutableRuntime(environment) && text(pushover.token)))
          && Boolean(text(environment.PUSHOVER_USER_KEY)
            || (!immutableRuntime(environment) && text(pushover.userKey))),
      },
      apns: configuredApns(object(notifications.apns), apnsCredentials),
    },
    trackKeyConfigured: Boolean(text(environment.TRACK_KEY)
      || (!immutableRuntime(environment) && text(source.trackKey))),
    apiHost: text(source.apiHost),
    apiNodeIp: text(source.apiNodeIp),
    nodes: projectedNodes(source),
    mpd: {
      host: text(environment.MPD_HOST || mpd.host),
      port: number(environment.MPD_PORT || mpd.port, 6600, { min: 1, max: 65535 }),
    },
    moode: {
      sshHost: text(environment.MOODE_SSH_HOST || moode.sshHost),
      sshUser: text(environment.MOODE_SSH_USER || moode.sshUser, 'moode'),
      baseUrl: moodeBaseRaw ? normalizeMoodeBaseUrl(moodeBaseRaw, moodeHost) : '',
    },
    runtime: {
      publicBaseUrl: text(environment.PUBLIC_BASE_URL || runtime.publicBaseUrl),
      artCacheLimit: number(runtime.artCacheLimit, 0, { min: 0, max: 100_000 }),
    },
    lastfm: {
      configured: configuredLastfm(source, environment),
      username: text(lastfm.username),
      recentsReplaceRadio: bool(lastfm.recentsReplaceRadio, false),
      recentsMode: ['toptracks', 'topartists', 'topalbums', 'recenttracks'].includes(text(lastfm.recentsMode).toLowerCase())
        ? text(lastfm.recentsMode).toLowerCase()
        : 'toptracks',
    },
    paths: {
      musicLibraryRoot: text(paths.musicLibraryRoot),
      moodeUsbMount: text(paths.moodeUsbMount),
      piMountBase: text(paths.piMountBase),
      podcastRoot: text(paths.podcastRoot),
    },
    storage: {
      mediaPathOverrides: {
        ...(text(environment.PI4_MOUNT_BASE) ? { piMountBase: text(environment.PI4_MOUNT_BASE) } : {}),
        ...(text(environment.PODCAST_ROOT) ? { podcastRoot: text(environment.PODCAST_ROOT) } : {}),
      },
      musicLibraryRootConfigured: Boolean(text(paths.musicLibraryRoot)),
      moodeUsbMountConfigured: Boolean(text(paths.moodeUsbMount)),
      piMountBaseConfigured: Boolean(text(paths.piMountBase)),
      podcastRootConfigured: Boolean(text(paths.podcastRoot)),
    },
  };
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function updateStringMap(value) {
  return limitedStringMap(value);
}

function updateRecords(value, fields) {
  return limitedRecords(value, fields);
}

/**
 * Permit only the editable configuration surface. Unknown incoming fields are
 * dropped before merge, preventing a browser POST from becoming a generic
 * write primitive. Credentials are not a mutable configuration surface and
 * must instead be supplied through root-managed protected environment files.
 */
export function sanitizeRuntimeConfigUpdate(value) {
  const incoming = object(value);
  assertNoSecretConfigFields(incoming, { context: 'runtime configuration update' });
  const out = {};

  if (hasOwn(incoming, 'projectName')) out.projectName = text(incoming.projectName);
  if (hasOwn(incoming, 'environment')) out.environment = text(incoming.environment);
  if (hasOwn(incoming, 'timezone')) out.timezone = text(incoming.timezone);
  for (const name of ['apiHost', 'apiNodeIp']) {
    if (hasOwn(incoming, name)) out[name] = text(incoming[name]);
  }

  if (hasOwn(incoming, 'ports')) {
    const ports = object(incoming.ports);
    out.ports = {};
    if (hasOwn(ports, 'api')) out.ports.api = number(ports.api, 3101, { min: 1, max: 65535 });
    if (hasOwn(ports, 'ui')) out.ports.ui = number(ports.ui, 8101, { min: 1, max: 65535 });
  }

  if (hasOwn(incoming, 'display')) {
    const display = object(incoming.display);
    out.display = {};
    for (const field of ['idleBrandLine', 'idleMessageLine']) {
      if (hasOwn(display, field)) out.display[field] = text(display[field]);
    }
  }

  if (hasOwn(incoming, 'features')) {
    const features = object(incoming.features);
    out.features = {};
    for (const field of ['podcasts', 'ratings', 'radio', 'albumPersonnel', 'showAboutWhenNoPersonnel', 'moodeDisplayTakeover', 'lastfm']) {
      if (hasOwn(features, field)) out.features[field] = bool(features[field], false);
    }
  }

  if (hasOwn(incoming, 'mpd')) {
    const mpd = object(incoming.mpd);
    out.mpd = {};
    if (hasOwn(mpd, 'host')) out.mpd.host = text(mpd.host);
    if (hasOwn(mpd, 'port')) out.mpd.port = number(mpd.port, 6600, { min: 1, max: 65535 });
  }

  if (hasOwn(incoming, 'moode')) {
    const moode = object(incoming.moode);
    out.moode = {};
    for (const field of ['sshHost', 'sshUser', 'baseUrl']) {
      if (hasOwn(moode, field)) out.moode[field] = text(moode[field]);
    }
  }

  if (hasOwn(incoming, 'nodes') && Array.isArray(incoming.nodes)) {
    out.nodes = projectedNodes({ nodes: incoming.nodes });
  }

  if (hasOwn(incoming, 'alexa')) {
    const alexa = object(incoming.alexa);
    out.alexa = {};
    for (const field of ['enabled']) {
      if (hasOwn(alexa, field)) out.alexa[field] = bool(alexa[field], false);
    }
    for (const field of ['publicDomain', 'webhookPath']) {
      if (hasOwn(alexa, field)) out.alexa[field] = text(alexa[field]);
    }
    for (const field of ['artistAliases', 'albumAliases', 'playlistAliases']) {
      if (hasOwn(alexa, field)) out.alexa[field] = updateStringMap(alexa[field]);
    }
    const recordFields = {
      unresolvedArtists: ['artist', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource'],
      heardArtists: ['artist', 'key', 'source', 'status', 'at'],
      unresolvedAlbums: ['album', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource'],
      heardAlbums: ['album', 'key', 'source', 'status', 'at'],
      unresolvedPlaylists: ['playlist', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource'],
      heardPlaylists: ['playlist', 'key', 'source', 'status', 'at'],
    };
    for (const [field, fields] of Object.entries(recordFields)) {
      if (hasOwn(alexa, field)) out.alexa[field] = updateRecords(alexa[field], fields);
    }
  }

  if (hasOwn(incoming, 'notifications')) {
    const notifications = object(incoming.notifications);
    out.notifications = {};
    if (hasOwn(notifications, 'trackNotify')) {
      const trackNotify = object(notifications.trackNotify);
      out.notifications.trackNotify = {};
      if (hasOwn(trackNotify, 'enabled')) out.notifications.trackNotify.enabled = bool(trackNotify.enabled, false);
      for (const field of ['pollMs', 'dedupeMs', 'alexaMaxAgeMs']) {
        if (hasOwn(trackNotify, field)) out.notifications.trackNotify[field] = number(trackNotify[field], 0, { min: 0, max: 604_800_000 });
      }
    }
  }

  if (hasOwn(incoming, 'paths')) {
    const paths = object(incoming.paths);
    out.paths = {};
    for (const field of ['musicLibraryRoot', 'moodeUsbMount', 'piMountBase', 'podcastRoot']) {
      const candidate = text(paths[field]);
      if (candidate) out.paths[field] = candidate;
    }
  }

  if (hasOwn(incoming, 'lastfm')) {
    const lastfm = object(incoming.lastfm);
    out.lastfm = {};
    if (hasOwn(lastfm, 'username')) out.lastfm.username = text(lastfm.username);
    if (hasOwn(lastfm, 'recentsReplaceRadio')) out.lastfm.recentsReplaceRadio = bool(lastfm.recentsReplaceRadio, false);
    if (hasOwn(lastfm, 'recentsMode')) {
      const mode = text(lastfm.recentsMode).toLowerCase();
      out.lastfm.recentsMode = ['toptracks', 'topartists', 'topalbums', 'recenttracks'].includes(mode) ? mode : 'toptracks';
    }
  }

  return out;
}

export function mergeRuntimeConfig(current, incoming) {
  const base = object(current);
  const next = { ...base, ...incoming };
  for (const key of ['alexa', 'ports', 'paths', 'display', 'features', 'mpd', 'moode', 'runtime', 'lastfm']) {
    if (incoming[key] && typeof incoming[key] === 'object' && !Array.isArray(incoming[key])) {
      next[key] = { ...object(base[key]), ...incoming[key] };
    }
  }
  if (incoming.notifications && typeof incoming.notifications === 'object') {
    const before = object(base.notifications);
    const after = object(incoming.notifications);
    next.notifications = {
      ...before,
      ...after,
      trackNotify: { ...object(before.trackNotify), ...object(after.trackNotify) },
      pushover: { ...object(before.pushover), ...object(after.pushover) },
      apns: { ...object(before.apns), ...object(after.apns) },
    };
  }
  return next;
}
