import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAudioInfoDiagnostics,
  buildQobuzAudioInfo,
  formatAlsaHardwareOutput,
  normalizeAlsaHardwareProbe,
  normalizeLegacyAudioInfoRows,
  parseAudioFormatDetails,
  parseAudioFormatMetadata,
  parseAudioInfoHtml,
} from '../src/lib/audio-info.mjs';
import { registerConfigMoodeAudioInfoRoutes } from '../src/routes/config.moode-audio-info.routes.mjs';

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

const moodeHtml = `
<div class="h5">Input / Output</div>
<li><span class="left">Source</span><span class="right">old.mp3</span></li>
<li><span class="left">Source format</span><span class="right">FLAC 24 bit 44.1 kHz, Stereo</span></li>
<li><span class="left">Decoded to</span><span class="right">Not playing</span></li>
<li><span class="left">Output format</span><span class="right">Not playing</span></li>
<li><span class="left">ALSA mode</span><span class="right"> (plughw)</span></li>
<li><span class="left">Audio chain</span><span class="right">inputCrossfeed &rarr; plughw &rarr; Device</span></li>
<div class="h5">DSP operations</div>
<li><span class="left">Resampling</span><span class="right">Off</span></li>
<li><span class="left">Crossfeed</span><span class="right"> Hz  dB</span></li>
<li><span class="left">Volume type</span><span class="right">Error: Unknow MPD volume type</span></li>
<li><span class="left">Volume levels</span><span class="right">Knob, ALSA Wrong scontrol identifier:, CDSP 0dB</span></li>
`;

const normalMoodeHtml = `
<div class="h5">Input / Output</div>
<li><span class="left">Source</span><span class="right">USB/SamsungMoode/Album/01 - Track.flac</span></li>
<li><span class="left">Source format</span><span class="right">FLAC 24 bit 96 kHz, Stereo</span></li>
<li><span class="left">Decoded to</span><span class="right">PCM 24 bit 96 kHz, Stereo, 4.608 Mbps</span></li>
<li><span class="left">Output format</span><span class="right">PCM 32 bit 96 kHz, Stereo, 6.144 Mbps</span></li>
<li><span class="left">ALSA mode</span><span class="right">(plughw)</span></li>
<li><span class="left">Audio chain</span><span class="right">MPD &rarr; plughw &rarr; Device</span></li>
<div class="h5">DSP operations</div>
<li><span class="left">Resampling</span><span class="right">Off</span></li>
<li><span class="left">Quality</span><span class="right">Off</span></li>
<li><span class="left">Selective</span><span class="right">Off</span></li>
<li><span class="left">Polarity invert</span><span class="right">Off</span></li>
<li><span class="left">Crossfade</span><span class="right">Off</span></li>
<li><span class="left">Crossfeed</span><span class="right">Off</span></li>
<li><span class="left">Parametric EQ</span><span class="right">Off</span></li>
<li><span class="left">Graphic EQ</span><span class="right">Off</span></li>
<li><span class="left">CamillaDSP</span><span class="right">Off</span></li>
<li><span class="left">Replaygain</span><span class="right">off</span></li>
<li><span class="left">Normalize vol</span><span class="right">off</span></li>
<li><span class="left">Volume type</span><span class="right">Fixed (0dB output)</span></li>
<li><span class="left">Volume levels</span><span class="right">Knob 0, ALSA none, CDSP 0dB</span></li>
`;

const lossyMoodeHtml = `
<div class="h5">Input / Output</div>
<li><span class="left">Source</span><span class="right">USB/SamsungMoode/Album/01 - Track.m4a</span></li>
<li><span class="left">Source format</span><span class="right">M4A 44.1 kHz, Stereo</span></li>
<li><span class="left">Decoded to</span><span class="right">PCM 24 bit 44.1 kHz, Stereo, 270 kbps</span></li>
<li><span class="left">Output format</span><span class="right">PCM 32 bit 44.1 kHz, Stereo, 2.822 Mbps</span></li>
<li><span class="left">ALSA mode</span><span class="right">(plughw)</span></li>
<li><span class="left">Audio chain</span><span class="right">MPD &rarr; plughw &rarr; Device</span></li>
<div class="h5">DSP operations</div>
<li><span class="left">Resampling</span><span class="right">Off</span></li>
`;

