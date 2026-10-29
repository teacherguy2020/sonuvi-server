import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyReleaseArtifact } from '../../src/lib/release-artifact.mjs';
import { assertReleaseTargetRuntime } from '../../src/lib/release-runtime-preflight.mjs';
import { assertImmutableRuntimeConfig } from '../../src/lib/runtime-config-security.mjs';
import { createRuntimeCapabilities } from '../../src/lib/runtime-capabilities.mjs';

export const H4C4A_SYNTHETIC_STATE_CONTRACT = 'sonuvi.h4c4a.synthetic-state.v1';
export const H4C4A_REHEARSAL_PLAN_CONTRACT = 'sonuvi.h4c4a.rehearsal-plan.v1';
export const H4C4A_RUNTIME_CONTRACT_PARITY = 'sonuvi.h4c4a.runtime-contract-parity.v1';
export const H4C4A_RUNTIME_IMAGE = 'node:20.20.1-bookworm-slim';
export const H4C4A_DEFAULT_PORTS = Object.freeze({ api: 31901, web: 31902 });

export const H4C4A_CONTAINER_PATHS = Object.freeze({
  releaseRoot: '/opt/sonuvi/release',
  stateRoot: '/var/lib/sonuvi-rehearsal',
  configRoot: '/var/lib/sonuvi-rehearsal/config',
  emptySecretsRoot: '/run/sonuvi-empty-secrets',
  temporaryRoot: '/tmp',
});

const FIXTURE_DIRECTORIES = Object.freeze([
  'config', 'data', 'cache', 'logs', 'checkpoints', 'protected',
]);

const FIXTURE_FILES = Object.freeze([
  '.sonuvi-h4c4a-fixture.json',
  'config/now-playing.config.json',
  'data/library-browse-index.json',
  'data/source-audio-cache.json',
  'data/controller-profile.json',
  'data/playlists-index.json',
  'data/radio-queue-presets.json',
  'data/radio-queue-map.json',
  'data/endless-vibe.json',
  'data/jukebox-entries.json',
  'data/peppy-last-push.json',
]);

const PRODUCTION_PORTS = new Set([3000, 3101, 8101]);
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  'TRACK_KEY', 'LASTFM_API_KEY', 'LASTFM_API_SECRET', 'LASTFM_SESSION_KEY',
  'PUSHOVER_TOKEN', 'PUSHOVER_USER_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY', 'APNS_PRIVATE_KEY_PATH', 'APPLE_MUSIC_DEVELOPER_TOKEN',
  'APPLE_MUSIC_KEY_ID', 'APPLE_MUSIC_TEAM_ID', 'APPLE_MUSIC_PRIVATE_KEY_PATH',
  'QOBUZ_TOKEN', 'QOBUZ_ACCESS_TOKEN', 'QOBUZ_REFRESH_TOKEN',
  'MOODE_SSH_IDENTITY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND',
]);
const FORBIDDEN_MOUNT_PREFIXES = Object.freeze([
  '/Users/', '/home/', '/opt/now-playing', '/opt/sonuvi/shared', '/etc/sonuvi',
]);
const SENSITIVE_KEY_PATTERN = /(token|secret|credential|password|passphrase|private.?key|api.?key|track.?key|authorization|session)/i;
const LOCAL_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT_RUNTIME_CONTRACTS = Object.freeze([
  'src/lib/browse-index.mjs',
  'src/lib/release-artifact.mjs',
  'src/lib/release-runtime-preflight.mjs',
  'src/lib/runtime-capabilities.mjs',
  'src/lib/runtime-config-security.mjs',
  'src/lib/runtime-state-paths.mjs',
]);

