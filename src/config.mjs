import path from 'node:path';
import { loadConfigOrNull } from './config/load-config.mjs';
import { normalizeMoodeBaseUrl } from './lib/moode-url.mjs';
import { resolveWithin, runtimeStatePaths } from './lib/runtime-state-paths.mjs';
import { loadProtectedLastfmEnvironment } from './lib/protected-runtime-secrets.mjs';

export const RUNTIME_STATE_PATHS = runtimeStatePaths();
export const MASTER_CONFIG = loadConfigOrNull();
const PROTECTED_LASTFM = loadProtectedLastfmEnvironment({ statePaths: RUNTIME_STATE_PATHS });

const apiNode = (MASTER_CONFIG?.nodes || []).find(n => n?.role === 'api' || n?.role === 'both') || null;
const apiIp = String(apiNode?.ip || '').trim() || null;
const alexaEnabledFromConfig = MASTER_CONFIG?.alexa?.enabled;
const publicDomainFromConfig = String(MASTER_CONFIG?.alexa?.publicDomain || '').trim();
const notificationsCfg = MASTER_CONFIG?.notifications || {};
const mpdCfg = MASTER_CONFIG?.mpd || {};
const moodeCfg = MASTER_CONFIG?.moode || {};
const runtimeCfg = MASTER_CONFIG?.runtime || {};

// Environment overrides are already resolved by runtime-state-paths. Config
// values still need the same containment rule so immutable releases cannot
// turn a relative cache/token path into a write below their read-only CWD.
function configuredWritableStatePath(value, { fallback, root, label }) {
  const configured = String(value || '').trim();
  if (!configured) return fallback;
  if (path.isAbsolute(configured)) return path.resolve(configured);
  if (RUNTIME_STATE_PATHS.sharedStateEnabled) return resolveWithin(root, configured, label);
  return path.resolve(RUNTIME_STATE_PATHS.releaseRoot, configured);
}

function legacyConfigSecret(value) {
  return RUNTIME_STATE_PATHS.sharedStateEnabled ? '' : String(value || '').trim();
}

export const FFMPEG = process.env.FFMPEG || '/usr/bin/ffmpeg';
export const CURL = process.env.CURL || '/usr/bin/curl';

export const MPD_PLAYLIST_DIR = '/var/lib/mpd/playlists';
export const FAVORITES_PATH = `${MPD_PLAYLIST_DIR}/Favorites.m3u`;
export const MOODE_SSH_USER = process.env.MOODE_SSH_USER || moodeCfg?.sshUser || 'moode';
export const MOODE_SSH_HOST = process.env.MOODE_SSH_HOST || moodeCfg?.sshHost || mpdCfg?.host || 'moode.local';
export const PORT = Number(process.env.PORT || MASTER_CONFIG?.ports?.api || '3000');

export const MOODE_BASE_URL = normalizeMoodeBaseUrl(
  process.env.MOODE_BASE_URL || moodeCfg?.baseUrl,
  MOODE_SSH_HOST,
);

export const LOCAL_ADDRESS = process.env.LOCAL_ADDRESS || apiIp || 'sonuvi.local';

export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  runtimeCfg?.publicBaseUrl ||
  ((alexaEnabledFromConfig ?? true) && publicDomainFromConfig ? `https://${publicDomainFromConfig}` : '') ||
  `http://${LOCAL_ADDRESS}:${PORT}`;

export const MPD_HOST = process.env.MPD_HOST || mpdCfg?.host || MOODE_SSH_HOST || 'moode.local';
export const MPD_PORT = Number(process.env.MPD_PORT || mpdCfg?.port || '6600');

export const MOODE_USB_PREFIX =
  process.env.MOODE_USB_PREFIX ||
  (MASTER_CONFIG?.paths?.moodeUsbMount
    ? `USB/${String(MASTER_CONFIG.paths.moodeUsbMount).split('/').filter(Boolean).slice(-1)[0] || 'SamsungMoode'}/`
    : 'USB/SamsungMoode/');
export const PI4_MOUNT_BASE = process.env.PI4_MOUNT_BASE || MASTER_CONFIG?.paths?.piMountBase || '/mnt/SamsungMoode';
export const MUSIC_LIBRARY_ROOT = process.env.MUSIC_LIBRARY_ROOT || MASTER_CONFIG?.paths?.musicLibraryRoot || '/var/lib/mpd/music';
export const PODCAST_ROOT = process.env.PODCAST_ROOT || MASTER_CONFIG?.paths?.podcastRoot || path.join(MUSIC_LIBRARY_ROOT, 'Podcasts');

export const METAFLAC = process.env.METAFLAC || '/usr/bin/metaflac';