const qobuz = {
  active: true,
  source: 'qobuz-connect',
  state: 'play',
  sourceFormat: 'FLAC 24/96 kHz',
  outputFormat: 'PCM 32/96 kHz, 2ch',
  sourceFormatDetails: { codec: 'FLAC', bitDepth: 24, sampleRateHz: 96000, channels: null },
  outputFormatDetails: { codec: 'PCM', bitDepth: 32, sampleRateHz: 96000, channels: 2 },
};

const alsaProbe = [
  'CARD\tcard2\tDAC',
  'PCM\t/proc/asound/card2/pcm0p\tcard2\tDAC\tUSB Audio\tRUNNING',
  'HW\t/proc/asound/card2/pcm0p\taccess: RW_INTERLEAVED',
  'HW\t/proc/asound/card2/pcm0p\tformat: S32_LE',
  'HW\t/proc/asound/card2/pcm0p\tchannels: 2',
  'HW\t/proc/asound/card2/pcm0p\trate: 96000 (96000/1)',
  'STATUS\t/proc/asound/card2/pcm0p\tstate: RUNNING',
].join('\n');

const alsa = normalizeAlsaHardwareProbe(alsaProbe);

const availableCollection = {
  session: { status: 'available' },
  rendererReport: { status: 'available' },
  mpd: { status: 'available' },
  alsa: { status: 'available' },
};

function snapshot({
  html = normalMoodeHtml,
  probe = alsaProbe,
  collection = availableCollection,
  mpd = {
    state: 'play',
    source: 'USB/SamsungMoode/Album/01 - Track.flac',
    decoded: { sampleRateHz: 96000, bitDepth: 24, bitDepthKind: 'integer', channels: 2 },
  },
} = {}) {
  return {
    capturedAt: '2026-10-30T13:16:01.000Z',
    audioInfoHtml: html,
    alsaProbe: probe,
    mpd,
    collection,
  };
}

test('Audio Info HTML parser preserves legacy moOde rows', () => {
  const rows = parseAudioInfoHtml(moodeHtml);
  assert.equal(rows.find((row) => row.key === 'Source')?.value, 'old.mp3');
  assert.equal(rows.find((row) => row.key === 'Audio chain')?.value, 'inputCrossfeed → plughw → Device');
  assert.equal(rows.find((row) => row.key === 'Crossfeed')?.value, 'Off');
});

test('ALSA probe parser reports measured hardware parameters independently of MPD', () => {
  assert.equal(alsa.activeDevice.state, 'running');
  assert.equal(alsa.activeDevice.format, 'S32_LE');
  assert.equal(alsa.activeDevice.sampleRateHz, 96000);
  assert.equal(alsa.activeDevice.channels, 2);
  assert.equal(alsa.activeDevice.measured, true);
  assert.deepEqual(formatAlsaHardwareOutput(alsa), {
    value: 'PCM S32_LE 96 kHz 2ch',
    measured: true,
    state: 'running',
    device: 'DAC / USB Audio',
    format: 'S32_LE',
    sampleRateHz: 96000,
    bitDepth: 32,
    channels: 2,
    provenance: 'alsa-procfs',
    reason: 'Read from the active ALSA playback hw_params/status files',
  });
});

test('Audio format parser separates source resolution from container details', () => {
  assert.deepEqual(parseAudioFormatDetails('FLAC 24 bit 96 kHz, Stereo'), {
    format: 'FLAC 24 bit 96 kHz, Stereo',
    codec: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    channels: 2,
  });
  assert.deepEqual(parseAudioFormatDetails('PCM S32_LE 96 kHz 2ch'), {
    format: 'PCM S32_LE 96 kHz 2ch',
    codec: 'PCM',
    bitDepth: 32,
    sampleRateHz: 96000,
    channels: 2,
  });
});