function text(value) {
  return String(value ?? '').trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function absolute(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(candidate);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function stableId(value, label) {
  const candidate = text(value);
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/i.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function port(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) {
    throw new Error(`${label} must be an unprivileged TCP port`);
  }
  if (PRODUCTION_PORTS.has(number)) throw new Error(`${label} must not use a production Sonuvi port`);
  return number;
}

function assertDistinctPorts({ apiPort, webPort } = {}) {
  const api = port(apiPort, 'API port');
  const web = port(webPort, 'web port');
  if (api === web) throw new Error('API and web ports must be distinct');
  return Object.freeze({ api, web });
}

function isLoopbackHost(value) {
  const host = text(value).toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function assertLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(text(value));
  } catch {
    throw new Error(`${label} must be a valid loopback URL`);
  }
  if (!isLoopbackHost(parsed.hostname)) throw new Error(`${label} must use a loopback host`);
}

function fixtureContent({ fixtureId, createdAt, ports }) {
  const syntheticTrackOne = 'Synthetic/Synthetic Ensemble/Fixture Album/01 - First Fixture.flac';
  const syntheticTrackTwo = 'Synthetic/Synthetic Ensemble/Fixture Album/02 - Second Fixture.flac';
  const builtAt = new Date(createdAt).toISOString();
  const config = {
    projectName: 'sonuvi-synthetic-rehearsal',
    environment: 'rehearsal',
    timezone: 'UTC',
    nodes: [{ name: 'synthetic-api', ip: '127.0.0.1', role: 'both', sshUser: 'disabled' }],
    ports: { api: ports.api, ui: ports.web },
    deployment: { sourceOfTruthNode: 'synthetic-api', syncMethod: 'disabled' },
    mpd: { host: '127.0.0.1', port: 6600 },
    moode: { sshHost: '127.0.0.1', sshUser: 'disabled', baseUrl: 'http://127.0.0.1:18080' },
    alexa: { enabled: false, publicDomain: '', webhookPath: '/alexa' },
    features: {
      podcasts: false, ratings: false, radio: false, albumPersonnel: false,
      showAboutWhenNoPersonnel: false, moodeDisplayTakeover: false, lastfm: false,
    },
    notifications: {
      trackNotify: { enabled: false, pollMs: 3000, dedupeMs: 15000, alexaMaxAgeMs: 21600000 },
      pushover: {},
      apns: { topic: 'org.example.sonuvi.synthetic', environment: 'development', tokensPath: 'protected/no-push-tokens.json' },
    },
    paths: {
      musicLibraryRoot: '/synthetic/no-media',
      moodeUsbMount: '/synthetic/no-media',
      piMountBase: '/synthetic/no-media',
      podcastRoot: '/synthetic/no-podcasts',
      subscriptionsJson: '/synthetic/no-subscriptions.json',
    },
    lastfm: { username: 'synthetic-listener', recentsReplaceRadio: false, recentsMode: 'disabled', period: '7day', topTracksWindowDays: 7 },
    runtime: { publicBaseUrl: `http://127.0.0.1:${ports.web}`, artCacheLimit: 8, trackCacheDir: 'tracks', artCacheDir: 'art' },
  };
  const browseIndex = {
    schema: 'now-playing.browse-index.v2',
    builtAt,
    dbUpdateAt: '',
    mpdHost: '127.0.0.1',
    counts: { artists: 1, albums: 1, tracks: 2 },
    artists: [{ key: 'synthetic ensemble', name: 'Synthetic Ensemble', albumCount: 1, trackCount: 2, sampleFile: syntheticTrackOne }],
    albums: [{ key: 'synthetic ensemble|fixture album', album: 'Fixture Album', artist: 'Synthetic Ensemble', sampleFile: syntheticTrackOne, trackCount: 2, durationSec: 301, genre: 'Synthetic' }],
    tracks: [
      { id: 1, file: syntheticTrackOne, artist: 'Synthetic Ensemble', albumArtist: 'Synthetic Ensemble', album: 'Fixture Album', title: 'First Fixture', track: '1', trackNo: 1, genre: 'Synthetic', durationSec: 150, albumKey: 'synthetic ensemble|fixture album', artistKey: 'synthetic ensemble', mbTrackId: '', mbAlbumId: '', mbArtistId: '', rating: 0 },
      { id: 2, file: syntheticTrackTwo, artist: 'Synthetic Ensemble', albumArtist: 'Synthetic Ensemble', album: 'Fixture Album', title: 'Second Fixture', track: '2', trackNo: 2, genre: 'Synthetic', durationSec: 151, albumKey: 'synthetic ensemble|fixture album', artistKey: 'synthetic ensemble', mbTrackId: '', mbAlbumId: '', mbArtistId: '', rating: 0 },
    ],
  };
  return {
    '.sonuvi-h4c4a-fixture.json': {
      contract: H4C4A_SYNTHETIC_STATE_CONTRACT,
      fixtureId,
      createdAt: builtAt,
      synthetic: true,
      purpose: 'H4C.4A local-only synthetic rehearsal fixture',
      files: [...FIXTURE_FILES].sort(),
      media: 'none',
      protectedMaterial: 'absent',
    },
    'config/now-playing.config.json': config,
    'data/library-browse-index.json': browseIndex,
    'data/source-audio-cache.json': {
      version: 1,
      files: {
        [syntheticTrackOne]: { probeVersion: 2, sizeBytes: 123456, modifiedMs: 0, sourceAudio: { sampleRateHz: 96000, bitDepth: 24, channels: 2, codec: 'FLAC', codecKind: 'lossless', bitDepthStatus: 'verified', bitDepthKind: 'integer', container: 'FLAC' } },
        [syntheticTrackTwo]: { probeVersion: 2, sizeBytes: 123457, modifiedMs: 0, sourceAudio: { sampleRateHz: 44100, bitDepth: 16, channels: 2, codec: 'FLAC', codecKind: 'lossless', bitDepthStatus: 'verified', bitDepthKind: 'integer', container: 'FLAC' } },
      },
    },
    'data/controller-profile.json': {
      devicePreset: 'mobile', theme: 'auto', layout: 'home-rail', showRecent: true,
      recentSource: 'albums', recentRows: ['albums', 'playlists', 'podcasts', 'radio'],
      colorPreset: 'ocean', recentCount: 6,
      customColors: { primaryThemeColor: '#0b111c', secondaryThemeColor: '#1f2a3d', primaryTextColor: '#f3f6ff', secondaryTextColor: '#9eb3d6' },
    },
    'data/playlists-index.json': {
      ts: 0,
      payload: { ok: true, playlists: [{ name: 'Synthetic Playlist', files: [syntheticTrackOne, syntheticTrackTwo] }] },
    },
    'data/radio-queue-presets.json': [],
    'data/radio-queue-map.json': { ts: 0, entries: [{ file: 'radio://synthetic', stationName: 'Synthetic Radio', genre: 'Synthetic' }] },
    'data/endless-vibe.json': { enabled: false, updatedAt: builtAt },
    'data/jukebox-entries.json': { version: 2, sequence: 0, entries: [] },
    'data/peppy-last-push.json': {
      url: `http://127.0.0.1:${ports.web}/display.html?kiosk=1`, skin: 'synthetic-1280', theme: 'synthetic',
      meterType: 'circular', fontMode: 'ui-sans', fontSize: 'm', linearStyle: 'continuous', linearSize: 'm',
      meterMode: 'segmented', colorMode: 'classic', spectrumColor: 'theme', spectrumEnergy: 'off', spectrumPeak: 'off',
      sensitivity: 'low', smoothing: 'low', normalization: 100, displayMode: 'peppy', playerSize: '1280x400',
      visualizer: { preset: 'synthetic', energy: 1, motion: 1, glow: 1 }, ts: 0,
    },
  };
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureRealDirectory(value, label) {
  const candidate = absolute(value, label);
  const stat = await lstatOrNull(candidate);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const real = await fs.realpath(candidate);
  if (real !== candidate) throw new Error(`${label} must not resolve through a symlink`);
  return candidate;
}

async function ensureRegularFile(value, label) {
  const candidate = absolute(value, label);
  const stat = await lstatOrNull(candidate);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return candidate;
}

async function sha256File(value, label) {
  const filePath = await ensureRegularFile(value, label);
  const contents = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function releaseId(value, label) {
  const candidate = text(value);
  if (!/^sonuvi-[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function assertRuntimeContractParityResult(value) {
  const modules = Array.isArray(value?.modules) ? value.modules : [];
  const paths = new Set(modules.map((entry) => entry?.relativePath));
  if (value?.contract !== H4C4A_RUNTIME_CONTRACT_PARITY || modules.length !== ARTIFACT_RUNTIME_CONTRACTS.length
    || paths.size !== ARTIFACT_RUNTIME_CONTRACTS.length
    || !modules.every((entry) => ARTIFACT_RUNTIME_CONTRACTS.includes(entry?.relativePath) && /^[a-f0-9]{64}$/.test(text(entry?.sha256)))) {
    throw new Error('release runtime-contract parity verification is invalid');
  }
  return Object.freeze({
    contract: H4C4A_RUNTIME_CONTRACT_PARITY,
    modules: Object.freeze(modules.map((entry) => Object.freeze({ relativePath: entry.relativePath, sha256: entry.sha256 }))),
  });
}

async function assertArtifactRuntimeContractParity({ releaseRoot } = {}) {
  const release = await ensureRealDirectory(releaseRoot, 'release root');
  const modules = [];
  for (const relativePath of ARTIFACT_RUNTIME_CONTRACTS) {
    const localPath = path.resolve(LOCAL_REPOSITORY_ROOT, relativePath);
    const artifactPath = path.resolve(release, relativePath);
    if (!contained(release, artifactPath)) throw new Error(`release runtime contract escapes artifact root: ${relativePath}`);
    const [localHash, artifactHash] = await Promise.all([
      sha256File(localPath, `local runtime contract ${relativePath}`),
      sha256File(artifactPath, `artifact runtime contract ${relativePath}`),
    ]);
    if (localHash !== artifactHash) {
      throw new Error(`release runtime contract differs from the local preflight contract: ${relativePath}`);
    }
    modules.push({ relativePath, sha256: artifactHash });
  }
  return assertRuntimeContractParityResult({ contract: H4C4A_RUNTIME_CONTRACT_PARITY, modules });
}

async function loadArtifactRuntimeCapabilities({ releaseRoot } = {}) {
  const release = await ensureRealDirectory(releaseRoot, 'release root');
  const modulePath = path.resolve(release, 'src/lib/runtime-capabilities.mjs');
  if (!contained(release, modulePath)) throw new Error('artifact capability module escapes release root');
  await ensureRegularFile(modulePath, 'artifact capability module');
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module?.createRuntimeCapabilities !== 'function') {
    throw new Error('artifact capability module does not export createRuntimeCapabilities');
  }
  return module.createRuntimeCapabilities;
}

function assertFixturePath(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!contained(root, resolved)) throw new Error('synthetic fixture path escapes its state root');
  return resolved;
}

async function writeJson(root, relative, value) {
  const target = assertFixturePath(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.chmod(target, 0o600);
}

async function listTree(root) {
  const directories = [];
  const files = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error(`synthetic rehearsal state cannot contain symlinks: ${childRelative}`);
      if (stat.isDirectory()) {
        directories.push(childRelative);
        await visit(child, childRelative);
      } else if (stat.isFile()) {
        files.push(childRelative);
      } else {
        throw new Error(`synthetic rehearsal state contains an unsupported file type: ${childRelative}`);
      }
    }
  }
  await visit(root);
  return { directories: directories.sort(), files: files.sort() };
}

function sensitiveKeys(value, prefix = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveKeys(item, `${prefix}[${index}]`));
  if (!isObject(value)) return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) found.push(name);
    found.push(...sensitiveKeys(child, name));
  }
  return found;
}

