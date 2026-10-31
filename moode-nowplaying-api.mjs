#!/usr/bin/env node
/**
 * moode-nowplaying-api.mjs -- moOde Now-Playing API (Pi4)
 *
 * Stable endpoints:
 *   GET  /now-playing
 *   GET  /next-up
 *   GET  /art/*
 *   GET/POST /rating
 *   POST /queue/*
 *   POST /mpd/*
 *
 * Optional (gated):
 *   GET /track           (ENABLE_ALEXA=0)
 *   GET /_debug/mpd
 *
 * This pass: organization + guardrails (avoid empty resolver calls) + comments only.
 * pm2 restart api --update-env && pm2 logs api --lines 20
 */

// =========================
// Imports (ESM / Node 16+)
// =========================
// Must remain the first local import: it installs rehearsal-only process,
// network, and state-write boundaries before legacy route modules capture
// Node built-in helpers.
import './src/lib/rehearsal-runtime-boundary.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { exec, execFile, spawn as spawnNative } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import os from "node:os";
import { isPodcastPlaylist } from './src/lib/playlist-classification.mjs';
import {
  deriveRadioLookupContext,
  normalizeRadioMetadata,
  radioMetadataProfile as sharedRadioMetadataProfile,
  radioHoldbackPolicy as sharedRadioHoldbackPolicy,
} from './src/lib/radio-metadata.mjs';



// If you already have FETCH_HEADERS, keep it; otherwise ensure it includes a UA.
const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const RADIO_META_EVAL_ENABLED = String(process.env.RADIO_META_EVAL_ENABLED || '1').trim() !== '0';
const RADIO_META_EVAL_LOG = String(process.env.RADIO_META_EVAL_LOG || path.join(TRACK_CACHE_DIR, 'radio-metadata-eval.jsonl'));
const RADIO_META_EVAL_MIN_INTERVAL_MS = Math.max(5000, Number(process.env.RADIO_META_EVAL_MIN_INTERVAL_MS || '45000') || 45000);

const RADIO_META_HOLDBACK_ENABLED = String(process.env.RADIO_META_HOLDBACK_ENABLED || '1').trim() !== '0';
const RADIO_META_HOLDBACK_MS = Math.max(0, Number(process.env.RADIO_META_HOLDBACK_MS || '6000') || 6000);
const RADIO_META_HOLDBACK_MS_WFMT = Math.max(0, Number(process.env.RADIO_META_HOLDBACK_MS_WFMT || '45000') || 45000);
const RADIO_META_HOLDBACK_MS_NORMAL = Math.max(0, Number(process.env.RADIO_META_HOLDBACK_MS_NORMAL || '1500') || 1500);
const RADIO_META_NEW_STREAM_RESET_DELTA_S = Math.max(2, Number(process.env.RADIO_META_NEW_STREAM_RESET_DELTA_S || '3') || 3);
const radioMetaHoldbackState = new Map();

let lastRadioMetaEvalKey = '';
let lastRadioMetaEvalTs = 0;

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function radioHoldbackPolicy(stationName = '', stationKey = '') {
  return sharedRadioHoldbackPolicy(stationName, stationKey, {
    defaultMs: RADIO_META_HOLDBACK_MS,
    wfmtMs: RADIO_META_HOLDBACK_MS_WFMT,
    normalMs: RADIO_META_HOLDBACK_MS_NORMAL,
  });
}

function applyRadioMetadataHoldback({ stationKey = '', stationName = '', artist = '', title = '', album = '', radioPerformers = '', elapsedSec = 0 }) {
  const current = {
    artist: String(artist || '').trim(),
    title: String(title || '').trim(),
    album: String(album || '').trim(),
    radioPerformers: String(radioPerformers || '').trim(),
  };
  const now = Date.now();
  const key = String(stationKey || '').trim() || '__default__';

  if (!RADIO_META_HOLDBACK_ENABLED || !current.title) {
    return { ...current, holdback: { active: false, reason: 'disabled-or-empty' } };
  }

  let st = radioMetaHoldbackState.get(key);
  if (!st) {
    st = { stableSig: '', stable: null, pendingSig: '', pending: null, lastElapsedSec: 0 };
    radioMetaHoldbackState.set(key, st);
  }

  const sig = `${current.artist}||${current.title}||${current.album}||${current.radioPerformers}`.toLowerCase();
  const policy = radioHoldbackPolicy(stationName, stationKey);
  const holdbackMs = Math.max(0, Number(policy?.holdbackMs || RADIO_META_HOLDBACK_MS) || RADIO_META_HOLDBACK_MS);
  const elapsed = Math.max(0, toNum(elapsedSec, 0));
  const prevElapsed = Math.max(0, toNum(st.lastElapsedSec, elapsed));
  const elapsedReset = prevElapsed > 0 && elapsed >= 0 && (prevElapsed - elapsed) >= RADIO_META_NEW_STREAM_RESET_DELTA_S;
  st.lastElapsedSec = elapsed;

  if (!st.stableSig) {
    st.stableSig = sig;
    st.stable = { ...current, ts: now };
    st.pendingSig = '';
    st.pending = null;
    return { ...current, holdback: { active: false, reason: 'init', elapsedSec: elapsed } };
  }

  if (sig === st.stableSig) {
    st.pendingSig = '';
    st.pending = null;
    return { ...current, holdback: { active: false, reason: 'same-as-stable', elapsedSec: elapsed } };
  }

  if (st.pendingSig !== sig || !st.pending) {
    st.pendingSig = sig;
    st.pending = { ...current, firstSeenTs: now, lastSeenTs: now };
  } else {
    st.pending.lastSeenTs = now;
  }

  const pendingAgeMs = Math.max(0, now - toNum(st.pending?.firstSeenTs, now));
  const promoteByStable = pendingAgeMs >= holdbackMs;
  const canPromote = elapsedReset || promoteByStable;

  if (canPromote) {
    st.stableSig = sig;
    st.stable = { ...current, ts: now };
    st.pendingSig = '';
    st.pending = null;
    return {
      ...current,
      holdback: {
        active: false,
        reason: elapsedReset ? 'promoted:elapsed-reset' : 'promoted:stable-timeout',
        policy: String(policy?.mode || 'normal'),
        pendingAgeMs,
        elapsedSec: elapsed,
        elapsedPrevSec: prevElapsed,
        holdbackMs,
      },
    };
  }

  const stable = st.stable || current;
  return {
    ...stable,
    holdback: {
      active: true,
      reason: 'holding',
      policy: String(policy?.mode || 'normal'),
      pendingAgeMs,
      elapsedSec: elapsed,
      elapsedPrevSec: prevElapsed,
      holdbackMs,
      pendingTitle: current.title,
      stableTitle: String(stable.title || ''),
    },
  };
}

async function appendRadioMetaEval(entry = {}) {
  if (!RADIO_META_EVAL_ENABLED) return;
  mainRuntimeCapabilities?.assertBackgroundMutation('radio-metadata-eval');
  const station = String(entry?.stationName || '').trim().toLowerCase();
  const title = String(entry?.raw?.title || '').trim().toLowerCase();
  const artist = String(entry?.raw?.artist || '').trim().toLowerCase();
  const key = `${station}||${artist}||${title}`;
  const now = Date.now();
  const isSame = key && key === lastRadioMetaEvalKey;
  if (isSame && (now - lastRadioMetaEvalTs) < RADIO_META_EVAL_MIN_INTERVAL_MS) return;
  if (key) lastRadioMetaEvalKey = key;
  lastRadioMetaEvalTs = now;
  try {
    await fsp.mkdir(path.dirname(RADIO_META_EVAL_LOG), { recursive: true });
    await fsp.appendFile(RADIO_META_EVAL_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}


// Lazy-load podcast ops so API can boot even if podcast module is broken
let _podOps;

import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
let mainRuntimeCapabilities = null;
const nativeExecFileP = promisify(execFile);

// This is a process/network boundary for the monolithic API's remaining
// legacy helpers. Rehearsal is deliberately stricter than production: unknown
// child-process launches are treated as mutations, while direct fetches are
// classified by HTTP method. Adapter-specific guards remain in place too.
const execFileP = (...args) => {
  const command = path.basename(String(args[0] || 'external-command'));
  mainRuntimeCapabilities?.assertExternalMutation(`process.${command}`);
  return nativeExecFileP(...args);
};

const spawn = (...args) => {
  const command = path.basename(String(args[0] || 'external-command'));
  mainRuntimeCapabilities?.assertExternalMutation(`process.${command}`);
  return spawnNative(...args);
};

function fetch(input, init = {}) {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    mainRuntimeCapabilities?.assertExternalRead('network.fetch');
  } else {
    mainRuntimeCapabilities?.assertExternalMutation('network.fetch');
  }
  return globalThis.fetch(input, init);
}


// ---- MUST BE BEFORE importing undici ----
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';

// Node 18 often has Blob but not File; undici expects File to exist globally.
if (!globalThis.Blob && NodeBlob) globalThis.Blob = NodeBlob;
if (!globalThis.File && NodeFile) globalThis.File = NodeFile;
// ----------------------------------------

import { ProxyAgent, setGlobalDispatcher, Agent } from 'undici';
import {
  FFMPEG, CURL, MPD_PLAYLIST_DIR, FAVORITES_PATH, MOODE_SSH_USER, MOODE_SSH_HOST, PORT,
  MOODE_BASE_URL, PUBLIC_BASE_URL, LOCAL_ADDRESS, MPD_HOST, MPD_PORT, MOODE_USB_PREFIX,
  PI4_MOUNT_BASE, METAFLAC, TRACK_KEY, LASTFM_API_KEY, LASTFM_API_SECRET, LASTFM_SESSION_KEY, LASTFM_MPD_MODE,
  ENABLE_ALEXA, TRANSCODE_TRACKS, TRACK_CACHE_DIR,
  FAVORITES_PLAYLIST_NAME, FAVORITES_REFRESH_MS, ITUNES_SEARCH_URL, ITUNES_COUNTRY,
  ITUNES_TIMEOUT_MS, ITUNES_TTL_HIT_MS, ITUNES_TTL_MISS_MS,
  APPLE_MUSIC_DEVELOPER_TOKEN, APPLE_MUSIC_COUNTRY, APPLE_MUSIC_TIMEOUT_MS,
  APPLE_MUSIC_KEY_ID, APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_PRIVATE_KEY_PATH,
  ART_CACHE_DIR, ART_CACHE_LIMIT,
  ART_640_PATH, ART_BG_PATH, PODCAST_DL_LOG, MOODE_SSH, FAVORITES_M3U, MUSIC_LIBRARY_ROOT, PODCAST_ROOT,
  TRACK_NOTIFY_ENABLED, TRACK_NOTIFY_POLL_MS, TRACK_NOTIFY_DEDUPE_MS, TRACK_NOTIFY_ALEXA_MAX_AGE_MS,
  SEEBURG_PLAYLIST_NAME, MULTIPHONE_PLAYLIST_NAME, MILLS_PLAYLIST_NAME,
  MOBILE_API_ENABLED, MOBILE_API_SECRET, MOBILE_TRACK_ID_SECRET, MOBILE_API_ENROLLMENT_CODE,
  MOBILE_PUBLIC_BASE_URL, MOBILE_TRACK_CACHE_DIR, MOBILE_TRANSCODE_TRACKS,
  MOBILE_VIDEO_ROOT, MOBILE_VIDEO_CATALOG_PATH,
  APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY_PATH, APNS_PRIVATE_KEY, APNS_TOPIC,
  APNS_ENVIRONMENT, MOBILE_PUSH_TOKENS_PATH,
  PUSHOVER_TOKEN, PUSHOVER_USER_KEY,
  HARMONY_HOST, HARMONY_PORT, HARMONY_DOMAIN, HARMONY_HUB_ID,
  HARMONY_DENON_DEVICE_ID, HARMONY_INPUT_PHONO, HARMONY_INPUT_AUX1,
  RUNTIME_STATE_PATHS
} from './src/config.mjs';
import { log } from './src/lib/log.mjs';
import { handleMobileJsonError } from './src/lib/mobile-http.mjs';
import { execFileStrict } from './src/lib/exec.mjs';
import { createRuntimeCapabilities, rehearsalReadOnlyMiddleware } from './src/lib/runtime-capabilities.mjs';
import { publicRuntimeReleaseIdentity, resolveRuntimePublicWebRoot, resolveRuntimeReleaseIdentity } from './src/lib/release-runtime.mjs';
import { hasConfiguredTrackKey, isAuthorizedTrackKey } from './src/lib/track-key-auth.mjs';
import { radioDisplayName, radioStationNameForFile } from './src/lib/radio-display.mjs';
import {
  isAirplayCurrentSong,
  isFreshAirplayMetadata,
  mergeMoodeAirplaySong,
} from './src/lib/airplay-state.mjs';
import {
  mpdEscapeValue, mpdHasACK, parseMpdFirstBlock, parseMpdKeyVals,
  mpdGetStatus, mpdPlay, mpdPlayId, mpdPause, mpdStop, mpdQueryRaw
} from './src/services/mpd.service.mjs';
import { registerRatingRoutes } from './src/routes/rating.routes.mjs';
import { registerQueueRoutes } from './src/routes/queue.routes.mjs';
import { registerTrackRoutes } from './src/routes/track.routes.mjs';
import { registerArtRoutes, serveTrackArtwork } from './src/routes/art.routes.mjs';
import { registerMobileRoutes } from './src/routes/mobile.routes.mjs';
import { getBrowseIndex } from './src/lib/browse-index.mjs';
import { buildMobileCatalog } from './src/lib/mobile-track-identity.mjs';
import { createSourceAudioProbe } from './src/lib/source-audio.mjs';
import { createLiveRadioAudioProbe } from './src/lib/live-radio-audio.mjs';
import {
  buildQobuzNowPlayingPayload,
  createQobuzConnectSource,
  hasVerifiedMpdPlaybackEvidence,
  qobuzConnectDefaults,
} from './src/lib/qobuz-connect.mjs';
import {
  createPibuzQobuzAdapter,
  pibuzQobuzDefaults,
} from './src/lib/pibuz-qobuz.mjs';
import { createPibuzQobuzControlAdapter } from './src/lib/pibuz-qobuz-control.mjs';
import { createSavedQobuzQueueStore } from './src/lib/saved-qobuz-queues.mjs';
import { createNamedQobuzQueueService } from './src/lib/named-qobuz-queue-service.mjs';
import { createLocalPibuzBridgeClient } from './src/local-client.mjs';
import { createSavedQueuePlayService } from './src/saved-queue-play-service.mjs';
import { createQobuzConnectController } from './src/lib/qobuz-connect-control.mjs';
import { createListeningHistoryStore } from './src/lib/listening-history.mjs';
import { createLastfmScrobbler } from './src/lib/lastfm-scrobbler.mjs';
import { createApnsProvider } from './src/lib/apns.mjs';
import { resolveApnsMediaUrl } from './src/lib/apns-artwork.mjs';
import { createMobilePushTokenStore } from './src/lib/mobile-push-store.mjs';
import { createMobileVideoCatalog } from './src/lib/mobile-video-catalog.mjs';
import { buildAnimatedArtContext } from './src/lib/animated-art-context.mjs';
import { UpnpControlPoint } from './src/lib/upnp-control-point.mjs';
import { createUpnpPlaybackSessionManager } from './src/lib/upnp-playback-session.mjs';
import { createUpnpPlaybackQueueManager } from './src/lib/upnp-playback-queue.mjs';
import { registerAllConfigRoutes } from './src/routes/config.routes.index.mjs';
import { registerUpnpRoutes } from './src/routes/upnp.routes.mjs';
import { registerPodcastSubscriptionRoutes } from './src/routes/podcasts-subscriptions.routes.mjs';
import { registerPodcastRefreshRoutes } from './src/routes/podcasts-refresh.routes.mjs';
import { registerPodcastEpisodeRoutes } from './src/routes/podcasts-episodes.routes.mjs';
import { registerPodcastDownloadRoutes } from './src/routes/podcasts-download.routes.mjs';
import {
  registerSeeburgRoutes,
  jukeboxEntries,
  removeJukeboxEntry,
  withJukeboxMutation,
} from './src/routes/seeburg.routes.mjs';
import { registerMultiphoneRoutes } from './src/routes/multiphone.routes.mjs';
import { getMillsIntegrationState, registerMillsRoutes } from './src/routes/mills.routes.mjs';
import { HarmonyHubClient, sendHarmonyIrCommand } from './src/services/harmony.service.mjs';
import { createAppleAboutService } from './src/services/apple-about.service.mjs';
import { createAppleCatalogSearchService } from './src/services/apple-catalog-search.service.mjs';
import { createAppleMusicTokenProvider } from './src/lib/apple-music-token.mjs';
import { ABOUT_STATUS, createAboutResolver } from './src/services/about.service.mjs';

const RUNTIME_CAPABILITIES = createRuntimeCapabilities();
mainRuntimeCapabilities = RUNTIME_CAPABILITIES;

const qobuzCacheConnect = createQobuzConnectSource({
  metaUrl: String(
    process.env.QOBUZ_META_URL
      || `${String(MOODE_BASE_URL || '').replace(/\/+$/, '')}/command/renderer.php?cmd=get_qbzmeta`
  ).trim(),
  timeoutMs: process.env.QOBUZ_META_TIMEOUT_MS || qobuzConnectDefaults.metaTimeoutMs,
  staleMs: process.env.QOBUZ_META_STALE_MS || qobuzConnectDefaults.staleMs,
  capabilities: RUNTIME_CAPABILITIES,
});

// PiBuZ is the authoritative read-only source while the receiver owns an
// active Qobuz Connect session. The existing moOde qbzmeta cache remains a
// compatibility fallback only when PiBuZ cannot be reached; an explicit
// inactive PiBuZ session must never be replaced by stale cache data.
const pibuzQobuzReadOnly = createPibuzQobuzAdapter({
  host: process.env.PIBUZ_HOST || MOODE_SSH_HOST,
  port: process.env.PIBUZ_PORT || 8182,
  timeoutMs: process.env.PIBUZ_TIMEOUT_MS || pibuzQobuzDefaults.timeoutMs,
  staleMs: process.env.PIBUZ_STALE_MS || pibuzQobuzDefaults.staleMs,
  capabilities: RUNTIME_CAPABILITIES,
});

const pibuzQobuz = createPibuzQobuzControlAdapter({
  adapter: pibuzQobuzReadOnly,
  capabilities: RUNTIME_CAPABILITIES,
  timeoutMs: process.env.PIBUZ_CONTROL_TIMEOUT_MS || 1200,
  verifyMs: process.env.PIBUZ_CONTROL_VERIFY_MS || 4000,
  pollMs: process.env.PIBUZ_CONTROL_POLL_MS || 150,
});

const savedQobuzQueueStore = createSavedQobuzQueueStore({
  directory: RUNTIME_STATE_PATHS.savedQobuzQueueDir,
});
const savedQobuzQueueService = createNamedQobuzQueueService({
  store: savedQobuzQueueStore,
  getQobuzSnapshot: (options) => pibuzQobuz.getSnapshot(options),
});
const savedQobuzBridge = createLocalPibuzBridgeClient({
  capabilities: RUNTIME_CAPABILITIES,
});
const savedQobuzQueuePlayService = createSavedQueuePlayService({
  savedQueueStore: savedQobuzQueueStore,
  adapter: savedQobuzBridge,
  getFreshQobuzOwnership: async () => {
    const ownership = await savedQobuzBridge.getOwnership();
    if (!ownership?.active) return { active: false };
    return {
      active: true,
      ownershipState: 'confirmed-active',
      receiverActive: true,
      fresh: true,
      sessionUuid: ownership.session_uuid,
      queueVersion: ownership.queue_version,
    };
  },
});

const qobuzConnect = {
  async get() {
    const native = await pibuzQobuz.getNowPlaying();
    if (native?.authoritative) return native;
    return qobuzCacheConnect.get();
  },
  getQueue: () => pibuzQobuz.getQueue(),
  getSnapshot: (options) => pibuzQobuz.getSnapshot(options),
  fetchArtwork: (ref) => pibuzQobuz.fetchArtwork(ref),
  getEventState: () => pibuzQobuz.getEventState(),
};

// The event stream is a bounded, read-only cache invalidation/observability
// channel. Normal API reads still fetch the current PiBuZ snapshot, so an SSE
// outage cannot make playback state appear fresher than it is.
if (!RUNTIME_CAPABILITIES.rehearsal) pibuzQobuz.startEvents();

let pibuzShutdownPromise = null;
async function stopPibuzEventsForShutdown(signal) {
  if (pibuzShutdownPromise) return pibuzShutdownPromise;
  pibuzShutdownPromise = (async () => {
    try {
      await pibuzQobuz.stopEvents();
    } catch (error) {
      log.debug('[pibuz-qobuz] shutdown cleanup failed', {
        signal,
        error: error?.message || String(error),
      });
    }
  })();
  return pibuzShutdownPromise;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stopPibuzEventsForShutdown(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

const qobuzConnectController = createQobuzConnectController({
  sshUser: MOODE_SSH_USER,
  sshHost: MOODE_SSH_HOST,
  runCommand: execFileP,
  capabilities: RUNTIME_CAPABILITIES,
});

// UPnP discovery/browsing and the separately gated single-track session layer.
// The session layer still stops before live playback unless its authenticated
// mutation routes are explicitly used after an operator preflight approval.
const upnpControlPoint = new UpnpControlPoint({
  capabilities: RUNTIME_CAPABILITIES,
});
let upnpPlaybackSession = null;
let upnpPlaybackQueue = null;

const appleMusicTokenProvider = APPLE_MUSIC_KEY_ID && APPLE_MUSIC_TEAM_ID && APPLE_MUSIC_PRIVATE_KEY_PATH
  ? createAppleMusicTokenProvider({
    keyId: APPLE_MUSIC_KEY_ID,
    teamId: APPLE_MUSIC_TEAM_ID,
    privateKeyPath: APPLE_MUSIC_PRIVATE_KEY_PATH,
  })
  : null;

const appleCatalogSearchService = createAppleCatalogSearchService({
  // Use the same protected Media Services authority as About enrichment. A
  // static developer token remains only as a development fallback.
  developerToken: appleMusicTokenProvider ? '' : APPLE_MUSIC_DEVELOPER_TOKEN,
  tokenProvider: appleMusicTokenProvider ? () => appleMusicTokenProvider.getToken() : null,
  storefront: APPLE_MUSIC_COUNTRY,
  timeoutMs: APPLE_MUSIC_TIMEOUT_MS,
  fetchImpl: fetch,
});

const appleAboutService = createAppleAboutService({
  // A protected Media Services key is the production authority. The legacy
  // pasted token remains a fallback only when automatic credentials are not
  // configured (useful for development/testing).
  developerToken: appleMusicTokenProvider ? '' : APPLE_MUSIC_DEVELOPER_TOKEN,
  tokenProvider: appleMusicTokenProvider ? () => appleMusicTokenProvider.getToken() : null,
  storefront: APPLE_MUSIC_COUNTRY,
  timeoutMs: APPLE_MUSIC_TIMEOUT_MS,
});

const appleMusicAboutConfigured = Boolean(appleMusicTokenProvider || APPLE_MUSIC_DEVELOPER_TOKEN);
const aboutResolver = createAboutResolver({
  providers: [{
    name: 'apple',
    configured: appleMusicAboutConfigured,
    getAbout: (input) => appleAboutService.getAbout(input),
  }],
});

const millsHarmonyClient = new HarmonyHubClient({
  host: HARMONY_HOST,
  port: HARMONY_PORT,
  domain: HARMONY_DOMAIN,
  hubId: HARMONY_HUB_ID,
  capabilities: RUNTIME_CAPABILITIES,
});

const nonMpdScrobbler = createLastfmScrobbler({
  apiKey: LASTFM_API_KEY,
  apiSecret: LASTFM_API_SECRET,
  sessionKey: LASTFM_SESSION_KEY,
  log,
  capabilities: RUNTIME_CAPABILITIES,
});
const listeningHistory = createListeningHistoryStore({
  log,
  onQualified: async (event, { updateEvent }) => {
    if (event.source === 'mpd' && LASTFM_MPD_MODE === 'shadow') {
      await updateEvent(event.sessionId, {
        lastfmEligible: true,
        lastfmScrobbleState: 'mpd-shadow-qualified',
        lastfmScrobbleError: '',
      });
      return;
    }
    await updateEvent(event.sessionId, { lastfmScrobbleState: 'submitting' });
    const result = await nonMpdScrobbler.submit(event);
    await updateEvent(event.sessionId, {
      lastfmScrobbleState: result.state,
      lastfmScrobbleError: result.error || '',
    });
  },
});

const mobilePushTokenStore = createMobilePushTokenStore({
  filePath: MOBILE_PUSH_TOKENS_PATH,
});
const mobileVideoCatalog = createMobileVideoCatalog({
  root: MOBILE_VIDEO_ROOT,
  registryPath: MOBILE_VIDEO_CATALOG_PATH,
});
const apnsProvider = createApnsProvider({
  keyId: APNS_KEY_ID,
  teamId: APNS_TEAM_ID,
  privateKeyPath: APNS_PRIVATE_KEY_PATH,
  privateKey: APNS_PRIVATE_KEY,
  topic: APNS_TOPIC,
  environment: APNS_ENVIRONMENT,
  capabilities: RUNTIME_CAPABILITIES,
});

log.info('[apns] provider initialized', {
  configured: apnsProvider.isConfigured(),
  topic: APNS_TOPIC,
  environment: APNS_ENVIRONMENT,
  trackNotificationsEnabled: TRACK_NOTIFY_ENABLED,
  tokenStoreConfigured: Boolean(MOBILE_PUSH_TOKENS_PATH),
});

const HARMONY_SOURCE_RETRY_DELAY_MS = 900;

async function switchDenonInput(input) {
  const command = input === 'phono' ? HARMONY_INPUT_PHONO : HARMONY_INPUT_AUX1;
  let firstResult;
  let firstError;

  try {
    firstResult = await sendHarmonyIrCommand(millsHarmonyClient, HARMONY_DENON_DEVICE_ID, command);
  } catch (error) {
    firstError = error;
  }

  await new Promise((resolve) => setTimeout(resolve, HARMONY_SOURCE_RETRY_DELAY_MS));

  try {
    // Harmony accepts the IR command without confirming Denon received it.
    // Repeat once after the receiver has had time to process the first send.
    return await sendHarmonyIrCommand(millsHarmonyClient, HARMONY_DENON_DEVICE_ID, command);
  } catch (secondError) {
    if (firstResult) return firstResult;
    throw secondError || firstError;
  }
}

async function downloadLatestForRss({ rss, count = 10 }) {
  const items = readSubs();
  const sub = items.find(it => normUrl(it?.rss) === normUrl(rss));
  if (!sub) throw new Error("Subscription not found");

  await fsp.mkdir(sub.dir, { recursive: true });

  const feed = await fetchPodcastRSS(rss, Math.max(1, count));
  const episodes = Array.isArray(feed?.items) ? feed.items.slice(0, count) : [];

  function shortId(s) {
    const txt = String(s || "").trim();
    if (!txt) return "";
    return crypto.createHash("sha1").update(txt).digest("hex").slice(0, 12);
  }

  function pickDate(item) {
    return (
      item?.isoDate ||
      item?.pubDate ||
      item?.published ||
      item?.date ||
      item?.datePublished ||
      ""
    );
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  const localItems = []; // ✅ add this

  for (const item of episodes) {
    const enc = String(item?.enclosure || "").trim();
    if (!enc) continue;

    let ext = ".mp3";
    try {
      const u = new URL(enc);
      const base = path.basename(u.pathname) || "";
      const m = base.toLowerCase().match(/\.(mp3|m4a|aac|mp4)$/);
      if (m) ext = `.${m[1]}`;
    } catch {}

    const guidRaw = String(item?.guid || "").trim();
    const id = shortId(guidRaw || enc) || "episode";

    let filename = `${id}${ext}`;
    filename = safeFileName(filename, `episode${ext}`);

    const outPath = path.join(sub.dir, filename);

    // ✅ capture metadata now (even if already exists)
    const meta = {
      filename,
      enclosureUrl: enc,                        // key candidate
      title: String(item?.title || "").trim(),
      date: yyyyMmDd(pickDate(item)),           // YYYY-MM-DD
      published: (() => {
        const d = new Date(pickDate(item));
        return Number.isNaN(d.getTime()) ? 0 : d.getTime();
      })()
    };

    if (fs.existsSync(outPath)) {
      skipped++;
      localItems.push(meta);
      continue;
    }

    try {
      await downloadWithFetch(enc, outPath);

      // tag (your existing code)
      try {
        await tagAudioFileWithFfmpeg(outPath, {
          title: meta.title || id,
          album: String(sub.title || "").trim() || "Podcast",
          artist: String(sub.title || "").trim() || "Podcast",
          date: meta.date || "",
          genre: "Podcast",
          comment: enc,
        });
      } catch {}

      downloaded++;
      localItems.push(meta);
    } catch (e) {
      failed++;
      // don’t add to localItems if it failed (so map reflects reality)
    }
  }

  return {
    ok: failed === 0,
    rss,
    dir: sub.dir,
    downloaded,
    skipped,
    failed,
    attempted: episodes.length,
    localItems // ✅ return it
  };
}




async function buildLocalPlaylistForRss({ rss, newestFirst = true }) {
  void newestFirst;

  const items = readSubs();
  const sub = items.find(it => normUrl(it?.rss) === normUrl(rss));
  if (!sub) throw new Error("Subscription not found after writeSubs()");

  const folder =
    path.basename(String(sub.mpdPrefix || sub.dir || "").trim()) || "podcast";

  const showDir = `/media/SamsungMoode/Podcasts/${folder}`;
  const plName  = folder; // <— no “-local”

  try {
    const { stdout, stderr } = await execFileStrict(
      "bash",
      ["/usr/local/bin/podcast_playlist.sh", showDir, plName]
    );

    console.log("[podcast_playlist] ok", { rss, showDir, plName });
    if ((stdout || "").trim()) console.log("[podcast_playlist] stdout:", stdout.trim());
    if ((stderr || "").trim()) console.log("[podcast_playlist] stderr:", stderr.trim());

    return { showDir, plName };
  } catch (e) {
    console.log("[podcast_playlist] FAIL", { rss, showDir, plName, error: e?.message || String(e) });
    throw e;
  }
}


const FETCH_HEADERS = {
    'user-agent': 'Mozilla/5.0',
    'accept': '*/*',
};

let lastArtKeyBuilt = '';

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

function artKeyToSafeId(key) {
  // stable, short, filename-safe id
  return crypto.createHash('sha1').update(String(key || ''), 'utf8').digest('hex').slice(0, 20);
}

function artPath640ForKey(key) {
  return path.join(ART_CACHE_DIR, `${artKeyToSafeId(key)}_640.jpg`);
}

function artPathBgForKey(key) {
  return path.join(ART_CACHE_DIR, `${artKeyToSafeId(key)}_bg_640_blur.jpg`);
}

// --- Private stream metadata integration loader (optional/local-only) ---

const motherEarth = {
  enabled: false,
  matchStation: () => null,
  fetchMeta: async () => null,
};

try {
  const mod = await import('./src/private/mother-earth.local.mjs');
  if (typeof mod.matchStation === 'function') motherEarth.matchStation = mod.matchStation;
  if (typeof mod.fetchMeta === 'function') motherEarth.fetchMeta = mod.fetchMeta;
  motherEarth.enabled = true;
  log.info?.('[private-meta] local integration loaded');
} catch {
  // intentionally optional; public builds should run without private integration
}

function matchMotherEarthStation(currentFile) {
  return motherEarth.matchStation(currentFile);
}

async function fetchMotherEarthMeta(entry) {
  return motherEarth.fetchMeta(entry, { agentForUrl, fetch });
}

/* =========================
 * Express
 * ========================= */

const app = express();
const RELEASE_IDENTITY = resolveRuntimeReleaseIdentity();
const PUBLIC_WEB_ROOT = resolveRuntimePublicWebRoot();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(handleMobileJsonError);
app.use(rehearsalReadOnlyMiddleware({ capabilities: RUNTIME_CAPABILITIES }));
// Immutable releases set SONUVI_PUBLIC_WEB_ROOT to the generated H2 public
// root. Legacy checkouts retain their historical root until they opt in.
app.use(express.static(PUBLIC_WEB_ROOT, { dotfiles: 'deny', index: false }));
app.get('/health', (_req, res) => {
  res.json({ contract: 'sonuvi.health.v1', ok: true, release: publicRuntimeReleaseIdentity(RELEASE_IDENTITY) });
});
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_WEB_ROOT, 'controller.html'));
});

// PeppyMeter bridge (HTTP level data -> app API)
let peppyMeterLast = { left: 0, right: 0, mono: 0, spectrum: [], ts: 0, source: 'init' };
let peppySpectrumLast = { bins: [], size: 0, maxValue: 100, ts: 0, source: 'init' };
app.put('/peppy/vumeter', (req, res) => {
  try {
    const left = Number(req?.body?.left ?? req?.query?.left ?? 0);
    const right = Number(req?.body?.right ?? req?.query?.right ?? 0);
    const mono = Number(req?.body?.mono ?? req?.query?.mono ?? 0);

    let spectrumRaw = req?.body?.spectrum ?? req?.query?.spectrum ?? [];
    if (typeof spectrumRaw === 'string') {
      try { spectrumRaw = JSON.parse(spectrumRaw); } catch { spectrumRaw = []; }
    }

    // Accept common alternate field names from external analyzers/bridges.
    if (!Array.isArray(spectrumRaw)) {
      const b = req?.body || {};
      const q = req?.query || {};
      const pickArray = (obj, key) => {
        const v = obj?.[key];
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') {
          try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch {}
        }
        return null;
      };
      const keys = ['fft', 'bands', 'bins', 'values', 'spectrumBins', 'spectrumData'];
      for (const k of keys) {
        spectrumRaw = pickArray(b, k) || pickArray(q, k) || spectrumRaw;
        if (Array.isArray(spectrumRaw)) break;
      }

      // Some senders provide per-channel arrays: { left:[...], right:[...] }.
      if (!Array.isArray(spectrumRaw) && Array.isArray(b?.left) && Array.isArray(b?.right)) {
        const n = Math.min(b.left.length, b.right.length, 128);
        spectrumRaw = Array.from({ length: n }, (_, i) => (Number(b.left[i] || 0) + Number(b.right[i] || 0)) / 2);
      }

      // Last resort: first numeric-ish array in body with a spectrum-like key name.
      if (!Array.isArray(spectrumRaw)) {
        const ent = Object.entries(b).find(([k, v]) => /fft|spec|band|bin|eq/i.test(String(k)) && Array.isArray(v));
        if (ent) spectrumRaw = ent[1];
      }
    }

    const spectrum = Array.isArray(spectrumRaw)
      ? spectrumRaw.slice(0, 128).map((v) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
        })
      : [];

    peppyMeterLast = {
      left: Number.isFinite(left) ? Math.max(0, Math.min(100, left)) : 0,
      right: Number.isFinite(right) ? Math.max(0, Math.min(100, right)) : 0,
      mono: Number.isFinite(mono) ? Math.max(0, Math.min(100, mono)) : 0,
      spectrum,
      ts: Date.now(),
      source: req?.ip || 'unknown',
    };
    return res.json({ ok: true });
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }
});

app.get('/peppy/vumeter', (_req, res) => {
  const now = Date.now();
  const ageMs = Math.max(0, now - Number(peppyMeterLast?.ts || 0));
  return res.json({ ok: true, meter: peppyMeterLast, ageMs, fresh: ageMs < 4000 });
});

// PeppySpectrum bridge (bins -> app API)
app.put('/peppy/spectrum', (req, res) => {
  try {
    let binsRaw = req?.body?.bins ?? req?.body?.spectrum ?? req?.query?.bins ?? req?.query?.spectrum ?? [];
    if (typeof binsRaw === 'string') {
      try { binsRaw = JSON.parse(binsRaw); } catch { binsRaw = []; }
    }
    if (!Array.isArray(binsRaw)) binsRaw = [];

    const maxValueRaw = Number(req?.body?.maxValue ?? req?.query?.maxValue ?? req?.body?.max ?? req?.query?.max ?? 100);
    const maxValue = Number.isFinite(maxValueRaw) && maxValueRaw > 0 ? maxValueRaw : 100;

    const bins = binsRaw.slice(0, 256).map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(maxValue, n)) : 0;
    });

    peppySpectrumLast = {
      bins,
      size: Number(req?.body?.size ?? req?.query?.size ?? bins.length ?? 0),
      maxValue,
      ts: Date.now(),
      source: req?.ip || 'unknown',
    };
    return res.json({ ok: true, size: bins.length });
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }
});

app.get('/peppy/spectrum', (_req, res) => {
  const now = Date.now();
  const ageMs = Math.max(0, now - Number(peppySpectrumLast?.ts || 0));
  return res.json({ ok: true, spectrum: peppySpectrumLast, ageMs, fresh: ageMs < 3000 });
});

/* =========================
 * Agents: LAN-bound vs default
 * ========================= */

const lanHttpAgent = new http.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const lanHttpsAgent = new https.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const defaultHttpAgent = new http.Agent({ keepAlive: true });
const defaultHttpsAgent = new https.Agent({ keepAlive: true });

function agentForUrl(url) {
  const s = String(url || '');
  const isLan =
    s.startsWith(MOODE_BASE_URL) ||
    s.startsWith('http://10.') ||
    s.startsWith('http://192.168.') ||
    s.startsWith('http://172.16.');

  const isHttps = s.startsWith('https:');
  if (isLan) return isHttps ? lanHttpsAgent : lanHttpAgent;
  return isHttps ? defaultHttpsAgent : defaultHttpAgent;
}

/* =========================
 * Podcasts
 * ========================= */



const PODCAST_MAP_DIR = RUNTIME_STATE_PATHS.podcastMapDir;

let _podcastCache = { loadedAt: 0, maps: [] };
const PODCAST_CACHE_MS = 60_000; // refresh once a minute
let youtubeNowPlayingHint = { setAt: 0, streamUrl: '', title: '', channel: '', thumbnail: '', webpageUrl: '' };
const youtubeQueueHints = new Map();
const youtubeProxyHints = new Map();
const youtubeProxyWorkers = new Map(); // id -> { ytdlp, ff, startedAt }
const YT_PROXY_MAX_WORKERS = 2;
const YOUTUBE_HINTS_PATH = RUNTIME_STATE_PATHS.youtubeHintsPath;
function youtubeStreamKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const mProxy = s.match(/\/youtube\/proxy\/([a-f0-9]{10,})/i);
  if (mProxy && mProxy[1]) return String(mProxy[1]).trim();
  const m = s.match(/\/id\/([^/]+)/i);
  return String((m && m[1]) || '').trim() || s;
}
function setYoutubeQueueHint(url, meta) {
  const key = youtubeStreamKey(url);
  if (!key) return;
  youtubeQueueHints.set(key, { ...(meta || {}), setAt: Date.now(), streamUrl: String(url || '') });
  if (youtubeQueueHints.size > 300) {
    const first = youtubeQueueHints.keys().next().value;
    if (first) youtubeQueueHints.delete(first);
  }
  scheduleSaveYoutubeHints();
}
function getYoutubeQueueHint(url) {
  const key = youtubeStreamKey(url);
  if (!key) return null;
  return youtubeQueueHints.get(key) || null;
}

function stopYoutubeProxyWorker(id) {
  const w = youtubeProxyWorkers.get(String(id || ''));
  if (!w) return;
  try { w?.ytdlp?.stdout?.unpipe?.(w?.ff?.stdin); } catch {}
  try { w?.ff?.stdout?.unpipe?.(); } catch {}
  try { w?.ytdlp?.kill?.('SIGKILL'); } catch {}
  try { w?.ff?.kill?.('SIGKILL'); } catch {}
  youtubeProxyWorkers.delete(String(id || ''));
}

function pruneYoutubeProxyWorkers() {
  for (const [id, w] of youtubeProxyWorkers.entries()) {
    const dead = !!(w?.ff?.exitCode !== null || w?.ff?.killed || w?.ytdlp?.exitCode !== null || w?.ytdlp?.killed);
    if (dead) youtubeProxyWorkers.delete(id);
  }
  while (youtubeProxyWorkers.size > YT_PROXY_MAX_WORKERS) {
    const oldest = Array.from(youtubeProxyWorkers.entries()).sort((a,b)=>Number(a?.[1]?.startedAt||0)-Number(b?.[1]?.startedAt||0))[0];
    if (!oldest) break;
    stopYoutubeProxyWorker(oldest[0]);
  }
}

async function loadYoutubeHintsFromDisk() {
  try {
    const raw = await fsp.readFile(YOUTUBE_HINTS_PATH, 'utf8');
    const arr = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(arr)) return;
    youtubeQueueHints.clear();
    for (const it of arr) {
      const streamUrl = String(it?.streamUrl || '').trim();
      const key = youtubeStreamKey(streamUrl);
      if (!key) continue;
      youtubeQueueHints.set(key, {
        setAt: Number(it?.setAt || 0) || Date.now(),
        streamUrl,
        title: String(it?.title || '').trim(),
        channel: String(it?.channel || '').trim(),
        thumbnail: String(it?.thumbnail || '').trim(),
        webpageUrl: String(it?.webpageUrl || '').trim(),
      });
    }
  } catch {}
}

let youtubeHintsSaveTimer = null;
function scheduleSaveYoutubeHints() {
  if (mainRuntimeCapabilities?.rehearsal) return;
  try { if (youtubeHintsSaveTimer) clearTimeout(youtubeHintsSaveTimer); } catch {}
  youtubeHintsSaveTimer = setTimeout(async () => {
    youtubeHintsSaveTimer = null;
    try {
      const items = Array.from(youtubeQueueHints.values())
        .sort((a, b) => Number(b?.setAt || 0) - Number(a?.setAt || 0))
        .slice(0, 500);
      await fsp.mkdir(path.dirname(YOUTUBE_HINTS_PATH), { recursive: true });
      await fsp.writeFile(YOUTUBE_HINTS_PATH, JSON.stringify(items, null, 2));
    } catch {}
  }, 250);
}

loadYoutubeHintsFromDisk().catch(() => {});
if (!RUNTIME_CAPABILITIES.rehearsal) {
  setInterval(() => { try { pruneYoutubeProxyWorkers(); } catch {} }, 15000);
}

async function loadPodcastMaps() {
  const now = Date.now();
  if (now - _podcastCache.loadedAt < PODCAST_CACHE_MS) return _podcastCache.maps;

  const maps = [];
  try {
    const files = await fsp.readdir(PODCAST_MAP_DIR);

    for (const f of files) {
      if (!f.toLowerCase().endsWith(".json")) continue;

      const full = path.join(PODCAST_MAP_DIR, f);
      try {
        const raw = await fsp.readFile(full, "utf8");
        const parsed = JSON.parse(raw);

        // Only accept our lookup-map shape
        if (parsed && typeof parsed === "object" && parsed.itemsByUrl && typeof parsed.itemsByUrl === "object") {
          maps.push(parsed);
        }
      } catch {
        // ignore bad json
      }
    }
  } catch {
    // ignore missing dir, etc
  }

  _podcastCache = { loadedAt: now, maps };
  return maps;
}

function looksUnknownArtist(a) {
  if (!a) return true;
  const s = String(a).trim().toLowerCase();
  return s === "" || s === "unknown" || s === "unknown artist";
}

async function enrichPodcastNowPlaying(payload) {
    try {
        if (!payload || typeof payload !== 'object') return payload;

        const fileRaw = String(payload.file || '').trim();
        if (!fileRaw) return payload;

        // Only touch when artist is missing/unknown
        const artistIsMissing =
            !String(payload.artist || '').trim() || looksUnknownArtist(payload.artist);
        if (!artistIsMissing) return payload;

        const maps = await loadPodcastMaps();
        if (!Array.isArray(maps) || maps.length === 0) return payload;

        const isHttp = /^https?:\/\//i.test(fileRaw);

        // Build candidate keys
        const keys = [];

        if (isHttp) {
            const rawNoQ = fileRaw.split(/[?#]/)[0];
            const canon = canonicalizePodcastUrl(fileRaw);
            const canonNoQ = String(canon || '').split(/[?#]/)[0];

            keys.push(fileRaw, rawNoQ, canon, canonNoQ);

            const id = extractMegaphoneId(canonNoQ) || extractMegaphoneId(rawNoQ);
            if (id) keys.push(`id:${id}`);
        } else {
            // Local file path: match via id:<NPR...>
            const id = extractNprId(fileRaw) || extractMegaphoneId(fileRaw);
            if (id) keys.push(`id:${id}`);
        }

        for (const m of maps) {
            const itemsByUrl = m?.itemsByUrl;
            if (!itemsByUrl || typeof itemsByUrl !== 'object') continue;

            let hit = null;
            for (const k of keys) {
                if (!k) continue;
                hit = itemsByUrl[k];
                if (hit) break;
            }
            if (!hit) continue;

            const showTitle = String(
                hit.podcastTitle ||
                hit.showTitle ||
                hit.show ||
                hit.artist ||
                hit.album ||
                ''
            ).trim();

            const episodeTitle = String(hit.title || '').trim();
            const albumFromFeed = String(hit.album || '').trim();

            const publishedTs = hit.startDate ?? hit.published ?? hit.pubDate ?? null;
            const prettyDate = formatPodcastDate(publishedTs);

            if (showTitle) payload.artist = showTitle;
            if (episodeTitle) payload.title = episodeTitle;
            payload.album = albumFromFeed || prettyDate || payload.album || '';

            const img = String(hit.imageUrl || hit.image || '').trim();
            if (img) payload.albumArtUrl = img;

            payload.podcast = true;
            payload.isPodcast = true;
            payload.published = publishedTs;
            payload.episodeId = hit.episodeId ?? hit.guid ?? null;

            // For local files, playbackUrl can stay as fileRaw; for http prefer canon
            payload.playbackUrl = isHttp ? (canonicalizePodcastUrl(fileRaw) || fileRaw) : fileRaw;

            return payload;
        }

        return payload;
    } catch (e) {
        log.debug('[podcast] enrich failed', e?.message || String(e));
        return payload;
    }
}

/* =========================
 * UPnP Identify helpers
 * ========================= */

async function safeUnlink(p) {
  try { await fsp.unlink(p); } catch {}
}

async function downloadToFile(url, outPath, {
  retries = 3,
  timeoutMs = 120000,
  preferCurl = false,      // set true if you want to always use curl
  curlFallback = true,     // set false if you don't want curl fallback
  ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
} = {}) {
  const srcUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(srcUrl)) throw new Error(`downloadToFile: invalid url: ${srcUrl}`);
  if (!outPath) throw new Error(`downloadToFile: invalid outPath`);

  await ensureDir(path.dirname(outPath));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function unlinkQuiet(p) { try { await fsp.unlink(p); } catch {} }

  async function curlDownload(u) {
    const maxTimeSec = Math.max(10, Math.ceil(timeoutMs / 1000));
    // -f fail on HTTP errors, -L follow redirects, -sS quiet but show errors, --compressed ok
    const args = [
      '-fLsS', '-L',
      '--max-time', String(maxTimeSec),
      '-A', ua,
      '-H', 'Accept: */*',
      '-o', outPath,
      u,
    ];

    // execFileP already exists in your file
    await execFileP('curl', args, { maxBuffer: 1024 * 1024 });
    const st = await fsp.stat(outPath);
    return { bytes: st.size || 0, finalUrl: null, method: 'curl' };
  }

  async function fetchDownload(u) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(u, {
        redirect: 'follow',
        headers: {
          ...(typeof FETCH_HEADERS === 'object' ? FETCH_HEADERS : {}),
          'User-Agent': ua,
          'Accept': '*/*',
        },
        signal: controller.signal,
      });

      const finalUrl = r.url || u;

      if (!r.ok || !r.body) {
        // Try to capture a tiny bit of body for debugging (often XML AccessDenied)
        let bodySnippet = '';
        try {
          const txt = await r.text();
          bodySnippet = String(txt || '').slice(0, 300);
        } catch {}
        throw new Error(`HTTP ${r.status} finalUrl=${finalUrl} body=${bodySnippet}`);
      }

      // Stream to file
      const ws = fs.createWriteStream(outPath);
      const rs = Readable.fromWeb(r.body); // Node 18+
      await pipeline(rs, ws);

      const st = await fsp.stat(outPath);
      return { bytes: st.size || 0, finalUrl, method: 'fetch' };
    } finally {
      clearTimeout(t);
    }
  }

  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      await unlinkQuiet(outPath);

      const result = preferCurl
        ? await curlDownload(srcUrl)
        : await fetchDownload(srcUrl);

      await logPodcastDownload({
        ts: new Date().toISOString(),
        ok: true,
        url: srcUrl,
        outPath,
        bytes: result.bytes,
        ms: Date.now() - started,
        attempt,
        method: result.method,
        finalUrl: result.finalUrl || '',
      });

      return true;

    } catch (e) {
      lastErr = e;
      await unlinkQuiet(outPath);

      await logPodcastDownload({
        ts: new Date().toISOString(),
        ok: false,
        url: srcUrl,
        outPath,
        err: String(e?.message || e),
        ms: Date.now() - started,
        attempt,
      });

      // If fetch fails with 403/404-ish and curlFallback is enabled, try curl immediately
      const msg = String(e?.message || e);
      const looksLike403or404 = /HTTP\s+(403|404)\b/.test(msg) || /AccessDenied/i.test(msg);

      if (!preferCurl && curlFallback && looksLike403or404) {
        try {
          const r2 = await curlDownload(srcUrl);
          await logPodcastDownload({
            ts: new Date().toISOString(),
            ok: true,
            url: srcUrl,
            outPath,
            bytes: r2.bytes,
            ms: Date.now() - started,
            attempt,
            method: r2.method,
            finalUrl: '',
          });
          return true;
        } catch (e2) {
          lastErr = e2;
          await unlinkQuiet(outPath);
        }
      }

      if (attempt < retries) await sleep(750 * attempt);
    }
  }

  throw lastErr || new Error('download failed');
}

async function ensureDir(p) {
  const s = String(p || '').trim();
  if (!s) throw new Error('ensureDir: empty path');

  const dir = path.extname(s) ? path.dirname(s) : s;
  await fs.promises.mkdir(dir, { recursive: true });
}


async function hasAttachedPic(mp3Path) {
  // returns true if ffprobe finds attached_pic stream
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      mp3Path
    ], { timeout: 10000 });

    const j = JSON.parse(stdout || '{}');
    const streams = Array.isArray(j.streams) ? j.streams : [];
    return streams.some(s => s?.disposition?.attached_pic === 1);
  } catch {
    return false;
  }
}

async function embedArtWithFfmpeg({ mp3In, imgIn, mp3Out, title, show, date }) {
  // date: prefer YYYY-MM-DD; show = podcast name; title = episode title
  const args = [
    "-hide_banner", "-y", "-loglevel", "error",
    "-i", mp3In,
    "-i", imgIn,
    "-map", "0:a",
    "-map", "1:v",
    "-c", "copy",

    // IMPORTANT: do NOT inherit random source tags
    "-map_metadata", "-1",

    // Prefer v4 so TDRC can hold full YYYY-MM-DD.
    "-id3v2_version", "4",

    "-metadata", `title=${title || ""}`,
    "-metadata", `artist=${show || ""}`,
    "-metadata", `album=${show || ""}`,
    "-metadata", `genre=Podcast`,

    // Full date (v2.4). If you keep id3v2_version 3, this often collapses to just the year.
    ...(date ? ["-metadata", `TDRC=${date}`] : []),

    "-metadata:s:v", "title=Cover (front)",
    "-metadata:s:v", "comment=Cover (front)",
    "-disposition:v:0", "attached_pic",

    mp3Out
  ];

  await execFileP(FFMPEG, args, { maxBuffer: 1024 * 1024 * 20 });
}

// atomic replace within same filesystem
async function replaceFileAtomic(src, dest) {
  const dir = path.dirname(dest);
  await ensureDir(dir);

  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}
  
  
// ---- single writer of pod-*.json and pod-*.m3u
// Reads disk -> writes mapJson + outM3u
async function rebuildPodcastLocalIndex(sub, opts = {}) {
    const logp = opts.logp || ((...a) => console.log("[rebuild]", ...a));

    const dir = String(sub?.dir || "").trim();
    const mpdPrefix = String(sub?.mpdPrefix || "").replace(/\/+$/, "");
    const mapJson = String(sub?.mapJson || "").trim();
    const outM3u = String(sub?.outM3u || "").trim();

    if (!dir || !mpdPrefix || !mapJson || !outM3u) {
        throw new Error("rebuildPodcastLocalIndex: sub missing dir/mpdPrefix/mapJson/outM3u");
    }

    const AUDIO_RE = /\.(mp3|m4a|aac|mp4|ogg|flac)$/i;

    // 1) Read disk (SMB-safe: no withFileTypes)
    const localByStem = Object.create(null); // stem -> { filename, mtimeMs, size }
    let names = [];
    try {
        names = await fsp.readdir(dir);
    } catch (e) {
        // Directory missing/unmounted: write empty map/m3u
        names = [];
    }

    for (const name of names) {
        if (!AUDIO_RE.test(name)) continue;

        const stem = String(name).replace(/\.[^.]+$/, "").trim().toLowerCase();
        if (!stem) continue;

        const full = path.join(dir, name);
        try {
            const st = await fsp.stat(full);
            if (!st.isFile()) continue;
            localByStem[stem] = { filename: name, mtimeMs: st.mtimeMs || 0, size: st.size || 0 };
        } catch {}
    }

    const stems = Object.keys(localByStem);
    logp("disk scan", { dir, localCount: stems.length });

    // 2) (Optional) Enrich from RSS so titles/dates are accurate
    // This keeps pod-*.json meaningful, but doesn't affect modal correctness.
    let rssMetaByStem = Object.create(null);

    if (opts.enrichFromRss !== false && sub?.rss) {
        try {
            const scanLimit = Math.max(1, Math.min(500, Number(opts.limit || sub.limit || 200)));
            const feed = await fetchPodcastRSS(sub.rss, scanLimit);
            const feedItems = Array.isArray(feed?.items) ? feed.items : [];

            // cache canonicalization to avoid repeated resolves in one rebuild
            const canonCache = new Map();

            async function stemForFeedItem(ep) {
                const guid = String(ep?.guid || "").trim();
                if (guid) {
                    return crypto.createHash("sha1").update(guid).digest("hex").slice(0, 12).toLowerCase();
                }

                const rawUrl = String(ep?.enclosure || "").trim();
                if (!rawUrl) return "";

                let canonUrl = canonCache.get(rawUrl);
                if (!canonUrl) {
                    let finalUrl = "";
                    try { finalUrl = await resolveFinalUrl(rawUrl); } catch {}
                    canonUrl = stripQueryHash(finalUrl || rawUrl);
                    canonCache.set(rawUrl, canonUrl);
                }

                if (!canonUrl) return "";
                return crypto.createHash("sha1").update(canonUrl).digest("hex").slice(0, 12).toLowerCase();
            }

            for (const ep of feedItems) {
                const stem = await stemForFeedItem(ep);
                if (!stem) continue;

                // only store meta if that stem exists locally (keeps it fast and relevant)
                if (!localByStem[stem]) continue;

                rssMetaByStem[stem] = {
                    title: String(ep?.title || "").trim(),
                    date: yyyyMmDd(ep?.isoDate || ep?.pubDate || ep?.published || ep?.date || ""),
                    published:
                        (typeof ep?.published === "number") ? ep.published :
                        (() => {
                            const d = new Date(ep?.isoDate || ep?.pubDate || ep?.date || "");
                            const t = d.getTime();
                            return Number.isFinite(t) ? t : null;
                        })()
                };
            }

            logp("rss enrich", { rss: sub.rss, matchedLocal: Object.keys(rssMetaByStem).length });
        } catch (e) {
            logp("rss enrich failed (non-fatal)", { error: e?.message || String(e) });
        }
    }

    // 3) Build itemsByUrl + m3u lines (local only)
    const showTitle = String(sub?.title || "Podcast").trim() || "Podcast";
    const imageUrl = String(sub?.imageUrl || "").trim();

    // Order: newest first by RSS published if present, else by mtime
    const ordered = stems
        .map(stem => {
            const local = localByStem[stem];
            const meta = rssMetaByStem[stem] || {};
            return {
                stem,
                filename: local.filename,
                mtimeMs: local.mtimeMs || 0,
                title: meta.title || "",
                date: meta.date || "",
                published: (typeof meta.published === "number") ? meta.published : null
            };
        })
        .sort((a, b) => (b.published || 0) - (a.published || 0) || (b.mtimeMs - a.mtimeMs));

    const itemsByUrl = Object.create(null);
    const lines = [];

    for (const it of ordered) {
        const key = `id:${it.stem}`;
        const mpdFile = `${mpdPrefix}/${it.filename}`;

        itemsByUrl[key] = {
            artist: showTitle,
            album: showTitle,
            title: it.title || "(untitled)",
            date: it.date || "",
            genre: "Podcast",
            imageUrl,
            file: mpdFile,
            filename: it.filename
        };

        lines.push(mpdFile);
    }

    // 4) Write files atomically
    await fsp.mkdir(path.dirname(mapJson), { recursive: true });
    await fsp.writeFile(mapJson, JSON.stringify({ itemsByUrl }, null, 2) + "\n", "utf8");

    await fsp.mkdir(path.dirname(outM3u), { recursive: true });
    await fsp.writeFile(outM3u, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

    return {
        localCount: stems.length,
        mapCount: Object.keys(itemsByUrl).length,
        m3uCount: lines.length
    };
}

function stemFromFilename(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

function yyyyMmDd(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// List locally-downloaded audio files for a subscription.
// Returns: [{ filename, path, size, mtimeMs }]


async function syncSubscriptionInitial({ sub, limit, downloadCount }) {
  // 1) Download N newest (this should be the ONLY place that decides episode art embedding)
  const dl = await downloadLatestForRss({
    rss: sub.rss,
    count: downloadCount
  });

  // 2) SINGLE WRITER (disk -> pod-*.json + pod-*.m3u, with RSS enrich)
  const rebuilt = await rebuildPodcastLocalIndex(sub, {
    enrichFromRss: true,
    limit: Math.max(1, Math.min(500, Number(limit || sub.limit || 200)))
  });

  // 3) Keep moOde playlist in sync
  await buildLocalPlaylistForRss({ rss: sub.rss });

  return {
    downloaded: dl.downloaded,
    skipped: dl.skipped,
    failed: dl.failed,
    mapCount: rebuilt.mapCount,
    m3uCount: rebuilt.m3uCount
  };
}

async function downloadCoverForSub(sub, feed) {
  // IMPORTANT:
  // - Show cover must be show-level ONLY (channel itunes:image / channel image.url)
  // - Never fall back to items[0].image (that’s “latest episode art everywhere”)
  const imgUrl =
    String(feed?.imageUrl || "").trim() ||
    String(feed?.titleImage || "").trim(); // optional future field

  if (!imgUrl) {
    console.log("[podcast_cover] no SHOW image url in feed", { rss: sub.rss, title: sub.title });
    return { ok: false, reason: "no-show-image-url" };
  }

  const outPath = path.join(sub.dir, "cover.jpg");

  try {
    await downloadWithFetch(imgUrl, outPath);
    console.log("[podcast_cover] ok", { imgUrl, outPath });
    return { ok: true, imgUrl, outPath };
  } catch (e) {
    console.log("[podcast_cover] fail", { imgUrl, outPath, error: e?.message || String(e) });
    return { ok: false, imgUrl, outPath, error: e?.message || String(e) };
  }
}

function moodePathFromPi4Mount(p) {
  // Pi4 sees Samba mount as /mnt/..., moOde uses /media/...
  return String(p || '').replace(/^\/mnt\//, '/media/');
}

function shQuote(s) {
  // safe for single-quoted shell strings
  return `'${String(s || '').replace(/'/g, `'\\''`)}'`;
}

async function pushPlaylistCoverToMoode(sub) {
  RUNTIME_CAPABILITIES.assertExternalMutation('ssh.playlist-cover');
  const showTitle = String(sub?.title || 'Podcast').trim() || 'Podcast';

  // Source is the cover you already downloaded into the show folder (on moOde's filesystem)
  const moodeShowDir = moodePathFromPi4Mount(sub.dir);
  const src = path.join(moodeShowDir, 'cover.jpg');

  // Destination is moOde's playlist cover cache
  const dst = `/var/local/www/imagesw/playlist-covers/${safeFileName(showTitle, 'Podcast')}.jpg`;

  // You already have ssh working (you used it manually), so automate it:
  // - copy cover into playlist-covers
  // - fix perms so nginx can serve it
  const cmd =
    `sudo cp -f ${shQuote(src)} ${shQuote(dst)} && ` +
    `sudo chmod 644 ${shQuote(dst)} && ` +
    `sudo chown root:root ${shQuote(dst)} && ` +
    `ls -lah ${shQuote(dst)}`;

  // Reuse whatever SSH helper you already have for Favorites (favoritesSetViaSsh etc).
  // If you DON'T have a generic helper, simplest is execFile('ssh', ...)
  await execFileP('ssh', ['moode@moode.local', cmd]);

  console.log('[podcast_cover] pushed playlist cover', { src, dst });
  return { ok: true, src, dst };
}

async function fetchFollow(url, headers, maxHops = 10) {
  let current = url;

  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetch(current, {
      method: "GET",
      headers,
      redirect: "manual",
    });

    // Follow 3xx ourselves so we can re-send headers each hop
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error(`Redirect ${resp.status} without Location (at hop ${hop})`);
      const next = new URL(loc, current).toString();
      console.log("[podcast_dl] redirect", { hop, status: resp.status, from: current, to: next });
      current = next;
      continue;
    }

    return { resp, finalUrl: current, hop };
  }

  throw new Error(`Too many redirects (>${maxHops})`);
}

async function downloadWithFetch(enclosureUrl, outPath) {
  const headers = {
    // Keep these across hops
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Accept": "*/*",
    // Important: your successful curl used Range
    "Range": "bytes=0-",
  };

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const { resp, finalUrl } = await fetchFollow(enclosureUrl, headers);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.log("[podcast_dl] FAIL", {
      status: resp.status,
      finalUrl,
      body: body.slice(0, 300),
    });
    throw new Error(`HTTP ${resp.status} finalUrl=${finalUrl} body=${body.slice(0, 120)}`);
  }

  // Stream to disk
  const fileHandle = await fs.promises.open(outPath, "w");
  try {
    const nodeStream = Readable.fromWeb(resp.body);
    await pipeline(nodeStream, fileHandle.createWriteStream());
  } finally {
    await fileHandle.close();
  }

  console.log("[podcast_dl] OK", { finalUrl, outPath, status: resp.status });
  return { ok: true, finalUrl, status: resp.status };
}

function dispatcherForUrl(url) {
  const u = new URL(url);
  const proxy =
    (u.protocol === 'https:' ? process.env.HTTPS_PROXY : process.env.HTTP_PROXY) ||
    process.env.ALL_PROXY;

  if (proxy) return new ProxyAgent(proxy);
  return undefined; // no custom dispatcher needed
}

function getArg(flag) {
    const i = process.argv.indexOf(flag);
    if (i === -1) return '';
    const v = process.argv[i + 1];
    return (v && !v.startsWith('--')) ? v : '';
}

function getArgNum(flag, fallback) {
    const v = getArg(flag);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
 
export async function fetchPodcastRSS(url, limit = 10) {
  const xml = await (await fetch(url)).text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml);

  const channel = feed?.rss?.channel;
  if (!channel) return { title: "", imageUrl: "", items: [] };

  const title = String(channel?.title || "").trim();

  const showImageUrl = String(
    channel?.["itunes:image"]?.["@_href"] ||
    channel?.image?.url ||
    ""
  ).trim();

  const rawItems = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
  const n = Math.max(0, Number(limit) || 0);
  const items = rawItems.slice(0, n);

  const mapped = items.map((i) => {
    const enclosure = String(i?.enclosure?.["@_url"] || "").trim();
    const guid = String(i?.guid?.["#text"] || i?.guid || "").trim();

    // Episode-level artwork (preferred for embedding) if present
    const episodeImageUrl = String(i?.["itunes:image"]?.["@_href"] || "").trim();

    // For UI display, fall back to show art if no episode art
    const image = String(
      i?.["itunes:image"]?.["@_href"] ||
      i?.["itunes:image"]?.["#text"] ||
      i?.["media:thumbnail"]?.["@_url"] ||
      i?.["media:content"]?.["@_url"] ||
      showImageUrl ||
      ""
    ).trim();

    let date = null;
    if (i?.pubDate) {
      const d = new Date(i.pubDate);
      if (Number.isFinite(d.getTime())) date = d;
    }

    return {
      podcastTitle: title,
      title: String(i?.title || "").trim(),
      date,
      enclosure,
      guid,
      image,           // display
      episodeImageUrl, // embed preference
    };
  });

  return {
    title,
    imageUrl: showImageUrl,
    items: mapped,
  };
}

function canonicalizePodcastUrl(u) {
  const s0 = String(u || '').trim();
  if (!s0) return '';

  // Strip query/hash early (stable key)
  const s = s0.split(/[?#]/)[0];

  // 1) Already a direct Megaphone URL? Normalize host to traffic.megaphone.fm
  //    Handles:
  //    - https://traffic.megaphone.fm/NPR123.mp3
  //    - https://dcs.megaphone.fm/NPR123.mp3
  //    - .../traffic.megaphone.fm/NPR123.mp3 (wrapped)
  //    - .../dcs.megaphone.fm/NPR123.mp3 (wrapped)
  {
    const m = s.match(/(?:^|\/)(?:traffic|dcs)\.megaphone\.fm\/([^\/]+\.mp3)$/i);
    if (m && m[1]) return `https://traffic.megaphone.fm/${m[1]}`;
  }

  // 2) NPR-style IDs anywhere after megaphone.fm/
  //    (covers odd wrappers where host/path changes but the MP3 ID is still there)
  {
    const m = s.match(/megaphone\.fm\/(NPR[^\/]+\.mp3)$/i);
    if (m && m[1]) return `https://traffic.megaphone.fm/${m[1]}`;
  }

  // 3) Generic: find *any* megaphone mp3 filename at the end of the URL
  //    (keeps working if they ever stop using NPR-prefixed ids)
  {
    const m = s.match(/megaphone\.fm\/([^\/]+\.mp3)$/i);
    if (m && m[1]) return `https://traffic.megaphone.fm/${m[1]}`;
  }

  // Fallback: just the stripped URL
  return s;
}

function prettyDate(d) {
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

// Build + write a JSON sidecar ({ itemsByUrl }) alongside an .m3u playlist
export async function writePodcastUrlMap({ episodes, outM3u }) {
  if (!Array.isArray(episodes)) {
    throw new Error("writePodcastUrlMap: episodes must be an array");
  }

  const m3uPath = String(outM3u || "").trim();
  if (!m3uPath) {
    throw new Error("writePodcastUrlMap: missing outM3u");
  }

  const itemsByUrl = Object.create(null);
  let episodeCount = 0;

  function toValidDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  for (const ep of episodes) {
    const rawUrl = String(ep?.enclosure || "").trim();
    if (!rawUrl) continue;

    const canonUrl = canonicalizePodcastUrl(rawUrl);
    if (!canonUrl) continue;

    episodeCount++;

    const podcastTitle = String(ep?.podcastTitle || "").trim() || "Podcast";
    const publishedDate = toValidDate(ep?.date);

    const item = {
      // ---- CANONICAL PODCAST TAGS (keep stable for moOde + MPD)
      artist: podcastTitle, // show
      album: podcastTitle,  // show
      title: String(ep?.title || "").trim(),
      date: publishedDate ? publishedDate.toISOString().slice(0, 10) : "", // YYYY-MM-DD
      genre: "Podcast",

      // ---- EXTRAS (UI / debugging)
      published: publishedDate ? publishedDate.getTime() : null,
      imageUrl: String(ep?.image || "").trim(),
      guid: String(ep?.guid || "").trim(),
    };

    // Keys that MPD may report as the "current file"
    const keys = new Set();

    // 1) Canonical enclosure URL
    keys.add(canonUrl);

    // 2) Raw URL without query/hash
    const rawNoQ = rawUrl.split(/[?#]/)[0].trim();
    if (rawNoQ) keys.add(rawNoQ);

    // 3) Canonicalized no-query URL
    const canonNoQ = rawNoQ ? canonicalizePodcastUrl(rawNoQ) : "";
    if (canonNoQ) keys.add(canonNoQ);

    // 4) Stable ID key (NPR-style)
    const stableId =
      extractNprId(canonUrl) ||
      extractNprId(rawNoQ) ||
      extractNprId(rawUrl);

    if (stableId) keys.add(`id:${stableId}`);

    // First key wins (preserve earliest mapping for each key)
    for (const k of keys) {
      if (!k) continue;
      if (itemsByUrl[k] === undefined) itemsByUrl[k] = item;
    }
  }

  const outJson = m3uPath.replace(/\.m3u$/i, ".json");
  await fsp.writeFile(outJson, JSON.stringify({ itemsByUrl }, null, 2), "utf8");

  const keyCount = Object.keys(itemsByUrl).length;
  log.info(`[podcast] wrote map -> ${outJson} (episodes=${episodeCount}, keys=${keyCount})`);

  return { outJson, episodeCount, keyCount };
}

/**
 * Art cache directory alias:
 * We keep ART_DIR as your “public-known” name, but internally we can refer to ART_CACHE_DIR
 * without renaming everything.
 */


async function fetchText(url, accept = 'text/plain') {
  const resp = await fetch(url, {
    headers: { Accept: accept },
    agent: agentForUrl(url),
    cache: 'no-store',
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
  return text;
}

async function fetchJson(url) {
  const text = await fetchText(url, 'application/json');
  if (!text.trim()) throw new Error(`Empty JSON body from ${url}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Bad JSON from ${url}: ${e.message}. Body: ${text.slice(0, 200)}`);
  }
}

async function fetchJsonWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'now-playing-next/1.0 (+https://moode.brianwis.com)',
      },
      agent: agentForUrl(url),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
    if (!text.trim()) throw new Error(`Empty JSON body from ${url}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
 * Basic helpers
 * ========================= */
 
function sha1_12(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

function safeMeta(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}


async function tagAudioFileWithFfmpeg(inPath, meta) {
  const dir = path.dirname(inPath);
  const ext = (path.extname(inPath) || ".mp3").toLowerCase();
  const tmp = path.join(dir, `.tmp_tag_${crypto.randomBytes(6).toString("hex")}${ext}`);

  const args = [
    "-y",
    "-i", inPath,
    "-map", "0",
    "-c", "copy",

    // MP3: make ID3 tags readable everywhere
    ...(ext === ".mp3" ? ["-id3v2_version", "3", "-write_id3v1", "1"] : []),

    "-metadata", `title=${safeMeta(meta?.title)}`,
    "-metadata", `album=${safeMeta(meta?.album)}`,
    "-metadata", `artist=${safeMeta(meta?.artist)}`,
    ...(meta?.date ? ["-metadata", `date=${safeMeta(meta.date)}`] : []),
    "-metadata", `genre=${safeMeta(meta?.genre || "Podcast")}`,
    ...(meta?.comment ? ["-metadata", `comment=${safeMeta(meta.comment)}`] : []),

    tmp,
  ];

  await execFileStrict(FFMPEG, args);
  await fsp.rename(tmp, inPath);
}
 
async function writeFileAtomic(destPath, data) {
  const p = String(destPath || '').trim();
  if (!p) throw new Error('writeFileAtomic: empty destPath');

  const dir = path.dirname(p);
  await fs.promises.mkdir(dir, { recursive: true });

  // Unique temp name in same directory (atomic rename on same filesystem)
  const tmp = path.join(
    dir,
    `.${path.basename(p)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  // Write + fsync file to reduce risk of truncated/corrupt outputs
  const fh = await fs.promises.open(tmp, 'w');
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }

  // Atomic replace
  await fs.promises.rename(tmp, p);

  // Best-effort: fsync directory entry (helps on power loss)
  try {
    const dh = await fs.promises.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch {
    // ignore
  }
}
 
function normalizeArtKey(input) {
  const s = String(input || '').trim();
  if (!s) return '';

  // Treat moOde-relative paths as stable keys too
  // Examples:
  //  - /coverart.php/USB/...
  //  - https://npr.brightspotcdn.com/...
  //  - http://moode.local/coverart.php/...
  try {
    // If it's an absolute URL, normalize it (strip trivial differences)
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      // Normalize host casing + remove default ports
      u.host = u.host.toLowerCase();
      if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
        u.port = '';
      }
      // Keep query because some CDNs use it for cache-busting; but you can optionally prune known junk.
      return u.toString();
    }
  } catch {
    // fall through
  }

  // For relative paths (like /coverart.php/...), keep as-is but collapse duplicate slashes
  return s.replace(/\/{2,}/g, '/');
}

// Write an .m3u playlist from episode enclosure URLs
export async function writePodcastM3u({ episodes, outM3u }) {
  if (!Array.isArray(episodes)) throw new Error('writePodcastM3u: episodes must be an array');
  if (!outM3u) throw new Error('writePodcastM3u: missing outM3u');

  await fsp.mkdir(path.dirname(outM3u), { recursive: true });

  const lines = ['#EXTM3U'];
  let n = 0;

  for (const ep of episodes) {
    const url = String(ep?.enclosure || '').trim();
    if (!url) continue;

    const title  = String(ep?.title || '').trim();
    const artist = String(ep?.podcastTitle || 'Podcast').trim();

    // Duration unknown; MPD will fetch the URL directly
    lines.push(`#EXTINF:-1,${artist} - ${title}`);
    lines.push(url);
    n++;
  }

  await fsp.writeFile(outM3u, lines.join('\n') + '\n', 'utf8');
  return { outM3u, count: n };
}
 
function formatPodcastDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}
 
function parseQuotedAttrs(raw) {
  const s = String(raw || '');
  if (!/title\s*=\s*"/i.test(s) && !/artist\s*=\s*"/i.test(s)) return null;

  const out = {};
  // matches: key="value" allowing newlines inside value
  const re = /([A-Za-z0-9_]+)\s*=\s*"([\s\S]*?)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2].replace(/\s+/g, ' ').trim(); // collapse weird whitespace/newlines
    out[k] = v;
  }

  // Only “accept” it if it looks like the iHeart style blob
  if (!out.title && !out.artist) return null;
  return out;
}
 
function parseIheartTitleBlob(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;

    // ✅ iHeart sponsor ads: hard stop
    if (/(^|[\s,])adContext="[^"]+"/i.test(s)) {
        return {
            artist: 'Sponsor Ad',
            title: 'Sponsor Ad',
            artUrl: '',
            raw: s,
            fields: {},
        };
    }

    // 1) Prefix artist: everything before ' - text='
    let artistPrefix = '';
    {
        const m = s.match(/^(.*?)\s*-\s*text="/i);
        if (m && m[1]) artistPrefix = m[1].trim();
    }

    // 2) Extract key="value" pairs (resilient parser for malformed blobs)
    const out = parseQuotedAttrs(s) || {};

    // 3) Fallback: directly capture text="..." / text=\"...\"
    let fallbackText = '';
    {
        const m1 = s.match(/(?:^|\s|,)text\s*=\s*"([^"]+)"/i);
        const m2 = s.match(/(?:^|\s|,)text\s*=\s*\\"([^\\"]+)\\"/i);
        fallbackText = String((m1 && m1[1]) || (m2 && m2[1]) || '').trim();
    }

    const cleanTitle = String(out.text || fallbackText || out.title || '').trim();
    const cleanArtist = String(artistPrefix || out.artist || '').trim();
    const art = String(out.amgartworkurl || out.amgArtworkURL || '').trim();

    return {
        artist: cleanArtist,
        title: cleanTitle,
        artUrl: art,
        raw: s,
        fields: out,
    };
}
 
function splitTitlePerformersProgram(titleLine) {
  const raw = String(titleLine || '').trim();
  if (!raw) return null;

  const normalizeEns = (s) => String(s || '')
    .replace(/\bOrch\b/gi, 'Orchestra')
    .replace(/\bSym\b/gi, 'Symphony')
    .replace(/\bPhil\b/gi, 'Philharmonic')
    .replace(/\bmembers\b/gi, '')
    .replace(/^English Concert$/i, 'The English Concert')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const looksEnsemble = (s) => /orchester|orchestra|ensemble|phil(harm|harmon)|symph|sinfon|choir|chor|quartet|quintet|trio|camerata/i.test(String(s || ''));

  const parsePersonnel = (perfRaw) => {
    const p = String(perfRaw || '').trim();
    if (!p) return [];

    const roleMap = {
      p: 'piano', pf: 'piano', pno: 'piano',
      vn: 'violin', vln: 'violin',
      vc: 'cello',
      va: 'viola', vla: 'viola', vi: 'viola',
      f: 'flute', fl: 'flute',
    };

    if (p.includes('/')) {
      const [lhs = '', rhs = ''] = p.split('/').map((x) => x.trim());
      const out = [];
      if (lhs) out.push(normalizeEns(lhs));
      if (rhs) out.push(`${rhs} (conductor)`);
      return out.filter(Boolean);
    }

    const arr = p.split(/\s*,\s*/).map((x) => normalizeEns(x)).filter(Boolean);

    // Pair "Name, vi, Name, p" into role-tagged personnel
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
      const cur = String(arr[i] || '').trim();
      const next = String(arr[i + 1] || '').trim().toLowerCase();
      if (roleMap[next]) {
        out.push(`${cur} (${roleMap[next]})`);
        i += 1;
        continue;
      }
      out.push(cur);
    }

    if (out.length === 2 && looksEnsemble(out[1]) && !/\((?:conductor|violin|piano|cello|viola|orchestra|ensemble)\)/i.test(out[0])) {
      return [`${out[0]} (conductor)`, `${out[1]}`];
    }
    if (out.length === 1 && looksEnsemble(out[0])) {
      return [`${out[0]}`];
    }
    return out;
  };

  // Case A: spaced-dash pattern (preserve hyphenated names like Ippolitov-Ivanov)
  const parts = raw.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 5) {
    const first = String(parts[0] || '');
    const second = String(parts[1] || '');
    const third = String(parts[2] || '');
    const fourth = String(parts[3] || '');
    const looksComposer = /^[A-Za-zÀ-ÿ'’. -]+$/.test(first) && /\s/.test(first);
    const looksPerfBlock = (s) => {
      const v = String(s || '').trim();
      if (!v) return false;
      const hasPerfWords = /\b(orch|orchestra|sym|symphony|phil|camerata|ensemble|choir|conduct|chailly|maestro)\b/i.test(v);
      // Program/catalog lines often contain ':' and '/' (work lists), which are not performer blocks.
      if (/:/.test(v) && !hasPerfWords) return false;
      return /\//.test(v) || hasPerfWords || /,\s*(p|pf|pno|vn|vln|vc|cello)\b/i.test(v);
    };

    // Pattern A: Composer - Work - Performers - Program - Label
    if (looksPerfBlock(third) && !looksPerfBlock(fourth)) {
      const work = looksComposer ? second : `${first} - ${second}`;
      const personnel = parsePersonnel(third);
      const programParts = parts.slice(3);
      const program = programParts.length > 1
        ? programParts.slice(0, -1).join(' - ')
        : fourth;
      return { composer: looksComposer ? first : '', work, personnel, program };
    }

    // Pattern B: Composer - Work - Movement - Performers - Program
    const work = looksComposer ? `${second} - ${third}` : `${first} - ${second} - ${third}`;
    const personnel = parsePersonnel(fourth);
    const program = String(parts[4] || '');
    return { composer: looksComposer ? first : '', work, personnel, program };
  }
  if (parts.length === 4) {
    // WFMT medium forms:
    //  A) Composer - Work - Performers - Program
    //  B) Work - Performers - Program - Label  (composer may already be in artist field)
    const first = String(parts[0] || '');
    const second = String(parts[1] || '');
    const third = String(parts[2] || '');
    const fourth = String(parts[3] || '');
    const looksComposer = /^[A-Za-zÀ-ÿ'’. -]+$/.test(first) && /\s/.test(first);
    const looksPerfBlock = (s) => {
      const v = String(s || '').trim();
      if (!v) return false;
      const hasPerfWords = /\b(orch|orchestra|sym|symphony|phil|camerata|ensemble|concert|members|conduct)\b/i.test(v);
      if (/:/.test(v) && !hasPerfWords) return false;
      return /\//.test(v) || hasPerfWords || /,\s*(p|pf|pno|vn|vln|vc|cello|va|vla|vi)\b/i.test(v);
    };

    if (!looksComposer && looksPerfBlock(second) && !looksPerfBlock(third)) {
      const work = first;
      const personnel = parsePersonnel(second);
      const program = third;
      return { composer: '', work, personnel, program };
    }

    const work = looksComposer ? second : `${first} - ${second}`;
    const personnel = parsePersonnel(third);
    const program = fourth;
    return { composer: looksComposer ? first : '', work, personnel, program };
  }
  if (parts.length === 3) {
    const work = String(parts[0] || '');
    const personnel = parsePersonnel(parts[1]);
    const program = String(parts[2] || '');
    return { work, personnel, program };
  }

  // Case B (WFMT-ish compact): "work-soloist, p; Orchestra/Conductor"
  const m = raw.match(/^(.*?)\s*-\s*(.*?)\s*;\s*([^\/;]+?)(?:\s*\/\s*([^;]+))?\s*$/);
  if (m) {
    const work = String(m[1] || '').trim();
    const soloistRaw = String(m[2] || '').trim();
    const orchRaw = String(m[3] || '').trim();
    const condRaw = String(m[4] || '').trim();

    const personnel = [];
    if (soloistRaw) {
      const solo = soloistRaw
        .replace(/,\s*p\b/i, ' (piano)')
        .replace(/,\s*pf\b/i, ' (piano)')
        .replace(/,\s*vn\b/i, ' (violin)')
        .replace(/,\s*vc\b/i, ' (cello)')
        .trim();
      personnel.push(solo);
    }
    if (orchRaw) personnel.push(normalizeEns(orchRaw));
    if (condRaw) personnel.push(`${condRaw} (conductor)`);

    return { composer: '', work, personnel, program: '' };
  }

  // Case C: "work-Orchestra/Soloist, v" (no semicolon)
  const m2 = raw.match(/^(.*?)\s*-\s*([^\/;]+?)\s*\/\s*([^,;]+?)\s*,\s*(p|pf|pno|vn|vln|vc|cello)\b/i);
  if (m2) {
    const work = String(m2[1] || '').trim();
    const orchRaw = String(m2[2] || '').trim();
    const soloist = String(m2[3] || '').trim();
    const abbr = String(m2[4] || '').toLowerCase();
    const role = (abbr === 'p' || abbr === 'pf' || abbr === 'pno') ? 'piano'
      : ((abbr === 'vn' || abbr === 'vln') ? 'violin'
      : ((abbr === 'vc' || abbr === 'cello') ? 'cello' : abbr));

    const personnel = [];
    if (orchRaw) personnel.push(`${normalizeEns(orchRaw)}`);
    if (soloist) personnel.push(`${soloist} (${role})`);
    return { composer: '', work, personnel, program: '' };
  }

  // Case D: "work - Ensemble/Conductor Label" (label appended, no extra dash)
  const m3 = raw.match(/^(.*?)\s*-\s*([^\/;]+?)\s*\/\s*([A-Za-zÀ-ÿ'’.\- ]+?)(?:\s+(Archiv|Decca|Erato|EMI|DG|DGG|Laserlight|Naxos|Philips))?\s*$/i);
  if (m3) {
    const work = String(m3[1] || '').trim();
    const ensRaw = String(m3[2] || '').trim();
    const condRaw = String(m3[3] || '').trim();
    const personnel = [];
    if (ensRaw) personnel.push(`${normalizeEns(ensRaw)}`);
    if (condRaw) personnel.push(`${condRaw} (conductor)`);
    return { composer: '', work, personnel, program: '' };
  }

  return null;
}

// Davide of MIMIC publishes classical metadata as:
// Composer - Work - Movement - Movement - Soloist, Conductor, Ensemble - Program
// The generic parser assumes the third/fourth segment is the performer block,
// so it mistakes a movement such as "Allegro" for personnel. Keep this
// station-specific shape isolated while preserving the generic/WFMT parser.
function splitDavideMimicTitlePerformersProgram(titleLine) {
  const raw = String(titleLine || '').trim();
  if (!raw) return null;

  const parts = raw.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 5) return null;

  const normalize = (s) => String(s || '').replace(/\s{2,}/g, ' ').trim();
  const looksEnsemble = (s) => /orchester|orchestra|symphonie|symphony|philharmonic|ensemble|sinfon|choir|chor|camerata/i.test(String(s || ''));
  const performerIndex = parts.findIndex((part, index) => index >= 2 && looksEnsemble(part));
  if (performerIndex < 0) return null;

  const composer = normalize(parts[0]);
  const work = parts.slice(1, performerIndex).map(normalize).filter(Boolean).join(' - ');
  const performerParts = parts[performerIndex].split(/\s*,\s*/).map(normalize).filter(Boolean);
  if (!composer || !work || !performerParts.length) return null;

  const ensembleIndex = performerParts.findIndex(looksEnsemble);
  const personnel = performerParts.map((person, index) => {
    // MIMIC's concerto form places the conductor immediately before the
    // orchestra after the soloist: Soloist, Conductor, Orchestra.
    if (ensembleIndex >= 2 && index === ensembleIndex - 1) return `${person} (conductor)`;
    if (performerParts.length === 2 && ensembleIndex === 1 && index === 0) return `${person} (conductor)`;
    return person;
  });
  const program = parts.slice(performerIndex + 1).map(normalize).filter(Boolean).join(' - ');

  return { composer, work, personnel, program };
}

// Brian-confirmed Apple album for the MIMIC Prokofiev Piano Concerto No. 2
// broadcast. The stream's credited performers differ from Apple's release
// metadata, so this must remain an explicit, work-scoped curation rather than
// weakening classical performer validation globally.
function curatedRadioAppleAlbum(profile, composer, title) {
  const p = String(profile || '').trim();
  const c = String(composer || '').trim();
  const t = String(title || '').trim();
  if (p !== 'davide-mimic') return null;
  if (!/\bprokofiev\b/i.test(c)) return null;
  if (!/\bpiano\s+concerto\s+no\.?\s*2\b/i.test(t)) return null;
  if (!/\bop\.?\s*16\b/i.test(t)) return null;
  return { collectionId: '1452523035' };
}

function clampRating(v) {
  // Accept number or numeric string; return integer 0..5, or null if invalid
  if (v === null || v === undefined) return null;

  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  const i = Math.round(n); // or Math.trunc(n) if you prefer
  if (i < 0 || i > 5) return null;
  return i;
}

function isStreamPath(file) {
  return !!file && file.includes('://');
}

function isAirplayFile(file) {
  return String(file || '').toLowerCase() === 'airplay active';
}

function isUpnpMediaItemUrl(file) {
  const f = String(file || '');
  return f.includes(':8200/MediaItems/');
}

function getStreamKind(file) {
  if (!isStreamPath(file)) return '';
  if (isUpnpMediaItemUrl(file)) return 'upnp';
  return 'radio';
}

function moodeValByKey(raw, keyOrIndex) {
  if (!raw) return '';

  if (typeof keyOrIndex === 'number') {
    const s = raw?.[String(keyOrIndex)];
    if (typeof s !== 'string') return '';
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  const direct = raw?.[String(keyOrIndex).toLowerCase().trim()];
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct).trim();

  const want = String(keyOrIndex).toLowerCase().trim() + ':';
  for (const v of Object.values(raw)) {
    if (typeof v !== 'string') continue;
    const line = v.trim();
    if (line.toLowerCase().startsWith(want)) {
      const i = line.indexOf(':');
      return i >= 0 ? line.slice(i + 1).trim() : line.trim();
    }
  }
  return '';
}

async function fetchCurrentSong() {
  const raw = await mpdQueryRaw('currentsong');
  if (!raw || mpdHasACK(raw)) throw new Error('mpd currentsong failed');

  const song = parseMpdFirstBlock(raw);
  if (!String(song?.file || '').trim()) throw new Error('mpd currentsong returned no file');
  if (!isAirplayCurrentSong(song)) {
    const moodeAirplaySong = await fetchMoodeAirplaySong();
    if (moodeAirplaySong) return mergeMoodeAirplaySong(song, moodeAirplaySong);
  }
  return song;
}

async function fetchMoodeAirplaySong() {
  try {
    const song = await fetchJsonWithTimeout(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`, 1500);
    return isAirplayCurrentSong(song) ? song : null;
  } catch {
    return null;
  }
}

async function fetchCurrentStatus() {
  const raw = await mpdQueryRaw('status');
  if (!raw || mpdHasACK(raw)) throw new Error('mpd status failed');
  return parseMpdKeyVals(raw);
}

function normalizeMoodeStatus(raw) {
  const state = moodeValByKey(raw, 'state');
  const timeStr = moodeValByKey(raw, 'time');
  const elapsedStr = moodeValByKey(raw, 'elapsed');
  const durationStr = moodeValByKey(raw, 'duration');

  let elapsed = 0;
  let duration = 0;

  if (timeStr && String(timeStr).includes(':')) {
    const parts = String(timeStr).trim().split(':').map(s => s.trim());
    if (parts.length >= 2) {
      const e = Number.parseFloat(parts[0]);
      const d = Number.parseFloat(parts[1]);
      if (Number.isFinite(e)) elapsed = e;
      if (Number.isFinite(d)) duration = d;
    }
  }

  if (!(duration > 0)) {
    const e2 = Number.parseFloat(elapsedStr);
    const d2 = Number.parseFloat(durationStr);
    if (Number.isFinite(e2)) elapsed = e2;
    if (Number.isFinite(d2)) duration = d2;
  }

  const percent = duration > 0 ? Math.round((elapsed / duration) * 100) : 0;
  return { state, elapsed, duration, percent, time: timeStr };
}

function normalizeCoverUrl(coverurl, baseUrl = MOODE_BASE_URL) {
  const s = String(coverurl || '').trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s)) return s;

  // Fix accidental "http://host/http://host/..." duplication
  const m = s.match(/^(https?:\/\/[^/]+)\/(https?:\/\/.+)$/i);
  if (m) return m[2];

  const prefix = s.startsWith('/') ? '' : '/';
  return `${baseUrl}${prefix}${s}`;
}

function extractYear(str) {
  const m = String(str || '').match(/\b(\d{4})\b/);
  return m ? m[1] : '';
}

function requireTrackKey(req, res) {
  if (!hasConfiguredTrackKey(TRACK_KEY)) {
    // Do not silently run an immutable release with its privileged endpoints
    // unauthenticated. Legacy checkouts retain their historical open behavior
    // only until an operator migrates them to the release model.
    if (RELEASE_IDENTITY.mode !== 'immutable-release') return true;
    res.status(503).send('Operator authentication is unavailable');
    return false;
  }
  const k = String(req.query.k || '') || String(req.headers['x-track-key'] || '');
  if (!isAuthorizedTrackKey(TRACK_KEY, k)) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

// A Sonuvi-owned UPnP session uses moOde's MPD internally. Reject the
// server's other playback/queue mutation surfaces while that ownership is
// active so a controller cannot silently take the renderer back over.
function rejectMpdMutationDuringUpnp(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())) return next();
  if (!upnpPlaybackSession?.hasActiveSession?.()) return next();
  return res.status(409).json({
    ok: false,
    unavailable: true,
    source: 'upnp-sonuvi',
    error: 'MPD playback and queue controls are unavailable while Sonuvi UPnP owns the renderer',
  });
}

for (const prefix of ['/mpd', '/queue', '/config/diagnostics/playback', '/youtube/queue']) {
  app.use(prefix, rejectMpdMutationDuringUpnp);
}

function isLikelyYouTubeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    const h = String(u.hostname || '').toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be' || h.endsWith('.youtu.be');
  } catch {
    return false;
  }
}

const ytResolveCache = new Map();
const YT_RESOLVE_CACHE_MS = 45 * 60 * 1000;

async function resolveYouTubeAudio(url) {
  const input = String(url || '').trim();
  if (!isLikelyYouTubeUrl(input)) throw new Error('Only YouTube URLs are supported');

  const now = Date.now();
  const cached = ytResolveCache.get(input);
  if (cached && (now - Number(cached.ts || 0) < YT_RESOLVE_CACHE_MS)) {
    return { ...cached.value };
  }

  let parsed = null;
  try {
    const { stdout } = await execFileP('yt-dlp', ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '--dump-single-json', input], { maxBuffer: 8 * 1024 * 1024 });
    parsed = JSON.parse(String(stdout || '{}'));
  } catch (e) {
    throw new Error(`yt-dlp resolve failed: ${e?.message || String(e)}`);
  }

  let streamUrl = String(parsed?.url || '').trim();
  if (!streamUrl) {
    try {
      const { stdout } = await execFileP('yt-dlp', ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-g', input], { maxBuffer: 2 * 1024 * 1024 });
      streamUrl = String(stdout || '').trim().split(/\r?\n/).find(Boolean) || '';
    } catch {}
  }
  if (!streamUrl) throw new Error('Could not resolve playable audio URL');

  const out = {
    title: String(parsed?.title || '').trim(),
    channel: String(parsed?.uploader || parsed?.channel || '').trim(),
    thumbnail: String(parsed?.thumbnail || '').trim(),
    duration: Number(parsed?.duration || 0) || 0,
    webpageUrl: String(parsed?.webpage_url || input).trim(),
    streamUrl,
  };
  ytResolveCache.set(input, { ts: Date.now(), value: out });
  if (ytResolveCache.size > 1000) {
    const first = ytResolveCache.keys().next().value;
    if (first) ytResolveCache.delete(first);
  }
  return out;
}

function normalizeYtEntry(e = {}) {
  const id = String(e?.id || '').trim();
  const rawUrl = String(e?.url || '').trim();
  const playlistId = String(e?.playlist_id || '').trim();
  const playlistLikeId = /^PL[\w-]{8,}$/i.test(id) ? id : '';
  const listIdFromUrl = (() => {
    try {
      const u = new URL(rawUrl);
      return String(u.searchParams.get('list') || '').trim();
    } catch { return ''; }
  })();
  const listId = playlistId || listIdFromUrl || playlistLikeId;
  const isPlaylist = !!(String(e?._type || '').toLowerCase() === 'playlist' || listId);

  let webpageUrl = '';
  if (rawUrl.startsWith('http')) {
    webpageUrl = rawUrl;
  } else if (isPlaylist && listId) {
    webpageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  } else if (id) {
    webpageUrl = `https://www.youtube.com/watch?v=${id}`;
  }

  return {
    id,
    title: String(e?.title || '').trim(),
    channel: String(e?.uploader || e?.channel || e?.channel_name || '').trim(),
    duration: Number(e?.duration || 0) || 0,
    thumbnail: String(e?.thumbnail || '').trim(),
    webpageUrl,
    isPlaylist,
  };
}

async function searchYouTube(query, limit = 8, playlistsOnly = false) {
  const q = String(query || '').trim();
  const n = Math.max(1, Math.min(20, Number(limit || 8) || 8));
  if (!q) return [];

  try {
    let querySource = '';
    if (playlistsOnly) {
      // YouTube search with "Type: Playlist" filter.
      const qs = encodeURIComponent(q.replace(/\s+/g, ' ').trim());
      querySource = `https://www.youtube.com/results?search_query=${qs}&sp=EgIQAw%253D%253D`;
    } else {
      querySource = `ytsearch${n}:${q}`;
    }

    const { stdout } = await execFileP('yt-dlp', ['--no-warnings', '--flat-playlist', '--dump-single-json', querySource], { maxBuffer: 20 * 1024 * 1024 });
    const j = JSON.parse(String(stdout || '{}'));
    const entries = Array.isArray(j?.entries) ? j.entries : [];
    let out = entries.map((e) => normalizeYtEntry(e)).filter((x) => !!x.webpageUrl);

    if (playlistsOnly) {
      out = out.filter((x) => {
        const u = String(x.webpageUrl || '');
        return /youtube\.com\/playlist\?list=/i.test(u) || !!x.isPlaylist;
      });
    }

    return out.slice(0, n);
  } catch (e) {
    throw new Error(`yt-dlp search failed: ${e?.message || String(e)}`);
  }
}

async function listYouTubePlaylist(url, limit = 100) {
  const input = String(url || '').trim();
  if (!isLikelyYouTubeUrl(input)) throw new Error('Only YouTube URLs are supported');
  let isPlaylist = false;
  try {
    const u = new URL(input);
    isPlaylist = !!String(u.searchParams.get('list') || '').trim();
  } catch {}
  if (!isPlaylist) throw new Error('URL is not a YouTube playlist (missing list=...)');
  const n = Math.max(1, Math.min(500, Number(limit || 100) || 100));
  try {
    const { stdout } = await execFileP('yt-dlp', ['--no-warnings', '--flat-playlist', '--playlist-end', String(n), '--dump-single-json', input], { maxBuffer: 30 * 1024 * 1024 });
    const j = JSON.parse(String(stdout || '{}'));
    const entries = Array.isArray(j?.entries) ? j.entries : [];
    return {
      playlistTitle: String(j?.title || '').trim(),
      count: entries.length,
      items: entries.map((e) => normalizeYtEntry(e)).filter((x) => !!x.webpageUrl),
    };
  } catch (e) {
    throw new Error(`yt-dlp playlist failed: ${e?.message || String(e)}`);
  }
}
/* =========================
 * MPD helpers
 * ========================= */
 
async function getMpdCurrentDateTag() {
  try {
    // Uses your existing execFileP and MPD_HOST/MPD_PORT envs
    const args = ['-h', String(MPD_HOST || '127.0.0.1'), '-p', String(MPD_PORT || '6600'), '-f', '%date%', 'current'];
    const { stdout } = await execFileP('mpc', args, { timeout: 4000 });

    const s = String(stdout || '').trim();
    // common cases: "2026-02-05" or "20260205" or "2026"
    return s;
  } catch {
    return '';
  }
}

// Returns: [{ filename, path, size, mtimeMs, title, date, published }]
async function getLocalItemsForSub(sub, metaByStem = null) {
  const dir = String(sub?.dir || '').trim();
  if (!dir) return [];

  let names = [];
  try {
    names = await fsp.readdir(dir); // IMPORTANT: no withFileTypes (SMB mounts can lie)
  } catch {
    return [];
  }
  
  console.log('[getLocalItemsForSub] names count=', names.length, 'sample=', names.slice(0, 10));
  
  const AUDIO_RE = /\.(mp3|m4a|aac|ogg|flac|mp4)$/i;

  const out = [];
  for (const filename of names) {
    if (!AUDIO_RE.test(filename)) continue;

    const full = path.join(dir, filename);

    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;

      const stem = stemFromFilename(filename);
      const meta = (metaByStem && stem) ? metaByStem[stem] : null;

      out.push({
        filename,
        path: full,
        size: st.size,
        mtimeMs: st.mtimeMs,
        title: String(meta?.title || ''),
        date: String(meta?.date || ''),
        published: meta?.published ?? null
      });
      console.log('[getLocalItemsForSub] audio count=', audioNames.length, 'sample=', audioNames.slice(0, 10));
    } catch {
      // ignore unreadable
    }
  }

  // Prefer published if present; else mtime
  out.sort(
    (a, b) =>
      (b.published || 0) - (a.published || 0) ||
      (b.mtimeMs || 0) - (a.mtimeMs || 0)
  );

  return out;
}
 
async function buildPodcastMap({ rss, outM3u }) {
  const items = readSubs();
  const sub = items.find(it => normUrl(it?.rss) === normUrl(rss));
  if (!sub) throw new Error("Subscription not found");

  // Scan local directory for downloaded audio
  const files = (await fsp.readdir(sub.dir))
    .filter(f => /\.(mp3|m4a|aac|mp4)$/i.test(f));

  const episodes = files.map(f => ({
    title: path.basename(f, path.extname(f)),
    enclosure: path.join(sub.mpdPrefix, f),
    podcastTitle: sub.title
  }));

  const m3u = await writePodcastM3u({ episodes, outM3u });
  const map = await writePodcastUrlMap({ episodes, outM3u });

  return {
    outM3u: m3u.outM3u,
    m3uCount: m3u.count,
    outJson: map.outJson,
    mapCount: map.keyCount
  };
}

async function buildPodcastMapFromLocalItems({ sub, items, outM3u, mapJson }) {
  const itemsByUrl = Object.create(null);
  const lines = [];

  const mpdPrefix = String(sub?.mpdPrefix || '').replace(/\/+$/, '');
  const showTitle = String(sub?.title || 'Podcast').trim() || 'Podcast';

  for (const it of (items || [])) {
    const filename = String(it?.filename || '').trim();
    if (!filename) continue;

    const stem = filename.replace(/\.[^.]+$/, '');
    const key = `id:${stem}`;

    const mpdFile = mpdPrefix ? `${mpdPrefix}/${filename}` : filename;

    itemsByUrl[key] = {
      artist: showTitle,
      album: showTitle,
      title: String(it?.title || '').trim() || '(untitled)',
      date: String(it?.date || '').trim(),
      genre: 'Podcast',

      imageUrl: String(sub?.imageUrl || '').trim(),
      file: mpdFile,
      filename
    };

    lines.push(mpdFile);
  }

  await fsp.mkdir(path.dirname(mapJson), { recursive: true });
  await fsp.writeFile(
    mapJson,
    JSON.stringify({ itemsByUrl }, null, 2) + '\n',
    'utf8'
  );

  await fsp.mkdir(path.dirname(outM3u), { recursive: true });
  await fsp.writeFile(
    outM3u,
    lines.join('\n') + (lines.length ? '\n' : ''),
    'utf8'
  );

  return {
    mapCount: Object.keys(itemsByUrl).length,
    m3uCount: lines.length
  };
}

function extractNprId(s) {
    const str = String(s || '');
    const m = str.match(/\b(NPR\d+)\.mp3\b/i);
    return m ? m[1].toUpperCase() : '';
}
 
 
function extractMegaphoneId(s) {
    const str = String(s || '').trim();
    if (!str) return '';

    // Local file path: .../NPR1234567890.mp3
    const m1 = str.match(/(?:^|\/)(NPR\d+)\.mp3$/i);
    if (m1 && m1[1]) return m1[1].toUpperCase();

    // Any URL that contains .../traffic.megaphone.fm/NPR123....mp3 (or variants)
    const m2 = str.match(/megaphone\.fm\/(NPR\d+)\.mp3/i);
    if (m2 && m2[1]) return m2[1].toUpperCase();

    return '';
}
 
function isLocalPodcastFile(file) {
    return /^USB\/.*\/Podcasts\//i.test(file);
}
 
// safe single-quote escape for shell
function shQ(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

async function favoritesSetViaSsh(file, want) {
  const f = String(file || '').trim();
  if (!f) return { changed: false, isFavorite: false };
  RUNTIME_CAPABILITIES.assertExternalMutation('ssh.playlist-write');

  // This runs on moOde:
  // - ensures file exists
  // - remove exact matching lines when want=false
  // - add exact line once when want=true
  // - prints RESULT=0/1
  const remoteCmd = `
set -e
p=${shQ(FAVORITES_M3U)}
f=${shQ(f)}
sudo touch "$p"
sudo chown root:audio "$p" || true
sudo chmod 664 "$p" || true

if ${want ? 'true' : 'false'}; then
  if sudo grep -Fxq "$f" "$p"; then
    echo "RESULT=1"
  else
    echo "$f" | sudo tee -a "$p" >/dev/null
    echo "RESULT=1"
  fi
else
  if sudo grep -Fxq "$f" "$p"; then
    # delete exact line matches
    sudo sed -i "\\|^${f.replace(/\\/g,'\\\\').replace(/\|/g,'\\|')}$|d" "$p"
  fi
  if sudo grep -Fxq "$f" "$p"; then
    echo "RESULT=1"
  else
    echo "RESULT=0"
  fi
fi
`;

  const { stdout } = await execFileP('ssh', ['-o', 'BatchMode=yes', MOODE_SSH, remoteCmd], {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });

  const isFavorite = /RESULT=1/.test(String(stdout || ''));
  return { changed: true, isFavorite };
}
 
async function sshMoode(cmd) {
  const host = `${MOODE_SSH_USER}@${MOODE_SSH_HOST}`;
  // IMPORTANT: wrap remote command in bash -lc so quoting behaves
  const full = `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${host} ${mpdEscapeShellArg(`bash -lc ${mpdEscapeShellArg(cmd)}`)}`;
  return await execShell(full); // whatever you already use to run shell commands and capture stdout/stderr
}

// Minimal shell-arg escaper (single-quote safe)
function mpdEscapeShellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
 
// =========================
// MPD stickers over TCP (mpdQueryRaw)
// =========================

function parseStickerGetValue(raw, key) {
  // Example MPD response line: "sticker: rating=5"
  const want = `${String(key || '').trim().toLowerCase()}=`;
  const lines = String(raw || '').split('\n');

  for (const line0 of lines) {
    const line = String(line0 || '').trim();
    const m = line.match(/^sticker:\s*(.+)$/i);
    if (!m) continue;

    const rhs = String(m[1] || '').trim(); // "rating=5"
    if (rhs.toLowerCase().startsWith(want)) {
      return rhs.slice(want.length).trim(); // "5"
    }
  }
  return '';
}

async function mpdStickerGetSong(file, key) {
  const f = String(file || '').trim();
  const k = String(key || '').trim();
  if (!f || !k) return '';
  if (isStreamPath(f) || isAirplayFile(f)) return '';

  const raw = await mpdQueryRaw(`sticker get song ${mpdEscapeValue(f)} ${k}`);
  if (!raw || mpdHasACK(raw)) return '';
  return parseStickerGetValue(raw, k);
}

async function mpdStickerSetSong(file, key, value) {
  const f = String(file || '').trim();
  const k = String(key || '').trim();
  const v = String(value ?? '').trim();

  if (!f || !k) throw new Error('mpdStickerSetSong: missing file/key');
  if (isStreamPath(f) || isAirplayFile(f)) throw new Error('mpdStickerSetSong: not a local file');

  const raw = await mpdQueryRaw(
    `sticker set song ${mpdEscapeValue(f)} ${k} ${mpdEscapeValue(v)}`
  );
  if (!raw || mpdHasACK(raw)) throw new Error('mpd sticker set failed');
  return true;
}

async function mpdStickerDeleteSong(file, key) {
  const f = String(file || '').trim();
  const k = String(key || '').trim();
  if (!f || !k) return false;
  if (isStreamPath(f) || isAirplayFile(f)) return false;

  const raw = await mpdQueryRaw(`sticker delete song ${mpdEscapeValue(f)} ${k}`);
  // If sticker doesn't exist, MPD may ACK. That's fine: goal is "no sticker".
  return !!raw;
}

async function setRatingForFile(file, rating0to5) {
  const fileStr = String(file || '').trim();
  if (!fileStr) throw new Error('setRatingForFile: missing file');

  const r = Math.max(0, Math.min(5, Number(rating0to5) || 0));

  if (r === 0) {
    // Prefer delete (true unrated), but fall back to set 0.
    try {
      await mpdStickerDeleteSong(fileStr, 'rating');
    } catch {
      await mpdStickerSetSong(fileStr, 'rating', '0');
    }
    return 0;
  }

  await mpdStickerSetSong(fileStr, 'rating', String(r));
  return r;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Alexa "was-playing" state (used by launch UX + UI overlays)
let alexaWasPlaying = {
  token: '',
  file: '',
  title: '',
  artist: '',
  album: '',
  year: '',
  date: '',
  personnel: [],
  rating: 0,
  ratingFile: '',
  ratingDisabled: false,
  startedAt: 0,
  stoppedAt: 0,
  playbackTarget: '',
  playbackMode: '',
  modeActive: false,
  pendingNaturalFinishToken: '',
  pendingNaturalFinishAt: 0,
  queuedNextToken: '',
  queuedNextForToken: '',
  active: false,
  updatedAt: 0,
};

// Homebridge/Matter Alexa Mode is independent from the Alexa AudioPlayer
// lifecycle. A track can finish while Alexa Mode remains enabled.
let alexaModeActive = false;
let alexaModeOutputSync = Promise.resolve();

async function setAlexaModeLocalOutput(modeActive) {
  const enabled = !modeActive;
  const command = enabled ? 'enableoutput 0' : 'disableoutput 0';
  const raw = await mpdQueryRaw(command);
  if (mpdHasACK(raw)) throw new Error(`MPD rejected Alexa Mode local output change: ${command}`);

  const outputs = parseMpdOutputs(await mpdQueryRaw('outputs'));
  const local = outputs.find((x) => x.id === 0) || null;
  if (!local) throw new Error('Local ALSA output not found after Alexa Mode change');
  if (local.enabled !== enabled) throw new Error(`Local ALSA output did not become ${enabled ? 'enabled' : 'muted'}`);

  log.info('[alexa] local ALSA output synchronized', { modeActive: !!modeActive, enabled: local.enabled });
  return local;
}

function queueAlexaModeLocalOutputSync(modeActive) {
  alexaModeOutputSync = alexaModeOutputSync
    .catch(() => {})
    .then(() => setAlexaModeLocalOutput(modeActive));
  return alexaModeOutputSync;
}

async function clearAlexaWasPlayingState() {
  const nowTs = Date.now();
  alexaModeActive = false;
  const outputSync = queueAlexaModeLocalOutputSync(false);
  alexaWasPlaying = {
    ...alexaWasPlaying,
    active: false,
    stoppedAt: nowTs,
    updatedAt: nowTs,
    playbackTarget: '',
    playbackMode: '',
    modeActive: false,
    pendingNaturalFinishToken: '',
    pendingNaturalFinishAt: 0,
    queuedNextToken: '',
    queuedNextForToken: '',
  };
  await outputSync;
  return alexaWasPlaying;
}

async function setAlexaModeState(active) {
  const nextActive = !!active;
  alexaModeActive = nextActive;
  const outputSync = queueAlexaModeLocalOutputSync(nextActive);
  if (!nextActive) {
    const nowTs = Date.now();
    alexaWasPlaying = {
      ...alexaWasPlaying,
      token: '',
      file: '',
      title: '',
      artist: '',
      album: '',
      year: '',
      date: '',
      personnel: [],
      rating: 0,
      ratingFile: '',
      ratingDisabled: false,
      active: false,
      stoppedAt: nowTs,
      updatedAt: nowTs,
      playbackTarget: '',
      playbackMode: '',
      modeActive: false,
      pendingNaturalFinishToken: '',
      pendingNaturalFinishAt: 0,
      queuedNextToken: '',
      queuedNextForToken: '',
    };
    await outputSync;
    return alexaWasPlaying;
  }

  if (alexaWasPlaying.modeActive && alexaWasPlaying.playbackMode === 'alexa') {
    await outputSync;
    return alexaWasPlaying;
  }

  const nowTs = Date.now();
  alexaWasPlaying = {
    ...alexaWasPlaying,
    token: '',
    file: '',
    title: '',
    artist: '',
    album: '',
    year: '',
    date: '',
    personnel: [],
    rating: 0,
    ratingFile: '',
    ratingDisabled: false,
    active: true,
    startedAt: nowTs,
    stoppedAt: 0,
    updatedAt: nowTs,
    playbackTarget: 'echo',
    playbackMode: 'alexa',
    modeActive: true,
    pendingNaturalFinishToken: '',
    pendingNaturalFinishAt: 0,
    queuedNextToken: '',
    queuedNextForToken: '',
  };
  await outputSync;
  return alexaWasPlaying;
}

app.get('/alexa/was-playing', async (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = Number.parseInt(String(req.query?.maxAgeMs || '43200000').trim(), 10); // 12h default
    const ageMs = (alexaWasPlaying.updatedAt > 0) ? Math.max(0, now - alexaWasPlaying.updatedAt) : null;
    const fresh = ageMs !== null && Number.isFinite(maxAgeMs) ? ageMs <= Math.max(0, maxAgeMs) : true;

    const wp = alexaWasPlaying || {};
    const file = String(wp.file || '').trim();
    const title = String(wp.title || '').trim();
    const artist = String(wp.artist || '').trim();
    const album = String(wp.album || '').trim();
    let year = String(wp.year || '').trim();
    let date = String(wp.date || '').trim();
    let ratingNum = Math.max(0, Math.min(5, Number(wp.rating) || 0));
    let ratingFile = String(wp.ratingFile || file || '').trim();
    let ratingDisabled = (typeof wp.ratingDisabled === 'boolean') ? !!wp.ratingDisabled : !ratingFile;

    // Prefer rich metadata from latest /now-playing snapshot when it matches the same file.
    const lnp = (lastNowPlayingOk && typeof lastNowPlayingOk === 'object') ? lastNowPlayingOk : null;
    const lnpFile = String(lnp?.file || '').trim();
    const sameAsLastNp = !!(file && lnpFile && file === lnpFile);

    if (sameAsLastNp) {
      if (!year) year = String(lnp?.year || '').trim();
      if (!date) date = String(lnp?.date || '').trim();
      if ((!ratingFile || ratingFile !== file) && String(lnp?.ratingFile || '').trim() === file) {
        ratingFile = file;
      }
      if (ratingNum <= 0 && Number(lnp?.rating || 0) > 0) {
        ratingNum = Math.max(0, Math.min(5, Number(lnp?.rating) || 0));
      }
      if (typeof lnp?.ratingDisabled === 'boolean') ratingDisabled = !!lnp.ratingDisabled;
    }

    if (file && (!year || !date)) {
      try {
        const deep = await getDeepMetadataCached(file);
        if (!year) year = String(deep?.year || '').trim();
        if (!date && year) date = year;
      } catch {}
    }

    // Keep Alexa rating in sync with the actual file when payload is stale/incomplete.
    if (file) {
      try {
        // Use direct sticker read here (not cache) so Alexa view cannot carry stale rating across tracks.
        const liveRating = Math.max(0, Math.min(5, Number(await getRatingForFile(file)) || 0));
        ratingNum = liveRating;
        ratingDisabled = false;
        ratingFile = file;
      } catch {
        if (!ratingFile || ratingFile !== file || ratingNum <= 0) {
          try {
            const rr = await getRatingForFileCached(file);
            ratingNum = Math.max(0, Math.min(5, Number(rr?.rating) || 0));
            ratingDisabled = !!rr?.disabled;
            ratingFile = file;
          } catch {}
        }
      }
    }

    let deepPerformers = [];
    if (file) {
      try {
        const deep = await getDeepMetadataCached(file);
        deepPerformers = Array.isArray(deep?.performers) ? deep.performers : [];
      } catch {}
    }

    const personnelOut = (sameAsLastNp && Array.isArray(lnp?.personnel) && lnp.personnel.length)
      ? lnp.personnel
      : ((Array.isArray(wp?.personnel) && wp.personnel.length)
          ? wp.personnel
          : deepPerformers);
    const encodedOut = String((sameAsLastNp ? (lnp?.encoded || '') : '') || (wp?.encoded || '')).trim();
    const bitrateOut = String((sameAsLastNp ? (lnp?.bitrate || '') : '') || (wp?.bitrate || '')).trim();
    const outrateOut = String((sameAsLastNp ? (lnp?.outrate || '') : '') || (wp?.outrate || '')).trim();

    const passthrough = {};
    for (const [k, v] of Object.entries(wp || {})) {
      if ([
        'token', 'active', 'startedAt', 'stoppedAt', 'updatedAt',
        // computed/normalized fields must not be overwritten by stale was-playing values
        'file', 'title', 'artist', 'album', 'year', 'date',
        'rating', 'ratingFile', 'ratingDisabled',
        'personnel', 'encoded', 'bitrate', 'outrate'
      ].includes(k)) continue;
      if (typeof v === 'undefined') continue;
      passthrough[k] = v;
    }

    // now-playing-compatible payload (safe defaults + passthrough parity)
    const nowPlaying = {
      playbackUrl: '',
      songpos: '',
      songid: '',
      albumArtUrl: file ? `${PUBLIC_BASE_URL}/art/track_640.jpg?file=${encodeURIComponent(file)}${TRACK_KEY ? `&k=${encodeURIComponent(TRACK_KEY)}` : ''}` : '',
      aplArtUrl: `${PUBLIC_BASE_URL}/art/current.jpg`,
      altArtUrl: '',
      stationLogoUrl: '',
      radioAlbum: '',
      radioYear: '',
      radioLabel: '',
      radioComposer: '',
      radioWork: '',
      radioPerformers: '',
      radioItunesUrl: '',
      radioTrackUrl: '',
      radioAlbumUrl: '',
      shareUrl: '',
      radioLookupReason: '',
      radioLookupTerm: '',
      elapsed: 0,
      duration: 0,
      percent: 0,
      year,
      label: '',
      producer: '',
      personnel: personnelOut,
      encoded: encodedOut,
      bitrate: bitrateOut || '0 bps',
      outrate: outrateOut,
      volume: '0',
      mute: '0',
      track: '',
      date,
      isStream: false,
      isAirplay: false,
      isYoutube: false,
      isPodcast: false,
      streamKind: '',
      isUpnp: false,
      isFavorite: false,
      rating: ratingNum,
      ratingDisabled,
      ratingFile,
      ...passthrough,
      artist,
      title,
      album,
      file,
      state: (fresh && !!wp.active) ? 'play' : 'stop',
      playbackTarget: String(wp.playbackTarget || '').trim(),
      playbackMode: String(wp.playbackMode || '').trim(),
      modeActive: !!alexaModeActive,
      alexaMode: !!alexaModeActive,
      fresh,
      ageMs,
      active: !!wp.active,
      startedAt: Number(wp.startedAt || 0) || 0,
      stoppedAt: Number(wp.stoppedAt || 0) || 0,
      updatedAt: Number(wp.updatedAt || 0) || 0,
    };

    return res.json({ ok: true, fresh, ageMs, wasPlaying: wp, nowPlaying });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Semantic alias: "what Alexa is playing now".
// Keeps /alexa/was-playing for backward compatibility while exposing clearer naming.
app.get('/alexa/now-playing', async (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = Number.parseInt(String(req.query?.maxAgeMs || '43200000').trim(), 10);
    const ageMs = (alexaWasPlaying.updatedAt > 0) ? Math.max(0, now - alexaWasPlaying.updatedAt) : null;
    const fresh = ageMs !== null && Number.isFinite(maxAgeMs) ? ageMs <= Math.max(0, maxAgeMs) : true;

    const wp = alexaWasPlaying || {};
    const npLike = {
      artist: String(wp.artist || '').trim(),
      title: String(wp.title || '').trim(),
      album: String(wp.album || '').trim(),
      file: String(wp.file || '').trim(),
      active: !!wp.active,
      state: !!wp.active ? 'play' : 'stop',
      playbackTarget: String(wp.playbackTarget || '').trim(),
      playbackMode: String(wp.playbackMode || '').trim(),
      modeActive: !!alexaModeActive,
      alexaMode: !!alexaModeActive,
      fresh,
      ageMs,
      startedAt: Number(wp.startedAt || 0) || 0,
      stoppedAt: Number(wp.stoppedAt || 0) || 0,
      updatedAt: Number(wp.updatedAt || 0) || 0,
    };

    return res.json({ ok: true, fresh, ageMs, nowPlaying: npLike });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Decode the exact Alexa stream token recorded when NearlyFinished enqueues a
// successor. MPD has already advanced past that item by the time clients poll
// /alexa/next-up, so the token is the only reliable immediate-successor source.
function parseAlexaTrackToken(token) {
  const value = String(token || '').trim();
  if (!value.startsWith('moode-track:')) return null;

  try {
    const raw = value.slice('moode-track:'.length);
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8') || '{}');
    const file = String(parsed?.file || '').trim();
    if (!file) return null;
    return {
      file,
      title: decodeHtmlEntities(String(parsed?.title || '').trim()),
      artist: decodeHtmlEntities(String(parsed?.artist || '').trim()),
      album: decodeHtmlEntities(String(parsed?.album || '').trim()),
      songid: String(parsed?.songid ?? '').trim(),
      songpos: String(parsed?.pos0 ?? '').trim(),
    };
  } catch {
    return null;
  }
}

// Semantic alias: Alexa "next up" is the recorded ENQUEUE successor while
// one is pending; once Alexa starts it, the marker is cleared and this falls
// back to the MPD live head as before.
app.get('/alexa/next-up', async (req, res) => {
  const wp = alexaWasPlaying || {};
  const currentToken = String(wp.token || '').trim();
  const queuedForToken = String(wp.queuedNextForToken || '').trim();
  const queuedNextToken = String(wp.queuedNextToken || '').trim();
  const alexaPlaybackAuthority = Boolean(
    alexaModeActive
      || wp.modeActive
      || wp.alexaMode
      || String(wp.playbackMode || '').trim().toLowerCase() === 'alexa'
      || String(wp.playbackTarget || '').trim().toLowerCase() === 'echo'
  );
  const successor = (
    alexaPlaybackAuthority
    && !!wp.active
    && currentToken
    && queuedForToken === currentToken
    && queuedNextToken
  ) ? parseAlexaTrackToken(queuedNextToken) : null;

  if (successor) {
    const isStream = isStreamPath(successor.file);
    const isYoutube = isStream && /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(successor.file);
    const item = {
      songid: successor.songid,
      songpos: successor.songpos,
      title: successor.title,
      artist: successor.artist,
      album: successor.album,
      file: successor.file,
      isStream,
      isYoutube,
      artUrl: isStream ? `${PUBLIC_BASE_URL}/art/current.jpg` : buildArtUrlForFile(successor.file),
      currentArtUrl: `${PUBLIC_BASE_URL}/art/current.jpg`,
      stationLogoUrl: '',
    };

    // Keep both the legacy top-level fields and the nested `next` shape so
    // existing tablet and full-controller clients can consume this endpoint.
    return res.json({
      ok: true,
      source: 'alexa-enqueue',
      ...item,
      next: item,
    });
  }

  return res.redirect(307, '/now-playing');
});

app.post('/alexa/was-playing', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;

    const active = !!req.body?.active;
    const nowTs = Date.now();

    const incoming = (req.body && typeof req.body === 'object') ? req.body : {};

    // Alexa can deliver a previous track's PlaybackFinished after the
    // successor's PlaybackStarted. Do not let that stale inactive event
    // overwrite the currently active successor; the real successor finish
    // must remain eligible for natural Alexa-mode cleanup.
    const incomingToken = String(incoming?.token || '').trim();
    const currentToken = String(alexaWasPlaying?.token || '').trim();
    if (!active
      && alexaWasPlaying?.active
      && incomingToken
      && currentToken
      && incomingToken !== currentToken) {
      return res.json({ ok: true, ignoredStaleInactive: true, wasPlaying: alexaWasPlaying });
    }

    const merged = { ...alexaWasPlaying };
    for (const [k, v] of Object.entries(incoming)) {
      if (['active', 'startedAt', 'stoppedAt', 'updatedAt'].includes(k)) continue;
      if (typeof v === 'undefined') continue;
      merged[k] = v;
    }

    const tokenResolved = String(incoming?.token || merged.token || '').trim();
    const pos0IncomingNum = Number(incoming?.removedPos0);
    let pos0FromToken = Number.NaN;
    try {
      if (tokenResolved.startsWith('moode-track:')) {
        const raw = tokenResolved.slice('moode-track:'.length);
        const pad = raw.length % 4 ? '='.repeat(4 - (raw.length % 4)) : '';
        const j = JSON.parse(Buffer.from((raw + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') || '{}');
        pos0FromToken = Number(j?.pos0);
      }
    } catch {}
    const removedPos0Resolved = Number.isFinite(pos0IncomingNum)
      ? Math.max(0, Math.floor(pos0IncomingNum))
      : (Number.isFinite(pos0FromToken) ? Math.max(0, Math.floor(pos0FromToken)) : Number(incoming?.removedPos1) - 1);
    const removedPos1Resolved = Number.isFinite(removedPos0Resolved) ? (removedPos0Resolved + 1) : Number(incoming?.removedPos1);

    alexaWasPlaying = {
      ...merged,
      token: tokenResolved,
      file: String(incoming?.file || merged.file || '').trim(),
      title: decodeHtmlEntities(String(incoming?.title || merged.title || '').trim()),
      artist: decodeHtmlEntities(String(incoming?.artist || merged.artist || '').trim()),
      album: decodeHtmlEntities(String(incoming?.album || merged.album || '').trim()),
      year: String(incoming?.year || merged.year || '').trim(),
      date: String(incoming?.date || merged.date || '').trim(),
      personnel: Array.isArray(incoming?.personnel)
        ? incoming.personnel
        : (Array.isArray(merged.personnel) ? merged.personnel : []),
      rating: Math.max(0, Math.min(5, Number(incoming?.rating ?? merged.rating ?? 0) || 0)),
      ratingFile: String(incoming?.ratingFile || merged.ratingFile || incoming?.file || merged.file || '').trim(),
      ratingDisabled: (typeof incoming?.ratingDisabled === 'boolean') ? !!incoming.ratingDisabled : ((typeof merged.ratingDisabled === 'boolean') ? !!merged.ratingDisabled : false),
      removedPos0: Number.isFinite(removedPos0Resolved) ? removedPos0Resolved : null,
      removedPos1: Number.isFinite(removedPos1Resolved) ? Math.max(1, Math.floor(removedPos1Resolved)) : null,
      modeActive: alexaModeActive,
      pendingNaturalFinishToken: String(incoming?.pendingNaturalFinishToken ?? merged.pendingNaturalFinishToken ?? '').trim(),
      pendingNaturalFinishAt: Number.parseInt(String(incoming?.pendingNaturalFinishAt ?? merged.pendingNaturalFinishAt ?? 0).trim(), 10) || 0,
      queuedNextToken: String(incoming?.queuedNextToken ?? merged.queuedNextToken ?? '').trim(),
      queuedNextForToken: String(incoming?.queuedNextForToken ?? merged.queuedNextForToken ?? '').trim(),
      startedAt: Number.parseInt(String(incoming?.startedAt || merged.startedAt || nowTs).trim(), 10) || nowTs,
      stoppedAt: active ? 0 : (Number.parseInt(String(incoming?.stoppedAt || nowTs).trim(), 10) || nowTs),
      active,
      updatedAt: nowTs,
    };

    return res.json({ ok: true, wasPlaying: alexaWasPlaying });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// =========================
// Optional track notifications. Pushover remains available for the web/app
// host, while APNs delivers to paired Sonuvi devices when the app is
// suspended or not currently open.
// =========================
const TRACK_NOTIFY_POLL_MS_SAFE = Math.max(1500, Number(TRACK_NOTIFY_POLL_MS || 3000));
const TRACK_NOTIFY_DEDUPE_MS_SAFE = Math.max(5000, Number(TRACK_NOTIFY_DEDUPE_MS || 15000));
const TRACK_NOTIFY_ALEXA_MAX_AGE_MS_SAFE = Math.max(30000, Number(TRACK_NOTIFY_ALEXA_MAX_AGE_MS || 21600000));

let _lastTrackNotifyKey = '';
let _lastTrackNotifyAt = 0;
let _trackNotifyBusy = false;
const TRACK_NOTIFY_RADIO_ENRICH_WAIT_MS = 1800;

function buildArtUrlForFile(file) {
  const f = String(file || '').trim();
  if (!f) return '';
  return `${PUBLIC_BASE_URL}/art/track_640.jpg?file=${encodeURIComponent(f)}${TRACK_KEY ? `&k=${encodeURIComponent(TRACK_KEY)}` : ''}`;
}

function buildRadioLogoUrlForFile(file) {
  const f = String(file || '').trim();
  if (!f) return '';
  return `${PUBLIC_BASE_URL}/art/radio-logo.jpg?file=${encodeURIComponent(f)}&v=20260924-radio-art2${TRACK_KEY ? `&k=${encodeURIComponent(TRACK_KEY)}` : ''}`;
}

function sanitizeNotifyMeta(rawArtist, rawTitle) {
  const unwrapStreamTitle = (value) => {
    let result = decodeHtmlEntities(String(value || '').trim());
    if (/^streamtitle\s*=/i.test(result)) {
      result = result.replace(/^streamtitle\s*=\s*/i, '').trim();
    }
    // AVPlayer may preserve the ICY wrapper's surrounding single quotes and
    // semicolon. Remove only that outer wrapper; quoted iHeart attributes
    // inside the value must remain intact for parseIheartTitleBlob.
    if (result.startsWith("'") && /';?$/.test(result)) {
      result = result.slice(1).replace(/';?$/, '').trim();
    } else if (result.startsWith('"') && /";?$/.test(result)) {
      result = result.slice(1).replace(/";?$/, '').trim();
    }
    return result;
  };

  let artist = unwrapStreamTitle(rawArtist);
  let title = unwrapStreamTitle(rawTitle);

  // iHeart blob cleanup (e.g., text="..." song_spot="..." TPID="...")
  const blobish = /(\btext="[^"]+"|\bsong_spot="[^"]+"|\bTPID="\d+"|\bamgArtworkURL="[^"]+")/i;
  if (blobish.test(title) || blobish.test(artist)) {
    const parsed = parseIheartTitleBlob(title) || parseIheartTitleBlob(artist);
    if (parsed) {
      if (parsed.title) title = parsed.title;
      if (parsed.artist) artist = parsed.artist;
    }
  }

  return { artist: String(artist || '').trim(), title: String(title || '').trim() };
}

async function selectNotificationTrack() {
  const now = Date.now();
  const age = (alexaWasPlaying.updatedAt > 0) ? Math.max(0, now - alexaWasPlaying.updatedAt) : null;
  const alexaFresh = age !== null && age <= TRACK_NOTIFY_ALEXA_MAX_AGE_MS_SAFE;

  if (alexaWasPlaying.active && alexaFresh && alexaWasPlaying.file) {
    return {
      source: 'alexa',
      file: String(alexaWasPlaying.file || '').trim(),
      title: String(alexaWasPlaying.title || '').trim(),
      artist: String(alexaWasPlaying.artist || '').trim(),
      album: String(alexaWasPlaying.album || '').trim(),
      artUrl: buildArtUrlForFile(alexaWasPlaying.file),
      key: `alexa|${alexaWasPlaying.file}|${alexaWasPlaying.title}|${alexaWasPlaying.artist}`,
    };
  }

  try {
    const song = await fetchCurrentSong();
    const statusRaw = await fetchCurrentStatus();
    const state = String(moodeValByKey(statusRaw, 'state') || '').trim().toLowerCase();
    const file = String(song?.file || '').trim();
    if (state !== 'play' || !file) return null;

    const cleaned = sanitizeNotifyMeta(song?.artist, song?.title);
    const isStreamLike = /^https?:\/\//i.test(file);

    const lnp = (lastNowPlayingOk && typeof lastNowPlayingOk === 'object') ? lastNowPlayingOk : null;
    const lnpFile = String(lnp?.file || '').trim();
    const sameAsLastNp = !!(file && lnpFile && file === lnpFile);
    const lnpStationLogo = sameAsLastNp
      ? String(lnp?.stationLogoUrl || lnp?.altArtUrl || '').trim()
      : '';

    return {
      source: 'now-playing',
      file,
      title: cleaned.title,
      artist: cleaned.artist,
      album: decodeHtmlEntities(String(song?.album || '').trim()),
      artUrl: buildArtUrlForFile(file),
      stationLogoUrl: isStreamLike
        ? (lnpStationLogo || `${PUBLIC_BASE_URL}/art/radio-logo.jpg?file=${encodeURIComponent(file)}&v=20260924-radio-art2${TRACK_KEY ? `&k=${encodeURIComponent(TRACK_KEY)}` : ''}`)
        : '',
      key: `np|${file}|${cleaned.title}|${cleaned.artist}`,
    };
  } catch {
    return null;
  }
}

async function sendPushoverTrackNotification(track) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER_KEY) return false;
  if (!track || !track.file) return false;
  RUNTIME_CAPABILITIES.assertExternalMutation('push.pushover');

  const title = String(track.title || '').trim() || (track.file.split('/').pop() || 'Now Playing');
  const artist = String(track.artist || '').trim();
  const album = String(track.album || '').trim();

  const form = new FormData();
  form.append('token', PUSHOVER_TOKEN);
  form.append('user', PUSHOVER_USER_KEY);
  form.append('title', title);
  const bodyLine = [artist, album].filter(Boolean).join(' — ') || 'Now playing';
  form.append('message', bodyLine);

  let attached = false;
  const isStreamLike = /^https?:\/\//i.test(String(track.file || ''));

  // For radio/streams prefer station logo first (avoids generic moOde default art races).
  if (isStreamLike && track.stationLogoUrl) {
    try {
      const r = await fetch(track.stationLogoUrl, { cache: 'no-store' });
      if (r.ok) {
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const ext = /png/i.test(ct) ? 'png' : 'jpg';
        const ab = await r.arrayBuffer();
        const blob = new Blob([ab], { type: ct });
        form.append('attachment', blob, `station.${ext}`);
        attached = true;
      }
    } catch (e) {}
  }

  if (!attached && track.artUrl) {
    try {
      const r = await fetch(track.artUrl, { cache: 'no-store' });
      if (r.ok) {
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const ext = /png/i.test(ct) ? 'png' : 'jpg';
        const ab = await r.arrayBuffer();
        const blob = new Blob([ab], { type: ct });
        form.append('attachment', blob, `cover.${ext}`);
        attached = true;
      }
    } catch (e) {}
  }

  // Non-stream fallback: if track art unavailable, use station logo when present.
  if (!attached && track.stationLogoUrl) {
    try {
      const r = await fetch(track.stationLogoUrl, { cache: 'no-store' });
      if (r.ok) {
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const ext = /png/i.test(ct) ? 'png' : 'jpg';
        const ab = await r.arrayBuffer();
        const blob = new Blob([ab], { type: ct });
        form.append('attachment', blob, `station.${ext}`);
        attached = true;
      }
    } catch (e) {}
  }

  const resp = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: form,
  });

  return resp.ok;
}

function apnsPayloadForTrack(track) {
  const title = String(track?.title || '').trim() || 'Now Playing';
  const artist = String(track?.artist || '').trim();
  const album = String(track?.album || '').trim();
  const trackID = String(track?.key || title).trim();
  const isRadio = track?.isRadio === true || /^https?:\/\//i.test(String(track?.file || ''));
  const artworkMatched = track?.artworkMatched === true;
  const rawMediaURL = String(
    (isRadio
      ? (artworkMatched ? track?.artUrl : track?.stationLogoUrl || track?.artUrl)
      : track?.artUrl) || track?.stationLogoUrl || ''
  ).trim();
  const mediaURL = resolveApnsMediaUrl(rawMediaURL, {
    publicBaseUrl: PUBLIC_BASE_URL,
    mobileBaseUrl: MOBILE_PUBLIC_BASE_URL,
  });
  const alert = {
    title,
    ...(artist ? { subtitle: artist } : {}),
    body: album || (artist ? 'Now playing' : 'Now playing on Sonuvi'),
  };

  return {
    aps: {
      alert,
      ...(isRadio ? {} : { sound: 'default' }),
      'mutable-content': mediaURL ? 1 : 0,
      'thread-id': 'sonuvi-playback',
    },
    trackID,
    source: String(track?.source || 'now-playing'),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(mediaURL ? { 'media-url': mediaURL } : {}),
    ...(String(track?.appleMusicUrl || '').trim()
      ? { appleMusicUrl: String(track.appleMusicUrl).trim() }
      : {}),
  };
}

async function sendApnsTrackNotification(track, { deviceId = '' } = {}) {
  const providerConfigured = apnsProvider.isConfigured();
  if (!providerConfigured || !track?.file) {
    log.warn('[apns] delivery skipped', {
      providerConfigured,
      filePresent: Boolean(track?.file),
      source: String(track?.source || 'unknown'),
      title: String(track?.title || '').trim() || 'unknown',
    });
    return { attempted: 0, sent: 0 };
  }

  const targetDeviceId = String(deviceId || '').trim();
  const allRecords = await mobilePushTokenStore.list();
  const records = allRecords.filter((record) => (
    !targetDeviceId || record.deviceId === targetDeviceId
  ));
  if (!records.length) {
    log.warn('[apns] no registered device tokens', {
      source: String(track?.source || 'unknown'),
      title: String(track?.title || '').trim() || 'unknown',
      registeredCount: allRecords.length,
      targetDevice: Boolean(targetDeviceId),
    });
    return { attempted: 0, sent: 0 };
  }

  const payload = apnsPayloadForTrack(track);
  let sent = 0;
  const outcomes = [];
  await Promise.all(records.map(async (record) => {
    try {
      const result = await apnsProvider.send({
        deviceToken: record.token,
        environment: record.environment,
        payload,
      });
      outcomes.push({
        environment: record.environment,
        status: result.status,
        reason: result.reason || '',
        ok: result.ok === true,
      });
      if (result.invalidToken) {
        await mobilePushTokenStore.remove({ token: record.token });
        log.warn('[apns] removed invalid device token', {
          environment: record.environment,
          reason: result.reason || 'invalid token',
        });
      }
      if (result.ok) sent += 1;
    } catch (error) {
      outcomes.push({
        environment: record.environment,
        status: 0,
        reason: error?.message || String(error),
        ok: false,
      });
      log.error('[apns] track notification failed', {
        environment: record.environment,
        error: error?.message || String(error),
      });
    }
  }));
  log.info('[apns] delivery completed', {
    source: String(track?.source || 'unknown'),
    title: String(track?.title || '').trim() || 'unknown',
    attempted: records.length,
    sent,
    outcomes,
  });
  return { attempted: records.length, sent };
}

const nativeApnsNotificationDedupe = new Map();
const NATIVE_APNS_DEDUPE_LIMIT = 128;

async function notifyNativePlaybackWithApns({ track, trackId, sessionId, deviceId } = {}) {
  if (!TRACK_NOTIFY_ENABLED || !track?.file) {
    log.warn('[apns/native] notification skipped', {
      trackNotificationsEnabled: TRACK_NOTIFY_ENABLED,
      filePresent: Boolean(track?.file),
      trackKind: String(trackId || '').startsWith('podcast-')
        ? 'podcast'
        : (String(trackId || '').startsWith('radio-') ? 'radio' : 'catalog'),
      title: String(track?.title || '').trim() || 'unknown',
    });
    return { attempted: 0, sent: 0 };
  }

  const nativeIdentity = [
    String(trackId || track.id || track.file).trim(),
    String(track.title || '').trim(),
    String(track.artist || '').trim(),
    String(track.album || '').trim(),
  ].join('|');
  const nativeKey = `ios-device|${String(sessionId || '').trim()}|${nativeIdentity}`;
  const now = Date.now();
  const previousAt = nativeApnsNotificationDedupe.get(nativeKey) || 0;
  if (previousAt > 0 && now - previousAt < TRACK_NOTIFY_DEDUPE_MS_SAFE) {
    log.info('[apns/native] notification deduplicated', {
      trackKind: String(trackId || '').startsWith('podcast-')
        ? 'podcast'
        : (String(trackId || '').startsWith('radio-') ? 'radio' : 'catalog'),
      title: String(track.title || '').trim() || 'unknown',
    });
    return { attempted: 0, sent: 0, deduped: true };
  }

  log.info('[apns/native] notification requested', {
    trackKind: String(trackId || '').startsWith('podcast-')
      ? 'podcast'
      : (String(trackId || '').startsWith('radio-') ? 'radio' : 'catalog'),
    title: String(track.title || '').trim() || 'unknown',
    filePresent: Boolean(track.file),
    targetDevice: Boolean(String(deviceId || '').trim()),
  });

  const result = await sendApnsTrackNotification({
    source: 'ios-device',
    file: track.file,
    title: track.title,
    artist: track.artist,
    album: track.album,
    isRadio: track.isRadio === true || /^https?:\/\//i.test(String(track.file || '')),
    artUrl: String(track.artUrl || track.artworkUrl || '').trim()
      || (track.isRadio === true || /^https?:\/\//i.test(String(track.file || ''))
        ? ''
        : buildArtUrlForFile(track.file)),
    stationLogoUrl: track.isRadio === true || /^https?:\/\//i.test(String(track.file || ''))
      ? (buildRadioLogoUrlForFile(track.file) || String(track.stationLogoUrl || '').trim())
      : String(track.stationLogoUrl || '').trim(),
    artworkMatched: track.artworkMatched === true,
    appleMusicUrl: String(track.appleMusicUrl || '').trim(),
    key: nativeKey,
  }, { deviceId });
  if (Number(result?.sent || 0) > 0) {
    nativeApnsNotificationDedupe.set(nativeKey, now);
    while (nativeApnsNotificationDedupe.size > NATIVE_APNS_DEDUPE_LIMIT) {
      const oldestKey = nativeApnsNotificationDedupe.keys().next().value;
      if (!oldestKey) break;
      nativeApnsNotificationDedupe.delete(oldestKey);
    }
  }
  return result;
}

async function trackNotificationTick() {
  if (!TRACK_NOTIFY_ENABLED) return;
  if (_trackNotifyBusy) return;

  _trackNotifyBusy = true;
  try {
    let track = await selectNotificationTrack();
    if (!track || !track.key) return;

    const now = Date.now();
    // Notify once per track key change (no periodic repeats on same track).
    if (track.key === _lastTrackNotifyKey) return;

    // Radio/stream enrichment lag guard: allow iTunes/artwork resolution to settle.
    const isStreamLike = /^https?:\/\//i.test(String(track.file || ''));
    if (isStreamLike) {
      await sleep(TRACK_NOTIFY_RADIO_ENRICH_WAIT_MS);
      const refreshed = await selectNotificationTrack();
      if (!refreshed || !refreshed.key) return;
      // If track changed during wait, skip this cycle and let next tick handle it.
      if (refreshed.key !== track.key) return;
      track = refreshed;
    }

    const [pushoverResult, apnsResult] = await Promise.allSettled([
      sendPushoverTrackNotification(track),
      sendApnsTrackNotification(track),
    ]);
    const pushoverSent = pushoverResult.status === 'fulfilled' && pushoverResult.value === true;
    const apnsSent = apnsResult.status === 'fulfilled' && Number(apnsResult.value?.sent || 0) > 0;
    if (pushoverSent || apnsSent) {
      _lastTrackNotifyKey = track.key;
      _lastTrackNotifyAt = now;
      log.debug('[notify] sent', {
        source: track.source,
        title: track.title,
        artist: track.artist,
        pushover: pushoverSent,
        apns: apnsSent,
      });
    }
  } catch (e) {
    log.debug('[notify] failed', e?.message || String(e));
  } finally {
    _trackNotifyBusy = false;
  }
}

if (TRACK_NOTIFY_ENABLED && !RUNTIME_CAPABILITIES.rehearsal) {
  setInterval(() => { trackNotificationTick().catch(() => {}); }, TRACK_NOTIFY_POLL_MS_SAFE);
}

app.post('/mpd/deprime', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const r = await mpdDeprimeCurrent();
    return res.json(Object.assign({ ok: true }, r || {}));
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
});

app.post('/mpd/prime', async (req, res) => {
  try {
    const result = await mpdPrimeIfIdle(); // new safe prime
    res.json(Object.assign({ ok: true }, result));
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
});



// You need these four primitives implemented in YOUR style:
// - mpdGetStatus(): returns { state: 'play'|'pause'|'stop', song: number|null, playlistlength: number }
// - mpdPlay(): starts playback (or mpdPlay(0) if you prefer)
// - mpdPause(on): pauses if on===true
// - mpdStop(): stops (optional alternative to pause)

async function mpdDeprimeCurrent() {
  // Required sequence: delete current twice, then verify no current.
  for (let i = 0; i < 2; i++) {
    const st = await mpdGetStatus();
    const len = Number(st && st.playlistlength ? st.playlistlength : 0);
    if (!Number.isFinite(len) || len <= 0) break;
    try { await mpdDeletePos0(0); } catch (e) { break; }
    await sleep(110);
  }

  // Verify current is empty using MPD status song/songid (mpc current equivalent signal).
  // Retry briefly to allow MPD to settle.
  for (let i = 0; i < 6; i++) {
    const st = await mpdGetStatus();
    const hasCurrent = st && st.song !== null && st.song !== undefined && Number.isFinite(Number(st.song));
    if (!hasCurrent) {
      try { await mpdStop(); } catch (e) {}
      return { ok: true, cleared: true, tries: i + 1 };
    }
    await sleep(100);
  }

  // One extra safety delete if queue still has entries, then final check.
  try {
    const st = await mpdGetStatus();
    const len = Number(st && st.playlistlength ? st.playlistlength : 0);
    if (Number.isFinite(len) && len > 0) {
      await mpdDeletePos0(0);
      await sleep(120);
    }
  } catch (e) {}

  const st2 = await mpdGetStatus();
  const hasCurrent2 = st2 && st2.song !== null && st2.song !== undefined && Number.isFinite(Number(st2.song));
  try { await mpdStop(); } catch (e) {}
  return { ok: !hasCurrent2, cleared: !hasCurrent2, tries: 7 };
}

async function mpdPrimeIfIdle() {
  const st = await mpdGetStatus();

  const state = String(st && st.state ? st.state : '').trim().toLowerCase();
  const song = (st && st.song !== undefined && st.song !== null && String(st.song).trim() !== '')
    ? Number(st.song)
    : null;
  const playlistlength = (st && st.playlistlength !== undefined && st.playlistlength !== null)
    ? Number(st.playlistlength)
    : 0;

  // 1) If MPD is engaged, never touch it
  if (state === 'play' || state === 'pause') {
    return { primed: false, skipped: true, reason: 'mpd_active', state: state };
  }

  // 2) If stopped but already has a current song selected, no need to prime
  if (state === 'stop' && song !== null && Number.isFinite(song) && song >= 0) {
    return { primed: false, skipped: true, reason: 'already_has_current', state: state, song: song };
  }

  // 3) If playlist empty, nothing to do
  if (!Number.isFinite(playlistlength) || playlistlength <= 0) {
    return { primed: false, skipped: true, reason: 'empty_playlist', state: state };
  }

  // 4) Legacy random mode is no longer a playback policy. Turn it off and
  // physically shuffle the queue before choosing its head. `playid`
  // intentionally selects an exact ID, so leaving random enabled would be
  // misleading and would make later playback semantics inconsistent.
  const statusRaw = await mpdQueryRaw('status');
  const randomOn = String(parseMpdKeyVals(statusRaw)?.random || '0').trim() === '1';
  let shuffled = false;
  if (randomOn) {
    const randomOffRaw = await mpdQueryRaw('random 0');
    if (mpdHasACK(randomOffRaw)) {
      throw new Error('MPD rejected disabling random mode during prime');
    }
    if (playlistlength > 1) {
      const shuffleRaw = await mpdQueryRaw('shuffle');
      if (mpdHasACK(shuffleRaw)) {
        throw new Error('MPD rejected queue shuffle during prime');
      }
      shuffled = true;
    }
  }

  // 5) Select the queue head by stable MPD song ID, not by position. A
  // positional `play` can race with queue edits while the prime is settling.
  const head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1', 10000));
  const songId = Number.parseInt(String(head?.id ?? '').trim(), 10);
  if (!Number.isSafeInteger(songId) || songId < 0) {
    return {
      primed: false,
      skipped: true,
      reason: 'queue_head_missing_songid',
      state: state,
      random: randomOn,
      shuffled,
    };
  }

  let playidSent = false;
  try {
    await mpdPlayId(songId);
    playidSent = true;

    // Wait for both status and currentsong to identify the exact stable song
    // before pausing. This keeps the prime useful to callers that immediately
    // inspect the selected/current track.
    const waitStartedAt = Date.now();
    let ready = null;
    for (let i = 0; i < 30; i++) {
      const status = parseMpdKeyVals(await mpdQueryRaw('status'));
      const statusSongId = Number.parseInt(String(status?.songid ?? '').trim(), 10);
      if (statusSongId === songId) {
        const current = parseMpdFirstBlock(await mpdQueryRaw('currentsong'));
        const currentSongId = Number.parseInt(String(current?.id ?? '').trim(), 10);
        if (currentSongId === songId) {
          ready = { status, current };
          break;
        }
      }
      await sleep(50);
    }

    if (!ready) {
      throw new Error(`MPD did not select queue head songid ${songId}`);
    }

    await mpdPause(true);
    return {
      primed: true,
      skipped: false,
      reason: 'idle_primed',
      state_before: state,
      random: randomOn,
      shuffled,
      songId,
      song: Number.parseInt(String(ready.status?.song ?? '').trim(), 10),
      waitMs: Date.now() - waitStartedAt,
    };
  } catch (e) {
    // Never leave audible playback running if the readiness check fails.
    if (playidSent) {
      try { await mpdPause(true); } catch {}
    }
    throw e;
  }
}

/* =========================
 * Ratings (stickers)
 * ========================= */


// =========================
// Rating cache (shared)
// =========================
const RATING_CACHE_MS = 2500;

let ratingCache = {
  file: '',
  ts: 0,
  rating: 0,
  disabled: true,
  err: '',
};


// Cached wrapper used by /now-playing
// - Honors "disabled" (streams/airplay) if caller passes that in later (optional)
// - Never returns disabled:true just because cache is stale
// - Treats cache as authoritative immediately after bumpRatingCache()
async function getRatingForFileCached(file) {
  const f = String(file || '').trim();
  if (!f) return { rating: 0, disabled: true, err: 'no-file' };

  const now = Date.now();

  // Cache hit
  if (
    ratingCache &&
    ratingCache.file === f &&
    Number.isFinite(ratingCache.ts) &&
    (now - ratingCache.ts) < RATING_CACHE_MS
  ) {
    return {
      rating: Number(ratingCache.rating) || 0,
      disabled: !!ratingCache.disabled,
      err: String(ratingCache.err || ''),
      source: 'cache',
    };
  }

  // Cache miss → ask MPD
  try {
    const rating = Number(await getRatingForFile(f)) || 0;

    ratingCache = {
      file: f,
      ts: now,
      rating,
      disabled: false,
      err: '',
    };

    return { rating, disabled: false, err: '', source: 'mpd' };
  } catch (e) {
    const msg = e?.message || String(e);

    // IMPORTANT: don't poison the cache with "disabled:true" permanently.
    // Instead, cache the error briefly so we don't spam MPD, but keep "disabled:false"
    // so the UI doesn't hide stars just because MPD hiccupped.
    ratingCache = {
      file: f,
      ts: now,
      rating: Number(ratingCache?.file === f ? ratingCache.rating : 0) || 0,
      disabled: false,
      err: msg,
    };

    return {
      rating: Number(ratingCache.rating) || 0,
      disabled: false,
      err: msg,
      source: 'error',
    };
  }
}

// Used by POST /rating/current so UI updates immediately
function bumpRatingCache(file, rating) {
  const f = String(file || '').trim();
  if (!f) return;
  ratingCache = { file: f, ts: Date.now(), rating: clampRating(rating) ?? 0, disabled: false, err: '' };
}

async function getRatingForFile(file) {
  const f = String(file || '').trim();
  if (!f || isStreamPath(f) || isAirplayFile(f)) return 0;

  const v = await mpdStickerGetSong(f, 'rating'); // "5" or ""
  const n = clampRating(v);
  return n ?? 0;
}

// VIP/off-script playback uses one-star tracks as an omission marker.  The
// legacy album and playlist loaders populate MPD directly, so filter their
// loaded queue after resolving it.  This is opt-in; ordinary Alexa requests
// retain their existing behavior unless they explicitly request the filter.
async function removeOneStarTracksFromQueue() {
  const blocks = parseMpdPlaylistBlocks(await mpdQueryRaw('playlistinfo'));
  let removed = 0;
  for (const block of blocks) {
    const file = String(block?.file || '').trim();
    const id = Number(block?.id);
    if (!file || !Number.isFinite(id) || id < 0) continue;
    let rating = 0;
    try { rating = Number(await getRatingForFile(file)) || 0; } catch (_) { rating = 0; }
    if (rating !== 1) continue;
    await mpdQueryRaw(`deleteid ${id}`);
    removed += 1;
  }
  return { removed, remaining: Math.max(0, blocks.length - removed) };
}


/* =========================
 * Local file mapping + tag reading
 * ========================= */

function mpdFileToLocalPath(mpdFile) {
  const f = String(mpdFile || '').trim();
  if (!f || isStreamPath(f) || isAirplayFile(f)) return '';
  if (!f.startsWith(MOODE_USB_PREFIX)) return '';

  // Build a clean absolute path on the Pi4 mount
  const rel = f.slice(MOODE_USB_PREFIX.length).replace(/^\/+/, '');
  return path.join(PI4_MOUNT_BASE, rel);
}

function safeIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

const sourceAudioProbe = createSourceAudioProbe({
  resolveFile: async (file) => {
    const localPath = mpdFileToLocalPath(file);
    return localPath && safeIsFile(localPath) ? localPath : '';
  },
  cachePath: RUNTIME_STATE_PATHS.sourceAudioCachePath,
});

const liveRadioAudioProbe = createLiveRadioAudioProbe({
  // Use the API's read-only fetch boundary rather than accepting a URL from a
  // diagnostic request. The probe itself validates every initial/redirect URL.
  fetchImpl: fetch,
  capabilities: RUNTIME_CAPABILITIES,
});

async function getActiveRadioStream() {
  const [statusRaw, songRaw] = await Promise.all([
    mpdQueryRaw('status'),
    mpdQueryRaw('currentsong'),
  ]);
  if (mpdHasACK(statusRaw) || mpdHasACK(songRaw)) return null;

  const status = parseMpdKeyVals(statusRaw);
  if (String(status?.state || '').trim().toLowerCase() !== 'play') return null;
  const song = parseMpdKeyVals(songRaw);
  const url = String(song?.file || '').trim();
  if (getStreamKind(url) !== 'radio') return null;

  const songId = String(song?.id || status?.songid || status?.song || '').trim();
  return {
    owner: 'server-mpd-current',
    active: true,
    kind: 'radio',
    url,
    streamKey: `${songId}:${url}`,
  };
}

async function runCmdQuiet(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

async function metaflacTag(tag, filePath) {
  const out = await runCmdQuiet(METAFLAC, [`--show-tag=${tag}`, filePath]);
  const line = out.split('\n').find((l) => l.includes('='));
  return line ? line.split('=', 2)[1].trim() : '';
}

async function metaflacTagMulti(tag, filePath) {
  const out = await runCmdQuiet(METAFLAC, [`--show-tag=${tag}`, filePath]);
  return out
    .split('\n')
    .map((l) => l.split('=', 2)[1]?.trim())
    .filter(Boolean);
}

const deepTagCache = new Map();
const DEEP_TAG_CACHE_MAX = Number(process.env.DEEP_TAG_CACHE_MAX || '2000');
const DEEP_TAG_CACHE_TTL_MS = Number(process.env.DEEP_TAG_CACHE_TTL_MS || '120000');

function deepTagCacheSet(key, value) {
  // Simple cap to avoid unbounded growth. Oldest eviction is fine here.
  if (deepTagCache.size >= DEEP_TAG_CACHE_MAX) {
    const firstKey = deepTagCache.keys().next().value;
    if (firstKey !== undefined) deepTagCache.delete(firstKey);
  }
  deepTagCache.set(key, { ts: Date.now(), value });
}

async function getDeepMetadataCached(mpdFile) {
  const empty = { year: '', label: '', producer: '', performers: [] };
  const f = String(mpdFile || '').trim();
  if (!f) return empty;

  const cached = deepTagCache.get(f);
  if (cached) {
    const ageMs = Date.now() - Number(cached.ts || 0);
    if (ageMs >= 0 && ageMs < DEEP_TAG_CACHE_TTL_MS) return cached.value;
    deepTagCache.delete(f);
  }

  const p = mpdFileToLocalPath(f);
  if (!p || !safeIsFile(p)) {
    deepTagCacheSet(f, empty);
    return empty;
  }

  const dateRaw = await metaflacTag('DATE', p);
  const year =
    (await metaflacTag('ORIGINALYEAR', p)) ||
    extractYear(await metaflacTag('ORIGINALDATE', p)) ||
    extractYear(dateRaw) ||
    '';

  const deep = {
    year,
    label: await metaflacTag('LABEL', p),
    producer: await metaflacTag('PRODUCER', p),
    performers: await metaflacTagMulti('PERFORMER', p),
  };

  deepTagCacheSet(f, deep);
  return deep;
}


function isRelativeMoodeCover(s) {
  const t = String(s || '').trim();
  return t.startsWith('/coverart.php/') || t.startsWith('/');
}


async function buildArtDerivatives(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('art url empty');

  // allow relative moOde cover refs like "/coverart.php/..."
  if (isRelativeMoodeCover(url) && !/^https?:\/\//i.test(url)) {
    url = normalizeCoverUrl(url, MOODE_BASE_URL);
  }

  const r = await fetch(url, { dispatcher: dispatcherForUrl(url), cache: 'no-store' });
  if (!r.ok) throw new Error(`art fetch failed: ${r.status}`);
  const input = Buffer.from(await r.arrayBuffer());

  const out640 = await sharp(input)
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  const outBG = await sharp(input)
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .blur(18)
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();

  return { out640, outBG };
}



async function updateArtCacheIfNeeded(rawArtUrl) {
  try {
    const key = normalizeArtKey(rawArtUrl);
    if (!key) return false;

    await ensureDir(ART_CACHE_DIR);

    const p640 = artPath640ForKey(key);
    const pbg  = artPathBgForKey(key);

    // If cached, refresh the "current_*" pointers when the key changes
    if (safeIsFile(p640) && safeIsFile(pbg)) {
      if (key !== lastArtKeyBuilt) {
        try {
          const [buf640, bufBG] = await Promise.all([
            fs.promises.readFile(p640),
            fs.promises.readFile(pbg),
          ]);

          await Promise.all([
            writeFileAtomic(ART_640_PATH, buf640),
            writeFileAtomic(ART_BG_PATH,  bufBG),
          ]);

          lastArtKeyBuilt = key;
        } catch {
          // ignore; caller will fall back to direct fetch/resize
        }
      }
      return true;
    }

    // Not cached yet → build derivatives from the provided URL
    const { out640, outBG } = await buildArtDerivatives(rawArtUrl);

    // Persist keyed cache + update "current_*" pointers
    await Promise.all([
      writeFileAtomic(p640, out640),
      writeFileAtomic(pbg,  outBG),
      writeFileAtomic(ART_640_PATH, out640),
      writeFileAtomic(ART_BG_PATH,  outBG),
    ]);

    lastArtKeyBuilt = key;
    log.debug('[art] rebuilt', { key, p640, pbg });
    return true;
  } catch (e) {
    log.debug('[art] cache build skipped:', e?.message || String(e));
    return false;
  }
}

// =========================
// Favorites (via MPD playlist, NOT filesystem)
// =========================

let favoritesCache = {
  ts: 0,
  set: new Set(),
  err: '',
};

function parseListPlaylistFiles(raw) {
  // listplaylist returns lines like: "file: USB/....flac"
  const out = new Set();
  const lines = String(raw || '').split('\n');

  for (const line0 of lines) {
    const line = String(line0 || '').trim();
    if (!line) continue;

    // ✅ ignore greeting
    if (line.startsWith('OK MPD ')) continue;

    // ✅ stop only on terminal OK
    if (line === 'OK') break;

    // stop on error
    if (/^ACK\b/.test(line)) break;

    const m = line.match(/^file:\s*(.+)\s*$/i);
    if (m && m[1]) out.add(m[1].trim());
  }

  return out;
}

async function refreshFavoritesFromMpd() {
  const name = String(FAVORITES_PLAYLIST_NAME || 'Favorites').trim();
  const raw = await mpdQueryRaw(`listplaylist ${mpdEscapeValue(name)}`);

  if (!raw || mpdHasACK(raw)) {
    favoritesCache = { ts: Date.now(), set: new Set(), err: 'playlist-missing-or-ack' };
    return favoritesCache;
  }

  favoritesCache = {
    ts: Date.now(),
    set: parseListPlaylistFiles(raw),
    err: '',
  };
  return favoritesCache;
}

async function isFavoriteInPlaylist(mpdFile, debugObj = null) {
  const f = String(mpdFile || '').trim();
  if (!f || isStreamPath(f) || isAirplayFile(f)) return false;

  const now = Date.now();
  const ttl = Number(FAVORITES_REFRESH_MS || 3000);

  // Refresh if stale OR cache empty OR cache doesn't contain the file (one forced retry)
  let didRefresh = false;

  const maybeRefresh = async (why) => {
    didRefresh = true;
    try {
      await refreshFavoritesFromMpd();
    } catch {}
    if (debugObj) debugObj.refreshWhy = why;
  };

  if (!favoritesCache.ts || (now - favoritesCache.ts) > ttl) {
    await maybeRefresh('stale');
  } else if (!favoritesCache.set || favoritesCache.set.size === 0) {
    await maybeRefresh('empty');
  }

  let has = favoritesCache.set.has(f);

  // If not found, force ONE refresh (covers “poisoned” cache + MPD changes)
  if (!has && !didRefresh) {
    await maybeRefresh('miss-force');
    has = favoritesCache.set.has(f);
  }

  if (debugObj) {
    debugObj.file = f;
    debugObj.cacheAgeMs = favoritesCache.ts ? (now - favoritesCache.ts) : null;
    debugObj.cacheSize = favoritesCache.set ? favoritesCache.set.size : null;
    debugObj.cacheErr = favoritesCache.err || '';
    debugObj.has = has;
    // helpful: show first few entries (sanitized)
    debugObj.sample = Array.from(favoritesCache.set).slice(0, 3);
  }

  return has;
}

async function mpdDeletePos0(pos0) {
  const n = Number(pos0);
  if (!Number.isFinite(n) || n < 0) throw new Error('bad pos0');
  await mpdQueryRaw(`delete ${n}`);
  return true;
}

async function mpdDeleteId(songid) {
  const id = Number(songid);
  if (!Number.isFinite(id) || id < 0) throw new Error('bad songid');
  await mpdQueryRaw(`deleteid ${id}`);
  return true;
}

async function mpdPlaylistInfoById(songid) {
  if (songid === '' || songid === null || songid === undefined) return null;
  const raw = await mpdQueryRaw(`playlistid ${songid}`);
  if (!raw || mpdHasACK(raw)) return null;

  const kv = parseMpdFirstBlock(raw);
  const file = kv.file || '';
  const title = kv.title || '';
  const artist = kv.artist || '';
  const album = kv.album || '';
  const id = kv.id || String(songid);
  const pos = kv.pos || '';

  if (!file && !title && !artist) return null;
  return { file, title, artist, album, songid: id, songpos: pos };
}

async function mpdPlaylistInfoByPos(songpos) {
  const n = Number(songpos);
  if (!Number.isFinite(n) || n < 0) return null;

  const raw = await mpdQueryRaw(`playlistinfo ${n}:${n + 1}`);
  if (!raw || mpdHasACK(raw)) return null;

  const kv = parseMpdFirstBlock(raw);
  const file   = kv.file   || '';
  const title  = kv.title  || '';
  const artist = kv.artist || '';
  const album  = kv.album  || '';
  const id     = kv.id     || '';
  const pos    = kv.pos    || String(n);

  if (!file && !title && !artist) return null;
  return { file, title, artist, album, songid: id, songpos: pos };
}

function parseMpdPlaylistBlocks(raw) {
  const lines = String(raw || '').split('\n');
  const blocks = [];
  let cur = null;

  for (const line0 of lines) {
    const line = String(line0 || '').trim();
    if (!line || line === 'OK' || line.startsWith('OK MPD ') || line.startsWith('ACK')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();

    if (k === 'file') {
      if (cur && cur.file) blocks.push(cur);
      cur = { file: v };
      continue;
    }

    if (!cur) cur = {};
    cur[k] = v;
  }

  if (cur && cur.file) blocks.push(cur);
  return blocks;
}

function isHolidayLikeGenre(genreStr) {
  const s = String(genreStr || '').toLowerCase();
  if (!s) return false;
  return /(christmas|xmas|holiday|noel)/i.test(s);
}

function isPodcastLikeGenre(genreStr) {
  const s = String(genreStr || '').toLowerCase();
  if (!s) return false;
  return /\bpodcast\b/i.test(s);
}

function isHolidayLikeTrackMeta(block) {
  const b = block || {};
  const blob = [
    b.genre,
    b.title,
    b.album,
    b.file,
    b.artist,
    b.albumartist,
  ].filter(Boolean).join(' | ').toLowerCase();
  if (!blob) return false;

  return /(christmas|xmas|holiday|noel|yuletide|silent\s+night|jingle|santa|sleigh|winter\s+wonderland|merry\s+christmas|a\s+christmas\s+song)/i.test(blob);
}

const RUNTIME_CONFIG_PATH = RUNTIME_STATE_PATHS.configPath;
function normalizeAliasKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\bjunior\b/g, 'jr')
    .replace(/\bjr\.?\b/g, 'jr')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveArtistAlias(artistRaw) {
  const artist = String(artistRaw || '').trim();
  if (!artist) return '';
  try {
    const cfg = JSON.parse(await fsp.readFile(RUNTIME_CONFIG_PATH, 'utf8'));
    const aliases = cfg?.alexa?.artistAliases || {};
    const want = normalizeAliasKey(artist);
    for (const [k, v] of Object.entries(aliases)) {
      if (normalizeAliasKey(k) === want && String(v || '').trim()) {
        return String(v).trim();
      }
    }
  } catch {}
  return artist;
}

async function resolveAlbumAlias(albumRaw) {
  const album = String(albumRaw || '').trim();
  if (!album) return '';
  try {
    const cfg = JSON.parse(await fsp.readFile(RUNTIME_CONFIG_PATH, 'utf8'));
    const aliases = cfg?.alexa?.albumAliases || {};
    const want = normalizeAliasKey(album);
    for (const [k, v] of Object.entries(aliases)) {
      if (normalizeAliasKey(k) === want && String(v || '').trim()) {
        return String(v).trim();
      }
    }
  } catch {}
  return album;
}

async function resolvePlaylistAlias(playlistRaw) {
  const playlist = String(playlistRaw || '').trim();
  if (!playlist) return '';
  try {
    const cfg = JSON.parse(await fsp.readFile(RUNTIME_CONFIG_PATH, 'utf8'));
    const aliases = cfg?.alexa?.playlistAliases || {};
    const want = normalizeAliasKey(playlist);
    for (const [k, v] of Object.entries(aliases)) {
      if (normalizeAliasKey(k) === want && String(v || '').trim()) {
        return String(v).trim();
      }
    }
  } catch {}
  return playlist;
}

function isLibraryFile(mpdFile) {
  const f = String(mpdFile || '').trim();
  return !!f && !isStreamPath(f) && !isAirplayFile(f) && f.startsWith(MOODE_USB_PREFIX);
}

async function mpdFindFirstLocalByTag(tag, value) {
  if (!tag || !value) return '';

  const raw = await mpdQueryRaw(`find ${tag} ${mpdEscapeValue(value)}`);
  if (!raw || mpdHasACK(raw)) return '';

  // Minimal parse: find first "file:" occurrence
  const lines = String(raw).split('\n');
  for (const line of lines) {
    if (!line.toLowerCase().startsWith('file:')) continue;
    const f = line.slice(line.indexOf(':') + 1).trim();
    if (isLibraryFile(f)) return f;
  }
  for (const line of lines) {
    if (!line.toLowerCase().startsWith('file:')) continue;
    const f = line.slice(line.indexOf(':') + 1).trim();
    if (f && !isStreamPath(f) && !isAirplayFile(f)) return f;
  }
  return '';
}

/**
 * Resolve a UPnP/HTTP stream track to a local library file, when possible.
 * Guarded so we do nothing (and log nothing) when inputs are empty.
 */
async function resolveLibraryFileForStream(inputs, debugLog = null) {
  const songid  = String(inputs?.songid  || '').trim();
  const songpos = String(inputs?.songpos || '').trim();
  let title     = String(inputs?.title   || '').trim();
  let artist    = String(inputs?.artist  || '').trim();
  let album     = String(inputs?.album   || '').trim();
  let track     = String(inputs?.track   || '').trim();

  // If literally nothing to resolve, bail silently.
  if (!songid && !songpos && !title && !artist && !album && !track) return '';

  let mbTrackId = '';

  // Prefer songpos → playlistinfo (pulls musicbrainz_trackid when available)
  if (songpos) {
    const n = Number(songpos);
    if (Number.isFinite(n) && n >= 0) {
      const cmd = `playlistinfo ${n}:${n + 1}`;
      const raw = await mpdQueryRaw(cmd);

      if (debugLog) {
        debugLog('[resolver:playlistinfo-raw]', {
          cmd,
          rawLen: raw.length,
          hasACK: mpdHasACK(raw),
          head: raw.slice(0, 500),
        });
      }

      if (raw && !mpdHasACK(raw)) {
        const kv = parseMpdFirstBlock(raw);
        mbTrackId = kv.musicbrainz_trackid || '';
        title  = kv.title  || title  || '';
        artist = kv.artist || artist || '';
        album  = kv.album  || album  || '';
        track  = kv.track  || track  || '';
      }
    }
  }

  if (debugLog) {
    debugLog('[resolver:after-songpos]', { songpos, songid, mbTrackId, title, artist, album, track });
  }

  // Fallback songid → playlistid
  if (!mbTrackId && songid) {
    const raw = await mpdQueryRaw(`playlistid ${songid}`);
    if (raw && !mpdHasACK(raw)) {
      const kv = parseMpdFirstBlock(raw);
      mbTrackId = kv.musicbrainz_trackid || '';
      title  = title  || kv.title  || '';
      artist = artist || kv.artist || '';
      album  = album  || kv.album  || '';
      track  = track  || kv.track  || '';
    }
  }

  if (mbTrackId) {
    const f = await mpdFindFirstLocalByTag('MUSICBRAINZ_TRACKID', mbTrackId);
    if (f) return f;
  }

  // Loose fallback heuristics
  if (title) {
    const f1 = await mpdFindFirstLocalByTag('Title', title);
    if (f1) return f1;
  }
  if (album) {
    const f2 = await mpdFindFirstLocalByTag('Album', album);
    if (f2) return f2;
  }
  if (track && album) {
    const f3 = await mpdFindFirstLocalByTag('Track', track);
    if (f3) return f3;
  }

  return '';
}

/* =========================
 * iTunes artwork cache (radio)
 * ========================= */

const itunesArtCache = new Map();
const appleMusicWebCache = new Map();
const APPLE_MUSIC_WEB_TTL_MS = 1000 * 60 * 10;
let itunesBackoffUntil = 0;
let itunesBackoffReason = '';
let itunesNextAllowedTs = 0;

async function waitForItunesSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, itunesNextAllowedTs - now);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  // 20/min limit => 3000ms spacing; use 3200ms safety margin
  itunesNextAllowedTs = Date.now() + 3200;
}

function pickArtFromItunesItem(item) {
  let art = item?.artworkUrl100 || '';
  if (art) art = art.replace(/\/\d+x\d+bb\./, '/600x600bb.');
  return art;
}

function pickAlbumAndYearFromItunesItem(item) {
  const album = item?.collectionName || '';
  const year = item?.releaseDate ? String(item.releaseDate).slice(0, 4) : '';
  return { album, year };
}

/* ============================================================
 * Radio/classical title cleanup for iTunes
 * ============================================================ */

function normalizeDashSpacing(s) {
  return String(s || '')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(str) {
  // Server-side: you may not have DOM. If your upstream can include entities,
  // keep it conservative: only decode a few common ones.
  // If you already decode upstream, you can replace this with: return String(str||'');
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function titleCaseArtistName(input) {
  const value = decodeHtmlEntities(String(input || '').replace(/\s+/g, ' ').trim());
  if (!value) return '';

  const preserve = new Set([
    'AC/DC', 'ABBA', 'BTS', 'DJ', 'MC', 'M.C.', 'R.E.M.', 'SZA', 'U2', 'UB40',
    'NPR', 'BBC', 'PBS', 'CBS', 'NBC', 'ABC', 'CNN', 'ESPN', 'MLB', 'NFL', 'NBA',
  ]);
  const words = value.split(/(\s+)/);
  const needsNormalization = !(/[a-zà-öø-ÿ]/.test(value) && /[A-ZÀ-ÖØ-Þ]/.test(value)) ||
    !(/[A-ZÀ-ÖØ-Þ]/.test(value) && /[a-zà-öø-ÿ]/.test(value)) ||
    words.some((word) => /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’.-]{2,}$/.test(word));
  if (!needsNormalization) return value;

  const titleWord = (word) => {
    if (!word) return word;
    if (preserve.has(word.toUpperCase())) return word.toUpperCase();
    if (/^(?:[A-ZÀ-ÖØ-Þ]\.){2,}$/i.test(word)) return word.toUpperCase();

    const lower = word.toLocaleLowerCase();
    const cased = lower.replace(/(^|[-–—'’])([a-zà-öø-ÿ])/gi, (_, prefix, ch) => `${prefix}${ch.toLocaleUpperCase()}`);
    const digitLead = cased.replace(/^(\d+)([a-zà-öø-ÿ])/, (_, digits, ch) => `${digits}${ch.toLocaleUpperCase()}`);
    return digitLead.replace(/^mc([a-zà-öø-ÿ])/i, (_, ch) => `Mc${ch.toLocaleUpperCase()}`);
  };

  return words.map((word) => /^\s+$/.test(word) ? word : titleWord(word)).join('');
}

function looksLikeEnsembleOrConductor(s) {
  const t = String(s || '').toLowerCase();

  // quick structural tells
  if (t.includes(' / ')) return true;        // "Orch / Conductor"
  if (t.includes('orch')) return true;
  if (t.includes('orchestra')) return true;

  return /orchester|orchestra|ensemble|phil(harm|harmon)|symph|sinfon|choir|chor|quartet|quintet|trio|dirig|conduct|conductor/i.test(s);
}

function looksLikeLabelish(s) {
  const t = String(s || '').trim().toLowerCase();
  return /^(telarc|decca|dg|dgg|sony|emi|rca|naxos|hyperion|harmonia\s+mundi|chandos|philips|warner|erato|ecm|blue\s+note|verve)$/i.test(t);
}

function looksLikePersonName(s) {
  // 2–4 words, name-like (helps detect composer in classical strings)
  const t = String(s || '').trim();
  return /^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+){1,3}$/.test(t);
}

function teaseWorkAndComposerFromTitle(titleLine, radioAlbum = '') {
  const raw = normalizeDashSpacing(decodeHtmlEntities(String(titleLine || '').trim()));
  if (!raw) return { composer: '', work: '' };

  const album = normalizeDashSpacing(decodeHtmlEntities(String(radioAlbum || '').trim()));

  // Split on " - " (this is what your stream is using)
  const parts = raw.split(' - ').map(p => p.trim()).filter(Boolean);

  // Pattern: "Composer - Work - Ensemble/Conductor - Album - Label"
  if (parts.length >= 2 && looksLikePersonName(parts[0])) {
    const candidateWork = parts[1];
    if (
      candidateWork &&
      !looksLikeEnsembleOrConductor(candidateWork) &&
      !looksLikeLabelish(candidateWork)
    ) {
      return { composer: parts[0], work: candidateWork };
    }
  }

  // Pattern: "Composer: Work -- Movement" or "Composer: Work - ..."
  const m = raw.match(/^([^:]{3,60})\s*:\s*(.+)$/);
  if (m) {
    const composer = m[1].trim();
    const rest = m[2].trim();
    if (composer && rest) {
      const restParts = rest.split(' - ').map(p => p.trim()).filter(Boolean);
      return { composer, work: restParts[0] || rest };
    }
  }

  // If album appears in parts, choose the segment immediately before it
  if (album && parts.length >= 2) {
    const idx = parts.findIndex(p => p.toLowerCase() === album.toLowerCase());
    if (idx > 0) {
      const candidate = parts[idx - 1];
      if (
        candidate &&
        !looksLikeEnsembleOrConductor(candidate) &&
        !looksLikeLabelish(candidate)
      ) {
        const composer = looksLikePersonName(parts[0]) ? parts[0] : '';
        return { composer, work: candidate };
      }
    }
  }

  // Fallback: first segment after the first that doesn't look like ensemble/label/album
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (album && p.toLowerCase() === album.toLowerCase()) continue;
    if (looksLikeLabelish(p)) continue;
    if (looksLikeEnsembleOrConductor(p)) continue;
    return { composer: looksLikePersonName(parts[0]) ? parts[0] : '', work: p };
  }

  // Last resort: use raw (but don’t pretend we extracted)
  return { composer: '', work: raw };
}

function buildItunesTerm(artist, title, opts = {}) {
  const aRaw = String(artist || '').trim();
  const tRaw = String(title || '').trim();
  const album = String(opts.radioAlbum || '').trim();
  const explicitComposer = String(opts.composer || '').trim();
  const ensembleHint = String(opts.ensembleHint || '').trim();
  const conductorHint = String(opts.conductorHint || '').trim();
  const preserveTitle = !!opts.preserveTitle;

  // If title is clearly a “metadata soup” classic pattern, try teasing it.
  const teased = teaseWorkAndComposerFromTitle(tRaw, album);

  // Decide what we trust:
  // - If we successfully teased a "work" that is shorter/cleaner, prefer it.
  // - Keep composer if present (even if artist is junky).
  const work = String(teased.work || '').trim();
  const composer = String(teased.composer || '').trim();

  // Heuristic: if teased work is materially shorter than raw and not ensemble-ish, use it.
  const useTeased =
    !preserveTitle &&
    !!work &&
    work.length >= 3 &&
    work.length <= 80 &&
    work.length < (tRaw.length * 0.75) &&
    !looksLikeEnsembleOrConductor(work) &&
    !looksLikeLabelish(work);

  const finalTitle = useTeased ? work : tRaw;

  // Artist selection:
  // - If composer exists, it’s often better than a polluted "artist" field.
  // - Otherwise keep artist if present.
  const finalArtist = composer || aRaw;

  const termParts = [];
  const addTermPart = (value) => {
    const part = String(value || '').trim();
    if (!part) return;
    const lower = part.toLowerCase();
    if (termParts.some((existing) => existing.toLowerCase() === lower)) return;
    termParts.push(part);
  };
  addTermPart(explicitComposer);
  addTermPart(finalTitle);
  addTermPart(finalArtist);
  addTermPart(ensembleHint);
  addTermPart(conductorHint);
  const term = termParts.join(' ').trim();

  return {
    term,
    debug: {
      aRaw,
      tRaw,
      album,
      explicitComposer,
      ensembleHint,
      conductorHint,
      preserveTitle,
      composer,
      work,
      useTeased,
      finalArtist,
      finalTitle,
    },
  };
}

/* ============================================================
 * iTunes lookup (rewritten)
 * - keeps your caching behavior
 * - uses cleaned term for classical/radio soup titles
 * ============================================================ */

function splitPrimaryArtistPart(s) {
  return String(s || '')
    .split(/\bfeat\.?\b|\bfeaturing\b|\bwith\b|,|&|\band\b|\bx\b|\+/i)[0]
    .trim();
}

function artistMatchStrict(targetArtist, candArtist) {
  const t = splitPrimaryArtistPart(targetArtist).toLowerCase();
  const c = splitPrimaryArtistPart(candArtist).toLowerCase();
  if (!t || !c) return false;
  return c === t || c.includes(t) || t.includes(c);
}

function normLoose(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function albumHintMatches(hint, collectionName) {
  const h = normLoose(hint);
  const c = normLoose(collectionName);
  if (!h || !c) return false;
  if (c.includes(h) || h.includes(c)) return true;
  const hTok = h.split(' ').filter(Boolean);
  const cTok = new Set(c.split(' ').filter(Boolean));
  const overlap = hTok.filter((t) => cTok.has(t)).length;
  return overlap >= Math.max(2, Math.floor(hTok.length * 0.5));
}

function extractOpusNums(s) {
  const txt = String(s || '').toLowerCase();
  const out = new Set();
  const re = /\bop\.?\s*(\d{1,3})\b/g;
  let m;
  while ((m = re.exec(txt))) out.add(String(m[1]));
  return out;
}

function tokenOverlapCount(a, b) {
  const ta = String(a || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x && x.length > 2);
  const tb = new Set(String(b || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x && x.length > 2));
  return ta.filter((x) => tb.has(x)).length;
}

function ensembleTokenSet(s) {
  const stop = new Set(['orchestra','symphony','philharmonic','phil','ensemble','chamber','the']);
  return new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((x) => x && x.length > 2 && !stop.has(x))
  );
}

function overlapCount(setA, setB) {
  let n = 0;
  for (const t of setA) if (setB.has(t)) n += 1;
  return n;
}

function ensembleMatchesCandidate(hint, candArtist, candAlbum) {
  const h = ensembleTokenSet(hint);
  if (!h.size) return true;
  const c = ensembleTokenSet(`${candArtist || ''} ${candAlbum || ''}`);
  if (!c.size) return false;
  return overlapCount(h, c) >= 1;
}

function movementTokenSet(s) {
  const m = String(s || '').toLowerCase();
  const out = new Set();
  if (/\bscherzo\b/.test(m)) out.add('scherzo');
  if (/\btrio\b/.test(m)) out.add('trio');
  if (/\bfinale\b/.test(m)) out.add('finale');
  if (/\badagio\b/.test(m)) out.add('adagio');
  if (/\ballegro\b/.test(m)) out.add('allegro');
  const mv = m.match(/(?:^|\W)([1-9])\s*[.)]/);
  if (mv) out.add(`mv${mv[1]}`);
  const romans = m.match(/(?:^|\W)(i{1,3}|iv|v|vi{0,3}|ix|x)\s*\./g) || [];
  for (const r of romans) {
    const tok = String(r).replace(/[^ivx]/g, '');
    if (tok) out.add(`rm${tok}`);
  }
  return out;
}

function nameTokenSet(s) {
  return new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((x) => x && x.length > 2 && !/^(van|von|der|den|the|and)$/.test(x))
  );
}

function extractLabelHintFromRawTitle(raw) {
  const s = decodeHtmlEntities(String(raw || '').trim());
  if (!s || !/\s-\s/.test(s)) return '';
  const parts = s.split(/\s-\s/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) return '';
  const last = String(parts[parts.length - 1] || '').trim();
  if (!last) return '';
  if (/\b(wfmt|radio|classical|stream)\b/i.test(last)) return '';
  if (/^[A-Za-z0-9&'’. -]{2,20}$/.test(last)) return last;
  return '';
}

function sanitizeLookupArtistForItunes(v = '') {
  return String(v || '')
    // Drop instrument abbreviations after commas: ", fh", ", p", ", vn", etc.
    .replace(/,\s*(?:fh|hp|harp|p|pf|pno|vn|vln|vc|cello|soprano|mezzo|tenor|baritone)\b/ig, '')
    .replace(/[;|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function shouldAcceptMatchedTitle(rawTitle = '', matchedTitle = '') {
  const a = String(rawTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const b = String(matchedTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(/\s+/).filter((x) => x.length > 2));
  const tb = new Set(b.split(/\s+/).filter((x) => x.length > 2));
  if (!ta.size || !tb.size) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  const ratio = overlap / Math.max(ta.size, tb.size);
  return ratio >= 0.5;
}

async function lookupAppleMusicWebFallback(artist, title, opts = {}) {
  const a = String(artist || '').trim();
  const t = String(title || '').trim();
  if (!a || !t) return null;

  const cacheKey = `${normLoose(a)}|${normLoose(t)}`;
  const now = Date.now();
  const cached = appleMusicWebCache.get(cacheKey);
  if (cached && !opts.debug && (now - Number(cached.ts || 0)) < APPLE_MUSIC_WEB_TTL_MS) {
    return cached.result || null;
  }

  const terms = Array.from(new Set([
    String(opts.searchTerm || '').trim(),
    `${a} ${t}`.trim(),
    `${t} ${a}`.trim(),
  ].filter(Boolean)));

  const readAttr = (tag, name) => {
    const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
    return decodeHtmlEntities(String(tag.match(re)?.[1] || '').trim());
  };

  let found = null;
  try {
    for (const term of terms) {
      const searchUrl = `https://music.apple.com/${encodeURIComponent(ITUNES_COUNTRY)}/search?term=${encodeURIComponent(term)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ITUNES_TIMEOUT_MS);
      let html = '';
      try {
        const response = await fetch(searchUrl, {
          headers: {
            Accept: 'text/html',
            'User-Agent': 'now-playing-next/1.0 (+https://moode.brianwis.com)',
          },
          agent: agentForUrl(searchUrl),
          signal: controller.signal,
          cache: 'no-store',
        });
        html = await response.text();
        if (!response.ok) continue;
      } finally {
        clearTimeout(timer);
      }

      const titleNeedle = normLoose(t);
      const artistNeedle = normLoose(a);
      const anchorRe = /<a\b[^>]*>/gi;
      let match;
      while ((match = anchorRe.exec(html))) {
        const tag = match[0];
        if (!/data-testid\s*=\s*["']click-action["']/i.test(tag)) continue;
        const href = readAttr(tag, 'href');
        const label = readAttr(tag, 'aria-label');
        const trackId = String(href.match(/[?&]i=(\d+)/i)?.[1] || '').trim();
        if (!trackId || !href) continue;

        const labelNorm = normLoose(label);
        if (!labelNorm.includes(titleNeedle) || !labelNorm.includes(artistNeedle)) continue;

        found = { trackId, href, label, searchUrl };
        break;
      }
      if (found) break;
    }

    if (found) {
      const lookupBase = String(ITUNES_SEARCH_URL).replace(/\/search\/?$/i, '/lookup');
      const lookupUrl = `${lookupBase}?id=${encodeURIComponent(found.trackId)}&entity=song`;
      const data = await fetchJsonWithTimeout(lookupUrl, ITUNES_TIMEOUT_MS);
      const item = (Array.isArray(data?.results) ? data.results : [])
        .find((row) => String(row?.trackId || '') === found.trackId);
      const matchedArtist = String(item?.artistName || '').trim();
      const matchedTitle = String(item?.trackName || '').trim();
      const art = pickArtFromItunesItem(item);

      if (
        item && art &&
        artistMatchStrict(a, matchedArtist) &&
        shouldAcceptMatchedTitle(t, matchedTitle)
      ) {
        const picked = pickAlbumAndYearFromItunesItem(item) || {};
        const result = {
          url: art,
          album: String(picked.album || ''),
          year: String(picked.year || ''),
          trackUrl: String(item?.trackViewUrl || found.href || ''),
          albumUrl: String(item?.collectionViewUrl || ''),
          matchedArtist,
          matchedTitle,
          reason: 'ok:web-search',
          webSearchUrl: found.searchUrl,
          webLookupUrl: lookupUrl,
        };
        appleMusicWebCache.set(cacheKey, { ts: now, result });
        return result;
      }
    }
  } catch {
    // Keep the normal iTunes miss behavior if Apple's web surface is unavailable.
  }

  appleMusicWebCache.set(cacheKey, { ts: now, result: null });
  return null;
}

async function lookupItunesFirst(artist, title, debug = false, opts = {}) {
  const a = sanitizeLookupArtistForItunes(String(artist || '').trim());
  const t = String(title || '').trim();

  const now0 = Date.now();
  if (itunesBackoffUntil && now0 < itunesBackoffUntil) {
    const secs = Math.max(1, Math.ceil((itunesBackoffUntil - now0) / 1000));
    return {
      url: '',
      album: '',
      year: '',
      trackUrl: '',
      albumUrl: '',
      reason: `itunes-backoff-active:${secs}s:${itunesBackoffReason || 'rate-limited'}`,
    };
  }

  // ✅ Always return a consistent shape
  const empty = (reason, extra = {}) => ({
    url: '',
    album: '',
    year: '',
    trackUrl: '',
    albumUrl: '',
    matchedArtist: '',
    matchedTitle: '',
    reason,
    ...(debug ? extra : {}),
  });

  if (!a || !t) return empty('missing-artist-or-title');

  // Build a smarter search term (and use it in cache key)
  const built = buildItunesTerm(a, t, opts) || {};
  const termStr = String(built.term || `${a} ${t}`).trim();
  const termDebug = built.debug || {};

  if (!termStr) return empty('missing-term', { term: termStr, termDebug });

  const cacheScope = [
    opts?.strictArtist ? 'strict' : 'loose',
    String(opts?.ensembleHint || '').toLowerCase(),
    String(opts?.conductorHint || '').toLowerCase(),
    String(opts?.soloistHint || '').toLowerCase(),
    String(opts?.labelHint || '').toLowerCase(),
    opts?.classicalAlbumSearch ? 'classical-album-profile2' : '',
    String(opts?.programHint || '').toLowerCase(),
    String(opts?.curatedCollectionId || ''),
  ].join('|');
  const cacheKey = `song|${cacheScope}|${termStr.toLowerCase()}`;
  const now = Date.now();

  // ✅ Cache hit (only when not debugging)
  const cached = itunesArtCache.get(cacheKey);
  if (cached && !debug) {
    const ttl = cached.url ? ITUNES_TTL_HIT_MS : ITUNES_TTL_MISS_MS;
    const allowEmptyCache = !(opts?.albumHint && !cached.url);
    if ((now - (cached.ts || 0)) < ttl && allowEmptyCache) {
      if (!cached.url) {
        const web = await lookupAppleMusicWebFallback(a, t, { searchTerm: termStr });
        if (web?.url) {
          const webCached = {
            url: web.url || '',
            album: web.album || '',
            year: web.year || '',
            trackUrl: web.trackUrl || '',
            albumUrl: web.albumUrl || '',
            matchedArtist: web.matchedArtist || '',
            matchedTitle: web.matchedTitle || '',
            ts: now,
          };
          itunesArtCache.set(cacheKey, webCached);
          return { ...webCached, reason: 'ok:web-search' };
        }
      }
      return {
        url: cached.url || '',
        album: cached.album || '',
        year: cached.year || '',
        trackUrl: cached.trackUrl || '',
        albumUrl: cached.albumUrl || '',
        matchedArtist: cached.matchedArtist || '',
        matchedTitle: cached.matchedTitle || '',
        reason: cached.url ? 'cache-hit' : 'cache-hit-empty',
      };
    }
    itunesArtCache.delete(cacheKey);
  }

  // Some curated station/work matches are known to Apple by album ID but do
  // not survive a performer-heavy Search API query. Resolve the canonical
  // album once, select the matching movement when possible, and cache the
  // result like an ordinary iTunes hit.
  const curatedCollectionId = String(opts?.curatedCollectionId || '').trim();
  if (curatedCollectionId) {
    const lookupBase = String(ITUNES_SEARCH_URL).replace(/\/search\/?$/i, '/lookup');
    const curatedQueryUrl = `${lookupBase}?id=${encodeURIComponent(curatedCollectionId)}&entity=song`;
    try {
      await waitForItunesSlot();
      const curatedData = await fetchJsonWithTimeout(curatedQueryUrl, ITUNES_TIMEOUT_MS);
      const curatedItems = Array.isArray(curatedData?.results) ? curatedData.results : [];
      const curatedTracks = curatedItems.filter((item) => String(item?.wrapperType || '') === 'track');
      const movementTrack = curatedTracks.find((item) => shouldAcceptMatchedTitle(t, String(item?.trackName || '').trim())) || null;
      const item = movementTrack || curatedItems.find((entry) => String(entry?.wrapperType || '') === 'collection') || curatedTracks[0] || null;
      const art = pickArtFromItunesItem(item);
      if (item && art) {
        const picked = pickAlbumAndYearFromItunesItem(item) || {};
        const curatedResult = {
          url: art,
          album: String(picked.album || '').trim(),
          year: String(picked.year || '').trim(),
          trackUrl: String(item?.trackViewUrl || '').trim(),
          albumUrl: String(item?.collectionViewUrl || '').trim(),
          matchedArtist: String(item?.artistName || '').trim(),
          matchedTitle: String(item?.trackName || '').trim(),
          ts: now,
        };
        itunesArtCache.set(cacheKey, curatedResult);
        if (debug) {
          return {
            ...curatedResult,
            reason: 'ok:curated-album',
            queryUrl: curatedQueryUrl,
            term: termStr,
            termDebug,
            resultDebug: {
              totalResults: curatedItems.length,
              curatedCollectionId,
              curatedTrack: String(item?.trackName || ''),
              curatedArtist: String(item?.artistName || ''),
            },
          };
        }
        return { ...curatedResult, reason: 'ok:curated-album' };
      }
    } catch (e) {
      if (debug) dlog('[itunes] curated album lookup failed:', e?.message || String(e));
    }
  }

  const queryUrl =
    `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(termStr)}&entity=song&limit=12`;

  try {
    await waitForItunesSlot();
    const data = await fetchJsonWithTimeout(queryUrl, ITUNES_TIMEOUT_MS);
    // Successful response clears any previous temporary backoff lock.
    itunesBackoffUntil = 0;
    itunesBackoffReason = '';
    let results = Array.isArray(data?.results) ? data.results : [];

    // Retry with looser term when album/program hint over-constrains search.
    if (!results.length) {
      const looseTerms = [];
      const baseLoose = `${a} ${t}`.trim();
      if (baseLoose) looseTerms.push(baseLoose);
      const tTar = String(t || '').replace(/\btarentelle\b/i, 'tarantelle');
      if (tTar !== t) looseTerms.push(`${a} ${tTar}`.trim());
      const tTer = String(t || '').replace(/\btarantelle\b/i, 'tarentelle');
      if (tTer !== t && tTer !== tTar) looseTerms.push(`${a} ${tTer}`.trim());

      for (const lt of looseTerms) {
        if (!lt || lt.toLowerCase() === termStr.toLowerCase()) continue;
        const u2 = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(lt)}&entity=song&limit=12`;
        const d2 = await fetchJsonWithTimeout(u2, ITUNES_TIMEOUT_MS);
        const r2 = Array.isArray(d2?.results) ? d2.results : [];
        if (r2.length) {
          results = r2;
          break;
        }
      }
    }

    let url = '';
    let album = '';
    let year = '';
    let trackUrl = '';
    let albumUrl = '';
    let matchedArtist = '';
    let matchedTitle = '';
    let strictRejected = 0;
    let filteredTitle = 0;
    let matchReason = '';
    let webFallback = null;

    const queryOpus = extractOpusNums(t);
    const queryWork = String(t || '')
      .replace(/,\s*\d+(?:st|nd|rd|th)\s+tableau\s*:\s*.*/i, '')
      .replace(/:\s*[IVXLC]+\.?\s+.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const queryMovement = movementTokenSet(queryWork);
    const conductorHint = String(opts?.conductorHint || '').trim();
    const conductorTokens = ensembleTokenSet(conductorHint);
    const labelHint = String(opts?.labelHint || '').trim().toLowerCase();
    const soloistHint = String(opts?.soloistHint || '').trim();
    const soloistTokens = nameTokenSet(soloistHint);
    const soloistSensitive = /\b(concerto|sonata|rhapsody|fantasy|variations?)\b/i.test(queryWork);
    let bestItem = null;
    let bestArt = '';
    let bestScore = -1e9;
    let filteredStrict = 0;
    let filteredEnsemble = 0;
    let filteredSoloist = 0;
    let filteredNoArt = 0;
    let albumSearchTerms = [];
    let albumSearchMatched = '';

    for (const item of results) {
      const matchedArtistCandidate = String(item?.artistName || '').trim();
      const collectionName = String(item?.collectionName || '').trim();
      const trackName = String(item?.trackName || '').trim();

      if (opts?.strictTitle && !shouldAcceptMatchedTitle(t, trackName)) {
        filteredTitle += 1;
        continue;
      }

      if (opts?.strictArtist && !artistMatchStrict(a, matchedArtistCandidate)) {
        const hint = String(opts?.albumHint || '').trim();
        const allowByAlbumHint = !!hint && albumHintMatches(hint, collectionName);
        if (!allowByAlbumHint) {
          strictRejected += 1;
          filteredStrict += 1;
          continue;
        }
      }

      const ensembleHint = String(opts?.ensembleHint || '').trim();
      if (ensembleHint && !ensembleMatchesCandidate(ensembleHint, matchedArtistCandidate, collectionName)) {
        filteredEnsemble += 1;
        continue;
      }

      if (soloistSensitive && soloistTokens.size) {
        const candTokens = nameTokenSet(`${matchedArtistCandidate} ${collectionName}`);
        if (overlapCount(soloistTokens, candTokens) === 0) {
          filteredSoloist += 1;
          continue;
        }
      }

      const art = pickArtFromItunesItem(item);
      if (!art) {
        filteredNoArt += 1;
        continue;
      }

      let score = 0;
      const candidateText = `${trackName} ${collectionName}`.trim();
      const overlap = tokenOverlapCount(queryWork, candidateText);
      score += Math.min(50, overlap * 10);

      const itemOpus = extractOpusNums(candidateText);
      if (queryOpus.size && itemOpus.size) {
        const shared = [...queryOpus].filter((n) => itemOpus.has(n)).length;
        if (shared > 0) score += 70;
        else score -= 90;
      }

      const hint = String(opts?.albumHint || '').trim();
      if (hint) {
        if (albumHintMatches(hint, collectionName)) score += 85;
        else score -= 55;
      }

      const candMovement = movementTokenSet(`${trackName} ${collectionName}`);
      if (queryMovement.size) {
        const mOverlap = overlapCount(queryMovement, candMovement);
        if (mOverlap > 0) score += 28;
        else score -= 60;

        const qRoman = new Set([...queryMovement].filter((t) => /^rm/.test(t)));
        const cRoman = new Set([...candMovement].filter((t) => /^rm/.test(t)));
        // For classical movement lines, roman numeral mismatch is a hard reject.
        if (qRoman.size) {
          if (!cRoman.size) continue;
          if (overlapCount(qRoman, cRoman) === 0) continue;
        }
      }

      if (conductorTokens.size) {
        const candTokens = ensembleTokenSet(`${matchedArtistCandidate} ${collectionName}`);
        const cOverlap = overlapCount(conductorTokens, candTokens);
        if (cOverlap > 0) score += 26;
      }

      if (labelHint) {
        const labelBlob = `${matchedArtistCandidate} ${collectionName}`.toLowerCase();
        if (labelBlob.includes(labelHint)) score += 22;
      }

      if (score > bestScore) {
        bestScore = score;
        bestItem = item;
        bestArt = art;
      }
    }

    if (bestItem) {
      url = bestArt;
      const picked = pickAlbumAndYearFromItunesItem(bestItem) || {};
      album = String(picked.album || '');
      year  = String(picked.year  || '');
      trackUrl = String(bestItem?.trackViewUrl || '');
      albumUrl = String(bestItem?.collectionViewUrl || '');
      matchedArtist = String(bestItem?.artistName || '').trim();
      matchedTitle = String(bestItem?.trackName || '').trim();
    }

    // Album-tier fallback for classical-like radio misses:
    // performer/ensemble + program hint often works better than composer+movement song search.
    // Some stations (notably MIMIC) provide a program/date instead of an
    // Apple-searchable album title, so also allow a performer-only search.
    const albumHintValue = String(opts?.albumHint || '').trim();
    const classicalAlbumSearch = !!opts?.classicalAlbumSearch;
    const programHint = String(opts?.programHint || '').trim();
    if (!url && String(a || '').trim() && (albumHintValue || classicalAlbumSearch)) {
      const shortComposer = String(opts?.composerShort || '').trim();
      const composer = String(opts?.composer || '').trim();
      const ensemble = String(opts?.ensembleHint || a || '').trim();
      const conductor = String(opts?.conductorHint || '').trim();
      const soloist = String(opts?.soloistHint || '').trim();
      const albumTerms = [
        [composer, t, albumHintValue, programHint, ensemble, conductor, soloist].filter(Boolean).join(' '),
        [composer, t, albumHintValue, programHint, ensemble, conductor].filter(Boolean).join(' '),
        [composer, t, programHint, ensemble, conductor, soloist].filter(Boolean).join(' '),
        [composer, t, programHint, ensemble, conductor].filter(Boolean).join(' '),
        [composer, t, ensemble, conductor, soloist].filter(Boolean).join(' '),
        composer && albumHintValue ? `${composer} ${albumHintValue}` : '',
        shortComposer && albumHintValue ? `${shortComposer} ${albumHintValue}` : '',
      ].filter((term, index, all) => term && all.findIndex((candidate) => candidate.toLowerCase() === term.toLowerCase()) === index);
      albumSearchTerms = albumTerms;

      for (const term of albumTerms) {
        const albumQueryUrl = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(term)}&entity=album&limit=8`;
        const d2 = await fetchJsonWithTimeout(albumQueryUrl, ITUNES_TIMEOUT_MS);
        const r2 = Array.isArray(d2?.results) ? d2.results : [];
        let picked = null;

        for (const item of r2) {
          const cName = String(item?.collectionName || '').trim();
          const aName = String(item?.artistName || '').trim();
          if (albumHintValue && !albumHintMatches(albumHintValue, cName)) continue;
          if (classicalAlbumSearch) {
            const candidateText = `${aName} ${cName}`;
            const composerTokens = nameTokenSet(composer || a);
            if (composerTokens.size && overlapCount(composerTokens, nameTokenSet(candidateText)) < 1) continue;
            // An album-level match does not need the full movement title, but
            // it must still identify the same work family (e.g. Piano +
            // Concerto), preventing a generic Prokofiev album from winning.
            if (tokenOverlapCount(t, cName) < 2) continue;
          }
          if (a && !artistMatchStrict(a, aName) && !String(aName).toLowerCase().includes(String(a).toLowerCase())) continue;
          const ensembleHint = String(opts?.ensembleHint || '').trim();
          if (ensembleHint && !ensembleMatchesCandidate(ensembleHint, aName, cName)) continue;
          const conductorHint = String(opts?.conductorHint || '').trim();
          if (conductorHint) {
            const condTok = nameTokenSet(conductorHint);
            const candTok = nameTokenSet(`${aName} ${cName}`);
            if (condTok.size && overlapCount(condTok, candTok) === 0) continue;
          }
          if (classicalAlbumSearch && soloist) {
            const soloistTok = nameTokenSet(soloist);
            const candTok = nameTokenSet(`${aName} ${cName}`);
            if (soloistTok.size && overlapCount(soloistTok, candTok) === 0) continue;
          }
          picked = item;
          break;
        }

        if (!picked && r2.length && !classicalAlbumSearch && albumHintValue) {
          picked = r2.find((item) => albumHintMatches(albumHintValue, String(item?.collectionName || '').trim())) || null;
        }

        if (picked) {
          url = pickArtFromItunesItem(picked) || '';
          const p2 = pickAlbumAndYearFromItunesItem(picked) || {};
          album = String(p2.album || picked?.collectionName || '');
          year = String(p2.year || '');
          albumUrl = String(picked?.collectionViewUrl || '');
          trackUrl = '';
          matchedArtist = String(picked?.artistName || '').trim();
          matchedTitle = '';
          albumSearchMatched = `${album} — ${matchedArtist}`.trim();
          break;
        }
      }
    }

    // The iTunes Search API does not index every Apple Music track. If the
    // normal API and album-tier searches miss, use Apple's web search to find
    // the track URL, then validate/fetch its canonical iTunes record by ID.
    if (!url) {
      const web = await lookupAppleMusicWebFallback(a, t, { searchTerm: termStr, debug });
      if (web?.url) {
        url = web.url;
        album = web.album || '';
        year = web.year || '';
        trackUrl = web.trackUrl || '';
        albumUrl = web.albumUrl || '';
        matchedArtist = web.matchedArtist || '';
        matchedTitle = web.matchedTitle || '';
        matchReason = 'ok:web-search';
        webFallback = {
          reason: web.reason || 'ok:web-search',
          searchUrl: web.webSearchUrl || '',
          lookupUrl: web.webLookupUrl || '',
        };
      }
    }

    // ✅ Cache both hits and misses, including URLs if present
    itunesArtCache.set(cacheKey, {
      url,
      album,
      year,
      trackUrl,
      albumUrl,
      matchedArtist,
      matchedTitle,
      ts: now,
    });

    const reason = url ? (matchReason || (trackUrl ? 'ok:bestMatch' : 'ok:albumFallback')) : ((opts?.strictArtist && strictRejected > 0) ? 'no-artist-match' : 'no-art');

    if (debug) {
      return {
        url,
        album,
        year,
        trackUrl,
        albumUrl,
        matchedArtist,
        matchedTitle,
        reason,
        queryUrl,
        term: termStr,
        termDebug,
        resultDebug: {
          totalResults: Array.isArray(results) ? results.length : 0,
          strictRejected,
          filteredStrict,
          filteredEnsemble,
          filteredSoloist,
          filteredTitle,
          filteredNoArt,
          bestScore,
          bestTrack: String(bestItem?.trackName || ''),
          bestArtist: String(bestItem?.artistName || ''),
          bestAlbum: String(bestItem?.collectionName || ''),
          albumSearchTerms,
          albumSearchMatched,
          webFallback,
        },
      };
    }

    return { url, album, year, trackUrl, albumUrl, matchedArtist, matchedTitle, reason };
  } catch (e) {
    const name = e?.name || 'Error';
    const msg  = e?.message || String(e);
    const reason = `error:${name}:${msg}`;

    // On hard upstream blocks (e.g. 403/429), avoid sticky empty cache entries and trip backoff.
    const isHardBlock = /HTTP\s*(403|429)\b/i.test(String(msg || ''));
    if (isHardBlock) {
      itunesBackoffReason = /429/.test(String(msg || '')) ? '429' : '403';
      itunesBackoffUntil = Math.max(itunesBackoffUntil || 0, Date.now() + (45 * 60 * 1000));
    }
    if (!isHardBlock) {
      // ✅ Cache miss on ordinary errors (prevents hammering)
      itunesArtCache.set(cacheKey, {
        url: '',
        album: '',
        year: '',
        trackUrl: '',
        albumUrl: '',
        ts: now,
      });
    }

    if (debug) {
      return empty(reason, {
        queryUrl,
        term: termStr,
        termDebug,
      });
    }

    return empty(reason);
  }
}

// Catalog-first radio lookup coordination. The Catalog service has its own
// per-identity result cache; this outer layer also coalesces the complete
// Catalog + legacy-fallback operation so concurrent HTTP/mobile snapshots
// cannot stampede the public iTunes Search endpoint.
const radioAppleLookupCache = new Map();
const radioAppleLookupPending = new Map();
const RADIO_APPLE_LOOKUP_MAX_CACHE_ENTRIES = 2_000;
const RADIO_APPLE_LOOKUP_TRANSIENT_TTL_MS = 30_000;

function radioAppleLookupCacheKey(artist, title, opts = {}) {
  return JSON.stringify({
    artist: normLoose(artist),
    title: normLoose(title),
    strictArtist: !!opts?.strictArtist,
    strictTitle: !!opts?.strictTitle,
    radioAlbum: normLoose(opts?.radioAlbum),
    albumHint: normLoose(opts?.albumHint),
    ensembleHint: normLoose(opts?.ensembleHint),
    conductorHint: normLoose(opts?.conductorHint),
    soloistHint: normLoose(opts?.soloistHint),
    labelHint: normLoose(opts?.labelHint),
    programHint: normLoose(opts?.programHint),
    curatedCollectionId: String(opts?.curatedCollectionId || '').trim(),
    classicalAlbumSearch: !!opts?.classicalAlbumSearch,
  });
}

function radioAppleLookupTtl(result) {
  const hasAcceptedIdentity = Boolean(String(
    result?.url || result?.trackUrl || result?.albumUrl || '',
  ).trim());
  if (hasAcceptedIdentity) {
    return Math.max(RADIO_APPLE_LOOKUP_TRANSIENT_TTL_MS, Number(ITUNES_TTL_HIT_MS) || 0);
  }
  const reason = String(result?.reason || '').toLowerCase();
  if (/(?:backoff|rate-limited|timeout|unavailable|error)/.test(reason)) {
    return RADIO_APPLE_LOOKUP_TRANSIENT_TTL_MS;
  }
  return Math.max(
    RADIO_APPLE_LOOKUP_TRANSIENT_TTL_MS,
    Math.min(1000 * 60 * 10, Number(ITUNES_TTL_MISS_MS) || RADIO_APPLE_LOOKUP_TRANSIENT_TTL_MS),
  );
}

function catalogLookupIsSafeForRadioContext(opts = {}) {
  // The specialized classical paths carry curated album/performer evidence
  // that the generic Catalog query cannot evaluate. Preserve their existing
  // stricter iTunes matcher rather than replacing it with a looser result.
  return !(
    opts?.curatedCollectionId
    || opts?.classicalAlbumSearch
    || opts?.strictTitle
    || opts?.ensembleHint
    || opts?.conductorHint
    || opts?.soloistHint
  );
}

async function lookupAppleCatalogFirst(artist, title, debug = false, opts = {}) {
  const cacheKey = radioAppleLookupCacheKey(artist, title, opts);
  const now = Date.now();
  const cached = radioAppleLookupCache.get(cacheKey);
  if (cached && !debug && (now - Number(cached.ts || 0)) < Number(cached.ttl || 0)) {
    return { ...cached.result };
  }
  if (cached) radioAppleLookupCache.delete(cacheKey);

  if (!debug && radioAppleLookupPending.has(cacheKey)) {
    return radioAppleLookupPending.get(cacheKey);
  }

  const lookup = (async () => {
    let catalog = null;
    if (catalogLookupIsSafeForRadioContext(opts)) {
      catalog = await appleCatalogSearchService.lookup({ artist, title });
      if (catalog?.matched) return catalog;
    }

    const fallback = await lookupItunesFirst(artist, title, debug, opts);
    if (!debug) return fallback;
    return {
      ...fallback,
      catalogReason: String(catalog?.reason || (catalog ? 'catalog-no-match' : 'catalog-skipped')),
    };
  })();

  if (!debug) radioAppleLookupPending.set(cacheKey, lookup);
  try {
    const result = await lookup;
    if (!debug) {
      if (radioAppleLookupCache.size >= RADIO_APPLE_LOOKUP_MAX_CACHE_ENTRIES) {
        radioAppleLookupCache.delete(radioAppleLookupCache.keys().next().value);
      }
      radioAppleLookupCache.set(cacheKey, {
        ts: Date.now(),
        ttl: radioAppleLookupTtl(result),
        result: { ...result },
      });
    }
    return result;
  } finally {
    if (!debug) radioAppleLookupPending.delete(cacheKey);
  }
}


/* =========================
 * AirPlay aplmeta.txt
 * ========================= */

function parseAplmeta(txt) {
  const line = String(txt || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  const parts = line.split('~~~');

  const title = (parts[0] || '').trim();
  const artist = (parts[1] || '').trim();
  const album = (parts[2] || '').trim();
  const duration = (parts[3] || '').trim();
  const coverRel = (parts[4] || '').trim();
  const fmt = (parts[5] || '').trim();

  const coverUrl = coverRel ? normalizeCoverUrl('/' + coverRel.replace(/^\/+/, '')) : '';
  return { title, artist, album, duration, coverRel, coverUrl, format: fmt };
}



/* =========================
 * Last-good cache for now-playing
 * ========================= */

let lastNowPlayingOk = null;
let lastNowPlayingTs = 0;
let airplaySessionStartedAt = 0;
let airplaySessionWasActive = false;

import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// --- small utils ---
function stripQueryHash(u) {
  return String(u || "").split("#")[0].split("?")[0];
}

function safeFileName(name, fallback = "episode.mp3") {
  const raw = String(name || "").trim();
  if (!raw) return fallback;

  // keep only safe chars
  let out = raw.replace(/[^a-zA-Z0-9._-]+/g, "_");

  // avoid hidden files or empty
  out = out.replace(/^_+/, "");
  if (!out || out === "." || out === "..") return fallback;

  return out;
}

async function resolveFinalUrl(url) {
  // Try HEAD first (fast), then fallback to GET (some hosts block HEAD)
  const u = String(url || "").trim();
  if (!u) return "";

  try {
    const r = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: FETCH_HEADERS });
    if (r?.url) return r.url;
  } catch {}

  // GET fallback, but do NOT download the whole file (cancel immediately)
  const ac = new AbortController();
  const r = await fetch(u, { method: 'GET', redirect: 'follow', signal: ac.signal, headers: FETCH_HEADERS });
  const finalUrl = r?.url || u;
  try { r.body?.cancel?.(); } catch {}
  try { ac.abort(); } catch {}
  return finalUrl;
}

async function logPodcastDownload(row) {
  try {
    await fsp.mkdir(path.dirname(PODCAST_DL_LOG), { recursive: true });
    await fsp.appendFile(PODCAST_DL_LOG, JSON.stringify(row) + "\n", "utf8");
  } catch {}
}

/* =========================
 * Routes
 * ========================= */
 

app.post('/mpd/reset-playback-state', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    try { await mpdStop(); } catch (e) {}
    try { await mpdQueryRaw('clear'); } catch (e) {}
    await sleep(120);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

function parseMpdOutputs(raw) {
  const outputs = [];
  let current = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (line === 'OK' || line.startsWith('ACK')) break;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'outputid') {
      if (current) outputs.push(current);
      current = { id: Number(value), name: '', plugin: '', enabled: false };
    } else if (current) {
      if (key === 'outputname') current.name = value;
      else if (key === 'plugin') current.plugin = value;
      else if (key === 'outputenabled') current.enabled = value === '1';
    }
  }
  if (current) outputs.push(current);
  return outputs.filter((x) => Number.isInteger(x.id));
}

app.get('/mpd/local-output', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const outputs = parseMpdOutputs(await mpdQueryRaw('outputs'));
    const local = outputs.find((x) => x.id === 0) || null;
    if (!local) return res.status(404).json({ ok: false, error: 'Local ALSA output not found' });
    return res.json({ ok: true, output: local, outputs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/local-output', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'enabled must be boolean' });
    }
    if (req.body.enabled === true && alexaModeActive) {
      const outputs = parseMpdOutputs(await mpdQueryRaw('outputs'));
      const local = outputs.find((x) => x.id === 0) || null;
      return res.status(409).json({ ok: false, error: 'Local ALSA output is muted while Alexa Mode is active', output: local, outputs, alexaMode: true });
    }
    const raw = await mpdQueryRaw(req.body.enabled ? 'enableoutput 0' : 'disableoutput 0');
    if (mpdHasACK(raw)) return res.status(409).json({ ok: false, error: 'MPD rejected local output change' });
    const outputs = parseMpdOutputs(await mpdQueryRaw('outputs'));
    const local = outputs.find((x) => x.id === 0) || null;
    return res.json({ ok: true, output: local, outputs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/start-queue', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    await mpdQueryRaw('play 0');
    return res.json({ ok: true, playbackStarted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Start a previously added MPD song by its stable song ID. This is used by
// Mabel when the record has been reserved while her retrieval sound plays;
// using playid avoids queue-position races during that short handoff.
app.post('/mpd/start-song', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const songId = Number(req.body?.songId);
    if (!Number.isSafeInteger(songId) || songId < 0) {
      return res.status(400).json({ ok: false, error: 'songId must be a non-negative integer' });
    }
    const raw = await mpdQueryRaw(`playid ${songId}`);
    if (mpdHasACK(raw)) return res.status(409).json({ ok: false, error: 'MPD rejected starting the song' });
    return res.json({ ok: true, playbackStarted: true, songId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/play-artist', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;

    const artistInput = String(req.body?.artist || '').trim();
    if (!artistInput) {
      return res.status(400).json({ ok: false, error: 'Missing artist' });
    }
    const artist = await resolveArtistAlias(artistInput);

    // Default behavior: EXCLUDE holiday/christmas titles for play-artist.
    // Override per request with { includeHoliday: true }.
    const includeHoliday = String(req.body?.includeHoliday ?? '').toLowerCase() === 'true'
      || req.body?.includeHoliday === true
      || req.body?.includeHoliday === 1;

    const q = mpdEscapeValue(artist);

    // Build candidate list first, then enqueue only approved tracks.
    async function collectCandidates(cmd) {
      const raw = await mpdQueryRaw(cmd);
      const blocks = parseMpdPlaylistBlocks(raw || '');
      const out = [];
      const seen = new Set();
      for (const b of blocks) {
        const f = String(b?.file || '').trim();
        if (!f || seen.has(f)) continue;
        // MPD's find/search responses can include playlist-like or directory
        // entries on some moOde configurations. Never enqueue those here:
        // `add` would expand them into the entire library.
        if (!/\.(?:flac|mp3|m4a|aac|ogg|opus|wav|mp4|m4v|webm)$/i.test(f)) continue;
        seen.add(f);
        out.push({
          file: f,
          title: String(b?.title || ''),
          album: String(b?.album || ''),
          artist: String(b?.artist || ''),
          albumartist: String(b?.albumartist || ''),
          genre: String(b?.genre || ''),
          genresort: String(b?.genresort || ''),
        });
      }
      return out;
    }

    async function collectAlbumsFromList(cmd) {
      const raw = await mpdQueryRaw(cmd);
      return String(raw || '')
        .split('\n')
        .map((ln) => ln.trim())
        .filter((ln) => ln.toLowerCase().startsWith('album: '))
        .map((ln) => ln.slice(7).trim())
        .filter(Boolean);
    }

    function normalizeArtistKey(v) {
      return String(v || '')
        .toLowerCase()
        .replace(/\bjunior\b/g, 'jr')
        .replace(/\bjr\.?\b/g, 'jr')
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    async function resolveCanonicalArtistName(artistName) {
      const wantRaw = String(artistName || '').trim();
      const want = wantRaw.toLowerCase();
      const wantNorm = normalizeArtistKey(wantRaw);
      if (!want) return wantRaw;

      const raw = await mpdQueryRaw('list artist');
      const artists = String(raw || '')
        .split('\n')
        .map((ln) => ln.trim())
        .filter((ln) => ln.toLowerCase().startsWith('artist: '))
        .map((ln) => ln.slice(8).trim())
        .filter(Boolean);

      const exactCI = artists.find((a) => a.toLowerCase() === want);
      if (exactCI) return exactCI;

      const normExact = artists.find((a) => normalizeArtistKey(a) === wantNorm);
      if (normExact) return normExact;

      const normContains = artists.find((a) => {
        const k = normalizeArtistKey(a);
        return k.includes(wantNorm) || wantNorm.includes(k);
      });
      return normContains || wantRaw;
    }

    async function collectByAlbumRollup(artistName) {
      const canonicalArtist = await resolveCanonicalArtistName(artistName);
      const qq = mpdEscapeValue(canonicalArtist || artistName);
      const albumNames = new Set([
        ...(await collectAlbumsFromList(`list album albumartist ${qq}`)),
        ...(await collectAlbumsFromList(`list album artist ${qq}`)),
      ]);

      const merged = [];
      const seen = new Set();
      for (const albumName of albumNames) {
        const aa = await collectCandidates(`find album ${mpdEscapeValue(albumName)}`);
        for (const row of aa) {
          if (!row.file || seen.has(row.file)) continue;
          seen.add(row.file);
          merged.push(row);
        }
      }
      return merged;
    }

    const canonicalArtist = await resolveCanonicalArtistName(artist);
    const qCanonical = mpdEscapeValue(canonicalArtist || artist);

    const bySource = {
      albumartist: await collectCandidates(`find albumartist ${qCanonical}`),
      artist: await collectCandidates(`find artist ${qCanonical}`),
      'search-artist': await collectCandidates(`search artist ${q}`),
    };

    const merged = [];
    const seenFiles = new Set();
    for (const key of ['albumartist', 'artist', 'search-artist']) {
      for (const row of bySource[key]) {
        if (seenFiles.has(row.file)) continue;
        seenFiles.add(row.file);
        merged.push(row);
      }
    }

    const strategy = 'union(albumartist,artist,search-artist)';
    const candidates = merged;

    if (!candidates.length) {
      return res.status(404).json({ ok: false, error: 'No matches for artist', artist });
    }

    let removedHoliday = 0;
    const removedSamples = [];
    let finalFiles = candidates;

    const candidateAlbums = [...new Set(candidates.map((r) => String(r.album || '').trim()).filter(Boolean))];

    if (!includeHoliday) {
      finalFiles = candidates.filter((b) => {
        const genreBlob = [b.genre, b.genresort].filter(Boolean).join(' | ');
        const isHoliday = isHolidayLikeGenre(genreBlob) || isHolidayLikeTrackMeta(b);
        if (isHoliday) {
          removedHoliday += 1;
          if (removedSamples.length < 5) {
            removedSamples.push({ title: String(b.title || ''), album: String(b.album || ''), file: String(b.file || '') });
          }
        }
        return !isHoliday;
      });

      if (removedHoliday > 0) {
        log.debug('[play-artist] holiday filter removed before enqueue', {
          artist,
          removedHoliday,
          remaining: finalFiles.length,
          samples: removedSamples,
        });
      }
    }

    let removedRating1 = 0;
    const removedRating1Samples = [];
    if (finalFiles.length) {
      const kept = [];
      for (const row of finalFiles) {
        let r = 0;
        try { r = Number(await getRatingForFile(String(row.file || '').trim())) || 0; } catch (_) { r = 0; }
        if (r === 1) {
          removedRating1 += 1;
          if (removedRating1Samples.length < 5) {
            removedRating1Samples.push({ title: String(row.title || ''), album: String(row.album || ''), file: String(row.file || '') });
          }
          continue;
        }
        kept.push(row);
      }
      finalFiles = kept;
      if (removedRating1 > 0) {
        log.debug('[play-artist] rating=1 filter removed before enqueue', {
          artist,
          removedRating1,
          remaining: finalFiles.length,
          samples: removedRating1Samples,
        });
      }
    }

    const requestedMaxTracks = Number(req.body?.maxTracks);
    const maxTracks = Number.isInteger(requestedMaxTracks) && requestedMaxTracks > 0
      ? Math.min(requestedMaxTracks, 200)
      : null;
    if (maxTracks && finalFiles.length > maxTracks) {
      finalFiles = finalFiles.slice(0, maxTracks);
    }

    if (!finalFiles.length) {
      await mpdQueryRaw('clear');
      return res.status(404).json({
        ok: false,
        error: 'Artist matches were filtered out as holiday/christmas',
        artist,
        removedHoliday,
      });
    }

    log.info('[play-artist] replacing queue', { artist, candidateCount: finalFiles.length });
    // Enqueue as one MPD command list. This prevents another queue mutation
    // from interleaving between the clear and the individual track adds.
    const addCommands = [
      'command_list_begin',
      'clear',
      ...finalFiles.map((row) => `add ${mpdEscapeValue(row.file)}`),
      'command_list_end',
    ].join('\n');
    await mpdQueryRaw(addCommands, 30000);
    const afterAdd = await mpdGetStatus();
    if (Number(afterAdd?.playlistlength || 0) !== finalFiles.length) {
      log.warn('[play-artist] add verification failed', {
        artist,
        expected: finalFiles.length,
        actual: Number(afterAdd?.playlistlength || 0),
      });
      return res.status(503).json({
        ok: false,
        error: 'MPD queue did not contain exactly the requested artist tracks',
        expected: finalFiles.length,
        actual: Number(afterAdd?.playlistlength || 0),
      });
    }

    const finalAlbums = [...new Set(finalFiles.map((r) => String(r.album || '').trim()).filter(Boolean))];
    log.info('[play-artist] built queue', {
      artist,
      canonicalArtist,
      includeHoliday,
      strategy,
      sourceCounts: {
        albumartist: bySource.albumartist.length,
        artist: bySource.artist.length,
        searchArtist: bySource['search-artist'].length,
        albumRollup: 0,
        merged: candidates.length,
      },
      candidateAlbumCount: candidateAlbums.length,
      finalAlbumCount: finalAlbums.length,
      finalTrackCount: finalFiles.length,
      maxTracks,
      finalAlbumSamples: finalAlbums.slice(0, 12),
    });

    let added = finalFiles.length;

    // Shuffle behavior for artist queues: an explicit shuffle physically
    // reorders the queue. Legacy MPD random mode is disabled and never used
    // to choose a random head.
    let shuffledQueue = false;
    const shuffleRequested = String(req.body?.shuffle ?? '').toLowerCase() === 'true'
      || req.body?.shuffle === true
      || req.body?.shuffle === 1;

    const stPrime = parseMpdKeyVals(await mpdQueryRaw('status'));
    const randomOn = String(stPrime.random || '0').trim() === '1';
    const hasPodcastGenre = finalFiles.some((r) => isPodcastLikeGenre([r.genre, r.genresort].filter(Boolean).join(' | ')));

    if (randomOn) {
      try { await mpdQueryRaw('random 0'); } catch (_) {}
    }

    if (added > 1 && !hasPodcastGenre) {
      if (shuffleRequested) {
        try {
          log.info('[play-artist] shuffling queue', { artist, added });
          await mpdQueryRaw('shuffle', 10000);
          shuffledQueue = true;
        } catch (e) {
          log.warn('[play-artist] shuffle failed or timed out', { artist, msg: e?.message || String(e) });
        }
      }
    }

    // Artist lists can take longer to settle; wait for head item to be readable.
    log.info('[play-artist] reading queue head', { artist, added });
    let head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1', 10000));
    for (let i = 0; i < 6; i++) {
      if (head && head.file) break;
      await sleep(120);
      head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1', 10000));
    }

    const startPlayback = req.body?.startPlayback === true
      || String(req.body?.startPlayback ?? '').toLowerCase() === 'true'
      || req.body?.startPlayback === 1;
    if (startPlayback) {
      log.info('[play-artist] starting playback', { artist });
      await mpdQueryRaw('play 0', 10000);
    }

    log.info('[play-artist] completed', { artist, added, playbackStarted: startPlayback, shuffledQueue });

    return res.json({
      ok: true,
      artist,
      artistInput,
      strategy,
      sourceCounts: {
        albumartist: bySource.albumartist.length,
        artist: bySource.artist.length,
        searchArtist: bySource['search-artist'].length,
        albumRollup: 0,
        merged: candidates.length,
      },
      added,
      includeHoliday,
      removedHoliday,
      removedRating1,
      hasPodcastGenre,
      shuffledQueue,
      playbackStarted: startPlayback,
      nowPlaying: {
        file: head.file || '',
        title: decodeHtmlEntities(head.title || ''),
        artist: decodeHtmlEntities(head.artist || ''),
        album: decodeHtmlEntities(head.album || ''),
        songpos: String(head.pos || '0').trim(),
        songid: String(head.id || '').trim(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


app.post('/mpd/play-album', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const albumInput = String(req.body?.album || '').trim();
    if (!albumInput) return res.status(400).json({ ok: false, error: 'Missing album' });
    const album = await resolveAlbumAlias(albumInput);
    const q = mpdEscapeValue(album);
    const excludeRating1 = req.body?.excludeRating1 === true
      || String(req.body?.excludeRating1 ?? '').toLowerCase() === 'true'
      || req.body?.excludeRating1 === 1;

    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const levenshtein = (a, b) => {
      const m = a.length, n = b.length;
      if (!m) return n;
      if (!n) return m;
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
      }
      return dp[m][n];
    };

    await mpdQueryRaw('clear');
    await mpdQueryRaw(`findadd album ${q}`);
    let st = await mpdGetStatus();
    let added = Number(st?.playlistlength || 0);
    let strategy = 'findadd-album';

    if (added <= 0) {
      await mpdQueryRaw('clear');
      await mpdQueryRaw(`searchadd album ${q}`);
      st = await mpdGetStatus();
      added = Number(st?.playlistlength || 0);
      strategy = 'searchadd-album';
    }

    // strict album-name fallback (no "search any" to avoid title/track false positives)
    if (added <= 0) {
      const rawAlbums = await mpdQueryRaw('list album');
      const names = String(rawAlbums || '').split('\n')
        .filter((ln) => ln.startsWith('Album: '))
        .map((ln) => ln.slice('Album: '.length).trim())
        .filter(Boolean);

      const askN = norm(album);
      let chosen = names.find((n) => n.toLowerCase() === album.toLowerCase()) || '';
      if (!chosen) chosen = names.find((n) => norm(n) === askN) || '';
      if (!chosen) chosen = names.find((n) => norm(n).includes(askN) || askN.includes(norm(n))) || '';
      if (!chosen && askN) {
        let best = { name: '', score: 0 };
        for (const n of names) {
          const nn = norm(n);
          if (!nn) continue;
          const dist = levenshtein(askN, nn);
          const score = 1 - dist / Math.max(askN.length, nn.length, 1);
          if (score > best.score) best = { name: n, score };
        }
        if (best.score >= 0.72) chosen = best.name;
      }

      if (chosen) {
        await mpdQueryRaw('clear');
        await mpdQueryRaw(`findadd album ${mpdEscapeValue(chosen)}`);
        st = await mpdGetStatus();
        added = Number(st?.playlistlength || 0);
        strategy = 'list-album-fuzzy';
      }
    }

    let removedRating1 = 0;
    if (excludeRating1 && added > 0) {
      const filtered = await removeOneStarTracksFromQueue();
      removedRating1 = filtered.removed;
      st = await mpdGetStatus();
      added = Number(st?.playlistlength || 0);
    }

    if (added <= 0) {
      if (excludeRating1) await mpdQueryRaw('clear');
      return res.status(404).json({
        ok: false,
        error: excludeRating1 ? 'All album matches were marked one star' : 'No matches for album',
        album,
        ...(excludeRating1 ? { removedRating1 } : {}),
      });
    }

    // Prime the deterministic queue head; MPD random mode is not part of the
    // playback model anymore.
    const stPrime = parseMpdKeyVals(await mpdQueryRaw('status'));
    if (String(stPrime.random || '0').trim() === '1') {
      try { await mpdQueryRaw('random 0'); } catch (_) {}
    }
    await mpdQueryRaw('play 0');
    await sleep(170);
    await mpdPause(true);

    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1'));
    const curPos = Number(String(moodeValByKey(statusRaw, 'song') || '').trim());
    const curByPos = Number.isFinite(curPos) ? await mpdPlaylistInfoByPos(curPos) : null;

    return res.json({ ok: true, album, albumInput, added, strategy,
      ...(excludeRating1 ? { excludeRating1: true, removedRating1 } : {}), nowPlaying: {
      file: (curByPos && curByPos.file) || head.file || song.file || '', title: decodeHtmlEntities((curByPos && curByPos.title) || head.title || song.title || ''), artist: decodeHtmlEntities((curByPos && curByPos.artist) || head.artist || song.artist || ''), album: decodeHtmlEntities((curByPos && curByPos.album) || head.album || song.album || ''),
      songpos: String((curByPos && curByPos.songpos) || head.pos || moodeValByKey(statusRaw, 'song') || '0').trim(), songid: String((curByPos && curByPos.songid) || head.id || moodeValByKey(statusRaw, 'songid') || '').trim(),
    }});
  } catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});

app.post('/mpd/play-track', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const track = String(req.body?.track || '').trim();
    if (!track) return res.status(400).json({ ok: false, error: 'Missing track' });
    const q = mpdEscapeValue(track);

    await mpdQueryRaw('clear');
    await mpdQueryRaw(`findadd title ${q}`);
    let st = await mpdGetStatus();
    let added = Number(st?.playlistlength || 0);
    let strategy = 'findadd-title';

    if (added <= 0) {
      await mpdQueryRaw('clear');
      await mpdQueryRaw(`searchadd title ${q}`);
      st = await mpdGetStatus();
      added = Number(st?.playlistlength || 0);
      strategy = 'searchadd-title';
    }

    if (added <= 0) {
      await mpdQueryRaw('clear');
      await mpdQueryRaw(`searchadd any ${q}`);
      st = await mpdGetStatus();
      added = Number(st?.playlistlength || 0);
      strategy = 'searchadd-any';
    }

    if (added <= 0) return res.status(404).json({ ok: false, error: 'No matches for track', track });

    // Prime the deterministic queue head; MPD random mode is not part of the
    // playback model anymore.
    const stPrime = parseMpdKeyVals(await mpdQueryRaw('status'));
    if (String(stPrime.random || '0').trim() === '1') {
      try { await mpdQueryRaw('random 0'); } catch (_) {}
    }
    await mpdQueryRaw('play 0');
    await sleep(170);
    await mpdPause(true);

    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1'));
    const curPos = Number(String(moodeValByKey(statusRaw, 'song') || '').trim());
    const curByPos = Number.isFinite(curPos) ? await mpdPlaylistInfoByPos(curPos) : null;

    return res.json({ ok: true, track, added, strategy, nowPlaying: {
      file: (curByPos && curByPos.file) || head.file || song.file || '', title: decodeHtmlEntities((curByPos && curByPos.title) || head.title || song.title || ''), artist: decodeHtmlEntities((curByPos && curByPos.artist) || head.artist || song.artist || ''), album: decodeHtmlEntities((curByPos && curByPos.album) || head.album || song.album || ''),
      songpos: String((curByPos && curByPos.songpos) || head.pos || moodeValByKey(statusRaw, 'song') || '0').trim(), songid: String((curByPos && curByPos.songid) || head.id || moodeValByKey(statusRaw, 'songid') || '').trim(),
    }});
  } catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});

app.post('/mpd/play-playlist', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const playlistInput = String(req.body?.playlist || '').trim();
    if (!playlistInput) return res.status(400).json({ ok: false, error: 'Missing playlist' });
    const playlist = await resolvePlaylistAlias(playlistInput);
    const excludeRating1 = req.body?.excludeRating1 === true
      || String(req.body?.excludeRating1 ?? '').toLowerCase() === 'true'
      || req.body?.excludeRating1 === 1;

    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    const raw = await mpdQueryRaw('listplaylists');
    const names = String(raw || '').split('\n')
      .filter((ln) => ln.startsWith('playlist: '))
      .map((ln) => ln.slice('playlist: '.length).trim())
      .filter(Boolean);

    let chosen = '';
    const askN = norm(playlist);

    const levenshtein = (a, b) => {
      const m = a.length, n = b.length;
      if (!m) return n;
      if (!n) return m;
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + cost
          );
        }
      }
      return dp[m][n];
    };

    // 1) exact (case-insensitive)
    chosen = names.find((n) => n.toLowerCase() === playlist.toLowerCase()) || '';
    // 2) normalized exact (punctuation-insensitive)
    if (!chosen) chosen = names.find((n) => norm(n) === askN) || '';
    // 3) contains fallback
    if (!chosen) chosen = names.find((n) => norm(n).includes(askN) || askN.includes(norm(n))) || '';
    // 4) fuzzy typo/ASR fallback
    if (!chosen && askN) {
      let best = { name: '', score: 0 };
      for (const n of names) {
        const nn = norm(n);
        if (!nn) continue;
        const dist = levenshtein(askN, nn);
        const score = 1 - dist / Math.max(askN.length, nn.length, 1);
        if (score > best.score) best = { name: n, score };
      }
      if (best.score >= 0.62) chosen = best.name;
    }

    if (!chosen) {
      return res.status(404).json({ ok: false, error: 'No matches for playlist', playlist, availableCount: names.length });
    }

    await mpdQueryRaw('clear');
    await mpdQueryRaw(`load ${mpdEscapeValue(chosen)}`);

    const st = await mpdGetStatus();
    let added = Number(st?.playlistlength || 0);
    if (added <= 0) return res.status(404).json({ ok: false, error: 'Playlist loaded but no tracks', playlist: chosen });

    let removedRating1 = 0;
    if (excludeRating1) {
      const filtered = await removeOneStarTracksFromQueue();
      removedRating1 = filtered.removed;
      const afterFilter = await mpdGetStatus();
      added = Number(afterFilter?.playlistlength || 0);
      if (added <= 0) {
        await mpdQueryRaw('clear');
        return res.status(404).json({ ok: false, error: 'All playlist tracks were marked one star', playlist: chosen, removedRating1 });
      }
    }

    // Keep playlist playback deterministic. Legacy MPD random mode is
    // disabled instead of selecting a random queue head.
    const stPrime = parseMpdKeyVals(await mpdQueryRaw('status'));
    const randomOn = String(stPrime.random || '0').trim() === '1';
    if (randomOn) {
      try { await mpdQueryRaw('random 0'); } catch (_) {}
    }
    const playlistBlocks = parseMpdPlaylistBlocks(await mpdQueryRaw('playlistinfo'));
    const hasPodcastGenre = playlistBlocks.some((b) => isPodcastLikeGenre([b.genre, b.genresort].filter(Boolean).join(' | ')));

    const head = parseMpdFirstBlock(await mpdQueryRaw('playlistinfo 0:1'));

    return res.json({ ok: true, playlist, playlistInput, chosen, added, hasPodcastGenre,
      ...(excludeRating1 ? { excludeRating1: true, removedRating1 } : {}), nowPlaying: {
      file: head.file || '', title: decodeHtmlEntities(head.title || ''), artist: decodeHtmlEntities(head.artist || ''), album: decodeHtmlEntities(head.album || ''),
      songpos: String(head.pos || '0').trim(), songid: String(head.id || '').trim(),
    }});
  } catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});


app.post('/mpd/shuffle', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    // Retain the legacy route name, but make its operation match the current
    // product semantics: physical queue shuffle, never MPD random mode.
    await mpdQueryRaw('random 0');
    await mpdQueryRaw('shuffle');
    const st = await mpdGetStatus();
    return res.json({ ok: true, shuffle: true, randomOn: false, state: st?.state || '' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/play-file', async (req, res) => {
  try {
    const file = String(req.body?.file || '').trim();

    if (!file) {
      return res.status(400).json({
        ok: false,
        error: 'Missing file',
      });
    }

    // moOde expects URL-encoded path, no quotes
    const encodedPath = encodeURIComponent(file);

    const url = `${MOODE_BASE_URL}/command/?cmd=play_item%20${encodedPath}`;

    await fetch(url, { cache: 'no-store' });

    return res.json({
      ok: true,
      file,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

app.post('/mpd/add-file', async (req, res) => {
  try {
    const file = String(req.body?.file || '').trim();
    if (!file) {
      return res.status(400).json({ ok: false, error: 'Missing file' });
    }

    const q = `"${file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await mpdQueryRaw(`add ${q}`);

    return res.json({ ok: true, file });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/add-album-folder', async (req, res) => {
  try {
    const folder = String(req.body?.folder || '').trim();
    if (!folder) return res.status(400).json({ ok: false, error: 'Missing folder' });
    const q = `"${folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await mpdQueryRaw(`findadd base ${q}`);
    return res.json({ ok: true, folder });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/play-album-folder', async (req, res) => {
  try {
    const folder = String(req.body?.folder || '').trim();
    if (!folder) return res.status(400).json({ ok: false, error: 'Missing folder' });
    const q = `"${folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await mpdQueryRaw('clear');
    await mpdQueryRaw(`findadd base ${q}`);
    await mpdQueryRaw('play 0');
    return res.json({ ok: true, folder, playing: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

registerPodcastEpisodeRoutes(app, {
  capabilities: RUNTIME_CAPABILITIES,
  normUrl,
  readSubs,
  rebuildPodcastLocalIndex,
  fetchPodcastRSS,
  downloadCoverForSub,
  resolveFinalUrl,
  stripQueryHash,
  yyyyMmDd,
});

registerPodcastDownloadRoutes(app, {
  capabilities: RUNTIME_CAPABILITIES,
  normUrl,
  readSubs,
  makePodcastId,
  podcastRoot: PODCAST_ROOT,
  ensureDir,
  safeFileName,
  downloadToFile,
  embedArtWithFfmpeg,
  hasAttachedPic,
  replaceFileAtomic,
  safeUnlink,
  fetchPodcastRSS,
  downloadCoverForSub,
  resolveFinalUrl,
  stripQueryHash,
  downloadWithFetch,
  tagAudioFileWithFfmpeg,
  yyyyMmDd,
  getLocalItemsForSub,
  buildPodcastMapFromLocalItems,
  buildLocalPlaylistForRss,
});

const SUBS_FILE = path.join(PODCAST_MAP_DIR, 'subscriptions.json');
const LEGACY_SUBS_FILE = '/home/brianwis/album_art/podcasts/subscriptions.json';

function readSubs() {
  try {
    // Immutable releases must not fall back into a private legacy home when
    // their shared podcast map is absent. Legacy checkout mode retains that
    // compatibility read until its state root is explicitly enabled.
    const src = fs.existsSync(SUBS_FILE) || RUNTIME_STATE_PATHS.sharedStateEnabled
      ? SUBS_FILE
      : LEGACY_SUBS_FILE;
    const raw = fs.readFileSync(src, "utf8");
    const j = JSON.parse(raw);
    const items = Array.isArray(j.items) ? j.items : [];
    const legacyPrefix = '/home/brianwis/album_art/podcasts/';
    return items.map((it) => {
      const outM3u = String(it?.outM3u || '');
      const mapJson = String(it?.mapJson || '');
      return {
        ...it,
        outM3u: outM3u.startsWith(legacyPrefix) ? path.join(PODCAST_MAP_DIR, path.basename(outM3u)) : outM3u,
        mapJson: mapJson.startsWith(legacyPrefix) ? path.join(PODCAST_MAP_DIR, path.basename(mapJson)) : mapJson,
      };
    });
  } catch {
    return [];
  }
}

function writeSubs(items) {
  RUNTIME_CAPABILITIES.assertStateWrite(SUBS_FILE);
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify({ items }, null, 2));
}

function normUrl(u) {
  return String(u || "").trim();
}

function makePodcastId(rss) {
  const norm = String(rss || '').trim().toLowerCase();
  const hash = crypto
    .createHash('sha1')
    .update(norm)
    .digest('hex')
    .slice(0, 10);
  return `pod-${hash}`;
}

registerPodcastSubscriptionRoutes(app, {
  capabilities: RUNTIME_CAPABILITIES,
  normUrl,
  readSubs,
  writeSubs,
  makePodcastId,
  podcastRoot: PODCAST_ROOT,
  fetchPodcastRSS,
  downloadCoverForSub,
  syncSubscriptionInitial,
  execFileP,
  musicLibraryRoot: MUSIC_LIBRARY_ROOT,
});

registerPodcastRefreshRoutes(app, {
  capabilities: RUNTIME_CAPABILITIES,
  readSubs,
  normUrl,
  buildPodcastMap,
  writeSubs,
});

// =========================
// Favorites (toggle current track in Favorites.m3u)
// =========================
//
// Accepts either:
//   POST /favorites/toggle   { favorite: true|false }
//   POST /favorite/current   { favorite: true|false }   (alias)
//
// Response:
//   { ok:true, isFavorite:true|false, file:"...", disabled?:true }
//

async function favoriteHandler(req, res) {
  try {
    const want = !!req?.body?.favorite;
    const requestedFile = String(req?.body?.file || '').trim();

    let file = requestedFile;
    if (!file) {
      const song = await fetchCurrentSong();
      file = String(song?.file || '').trim();
    }

    // disable for stream/airplay/no file
    if (!file || isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file: file || '', isFavorite: false, disabled: true });
    }

    // ✅ Do the real change on moOde by editing Favorites.m3u
    const out = await favoritesSetViaSsh(file, want);

    // Refresh favorites cache (best effort)
    try { await refreshFavoritesFromMpd(); } catch {}

    // Trust the SSH result as truth
    return res.json({ ok: true, file, isFavorite: !!out.isFavorite });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

app.post('/favorites/toggle', favoriteHandler);
app.post('/favorite/current', favoriteHandler); // alias

async function lookupMobileRadioMetadata({ artist = '', title = '', album = '', stationName = '', file = '' } = {}) {
  // Native AVPlayer receives the stream's raw ICY value. Some stations
  // publish a normal pair, while iHeart publishes a StreamTitle blob such as
  // `Chet Baker - text="Almost Blue" ... TPID="..."`. The web Now Playing
  // path already owns the station-specific cleanup; use that same helper
  // here before applying the shared iTunes matcher.
  const normalized = normalizeRadioMetadata({ artist, title, album, stationName, file });
  const lookupContext = deriveRadioLookupContext({
    artist: normalized.artist,
    title: normalized.title,
    album: normalized.album,
    profile: normalized.profile,
  });
  const rawArtist = String(normalized.artist || lookupContext.composer || '').trim();
  const rawTitle = String(normalized.title || '').trim();
  const rawAlbum = String(normalized.album || '').trim();
  const empty = (reason) => ({
    matched: false,
    title: rawTitle,
    artist: rawArtist,
    album: rawAlbum,
    year: '',
    artworkUrl: '',
    trackUrl: '',
    albumUrl: '',
    itunesUrl: '',
    reason,
    profile: normalized.profile,
    classification: normalized.classification,
    confidence: normalized.confidence,
    reasonCodes: normalized.reasonCodes,
    lookup: normalized.lookup,
  });

  if (!rawTitle) return empty('empty-title');
  if (!rawArtist) return empty('empty-artist');

  if (!normalized.lookup.allow) return empty(normalized.lookup.reason);

  const classical = normalized.classification === 'classical';
  const lookupArtist = sanitizeLookupArtistForItunes(lookupContext.lookupArtist || rawArtist);
  const lookupTitle = String(lookupContext.lookupTitle || rawTitle).trim();
  const curatedAlbum = curatedRadioAppleAlbum(
    normalized.profile,
    lookupContext.composer,
    lookupTitle,
  );
  const result = await lookupAppleCatalogFirst(lookupArtist, lookupTitle, false, {
    strictArtist: !classical,
    strictTitle: classical,
    radioAlbum: lookupContext.lookupAlbumHint,
    albumHint: lookupContext.lookupAlbumHint,
    composer: lookupContext.composer,
    composerShort: lookupContext.composerShort,
    ensembleHint: lookupContext.ensembleHint,
    conductorHint: lookupContext.conductorHint,
    soloistHint: lookupContext.soloistHint,
    labelHint: lookupContext.labelHint,
    programHint: lookupContext.programHint,
    preserveTitle: normalized.profile === 'davide-mimic',
    classicalAlbumSearch: normalized.profile === 'davide-mimic',
    curatedCollectionId: curatedAlbum?.collectionId || '',
    stationName: String(stationName || '').trim(),
    file: String(file || '').trim(),
  });
  const matchedTitle = String(result?.matchedTitle || '').trim();
  const verified = !!String(result?.url || result?.trackUrl || result?.albumUrl || '').trim()
    && (!matchedTitle || shouldAcceptMatchedTitle(classical ? lookupTitle : rawTitle, matchedTitle));
  if (!verified) return empty(result?.reason || 'no-match');

  return {
    matched: true,
    title: matchedTitle || lookupTitle || rawTitle,
    artist: String(result?.matchedArtist || rawArtist).trim(),
    album: String(result?.album || rawAlbum).trim(),
    year: String(result?.year || '').trim(),
    artworkUrl: String(result?.url || '').trim(),
    trackUrl: String(result?.trackUrl || '').trim(),
    albumUrl: String(result?.albumUrl || '').trim(),
    itunesUrl: String(result?.albumUrl || result?.trackUrl || '').trim(),
    reason: String(result?.reason || 'matched').trim(),
    profile: normalized.profile,
    classification: normalized.classification,
    confidence: normalized.confidence,
    reasonCodes: normalized.reasonCodes,
    lookup: normalized.lookup,
  };
}


async function enrichNowPlayingAbout({ artist = '', title = '', album = '', trackUrl = '', albumUrl = '', file = '', displayOnly = false } = {}) {
  if (displayOnly) return { status: ABOUT_STATUS.NOT_REQUESTED, data: null, provider: null };
  if (!String(artist || '').trim() || !String(title || '').trim()) {
    return { status: ABOUT_STATUS.NO_DATA, data: null, provider: null };
  }

  let acceptedTrackUrl = String(trackUrl || '').trim();
  let acceptedAlbumUrl = String(albumUrl || '').trim();
  if (!acceptedTrackUrl && !acceptedAlbumUrl) {
    const match = await lookupAppleCatalogFirst(artist, title, false, {
      strictArtist: true,
      albumHint: album,
    });
    acceptedTrackUrl = String(match?.trackUrl || '').trim();
    acceptedAlbumUrl = String(match?.albumUrl || '').trim();
  }
  if (!acceptedTrackUrl && !acceptedAlbumUrl) return { status: ABOUT_STATUS.NO_DATA, data: null, provider: null };

  const request = aboutResolver.resolve({
    trackUrl: acceptedTrackUrl,
    albumUrl: acceptedAlbumUrl,
    identityKey: file || `${artist}|${title}|${album}`,
  });
  try {
    return await Promise.race([
      request,
      new Promise((resolve) => setTimeout(() => resolve({ status: ABOUT_STATUS.NO_DATA, data: null, provider: null }), Math.max(250, APPLE_MUSIC_TIMEOUT_MS + 100))),
    ]);
  } catch {
    return { status: ABOUT_STATUS.NO_DATA, data: null, provider: null };
  }
}

app.get('/now-playing', async (req, res) => {
  const debug = req.query.debug === '1';
  const dlog = (...args) => { if (debug) log.debug(...args); };
  let currentQobuzState = null;

  function serveCached(reason, errMsg = '') {
    if (lastNowPlayingOk?.source === 'qobuz-connect' && !currentQobuzState?.active) {
      return res.status(503).json({
        error: 'now-playing unavailable',
        ...(debug ? { reason, err: errMsg } : {}),
      });
    }
    if (lastNowPlayingOk?.source === 'upnp-sonuvi' && !upnpPlaybackSession?.hasActiveSession?.()) {
      return res.status(503).json({
        error: 'now-playing unavailable',
        ...(debug ? { reason, err: errMsg } : {}),
      });
    }
    if (lastNowPlayingOk) {
      const ageMs = Date.now() - lastNowPlayingTs;
      return res.status(200).json({
        ...lastNowPlayingOk,
        _stale: true,
        _staleAgeMs: ageMs,
        ...(debug ? { _staleReason: reason, _staleError: errMsg } : {}),
      });
    }
    return res.status(503).json({
      error: 'now-playing unavailable',
      ...(debug ? { reason, err: errMsg } : {}),
    });
  }

  // Minimal helper: "24/192" -> "24-bit / 192 kHz"
  function formatHiresLabel(label) {
    const s = String(label || '').trim();
    const m = s.match(/^(\d{2})\s*\/\s*(\d{2,3})(?:\.(\d+))?$/);
    if (!m) return s;
    const bit = m[1];
    const khz = m[2];
    const frac = m[3] ? `.${m[3]}` : '';
    return `${bit}-bit / ${khz}${frac} kHz`;
  }



  // RADIO helper: split "Artist - Title" patterns safely
  function splitArtistTitleFromTitle(rawTitle) {
    const t0 = decodeHtmlEntities(String(rawTitle || '').trim());
    if (!t0) return { artist: '', title: '' };

    const seps = [' - ', ' — ', ' – ', ' —', '–', '—'];
    for (const sep of seps) {
      if (!t0.includes(sep)) continue;
      const parts = t0.split(sep).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return { artist: parts[0], title: parts.slice(1).join(sep.trim()) };
      }
    }
    return { artist: '', title: '' };
  }

  function artistLooksGeneric(a) {
    const s = String(a || '').trim();
    if (!s) return true;
    if (/^radio\s*station$/i.test(s)) return true;
    if (/^unknown$/i.test(s)) return true;
    if (/^stream$/i.test(s)) return true;
    if (/^\d{1,3}$/.test(s)) return true; // e.g., "06" track-number junk
    return false;
  }

  // Radio feeds sometimes publish only a shortened artist token (for example
  // "WAYNE") while a verified Apple/iTunes match gives us the full performer
  // name ("Wayne Shorter"). Promote only a clear prefix match so personnel
  // lists or unrelated enrichment cannot overwrite the feed's artist.
  function fullerRadioArtistName(currentArtist, performers, { verified = false } = {}) {
    const current = String(currentArtist || '').trim();
    const candidate = decodeHtmlEntities(String(performers || '').trim())
      .split(/\s*[,;|]\s*/)[0]
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();
    if (!candidate) return '';
    if (artistLooksGeneric(current)) return verified ? candidate : '';
    const currentLower = current.toLocaleLowerCase();
    const candidateLower = candidate.toLocaleLowerCase();
    return candidateLower.startsWith(`${currentLower} `) ? candidate : '';
  }

  // Guard iTunes lookups for non-music radio (talk/news/sports, etc.)
  function getRadioLookupGuard({ artist, title, album, encoded = '', stationName = '' }) {
    const a = String(artist || '').trim();
    const t = String(title || '').trim();
    const al = String(album || '').trim();
    const enc = String(encoded || '').trim();
    const st = String(stationName || '').trim();

    if (!t) return { allow: false, reason: 'empty-title' };

    const blob = [a, t, al, enc, st].join(' | ').toLowerCase();

    const talkishPatterns = [
      /(^|\W)talk(\W|$)/i,
      /(^|\W)news(\W|$)/i,
      /(^|\W)sports?(\W|$)/i,
      /sportstalk/i,
      /(^|\W)espn(\W|$)/i,
      /(^|\W)npr(\W|$)/i,
      /(^|\W)hour(\W|$)/i,
      /podcast/i,
      /weather/i,
      /traffic/i,
      /headline/i,
      /commentary/i,
      /interview/i,
      /morning\s+show/i,
      /afternoon\s+show/i,
      /drive\s*time/i,
      /play-by-play/i,
    ];
    const talkish = talkishPatterns.some((re) => re.test(blob));

    if (talkish) return { allow: false, reason: 'talk-news-sports' };

    // If artist is generic and title does not look like an artist-track split,
    // it is very likely station/program metadata rather than a song.
    // But allow if raw metadata includes an explicit "Artist - Title" form.
    if (artistLooksGeneric(a) && !/\s[-–—]\s/.test(t)) {
      const splitFromRaw = splitArtistTitleFromTitle(t) || splitArtistTitleFromTitle(a) || { artist: '', title: '' };
      if (!splitFromRaw.artist || !splitFromRaw.title) {
        return { allow: false, reason: 'generic-artist' };
      }
    }

    return { allow: true, reason: 'ok' };
  }

  function sanitizeRadioLookupInputs({ artist, title }) {
    let a = String(artist || '').trim();
    let t = decodeHtmlEntities(String(title || '').trim());

    // Drop obvious non-artist tokens like track numbers.
    if (artistLooksGeneric(a)) a = '';

    // Remove leading track-number noise from title.
    t = t.replace(/^\s*\d{1,3}[\s.)-]+/, '').trim();
    // Remove trailing bracketed index noise like "[95]" sometimes injected by stations.
    t = t.replace(/\s*\[\d{1,4}\]\s*$/,'').trim();

    // Classical-radio cleanup: if artist is likely composer and title carries
    // performer suffixes, prefer soloist or orchestra for iTunes matching.
    const composerBase = String(a || '').replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const composerLike = /^[A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Za-zÀ-ÿ'’.-]+){0,7}$/.test(composerBase);
    if (composerLike) {
      // e.g. "... Op. 7-Isata Kanneh-Mason, p; Royal Liverpool Phil Orch/Holly..."
      const soloistMatch = t.match(/^(.*?)\s*-\s*([^,;\/\-]+?)\s*,\s*(?:h|hp|harp|p|pf|pno|vn|vln|vc|cello|soprano|mezzo|tenor|baritone)\b/i);
      if (soloistMatch) {
        const work = String(soloistMatch[1] || '').trim();
        const soloist = String(soloistMatch[2] || '').trim();
        if (soloist) a = soloist;
        if (work) t = work;
      } else {
        // e.g. "... Op 39-Milwaukee Sym Orch/Zdenek Macal"
        const perfMatchOp = t.match(/^(.*?\bOp\.?\s*\d+\b)\s*-\s*([A-Za-zÀ-ÿ0-9'’.&\- ]+\s+Orch(?:estra)?)(?:\s*\/\s*([A-Za-zÀ-ÿ'’.\- ]+))?\s*$/i);
        const perfMatch = perfMatchOp || t.match(/^(.*?)[\s-]+([A-Za-zÀ-ÿ0-9'’.&\- ]+\s+Orch(?:estra)?)(?:\s*\/\s*([A-Za-zÀ-ÿ'’.\- ]+))?\s*$/i);
        if (perfMatch) {
          const work = String(perfMatch[1] || '').trim();
          const ens = String(perfMatch[2] || '').trim().replace(/\bOrch\b/gi, 'Orchestra');
          if (ens) a = ens;
          if (work) t = work;
        } else {
          // e.g. "Fields of Wonder - Cantus" (performer trailing in title)
          const trailingPerf = t.match(/^(.*?)\s*-\s*([A-Za-zÀ-ÿ0-9'’.&\- ]{2,80})\s*$/i);
          if (trailingPerf) {
            const work = String(trailingPerf[1] || '').trim();
            const perf = String(trailingPerf[2] || '').trim();
            const perfLooksUseful = /\b(choir|chorale|chorus|consort|ensemble|orchestra|orch|singers|cantus|players|quartet|trio|duo)\b/i.test(perf) || /^cantus$/i.test(perf);
            if (perfLooksUseful && work) {
              a = perf;
              t = work;
            }
          }
        }
      }

      // Drop trailing performer blocks after semicolon/slash from title.
      t = t.replace(/\s*[;\/].*$/, '').trim();
    }

    return { artist: a, title: t };
  }

  // Build a deterministic Apple lookup term (keeps cache stable)
  function looksAlbumHintText(s) {
    const v = String(s || '').trim();
    if (!v) return false;
    if (/^wfmt\b|radio|stream/i.test(v)) return false;
    // album-ish: work separators and rich punctuation, not just person names
    if (/:/.test(v) || /\b(op\.?|concerto|symphony|quartet|sonata|season|saisons|concertos?)\b/i.test(v)) return true;
    return false;
  }

  function isLabelLikeHint(s) {
    const v = String(s || '').trim();
    if (!v) return false;
    if (/:/.test(v)) return false;
    if (/\b(op\.?|concerto|symphony|quartet|sonata|suite|metamorphoses?)\b/i.test(v)) return false;
    // short single-token label-ish hints: Koss, Decca, Naxos, etc.
    if (/^[A-Za-z0-9&'’.-]{2,18}$/.test(v)) return true;
    return false;
  }

  function isProgramDateHint(s) {
    const v = String(s || '').trim();
    if (!v) return false;
    if (/\blive\s+in\b/i.test(v)) return true;
    if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(v) && /\b(19|20)\d{2}\b/.test(v)) return true;
    return false;
  }

  function buildAppleLookupTerm({ artist, title, album, composer = '', ensemble = '', conductor = '' }) {
    const s = sanitizeRadioLookupInputs({ artist, title });
    const a = String(s.artist || '').trim();
    const t = String(s.title || '').trim();
    const al = String(album || '').trim();
    const c = String(composer || '').trim();
    const e = String(ensemble || '').trim();
    const d = String(conductor || '').trim();

    const parts = [];
    if (c) parts.push(c);
    if (t) parts.push(t);
    if (a) parts.push(a);
    if (e && e.toLowerCase() !== a.toLowerCase()) parts.push(e);
    if (d) parts.push(d);
    if (al) parts.push(al);
    return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  function stripClassicalMovementDetail(s) {
    let t = decodeHtmlEntities(String(s || '').trim());
    t = t.replace(/,\s*\d+(?:st|nd|rd|th)\s+tableau\s*:\s*.*/i, '');
    t = t.replace(/:\s*[IVXLC]+\.?\s+.*$/i, '');
    // Keep movement detail in the display title, but remove it from Apple
    // lookup terms (e.g. "Work - I. Andantino - Allegro").
    t = t.replace(/\s+-\s+[IVXLC]+\.?\s+.*$/i, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    return t;
  }

  function extractClassicalAlbumHintFromDashedTitle(raw) {
    const s = decodeHtmlEntities(String(raw || '').trim());
    if (!s || !/\s-\s/.test(s)) return '';
    const parts = s.split(/\s-\s/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 4) return '';
    const last = String(parts[parts.length - 1] || '').trim();
    const prev = String(parts[parts.length - 2] || '').trim();
    if (!last) return '';

    const prevLooksPerformer = /orch|orchestra|orchester|symphony|symphonie|philharmonic|ensemble|\/|,/.test(prev.toLowerCase());
    const lastLooksAlbum = /:/.test(last) || /\b(op\.?|concerto|symphony|quartet|sonata|metamorphoses?)\b/i.test(last);
    if (prevLooksPerformer && lastLooksAlbum) return last;
    return '';
  }

  function deriveRadioLookupContext({ artist, title, radioPerformers = '', personnel = [], albumHint = '' }) {
    const s = sanitizeRadioLookupInputs({ artist, title });
    const composerDisplay = String(artist || '').trim();
    let lookupArtist = String(s.artist || '').trim();
    const lookupTitleFull = String(s.title || '').trim();
    let lookupTitle = String(s.title || '').trim();

    const perf = decodeHtmlEntities(String(radioPerformers || '').trim());
    const pList = [];
    for (const p of (Array.isArray(personnel) ? personnel : [])) pList.push(String(p || '').trim());
    if (perf) pList.push(...perf.split(/\s*,\s*/));

    const cleaned = pList
      .map((p) => p.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);

    const ensemble = cleaned.find((p) => /orchestra|orchester|symphony|symphonie|philharmonic|camerata|ensemble|chamber\s+orchestra/i.test(p));
    if (ensemble) lookupArtist = ensemble;
    const conductorRaw = pList.find((p) => /\(conductor\)/i.test(p)) || '';
    const conductor = String(conductorRaw).replace(/\s*\(conductor\)\s*/i, '').trim();
    const conductorNames = new Set(
      pList
        .filter((p) => /\(conductor\)/i.test(p))
        .map((p) => String(p).replace(/\s*\(conductor\)\s*/i, '').trim().toLowerCase())
    );
    const soloistRaw = cleaned.find((p) => !conductorNames.has(String(p).toLowerCase()) && !/orchestra|orchester|symphony|symphonie|philharmonic|ensemble|camerata/i.test(p)) || '';
    const soloist = String(soloistRaw || '').replace(/\s*\([^)]*\)\s*/g, '').trim();

    // For classical, movement-heavy titles over-constrain iTunes query.
    if (lookupArtist && cleaned.length) lookupTitle = stripClassicalMovementDetail(lookupTitle);

    const parts = composerDisplay.replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim().split(/\s+/).filter(Boolean);
    const composerShort = parts.length >= 2
      ? `${parts[0].charAt(0)}. ${parts[1].slice(0, 4)}`
      : '';

    return {
      lookupArtist,
      lookupTitle,
      lookupTitleFull,
      lookupAlbumHint: String(albumHint || '').trim(),
      composer: composerDisplay,
      composerShort,
      ensembleHint: String(ensemble || '').trim(),
      conductorHint: String(conductor || '').trim(),
      soloistHint: String(soloist || '').trim(),
    };
  }

  try {
    currentQobuzState = await qobuzConnect.get();
    if (currentQobuzState.active) {
      // MPD is still useful for the queue position and receiver volume, but
      // Qobuz owns the visible track while its metadata session is active.
      let qobuzSong = {};
      let qobuzStatus = {};
      try { qobuzSong = await fetchCurrentSong(); } catch {}
      try { qobuzStatus = await fetchCurrentStatus(); } catch {}

      const payload = buildQobuzNowPlayingPayload({
        qobuz: currentQobuzState,
        mpdSong: qobuzSong,
        mpdStatus: qobuzStatus,
        publicBaseUrl: PUBLIC_BASE_URL,
      });
      payload.aboutStatus = ABOUT_STATUS.NOT_REQUESTED;
      lastNowPlayingOk = payload;
      lastNowPlayingTs = Date.now();
      return res.json(payload);
    }
    const qobuzOwnershipUnknown = currentQobuzState?.ownershipState === 'unknown';
    if (currentQobuzState.suppressMpdHistory && !qobuzOwnershipUnknown) {
      return res.status(503).json({
        error: 'qobuz metadata unavailable',
        ...(debug ? { reason: currentQobuzState.reason || 'transport-error' } : {}),
      });
    }

    let upnpNowPlaying = null;
    if (upnpPlaybackSession) {
      try { upnpNowPlaying = await upnpPlaybackSession.getNowPlaying(); } catch {}
    }
    if (upnpNowPlaying) {
      const rawArtUrl = String(upnpNowPlaying.artworkSourceUrl || '').trim();
      if (rawArtUrl) {
        const cached = await updateArtCacheIfNeeded(rawArtUrl);
        if (cached) upnpNowPlaying.albumArtUrl = `${PUBLIC_BASE_URL}/art/current.jpg`;
        // Keep the source-specific artwork identity in the canonical display
        // field. Clients proxy this through /art/current.jpg?v=..., so using
        // only the generic current-art URL here can re-key the request to an
        // older Qobuz/MPD cache entry after an UPnP track transition.
        upnpNowPlaying.displayArtUrl = rawArtUrl;
      }
      delete upnpNowPlaying.artworkSourceUrl;
      upnpNowPlaying.aplArtUrl = `${PUBLIC_BASE_URL}/art/current.jpg`;
      upnpNowPlaying.aboutStatus = ABOUT_STATUS.NOT_REQUESTED;
      lastNowPlayingOk = upnpNowPlaying;
      lastNowPlayingTs = Date.now();
      return res.json(upnpNowPlaying);
    }

    // 1) Fetch moOde/MPD snapshots
    let song, statusRaw;
    try {
      song = await fetchCurrentSong();
    } catch (e) {
      if (qobuzOwnershipUnknown) {
        return res.status(503).json({
          error: 'playback ownership unknown',
          ...(debug ? { reason: 'mpd-evidence-unavailable' } : {}),
        });
      }
      return serveCached('mpd_currentsong_failed', e?.message || String(e));
    }

    try {
      statusRaw = await fetchCurrentStatus();
    } catch (e) {
      if (qobuzOwnershipUnknown) {
        return res.status(503).json({
          error: 'playback ownership unknown',
          ...(debug ? { reason: 'mpd-evidence-unavailable' } : {}),
        });
      }
      return serveCached('status_failed', e?.message || String(e));
    }

    if (qobuzOwnershipUnknown && !hasVerifiedMpdPlaybackEvidence({
      state: moodeValByKey(statusRaw, 'state'),
      file: song?.file,
    })) {
      return res.status(503).json({
        error: 'playback ownership unknown',
        ...(debug ? { reason: 'mpd-playback-not-confirmed' } : {}),
      });
    }

    const status = normalizeMoodeStatus(statusRaw);
    const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
    const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();
    const currentJukeboxEntry = jukeboxEntries.get(Number(songid));
    const jukeboxSource = String(currentJukeboxEntry?.source || '').trim();
    const jukeboxSelectionNumber = Number(currentJukeboxEntry?.selectionNumber);
    const randomState = String(moodeValByKey(statusRaw, 'random') || '').trim();
    const repeatState = String(moodeValByKey(statusRaw, 'repeat') || '').trim();

    let file = String(song.file || '').trim();
    const isLocalPodcast = isLocalPodcastFile(file);
    const stream = isStreamPath(file);
    const airplay =
      isAirplayFile(file) || (String(song.encoded || '').toLowerCase() === 'airplay');
    if (airplay && !airplaySessionWasActive) airplaySessionStartedAt = Date.now();
    if (!airplay) airplaySessionStartedAt = 0;
    airplaySessionWasActive = airplay;

    const streamKind = stream ? String(getStreamKind(file) || '').trim() : '';
    const isYouTubeStream = !!(stream && (/googlevideo\.com|youtube\.com|youtu\.be/i.test(file) || /\/youtube\/proxy\//i.test(file)));
    const effectiveStreamKind = isYouTubeStream ? 'youtube' : streamKind;
    const isUpnp = effectiveStreamKind === 'upnp';
    const isRadio = stream && effectiveStreamKind === 'radio';

    // 2) Base metadata
    let artist = song.artist || '';
    let title  = song.title  || '';
    let album  = song.album  || '';

    // Machine-readable date for clients
    // - songs: keep YYYYMM (no day)
    // - podcasts: override from MPD via mpc (YYYY-MM-DD)
    let dateOut = '';

    {
      const s = String(song.date || '').trim();
      const m = s.match(/^(\d{4})(\d{2})/); // YYYYMM or YYYYMMDD
      if (m) dateOut = `${m[1]}${m[2]}`;    // month precision default
    }
    
    // ✅ Podcast date must come from MPD (moOde JSON loses day precision)
    if (isLocalPodcast) {
        const mpdDate = String(await getMpdCurrentDateTag()).trim();

        // Only override if MPD gives full day precision
        if (/^\d{4}-\d{2}-\d{2}$/.test(mpdDate)) {
            dateOut = mpdDate;
        }
    }
    
    // 3) Art + extras
    let altArtUrl = '';
    let producer = '';
    let personnel = [];

    let radioAlbum = '';
    let radioYear = '';
    let radioLabel = '';
    let radioComposer = '';
    let radioWork = '';
    let radioPerformers = '';

    let debugItunesReason = '';
    let debugRadioHoldback = null;

    let stationLogoUrl = '';
    let primaryArtUrl = '';
    // Keep station identity tied to the stream URL. iTunes enrichment may
    // replace the song/album fields, but it must never erase the station.
    let streamStationName = isRadio
      ? await radioStationNameForFile(file, String(song?.name || song?.album || '').trim())
      : String(song?.name || song?.album || '').trim();
    const radioMetadataProfileName = isRadio ? sharedRadioMetadataProfile(streamStationName, file) : 'generic';

    // ✅ Apple Music link fields (RADIO)
    let radioItunesUrl = '';
    let radioTrackUrl = '';
    let radioAlbumUrl = '';
    let shareUrl = '';
    let radioLookupReason = '';
    let radioLookupTerm = '';
    let radioClassification = '';
    let radioConfidence = '';
    let radioReasonCodes = [];
    let radioMetadataContract = null;

    // Default art scaffolding
    if (stream) {
      stationLogoUrl = song.coverurl ? normalizeCoverUrl(song.coverurl, MOODE_BASE_URL) : '';
      if (!stationLogoUrl && isRadio && streamStationName) {
        stationLogoUrl = `${MOODE_BASE_URL}/imagesw/radio-logos/thumbs/${encodeURIComponent(streamStationName)}.jpg`;
      }
      primaryArtUrl = stationLogoUrl || '';
    } else if (!airplay && file) {
      primaryArtUrl = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(file)}`;
    }
    
    // =========================
    // RADIO: iHeart "blob" cleanup
    // =========================
    function looksLikeIheartBlob(t) {
        const s = String(t || '').trim();
        if (!s) return false;

        // ✅ Sponsor/ad blob
        if (/(^|[\s,])adContext="[^"]+"/i.test(s)) return true;

        // iHeart track blob variants seen in wild:
        // - text="..." + TPID="..."
        // - title="...",artist="..." with extra key/value payload
        if ((/(^|\s)text="[^"]+"/i.test(s) && /\bTPID="\d+"/.test(s))) return true;
        if (/\btitle="[^"]+"/i.test(s) && /\bartist="[^"]+"/i.test(s) && /\bTPID="\d+"/.test(s)) return true;

        return false;
    }

    if ((isRadio || stream) && looksLikeIheartBlob(title)) {
        const parsed = parseIheartTitleBlob(title);

        if (parsed?.artist) {
            artist = parsed.artist;
        }

        if (parsed?.title) {
            title = parsed.title;
        }

        if (debug) {
            dlog('[iheart] cleaned', {
                artist,
                title,
                art: parsed?.artUrl,
            });
        }
    }

    // Shared contract: preserve the existing enrichment/matching pipeline
    // below, while making one normalized source record authoritative for
    // profile, classification, conservative lookup gating, and radio fields.
    if (isRadio) {
      radioMetadataContract = normalizeRadioMetadata({
        artist: song?.artist || artist,
        title: song?.title || title,
        album: song?.album || album,
        stationName: streamStationName,
        file,
      });
      artist = radioMetadataContract.artist || artist;
      title = radioMetadataContract.title || title;
      radioClassification = radioMetadataContract.classification;
      radioConfidence = radioMetadataContract.confidence;
      radioReasonCodes = radioMetadataContract.reasonCodes;
      if (radioMetadataContract.composer && !radioComposer) radioComposer = radioMetadataContract.composer;
      if (radioMetadataContract.work && !radioWork) radioWork = radioMetadataContract.work;
      if (radioMetadataContract.program && !radioAlbum) radioAlbum = radioMetadataContract.program;
      if (radioMetadataContract.personnel.length && !radioPerformers) {
        radioPerformers = radioMetadataContract.personnel.join(', ');
      }
    }

    // --- per-request flag (do NOT keep podcast state globally)
    // Primary truth: local file path indicates "podcast mode" even if enrichment misses.
    let isPodcast = isLocalPodcast;
    let playbackUrl = '';

    // =========================
    // PODCAST: enrich using RSS-built JSON maps
    // =========================
    try {
        // Helper mutates payload in place.
        const tmp = {
                artist,
                title,
                album,
                file,
                albumArtUrl: '',
                encoded: song.encoded || '',
        };

        await enrichPodcastNowPlaying(tmp);

        // Treat any of these as “enriched podcast”
        const enrichedPodcast =
                tmp.podcast === true ||
                tmp.isPodcast === true ||
                tmp.podcastEpisode === true;

        if (enrichedPodcast) {
                isPodcast = true;

                // Show name: prefer explicit show fields; otherwise fall back to album/artist.
                // (NPR-style feeds often put the show title in album, with artist = "Unknown artist".)
                const showTitle = String(
                        tmp.podcastTitle ||
                        tmp.showTitle ||
                        tmp.show ||
                        tmp.album ||
                        tmp.artist ||
                        ''
                ).trim();

                // Episode title: prefer enriched title, else keep existing
                const episodeTitle = String(tmp.title || title || '').trim();

                // Human-friendly episode date (YYYY-MM-DD → "Feb 5, 2026")
                const epDateLine = formatPodcastDate(tmp.published);

                // ✅ Podcast display mapping
                //   artist → show name
                //   title  → episode title
                //   album  → published date (human-friendly)
                if (showTitle)      artist = showTitle;
                if (episodeTitle)   title  = episodeTitle;
                if (epDateLine)     album  = epDateLine;

                // Machine-readable date for clients (podcasts want day precision)
                // Prefer MPD tag (mpc) because moOde JSON can lose the day (e.g., "202602")
                const mpdDate = String(await getMpdCurrentDateTag()).trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(mpdDate)) {
                        dateOut = mpdDate;
                } else {
                        const pub = String(tmp.published || tmp.date || tmp.pubDate || '').trim();
                        if (pub) dateOut = pub; // expect YYYY-MM-DD
                }

                // Prefer stable playback URL (strip tracking / redirect wrappers)
                const canonUrl = canonicalizePodcastUrl(file);
                if (canonUrl) {
                        tmp.playbackUrl = canonUrl;
                        playbackUrl = canonUrl;
                }

                // Podcast art becomes primary art
                if (tmp.albumArtUrl) {
                        primaryArtUrl = tmp.albumArtUrl;
                        stationLogoUrl = '';
                }

                if (debug) {
                        dlog('[podcast] enriched', {
                                enrichedPodcast,
                                showTitle: artist,
                                episodeTitle: title,
                                dateLine: album,
                                primaryArtUrl,
                                published: tmp.published,
                                mpdDate,
                                dateOut,
                                episodeId: tmp.episodeId,
                                playbackUrl,
                        });
                }
        }
    } catch (e) {
        if (debug) dlog('[podcast] enrich failed', e?.message || String(e));
    }
   
    
    const aplArtUrl = `${PUBLIC_BASE_URL}/art/current.jpg`;

    // ✅ ratings allowed only for local files
    const ratingsAllowed = (!stream && !airplay && !!file);

    // =========================
    // AIRPLAY (authoritative aplmeta.txt, unchanged behavior)
    // =========================
    if (airplay) {
      let airplayInfoLine = 'AirPlay';
      try {
        const aplUrl = String(MOODE_BASE_URL).replace(/\/+$/, '') + '/aplmeta.txt';
        const aplResponse = await fetch(aplUrl, {
          headers: { Accept: 'text/plain' },
          agent: agentForUrl(aplUrl),
          cache: 'no-store',
        });
        if (!aplResponse.ok) throw new Error('aplmeta.txt HTTP ' + aplResponse.status);
        const lastModified = aplResponse.headers.get('last-modified') || '';
        if (!isFreshAirplayMetadata(lastModified, airplaySessionStartedAt)) {
          if (debug) dlog('[airplay] ignoring stale aplmeta.txt', { lastModified, airplaySessionStartedAt });
          throw new Error('stale aplmeta.txt');
        }
        const ap = parseAplmeta(await aplResponse.text());

        artist = ap.artist || artist || '';
        title  = ap.title  || title  || '';
        album  = ap.album  || album  || 'AirPlay Source';

        const isAirplaySourceAlbum = /^airplay\s+source$/i.test(String(ap.album || '').trim());
        const looksStickyCover = /imagesw\/airplay-covers\/cover-[a-f0-9]{8,}\.jpg/i.test(String(ap.coverRel || ''));
        const ytBlob = [ap.title, ap.artist, ap.album, ap.coverRel].map((x) => String(x || '').toLowerCase()).join(' | ');
        const looksYouTube = /(youtube|youtu\.be|ytmusic|yt music)/i.test(ytBlob);
        const youtubeLogo = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/09/YouTube_full-color_icon_%282017%29.svg/512px-YouTube_full-color_icon_%282017%29.svg.png';
        // YouTube/other senders often provide title/artist but no fresh art, while aplmeta can retain an older cover file.
        // In that case, prefer non-stale fallback art.
        if (isAirplaySourceAlbum && looksStickyCover) {
          altArtUrl = looksYouTube ? youtubeLogo : `${MOODE_BASE_URL}/images/default-album-cover.png`;
        } else if (looksYouTube && !ap.coverUrl) {
          altArtUrl = youtubeLogo;
        } else {
          altArtUrl = ap.coverUrl || '';
        }
        if (altArtUrl) primaryArtUrl = altArtUrl;
        airplayInfoLine = ap.format || 'AirPlay';
      } catch {}

      const rawArtUrl = (altArtUrl && altArtUrl.trim())
        ? altArtUrl.trim()
        : (primaryArtUrl || '');

      if (rawArtUrl) {
        updateArtCacheIfNeeded(rawArtUrl).catch(e => console.warn('[art] failed', e.message));
      }

      let queueTotal = Math.max(0, Number(status?.playlistlength || moodeValByKey(statusRaw, 'playlistlength') || 0) || 0);
      let queueTrack = 0;
      {
        const sp = Number(songpos);
        if (Number.isFinite(sp) && sp >= 0) queueTrack = sp + 1;
      }
      if (queueTotal <= 0 || queueTrack <= 0) {
        try {
          const stq = await mpdGetStatus();
          const t = Math.max(0, Number(stq?.playlistlength || 0) || 0);
          const s = Number(stq?.song);
          if (queueTotal <= 0 && t > 0) queueTotal = t;
          if (queueTrack <= 0 && Number.isFinite(s) && s >= 0) queueTrack = s + 1;
        } catch {}
      }

      const payload = {
        artist: artist || '',
        title: title || '',
        album: album || '',
        file: file || 'AirPlay Active',

        songpos,
        songid,
        queueTrack,
        queueTotal,
        queueLabel: (queueTrack > 0 && queueTotal > 0) ? `Track ${queueTrack} of ${queueTotal}` : '',

        albumArtUrl: primaryArtUrl || '',
        aplArtUrl,
        altArtUrl: altArtUrl || '',

        stationLogoUrl: '',
        stationName: '',
        radioStationName: '',

        // RADIO fields (empty on AirPlay)
        radioAlbum: '',
        radioYear: '',
        radioLabel: '',
        radioComposer: '',
        radioWork: '',
        radioPerformers: '',
        radioItunesUrl: '',
        radioTrackUrl: '',
        radioAlbumUrl: '',
        shareUrl: '',
        radioLookupReason: '',
        radioLookupTerm: '',

        state: airplay ? 'play' : (status.state || song.state),
        elapsed: status.elapsed,
        duration: status.duration,
        percent: status.percent,

        year: '',
        label: '',
        producer: '',
        personnel: [],

        encoded: airplayInfoLine,
        bitrate: song.bitrate || '',
        outrate: song.outrate || '',
        volume: song.volume || '0',
        mute: song.mute || '0',
        track: song.track || '',
        date: dateOut || '',

        isStream: false,
        isAirplay: true,
        isYoutube: false,
        streamKind: '',
        isUpnp: false,

        isFavorite: false,

        // rating fields always present
        rating: 0,
        ratingDisabled: true,
        ratingFile: '',

        ...(debug ? { debugAplmetaUrl: `${MOODE_BASE_URL}/aplmeta.txt` } : {}),
      };
      
      await enrichPodcastNowPlaying(payload);

      lastNowPlayingOk = payload;
      lastNowPlayingTs = Date.now();
      return res.json(payload);
    }

    // =========================
    // STREAM: optional private side-channel metadata (radio only)
    // =========================
    let meStation = null;
    let meMeta = null;

    if (isRadio) {
      meStation = matchMotherEarthStation(file);
      if (meStation) {
        try {
          meMeta = await fetchMotherEarthMeta(meStation);
          if (meMeta) {
            artist = meMeta.artist || artist || '';
            title  = meMeta.title  || title  || '';
            album  = meMeta.album  || album  || '';

            if (meMeta.art) primaryArtUrl = meMeta.art;

            radioAlbum = meMeta.album || radioAlbum || '';
          }
        } catch (e) {
          dlog('[private-meta] fetch failed:', e?.message || String(e));
        }
      }
    }

    // =========================
    // STREAM: UPnP resolver (upnp only)
    // =========================
    let debugArtUpgraded = false;
    let debugResolvedFile = '';
    let debugArtErr = '';

    if (stream && isUpnp) {
      try {
        const hasResolverInputs =
          !!songpos || !!songid ||
          !!String(song.title || '').trim() ||
          !!String(song.artist || '').trim() ||
          !!String(song.album || '').trim() ||
          !!String(song.track || '').trim();

        if (hasResolverInputs) {
          const realFile = await resolveLibraryFileForStream({
            songid,
            songpos,
            title: song.title || '',
            artist: song.artist || '',
            album: song.album || '',
            track: song.track || '',
          });

          debugResolvedFile = realFile || '';
          if (realFile) {
            primaryArtUrl = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(realFile)}`;
            debugArtUpgraded = true;
          }
        }
      } catch (e) {
        debugArtErr = e?.message || String(e);
        dlog('UPnP/stream art upgrade failed:', debugArtErr);
      }
    }

    // =========================
    // RADIO: extract performers from verbose title lines
    // =========================
    if (isRadio && title) {
      const previousRadioPerformers = decodeHtmlEntities(String(radioPerformers || '').trim());
      const split = radioMetadataProfileName === 'davide-mimic'
        ? (splitDavideMimicTitlePerformersProgram(title) || splitTitlePerformersProgram(title))
        : splitTitlePerformersProgram(title);
      if (split) {
        title = split.work;
        const splitComposer = String(split.composer || '').trim();
        const curArtist = String(artist || '').trim();
        const programTxt = String(split.program || '').trim();
        const programComposer = /^\s*(?:J\.?\s*Chr\.?\s*Bach|JC\s*Bach)\s*:/i.test(programTxt)
          ? 'Johann Christian Bach'
          : '';
        const shouldPromoteComposer = (
          !!splitComposer && (
            artistLooksGeneric(curArtist) ||
            !curArtist ||
            curArtist.toLowerCase() === String(split.work || '').trim().toLowerCase() ||
            /wfmt|radio station|classical|davide|mimic/i.test(curArtist)
          )
        ) || (!curArtist && !!programComposer);
        if (shouldPromoteComposer) {
          artist = splitComposer || programComposer;
        }

        const set = new Set(
          (Array.isArray(personnel) ? personnel : [])
            .map(p => String(p).trim())
            .filter(Boolean)
        );

        for (const p of split.personnel) set.add(p);
        personnel = Array.from(set);
        if (split.personnel?.length) {
          radioPerformers = split.personnel.join(', ');
        }
        if (split.program) {
          const programRaw = String(split.program || '').trim();
          const programClean = programRaw.replace(/^.*?:\s*/, '').trim();
          if (programClean && (!radioAlbum || /\barchiv\b|\bdecca\b|\berato\b|\bemi\b|\blaserlight\b/i.test(String(radioAlbum)))) {
            radioAlbum = programRaw;
          }
        }
        // If station/label-ish album is present but metadata provided a richer program title,
        // use that richer text as radio album line.
        if (looksAlbumHintText(previousRadioPerformers) && (!radioAlbum || /\berato\b|\blaserlight\b|\bwfmt\b|\bradio\b|\bstream\b/i.test(String(radioAlbum)))) {
          radioAlbum = previousRadioPerformers;
        }
      }
    }

    // If radio album resolves to a plain label token (e.g., Signum/Decca), don't present it as album.
    if (isRadio && isLabelLikeHint(radioAlbum)) {
      radioAlbum = '';
    }

    // =========================
    // RADIO: normalize displayed artist/title from "Artist - Title"
    // =========================
    if (isRadio) {
      const a0 = String(artist || '').trim();

      if (artistLooksGeneric(a0)) {
        const split = splitArtistTitleFromTitle(title);
        if (split.artist && split.title) {
          artist = split.artist;
          title  = split.title;
        }
      } else {
        const decoded = decodeHtmlEntities(String(title || '').trim());

        // If title starts with full hyphenated composer surname (e.g., Ippolitov-Ivanov)
        // and current artist is only a prefix, promote artist to the full composer.
        const hyComposer = decoded.match(/^([A-Za-zÀ-ÿ'’.\- ]+\-[A-Za-zÀ-ÿ'’.\- ]+)\s+-\s+(.+)$/);
        if (hyComposer) {
          const fullComposer = String(hyComposer[1] || '').trim();
          const rest = String(hyComposer[2] || '').trim();
          if (!a0 || fullComposer.toLowerCase().startsWith(a0.toLowerCase())) {
            artist = fullComposer;
            title = rest;
          }
        }

        const prefix = `${String(artist || a0).trim()} - `;
        if (decoded.toLowerCase().startsWith(prefix.toLowerCase())) {
          title = decoded.slice(prefix.length).trim();
        }
      }
    }

    // Apply radio metadata holdback only for strict stations (WFMT/classical).
    // For normal talk/sports/news streams, do not hold stale track metadata.
    if (isRadio) {
      const hbPolicy = radioHoldbackPolicy(String(streamStationName || song?.name || '').trim(), String(file || song?.name || '').trim());
      if (hbPolicy.mode === 'strict') {
        const hb = applyRadioMetadataHoldback({
          stationKey: String(file || song?.name || '').trim(),
          stationName: String(streamStationName || song?.name || '').trim(),
          artist,
          title,
          album: radioAlbum || album || '',
          radioPerformers,
          elapsedSec: status?.elapsed,
        });
        artist = String(hb?.artist || artist || '').trim();
        title = String(hb?.title || title || '').trim();
        if (String(hb?.album || '').trim()) {
          radioAlbum = String(hb.album).trim();
          if (!String(album || '').trim()) album = radioAlbum;
        }
        if (String(hb?.radioPerformers || '').trim()) {
          radioPerformers = String(hb.radioPerformers).trim();
        }
        debugRadioHoldback = hb?.holdback || null;
      } else {
        debugRadioHoldback = { active: false, reason: 'skipped-non-strict', policy: hbPolicy.mode };
      }
    }

    // =========================
    // FILE: deep tags
    // =========================
    const deep = stream
      ? { year: '', label: '', producer: '', performers: [] }
      : await getDeepMetadataCached(file);

    producer = deep.producer || '';
    {
      const merged = new Set([
        ...((Array.isArray(personnel) ? personnel : []).map((p) => String(p).trim()).filter(Boolean)),
        ...((Array.isArray(deep.performers) ? deep.performers : []).map((p) => String(p).trim()).filter(Boolean)),
      ]);
      personnel = Array.from(merged);
    }

    const existingRadioLookupGuard = isRadio
      ? getRadioLookupGuard({
          artist,
          title,
          album: radioAlbum || album || '',
          encoded: song.encoded || '',
          stationName: streamStationName || song.name || '',
        })
      : { allow: true, reason: 'not-radio' };
    const radioLookupGuard = isRadio && radioMetadataContract?.lookup?.allow === false
      ? radioMetadataContract.lookup
      : existingRadioLookupGuard;

    // =========================
    // STREAM: iTunes art + album/year fallback (RADIO ONLY)
    // (Also captures links when available, without clobbering later.)
    // =========================
    const sanitizedLookup = sanitizeRadioLookupInputs({ artist, title });
    let lookupArtist = String(sanitizedLookup.artist || '').trim();
    let lookupTitle = String(sanitizedLookup.title || '').trim();

    if (isRadio && radioLookupGuard.allow && (!primaryArtUrl || primaryArtUrl === stationLogoUrl)) {
      let albumForLookup = String(radioAlbum || album || '').trim();
      // MIMIC's "Live in ..." value is useful search context even though it
      // is usually a broadcast/program label rather than an Apple album.
      const programHint = radioMetadataProfileName === 'davide-mimic'
        ? String(radioAlbum || album || '').trim()
        : '';
      const stName0 = String(song?.name || '').trim();
      if (albumForLookup && stName0 && albumForLookup.toLowerCase() === stName0.toLowerCase()) albumForLookup = '';
      if (/\bwfmt\b|\bclassical\b|\bradio\b|\bstream\b|\bmimic\b|\berato\b|\blaserlight\b/i.test(albumForLookup)) albumForLookup = '';
      if (isLabelLikeHint(albumForLookup) || isProgramDateHint(albumForLookup)) albumForLookup = '';
      // Classical streams may include album as the last dashed segment in title metadata.
      const dashedAlbumHint = extractClassicalAlbumHintFromDashedTitle(song.title || title || '');
      if (!albumForLookup && looksAlbumHintText(dashedAlbumHint)) albumForLookup = dashedAlbumHint;

      // WFMT often places useful program/album clue in radioPerformers; use it as album hint when present.
      const perfAlbumHint = decodeHtmlEntities(String(radioPerformers || '').trim());
      if (!albumForLookup && looksAlbumHintText(perfAlbumHint)) albumForLookup = perfAlbumHint;
      const labelHint = extractLabelHintFromRawTitle(song.title || title || '');

      const lookupCtx = deriveRadioLookupContext({
        artist,
        title,
        radioPerformers,
        personnel,
        albumHint: albumForLookup,
      });
      const soloistHintRaw = decodeHtmlEntities(String(radioPerformers || '').trim()).split(',')[0]?.trim() || '';
      lookupArtist = String(lookupCtx.lookupArtist || lookupArtist || '').trim();
      const exactLookupTitle = radioMetadataProfileName === 'davide-mimic'
        ? (lookupCtx.lookupTitleFull || lookupCtx.lookupTitle)
        : lookupCtx.lookupTitle;
      lookupTitle = String(exactLookupTitle || lookupTitle || '').trim();
      const curatedAlbum = curatedRadioAppleAlbum(
        radioMetadataProfileName,
        lookupCtx.composer,
        lookupTitle,
      );

      if (lookupArtist && lookupTitle) {
        const likelyClassical = /\b(op\.?|concerto|symphony|quartet|sonata|andante|allegro|adagio|lento|presto)\b/i.test(`${lookupTitle} ${title}`);
        const classicalContextOk = !!String(lookupCtx.ensembleHint || lookupCtx.conductorHint || lookupCtx.soloistHint || soloistHintRaw || '').trim() || !!String(albumForLookup || '').trim();
        const it = (likelyClassical && !classicalContextOk)
          ? { url:'', album:'', year:'', trackUrl:'', albumUrl:'', matchedArtist:'', matchedTitle:'', reason:'insufficient-metadata' }
          : await lookupAppleCatalogFirst(lookupArtist, lookupTitle, debug, {
              radioAlbum: albumForLookup,
              albumHint: albumForLookup,
              composerShort: lookupCtx.composerShort || '',
              ensembleHint: lookupCtx.ensembleHint || '',
              conductorHint: lookupCtx.conductorHint || '',
              labelHint,
              soloistHint: lookupCtx.soloistHint || soloistHintRaw || '',
              composer: lookupCtx.composer || '',
              preserveTitle: radioMetadataProfileName === 'davide-mimic',
              programHint,
              curatedCollectionId: curatedAlbum?.collectionId || '',
              classicalAlbumSearch: radioMetadataProfileName === 'davide-mimic',
              strictArtist: !likelyClassical,
              strictTitle: likelyClassical,
            });

        let itResolved = it;
        if (likelyClassical && String(itResolved?.matchedTitle || '').trim()) {
          const classicalRaw = String(song.title || lookupTitle || title || '').trim();
          const classicalMatched = String(itResolved.matchedTitle || '').trim();
          if (classicalRaw && classicalMatched && !shouldAcceptMatchedTitle(classicalRaw, classicalMatched)) {
            itResolved = {
              url: '', album: '', year: '', trackUrl: '', albumUrl: '', matchedArtist: '', matchedTitle: '', reason: 'classical-title-mismatch'
            };
          }
        }
        if (!String(itResolved?.url || itResolved?.trackUrl || itResolved?.albumUrl || '').trim() && /no-artist-match/i.test(String(itResolved?.reason || ''))) {
          const aTry = String(lookupArtist || '').trim();
          const tTry = String(lookupTitle || '').trim();
          if (aTry && tTry) {
            const swapped = await lookupAppleCatalogFirst(tTry, aTry, debug, {
              radioAlbum: albumForLookup,
              albumHint: albumForLookup,
              composerShort: lookupCtx.composerShort || '',
              ensembleHint: lookupCtx.ensembleHint || '',
              conductorHint: lookupCtx.conductorHint || '',
              labelHint,
              soloistHint: lookupCtx.soloistHint || soloistHintRaw || '',
              composer: lookupCtx.composer || '',
              preserveTitle: radioMetadataProfileName === 'davide-mimic',
              programHint,
              curatedCollectionId: curatedAlbum?.collectionId || '',
              classicalAlbumSearch: radioMetadataProfileName === 'davide-mimic',
              strictArtist: false,
            });
            if (String(swapped?.url || swapped?.trackUrl || swapped?.albumUrl || '').trim()) {
              itResolved = swapped;
              radioLookupTerm = `${tTry} ${aTry}`.trim();
            }
          }
        }

        if (itResolved.url) primaryArtUrl = itResolved.url;

        {
          const itAlbum = String(itResolved?.album || '').trim();
          const curAlbum = String(radioAlbum || '').trim();
          const itMatched = !!String(itResolved?.url || itResolved?.trackUrl || itResolved?.albumUrl || '').trim() || /^ok:/i.test(String(itResolved?.reason || ''));
          if (itAlbum && (itMatched || !curAlbum || isLabelLikeHint(curAlbum) || looksLikePersonName(curAlbum))) {
            radioAlbum = itAlbum;
          }
        }
        radioYear  = itResolved.year || '';

        // Links (best effort)
        if (!radioTrackUrl) radioTrackUrl = String(itResolved.trackUrl || '').trim();
        if (!radioAlbumUrl) radioAlbumUrl = String(itResolved.albumUrl || '').trim();
        if (!radioItunesUrl) radioItunesUrl = radioAlbumUrl || radioTrackUrl || '';

        // If stream metadata had junk artist (e.g., "06"), adopt iTunes artist/title.
        if (artistLooksGeneric(artist) && String(itResolved?.matchedArtist || '').trim()) {
          artist = String(itResolved.matchedArtist).trim();
          if (!radioPerformers) radioPerformers = artist;
        }

        // Heuristic: if matched pair appears fully swapped vs current pair, swap current artist/title.
        {
          const curA = String(artist || '').trim().toLowerCase();
          const curT = String(title || '').trim().toLowerCase();
          const mA = String(itResolved?.matchedArtist || '').trim();
          const mT = String(itResolved?.matchedTitle || '').trim();
          if (mA && mT && curA && curT && curA === mT.toLowerCase() && curT === mA.toLowerCase()) {
            artist = mA;
            title = mT;
            if (!radioPerformers) radioPerformers = mA;
          }
        }

        if (String(itResolved?.matchedTitle || '').trim() && shouldAcceptMatchedTitle(String(lookupTitle || title || '').trim(), String(itResolved.matchedTitle).trim())) {
          title = String(itResolved.matchedTitle).trim();
        }

        dlog('[radio links]', { radioItunesUrl, radioAlbumUrl, radioTrackUrl });
        debugItunesReason = itResolved.reason || '';
      } else {
        const decodedTitle = decodeHtmlEntities(song.title || '');
        const parts = decodedTitle.split(' - ').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const s2 = sanitizeRadioLookupInputs({ artist: parts[0], title: parts.slice(1).join(' - ') });
          const s2Title = String(s2.title || '').trim();
          const likelyClassical2 = /\b(op\.?|concerto|symphony|quartet|sonata|andante|allegro|adagio|lento|presto)\b/i.test(s2Title);
          const classicalContextOk2 = !!String(albumForLookup || '').trim();
          let it = (likelyClassical2 && !classicalContextOk2)
            ? { url:'', album:'', year:'', trackUrl:'', albumUrl:'', matchedArtist:'', matchedTitle:'', reason:'insufficient-metadata' }
            : await lookupAppleCatalogFirst(String(s2.artist || '').trim(), s2Title, debug, {
                radioAlbum: albumForLookup,
                albumHint: albumForLookup,
                composerShort: '',
                composer: String(s2.artist || '').trim(),
                labelHint,
                soloistHint: '',
                strictArtist: !likelyClassical2,
                strictTitle: likelyClassical2,
              });
          if (likelyClassical2 && String(it?.matchedTitle || '').trim()) {
            const classicalRaw2 = String(song.title || s2Title || '').trim();
            const classicalMatched2 = String(it.matchedTitle || '').trim();
            if (classicalRaw2 && classicalMatched2 && !shouldAcceptMatchedTitle(classicalRaw2, classicalMatched2)) {
              it = { url:'', album:'', year:'', trackUrl:'', albumUrl:'', matchedArtist:'', matchedTitle:'', reason:'classical-title-mismatch' };
            }
          }
          if (it.url) primaryArtUrl = it.url;

          {
            const itAlbum = String(it?.album || '').trim();
            const curAlbum = String(radioAlbum || '').trim();
            const itMatched = !!String(it?.url || it?.trackUrl || it?.albumUrl || '').trim() || /^ok:/i.test(String(it?.reason || ''));
            if (itAlbum && (itMatched || !curAlbum || isLabelLikeHint(curAlbum) || looksLikePersonName(curAlbum))) {
              radioAlbum = itAlbum;
            }
          }
          radioYear  = it.year || '';
          debugItunesReason = it.reason || '';

          // Links (best effort)
          if (!radioTrackUrl) radioTrackUrl = String(it.trackUrl || '').trim();
          if (!radioAlbumUrl) radioAlbumUrl = String(it.albumUrl || '').trim();
          if (!radioItunesUrl) radioItunesUrl = radioAlbumUrl || radioTrackUrl || '';

          if (artistLooksGeneric(artist) && String(it?.matchedArtist || '').trim()) {
            artist = String(it.matchedArtist).trim();
            if (!radioPerformers) radioPerformers = artist;
          }
          if (String(it?.matchedTitle || '').trim() && shouldAcceptMatchedTitle(String(s2.lookupTitle || title || '').trim(), String(it.matchedTitle).trim())) {
            title = String(it.matchedTitle).trim();
          }
        } else {
          debugItunesReason = 'no-parse';
        }
      }

      if (!album && radioAlbum) album = radioAlbum;
    } else if (isRadio) {
      debugItunesReason = radioLookupGuard.allow
        ? (meStation ? 'skip:private-meta-or-primary' : 'skip')
        : `skip:${radioLookupGuard.reason}`;
    } else if (stream) {
      debugItunesReason = `skip:${effectiveStreamKind || 'stream'}`;
    }

    // Secondary art:
    if (stream && stationLogoUrl) altArtUrl = stationLogoUrl;

    // =========================
    // ✅ RADIO: Apple Catalog lookup first, iTunes fallback second.
    // - No undefined helper
    // - Never blanks links on error
    // - Only fills if missing (won't clobber values from earlier steps)
    // =========================
    let debugAppleLookup = null;

    if (isRadio && radioLookupGuard.allow) {
      try {
        let albumForTerm = String(radioAlbum || album || '').trim();
        const stName = String(song?.name || streamStationName || '').trim();
        const lowAlbum = albumForTerm.toLowerCase();
        const lowStation = stName.toLowerCase();
        if (albumForTerm && stName && (lowAlbum === lowStation || lowAlbum.includes(lowStation) || lowStation.includes(lowAlbum))) albumForTerm = '';
        if (/\biheart\b|\bwfmt\b|\bclassical\b|\bstream\b|\bradio\b|\berato\b|\blaserlight\b|\bhit music station\b/i.test(albumForTerm)) albumForTerm = '';
        if (isLabelLikeHint(albumForTerm) || isProgramDateHint(albumForTerm)) albumForTerm = '';
        const perfAlbumHint = decodeHtmlEntities(String(radioPerformers || '').trim());
        if (!albumForTerm && looksAlbumHintText(perfAlbumHint)) albumForTerm = perfAlbumHint;
        const s3 = deriveRadioLookupContext({
          artist,
          title,
          radioPerformers,
          personnel,
          albumHint: albumForTerm,
        });
        const labelHint2 = extractLabelHintFromRawTitle(song.title || title || '');
        const soloistHint2 = decodeHtmlEntities(String(radioPerformers || '').trim()).split(',')[0]?.trim() || '';
        radioLookupTerm = buildAppleLookupTerm({
          artist: s3.lookupArtist,
          composer: s3.composer,
          ensemble: s3.ensembleHint,
          conductor: s3.conductorHint,
          title: s3.lookupTitle,
          album: albumForTerm,
        });

        // Reuse existing iTunes lookup (it already returns trackUrl/albumUrl)
        const s3Title = String(s3.lookupTitle || '').trim();
        const likelyClassical3 = /\b(op\.?|concerto|symphony|quartet|sonata|andante|allegro|adagio|lento|presto)\b/i.test(s3Title);
        const classicalContextOk3 = !!String(s3.ensembleHint || s3.conductorHint || s3.soloistHint || soloistHint2 || '').trim() || !!String(albumForTerm || '').trim();
        let ap = (likelyClassical3 && !classicalContextOk3)
          ? { url:'', album:'', year:'', trackUrl:'', albumUrl:'', matchedArtist:'', matchedTitle:'', reason:'insufficient-metadata' }
          : await lookupAppleCatalogFirst(String(s3.lookupArtist || '').trim(), s3Title, debug, {
              radioAlbum: albumForTerm,
              albumHint: albumForTerm,
              composerShort: String(s3.composerShort || '').trim(),
              ensembleHint: String(s3.ensembleHint || '').trim(),
              conductorHint: String(s3.conductorHint || '').trim(),
              labelHint: labelHint2,
              soloistHint: String(s3.soloistHint || soloistHint2 || '').trim(),
              composer: String(s3.composer || '').trim(),
              programHint: radioMetadataProfileName === 'davide-mimic'
                ? String(radioAlbum || album || '').trim()
                : '',
              classicalAlbumSearch: radioMetadataProfileName === 'davide-mimic',
              strictArtist: !likelyClassical3,
              strictTitle: likelyClassical3,
            });

        // Do not let a plausible ensemble match supply album/art/link data
        // when Apple matched the wrong classical work (for example Bruckner
        // Symphony No. 4 resolving to Beethoven Symphony No. 3). The first
        // lookup pass already applies this guard; the second pass must too.
        if (likelyClassical3 && String(ap?.matchedTitle || '').trim()) {
          const classicalRaw3 = String(song.title || s3Title || title || '').trim();
          const classicalMatched3 = String(ap.matchedTitle || '').trim();
          if (classicalRaw3 && !shouldAcceptMatchedTitle(classicalRaw3, classicalMatched3)) {
            ap = {
              ...ap,
              url: '',
              album: '',
              year: '',
              trackUrl: '',
              albumUrl: '',
              matchedArtist: '',
              matchedTitle: '',
              reason: 'classical-title-mismatch',
            };
          }
        }

        const tUrl = String(ap?.trackUrl || '').trim();
        const aUrl = String(ap?.albumUrl || '').trim();
        const best = aUrl || tUrl;

        // The second-pass lookup can be the branch that supplies the valid
        // Apple link (especially after a cache hit). Promote its artwork too;
        // otherwise the link is correct while the foreground remains on the
        // station logo from the initial radio fallback.
        const matchedArtUrl = String(ap?.url || '').trim();
        if (matchedArtUrl && (!String(primaryArtUrl || '').trim() || primaryArtUrl === stationLogoUrl)) {
          primaryArtUrl = matchedArtUrl;
        }

        if (!radioTrackUrl && tUrl) radioTrackUrl = tUrl;
        if (!radioAlbumUrl && aUrl) radioAlbumUrl = aUrl;
        if (!radioItunesUrl && best) radioItunesUrl = best;

        radioLookupReason = String(ap?.reason || '').trim() || radioLookupReason || 'no-reason';

        // Fill album/year; prefer iTunes album when current album is empty/label-ish/person-like.
        {
          const itAlbum = String(ap?.album || '').trim();
          const curAlbum = String(radioAlbum || '').trim();
          const apMatched = !!String(ap?.url || ap?.trackUrl || ap?.albumUrl || '').trim() || /^ok:/i.test(String(ap?.reason || ''));
          if (itAlbum && (apMatched || !curAlbum || isLabelLikeHint(curAlbum) || looksLikePersonName(curAlbum))) {
            radioAlbum = itAlbum;
          }
        }
        if (!radioYear)  radioYear  = String(ap?.year  || '').trim() || radioYear;
        if (!radioPerformers && String(ap?.matchedArtist || '').trim()) {
          radioPerformers = String(ap.matchedArtist).trim();
        }
        if (String(ap?.matchedTitle || '').trim() && shouldAcceptMatchedTitle(String(s3.lookupTitle || title || '').trim(), String(ap.matchedTitle).trim())) {
          title = String(ap.matchedTitle).trim();
        }

        if (debug) {
          debugAppleLookup = {
            radioItunesUrl,
            radioTrackUrl,
            radioAlbumUrl,
            reason: radioLookupReason,
            term: radioLookupTerm,
            ...(ap?.termDebug ? { termDebug: ap.termDebug } : {}),
            ...(ap?.resultDebug ? { resultDebug: ap.resultDebug } : {}),
          };
        }
      } catch (e) {
        // Do NOT clobber existing URLs; just record reason
        radioLookupReason = radioLookupReason || `error:${e?.name || 'Error'}`;
        if (debug) debugAppleLookup = { reason: radioLookupReason, term: radioLookupTerm };
      }
    } else if (isRadio && !radioLookupGuard.allow) {
      radioLookupReason = radioLookupReason || `skip:${radioLookupGuard.reason}`;
    }

    // Prefer radioAlbum for displayed album (your UI already does this)
    if (isRadio && !album && radioAlbum) album = radioAlbum;

    // Favorites
    const favDbg = debug ? {} : null;
    const isFavorite = (!stream && file) ? await isFavoriteInPlaylist(file, favDbg) : false;

    // Encoded label: NEVER append "(VBR)" here
    let encoded = song.encoded || '';
    if (!encoded && meStation?.hiresLabel) {
      encoded = `FLAC • ${formatHiresLabel(meStation.hiresLabel)}`;
    }

    // YouTube stream hint overlay (for better now-playing metadata/art on transient stream URLs)
    try {
      let f = String(file || '').trim();
      const ytFileLike = /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(f);
      const ytStream = !!(stream && ytFileLike);
      if (ytStream) {
        // MPD current file is authoritative for currently playing stream; moOde JSON can lag.
        try {
          const args = ['-h', String(MPD_HOST || '127.0.0.1'), '-p', String(MPD_PORT || '6600'), '-f', '%file%', 'current'];
          const { stdout } = await execFileP('mpc', args, { timeout: 4000 });
          const mpcFile = String(stdout || '').split(/\r?\n/).map((s)=>String(s||'').trim()).find(Boolean) || '';
          if (mpcFile && /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(mpcFile)) {
            f = mpcFile;
            file = mpcFile;
          }
        } catch {}

        const byFile = getYoutubeQueueHint(f) || null;
        const globalHint = youtubeNowPlayingHint || {};
        const globalFresh = (Date.now() - Number(globalHint.setAt || 0)) < (6 * 60 * 60 * 1000);
        const globalMatchesCurrent = youtubeStreamKey(String(globalHint.streamUrl || '')) === youtubeStreamKey(f);
        const hint = byFile || ((globalFresh && globalMatchesCurrent) ? globalHint : null) || {};
        const hTitle = String(hint.title || '').trim();
        const hChan = String(hint.channel || '').trim();
        const hThumb = String(hint.thumbnail || '').trim();
        const hPage = String(hint.webpageUrl || '').trim();
        if (hTitle) title = hTitle;
        if (hChan) artist = hChan;
        if (hPage) shareUrl = hPage;
        album = 'YouTube Audio Stream';
        // Clear stale radio-lookup-derived fields for YouTube stream entries.
        radioAlbum = '';
        radioYear = '';
        radioItunesUrl = '';
        radioAlbumUrl = '';
        radioTrackUrl = '';
        radioLookupReason = 'youtube-hint';
        streamStationName = 'YouTube';
        if (hThumb) primaryArtUrl = hThumb;
      }
    } catch {}

    // Use a verified fuller performer name when the radio feed's artist is a
    // shortened prefix. This keeps the ordinary current-track surfaces and
    // their title-cased display field consistent with the matched artwork.
    if (isRadio) {
      const fullerArtist = fullerRadioArtistName(artist, radioPerformers, {
        verified: !!(radioItunesUrl || radioTrackUrl || radioAlbumUrl),
      });
      if (fullerArtist) artist = fullerArtist;
    }

    // Radio without a verified iTunes match must always retain station
    // branding. This includes ordinary music rows whose lookup simply missed,
    // not only talk/news/sports rows rejected by the lookup guard. The file
    // based logo endpoint can resolve a station even when moOde supplies no
    // station name in its current-song payload.
    const radioHasItunesMatch = !!(radioItunesUrl || radioTrackUrl || radioAlbumUrl);
    const radioLogoProxyUrl = isRadio && file
      ? `${PUBLIC_BASE_URL}/art/radio-logo.jpg?file=${encodeURIComponent(file)}&v=20260924-radio-art2`
      : '';
    if (isRadio && !radioHasItunesMatch) {
      const fallbackLogoUrl = radioLogoProxyUrl || (streamStationName
        ? `${MOODE_BASE_URL}/imagesw/radio-logos/thumbs/${encodeURIComponent(streamStationName)}.jpg`
        : '');
      if (fallbackLogoUrl) {
        stationLogoUrl = fallbackLogoUrl;
        primaryArtUrl = fallbackLogoUrl;
        altArtUrl = fallbackLogoUrl;
      }
    }

    // Build/cache art derivatives based on PRIMARY art (what the UI uses)
    const rawArtUrl = String(primaryArtUrl || '').trim();
    if (rawArtUrl) {
      updateArtCacheIfNeeded(rawArtUrl).catch(e => console.warn('[art] failed', e.message));
    }

    // Radio mode-logo should remain station branding, not track art.
    if (isRadio) {
      const stLogo = String(stationLogoUrl || '').trim();
      const artUrl = String(primaryArtUrl || '').trim();
      const stripQ = (u = '') => String(u || '').replace(/\?.*$/, '').trim();
      const sameAsArt = !!stLogo && !!artUrl && stripQ(stLogo) === stripQ(artUrl);
      const looksTrackArt = /mzstatic|itunes\.apple\.com|coverart\.php|ytimg|googleusercontent/i.test(stLogo);
      if ((sameAsArt || looksTrackArt) && streamStationName) {
        stationLogoUrl = radioLogoProxyUrl || `${MOODE_BASE_URL}/imagesw/radio-logos/thumbs/${encodeURIComponent(streamStationName)}.jpg`;
      }
    }
    if (radioLogoProxyUrl) stationLogoUrl = radioLogoProxyUrl;

    // ✅ rating (piggybacked) for local files only
    let rating = 0;
    let ratingDisabled = true;
    let ratingFile = '';

    let debugRatingErr = '';
    if (ratingsAllowed) {
      ratingFile = file;
      const rr = await getRatingForFileCached(file);
      rating = rr.rating || 0;
      ratingDisabled = !!rr.disabled;
      debugRatingErr = rr.err || '';
    }

    let queueTotal = Math.max(0, Number(status?.playlistlength || moodeValByKey(statusRaw, 'playlistlength') || 0) || 0);
    let queueTrack = 0;
    {
      const sp = Number(songpos);
      if (Number.isFinite(sp) && sp >= 0) queueTrack = sp + 1;
    }
    if (queueTotal <= 0 || queueTrack <= 0) {
      try {
        const stq = await mpdGetStatus();
        const t = Math.max(0, Number(stq?.playlistlength || 0) || 0);
        const s = Number(stq?.song);
        if (queueTotal <= 0 && t > 0) queueTotal = t;
        if (queueTrack <= 0 && Number.isFinite(s) && s >= 0) queueTrack = s + 1;
      } catch {}
    }

    const displayStationName = radioDisplayName(streamStationName || song?.name || '');
    const radioArtistGeneric = artistLooksGeneric(artist);
    const displayMode = isRadio ? 'radio' : (stream ? 'stream' : (isPodcast ? 'podcast' : 'track'));
    const displayArtist = titleCaseArtistName(isRadio ? (radioArtistGeneric ? (displayStationName || 'Radio') : String(artist || '').trim()) : String(artist || '').trim());
    const displayTitle = isRadio ? (String(title || '').trim() || displayStationName || 'Live Radio') : String(title || '').trim();
    const displayLine3 = isRadio
      ? String(radioAlbum || album || displayStationName || '').trim()
      : String(album || '').trim();
    const displayArtUrl = String((isRadio ? (primaryArtUrl || stationLogoUrl) : primaryArtUrl) || '').trim();
    const displayConfidence = isRadio ? (displayStationName ? 'station' : 'fallback') : 'track';

    const payload = {
      artist: artist || '',
      title: title || '',
      album: album || '',
      file: file || '',
      playbackUrl: playbackUrl || '',

      songpos,
      songid,
      queueTrack,
      queueTotal,
      queueLabel: (queueTrack > 0 && queueTotal > 0) ? `Track ${queueTrack} of ${queueTotal}` : '',

      albumArtUrl: primaryArtUrl || '',
      aplArtUrl,

      altArtUrl: altArtUrl || '',
      stationLogoUrl: stationLogoUrl || '',
      stationName: displayStationName,
      radioStationName: displayStationName,

      // Canonical display fields (single source of truth for UIs)
      displayMode,
      displayArtist,
      displayTitle,
      displayLine3,
      displayStationName,
      displayArtUrl,
      displayConfidence,

      // Radio meta (what your UI already uses)
      radioAlbum,
      radioYear,
      radioLabel,
      radioComposer,
      radioWork,
      radioPerformers,

      // ✅ Apple Music link fields (what your UI needs)
      radioItunesUrl,
      radioTrackUrl,
      radioAlbumUrl,
      shareUrl,
      radioLookupReason,
      radioLookupTerm,
      radioMetadataProfile: radioMetadataProfileName,
      radioClassification,
      radioConfidence,
      radioReasonCodes,
      radioMetadataContract: radioMetadataContract
        ? {
          version: radioMetadataContract.contractVersion,
          profile: radioMetadataContract.profile,
          classification: radioMetadataContract.classification,
          confidence: radioMetadataContract.confidence,
          reasonCodes: radioMetadataContract.reasonCodes,
          lookup: radioMetadataContract.lookup,
        }
        : null,

      state: status.state || song.state,
      random: randomState,
      repeat: repeatState,
      elapsed: status.elapsed,
      duration: status.duration,
      percent: status.percent,

      year: deep.year || '',
      label: deep.label || '',
      producer: producer || '',
      personnel: personnel || [],

      encoded,
      bitrate: song.bitrate || '',
      outrate: song.outrate || '',
      volume: song.volume || '0',
      mute: song.mute || '0',
      track: song.track || '',
      date: dateOut || '',

      isStream: stream,
      isAirplay: false,
      isYoutube: isYouTubeStream,
      isPodcast,
      streamKind: effectiveStreamKind,
      isUpnp,
      ...(isUpnp
        ? {
          animatedArt: buildAnimatedArtContext({
            source: 'external-upnp',
            isUpnp: true,
            streamKind: effectiveStreamKind,
            artist,
            title,
            album,
            trackIdentity: `${file}|${songid}|${songpos}`,
          }),
        }
        : {}),

      isFavorite,

      // rating fields always present
      rating,
      ratingDisabled,
      ratingFile,
      jukeboxSource,
      jukeboxSelectionNumber: Number.isSafeInteger(jukeboxSelectionNumber) ? jukeboxSelectionNumber : null,

      ...(debug ? {
        debugArtUpgraded,
        debugResolvedFile,
        debugArtErr,
        debugItunesReason,
        debugPrimaryArtUrl: primaryArtUrl || '',
        ...(debugRadioHoldback ? { debugRadioHoldback } : {}),
        ...(debugRatingErr ? { debugRatingErr } : {}),
        ...(debug ? { debugFavorites: favDbg } : {}),
        ...(debug ? {
          debugRatingCache: {
            file: ratingCache.file,
            ageMs: Date.now() - (ratingCache.ts || 0),
            disabled: ratingCache.disabled,
          }
        } : {}),
        ...(debugAppleLookup ? { debugAppleLookup } : {}),
      } : {}),
    };

    // Mills is a physical record source. Keep the normal display payload and
    // artwork path, but overlay the selected record without allowing its
    // digital file to play or contribute progress.
    const millsState = getMillsIntegrationState();
    if (millsState.active) {
      const metadata = millsState.metadata || null;
      const millsFile = String(metadata?.file || '').trim();
      const millsArtUrl = millsFile
        ? `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(millsFile)}`
        : '';

      payload.millsMode = true;
      payload.displayOnly = true;
      payload.showProgress = false;
      payload.displayMode = 'mills';
      payload.state = 'pause';
      payload.elapsed = 0;
      payload.duration = 0;
      payload.percent = 0;
      payload.playbackUrl = '';
      payload.isStream = false;
      payload.isAirplay = false;
      payload.isPodcast = false;
      payload.songpos = -1;
      payload.songid = 0;
      payload.queueTrack = 0;
      payload.queueTotal = 0;
      payload.queueLabel = '';
      payload.rating = 0;
      payload.ratingDisabled = true;
      payload.ratingFile = '';
      // Mills metadata is selected independently of the paused MPD track.
      // Never let the previous digital track's personnel leak into the
      // physical-record display when the selected Mills entry has none.
      payload.personnel = [];

      if (metadata) {
        payload.artist = metadata.artist || '';
        payload.title = metadata.title || '';
        payload.album = metadata.album || '';
        payload.file = millsFile;
        payload.displayArtist = payload.artist;
        payload.displayTitle = payload.title;
        payload.displayLine3 = payload.album;
        payload.albumArtUrl = millsArtUrl;
        payload.displayArtUrl = millsArtUrl;
        payload.displayConfidence = 'track';
        payload.year = metadata.date || '';
        payload.encoded = metadata.encoded || '';
        payload.bitrate = metadata.bitrate || '';
        payload.outrate = metadata.outrate || '';
        payload.track = metadata.track || '';

        // The physical record is represented by MPD pause, but its selected
        // playlist entry still has normal local-track rating metadata.
        const millsRating = await getRatingForFileCached(millsFile);
        payload.rating = Number(millsRating?.rating) || 0;
        payload.ratingDisabled = !!millsRating?.disabled;
        payload.ratingFile = millsFile;
      } else {
        payload.artist = '';
        payload.title = '';
        payload.album = '';
        payload.file = '';
        payload.displayArtist = '';
        payload.displayTitle = '';
        payload.displayLine3 = '';
        payload.albumArtUrl = '';
        payload.displayArtUrl = '';
        payload.displayConfidence = 'physical';
      }
    }

    if (isRadio) {
      appendRadioMetaEval({
        ts: Date.now(),
        iso: new Date().toISOString(),
        stationName: String(song?.name || streamStationName || '').trim(),
        streamUrl: String(file || '').trim(),
        raw: {
          artist: String(song?.artist || '').trim(),
          title: String(song?.title || '').trim(),
          album: String(song?.album || '').trim(),
          name: String(song?.name || '').trim(),
        },
        parsed: {
          artist: String(artist || '').trim(),
          title: String(title || '').trim(),
          album: String(radioAlbum || album || '').trim(),
          performers: String(radioPerformers || '').trim(),
          lookupArtist: String(lookupArtist || '').trim(),
          lookupTitle: String(lookupTitle || '').trim(),
        },
        profile: String(radioMetadataContract?.profile || radioMetadataProfileName || 'generic').trim(),
        classification: String(radioClassification || '').trim(),
        confidence: String(radioConfidence || '').trim(),
        reasonCodes: Array.isArray(radioReasonCodes) ? radioReasonCodes : [],
        lookupDecision: radioMetadataContract?.lookup || null,
        itunes: {
          reason: String(radioLookupReason || debugItunesReason || '').trim(),
          term: String(radioLookupTerm || '').trim(),
          url: String(radioItunesUrl || '').trim(),
          trackUrl: String(radioTrackUrl || '').trim(),
          albumUrl: String(radioAlbumUrl || '').trim(),
        },
        holdback: debugRadioHoldback || null,
      }).catch(() => {});
    }

    // Editorial About metadata is optional and non-critical. It is resolved
    // from the final track payload so a refresh can never retain the prior
    // track's text, and a provider timeout cannot affect playback state.
    const aboutResult = await enrichNowPlayingAbout({
      artist: payload.artist,
      title: payload.title,
      album: payload.album,
      trackUrl: payload.radioTrackUrl,
      albumUrl: payload.radioAlbumUrl,
      file: payload.file,
      displayOnly: payload.displayOnly,
    });
    payload.aboutStatus = aboutResult?.status || ABOUT_STATUS.NO_DATA;
    if (aboutResult?.provider) payload.aboutProvider = aboutResult.provider;
    if (aboutResult?.data) payload.about = aboutResult.data;

    lastNowPlayingOk = payload;
    lastNowPlayingTs = Date.now();
    return res.json(payload);

  } catch (err) {
    console.error('now-playing error:', err?.stack || err?.message || String(err));
    return serveCached('exception', err?.message || String(err));
  }
});

app.get('/debug/radio-metadata-log', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 80) || 80));
    const raw = await fsp.readFile(RADIO_META_EVAL_LOG, 'utf8').catch(() => '');
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-limit);
    const rows = tail.map((ln) => {
      try { return JSON.parse(ln); } catch { return null; }
    }).filter(Boolean);
    return res.json({ ok: true, path: RADIO_META_EVAL_LOG, count: rows.length, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/debug/radio-metadata-log/clear', async (req, res) => {
  try {
    await fsp.mkdir(path.dirname(RADIO_META_EVAL_LOG), { recursive: true });
    await fsp.writeFile(RADIO_META_EVAL_LOG, '', 'utf8');
    lastRadioMetaEvalKey = '';
    lastRadioMetaEvalTs = 0;
    radioMetaHoldbackState.clear();
    return res.json({ ok: true, path: RADIO_META_EVAL_LOG, cleared: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/next-up', async (req, res) => {
  const debug = req.query.debug === '1';

  // moOde coverart.php expects the MPD-style file path URL-encoded after the slash
  const coverArtForFile = (filePath) => {
    const f = String(filePath || '').trim();
    if (!f) return '';
    return `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(f)}`;
  };

  try {
    const song = await fetchCurrentSong();
    const statusRaw = await fetchCurrentStatus();

    const file = String(song.file || '').trim();
    const isStream = isStreamPath(file);
    const isAirplay =
      isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    if (isAirplay) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'airplay' } : {}),
      });
    }

    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextsongid = moodeValByKey(statusRaw, 'nextsongid');

    if (!String(nextsongRaw || '').trim()) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'no-nextsong' } : {}),
      });
    }

    const nextPos = Number.parseInt(String(nextsongRaw).trim(), 10);
    if (!Number.isFinite(nextPos) || nextPos < 0) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'bad-nextsong', nextsongRaw, nextsongid } : {}),
      });
    }

    let next = await mpdPlaylistInfoByPos(nextPos);
    if (!next && nextsongid) next = await mpdPlaylistInfoById(nextsongid);

    if (!next) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'mpd-no-match', nextPos, nextsongid } : {}),
      });
    }

    const nextFile = String(next.file || '').trim();
    const nextIsStream = isStreamPath(nextFile);
    const nextYt = nextIsStream && /googlevideo\.com|youtube\.com|youtu\.be|\/youtube\/proxy\//i.test(nextFile);
    const ytHint = nextYt ? (getYoutubeQueueHint(nextFile) || {}) : {};
    const nextTitle = String(next.title || ytHint?.title || '').trim();
    const nextArtist = String(next.artist || ytHint?.channel || '').trim();
    const nextAlbum = String(next.album || (nextYt ? 'YouTube Audio Stream' : '')).trim();
    const nextArtUrl = nextIsStream
      ? (String(ytHint?.thumbnail || '').trim() || `${PUBLIC_BASE_URL}/art/current.jpg`)
      : coverArtForFile(nextFile);

    return res.json({
      ok: true,
      next: {
        songid: next.songid || String(nextsongid || ''),
        songpos: next.songpos || String(nextPos),
        title: nextTitle,
        artist: nextArtist,
        album: nextAlbum,
        file: nextFile,
        isStream: nextIsStream,
        isYoutube: !!nextYt,

        artUrl: nextArtUrl, // ✅ cover art for NEXT track
        currentArtUrl: `${PUBLIC_BASE_URL}/art/current.jpg`, // ✅ public, consistent

        stationLogoUrl: '',
      },
      ...(debug ? { reason: 'ok' } : {}),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      next: null,
      ...(debug ? { error: err?.message || String(err), reason: 'exception' } : {}),
    });
  }
});


// ------------------------------
// Current art (square 640) helpers
// ------------------------------

async function resolveBestArtForCurrentSong(song, statusRaw) {
  const qobuz = await qobuzConnect.get().catch(() => null);
  if (qobuz?.active && qobuz.artworkUrl) return qobuz.artworkUrl;
  if (qobuz?.suppressMpdHistory && qobuz?.ownershipState !== 'unknown') return '';

  const file = String(song?.file || '').trim();
  if (!file) return '';
  if (qobuz?.ownershipState === 'unknown' && !hasVerifiedMpdPlaybackEvidence({
    state: moodeValByKey(statusRaw, 'state'),
    file,
  })) return '';

  const stream = isStreamPath(file);
  const airplay =
    isAirplayFile(file) || String(song?.encoded || '').toLowerCase() === 'airplay';

  let best = '';

  // 0) AirPlay => aplmeta cover (authoritative)
  if (airplay) {
    best = await getAirplayCoverUrlFromAplmeta(MOODE_BASE_URL);
  }

  // 1) Local podcast file => RSS map art (episode/show)  ✅
  if (!best && !stream && isLocalPodcastFile(file)) {
    try {
      const tmp = {
        artist: song.artist || '',
        album: song.album || '',
        title: song.title || '',
        file,
        albumArtUrl: '',
      };
      await enrichPodcastNowPlaying(tmp);
      if (tmp?.albumArtUrl) best = String(tmp.albumArtUrl).trim();
    } catch {}
  }

  // 2) Local library file => coverart.php
  if (!best && !stream) {
    best = `/coverart.php/${encodeURIComponent(file)}`;
  }

  // 3) Streams
  if (!best && stream) {
    const streamKind = String(getStreamKind(file) || '').trim().toLowerCase(); // 'radio' | 'upnp' | ''

    // 3a) Podcast-as-stream => RSS map art
    if (streamKind === 'radio') {
      try {
        const tmp = {
          artist: song.artist || '',
          album: song.album || '',
          title: song.title || '',
          file,
          albumArtUrl: '',
        };
        await enrichPodcastNowPlaying(tmp);
        if (tmp?.albumArtUrl) best = String(tmp.albumArtUrl).trim();
      } catch {}
    }

    // 3b) Private side-channel metadata => authoritative art
    if (!best && streamKind === 'radio') {
      const meStation = matchMotherEarthStation(file);
      if (meStation) {
        try {
          const meMeta = await fetchMotherEarthMeta(meStation);
          if (meMeta?.art) best = String(meMeta.art).trim();
        } catch (e) {
          console.warn('[private-meta] fetch failed:', e?.message || String(e));
        }
      }
    }

    // 3c) Radio => iTunes fallback
    if (!best && streamKind === 'radio') {
      const decodedTitle = decodeHtmlEntities(song.title || '');
      const parts = decodedTitle.split(' - ').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const it = await lookupAppleCatalogFirst(parts[0], parts.slice(1).join(' - '), false);
        if (it?.url) best = String(it.url).trim();
      }
    }

    // 3d) UPnP => resolve to local file coverart if possible
    if (!best && streamKind === 'upnp') {
      const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
      const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();

      const realFile = await resolveLibraryFileForStream({
        songid,
        songpos,
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        track: song.track || '',
      }, null);

      if (realFile) best = `/coverart.php/${encodeURIComponent(realFile)}`;
    }
  }

  // 4) Radio station logo fallback when direct MPD has no moOde-only coverurl.
  if (!best && stream && getStreamKind(file) === 'radio') {
    const stationName = String(song?.name || song?.album || '').trim();
    if (stationName) {
      best = `${MOODE_BASE_URL}/imagesw/radio-logos/thumbs/${encodeURIComponent(stationName)}.jpg`;
    } else {
      // Direct MPD streams may not include moOde's station name. Let the
      // file-aware route resolve configured URL aliases and fetch the logo.
      best = `${PUBLIC_BASE_URL}/art/radio-logo.jpg?file=${encodeURIComponent(file)}&v=20260924-radio-art2`;
    }
  }

  // 5) Final fallback: moOde coverurl (station logo, etc.)
  if (!best && song?.coverurl) best = normalizeCoverUrl(song.coverurl, MOODE_BASE_URL);

  return best;
}

async function getAirplayCoverUrlFromAplmeta(MOODE_BASE_URL) {
  try {
    const p = `${String(MOODE_BASE_URL || '').replace(/\/+$/, '')}/aplmeta.txt`;
    const rr = await fetch(p, { redirect: 'follow', headers: { 'User-Agent': 'now-playing-airplay/1.0' } });
    if (!rr.ok) return '';
    const raw = await rr.text();
    const parts = String(raw || '').trim().split('~~~');

    // [4] is cover_path_or_url per your print script
    const cover = String(parts[4] || '').trim();

    const isDefault = /images\/default-album-cover\.png/i.test(cover);
    if (!cover || isDefault) {
      // Fallback: newest generated AirPlay cover (handles metadata parser drift).
      try {
        const dir = '/var/local/www/imagesw/airplay-covers';
        const ents = await fs.promises.readdir(dir).catch(() => []);
        const jpgs = ents.filter((n) => /^cover-.*\.jpg$/i.test(String(n || '')));
        let best = '';
        let bestM = 0;
        for (const n of jpgs) {
          const fp = `${dir}/${n}`;
          const st = await fs.promises.stat(fp).catch(() => null);
          const mt = Number(st?.mtimeMs || 0);
          if (mt > bestM) { bestM = mt; best = n; }
        }
        if (best) {
          const ageMs = Date.now() - bestM;
          // Only trust fresh-ish covers while AirPlay active.
          if (ageMs < 8 * 60 * 60 * 1000) {
            return `${MOODE_BASE_URL.replace(/\/+$/, '')}/imagesw/airplay-covers/${encodeURIComponent(best)}`;
          }
        }
      } catch {}
      if (!cover) return '';
    }

    // Sometimes includes ?v=... cachebuster; keep it.
    if (/^https?:\/\//i.test(cover)) return cover;

    // Typically "imagesw/airplay-covers/cover-....jpg?v=..."
    const rel = cover.replace(/^\/+/, '');
    return `${MOODE_BASE_URL.replace(/\/+$/, '')}/${rel}`;
  } catch {
    return '';
  }
}

registerArtRoutes(app, {
  MOODE_BASE_URL,
  fetchJson,
  fetchCurrentSong,
  fetchCurrentStatus,
  getQobuzNowPlaying: async () => {
    const state = await qobuzConnect.get();
    // The art resolver may fall back to independently verified MPD playback
    // while ownership is unknown; other consumers retain fail-closed history
    // and release semantics through the original state.
    return state?.ownershipState === 'unknown'
      ? { ...state, suppressMpdHistory: false }
      : state;
  },
  resolveBestArtForCurrentSong,
  normalizeArtKey,
  updateArtCacheIfNeeded,
  artPath640ForKey,
  artPathBgForKey,
  safeIsFile,
  normalizeCoverUrl,
  dispatcherForUrl,
  agentForUrl,
});

let mobileVibeStarter = null;

registerMobileRoutes(app, {
  enabled: MOBILE_API_ENABLED,
  apiSecret: MOBILE_API_SECRET,
  trackIdSecret: MOBILE_TRACK_ID_SECRET,
  enrollmentCode: MOBILE_API_ENROLLMENT_CODE,
  mobileBaseUrl: MOBILE_PUBLIC_BASE_URL,
  mobileTrackCacheDir: MOBILE_TRACK_CACHE_DIR,
  transcodeTracks: MOBILE_TRANSCODE_TRACKS,
  musicLibraryRoot: PI4_MOUNT_BASE,
  videoCatalog: mobileVideoCatalog,
  listeningHistory,
  pushTokenStore: mobilePushTokenStore,
  apnsConfigured: apnsProvider.isConfigured(),
  apnsTopic: APNS_TOPIC,
  notifyNativePlayback: notifyNativePlaybackWithApns,
  mpdHost: MPD_HOST,
  getBrowseIndex,
  getSourceAudio: sourceAudioProbe.get,
  fetchInternalJson: async (pathname) => {
    const routePath = String(pathname || '').startsWith('/') ? String(pathname) : `/${String(pathname || '')}`;
    const url = `http://127.0.0.1:${Number(PORT || 3101)}${routePath}`;
    const response = await fetch(url, {
      cache: 'no-store',
      headers: TRACK_KEY ? { 'x-track-key': String(TRACK_KEY) } : {},
    });
    return {
      ok: response.ok,
      status: Number(response.status || 0) || 0,
      json: await response.json().catch(() => ({})),
    };
  },
  getPibuzQobuzSnapshot: (options) => pibuzQobuz.getSnapshot(options),
  controlPibuzQobuz: (action, options) => pibuzQobuz.control(action, options),
  getQobuzNowPlaying: () => qobuzConnect.get(),
  releaseQobuzConnect: () => qobuzConnectController.release(),
  fetchPibuzQobuzArtwork: (artworkRef) => pibuzQobuz.fetchArtwork(artworkRef),
  savedQobuzQueueService,
  savedQobuzQueuePlayService,
  fetchInternalRequest: async (pathname, options = {}) => {
    const routePath = String(pathname || '').startsWith('/') ? String(pathname) : `/${String(pathname || '')}`;
    const method = String(options?.method || 'GET').toUpperCase();
    const headers = {
      ...(TRACK_KEY ? { 'x-track-key': String(TRACK_KEY) } : {}),
      ...(options?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const url = `http://127.0.0.1:${Number(PORT || 3101)}${routePath}`;
    const response = await fetch(url, {
      cache: 'no-store',
      method,
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return {
      ok: response.ok,
      status: Number(response.status || 0) || 0,
      json: await response.json().catch(() => ({})),
    };
  },
  enrichRadioMetadata: lookupMobileRadioMetadata,
  getMobilePlaylists: async () => {
    const host = String(MPD_HOST || '127.0.0.1');
    const port = String(MPD_PORT || '6600');
    const { stdout } = await execFileP('mpc', ['-h', host, '-p', port, 'lsplaylists'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const names = String(stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const rows = await Promise.all(names.map(async (name) => {
      const result = await execFileP('mpc', ['-h', host, '-p', port, '-f', '%file%', 'playlist', name], {
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return {
        name,
        files: String(result.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      };
    }));
    return rows.filter((row) => !isPodcastPlaylist(row.name, row.files));
  },
  mpdQueryRaw,
  getRatingForFile,
  getFavoriteForFile: async (file) => isFavoriteInPlaylist(file),
  ratingsEnabled: async () => {
    try {
      const cfg = JSON.parse(await fsp.readFile(RUNTIME_CONFIG_PATH, 'utf8'));
      return Boolean(cfg?.features?.ratings ?? true);
    } catch {
      return true;
    }
  },
  getCurrentFile: async () => {
    const song = await fetchCurrentSong();
    return String(song?.file || '').trim();
  },
  isStreamPath,
  isAirplayFile,
  startMobileVibe: (body) => {
    if (typeof mobileVibeStarter !== 'function') {
      throw new Error('mobile Vibe control is not configured');
    }
    return mobileVibeStarter(body);
  },
  mpdFileToLocalPath,
  safeIsFile,
  requireTrackKey,
  getUpnpControlPoint: () => upnpControlPoint,
  getUpnpPlaybackSession: () => upnpPlaybackSession,
  getUpnpPlaybackQueue: () => upnpPlaybackQueue,
  expectedRendererHost: process.env.UPNP_MOODE_RENDERER_HOST || '10.0.0.254',
  trackKeyConfigured: Boolean(TRACK_KEY),
  serveArtworkForTrack: (res, file) => serveTrackArtwork(res, file, {
    MOODE_BASE_URL,
    normalizeCoverUrl,
    dispatcherForUrl,
    agentForUrl,
    normalizeArtKey,
    updateArtCacheIfNeeded,
    artPath640ForKey,
    safeIsFile,
  }),
  servePlaylistArtwork: async (res, playlistName) => {
    const name = String(playlistName || '').trim();
    if (!name) return res.status(404).end();
    const safeName = name
      .replace(/[^A-Za-z0-9 _.-]/g, '')
      .trim()
      .replace(/\s+/g, '_');
    const candidates = [...new Set([name, safeName].filter(Boolean))];
    for (const candidate of candidates) {
      const url = `${String(MOODE_BASE_URL || '').replace(/\/+$/, '')}/imagesw/playlist-covers/${encodeURIComponent(candidate)}.jpg`;
      try {
        const response = await fetch(url, {
          dispatcher: dispatcherForUrl(url),
          cache: 'no-store',
        });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 8 * 1024 * 1024) return res.status(413).end();
        const contentType = String(response.headers.get('content-type') || 'image/jpeg').toLowerCase();
        res.set('Content-Type', contentType.startsWith('image/') ? contentType : 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=3600');
        return res.status(200).send(bytes);
      } catch {}
    }
    return res.status(404).end();
  },
  serveHomeArtwork: async (res, descriptor) => {
    try {
      const kind = String(descriptor?.kind || '').trim().toLowerCase();
      const reference = String(descriptor?.reference || '').trim();
      let url = reference;
      if (kind === 'background') {
        url = `http://127.0.0.1:${Number(PORT || 3101)}/art/current_bg_640_blur.jpg`;
      } else if (kind === 'radio-file') {
        url = `http://127.0.0.1:${Number(PORT || 3101)}/art/radio-logo.jpg?file=${encodeURIComponent(reference)}`;
      } else if (kind === 'radio') {
        url = `http://127.0.0.1:${Number(PORT || 3101)}/art/radio-logo.jpg?name=${encodeURIComponent(reference)}`;
      }
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return res.status(404).end();
      }
      const response = await fetch(parsed.toString(), { cache: 'no-store', redirect: 'follow' });
      if (!response.ok) return res.status(404).end();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) return res.status(413).end();
      const contentType = String(response.headers.get('content-type') || 'image/jpeg').toLowerCase();
      res.set('Content-Type', contentType.startsWith('image/') ? contentType : 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      return res.status(200).send(bytes);
    } catch {
      return res.status(404).end();
    }
  },
});

registerRatingRoutes(app, {
  clampRating,
  isStreamPath,
  isAirplayFile,
  getRatingForFile,
  setRatingForFile,
  fetchJson,
  MOODE_BASE_URL,
  bumpRatingCache,
  getMillsIntegrationState,
});

registerQueueRoutes(app, {
  requireTrackKey,
  mpdPlaylistInfoById,
  mpdDeleteId,
  mpdDeletePos0,
  mpdQueryRaw,
  parseMpdKeyVals,
  parseMpdFirstBlock,
  mpdPrimeIfIdle,
  fetchJson,
  MOODE_BASE_URL,
  moodeValByKey,
  decodeHtmlEntities,
  log,
  execFileP,
  MPD_HOST,
  onQueueItemRemoved: ({ songid }) => ({ removed: removeJukeboxEntry(songid) }),
});

registerSeeburgRoutes(app, {
  requireTrackKey,
  mpdQueryRaw,
  mpdEscapeValue,
  mpdHasACK,
  parseMpdFirstBlock,
  seeburgPlaylistName: SEEBURG_PLAYLIST_NAME,
});

registerMultiphoneRoutes(app, {
  requireTrackKey,
  mpdQueryRaw,
  mpdEscapeValue,
  mpdHasACK,
  parseMpdFirstBlock,
  multiphonePlaylistName: MULTIPHONE_PLAYLIST_NAME,
});

registerMillsRoutes(app, {
  requireTrackKey,
  switchDenonInput,
  mpdQueryRaw,
  mpdEscapeValue,
  mpdHasACK,
  parseMpdFirstBlock,
  millsPlaylistName: MILLS_PLAYLIST_NAME,
});

async function readUpnpMpdSnapshot() {
  const [statusRaw, songRaw, queueRaw] = await Promise.all([
    mpdQueryRaw('status'),
    mpdQueryRaw('currentsong'),
    mpdQueryRaw('playlistinfo'),
  ]);
  if ([statusRaw, songRaw, queueRaw].some((raw) => !raw || mpdHasACK(raw))) {
    throw new Error('MPD snapshot returned an error');
  }
  return {
    status: parseMpdKeyVals(statusRaw),
    song: parseMpdFirstBlock(songRaw),
    queue: parseMpdPlaylistBlocks(queueRaw),
  };
}

upnpPlaybackSession = createUpnpPlaybackSessionManager({
  controlPoint: upnpControlPoint,
  readMpdSnapshot: readUpnpMpdSnapshot,
  getQobuzState: () => qobuzConnect.get(),
  stopMpd: async () => {
    const raw = await mpdQueryRaw('stop');
    if (!raw || mpdHasACK(raw)) throw new Error('MPD rejected the explicit UPnP takeover stop');
    return { ok: true };
  },
  expectedRendererHost: process.env.UPNP_MOODE_RENDERER_HOST || '10.0.0.254',
  log,
});

upnpPlaybackQueue = createUpnpPlaybackQueueManager({
  controlPoint: upnpControlPoint,
  playbackSession: upnpPlaybackSession,
  log,
});

registerUpnpRoutes(app, {
  requireTrackKey,
  controlPoint: upnpControlPoint,
  playbackSession: upnpPlaybackSession,
  playbackQueue: upnpPlaybackQueue,
});

const UPNP_QUEUE_POLL_MS = Math.max(500, Number(process.env.UPNP_QUEUE_POLL_MS || 1000) || 1000);
const upnpQueuePoller = RUNTIME_CAPABILITIES.rehearsal ? null : setInterval(() => {
  upnpPlaybackQueue.tick().catch((error) => {
    log.debug?.('[upnp] queue poll failed:', error?.message || String(error));
  });
}, UPNP_QUEUE_POLL_MS);
upnpQueuePoller?.unref?.();

// MPD normally keeps completed playlist items unless `consume` is enabled.
// Do not enable consume globally: house queues should retain their existing
// behavior. Instead, consume only paid Seeburg/Multiphone items when MPD
// advances away from them (or stops after their final play).
const PRIORITY_COMPLETION_POLL_MS = 1500;
let priorityCompletionBusy = false;
let lastObservedPlayback = null;

async function consumeCompletedPriorityTrack(previous) {
  const previousId = Number(previous?.songid || 0);
  if (!Number.isSafeInteger(previousId) || previousId <= 0 || !jukeboxEntries.has(previousId)) return;

  await withJukeboxMutation(async () => {
    // A selection can race the poller. Recheck that MPD has moved away from
    // the previous item before deleting it by stable ID.
    const currentRaw = await mpdQueryRaw('status');
    if (!currentRaw || mpdHasACK(currentRaw)) return;
    const current = parseMpdKeyVals(currentRaw);
    const currentId = Number(current.songid || 0);
    const currentState = String(current.state || '').trim().toLowerCase();
    if (currentId === previousId && currentState === 'play') return;
    if (currentId === previousId && currentState !== 'stop') return;

    try {
      await mpdDeleteId(previousId);
    } finally {
      // Cleanup is safe even if queue/advance already removed the MPD item;
      // this makes the operation idempotent across Alexa and local playback.
      if (removeJukeboxEntry(previousId)) {
        log.debug('[jukebox] consumed completed priority track', { songid: previousId });
      }
    }
  });
}

async function priorityCompletionTick() {
  if (priorityCompletionBusy) return;
  priorityCompletionBusy = true;
  try {
    const raw = await mpdQueryRaw('status');
    if (!raw || mpdHasACK(raw)) return;
    const status = parseMpdKeyVals(raw);
    const current = {
      songid: Number(status.songid || 0),
      state: String(status.state || '').trim().toLowerCase(),
    };
    const previous = lastObservedPlayback;
    const movedAway = previous
      && previous.state === 'play'
      && (current.songid !== previous.songid || current.state === 'stop');
    if (movedAway) await consumeCompletedPriorityTrack(previous);
    lastObservedPlayback = current;
  } catch (error) {
    log.debug('[jukebox] completion watcher failed:', error?.message || String(error));
  } finally {
    priorityCompletionBusy = false;
  }
}

if (!RUNTIME_CAPABILITIES.rehearsal) {
  setInterval(() => { priorityCompletionTick().catch(() => {}); }, PRIORITY_COMPLETION_POLL_MS);
}

// Keep a server-side listening history independent of browser/controller
// polling.  Last.fm remains an optional enrichment provider; this local
// history is the fallback for users who do not have a Last.fm account.
const LISTENING_HISTORY_POLL_MS = Math.max(2500, Number(process.env.LISTENING_HISTORY_POLL_MS || 5000) || 5000);
let listeningHistoryBusy = false;
let mpdMobileCatalogIndex = null;
let mpdMobileCatalog = null;

async function canonicalMobileTrackForFile(file) {
  if (!MOBILE_TRACK_ID_SECRET || !file) return null;
  const index = await getBrowseIndex(MPD_HOST);
  if (mpdMobileCatalogIndex !== index) {
    mpdMobileCatalogIndex = index;
    mpdMobileCatalog = buildMobileCatalog(index, { trackIdSecret: MOBILE_TRACK_ID_SECRET });
  }
  return mpdMobileCatalog?.byFile?.get(file) || null;
}

async function listeningHistoryTick() {
  if (listeningHistoryBusy) return;
  listeningHistoryBusy = true;
  try {
    const qobuz = await qobuzConnect.get();
    const qobuzOwnershipUnknown = qobuz?.ownershipState === 'unknown';
    if (qobuz.suppressMpdHistory && !qobuzOwnershipUnknown) {
      // Qobuz owns the audible session. Clear any MPD event that was left
      // selected when qbzevent.sh stopped MPD, so it cannot qualify or
      // scrobble while Qobuz is active (or while its transport is stale).
      await listeningHistory.observe({ song: { file: '' } });
      return;
    }

    if (upnpPlaybackSession?.shouldSuppressMpdHistory?.()) {
      // upmpdcli feeds the selected network resource through MPD internally.
      // Do not let the ordinary MPD observer create a second Sonuvi history
      // event or Last.fm session for the same UPnP-controlled playback.
      await listeningHistory.observe({ song: { file: '' } });
      return;
    }

    const [statusRaw, songRaw] = await Promise.all([
      mpdQueryRaw('status'),
      mpdQueryRaw('currentsong'),
    ]);
    if (!statusRaw || !songRaw || mpdHasACK(statusRaw) || mpdHasACK(songRaw)) return;

    const status = parseMpdKeyVals(statusRaw);
    const song = parseMpdFirstBlock(songRaw);
    const file = String(song.file || '').trim();
    if (qobuzOwnershipUnknown && !hasVerifiedMpdPlaybackEvidence({
      state: status.state,
      file,
    })) {
      // An MPD stopped/paused state is not proof that Qobuz released the
      // receiver. Keep history neutral until MPD independently demonstrates
      // that ordinary playback has resumed.
      await listeningHistory.observe({ song: { file: '' } });
      return;
    }
    const canonicalTrack = await canonicalMobileTrackForFile(file);
    const localFile = !!file && !!mpdFileToLocalPath(file);
    const eligible = localFile
      && !isStreamPath(file)
      && !isAirplayFile(file)
      && !isLocalPodcastFile(file)
      && !alexaModeActive;

    await listeningHistory.observe({
      status: {
        state: String(status.state || '').trim().toLowerCase(),
        songid: String(status.songid || '').trim(),
        elapsedSec: Number(status.elapsed || 0) || 0,
      },
      song: {
        file,
        artist: song.artist,
        albumArtist: song.albumartist,
        album: song.album,
        title: song.title,
        track: song.track,
        genre: song.genre,
        time: song.time,
        durationSec: song.time || status.duration || canonicalTrack?.durationSec || '',
        trackKey: canonicalTrack?.id || '',
      },
      eligible,
      source: 'mpd',
      lastfmMode: LASTFM_MPD_MODE,
    });
  } catch (error) {
    log.debug('[listening-history] poll failed', error?.message || String(error));
  } finally {
    listeningHistoryBusy = false;
  }
}

if (!RUNTIME_CAPABILITIES.rehearsal) {
  setInterval(() => { listeningHistoryTick().catch(() => {}); }, LISTENING_HISTORY_POLL_MS);
  listeningHistoryTick().catch(() => {});
}

const configRouteHandles = registerAllConfigRoutes(app, {
  requireTrackKey,
  log,
  trackKey: TRACK_KEY,
  getLocalHistoryItems: ({ kind, limit, period, windowDays, baseUrl, trackKey } = {}) => listeningHistory.getItems(kind, {
    limit,
    period,
    windowDays,
    baseUrl,
    trackKey: trackKey || TRACK_KEY,
  }),
  getLocalHistoryEvents: ({ limit } = {}) => listeningHistory.getEvents({ limit }),
  mpdQueryRaw,
  mpdHasACK,
  parseMpdKeyVals,
  parseMpdFirstBlock,
  getRatingForFile,
  setRatingForFile,
  mpdStickerGetSong,
  getAlexaWasPlaying: () => alexaWasPlaying,
  clearAlexaWasPlayingState,
  setAlexaModeState,
  getYoutubeNowPlayingHint: () => youtubeNowPlayingHint,
  getYoutubeQueueHint,
  getSourceAudio: sourceAudioProbe.get,
  getActiveRadioStream,
  getLiveRadioAudio: liveRadioAudioProbe.get,
  getQobuzNowPlaying: () => qobuzConnect.get(),
  releaseQobuzConnect: () => qobuzConnectController.release(),
  controlPoint: upnpControlPoint,
});

mobileVibeStarter = configRouteHandles?.startMobileVibe || null;


/* =========================
 * /track (Alexa) - unchanged behavior
 * ========================= */

registerTrackRoutes(app, {
  ENABLE_ALEXA,
  TRANSCODE_TRACKS,
  TRACK_CACHE_DIR,
  requireTrackKey,
  isStreamPath,
  isAirplayFile,
  mpdFileToLocalPath,
  safeIsFile,
  log,
});

/* =========================
 * Start
 * ========================= */
 
// =========================
// CLI: build podcast URL map (one-shot)
// =========================
if (process.argv.includes('--build-podcast-map')) {
    (async () => {
        try {
            // Prefer CLI flags, fall back to env
            const rssUrl =
                getArg('--rss') ||
                process.env.PODCAST_RSS_URL ||
                '';

            const outM3u =
                getArg('--out') ||
                process.env.PODCAST_OUT_M3U ||
                '';

            const limit =
                getArgNum('--limit', Number(process.env.PODCAST_LIMIT || 50));

            if (!rssUrl || !outM3u) {
                console.error('Usage: --build-podcast-map --rss <feedUrl> --out <path.m3u> [--limit N]');
                console.error('Or set PODCAST_RSS_URL + PODCAST_OUT_M3U');
                process.exit(2);
            }

            const feed = await fetchPodcastRSS(rssUrl, limit);
            const episodes = feed.items.map(ep => ({
                ...ep,
                podcastTitle: feed.title,
            }));

            await writePodcastM3u({ episodes, outM3u });
            await writePodcastUrlMap({ episodes, outM3u });
            
            process.exit(0);
        } catch (e) {
            console.error('[podcast map build failed]', e);
            process.exit(1);
        }
    })();
}

app.post('/youtube/resolve', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    const r = await resolveYouTubeAudio(url);
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/youtube/search', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const query = String(req.body?.query || '').trim();
    const limit = Number(req.body?.limit || 8) || 8;
    const playlistsOnly = !!req.body?.playlistsOnly;
    if (!query) return res.status(400).json({ ok: false, error: 'query is required' });
    const items = await searchYouTube(query, limit, playlistsOnly);
    return res.json({ ok: true, count: items.length, playlistsOnly, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/youtube/playlist', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const url = String(req.body?.url || '').trim();
    const limit = Number(req.body?.limit || 100) || 100;
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    const out = await listYouTubePlaylist(url, limit);
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/youtube/proxy/:id', async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    let hint = youtubeProxyHints.get(id) || null;
    if (!hint && id) {
      const fallback = getYoutubeQueueHint(`http://${LOCAL_ADDRESS}:${PORT}/youtube/proxy/${id}`) || getYoutubeQueueHint(`/youtube/proxy/${id}`) || null;
      if (fallback) {
        hint = {
          sourcePageUrl: String(fallback?.webpageUrl || '').trim(),
          webpageUrl: String(fallback?.webpageUrl || '').trim(),
          title: String(fallback?.title || '').trim(),
          channel: String(fallback?.channel || '').trim(),
          thumbnail: String(fallback?.thumbnail || '').trim(),
        };
      }
    }
    const srcPage = String(hint?.sourcePageUrl || hint?.webpageUrl || '').trim();
    if (!id || !srcPage) return res.status(404).end('not found');
    if (!youtubeProxyHints.has(id)) {
      youtubeProxyHints.set(id, { ...(hint || {}), sourcePageUrl: srcPage, webpageUrl: String(hint?.webpageUrl || srcPage).trim(), restored: true });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');

    // Ensure old worker for same proxy id is not lingering.
    stopYoutubeProxyWorker(id);
    pruneYoutubeProxyWorkers();

    // First try to resolve a direct non-HLS URL (avoids hlsnative 403 fragment issues).
    let directUrl = '';
    try {
      const { stdout } = await execFileP('yt-dlp', [
        '--no-warnings', '--extractor-args', 'youtube:player_client=android',
        '--no-playlist', '-f', 'bestaudio[protocol!=m3u8][protocol!=m3u8_native]/bestaudio/best', '-g', srcPage
      ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      directUrl = String(stdout || '').split(/\r?\n/).map((s) => String(s || '').trim()).find(Boolean) || '';
    } catch {}

    let ytdlp = null;
    let ff = null;
    if (directUrl) {
      ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2',
        '-i', directUrl,
        '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k',
        '-f', 'mp3', 'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      ytdlp = spawn('yt-dlp', [
        '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-o', '-', srcPage
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k',
        '-f', 'mp3', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      ytdlp.stdout.on('error', () => {});
      ff.stdin.on('error', (e) => {
        if (String(e?.code || '') !== 'EPIPE') {
          try { console.warn('[yt-proxy] ff stdin error', e?.message || e); } catch {}
        }
      });
      ytdlp.stdout.pipe(ff.stdin, { end: true });
    }

    youtubeProxyWorkers.set(id, { ytdlp, ff, startedAt: Date.now() });
    pruneYoutubeProxyWorkers();

    ff.stdout.pipe(res);

    const endAll = () => {
      stopYoutubeProxyWorker(id);
      try { res.end(); } catch {}
    };
    req.on('close', endAll);
    res.on('close', endAll);
    res.on('error', () => endAll());

    if (ytdlp) ytdlp.on('error', () => endAll());
    ff.on('error', () => endAll());
    ff.on('exit', () => endAll());
  } catch {
    try { res.status(500).end('proxy error'); } catch {}
  }
});

app.post('/youtube/queue', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;
    const modeIn = String(req.body?.mode || 'append').trim().toLowerCase();
    const mode = ['append', 'replace', 'crop'].includes(modeIn) ? modeIn : 'append';
    const urlsIn = Array.isArray(req.body?.urls) ? req.body.urls : null;
    const singleUrl = String(req.body?.url || '').trim();
    const urls = (urlsIn && urlsIn.length ? urlsIn : [singleUrl])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 200);
    if (!urls.length) return res.status(400).json({ ok: false, error: 'url or urls[] is required' });

    const mpc = async (...args) => execFileP('mpc', ['-h', String(MPD_HOST || '127.0.0.1'), '-p', String(MPD_PORT || '6600'), ...args], { timeout: 15000 });
    let effectiveMode = mode;

    if (mode === 'replace') {
      await mpc('clear');
    } else if (mode === 'crop') {
      await mpc('crop');
      effectiveMode = 'crop';
    }

    const queuedItems = [];
    const failed = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const resolved = await resolveYouTubeAudio(urls[i]);
        const streamUrl = String(resolved?.streamUrl || '').trim();
        if (!streamUrl) {
          failed.push({ url: urls[i], error: 'empty stream url' });
          continue;
        }

        const hint = {
          setAt: Date.now(),
          streamUrl,
          title: String(resolved?.title || '').trim(),
          channel: String(resolved?.channel || '').trim(),
          thumbnail: String(resolved?.thumbnail || '').trim(),
          webpageUrl: String(resolved?.webpageUrl || '').trim(),
        };

        const proxyId = crypto.createHash('sha1').update(`${streamUrl}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16);
        const proxyUrl = `http://${LOCAL_ADDRESS}:${PORT}/youtube/proxy/${proxyId}`;
        youtubeProxyHints.set(proxyId, { ...hint, sourceUrl: streamUrl, sourcePageUrl: String(resolved?.webpageUrl || '').trim(), proxyUrl });
        if (youtubeProxyHints.size > 500) {
          const first = youtubeProxyHints.keys().next().value;
          if (first) youtubeProxyHints.delete(first);
        }

        setYoutubeQueueHint(proxyUrl, {
          title: hint.title,
          channel: hint.channel,
          thumbnail: hint.thumbnail,
          webpageUrl: hint.webpageUrl,
        });

        await mpc('add', proxyUrl);
        queuedItems.push({
          title: resolved.title,
          channel: resolved.channel,
          thumbnail: resolved.thumbnail,
          duration: resolved.duration,
          webpageUrl: resolved.webpageUrl,
          streamUrl: proxyUrl,
          sourceUrl: streamUrl,
        });

        if (mode === 'replace' && queuedItems.length === 1) {
          youtubeNowPlayingHint = { ...hint, streamUrl: proxyUrl };
        }
      } catch (e) {
        failed.push({ url: urls[i], error: e?.message || String(e) });
      }
    }

    if (mode === 'replace' && queuedItems.length) {
      await mpc('play');
    }

    return res.json({
      ok: queuedItems.length > 0,
      mode,
      effectiveMode,
      queued: queuedItems.length > 0,
      queuedCount: queuedItems.length,
      failedCount: failed.length,
      failed,
      item: queuedItems[0] || null,
      items: queuedItems,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  log.debug(`moOde now-playing server running on port ${PORT}`);
  log.debug(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/now-playing`);
  log.debug(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/next-up`);
  log.debug(`Public: ${PUBLIC_BASE_URL}`);
  log.debug(`Alexa routes enabled? ${ENABLE_ALEXA ? 'YES' : 'NO'}`);
});