test('Audio format metadata parses container and reported bitrate without assigning bitrate to PCM', () => {
  assert.deepEqual(parseAudioFormatMetadata('M4A 44.1 kHz, Stereo'), {
    format: 'M4A 44.1 kHz, Stereo',
    codec: '',
    bitDepth: null,
    sampleRateHz: 44100,
    channels: 2,
    container: 'M4A',
    reportedBitrateBps: null,
    codecKind: 'unknown',
  });
  assert.equal(parseAudioFormatMetadata('PCM 24 bit 44.1 kHz, Stereo, 270 kbps').reportedBitrateBps, 270000);
  assert.equal(parseAudioFormatMetadata('PCM 24 bit 44.1 kHz, Stereo, 270 kbps').codecKind, 'unknown');
});

test('normal MPD diagnostics separate configured values from measured ALSA output', () => {
  const diagnostics = buildAudioInfoDiagnostics({
    moodeRows: parseAudioInfoHtml(normalMoodeHtml),
    alsa,
    capturedAt: '2026-10-15T18:00:00.000Z',
  });

  assert.equal(diagnostics.version, 'audio-info.v1');
  assert.equal(diagnostics.renderer, 'mpd');
  assert.equal(diagnostics.sourceFormat.bitDepth, 24);
  assert.equal(diagnostics.sourceFormat.sampleRateHz, 96000);
  assert.equal(diagnostics.decodedPcm.bitDepth, 24);
  assert.equal(diagnostics.sourceFile.container, 'FLAC');
  assert.equal(diagnostics.sourceFile.codec, 'FLAC');
  assert.equal(diagnostics.sourceFile.bitDepthStatus, 'reported');
  assert.equal(diagnostics.sourceFile.valueType, 'source-file');
  assert.equal(diagnostics.sourceFile.encodedBitrateBps, null);
  assert.equal(diagnostics.decodedAudio.format, 'PCM');
  assert.equal(diagnostics.decodedAudio.pcmBitrateBps, 4608000);
  assert.equal(diagnostics.configuredOutput.alsaMode, 'plughw');
  assert.equal(diagnostics.configuredOutput.measured, false);
  assert.equal(diagnostics.hardwareOutput.format, 'S32_LE');
  assert.equal(diagnostics.hardwareOutput.interface, 'USB Audio');
  assert.equal(diagnostics.hardwareOutput.sampleRateHz, 96000);
  assert.equal(diagnostics.hardwareOutput.measured, true);
  assert.equal(diagnostics.hardwareOutput.measuredAt, '2026-10-15T18:00:00.000Z');
  assert.equal(diagnostics.processing.polarityInversion, 'Off');
  assert.equal(diagnostics.processing.measured, false);
  assert.equal(diagnostics.volume.type, 'Fixed (0dB output)');
  assert.equal(diagnostics.conversion.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(diagnostics), /USB\/SamsungMoode|Track\.flac/);
});

