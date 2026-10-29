import path from 'node:path';

// Persistent state must be addressable outside an application release before a
// release can be treated as immutable.  This module deliberately does not
// create directories or move existing files: callers retain their current
// atomic-write behavior and an operator opts into the shared layout explicitly.
//
// Legacy installs remain byte-for-byte path compatible when neither state-root
// environment variable is set.  SONUVI_* is the documented spelling;
// NOW_PLAYING_* remains an accepted compatibility alias.
const STATE_ROOT_ENV_NAMES = ['SONUVI_STATE_ROOT', 'NOW_PLAYING_STATE_ROOT'];
const CONFIG_ROOT_ENV_NAMES = ['SONUVI_CONFIG_ROOT', 'NOW_PLAYING_CONFIG_ROOT'];
const SECRETS_ROOT_ENV_NAMES = ['SONUVI_SECRETS_ROOT', 'NOW_PLAYING_SECRETS_ROOT'];

function text(value) {
  return String(value || '').trim();
}

function configured(env, names) {
  for (const name of names) {
    const value = text(env?.[name]);
    if (value) return value;
  }
  return '';
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function absoluteRoot(value, name) {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

/**
 * Resolve a child path without allowing a relative override to escape its
 * declared root.  Absolute per-artifact overrides are intentionally supported
 * for existing operators, but are treated as an explicit operator choice rather
 * than a path derived from untrusted input.
 */
export function resolveWithin(root, relativePath, label = 'runtime state path') {
  const raw = text(relativePath);
  if (!raw || path.isAbsolute(raw) || raw.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(root, raw);
  if (!contained(root, resolved)) throw new Error(`${label} escapes its approved root`);
  return resolved;
}

function configuredFile({ env, name, root, fallback, legacyRoot = root, sharedStateEnabled = false }) {
  const value = text(env?.[name]);
  if (!value) return fallback;
  if (path.isAbsolute(value)) return path.resolve(value);
  return sharedStateEnabled
    ? resolveWithin(root, value, `${name} override`)
    : path.resolve(legacyRoot, value);
}

function protectedFile({ env, name, root, fallback, sharedStateEnabled }) {
  const value = text(env?.[name]);
  if (!sharedStateEnabled || !value) return fallback;
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path beneath SONUVI_SECRETS_ROOT`);
  }
  const resolved = path.resolve(value);
  if (!contained(root, resolved)) {
    throw new Error(`${name} must remain beneath SONUVI_SECRETS_ROOT`);
  }
  return resolved;
}

/**
 * Return all Sonuvi-owned persistent locations.  No returned path is created
 * here, making this safe for route construction and inspection.  When a shared
 * root is enabled, default writes are contained below it; callers that need a
 * specific external mount must use an explicit absolute override.
 */
export function createRuntimeStatePaths({ cwd = process.cwd(), env = process.env } = {}) {
  const releaseRoot = path.resolve(cwd);
  const configuredStateRoot = configured(env, STATE_ROOT_ENV_NAMES);
  const sharedStateEnabled = Boolean(configuredStateRoot);
  const stateRoot = sharedStateEnabled
    ? absoluteRoot(configuredStateRoot, 'SONUVI_STATE_ROOT')
    : releaseRoot;

  const configuredConfigRoot = configured(env, CONFIG_ROOT_ENV_NAMES);
  const configRoot = configuredConfigRoot
    ? absoluteRoot(configuredConfigRoot, 'SONUVI_CONFIG_ROOT')
    : (sharedStateEnabled ? resolveWithin(stateRoot, 'config', 'shared configuration root') : resolveWithin(releaseRoot, 'config', 'legacy configuration root'));
  const configuredSecretsRoot = configured(env, SECRETS_ROOT_ENV_NAMES);
  const secretsRoot = sharedStateEnabled
    ? absoluteRoot(configuredSecretsRoot || '/etc/sonuvi', 'SONUVI_SECRETS_ROOT')
    : '';

  const dataRoot = sharedStateEnabled ? resolveWithin(stateRoot, 'data') : resolveWithin(releaseRoot, 'data');
  const cacheRoot = sharedStateEnabled ? resolveWithin(stateRoot, 'cache') : resolveWithin(releaseRoot, 'var');
  const protectedRoot = sharedStateEnabled ? resolveWithin(stateRoot, 'protected') : resolveWithin(releaseRoot, 'var');
  const logsRoot = sharedStateEnabled ? resolveWithin(stateRoot, 'logs') : resolveWithin(releaseRoot, 'logs');

  const file = (options) => configuredFile({
    ...options,
    legacyRoot: releaseRoot,
    sharedStateEnabled,
  });
  const defaultPath = (root, relative, envName) => file({
    env,
    name: envName,
    root,
    fallback: resolveWithin(root, relative, envName || 'runtime state path'),
  });

  const legacyTmp = (name) => path.join('/tmp', 'now-playing', name);
  const trackCacheFallback = sharedStateEnabled
    ? resolveWithin(cacheRoot, 'tracks', 'track cache')
    : '/tmp/moode-track-cache';
  const mobileTrackCacheFallback = sharedStateEnabled
    ? resolveWithin(cacheRoot, 'mobile-tracks', 'mobile track cache')
    : legacyTmp('mobile-track-cache');
  const artCacheFallback = sharedStateEnabled
    ? resolveWithin(cacheRoot, 'art', 'art cache')
    : legacyTmp('art-cache');
  const podcastDownloadLogPath = file({
    env,
    name: 'PODCAST_DL_LOG',
    root: cacheRoot,
    fallback: sharedStateEnabled
      ? resolveWithin(cacheRoot, 'podcasts/downloads.ndjson', 'podcast download log')
      : resolveWithin(releaseRoot, 'var/podcasts/downloads.ndjson', 'legacy podcast download log'),
  });
  const podcastMapDir = file({
    env,
    name: 'PODCAST_MAP_DIR',
    root: cacheRoot,
    fallback: path.join(path.dirname(podcastDownloadLogPath), 'maps'),
  });

  return Object.freeze({
    contract: 'sonuvi.runtime-state-paths.v1',
    sharedStateEnabled,
    releaseRoot,
    stateRoot,
    configRoot,
    secretsRoot,
    dataRoot,
    cacheRoot,
    protectedRoot,
    logsRoot,

    // Configuration and credentials. Config roots are deliberately separate
    // from caches; explicit environment files continue to take precedence.
    configPath: file({
      env,
      name: 'NOW_PLAYING_CONFIG_PATH',
      root: configRoot,
      fallback: resolveWithin(configRoot, 'now-playing.config.json', 'runtime config'),
    }),
    exampleConfigPath: resolveWithin(releaseRoot, 'config/now-playing.config.example.json', 'example config'),
    lastfmEnvPath: protectedFile({
      env,
      name: 'LASTFM_ENV_FILE',
      root: secretsRoot || releaseRoot,
      fallback: sharedStateEnabled
        ? path.join(secretsRoot, 'lastfm.env')
        : resolveWithin(releaseRoot, '.env', 'legacy Last.fm environment file'),
      sharedStateEnabled,
    }),

    // Catalog, source diagnostics, and future audio-quality checkpoints.
    browseIndexPath: defaultPath(dataRoot, 'library-browse-index.json', 'BROWSE_INDEX_PATH'),
    sourceAudioCachePath: file({
      env,
      name: 'SOURCE_AUDIO_CACHE_PATH',
      root: dataRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(dataRoot, 'source-audio-cache.json', 'source audio cache')
        : resolveWithin(releaseRoot, 'var/mobile-source-audio.json', 'legacy source audio cache'),
    }),
    audioQualityCatalogPath: defaultPath(dataRoot, 'audio-quality-catalog.json', 'AUDIO_QUALITY_CATALOG_PATH'),
    audioQualityCheckpointPath: defaultPath(dataRoot, 'audio-quality-checkpoint.json', 'AUDIO_QUALITY_CHECKPOINT_PATH'),

    // User-visible history, profile, playlists, radio, and controller state.
    listeningHistoryPath: defaultPath(dataRoot, 'listening-history.jsonl', 'LISTENING_HISTORY_PATH'),
    listeningHistoryStatePath: defaultPath(dataRoot, 'listening-history.state.json', 'LISTENING_HISTORY_STATE_PATH'),
    controllerProfilePath: defaultPath(dataRoot, 'controller-profile.json', 'NOW_PLAYING_CONTROLLER_PROFILE_PATH'),
    playlistIndexPath: defaultPath(dataRoot, 'playlists-index.json', 'PLAYLISTS_CACHE_PATH'),
    radioQueuePresetsPath: defaultPath(dataRoot, 'radio-queue-presets.json', 'RADIO_PRESETS_PATH'),
    radioQueueMapPath: defaultPath(dataRoot, 'radio-queue-map.json', 'RADIO_QUEUE_MAP_PATH'),
    endlessVibePath: defaultPath(dataRoot, 'endless-vibe.json', 'ENDLESS_VIBE_PATH'),
    vibeLibraryIndexPath: file({
      env,
      name: 'MOODE_LIBRARY_INDEX',
      root: dataRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(dataRoot, 'moode-library-index.json', 'vibe library index')
        : resolveWithin(releaseRoot, 'moode_library_index.json', 'legacy vibe library index'),
    }),
    jukeboxStatePath: defaultPath(dataRoot, 'jukebox-entries.json', 'JUKEBOX_STATE_PATH'),
    peppyLastPushPath: defaultPath(dataRoot, 'peppy-last-push.json', 'PEPPY_LAST_PUSH_PATH'),
    animatedArtCachePath: defaultPath(dataRoot, 'animated-art-cache.json', 'ANIMATED_ART_CACHE_PATH'),
    animatedArtDiscoveryPath: defaultPath(dataRoot, 'animated-art-discovery.json', 'ANIMATED_ART_DISCOVERY_PATH'),
    animatedArtH264Dir: defaultPath(dataRoot, 'animated-art-h264', 'ANIMATED_ART_H264_DIR'),

    // Regenerable cache and media-adjacent bookkeeping. These keep historical
    // /tmp defaults until an immutable-release root is explicitly selected.
    trackCacheDir: file({ env, name: 'TRACK_CACHE_DIR', root: cacheRoot, fallback: trackCacheFallback }),
    mobileTrackCacheDir: file({ env, name: 'MOBILE_TRACK_CACHE_DIR', root: cacheRoot, fallback: mobileTrackCacheFallback }),
    artCacheDir: file({ env, name: 'ART_CACHE_DIR', root: cacheRoot, fallback: artCacheFallback }),
    libraryThumbsDir: file({
      env,
      name: 'LIBRARY_THUMBS_DIR',
      root: cacheRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(cacheRoot, 'library-thumbs', 'library thumbnails')
        : resolveWithin(releaseRoot, '.cache/library-thumbs', 'legacy library thumbnails'),
    }),
    radioLogoCacheDir: file({
      env,
      name: 'RADIO_LOGO_CACHE_DIR',
      root: cacheRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(cacheRoot, 'radio-logo-cache', 'radio logo cache')
        : resolveWithin(releaseRoot, 'var/radio-logo-cache', 'legacy radio logo cache'),
    }),
    peppyExportDir: file({
      env,
      name: 'SONUVI_PEPPY_EXPORT_ROOT',
      root: cacheRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(cacheRoot, 'exports/peppymeter/1280x400', 'PeppyMeter export root')
        : resolveWithin(releaseRoot, 'exports/peppymeter/1280x400', 'legacy PeppyMeter export root'),
    }),
    mobileVideoCatalogPath: file({
      env,
      name: 'MOBILE_VIDEO_CATALOG_PATH',
      root: dataRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(dataRoot, 'mobile-video-catalog.json', 'mobile video catalog')
        : resolveWithin(releaseRoot, 'var/mobile-video-catalog.json', 'legacy mobile video catalog'),
    }),
    podcastDownloadLogPath,
    podcastMapDir,
    podcastsNightlyStatePath: file({
      env,
      name: 'PODCASTS_NIGHTLY_STATE_PATH',
      root: dataRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(dataRoot, 'podcasts/nightly-state.json', 'podcast nightly state')
        : '/tmp/now-playing-podcasts-nightly.json',
    }),
    youtubeHintsPath: file({
      env,
      name: 'YOUTUBE_HINTS_PATH',
      root: cacheRoot,
      fallback: path.join(path.dirname(podcastDownloadLogPath), 'youtube-hints.json'),
    }),
    temporaryDir: file({
      env,
      name: 'NOW_PLAYING_TEMP_DIR',
      root: cacheRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(cacheRoot, 'tmp', 'runtime temporary directory')
        : resolveWithin(releaseRoot, 'tmp', 'legacy runtime temporary directory'),
    }),

    // Protected runtime records: never public assets and always written by
    // existing atomic-write code with restrictive permissions.
    mobilePushTokensPath: defaultPath(protectedRoot, 'mobile-push-tokens.json', 'MOBILE_PUSH_TOKENS_PATH'),
    savedQobuzQueueDir: file({
      env,
      name: 'SAVED_QOBUZ_QUEUE_DIR',
      root: protectedRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(protectedRoot, 'saved-qobuz-queues', 'saved Qobuz queue directory')
        : '/var/lib/sonuvi/saved-qobuz-queues',
    }),
    vibeLogDir: defaultPath(logsRoot, 'vibe', 'VIBE_LOG_DIR'),
    vibePythonLogPath: file({
      env,
      name: 'VIBE_PYTHON_LOG',
      root: logsRoot,
      fallback: sharedStateEnabled
        ? resolveWithin(logsRoot, 'vibe/lastfm-vibe-radio.log', 'Last.fm vibe log')
        : '/home/moode/lastfm_vibe_radio.log',
    }),
  });
}

export function runtimeStatePaths(options) {
  return createRuntimeStatePaths(options);
}