function assertFixtureConfig(config, ports) {
  assertImmutableRuntimeConfig(config, { context: 'synthetic rehearsal configuration' });
  if (!Array.isArray(config?.nodes) || config.nodes.length !== 1 || !isLoopbackHost(config.nodes[0]?.ip)) {
    throw new Error('synthetic rehearsal configuration must have one loopback node');
  }
  if (Number(config?.ports?.api) !== ports.api || Number(config?.ports?.ui) !== ports.web) {
    throw new Error('synthetic rehearsal configuration ports do not match the rehearsal plan');
  }
  if (!isLoopbackHost(config?.mpd?.host) || !isLoopbackHost(config?.moode?.sshHost)) {
    throw new Error('synthetic rehearsal configuration must not name a routeable MPD or moOde host');
  }
  assertLoopbackUrl(config?.moode?.baseUrl, 'synthetic moOde base URL');
  assertLoopbackUrl(config?.runtime?.publicBaseUrl, 'synthetic public base URL');
  if (config?.alexa?.enabled === true || config?.notifications?.trackNotify?.enabled === true) {
    throw new Error('synthetic rehearsal configuration must disable Alexa and push notifications');
  }
  for (const value of Object.values(config?.paths || {})) {
    if (!text(value).startsWith('/synthetic/')) throw new Error('synthetic rehearsal configuration paths must be synthetic-only');
  }
}