test('lossy source metadata keeps encoded bitrate separate from decoded PCM precision', () => {
  const rows = parseAudioInfoHtml(`
<div class="h5">Input / Output</div>
<li><span class="left">Source</span><span class="right">USB/SamsungMoode/Album/01 - Track.m4a</span></li>
<li><span class="left">Source format</span><span class="right">M4A 44.1 kHz, Stereo</span></li>
<li><span class="left">Decoded to</span><span class="right">PCM 24 bit 44.1 kHz, Stereo, 270 kbps</span></li>
<li><span class="left">Output format</span><span class="right">PCM 32 bit 96 kHz, Stereo, 6.144 Mbps</span></li>`);
  const diagnostics = buildAudioInfoDiagnostics({
    moodeRows: rows,
    sourceAudio: {
      codec: 'AAC-LC',
      codecKind: 'lossy',
      container: 'M4A',
      sampleRateHz: 44100,
      channels: 2,
      encodedBitrateBps: 270000,
      encodedBitrateStatus: 'reported',
      encodedBitrateProvenance: 'ffprobe.stream',
      bitDepthStatus: 'not-applicable',
    },
    alsa,
  });

  assert.equal(diagnostics.sourceFile.container, 'M4A');
  assert.equal(diagnostics.sourceFile.codec, 'AAC-LC');
  assert.equal(diagnostics.sourceFile.codecStatus, 'verified');
  assert.equal(diagnostics.sourceFile.bitDepth, null);
  assert.equal(diagnostics.sourceFile.bitDepthStatus, 'not-applicable');
  assert.equal(diagnostics.sourceFile.encodedBitrateBps, 270000);
  assert.equal(diagnostics.decodedAudio.bitDepth, 24);
  assert.equal(diagnostics.decodedAudio.bitDepthKind, null);
  assert.equal(diagnostics.decodedAudio.pcmBitrateBps, 2116800);
  assert.equal(diagnostics.hardwareOutput.sampleRateHz, 96000);
  assert.equal(diagnostics.sourceFormat.bitDepth, null);
});

test('lossy diagnostics remove encoded bitrate from the legacy decoded row', () => {
  const rows = parseAudioInfoHtml(lossyMoodeHtml);
  const sourceFile = { codec: 'AAC-LC', codecKind: 'lossy' };
  const corrected = normalizeLegacyAudioInfoRows(rows, { sourceFile });
  const decoded = corrected.find((row) => row.key === 'Decoded to');

  assert.equal(decoded.value, 'PCM 24 bit 44.1 kHz, Stereo');
  assert.equal(decoded.provenance, 'moode-audioinfo.php:mpd-decoder-fields');
  assert.equal(decoded.valueType, 'decoded-reported');
  assert.equal(decoded.measured, false);
  assert.equal(
    normalizeLegacyAudioInfoRows(rows, { sourceFile: { codecKind: 'lossless' } })
      .find((row) => row.key === 'Decoded to').value,
    'PCM 24 bit 44.1 kHz, Stereo, 270 kbps',
  );
});

test('Qobuz Audio Info separates reported formats, configured path, and measured output', () => {
  const built = buildQobuzAudioInfo({ moodeRows: parseAudioInfoHtml(moodeHtml), qobuz, alsa });
  const row = (section, key) => built.rows.find((item) => item.section === section && item.key === key);

  assert.equal(row('Input / Output', 'Source').value, 'Qobuz stream (Pibuz renderer)');
  assert.equal(row('Input / Output', 'Source format').value, 'FLAC 24/96 kHz');
  assert.equal(row('Input / Output', 'Decoded to').value, 'PCM 32/96 kHz, 2ch');
  assert.equal(row('Input / Output', 'Output format').value, 'PCM S32_LE 96 kHz 2ch');
  assert.match(row('Input / Output', 'Audio chain').value, /configured moOde\/MPD path/);
  assert.match(row('DSP operations', 'Volume type').value, /Unavailable/);
  assert.doesNotMatch(JSON.stringify(built.rows), /Unknow MPD|Wrong scontrol/);
  assert.equal(built.audio.sourceFormat.format, 'FLAC 24/96 kHz');
  assert.equal(built.audio.decodedPcm.bitDepth, 32);
  assert.equal(built.audio.hardwareOutput.measured, true);
  assert.equal(built.audio.hardwareOutput.conversion, 'Unknown');
});

test('Qobuz Audio Info does not claim hardware output when ALSA is closed', () => {
  const built = buildQobuzAudioInfo({
    moodeRows: parseAudioInfoHtml(moodeHtml),
    qobuz,
    alsa: { available: true, devices: [], activeDevice: null, state: 'not-open' },
  });
  const output = built.rows.find((row) => row.section === 'Input / Output' && row.key === 'Output format');
  assert.equal(output.value, 'Not measured');
  assert.equal(output.measured, false);
  assert.match(built.rows.find((row) => row.key === 'Hardware playback state').value, /not-open/);
});

