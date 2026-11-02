import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

const execFileP = promisify(execFile);

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

const LOSSY_CODECS = new Set([
  'aac', 'ac3', 'amr_nb', 'amr_wb', 'eac3', 'mp2', 'mp3', 'nellymoser',
  'opus', 'vorbis', 'speex', 'wmav1', 'wmav2', 'wmavoice',
]);

const LOSSLESS_CODECS = new Set([
  'alac', 'ape', 'flac', 'mlp', 'tta', 'tak', 'truehd', 'wavpack',
]);

function normalizedCodec(value) {
  return String(value || '').trim().toLowerCase();
}

function codecKind(codec) {
  const normalized = normalizedCodec(codec);
  if (!normalized) return 'unknown';
  if (normalized.startsWith('pcm_') || LOSSLESS_CODECS.has(normalized)) return 'lossless';
  if (LOSSY_CODECS.has(normalized)) return 'lossy';
  return 'unknown';
}

function pcmCodecDetails(codec) {
  const match = normalizedCodec(codec).match(/^pcm_([suf])(8|16|24|32|64)(?:le|be)$/);
  if (!match) return null;
  return {
    bitDepth: positiveInt(match[2]),
    bitDepthKind: match[1] === 'f' ? 'float' : 'integer',
  };
}

function codecLabel(codec, profile) {
  const normalized = normalizedCodec(codec);
  if (!normalized) return '';
  if (normalized === 'aac' && /lc/i.test(String(profile || ''))) return 'AAC-LC';
  return normalized.toUpperCase();
}

function containerLabel(formatName) {
  const names = String(formatName || '')
    .split(',')
    .map((value) => normalizedCodec(value))
    .filter(Boolean);
  const preferred = ['m4a', 'mp4', 'flac', 'wav', 'aiff', 'aif', 'ogg', 'opus', 'dsf', 'dff', 'wv']
    .find((value) => names.includes(value));
  const value = preferred || names[0] || '';
  return value === 'aif' ? 'AIFF' : value.toUpperCase();
}

function probeBitrate(parsed, stream) {
  const streamRate = positiveInt(stream?.bit_rate);
  if (streamRate) return { value: streamRate, provenance: 'ffprobe.stream' };
  const formatRate = positiveInt(parsed?.format?.bit_rate);
  if (formatRate) return { value: formatRate, provenance: 'ffprobe.format' };
  return { value: null, provenance: '' };
}

function normalizeProbe(parsed) {
  const stream = parsed?.streams?.[0] || {};
  const codecName = normalizedCodec(stream.codec_name);
  const kind = codecKind(codecName);
  const pcm = pcmCodecDetails(codecName);
  const rawBitDepth = positiveInt(stream.bits_per_raw_sample);
  const bitDepth = kind === 'lossy'
    ? null
    : (rawBitDepth || pcm?.bitDepth || (kind === 'lossless' ? positiveInt(stream.bits_per_sample) : null));
  const bitrate = probeBitrate(parsed, stream);
  const sourceAudio = {
    ...(positiveInt(stream.sample_rate) ? { sampleRateHz: positiveInt(stream.sample_rate) } : {}),
    ...(bitDepth ? { bitDepth } : {}),
    ...(positiveInt(stream.channels) ? { channels: positiveInt(stream.channels) } : {}),
    ...(codecName ? {
      codec: codecLabel(codecName, stream.profile),
      codecKind: kind,
      bitDepthStatus: bitDepth ? 'verified' : (kind === 'lossy' ? 'not-applicable' : 'unavailable'),
      ...(bitDepth ? { bitDepthKind: pcm?.bitDepthKind || 'integer' } : {}),
    } : {}),
    ...(containerLabel(parsed?.format?.format_name)
      ? { container: containerLabel(parsed?.format?.format_name) }
      : {}),
    ...(bitrate.value ? {
      encodedBitrateBps: bitrate.value,
      encodedBitrateStatus: 'reported',
      encodedBitrateProvenance: bitrate.provenance,
    } : {}),
  };
  return Object.keys(sourceAudio).length ? sourceAudio : null;
}

