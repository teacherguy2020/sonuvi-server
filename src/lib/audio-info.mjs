function text(value) {
  return String(value ?? '').trim();
}

function stripTags(value = '') {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rarr;/g, '→')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeValue(key = '', value = '') {
  const k = String(key || '').toLowerCase();
  const v = String(value || '').trim();
  if (!v) return '—';
  if (v.toLowerCase() === 'not playing') return 'Not playing';
  if (k === 'crossfade' && /^seconds$/i.test(v)) return 'Off';
  if (k === 'crossfeed' && /^hz\s+db$/i.test(v)) return 'Off';
  return v;
}

export function parseAudioInfoHtml(html = '') {
  const out = [];
  const src = String(html || '');
  if (!src) return out;

  let section = 'General';
  const tokenRe = /<div\s+class="h5">([\s\S]*?)<\/div>|<li[^>]*>[\s\S]*?<\/li>/gi;
  let match;
  while ((match = tokenRe.exec(src))) {
    if (match[1] != null) {
      section = decodeEntities(stripTags(match[1])) || section;
      continue;
    }
    const li = match[0] || '';
    const left = li.match(/<span\s+class="left">([\s\S]*?)<\/span>/i);
    const right = li.match(/<span\s+class="right">([\s\S]*?)<\/span>/i);
    if (!left || !right) continue;
    const key = decodeEntities(stripTags(left[1] || ''));
    const value = normalizeValue(key, decodeEntities(stripTags(right[1] || '')));
    if (!key) continue;
    out.push({ section, key, value });
  }
  return out;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseKeyValueLines(lines = []) {
  const out = {};
  for (const line of lines) {
    const raw = text(line);
    const separator = raw.indexOf(':');
    if (separator <= 0) continue;
    const key = raw.slice(0, separator).trim().toLowerCase();
    const value = raw.slice(separator + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function sampleRateFromValue(value) {
  const match = text(value).match(/\b(\d{4,6})\b/);
  return match ? positiveInt(match[1]) : null;
}

function bitDepthFromFormat(value) {
  const match = text(value).match(/\bS(8|16|24|32|64)_(?:LE|BE)\b/i);
  return match ? positiveInt(match[1]) : null;
}

const LOSSY_AUDIO_CODECS = new Set([
  'aac', 'ac3', 'amr_nb', 'amr_wb', 'eac3', 'mp2', 'mp3', 'nellymoser',
  'opus', 'vorbis', 'speex', 'wmav1', 'wmav2', 'wmavoice',
]);

const LOSSLESS_AUDIO_CODECS = new Set([
  'alac', 'ape', 'flac', 'mlp', 'tta', 'tak', 'truehd', 'wavpack',
]);

function normalizeCodecToken(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
}

function audioCodecKind(value) {
  const codec = normalizeCodecToken(value);
  if (!codec) return 'unknown';
  if (codec.startsWith('pcm_') || LOSSLESS_AUDIO_CODECS.has(codec)) return 'lossless';
  if (LOSSY_AUDIO_CODECS.has(codec) || codec.startsWith('aac')) return 'lossy';
  return 'unknown';
}

function parseBitrateBps(value) {
  const match = text(value).match(/\b(\d+(?:\.\d+)?)\s*(bps|kbps|mbps)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'mbps' ? 1_000_000 : unit === 'kbps' ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function containerFromFormat(value) {
  const match = text(value).match(/\b(M4A|MP4|FLAC|WAV|AIFF|AIF|OGG|OPUS|DSF|DFF|WV)\b/i);
  if (!match) return '';
  return match[1].toUpperCase() === 'AIF' ? 'AIFF' : match[1].toUpperCase();
}

function nominalPcmBitrateBps({ sampleRateHz, bitDepth, channels } = {}) {
  const rate = positiveInt(sampleRateHz);
  const depth = positiveInt(bitDepth);
  const count = positiveInt(channels);
  if (!rate || !depth || !count) return null;
  return rate * depth * count;
}

function stateRank(state = '') {
  const normalized = text(state).toLowerCase();
  if (normalized === 'running') return 4;
  if (normalized === 'paused') return 3;
  if (normalized === 'prepared') return 2;
  if (normalized === 'open') return 1;
  return 0;
}

export function normalizeAlsaHardwareProbe(raw = '') {
  const cards = new Map();
  const devices = new Map();

  for (const line of String(raw || '').split(/\r?\n/)) {
    const fields = line.split('\t');
    const kind = text(fields.shift()).toUpperCase();
    if (!kind) continue;

    if (kind === 'CARD') {
      const card = text(fields[0]);
      if (card) cards.set(card, { card, id: text(fields[1]) });
      continue;
    }

    if (kind === 'PCM') {
      const path = text(fields[0]);
      if (!path) continue;
      devices.set(path, {
        path,
        card: text(fields[1]),
        cardId: text(fields[2]),
        name: text(fields[3]),
        state: text(fields[4]).toLowerCase(),
        hw: [],
        status: [],
      });
      continue;
    }

    const path = text(fields[0]);
    const lineValue = fields.slice(1).join('\t');
    const device = devices.get(path);
    if (!device) continue;
    if (kind === 'HW') device.hw.push(lineValue);
    if (kind === 'STATUS') device.status.push(lineValue);
  }

  const normalizedDevices = Array.from(devices.values()).map((device) => {
    const hw = parseKeyValueLines(device.hw);
    const status = parseKeyValueLines(device.status);
    const state = text(status.state || device.state).toLowerCase() || 'unknown';
    const sampleRateHz = sampleRateFromValue(hw.rate);
    const channels = positiveInt(hw.channels);
    const bitDepth = bitDepthFromFormat(hw.format);
    return {
      ...device,
      cardLabel: cards.get(device.card)?.id || device.cardId || device.card,
      state,
      stateRank: stateRank(state),
      format: text(hw.format),
      sampleRateHz,
      channels,
      bitDepth,
      measured: !!(sampleRateHz && channels && text(hw.format)),
    };
  });

  const activeDevice = normalizedDevices
    .filter((device) => device.stateRank > 0)
    .sort((a, b) => b.stateRank - a.stateRank)[0] || null;

  return {
    available: true,
    devices: normalizedDevices,
    activeDevice,
    state: activeDevice?.state || 'not-open',
  };
}

function rateLabel(sampleRateHz) {
  const rate = positiveInt(sampleRateHz);
  if (!rate) return '';
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

function sampleRateHzFromFormat(value) {
  const raw = text(value);
  const match = raw.match(/\b(?:\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*kHz\b/i)
    || raw.match(/\b(\d+(?:\.\d+)?)\s*kHz\b/i);
  if (!match) return null;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) : null;
}

export function parseAudioFormatDetails(value = '') {
  const raw = text(value);
  const usable = raw && !/^(?:not playing|unknown|—)$/i.test(raw);
  if (!usable) {
    return {
      format: 'Unknown',
      codec: '',
      bitDepth: null,
      sampleRateHz: null,
      channels: null,
    };
  }

  const codec = raw.match(/\b(FLAC|PCM|DSD|MP3|AAC|ALAC|OPUS|VORBIS|WAVPACK|APE|TTA|TAK|AC-?3|E-?AC-?3|DTS|TRUEHD)\b/i)?.[1] || '';
  const bitDepthMatch = raw.match(/\bS(8|16|24|32|64)_(?:LE|BE)\b/i)
    || raw.match(/\b(8|16|24|32|64)\s*bit\b/i)
    || raw.match(/\b(8|16|24|32|64)\s*\/\s*\d/i);
  const channelsMatch = raw.match(/\b(\d+)\s*ch(?:annels?)?\b/i);
  const channels = channelsMatch
    ? positiveInt(channelsMatch[1])
    : (/\bstereo\b/i.test(raw) ? 2 : (/\bmono\b/i.test(raw) ? 1 : null));

  return {
    format: raw,
    codec: text(codec).toUpperCase(),
    bitDepth: bitDepthMatch ? positiveInt(bitDepthMatch[1]) : null,
    sampleRateHz: sampleRateHzFromFormat(raw),
    channels,
  };
}

export function parseAudioFormatMetadata(value = '') {
  const details = parseAudioFormatDetails(value);
  return {
    ...details,
    container: containerFromFormat(value),
    reportedBitrateBps: parseBitrateBps(value),
    codecKind: audioCodecKind(details.codec),
  };
}

export function formatAlsaHardwareOutput(probe) {
  const device = probe?.activeDevice || null;
  const state = text(probe?.state || device?.state).toLowerCase() || 'not-measured';
  const deviceLabel = device
    ? [device.cardLabel || device.cardId || device.card, device.name].filter(Boolean).join(' / ')
    : '';

  if (!device || !device.measured) {
    return {
      value: 'Not measured',
      measured: false,
      state,
      device: deviceLabel,
      format: '',
      sampleRateHz: device?.sampleRateHz || null,
      bitDepth: device?.bitDepth || null,
      channels: device?.channels || null,
      provenance: 'alsa-procfs',
      reason: state === 'not-open' ? 'No open ALSA playback stream was observed' : 'ALSA parameters were unavailable',
    };
  }

  const details = [
    'PCM',
    device.format,
    rateLabel(device.sampleRateHz),
    device.channels ? `${device.channels}ch` : '',
  ].filter(Boolean);

  return {
    value: details.join(' '),
    measured: true,
    state,
    device: deviceLabel,
    format: device.format,
    sampleRateHz: device.sampleRateHz,
    bitDepth: device.bitDepth,
    channels: device.channels,
    provenance: 'alsa-procfs',
    reason: 'Read from the active ALSA playback hw_params/status files',
  };
}

function rowValue(rows, key, section = '') {
  const match = rows.find((row) => (
    String(row?.key || '').trim().toLowerCase() === String(key || '').trim().toLowerCase()
      && (!section || String(row?.section || '').trim() === section)
  ));
  return text(match?.value);
}

function configuredAlsaMode(value) {
  const cleaned = text(value).replace(/[()]/g, '').trim();
  return cleaned && cleaned !== '—' ? cleaned : '';
}

function configuredDspLevel(value) {
  const match = text(value).split(',').map((part) => part.trim()).find((part) => /^cdsp\b/i.test(part));
  return match || '';
}

function setRow(rows, section, key, value, metadata = {}) {
  const index = rows.findIndex((row) => (
    String(row?.section || '').trim() === section
      && String(row?.key || '').trim().toLowerCase() === String(key || '').trim().toLowerCase()
  ));
  const next = { section, key, value, ...metadata };
  if (index >= 0) rows[index] = next;
  else rows.push(next);
}

function withConfiguredLabel(value) {
  const normalized = text(value);
  if (!normalized || normalized === '—') return 'Unknown';
  if (/\(configured\b/i.test(normalized)) return normalized;
  return `${normalized} (configured; live Qobuz effect not measured)`;
}

function formatDetailObject(format, details = {}, provenance, valueType) {
  const parsed = parseAudioFormatDetails(format);
  return {
    format: parsed.format,
    codec: text(details?.codec) || parsed.codec,
    bitDepth: details?.bitDepth == null ? parsed.bitDepth : positiveInt(details.bitDepth),
    sampleRateHz: details?.sampleRateHz == null ? parsed.sampleRateHz : positiveInt(details.sampleRateHz),
    channels: details?.channels == null ? parsed.channels : positiveInt(details.channels),
    provenance,
    valueType,
    live: true,
    measured: false,
  };
}

function configuredDiagnosticValue(value) {
  const normalized = text(value);
  return normalized && normalized !== '—' ? normalized : 'Unknown';
}

function reportedFormatDetail(format, details, provenance, valueType) {
  return {
    ...formatDetailObject(format, details, provenance, valueType),
    configured: false,
  };
}

/**
 * moOde appends MPD's bitrate field to the legacy `Decoded to` row. For a
 * lossy source that value is the encoded stream bitrate, not decoded PCM
 * throughput. Keep the legacy row untouched unless the diagnostics view has
 * verified a lossy source; the normalized sourceFile/decodedAudio fields are
 * the authoritative locations for the two separate values.
 */
export function normalizeLegacyAudioInfoRows(rows = [], { sourceFile = null } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (text(sourceFile?.codecKind).toLowerCase() !== 'lossy') return input;

  return input.map((row) => {
    const section = text(row?.section);
    const key = text(row?.key);
    if (!/^input \/ output$/i.test(section) || !/^decoded to$/i.test(key)) return row;

    const value = text(row?.value);
    const corrected = value.replace(/,\s*\d+(?:\.\d+)?\s*(?:k|m)bps\s*$/i, '').trim();
    if (!corrected || corrected === value) return row;

    return {
      ...row,
      value: corrected,
      provenance: text(row?.provenance) || 'moode-audioinfo.php:mpd-decoder-fields',
      valueType: text(row?.valueType) || 'decoded-reported',
      live: typeof row?.live === 'boolean' ? row.live : true,
      measured: false,
    };
  });
}

function buildSourceFileMetadata({
  sourceFormat,
  decodedFormat,
  sourceAudio,
  qobuzActive,
  qobuz,
} = {}) {
  const parsedSource = parseAudioFormatMetadata(sourceFormat);
  const parsedDecoded = parseAudioFormatMetadata(decodedFormat);
  const probe = sourceAudio && typeof sourceAudio === 'object' && !Array.isArray(sourceAudio)
    ? sourceAudio
    : null;
  const reportedDetails = qobuzActive && qobuz?.sourceFormatDetails
    ? qobuz.sourceFormatDetails
    : {};
  const probedCodec = text(probe?.codec);
  const codec = probedCodec || text(reportedDetails.codec) || parsedSource.codec;
  const codecKind = text(probe?.codecKind) || audioCodecKind(codec);
  const codecStatus = text(probe?.codecStatus) || (probedCodec ? 'verified' : (codec ? 'reported' : 'unavailable'));
  const bitDepth = positiveInt(probe?.bitDepth)
    || (codecKind === 'lossless'
      ? positiveInt(reportedDetails.bitDepth) || positiveInt(parsedSource.bitDepth)
      : null);
  const bitDepthStatus = text(probe?.bitDepthStatus)
    || (bitDepth ? 'reported' : (codecKind === 'lossy' ? 'not-applicable' : 'unavailable'));
  const encodedBitrateBps = positiveInt(probe?.encodedBitrateBps)
    || (codecKind === 'lossy' ? parsedSource.reportedBitrateBps || parsedDecoded.reportedBitrateBps : null);
  const encodedBitrateProvenance = text(probe?.encodedBitrateProvenance)
    || (encodedBitrateBps
      ? (qobuzActive ? 'pibuz-qobuz-metadata' : 'moode-audioinfo.php:mpd-status-bitrate')
      : '');
  const provenance = text(probe?.provenance)
    || (probe
      ? 'ffprobe.source-file'
      : (qobuzActive ? 'pibuz-qobuz-metadata' : 'moode-audioinfo.php'));
  const valueType = text(probe?.valueType)
    || (qobuzActive ? 'source-reported' : 'source-file');
  const verified = typeof probe?.verified === 'boolean'
    ? probe.verified
    : Boolean(probe && (probedCodec || probe?.container || probe?.bitDepthStatus === 'verified'));

  return {
    format: text(probe?.format) || text(sourceFormat) || 'Unknown',
    container: text(probe?.container) || parsedSource.container || 'Unknown',
    codec: codec || 'Unknown',
    codecStatus,
    codecKind,
    bitDepth,
    bitDepthStatus,
    bitDepthKind: text(probe?.bitDepthKind) || (bitDepth ? 'integer' : null),
    sampleRateHz: positiveInt(probe?.sampleRateHz)
      || positiveInt(reportedDetails.sampleRateHz)
      || parsedSource.sampleRateHz,
    channels: positiveInt(probe?.channels)
      || positiveInt(reportedDetails.channels)
      || parsedSource.channels,
    encodedBitrateBps,
    encodedBitrateKbps: encodedBitrateBps ? Math.round(encodedBitrateBps / 1000) : null,
    encodedBitrateStatus: encodedBitrateBps
      ? (text(probe?.encodedBitrateStatus) || 'reported')
      : 'unavailable',
    encodedBitrateProvenance: encodedBitrateProvenance || null,
    provenance,
    valueType,
    live: typeof probe?.live === 'boolean' ? probe.live : true,
    measured: typeof probe?.measured === 'boolean' ? probe.measured : false,
    verified,
    configured: false,
  };
}

function buildDecodedAudioMetadata({ decodedFormat, qobuzActive, qobuz } = {}) {
  const parsed = parseAudioFormatMetadata(decodedFormat);
  const reportedDetails = qobuzActive && qobuz?.outputFormatDetails
    ? qobuz.outputFormatDetails
    : {};
  const codec = text(reportedDetails.codec) || parsed.codec || (/^PCM\b/i.test(parsed.format) ? 'PCM' : '');
  const isPcm = /^PCM$/i.test(codec) || /^PCM\b/i.test(parsed.format);
  const bitDepth = positiveInt(reportedDetails.bitDepth) || parsed.bitDepth;
  const sampleRateHz = positiveInt(reportedDetails.sampleRateHz) || parsed.sampleRateHz;
  const channels = positiveInt(reportedDetails.channels) || parsed.channels;
  const pcmBitrateBps = isPcm ? nominalPcmBitrateBps({ sampleRateHz, bitDepth, channels }) : null;
  const bitDepthKind = /\bfloat\b/i.test(parsed.format)
    ? 'float'
    : /\bS(?:8|16|24|32|64)_(?:LE|BE)\b/i.test(parsed.format) ? 'integer' : null;

  return {
    format: isPcm ? 'PCM' : (parsed.format || 'Unknown'),
    codec: codec || 'Unknown',
    bitDepth,
    bitDepthKind,
    sampleRateHz,
    channels,
    pcmBitrateBps,
    pcmBitrateStatus: pcmBitrateBps ? 'calculated' : 'unavailable',
    provenance: qobuzActive ? 'pibuz-qobuz-metadata' : 'moode-audioinfo.php',
    valueType: 'decoded-reported',
    live: true,
    measured: false,
    configured: false,
  };
}

function buildOutputMetadata({ hardwareOutput, activeDevice, capturedAt } = {}) {
  const measured = Boolean(hardwareOutput?.measured);
  return {
    value: hardwareOutput?.value || 'Not measured',
    state: hardwareOutput?.state || 'unknown',
    device: hardwareOutput?.device || null,
    interface: text(activeDevice?.name) || null,
    card: text(activeDevice?.cardLabel || activeDevice?.cardId || activeDevice?.card) || null,
    format: hardwareOutput?.format || null,
    bitDepth: hardwareOutput?.bitDepth || null,
    sampleRateHz: hardwareOutput?.sampleRateHz || null,
    channels: hardwareOutput?.channels || null,
    provenance: hardwareOutput?.provenance || 'alsa-procfs',
    valueType: measured ? 'hardware-measured' : 'unavailable',
    live: true,
    measured,
    configured: false,
    measuredAt: measured ? capturedAt : null,
    reason: hardwareOutput?.reason || null,
  };
}

export function buildAudioInfoDiagnostics({
  moodeRows = [],
  alsa = null,
  qobuz = null,
  sourceAudio = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const rows = Array.isArray(moodeRows) ? moodeRows : [];
  const qobuzActive = Boolean(qobuz?.active);
  const sourceFormat = qobuzActive
    ? text(qobuz?.sourceFormat)
    : rowValue(rows, 'Source format', 'Input / Output');
  const decodedFormat = qobuzActive
    ? text(qobuz?.outputFormat)
    : rowValue(rows, 'Decoded to', 'Input / Output');
  const formatProvenance = qobuzActive ? 'pibuz-qobuz-metadata' : 'moode-audioinfo.php';
  const sourceValueType = 'source-reported';
  const decodedValueType = 'decoded-reported';
  const hardwareOutput = formatAlsaHardwareOutput(alsa);
  const activeDevice = alsa?.activeDevice || null;
  const measured = Boolean(hardwareOutput.measured);
  const sourceFile = buildSourceFileMetadata({
    sourceFormat,
    decodedFormat,
    sourceAudio,
    qobuzActive,
    qobuz,
  });
  const decodedAudio = buildDecodedAudioMetadata({ decodedFormat, qobuzActive, qobuz });
  const legacySourceFormat = reportedFormatDetail(
    sourceFormat,
    qobuzActive ? qobuz?.sourceFormatDetails : null,
    formatProvenance,
    sourceValueType,
  );
  if (sourceFile.codecKind === 'lossy') legacySourceFormat.bitDepth = null;
  const configuredOutput = {
    alsaMode: configuredAlsaMode(rowValue(rows, 'ALSA mode', 'Input / Output')) || 'Unknown',
    audioChain: configuredDiagnosticValue(rowValue(rows, 'Audio chain', 'Input / Output')),
    provenance: 'moode-audioinfo.php',
    valueType: 'configured',
    live: false,
    measured: false,
    configured: true,
  };
  const processing = {
    resampling: configuredDiagnosticValue(rowValue(rows, 'Resampling', 'DSP operations')),
    quality: configuredDiagnosticValue(rowValue(rows, 'Quality', 'DSP operations')),
    selective: configuredDiagnosticValue(rowValue(rows, 'Selective', 'DSP operations')),
    polarityInversion: configuredDiagnosticValue(rowValue(rows, 'Polarity invert', 'DSP operations')),
    crossfade: configuredDiagnosticValue(rowValue(rows, 'Crossfade', 'DSP operations')),
    crossfeed: configuredDiagnosticValue(rowValue(rows, 'Crossfeed', 'DSP operations')),
    parametricEq: configuredDiagnosticValue(rowValue(rows, 'Parametric EQ', 'DSP operations')),
    graphicEq: configuredDiagnosticValue(rowValue(rows, 'Graphic EQ', 'DSP operations')),
    camillaDsp: configuredDiagnosticValue(rowValue(rows, 'CamillaDSP', 'DSP operations')),
    replayGain: configuredDiagnosticValue(rowValue(rows, 'Replaygain', 'DSP operations')),
    normalization: configuredDiagnosticValue(rowValue(rows, 'Normalize vol', 'DSP operations')),
    chipOptions: configuredDiagnosticValue(rowValue(rows, 'Chip options', 'DSP operations')),
    provenance: 'moode-audioinfo.php',
    valueType: 'configured',
    live: false,
    measured: false,
    configured: true,
  };
  const volume = {
    type: configuredDiagnosticValue(rowValue(rows, 'Volume type', 'DSP operations')),
    levels: configuredDiagnosticValue(rowValue(rows, 'Volume levels', 'DSP operations')),
    provenance: 'moode-audioinfo.php',
    valueType: 'configured',
    live: false,
    measured: false,
    configured: true,
  };

  return {
    version: 'audio-info.v1',
    capturedAt,
    freshness: {
      mode: 'on-demand',
      capturedAt,
      hardwareMeasuredAt: measured ? capturedAt : null,
    },
    renderer: qobuzActive ? 'qobuz-connect' : 'mpd',
    sourceFormat: legacySourceFormat,
    decodedPcm: reportedFormatDetail(
      decodedFormat,
      qobuzActive ? qobuz?.outputFormatDetails : null,
      formatProvenance,
      decodedValueType,
    ),
    sourceFile,
    decodedAudio,
    configuredOutput,
    hardwareOutput: buildOutputMetadata({ hardwareOutput, activeDevice, capturedAt }),
    output: buildOutputMetadata({ hardwareOutput, activeDevice, capturedAt }),
    processing,
    volume,
    conversion: {
      status: 'unknown',
      reason: 'Read-only ALSA hw_params reports the negotiated endpoint format, not every transformation before it',
      provenance: 'alsa-procfs+moode-audioinfo.php',
      valueType: 'not-measured',
      live: false,
      measured: false,
      configured: false,
    },
  };
}

export function buildQobuzAudioInfo({ moodeRows = [], qobuz = {}, alsa = null } = {}) {
  const rows = (Array.isArray(moodeRows) ? moodeRows : []).map((row) => ({ ...row }));
  const sourceFormat = text(qobuz?.sourceFormat) || 'Unknown';
  const decodedFormat = text(qobuz?.outputFormat) || 'Unknown';
  const sourceDetails = qobuz?.sourceFormatDetails || {};
  const decodedDetails = qobuz?.outputFormatDetails || {};
  const hardwareOutput = formatAlsaHardwareOutput(alsa);
  const alsaMode = configuredAlsaMode(rowValue(rows, 'ALSA mode', 'Input / Output'));
  const configuredChain = rowValue(rows, 'Audio chain', 'Input / Output');
  const configuredVolumeLevels = rowValue(rows, 'Volume levels', 'DSP operations');
  const dspLevel = configuredDspLevel(configuredVolumeLevels);
  const state = text(qobuz?.state).toLowerCase() || 'unknown';

  setRow(rows, 'Input / Output', 'Source', 'Qobuz stream (Pibuz renderer)', {
    provenance: 'pibuz-qobuz-metadata', valueType: 'source-reported', live: true, measured: false,
  });
  setRow(rows, 'Input / Output', 'Source format', sourceFormat, {
    provenance: 'pibuz-qobuz-metadata', valueType: 'source-reported', live: true, measured: false,
  });
  setRow(rows, 'Input / Output', 'Decoded to', decodedFormat, {
    provenance: 'pibuz-qobuz-metadata', valueType: 'decoded-reported', live: true, measured: false,
  });
  setRow(rows, 'Input / Output', 'Output format', hardwareOutput.value, {
    provenance: hardwareOutput.provenance, valueType: 'hardware-measured', live: true, measured: hardwareOutput.measured,
  });
  setRow(rows, 'Input / Output', 'ALSA mode', alsaMode
    ? `${alsaMode} (configured; live Qobuz renderer mode not measured)`
    : 'Unknown', {
    provenance: 'moode-audioinfo.php', valueType: 'configured', live: false, measured: false, configured: true,
  });
  setRow(rows, 'Input / Output', 'Audio chain', configuredChain && configuredChain !== '—'
    ? `${configuredChain} (configured moOde/MPD path; live Qobuz path not measured)`
    : 'Unknown', {
    provenance: 'moode-audioinfo.php', valueType: 'configured', live: false, measured: false, configured: true,
  });

  for (const key of ['Resampling', 'Quality', 'Selective', 'Polarity invert', 'Crossfade', 'Crossfeed', 'Parametric EQ', 'Graphic EQ', 'CamillaDSP', 'Replaygain', 'Normalize vol', 'Chip options']) {
    const value = rowValue(rows, key, 'DSP operations');
    if (value && value !== '—') {
      setRow(rows, 'DSP operations', key, withConfiguredLabel(value), {
        provenance: 'moode-audioinfo.php', valueType: 'configured', live: false, measured: false, configured: true,
      });
    }
  }

  setRow(rows, 'DSP operations', 'Volume type', 'Unavailable (MPD-only diagnostic; Qobuz/Pibuz volume is not exposed)', {
    provenance: 'mpd-only', valueType: 'unavailable', live: false, measured: false, configured: false,
  });
  setRow(rows, 'DSP operations', 'Volume levels', dspLevel
    ? `Configured DSP: ${dspLevel}; MPD/ALSA mixer unavailable`
    : 'Unavailable (MPD-only diagnostic)', {
    provenance: 'mpd-only', valueType: 'unavailable', live: false, measured: false, configured: false,
  });

  setRow(rows, 'Evidence', 'Playback source', 'Qobuz Connect / Pibuz', {
    provenance: 'pibuz-qobuz-metadata', valueType: 'source-reported', live: true, measured: false,
  });
  setRow(rows, 'Evidence', 'Renderer state', state, {
    provenance: 'pibuz-qobuz-metadata', valueType: 'source-reported', live: true, measured: false,
  });
  setRow(rows, 'Evidence', 'Hardware playback state', hardwareOutput.state || 'Unknown', {
    provenance: hardwareOutput.provenance, valueType: 'hardware-observed', live: true, measured: hardwareOutput.measured,
  });
  setRow(rows, 'Evidence', 'Hardware device', hardwareOutput.device || 'Unknown', {
    provenance: hardwareOutput.provenance, valueType: 'hardware-observed', live: true, measured: !!hardwareOutput.device,
  });
  setRow(rows, 'Evidence', 'ALSA conversion', 'Unknown (read-only hw_params cannot establish conversion)', {
    provenance: 'alsa-procfs', valueType: 'unavailable', live: true, measured: false,
  });

  return {
    rows,
    audio: {
      sourceFormat: formatDetailObject(sourceFormat, sourceDetails, 'pibuz-qobuz-metadata', 'source-reported'),
      decodedPcm: formatDetailObject(decodedFormat, decodedDetails, 'pibuz-qobuz-metadata', 'decoded-reported'),
      hardwareOutput: {
        ...hardwareOutput,
        conversion: 'Unknown',
      },
      configuredOutput: {
        alsaMode: alsaMode || 'Unknown',
        audioChain: configuredChain && configuredChain !== '—' ? configuredChain : 'Unknown',
        provenance: 'moode-audioinfo.php',
        valueType: 'configured',
        live: false,
        measured: false,
      },
      volume: {
        type: 'Unavailable',
        levels: dspLevel ? `Configured DSP: ${dspLevel}` : 'Unavailable',
        reason: 'MPD-only volume diagnostics do not apply to the Qobuz/Pibuz renderer',
        provenance: 'mpd-only',
        valueType: 'unavailable',
        live: false,
        measured: false,
      },
    },
  };
}