test('Audio Info route adds Qobuz diagnostics from the bounded snapshot', async () => {
  const app = createApp();
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => qobuz,
    readMoodeAudioInfoSnapshot: async () => snapshot({ html: moodeHtml }),
  });

  const response = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.playback.source, 'qobuz-connect');
  assert.equal(response.body.audio.sourceFormat.provenance, 'pibuz-qobuz-metadata');
  assert.equal(response.body.rows.find((row) => row.key === 'Output format').value, 'PCM S32_LE 96 kHz 2ch');
  assert.equal(response.body.sections, undefined);
  assert.equal(response.body.rows.find((row) => row.key === 'Session-backed moOde report').value, 'Available');
});

test('Audio Info route uses one session-backed snapshot for normal MPD diagnostics', async () => {
  const app = createApp();
  let snapshotCount = 0;
  let sourceProbeInput = '';
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => {
      snapshotCount += 1;
      return snapshot();
    },
    getSourceAudio: async (file) => {
      sourceProbeInput = file;
      return {
        codec: 'FLAC',
        codecKind: 'lossless',
        container: 'FLAC',
        bitDepth: 24,
        bitDepthStatus: 'verified',
        sampleRateHz: 96000,
        channels: 2,
      };
    },
  });

  const legacyResponse = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows' } }, legacyResponse);
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(legacyResponse.body.diagnostics, undefined);
  assert.equal(snapshotCount, 1);

  const diagnosticResponse = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({
    query: { view: 'rows', diagnostics: '1' },
  }, diagnosticResponse);
  assert.equal(diagnosticResponse.statusCode, 200);
  assert.equal(snapshotCount, 2);
  assert.equal(diagnosticResponse.body.diagnostics.version, 'audio-info.v1');
  assert.equal(diagnosticResponse.body.diagnostics.hardwareOutput.format, 'S32_LE');
  assert.equal(diagnosticResponse.body.diagnostics.sourceFile.bitDepthStatus, 'verified');
  assert.equal(diagnosticResponse.body.diagnostics.collection.rendererReport.status, 'available');
  assert.equal(sourceProbeInput, 'USB/SamsungMoode/Album/01 - Track.flac');
  assert.doesNotMatch(JSON.stringify(diagnosticResponse.body.diagnostics), /sessionid|PHPSESSID/i);
});

test('Audio Info diagnostics route verifies M4A codec and corrects only its user-facing legacy row', async () => {
  const app = createApp();
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => snapshot({ html: lossyMoodeHtml }),
    getSourceAudio: async () => ({
      codec: 'AAC-LC',
      codecKind: 'lossy',
      container: 'M4A',
      sampleRateHz: 44100,
      channels: 2,
      encodedBitrateBps: 270000,
      encodedBitrateStatus: 'reported',
      encodedBitrateProvenance: 'ffprobe.stream',
      bitDepthStatus: 'not-applicable',
    }),
  });

  const legacyResponse = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows' } }, legacyResponse);
  assert.equal(legacyResponse.body.rows.find((row) => row.key === 'Decoded to').value, 'PCM 24 bit 44.1 kHz, Stereo, 270 kbps');

  const diagnosticResponse = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, diagnosticResponse);
  assert.equal(diagnosticResponse.body.diagnostics.sourceFile.codec, 'AAC-LC');
  assert.equal(diagnosticResponse.body.diagnostics.sourceFile.codecStatus, 'verified');
  assert.equal(diagnosticResponse.body.diagnostics.sourceFile.bitDepthStatus, 'not-applicable');
  assert.equal(diagnosticResponse.body.diagnostics.decodedAudio.pcmBitrateBps, 2116800);
  assert.equal(diagnosticResponse.body.rows.find((row) => row.key === 'Decoded to').value, 'PCM 24 bit 44.1 kHz, Stereo');
});

