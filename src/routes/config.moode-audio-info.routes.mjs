import { MOODE_BASE_URL } from '../config.mjs';
import {
  buildAudioInfoDiagnostics,
  buildQobuzAudioInfo,
  normalizeAlsaHardwareProbe,
  normalizeLegacyAudioInfoRows,
  parseAudioInfoHtml,
} from '../lib/audio-info.mjs';
import {
  normalizeMoodeAudioInfoSnapshot,
  readMoodeAudioInfoSnapshot,
} from '../lib/moode-readonly.mjs';

const SAFE_ERROR_CODE = /^SONUVI_[A-Z0-9_]{1,96}$/;

function text(value) {
  return String(value ?? '').trim();
}

function errorCode(error, fallback = 'SONUVI_MOODE_READ_UNAVAILABLE') {
  const code = text(error?.code).toUpperCase();
  return SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function unavailableSnapshot(error) {
  const code = errorCode(error);
  const unavailable = { status: 'unavailable', code, provenance: 'sonuvi-moode-readonly-v1' };
  return {
    capturedAt: null,
    audioInfoHtml: '',
    alsaProbe: '',
    mpd: {
      state: 'unknown',
      source: '',
      decoded: { sampleRateHz: null, bitDepth: null, bitDepthKind: null, channels: null },
    },
    collection: {
      session: unavailable,
      rendererReport: unavailable,
      mpd: unavailable,
      alsa: unavailable,
    },
  };
}

function snapshotFromResult(result) {
  if (result?.status !== 'fulfilled') return unavailableSnapshot(result?.reason);
  try {
    return normalizeMoodeAudioInfoSnapshot(result.value);
  } catch (error) {
    return unavailableSnapshot(error);
  }
}

function metadataForMoodeRow(row) {
  const section = text(row?.section).toLowerCase();
  const key = text(row?.key).toLowerCase();
  if (section === 'input / output' && /^source(?: format)?$/.test(key)) {
    return { provenance: 'moode-audioinfo.php', valueType: 'source-reported', live: true, measured: false };
  }
  if (section === 'input / output' && key === 'decoded to') {
    return { provenance: 'moode-audioinfo.php:mpd-decoder-fields', valueType: 'decoded-reported', live: true, measured: false };
  }
  if (section === 'input / output' && key === 'output format') {
    return { provenance: 'moode-audioinfo.php', valueType: 'output-reported', live: true, measured: false };
  }
  return { provenance: 'moode-audioinfo.php', valueType: 'configured', live: false, measured: false, configured: true };
}

function moodeRows(html) {
  return parseAudioInfoHtml(html).map((row) => ({ ...row, ...metadataForMoodeRow(row) }));
}

function rateLabel(sampleRateHz) {
  const rate = Number(sampleRateHz);
  if (!Number.isFinite(rate) || rate <= 0) return '';
  const kHz = rate / 1000;
  return `${Number.isInteger(kHz) ? kHz : kHz.toFixed(1)} kHz`;
}

function decodedLabel(decoded = {}) {
  const bits = Number(decoded.bitDepth);
  const rate = rateLabel(decoded.sampleRateHz);
  const channels = Number(decoded.channels) === 2 ? 'Stereo'
    : Number(decoded.channels) > 0 ? `${decoded.channels}ch` : '';
  const precision = decoded.bitDepthKind === 'float'
    ? 'floating-point'
    : Number.isInteger(bits) && bits > 0 ? `${bits} bit` : '';
  const details = [precision, rate, channels].filter(Boolean).join(' ');
  return details ? `PCM ${details.replace(/ (Stereo|\d+ch)$/, ', $1')}` : 'Unavailable';
}

function fallbackRows(snapshot) {
  const state = text(snapshot?.mpd?.state).toLowerCase();
  const source = text(snapshot?.mpd?.source);
  const playing = state === 'play' || state === 'pause';
  const sourceValue = state === 'stop' ? 'Not playing' : (source || (playing ? 'Unavailable' : 'Unavailable'));
  return [
    {
      section: 'Input / Output',
      key: 'Source',
      value: sourceValue,
      provenance: 'mpd-status',
      valueType: state === 'stop' ? 'playback-state' : 'source-reported',
      live: state !== 'unknown',
      measured: false,
    },
    {
      section: 'Input / Output',
      key: 'Source format',
      value: 'Unavailable',
      provenance: 'unavailable',
      valueType: 'unavailable',
      live: false,
      measured: false,
    },
    {
      section: 'Input / Output',
      key: 'Decoded to',
      value: playing ? decodedLabel(snapshot?.mpd?.decoded) : 'Unavailable',
      provenance: 'mpd-status',
      valueType: 'decoded-reported',
      live: playing,
      measured: false,
    },
    {
      section: 'Input / Output',
      key: 'Output format',
      value: 'Not measured',
      provenance: 'alsa-procfs',
      valueType: 'unavailable',
      live: false,
      measured: false,
    },
  ];
}

function stageLabel(stage = {}) {
  if (stage?.status === 'available') return 'Available';
  return stage?.code ? `Unavailable (${stage.code})` : 'Unavailable';
}

function appendCollectionRows(rows, snapshot) {
  const collection = snapshot?.collection || {};
  const mpdState = text(snapshot?.mpd?.state).toLowerCase();
  return [
    ...rows,
    {
      section: 'Collection',
      key: 'Session-backed moOde report',
      value: stageLabel(collection.rendererReport),
      provenance: 'sonuvi-moode-readonly-v1',
      valueType: collection.rendererReport?.status === 'available' ? 'collection-status' : 'unavailable',
      live: collection.rendererReport?.status === 'available',
      measured: false,
    },
    {
      section: 'Collection',
      key: 'MPD playback state',
      value: collection.mpd?.status === 'available' && mpdState ? mpdState : stageLabel(collection.mpd),
      provenance: 'mpd-status',
      valueType: collection.mpd?.status === 'available' ? 'source-reported' : 'unavailable',
      live: collection.mpd?.status === 'available',
      measured: false,
    },
    {
      section: 'Collection',
      key: 'ALSA hardware measurement',
      value: stageLabel(collection.alsa),
      provenance: 'alsa-procfs',
      valueType: collection.alsa?.status === 'available' ? 'hardware-observed' : 'unavailable',
      live: collection.alsa?.status === 'available',
      measured: false,
    },
  ];
}

function usableSource(value) {
  const source = text(value);
  return source && !/^(?:not playing|unknown|unavailable|—)$/i.test(source) && !/^[a-z][a-z\d+.-]*:\/\//i.test(source);
}

function verifiedSourceFormat(sourceAudio) {
  const codec = text(sourceAudio?.codec);
  const bitDepth = Number(sourceAudio?.bitDepth);
  const rate = rateLabel(sourceAudio?.sampleRateHz);
  const channels = Number(sourceAudio?.channels) === 2 ? 'Stereo'
    : Number(sourceAudio?.channels) > 0 ? `${sourceAudio.channels}ch` : '';
  const details = [codec, Number.isInteger(bitDepth) && bitDepth > 0 ? `${bitDepth} bit` : '', rate, channels].filter(Boolean);
  return details.length ? details.join(' ') : '';
}

function enrichFallbackSourceFormat(rows, sourceAudio) {
  const format = verifiedSourceFormat(sourceAudio);
  if (!format) return rows;
  return rows.map((row) => {
    if (text(row.section) !== 'Input / Output' || text(row.key).toLowerCase() !== 'source format'
      || !/^(?:unknown|unavailable|—)$/i.test(text(row.value))) return row;
    return {
      ...row,
      value: format,
      provenance: 'ffprobe.source-file',
      valueType: 'source-file',
      live: true,
      measured: false,
    };
  });
}

function sourceValue(rows) {
  return rows.find((row) => (
    text(row.section) === 'Input / Output' && text(row.key).toLowerCase() === 'source'
  ))?.value || '';
}

export function registerConfigMoodeAudioInfoRoutes(app, deps = {}) {
  const requireTrackKey = deps.requireTrackKey;
  const getQobuzNowPlaying = deps.getQobuzNowPlaying;
  const getSourceAudio = deps.getSourceAudio;
  const getActiveRadioStream = deps.getActiveRadioStream;
  const getLiveRadioAudio = deps.getLiveRadioAudio;
  const readSnapshot = deps.readMoodeAudioInfoSnapshot || readMoodeAudioInfoSnapshot;

  app.get('/config/moode/audio-info', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const diagnosticsRequested = /^(?:1|true|yes|on)$/i.test(String(
        req.query?.diagnostics || req.query?.includeDiagnostics || '',
      ).trim());

      const [snapshotResult, qobuzResult] = await Promise.allSettled([
        readSnapshot(),
        typeof getQobuzNowPlaying === 'function' ? getQobuzNowPlaying() : null,
      ]);
      const snapshot = snapshotFromResult(snapshotResult);
      const qobuz = qobuzResult.status === 'fulfilled' ? qobuzResult.value : null;

      let rows = snapshot.audioInfoHtml ? moodeRows(snapshot.audioInfoHtml) : fallbackRows(snapshot);
      const alsa = snapshot.collection?.alsa?.status === 'available'
        ? normalizeAlsaHardwareProbe(snapshot.alsaProbe)
        : null;

      let audio = null;
      let sourceAudio = null;
      if (diagnosticsRequested && !qobuz?.active) {
        // A live-radio URL is never read from the request or from an
        // audioinfo.php row. The injected getter is backed by current MPD
        // state, and the probe itself enforces public-URL/redirect policy.
        const activeRadio = typeof getActiveRadioStream === 'function'
          ? await getActiveRadioStream().catch(() => null)
          : null;
        if (activeRadio && typeof getLiveRadioAudio === 'function') {
          sourceAudio = await getLiveRadioAudio(activeRadio).catch(() => null);
        } else if (!activeRadio && typeof getSourceAudio === 'function') {
          const source = sourceValue(rows);
          if (usableSource(source)) {
            sourceAudio = await getSourceAudio(source).catch(() => null);
            if (!snapshot.audioInfoHtml) rows = enrichFallbackSourceFormat(rows, sourceAudio);
          }
        }
      }
      if (qobuz?.active) {
        const enriched = buildQobuzAudioInfo({ moodeRows: rows, qobuz, alsa });
        rows = enriched.rows;
        audio = enriched.audio;
      }

      const fetchedAt = snapshot.capturedAt || new Date().toISOString();
      let diagnostics = null;
      if (diagnosticsRequested) {
        diagnostics = buildAudioInfoDiagnostics({
          moodeRows: rows,
          alsa,
          qobuz,
          sourceAudio,
          collection: snapshot.collection,
          capturedAt: fetchedAt,
        });
        rows = normalizeLegacyAudioInfoRows(rows, { sourceFile: diagnostics.sourceFile });
      }
      rows = appendCollectionRows(rows, snapshot);

      const sections = rows.reduce((acc, row) => {
        if (!acc[row.section]) acc[row.section] = [];
        const { section: _section, ...rest } = row;
        acc[row.section].push(rest);
        return acc;
      }, {});
      const view = String(req.query?.view || 'sections').trim().toLowerCase();
      const base = String(MOODE_BASE_URL || '').trim().replace(/\/+$/, '');
      const payload = {
        ok: true,
        sourceUrl: base ? `${base}/audioinfo.php` : null,
        rowCount: rows.length,
        fetchedAt,
        view,
      };
      if (audio) {
        payload.playback = {
          source: 'qobuz-connect',
          renderer: 'pibuz',
          state: text(qobuz?.state).toLowerCase() || 'unknown',
          active: true,
        };
        payload.audio = audio;
      }
      if (diagnostics) payload.diagnostics = diagnostics;
      if (view === 'rows') payload.rows = rows;
      else if (view === 'both' || view === 'all') {
        payload.rows = rows;
        payload.sections = sections;
      } else payload.sections = sections;
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
}
