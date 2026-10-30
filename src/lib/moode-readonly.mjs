import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { moodeReadOnlyArgs, resolveMoodeSshProfile } from './moode-ssh-profile.mjs';

const execFileP = promisify(execFile);
const CONTRACT = 'sonuvi.moode-readonly.v1';
const MAX_AUDIOINFO_HTML_BYTES = 512 * 1024;
const MAX_ALSA_PROBE_BYTES = 256 * 1024;
const SAFE_CODE = /^SONUVI_[A-Z0-9_]{1,96}$/;
const STAGE_STATUS = new Set(['available', 'unavailable']);
const MPD_STATES = new Set(['play', 'pause', 'stop', 'unknown']);
const BIT_DEPTH_KINDS = new Set(['integer', 'float']);

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function safeCode(value, fallback = null) {
  const code = text(value).toUpperCase();
  return SAFE_CODE.test(code) ? code : fallback;
}

function parseDispatcherPayload(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function remoteFailure(error) {
  const payload = parseDispatcherPayload(error?.stdout);
  return new MoodeReadUnavailableError(safeCode(payload?.code, 'SONUVI_MOODE_READ_UNAVAILABLE'));
}

function stage(value, fallbackStatus) {
  const input = plainObject(value) ? value : {};
  const status = STAGE_STATUS.has(text(input.status).toLowerCase())
    ? text(input.status).toLowerCase()
    : fallbackStatus;
  return {
    status,
    code: safeCode(input.code),
    provenance: 'sonuvi-moode-readonly-v1',
  };
}

function snapshotMpd(value) {
  const input = plainObject(value) ? value : {};
  const decoded = plainObject(input.decoded) ? input.decoded : {};
  const state = text(input.state).toLowerCase();
  const bitDepthKind = text(decoded.bitDepthKind).toLowerCase();
  return {
    state: MPD_STATES.has(state) ? state : 'unknown',
    source: text(input.source).slice(0, 4096),
    decoded: {
      sampleRateHz: positiveInteger(decoded.sampleRateHz),
      bitDepth: positiveInteger(decoded.bitDepth),
      bitDepthKind: BIT_DEPTH_KINDS.has(bitDepthKind) ? bitDepthKind : null,
      channels: positiveInteger(decoded.channels),
    },
  };
}

export class MoodeReadUnavailableError extends Error {
  constructor(code = 'SONUVI_MOODE_READ_UNAVAILABLE') {
    super('moOde read-only diagnostics are unavailable');
    this.name = 'MoodeReadUnavailableError';
    this.code = safeCode(code, 'SONUVI_MOODE_READ_UNAVAILABLE');
  }
}

export function normalizeMoodeAudioInfoSnapshot(value) {
  if (!plainObject(value)) throw new MoodeReadUnavailableError('SONUVI_MOODE_READ_UNAVAILABLE');

  const audioInfoHtml = String(value.audioInfoHtml || '');
  const alsaProbe = String(value.alsaProbe || '');
  if (Buffer.byteLength(audioInfoHtml, 'utf8') > MAX_AUDIOINFO_HTML_BYTES
    || Buffer.byteLength(alsaProbe, 'utf8') > MAX_ALSA_PROBE_BYTES) {
    throw new MoodeReadUnavailableError('SONUVI_MOODE_READ_UNAVAILABLE');
  }

  const collection = plainObject(value.collection) ? value.collection : {};
  return {
    capturedAt: text(value.capturedAt) || null,
    audioInfoHtml,
    alsaProbe,
    mpd: snapshotMpd(value.mpd),
    collection: {
      session: stage(collection.session, audioInfoHtml ? 'available' : 'unavailable'),
      rendererReport: stage(collection.rendererReport, audioInfoHtml ? 'available' : 'unavailable'),
      mpd: stage(collection.mpd, text(value.mpd?.state) ? 'available' : 'unavailable'),
      alsa: stage(collection.alsa, alsaProbe ? 'available' : 'unavailable'),
    },
  };
}

async function readMoodeOperation(operation, {
  environment = process.env,
  execute = execFileP,
} = {}) {
  const profile = resolveMoodeSshProfile({ env: environment });
  const args = moodeReadOnlyArgs(operation, { profile });

  let response;
  try {
    response = await execute('/usr/bin/ssh', args, {
      timeout: 7000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw remoteFailure(error);
  }

  const payload = parseDispatcherPayload(response?.stdout);
  if (!payload?.ok || payload.contract !== CONTRACT || payload.operation !== operation) {
    throw new MoodeReadUnavailableError(safeCode(payload?.code, 'SONUVI_MOODE_READ_UNAVAILABLE'));
  }
  return payload;
}

export async function readMoodeAudioInfoSnapshot(options = {}) {
  const payload = await readMoodeOperation('audio-info-snapshot', options);
  return normalizeMoodeAudioInfoSnapshot(payload.snapshot);
}