test('denied collection reports the denial instead of fabricated stopped-player rows', async () => {
  const app = createApp();
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => {
      const error = new Error('remote denial');
      error.code = 'SONUVI_OPERATION_DENIED';
      throw error;
    },
  });

  const response = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rows.find((row) => row.key === 'Source').value, 'Unavailable');
  assert.doesNotMatch(JSON.stringify(response.body.rows), /Not playing/i);
  assert.equal(response.body.rows.find((row) => row.key === 'Session-backed moOde report').value, 'Unavailable (SONUVI_OPERATION_DENIED)');
  assert.equal(response.body.diagnostics.collection.rendererReport.code, 'SONUVI_OPERATION_DENIED');
  assert.equal(response.body.diagnostics.hardwareOutput.measured, false);
});

test('malformed successful collection is reported as unavailable rather than failing the endpoint', async () => {
  const app = createApp();
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => [],
  });

  const response = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rows.find((row) => row.key === 'Source').value, 'Unavailable');
  assert.equal(response.body.rows.find((row) => row.key === 'Session-backed moOde report').value,
    'Unavailable (SONUVI_MOODE_READ_UNAVAILABLE)');
  assert.equal(response.body.diagnostics.collection.rendererReport.code, 'SONUVI_MOODE_READ_UNAVAILABLE');
});

test('missing moOde session preserves independently observed MPD source and ALSA output', async () => {
  const app = createApp();
  let sourceProbeInput = '';
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => snapshot({
      html: '',
      collection: {
        session: { status: 'unavailable', code: 'SONUVI_MOODE_SESSION_UNAVAILABLE' },
        rendererReport: { status: 'unavailable', code: 'SONUVI_MOODE_SESSION_UNAVAILABLE' },
        mpd: { status: 'available' },
        alsa: { status: 'available' },
      },
    }),
    getSourceAudio: async (source) => {
      sourceProbeInput = source;
      return {
        codec: 'FLAC', codecKind: 'lossless', container: 'FLAC', bitDepth: 24,
        bitDepthStatus: 'verified', sampleRateHz: 96000, channels: 2,
      };
    },
  });

  const response = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, response);
  assert.equal(response.body.rows.find((row) => row.key === 'Source').value, 'USB/SamsungMoode/Album/01 - Track.flac');
  assert.equal(sourceProbeInput, 'USB/SamsungMoode/Album/01 - Track.flac');
  assert.equal(response.body.diagnostics.sourceFile.codec, 'FLAC');
  assert.equal(response.body.diagnostics.hardwareOutput.format, 'S32_LE');
  assert.equal(response.body.diagnostics.collection.session.code, 'SONUVI_MOODE_SESSION_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response.body.rows), /Cirrus|I2S|Not playing/i);
});

test('absent ALSA data is unavailable rather than a stale hardware measurement', async () => {
  const app = createApp();
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    readMoodeAudioInfoSnapshot: async () => snapshot({
      probe: '',
      collection: {
        ...availableCollection,
        alsa: { status: 'unavailable', code: 'SONUVI_ALSA_UNAVAILABLE' },
      },
    }),
  });

  const response = createResponse();
  await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, response);
  assert.equal(response.body.diagnostics.hardwareOutput.measured, false);
  assert.equal(response.body.diagnostics.hardwareOutput.value, 'Not measured');
  assert.equal(response.body.diagnostics.collection.alsa.code, 'SONUVI_ALSA_UNAVAILABLE');
  assert.equal(response.body.rows.find((row) => row.key === 'ALSA hardware measurement').value, 'Unavailable (SONUVI_ALSA_UNAVAILABLE)');
});