function assertBrowseIndex(index) {
  if (index?.schema !== 'now-playing.browse-index.v2') throw new Error('synthetic browse index must use v2');
  if (!Array.isArray(index?.artists) || !Array.isArray(index?.albums) || !Array.isArray(index?.tracks)) {
    throw new Error('synthetic browse index collections are invalid');
  }
  if (Number(index?.counts?.artists) !== index.artists.length || Number(index?.counts?.albums) !== index.albums.length || Number(index?.counts?.tracks) !== index.tracks.length) {
    throw new Error('synthetic browse index counts are inconsistent');
  }
  if (!index.tracks.every((track) => text(track?.file).startsWith('Synthetic/'))) {
    throw new Error('synthetic browse index includes a non-fictional track location');
  }
}

async function readJson(root, relative) {
  const target = assertFixturePath(root, relative);
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    throw new Error(`synthetic rehearsal fixture JSON is invalid: ${relative}`);
  }
}

export async function createSyntheticRehearsalState({
  stateRoot,
  apiPort = H4C4A_DEFAULT_PORTS.api,
  webPort = H4C4A_DEFAULT_PORTS.web,
  fixtureId = `sonuvi-h4c4a-${crypto.randomUUID()}`,
  createdAt = new Date().toISOString(),
} = {}) {
  const root = absolute(stateRoot, 'synthetic state root');
  const ports = assertDistinctPorts({ apiPort, webPort });
  const id = stableId(fixtureId, 'synthetic fixture ID');
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('synthetic fixture creation timestamp is invalid');
  if (await lstatOrNull(root)) throw new Error('synthetic state root must not already exist');
  const parent = await ensureRealDirectory(path.dirname(root), 'synthetic state-root parent');
  if (!contained(parent, root)) throw new Error('synthetic state root must be directly beneath its approved parent');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  try {
    for (const directory of FIXTURE_DIRECTORIES) {
      const target = assertFixturePath(root, directory);
      await fs.mkdir(target, { mode: 0o700 });
      await fs.chmod(target, 0o700);
    }
    for (const [relative, value] of Object.entries(fixtureContent({ fixtureId: id, createdAt, ports }))) {
      await writeJson(root, relative, value);
    }
    return await inspectSyntheticRehearsalState({ stateRoot: root, apiPort: ports.api, webPort: ports.web });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function inspectSyntheticRehearsalState({
  stateRoot,
  apiPort = H4C4A_DEFAULT_PORTS.api,
  webPort = H4C4A_DEFAULT_PORTS.web,
} = {}) {
  const root = await ensureRealDirectory(stateRoot, 'synthetic state root');
  const ports = assertDistinctPorts({ apiPort, webPort });
  const rootStat = await fs.stat(root);
  if ((rootStat.mode & 0o077) !== 0) throw new Error('synthetic state root permissions are too broad');
  const tree = await listTree(root);
  if (JSON.stringify(tree.directories) !== JSON.stringify([...FIXTURE_DIRECTORIES].sort())) {
    throw new Error('synthetic rehearsal state directory inventory is unexpected');
  }
  if (JSON.stringify(tree.files) !== JSON.stringify([...FIXTURE_FILES].sort())) {
    throw new Error('synthetic rehearsal state file inventory is unexpected');
  }
  for (const directory of FIXTURE_DIRECTORIES) {
    const stat = await fs.stat(assertFixturePath(root, directory));
    if ((stat.mode & 0o077) !== 0) throw new Error(`synthetic rehearsal directory permissions are too broad: ${directory}`);
  }
  const documents = {};
  for (const relative of FIXTURE_FILES) {
    const target = assertFixturePath(root, relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error(`synthetic rehearsal file is not a private regular file: ${relative}`);
    }
    documents[relative] = await readJson(root, relative);
  }
  const marker = documents['.sonuvi-h4c4a-fixture.json'];
  if (marker?.contract !== H4C4A_SYNTHETIC_STATE_CONTRACT || marker?.synthetic !== true || !stableId(marker?.fixtureId, 'synthetic fixture ID')) {
    throw new Error('synthetic rehearsal fixture marker is invalid');
  }
  if (JSON.stringify([...marker.files || []].sort()) !== JSON.stringify([...FIXTURE_FILES].sort())) {
    throw new Error('synthetic rehearsal fixture marker inventory is invalid');
  }
  assertFixtureConfig(documents['config/now-playing.config.json'], ports);
  assertBrowseIndex(documents['data/library-browse-index.json']);
  const sourceCache = documents['data/source-audio-cache.json'];
  if (sourceCache?.version !== 1 || !isObject(sourceCache?.files) || !Object.keys(sourceCache.files).every((entry) => entry.startsWith('Synthetic/'))) {
    throw new Error('synthetic source-audio cache is invalid');
  }
  const playlists = documents['data/playlists-index.json'];
  if (!Number.isFinite(Number(playlists?.ts)) || playlists?.payload?.ok !== true || !Array.isArray(playlists?.payload?.playlists)) {
    throw new Error('synthetic playlist cache is invalid');
  }
  const radio = documents['data/radio-queue-map.json'];
  if (!Number.isFinite(Number(radio?.ts)) || !Array.isArray(radio?.entries) || !radio.entries.every((entry) => text(entry?.file).startsWith('radio://synthetic'))) {
    throw new Error('synthetic radio metadata is invalid');
  }
  if (documents['data/endless-vibe.json']?.enabled !== false) throw new Error('synthetic Endless Vibe must stay disabled');
  if (documents['data/jukebox-entries.json']?.version !== 2 || !Array.isArray(documents['data/jukebox-entries.json']?.entries)) {
    throw new Error('synthetic jukebox queue state is invalid');
  }
  for (const [relative, value] of Object.entries(documents)) {
    if (relative === 'config/now-playing.config.json') continue;
    const keys = sensitiveKeys(value);
    if (keys.length) throw new Error(`synthetic rehearsal fixture contains protected-looking field names: ${keys.join(', ')}`);
  }
  return Object.freeze({
    contract: H4C4A_SYNTHETIC_STATE_CONTRACT,
    stateRoot: root,
    fixtureId: marker.fixtureId,
    ports,
    files: Object.freeze([...FIXTURE_FILES]),
  });
}

export async function removeSyntheticRehearsalState({ stateRoot, fixtureId } = {}) {
  const root = await ensureRealDirectory(stateRoot, 'synthetic state root');
  const marker = await readJson(root, '.sonuvi-h4c4a-fixture.json');
  if (marker?.contract !== H4C4A_SYNTHETIC_STATE_CONTRACT || marker?.synthetic !== true) {
    throw new Error('refusing cleanup of a root without the H4C.4A synthetic-state marker');
  }
  if (!fixtureId || marker.fixtureId !== fixtureId) {
    throw new Error('synthetic-state cleanup requires the exact fixture ID');
  }
  await fs.rm(root, { recursive: true, force: false });
  return Object.freeze({ removed: root, fixtureId: marker.fixtureId });
}

function rehearsalEnvironment({ releaseId }) {
  return Object.freeze({
    NODE_ENV: 'production',
    HOME: '/nonexistent',
    SONUVI_EXECUTION_MODE: 'rehearsal',
    SONUVI_REHEARSAL_STATE_ROOT: H4C4A_CONTAINER_PATHS.stateRoot,
    SONUVI_STATE_ROOT: H4C4A_CONTAINER_PATHS.stateRoot,
    SONUVI_CONFIG_ROOT: H4C4A_CONTAINER_PATHS.configRoot,
    SONUVI_SECRETS_ROOT: H4C4A_CONTAINER_PATHS.emptySecretsRoot,
    SONUVI_RELEASE_ID: releaseId,
    SONUVI_RELEASE_MANIFEST: `${H4C4A_CONTAINER_PATHS.releaseRoot}/release-manifest.json`,
    SONUVI_PUBLIC_WEB_ROOT: `${H4C4A_CONTAINER_PATHS.releaseRoot}/public`,
  });
}

function assertRehearsalEnvironment(environment, { releaseId, capabilityFactory = createRuntimeCapabilities } = {}) {
  if (!isObject(environment)) throw new Error('rehearsal environment is invalid');
  const required = {
    SONUVI_EXECUTION_MODE: 'rehearsal',
    SONUVI_REHEARSAL_STATE_ROOT: H4C4A_CONTAINER_PATHS.stateRoot,
    SONUVI_STATE_ROOT: H4C4A_CONTAINER_PATHS.stateRoot,
    SONUVI_CONFIG_ROOT: H4C4A_CONTAINER_PATHS.configRoot,
    SONUVI_SECRETS_ROOT: H4C4A_CONTAINER_PATHS.emptySecretsRoot,
    SONUVI_RELEASE_ID: releaseId,
    SONUVI_RELEASE_MANIFEST: `${H4C4A_CONTAINER_PATHS.releaseRoot}/release-manifest.json`,
    SONUVI_PUBLIC_WEB_ROOT: `${H4C4A_CONTAINER_PATHS.releaseRoot}/public`,
  };
  const allowed = new Set([
    'NODE_ENV', 'HOME', 'PORT', 'SONUVI_WEB_PORT',
    ...Object.keys(required),
  ]);
  if (text(environment.SONUVI_REHEARSAL_ALLOW_EXTERNAL_READ) === '1') {
    throw new Error('rehearsal environment must not allow external reads');
  }
  for (const name of Object.keys(environment)) {
    if (!allowed.has(name)) throw new Error(`rehearsal environment contains an unexpected variable: ${name}`);
  }
  if (environment.NODE_ENV !== 'production' || environment.HOME !== '/nonexistent') {
    throw new Error('rehearsal environment must use the locked-down Node and home settings');
  }
  for (const [name, expected] of Object.entries(required)) {
    if (environment[name] !== expected) throw new Error(`rehearsal environment must set ${name} exactly`);
  }
  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) {
    if (text(environment[name])) throw new Error(`rehearsal environment must not include ${name}`);
  }
  const capabilities = capabilityFactory({ env: environment });
  if (!capabilities.rehearsal) throw new Error('rehearsal environment did not activate the capability gate');
}

function mount(source, target, readOnly) {
  return Object.freeze({ type: 'bind', source, target, readOnly });
}

function containerSpec({ name, command, ports, releaseRoot, stateRoot, releaseId, kind }) {
  const stateReadOnly = kind === 'web';
  const environment = Object.freeze({
    ...rehearsalEnvironment({ releaseId }),
    ...(kind === 'api' ? { PORT: String(ports.api) } : { SONUVI_WEB_PORT: String(ports.web) }),
  });
  return Object.freeze({
    name,
    command: Object.freeze([...command]),
    environment,
    environmentMode: 'replace',
    networkMode: 'internal-rehearsal-bridge',
    publishedPorts: Object.freeze([]),
    readOnlyRootFilesystem: true,
    privileged: false,
    hostPid: false,
    hostIpc: false,
    dockerSocket: false,
    capDrop: Object.freeze(['ALL']),
    noNewPrivileges: true,
    user: '1000:1000',
    mounts: Object.freeze([
      mount(releaseRoot, H4C4A_CONTAINER_PATHS.releaseRoot, true),
      mount(stateRoot, H4C4A_CONTAINER_PATHS.stateRoot, stateReadOnly),
    ]),
    tmpfs: Object.freeze(kind === 'api'
      ? [
        { target: '/tmp', sizeBytes: 64 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: `${H4C4A_CONTAINER_PATHS.stateRoot}/cache`, sizeBytes: 128 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: `${H4C4A_CONTAINER_PATHS.stateRoot}/logs`, sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
        { target: `${H4C4A_CONTAINER_PATHS.stateRoot}/checkpoints`, sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
      ]
      : [
        { target: '/tmp', sizeBytes: 32 * 1024 * 1024, options: ['rw', 'noexec', 'nosuid'] },
      ]),
    resources: Object.freeze(kind === 'api'
      ? { cpus: 0.75, memoryBytes: 768 * 1024 * 1024, pids: 128, nofile: 1024, logMaxBytes: 10 * 1024 * 1024, logFiles: 2 }
      : { cpus: 0.25, memoryBytes: 192 * 1024 * 1024, pids: 32, nofile: 512, logMaxBytes: 5 * 1024 * 1024, logFiles: 2 }),
  });
}

function assertSafeMountSource(value, label) {
  const source = absolute(value, label);
  if (FORBIDDEN_MOUNT_PREFIXES.some((prefix) => source === prefix.slice(0, -1) || source.startsWith(prefix))) {
    throw new Error(`${label} names a prohibited production or home path`);
  }
  return source;
}

export function assertContainerIsolationPlan(plan, { capabilityFactory = createRuntimeCapabilities } = {}) {
  if (!isObject(plan) || plan.contract !== H4C4A_REHEARSAL_PLAN_CONTRACT) throw new Error('rehearsal plan contract is invalid');
  if (plan.action !== 'preflight-only' || plan.startAuthorized !== false) throw new Error('H4C.4A plan must remain preflight-only');
  if (plan.expectedReleaseId !== plan.releaseId) throw new Error('rehearsal plan release identity is not pinned');
  assertRuntimeContractParityResult(plan.runtimeContractParity);
  if (plan.platform !== 'linux/arm64') throw new Error('rehearsal plan must target linux/arm64');
  if (plan.network?.kind !== 'internal-bridge' || plan.network?.internal !== true || plan.network?.allowExternalEgress !== false || !Array.isArray(plan.network?.publishedPorts) || plan.network.publishedPorts.length) {
    throw new Error('rehearsal plan network isolation is incomplete');
  }
  const containers = Array.isArray(plan.containers) ? plan.containers : [];
  if (containers.length !== 2) throw new Error('rehearsal plan must define exactly API and web containers');
  const names = new Set(containers.map((container) => container?.name));
  if (!names.has('api') || !names.has('web') || names.size !== 2) throw new Error('rehearsal plan container names are invalid');
  const expectedPorts = assertDistinctPorts({ apiPort: plan.ports?.api, webPort: plan.ports?.web });
  const permittedSources = new Set([absolute(plan.releaseRoot, 'release root'), absolute(plan.stateRoot, 'synthetic state root')]);
  for (const container of containers) {
    if (!isObject(container) || !Array.isArray(container.command) || !container.command.length) throw new Error('rehearsal container command is missing');
    if (container.environmentMode !== 'replace' || container.networkMode !== 'internal-rehearsal-bridge' || !Array.isArray(container.publishedPorts) || container.publishedPorts.length) {
      throw new Error('rehearsal container must use the internal bridge without published ports');
    }
    if (!container.readOnlyRootFilesystem || container.privileged || container.hostPid || container.hostIpc || container.dockerSocket || !Array.isArray(container.capDrop) || !container.capDrop.includes('ALL') || container.noNewPrivileges !== true) {
      throw new Error('rehearsal container sandbox settings are incomplete');
    }
    const mounts = Array.isArray(container.mounts) ? container.mounts : [];
    if (mounts.length !== 2) throw new Error('rehearsal container mount inventory is invalid');
    const releaseMount = mounts.find((entry) => entry?.target === H4C4A_CONTAINER_PATHS.releaseRoot);
    const stateMount = mounts.find((entry) => entry?.target === H4C4A_CONTAINER_PATHS.stateRoot);
    const expectStateReadOnly = container.name === 'web';
    if (!releaseMount?.readOnly || stateMount?.readOnly !== expectStateReadOnly || releaseMount.type !== 'bind' || stateMount.type !== 'bind') {
      throw new Error('rehearsal container release/state mounts are invalid');
    }
    for (const item of mounts) {
      const source = assertSafeMountSource(item?.source, 'rehearsal mount source');
      if (!permittedSources.has(source) || item.target === '/var/run/docker.sock') throw new Error('rehearsal container has an unexpected mount');
    }
    if (!Array.isArray(container.tmpfs) || !container.tmpfs.length || !isObject(container.resources)) {
      throw new Error('rehearsal container resource limits are incomplete');
    }
    assertRehearsalEnvironment(container.environment, { releaseId: plan.releaseId, capabilityFactory });
  }
  if (Number(plan.containers.find((container) => container.name === 'api')?.environment?.PORT) !== expectedPorts.api
    || Number(plan.containers.find((container) => container.name === 'web')?.environment?.SONUVI_WEB_PORT) !== expectedPorts.web) {
    throw new Error('rehearsal container ports are inconsistent');
  }
  return true;
}

export async function prepareH4c4aRehearsal({
  releaseRoot,
  stateRoot,
  expectedReleaseId,
  apiPort = H4C4A_DEFAULT_PORTS.api,
  webPort = H4C4A_DEFAULT_PORTS.web,
  verifyArtifact = verifyReleaseArtifact,
  verifyRuntimeContractParity = assertArtifactRuntimeContractParity,
  loadRuntimeCapabilities = loadArtifactRuntimeCapabilities,
  targetRuntime = { version: 'v20.20.1', platform: 'linux', arch: 'arm64', versions: { modules: '115', napi: '9' } },
} = {}) {
  const release = await ensureRealDirectory(releaseRoot, 'release root');
  const state = await inspectSyntheticRehearsalState({ stateRoot, apiPort, webPort });
  const verified = await verifyArtifact({ artifactRoot: release });
  if (!verified || absolute(verified.root, 'verified release root') !== release || !isObject(verified.manifest)) {
    throw new Error('release manifest verifier did not confirm the explicit release root');
  }
  const manifest = verified.manifest;
  if (manifest?.source?.dirty !== false || manifest?.source?.snapshotStatus !== 'clean-git-worktree-snapshot') {
    throw new Error('rehearsal requires a clean Git-provenance release artifact');
  }
  if (manifest?.target?.os !== 'linux' || manifest?.target?.architecture !== 'arm64') {
    throw new Error('rehearsal requires a linux/arm64 release artifact');
  }
  if (!/^v?20\./.test(text(targetRuntime?.version))) throw new Error('rehearsal requires a Node 20 target runtime');
  assertReleaseTargetRuntime({ manifest, runtime: targetRuntime });
  const verifiedReleaseId = releaseId(verified.releaseId || manifest.releaseId, 'verified release ID');
  const expectedId = releaseId(expectedReleaseId, 'expected release ID');
  if (verifiedReleaseId !== expectedId) throw new Error('verified release ID does not match the explicit rehearsal release identity');
  const runtimeContractParity = assertRuntimeContractParityResult(await verifyRuntimeContractParity({ releaseRoot: release }));
  const artifactCapabilityFactory = await loadRuntimeCapabilities({ releaseRoot: release });
  if (typeof artifactCapabilityFactory !== 'function') throw new Error('artifact capability loader returned an invalid capability factory');
  const ports = assertDistinctPorts({ apiPort, webPort });
  const plan = {
    contract: H4C4A_REHEARSAL_PLAN_CONTRACT,
    action: 'preflight-only',
    startAuthorized: false,
    platform: 'linux/arm64',
    runtimeImage: H4C4A_RUNTIME_IMAGE,
    releaseId: verifiedReleaseId,
    expectedReleaseId: expectedId,
    runtimeContractParity,
    releaseRoot: assertSafeMountSource(release, 'release root'),
    stateRoot: assertSafeMountSource(state.stateRoot, 'synthetic state root'),
    fixtureId: state.fixtureId,
    ports,
    network: {
      kind: 'internal-bridge',
      internal: true,
      allowExternalEgress: false,
      publishedPorts: [],
      healthProbe: 'future disposable probe container on the same internal bridge only',
    },
    containers: [
      containerSpec({ name: 'api', command: ['node', 'moode-nowplaying-api.mjs'], ports, releaseRoot: release, stateRoot: state.stateRoot, releaseId: verifiedReleaseId, kind: 'api' }),
      containerSpec({ name: 'web', command: ['node', 'scripts/serve-public-web.mjs'], ports, releaseRoot: release, stateRoot: state.stateRoot, releaseId: verifiedReleaseId, kind: 'web' }),
    ],
    cleanup: {
      stateRoot: state.stateRoot,
      fixtureId: state.fixtureId,
      rule: 'Remove only this exact marked synthetic root after an explicit cleanup command; never prune Docker globally.',
    },
  };
  assertContainerIsolationPlan(plan, { capabilityFactory: artifactCapabilityFactory });
  return Object.freeze(plan);
}