export function createSourceAudioProbe({
  resolveFile,
  cachePath,
  ffprobePath = process.env.FFPROBE || '/usr/bin/ffprobe',
  fsApi = fs,
  runExecFile = execFileP,
  now = () => Date.now(),
  retryDelayMs = 30 * 60 * 1000,
} = {}) {
  const probeVersion = 2;
  const configuredCachePath = path.resolve(String(cachePath || runtimeStatePaths().sourceAudioCachePath));
  let cache = null;
  const inflight = new Map();
  let persistOperation = Promise.resolve();
  const boundedRetryDelayMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(retryDelayMs) || 30 * 60 * 1000));

  const load = async () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsApi.readFile(configuredCachePath, 'utf8'));
      cache = parsed?.files && typeof parsed.files === 'object' ? parsed.files : {};
    } catch {
      cache = {};
    }
    return cache;
  };

  const persist = async () => {
    const write = persistOperation.then(async () => {
      await fsApi.mkdir(path.dirname(configuredCachePath), { recursive: true });
      const temporary = `${configuredCachePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fsApi.writeFile(temporary, `${JSON.stringify({ version: 2, files: cache }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsApi.rename(temporary, configuredCachePath);
    });
    persistOperation = write.catch(() => {});
    await write;
  };

  const sourceRevision = (stat) => ({
    sizeBytes: Number(stat.size),
    modifiedMs: Number(stat.mtimeMs),
    probeVersion,
  });

  const retryAfter = () => new Date(Number(now()) + boundedRetryDelayMs).toISOString();

  const failed = (reason, revision = null, retryAt = retryAfter()) => ({
    status: 'failed',
    reason,
    retryAfter: retryAt,
    ...(revision ? { sourceRevision: revision } : {}),
  });

  const cacheMatches = (previous, revision) => (
    previous
      && Number(previous.probeVersion) === probeVersion
      && Number(previous.sizeBytes) === Number(revision.sizeBytes)
      && Number(previous.modifiedMs) === Number(revision.modifiedMs)
  );

  const getRecord = async (mpdFile, { force = false } = {}) => {
    const key = String(mpdFile || '').trim();
    if (!key || typeof resolveFile !== 'function') return failed('source-unavailable');
    if (inflight.has(key)) return inflight.get(key);

    const task = (async () => {
      const filePath = await resolveFile(key);
      if (!filePath) return failed('source-unavailable');
      let stat;
      try {
        stat = await fsApi.stat(filePath);
        if (!stat.isFile()) return failed('source-unavailable');
      } catch {
        return failed('source-unavailable');
      }

      const revision = sourceRevision(stat);
      const entries = await load();
      const previous = entries[key];
      if (!force && cacheMatches(previous, revision) && previous?.sourceAudio && typeof previous.sourceAudio === 'object') {
        return { status: 'verified', sourceAudio: previous.sourceAudio, sourceRevision: revision };
      }
      if (!force && cacheMatches(previous, revision) && previous?.probeStatus === 'failed') {
        const retryAt = Date.parse(String(previous.retryAfter || ''));
        if (Number.isFinite(retryAt) && retryAt > Number(now())) {
          return failed(String(previous.failureReason || 'probe-failed'), revision, new Date(retryAt).toISOString());
        }
      }

      let sourceAudio = null;
      let failureReason = '';
      try {
        const { stdout } = await runExecFile(ffprobePath, [
          '-v', 'error',
          '-select_streams', 'a:0',
          '-show_entries', 'stream=codec_name,profile,sample_rate,channels,bits_per_raw_sample,bits_per_sample,bit_rate:format=format_name,format_long_name,bit_rate',
          '-of', 'json',
          filePath,
        ], { timeout: 15_000, maxBuffer: 128 * 1024 });
        sourceAudio = normalizeProbe(JSON.parse(String(stdout || '{}')));
        if (!sourceAudio) failureReason = 'unrecognized-audio';
      } catch {
        failureReason = 'probe-failed';
      }

      entries[key] = {
        probeVersion,
        sizeBytes: revision.sizeBytes,
        modifiedMs: revision.modifiedMs,
        sourceAudio,
        probeStatus: sourceAudio ? 'verified' : 'failed',
        ...(sourceAudio ? {} : { failureReason: failureReason || 'probe-failed', retryAfter: retryAfter() }),
      };
      await persist().catch(() => {});
      return sourceAudio
        ? { status: 'verified', sourceAudio, sourceRevision: revision }
        : failed(failureReason || 'probe-failed', revision, entries[key].retryAfter);
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  };

  const get = async (mpdFile) => {
    const record = await getRecord(mpdFile);
    return record?.status === 'verified' ? record.sourceAudio || null : null;
  };

  return { get, getRecord };
}

export { normalizeProbe as normalizeSourceAudioProbe };