test('live radio diagnostics use only the injected current-MPD stream and retain stream provenance', async () => {
  const app = createApp();
  let activeRadioCalls = 0;
  let liveProbeCalls = 0;
  let localSourceCalls = 0;
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => null,
    probeAlsaHardware: async () => alsa,
    getSourceAudio: async () => {
      localSourceCalls += 1;
      return null;
    },
    getActiveRadioStream: async () => {
      activeRadioCalls += 1;
      return {
        owner: 'server-mpd-current',
        active: true,
        kind: 'radio',
        url: 'https://stream.example.org/jazz24.aac',
        streamKey: '42:https://stream.example.org/jazz24.aac',
      };
    },
    getLiveRadioAudio: async (stream) => {
      liveProbeCalls += 1;
      assert.equal(stream.url, 'https://stream.example.org/jazz24.aac');
      return {
        format: 'AAC-LC · 44.1 kHz · Stereo',
        codec: 'AAC-LC',
        codecStatus: 'verified',
        codecKind: 'lossy',
        container: 'AAC',
        bitDepthStatus: 'not-applicable',
        sampleRateHz: 44100,
        channels: 2,
        encodedBitrateBps: 256000,
        encodedBitrateStatus: 'reported',
        encodedBitrateProvenance: 'icy.header',
        provenance: 'live-upstream-probe',
        valueType: 'live-stream',
        live: true,
        measured: false,
        verified: true,
      };
    },
    fetchMoodeDeviceMeta: async () => ({ sessionId: 'stored-moode-session' }),
  });

  const radioHtml = `
<div class="h5">Input / Output</div>
<li><span class="left">Source</span><span class="right">https://row.example.invalid/not-used</span></li>
<li><span class="left">Source format</span><span class="right">Not playing</span></li>
<li><span class="left">Decoded to</span><span class="right">PCM 24 bit 44.1 kHz, Stereo, 256 kbps</span></li>
<li><span class="left">Output format</span><span class="right">PCM 32 bit 44.1 kHz, Stereo</span></li>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(radioHtml, { status: 200 });
  try {
    const legacyResponse = createResponse();
    await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows' } }, legacyResponse);
    assert.equal(activeRadioCalls, 0);
    assert.equal(liveProbeCalls, 0);

    const response = createResponse();
    await app.routes.get('GET /config/moode/audio-info')?.({ query: { view: 'rows', diagnostics: '1' } }, response);
    const source = response.body.diagnostics.sourceFile;
    assert.equal(activeRadioCalls, 1);
    assert.equal(liveProbeCalls, 1);
    assert.equal(localSourceCalls, 0);
    assert.equal(source.codec, 'AAC-LC');
    assert.equal(source.sampleRateHz, 44100);
    assert.equal(source.channels, 2);
    assert.equal(source.encodedBitrateBps, 256000);
    assert.equal(source.bitDepthStatus, 'not-applicable');
    assert.equal(source.provenance, 'live-upstream-probe');
    assert.equal(source.valueType, 'live-stream');
    assert.equal(source.verified, true);
    assert.equal(response.body.rows.find((row) => row.key === 'Decoded to').value, 'PCM 24 bit 44.1 kHz, Stereo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qobuz diagnostics bypass the live-radio source probe', async () => {
  const app = createApp();
  let liveProbeCalls = 0;
  let activeRadioCalls = 0;
  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: () => true,
    getQobuzNowPlaying: async () => qobuz,
    probeAlsaHardware: async () => alsa,
    getActiveRadioStream: async () => {
      activeRadioCalls += 1;
      return null;
    },
    getLiveRadioAudio: async () => {
      liveProbeCalls += 1;
      return null;
    },
    fetchMoodeDeviceMeta: async () => ({ sessionId: 'stored-moode-session' }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(moodeHtml, { status: 200 });
  try {
    const response = createResponse();
    await app.routes.get('GET /config/moode/audio-info')?.({ query: { diagnostics: '1' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(activeRadioCalls, 0);
    assert.equal(liveProbeCalls, 0);
    assert.equal(response.body.diagnostics.renderer, 'qobuz-connect');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