// A deployment must supply its own operator credential through protected
// environment material. Legacy config fallback remains only for a checkout
// that has not opted into the immutable shared-state contract.
export const TRACK_KEY = String(process.env.TRACK_KEY || legacyConfigSecret(MASTER_CONFIG?.trackKey) || '').trim();
// Immutable releases read Last.fm values only from /etc/sonuvi (or a supplied
// root-managed equivalent). They never fall back to mutable JSON config.
export const LASTFM_API_KEY = String(process.env.LASTFM_API_KEY || PROTECTED_LASTFM.LASTFM_API_KEY || legacyConfigSecret(MASTER_CONFIG?.lastfm?.apiKey) || '').trim();
export const LASTFM_API_SECRET = String(process.env.LASTFM_API_SECRET || PROTECTED_LASTFM.LASTFM_API_SECRET || '').trim();
export const LASTFM_SESSION_KEY = String(process.env.LASTFM_SESSION_KEY || PROTECTED_LASTFM.LASTFM_SESSION_KEY || '').trim();
export const LASTFM_MPD_MODE = ['disabled', 'shadow', 'active'].includes(String(process.env.LASTFM_MPD_MODE || '').trim().toLowerCase())
  ? String(process.env.LASTFM_MPD_MODE).trim().toLowerCase()
  : 'shadow';
export const ENABLE_ALEXA =
  process.env.ENABLE_ALEXA != null
    ? String(process.env.ENABLE_ALEXA).trim() === '1'
    : Boolean(alexaEnabledFromConfig ?? true);
export const TRANSCODE_TRACKS = String(process.env.TRANSCODE_TRACKS || '0').trim() === '1';
export const TRACK_CACHE_DIR = configuredWritableStatePath(runtimeCfg?.trackCacheDir, {
  fallback: RUNTIME_STATE_PATHS.trackCacheDir,
  root: RUNTIME_STATE_PATHS.cacheRoot,
  label: 'runtime.trackCacheDir',
});

// Native iPhone/CarPlay POC surface. Disabled unless explicitly configured;
// these credentials are intentionally separate from the Alexa TRACK_KEY.
export const MOBILE_API_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MOBILE_API_ENABLED || '').trim());
export const MOBILE_API_SECRET = String(process.env.MOBILE_API_SECRET || '').trim();
export const MOBILE_TRACK_ID_SECRET = String(process.env.MOBILE_TRACK_ID_SECRET || '').trim();
export const MOBILE_API_ENROLLMENT_CODE = String(process.env.MOBILE_API_ENROLLMENT_CODE || '').trim();
export const MOBILE_PUBLIC_BASE_URL = String(process.env.MOBILE_PUBLIC_BASE_URL || '').trim();
export const MOBILE_TRACK_CACHE_DIR = RUNTIME_STATE_PATHS.mobileTrackCacheDir;
export const MOBILE_TRANSCODE_TRACKS =
  process.env.MOBILE_TRANSCODE_TRACKS != null
    ? /^(1|true|yes|on)$/i.test(String(process.env.MOBILE_TRANSCODE_TRACKS).trim())
    : true;
export const MOBILE_VIDEO_ROOT = path.resolve(
  process.env.MOBILE_VIDEO_ROOT || PI4_MOUNT_BASE
);
export const MOBILE_VIDEO_CATALOG_PATH = RUNTIME_STATE_PATHS.mobileVideoCatalogPath;

export const FAVORITES_PLAYLIST_NAME = process.env.FAVORITES_PLAYLIST_NAME || 'Favorites';
export const FAVORITES_REFRESH_MS = Number(process.env.FAVORITES_REFRESH_MS || '3000');
export const SEEBURG_PLAYLIST_NAME = process.env.SEEBURG_PLAYLIST_NAME || 'Seeburg Playlist';
export const MULTIPHONE_PLAYLIST_NAME = process.env.MULTIPHONE_PLAYLIST_NAME || 'Multiphone Playlist';
export const MILLS_PLAYLIST_NAME = process.env.MILLS_PLAYLIST_NAME || 'Mills Playlist';

// Optional Mills source-switching integration. Leave unset until Harmony is
// intentionally enabled on the Now-Playing host.
export const HARMONY_HOST = String(process.env.HARMONY_HOST || '').trim();
export const HARMONY_PORT = Number(process.env.HARMONY_PORT || '8088');
export const HARMONY_DOMAIN = String(process.env.HARMONY_DOMAIN || 'svcs.myharmony.com').trim();
export const HARMONY_HUB_ID = String(process.env.HARMONY_HUB_ID || '').trim();
export const HARMONY_DENON_DEVICE_ID = String(process.env.HARMONY_DENON_DEVICE_ID || '').trim();
export const HARMONY_INPUT_PHONO = String(process.env.HARMONY_INPUT_PHONO || 'InputPhono').trim();
export const HARMONY_INPUT_AUX1 = String(process.env.HARMONY_INPUT_AUX1 || 'InputAux1').trim();

// Optional Main Floor Echo Link volume sidecar. The sidecar owns Alexa
// credentials; these values only describe its loopback endpoint and target.
export const ECHO_LINK_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ECHO_LINK_ENABLED || '').trim());
export const ECHO_LINK_HOST = String(process.env.ECHO_LINK_HOST || '127.0.0.1').trim();
export const ECHO_LINK_PORT = Number(process.env.ECHO_LINK_PORT || '8765');
export const ECHO_LINK_TIMEOUT_MS = Number(process.env.ECHO_LINK_TIMEOUT_MS || '8000');

