import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

const execFileP = promisify(execFile);
const REGISTRY_VERSION = 1;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_THUMBNAIL_TIME_SEC = 10;

const VIDEO_FORMATS = Object.freeze({
  '.mp4': { format: 'mp4', mimeType: 'video/mp4', supported: true },
  '.m4v': { format: 'm4v', mimeType: 'video/x-m4v', supported: true },
  '.mov': { format: 'mov', mimeType: 'video/quicktime', supported: true },
  '.mkv': { format: 'mkv', mimeType: 'video/x-matroska', supported: false },
});

export class MobileVideoStorageUnavailableError extends Error {
  constructor(message = 'video storage is unavailable') {
    super(message);
    this.name = 'MobileVideoStorageUnavailableError';
    this.code = 'VIDEO_STORAGE_UNAVAILABLE';
  }
}

function randomOpaqueId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function posixRelative(value) {
  return String(value || '').split(path.sep).filter(Boolean).join('/');
}

function normalizedRelative(value) {
  const raw = posixRelative(value);
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return '';
  }
  return normalized;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function classifyVideoPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const descriptor = VIDEO_FORMATS[ext];
  return descriptor ? { extension: ext, ...descriptor } : null;
}

function defaultTitle(filename) {
  return path.basename(String(filename || ''), path.extname(String(filename || ''))).trim();
}