export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
export const ITUNES_COUNTRY = 'us';
export const ITUNES_TIMEOUT_MS = Number(process.env.ITUNES_TIMEOUT_MS || '2500');
export const ITUNES_TTL_HIT_MS = 1000 * 60 * 60 * 12;
export const ITUNES_TTL_MISS_MS = 1000 * 60 * 10;
// Optional Apple Music Catalog API credentials. Editorial About metadata is
// disabled unless this developer token is explicitly configured.
export const APPLE_MUSIC_DEVELOPER_TOKEN = String(process.env.APPLE_MUSIC_DEVELOPER_TOKEN || '').trim();
export const APPLE_MUSIC_COUNTRY = String(process.env.APPLE_MUSIC_COUNTRY || ITUNES_COUNTRY || 'us').trim().toLowerCase();
export const APPLE_MUSIC_TIMEOUT_MS = Number(process.env.APPLE_MUSIC_TIMEOUT_MS || '1200');
export const APPLE_MUSIC_KEY_ID = String(process.env.APPLE_MUSIC_KEY_ID || '').trim();
export const APPLE_MUSIC_TEAM_ID = String(process.env.APPLE_MUSIC_TEAM_ID || '').trim();
export const APPLE_MUSIC_PRIVATE_KEY_PATH = String(process.env.APPLE_MUSIC_PRIVATE_KEY_PATH || '').trim();

export const ART_CACHE_DIR = configuredWritableStatePath(runtimeCfg?.artCacheDir, {
  fallback: RUNTIME_STATE_PATHS.artCacheDir,
  root: RUNTIME_STATE_PATHS.cacheRoot,
  label: 'runtime.artCacheDir',
});
export const ART_CACHE_LIMIT = Number(process.env.ART_CACHE_LIMIT || runtimeCfg?.artCacheLimit || '250');

export const ART_640_PATH = path.join(ART_CACHE_DIR, 'current_640.jpg');
export const ART_BG_PATH = path.join(ART_CACHE_DIR, 'current_bg_640_blur.jpg');
export const PODCAST_DL_LOG = RUNTIME_STATE_PATHS.podcastDownloadLogPath;

export const MOODE_SSH = process.env.MOODE_SSH || `${MOODE_SSH_USER}@${MOODE_SSH_HOST}`;
export const FAVORITES_M3U = process.env.FAVORITES_M3U || '/var/lib/mpd/playlists/Favorites.m3u';

// Optional track-start push notifications (Pushover)
export const TRACK_NOTIFY_ENABLED =
  process.env.TRACK_NOTIFY_ENABLED != null
    ? /^(1|true|yes|on)$/i.test(String(process.env.TRACK_NOTIFY_ENABLED).trim())
    : Boolean(notificationsCfg?.trackNotify?.enabled ?? false);

export const TRACK_NOTIFY_POLL_MS = Number(
  process.env.TRACK_NOTIFY_POLL_MS || notificationsCfg?.trackNotify?.pollMs || 3000
);

export const TRACK_NOTIFY_DEDUPE_MS = Number(
  process.env.TRACK_NOTIFY_DEDUPE_MS || notificationsCfg?.trackNotify?.dedupeMs || 15000
);

export const TRACK_NOTIFY_ALEXA_MAX_AGE_MS = Number(
  process.env.TRACK_NOTIFY_ALEXA_MAX_AGE_MS || notificationsCfg?.trackNotify?.alexaMaxAgeMs || 21600000
);

// APNs provider credentials are deliberately environment/file-only. The
// runtime JSON may describe the topic/environment, but the Apple private key
// must never be returned by config routes or committed to the repository.
const apnsCfg = notificationsCfg?.apns || {};
export const APNS_KEY_ID = String(process.env.APNS_KEY_ID || '').trim();
export const APNS_TEAM_ID = String(process.env.APNS_TEAM_ID || '').trim();
export const APNS_PRIVATE_KEY_PATH = String(process.env.APNS_PRIVATE_KEY_PATH || '').trim();
export const APNS_PRIVATE_KEY = String(process.env.APNS_PRIVATE_KEY || '').trim();
export const APNS_TOPIC = String(
  process.env.APNS_TOPIC || apnsCfg?.topic || 'com.brianwis.sonuvi'
).trim();
export const APNS_ENVIRONMENT = String(
  process.env.APNS_ENVIRONMENT || apnsCfg?.environment || 'auto'
).trim().toLowerCase();
export const MOBILE_PUSH_TOKENS_PATH = configuredWritableStatePath(apnsCfg?.tokensPath, {
  fallback: RUNTIME_STATE_PATHS.mobilePushTokensPath,
  root: RUNTIME_STATE_PATHS.protectedRoot,
  label: 'notifications.apns.tokensPath',
});

export const PUSHOVER_TOKEN = String(
  process.env.PUSHOVER_TOKEN || legacyConfigSecret(notificationsCfg?.pushover?.token) || ''
).trim();

export const PUSHOVER_USER_KEY = String(
  process.env.PUSHOVER_USER_KEY || legacyConfigSecret(notificationsCfg?.pushover?.userKey) || ''
).trim();