async function probeMetadata(filePath, ffprobePath) {
  try {
    const { stdout } = await execFileP(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=title,artist,album',
      '-of', 'json',
      filePath,
    ], { timeout: 15_000, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(String(stdout || '{}'));
    const format = parsed?.format || {};
    const duration = Number(format.duration);
    const tags = format.tags && typeof format.tags === 'object' ? format.tags : {};
    return {
      durationSec: Number.isFinite(duration) && duration >= 0 ? duration : null,
      metadata: {
        ...(String(tags.title || '').trim() ? { title: String(tags.title).trim() } : {}),
        ...(String(tags.artist || '').trim() ? { artist: String(tags.artist).trim() } : {}),
        ...(String(tags.album || '').trim() ? { album: String(tags.album).trim() } : {}),
      },
    };
  } catch {
    return { durationSec: null, metadata: {} };
  }
}

export function createMobileVideoCatalog({
  root,
  registryPath,
  ffprobePath = process.env.FFPROBE || '/usr/bin/ffprobe',
  ffmpegPath = process.env.FFMPEG || '/usr/bin/ffmpeg',
  readMetadata = (filePath) => probeMetadata(filePath, ffprobePath),
  runThumbnail,
} = {}) {
  const configuredRoot = path.resolve(String(root || ''));
  const configuredRegistry = path.resolve(String(registryPath || runtimeStatePaths().mobileVideoCatalogPath));
  let registry = null;
  let operation = Promise.resolve();

  const run = (task) => {
    const next = operation.then(task, task);
    operation = next.catch(() => {});
    return next;
  };

  const loadRegistry = async () => {
    if (registry) return registry;
    try {
      const parsed = JSON.parse(await fsp.readFile(configuredRegistry, 'utf8'));
      registry = {
        version: REGISTRY_VERSION,
        videos: parsed?.videos && typeof parsed.videos === 'object' ? parsed.videos : {},
        folders: parsed?.folders && typeof parsed.folders === 'object' ? parsed.folders : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      registry = { version: REGISTRY_VERSION, videos: {}, folders: {} };
    }
    return registry;
  };

  const persistRegistry = async () => {
    await fsp.mkdir(path.dirname(configuredRegistry), { recursive: true });
    const temporary = `${configuredRegistry}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(temporary, 0o600).catch(() => {});
    await fsp.rename(temporary, configuredRegistry);
    await fsp.chmod(configuredRegistry, 0o600).catch(() => {});
  };

  const rootRealPath = async () => {
    if (!configuredRoot) throw new MobileVideoStorageUnavailableError();
    try {
      const stat = await fsp.stat(configuredRoot);
      if (!stat.isDirectory()) throw new Error('video root is not a directory');
      return await fsp.realpath(configuredRoot);
    } catch {
      throw new MobileVideoStorageUnavailableError();
    }
  };

  const thumbnailTimeSec = (durationSec) => {
    const duration = Number(durationSec);
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_THUMBNAIL_TIME_SEC;
    return Math.min(DEFAULT_THUMBNAIL_TIME_SEC, Math.max(1, duration * 0.05));
  };

  const renderThumbnail = async (filePath, durationSec) => {
    if (typeof runThumbnail === 'function') {
      return runThumbnail(filePath, thumbnailTimeSec(durationSec));
    }
    const result = await execFileP(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(thumbnailTimeSec(durationSec)), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { timeout: 30_000, maxBuffer: MAX_THUMBNAIL_BYTES, encoding: 'buffer' });
    return Buffer.from(result.stdout || '');
  };

  const thumbnailProbe = async (filePath, durationSec) => {
    try {
      const buffer = await renderThumbnail(filePath, durationSec);
      return Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= MAX_THUMBNAIL_BYTES;
    } catch {
      return false;
    }
  };

  const scan = async (directory, relative = '', output = []) => {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      throw new MobileVideoStorageUnavailableError();
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      // macOS Finder resource-fork sidecars such as ._Movie.mp4 are not
      // videos and must not become catalog entries.
      if (entry.name.startsWith('.')) continue;
      const childRelative = normalizedRelative(path.posix.join(posixRelative(relative), entry.name));
      if (!childRelative) continue;
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(childPath, childRelative, output);
        continue;
      }
      if (!entry.isFile() || !classifyVideoPath(childRelative)) continue;
      output.push({ relativePath: childRelative, absolutePath: childPath });
    }
    return output;
  };

  const folderIdFor = (relativeFolder, changed) => {
    if (!relativeFolder) return null;
    const existing = registry.folders[relativeFolder];
    if (existing?.id) return existing.id;
    const id = randomOpaqueId('vfld');
    registry.folders[relativeFolder] = { id, relativePath: relativeFolder };
    changed.value = true;
    return id;
  };

  const list = async ({ folderId = '' } = {}) => run(async () => {
    const realRoot = await rootRealPath();
    await loadRegistry();
    const discovered = await scan(realRoot);
    const changed = { value: false };
    const items = [];

    for (const found of discovered) {
      const descriptor = classifyVideoPath(found.relativePath);
      if (!descriptor) continue;
      const safeRelative = normalizedRelative(found.relativePath);
      const absolutePath = path.resolve(realRoot, ...safeRelative.split('/'));
      if (!isContained(realRoot, absolutePath)) continue;
      let stat;
      try {
        if ((await fsp.lstat(absolutePath)).isSymbolicLink()) continue;
        if (!isContained(realRoot, await fsp.realpath(absolutePath))) continue;
        stat = await fsp.stat(absolutePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const existing = registry.videos[safeRelative];
      const unchanged = existing
        && Number(existing.sizeBytes) === Number(stat.size)
        && Number(existing.modifiedMs) === Number(stat.mtimeMs)
        && existing.id;
      const folderRelative = path.posix.dirname(safeRelative) === '.' ? '' : path.posix.dirname(safeRelative);
      const current = unchanged ? existing : {
        id: existing?.id || randomOpaqueId('vid'),
        relativePath: safeRelative,
        sizeBytes: Number(stat.size),
        modifiedMs: Number(stat.mtimeMs),
        durationSec: null,
        metadata: {},
      };
      current.relativePath = safeRelative;
      current.sizeBytes = Number(stat.size);
      current.modifiedMs = Number(stat.mtimeMs);
      if (!unchanged) {
        const metadata = await readMetadata(absolutePath).catch(() => ({ durationSec: null, metadata: {} }));
        current.durationSec = Number.isFinite(Number(metadata?.durationSec)) ? Math.max(0, Number(metadata.durationSec)) : null;
        current.metadata = metadata?.metadata && typeof metadata.metadata === 'object' ? metadata.metadata : {};
        registry.videos[safeRelative] = current;
        changed.value = true;
      }
      if (!unchanged || typeof current.thumbnailAvailable !== 'boolean') {
        current.thumbnailAvailable = await thumbnailProbe(absolutePath, current.durationSec);
        registry.videos[safeRelative] = current;
        changed.value = true;
      }
      const folderIdValue = folderIdFor(folderRelative, changed);
      const folder = folderRelative ? path.posix.basename(folderRelative) : null;
      const requestedFolder = String(folderId || '').trim();
      if (requestedFolder && requestedFolder !== folderIdValue) continue;
      items.push({
        videoID: current.id,
        title: String(current.metadata?.title || defaultTitle(path.basename(safeRelative))).trim(),
        filename: path.basename(safeRelative),
        folderID: folderIdValue,
        folderName: folder,
        mimeType: descriptor.mimeType,
        format: descriptor.format,
        sizeBytes: Number(current.sizeBytes),
        durationSec: current.durationSec,
        modifiedAt: new Date(Number(current.modifiedMs)).toISOString(),
        metadata: current.metadata || {},
        thumbnailAvailable: current.thumbnailAvailable === true,
        playback: {
          available: descriptor.supported,
          reason: descriptor.supported ? null : 'format is not supported for native playback',
        },
        _absolutePath: absolutePath,
        _supported: descriptor.supported,
      });
    }
    if (changed.value) await persistRegistry();
    items.sort((a, b) => `${a.folderName || ''}/${a.filename}`.localeCompare(`${b.folderName || ''}/${b.filename}`));
    return { items, storageAvailable: true };
  });

  const resolve = async (videoID) => {
    const id = String(videoID || '').trim();
    if (!id) return { status: 'not_found' };
    const result = await list();
    const item = result.items.find((candidate) => candidate.videoID === id);
    if (!item) return { status: 'not_found' };
    return { status: 'ok', item };
  };

  const thumbnail = async (videoID) => {
    const resolved = await resolve(videoID);
    if (resolved.status !== 'ok') return resolved;
    const { item } = resolved;
    let buffer;
    try {
      buffer = await renderThumbnail(item._absolutePath, item.durationSec);
    } catch (error) {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { status: 'too_large' };
      return { status: 'unavailable' };
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { status: 'unavailable' };
    if (buffer.length > MAX_THUMBNAIL_BYTES) return { status: 'too_large' };
    return { status: 'ok', buffer, contentType: 'image/jpeg' };
  };

  return {
    root: configuredRoot,
    list,
    resolve,
    thumbnail,
  };
}

export const MOBILE_VIDEO_THUMBNAIL_MAX_BYTES = MAX_THUMBNAIL_BYTES;
