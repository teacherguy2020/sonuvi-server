import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MOODE_BASE_URL, MOODE_SSH } from '../config.mjs';
import {
  buildAudioInfoDiagnostics,
  buildQobuzAudioInfo,
  normalizeAlsaHardwareProbe,
  normalizeLegacyAudioInfoRows,
  parseAudioInfoHtml,
} from '../lib/audio-info.mjs';

const execFileP = promisify(execFile);

async function fetchMoodeDeviceMeta() {
  const out = { deviceName: '', piModel: '', sessionId: '' };
  const ssh = String(MOODE_SSH || '').trim();
  if (!ssh) return out;
  try {
    const cmd = "bash -lc 'sqlite3 /var/local/www/db/moode-sqlite3.db \"select param || char(9) || value from cfg_system where param in (\\\"adevname\\\",\\\"sessionid\\\") limit 2;\" 2>/dev/null || true'";
    const r = await execFileP('ssh', ['-o', 'BatchMode=yes', ssh, cmd], { timeout: 2200, maxBuffer: 128 * 1024 });
    for (const line of String(r?.stdout || '').split(/\r?\n/)) {
      const separator = line.indexOf('\t');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === 'adevname') out.deviceName = value;
      if (key === 'sessionid') out.sessionId = value;
    }
  } catch {}
  try {
    const cmd = "bash -lc 'tr -d \\\"\\0\\\" </proc/device-tree/model 2>/dev/null || cat /proc/device-tree/model 2>/dev/null || true'";
    const r = await execFileP('ssh', ['-o', 'BatchMode=yes', ssh, cmd], { timeout: 2200, maxBuffer: 128 * 1024 });
    out.piModel = String(r?.stdout || '').replace(/\u0000/g, '').trim();
  } catch {}
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export async function probeAlsaHardware({
  ssh = MOODE_SSH,
  execFileImpl = execFileP,
} = {}) {
  const target = String(ssh || '').trim();
  if (!target) return { available: false, devices: [], activeDevice: null, state: 'unavailable' };

  const script = [
    'for cardDir in /proc/asound/card*; do',
    '  [ -d "$cardDir" ] || continue',
    '  card="${cardDir##*/}"',
    '  id="$(tr -d "\\n" < "$cardDir/id" 2>/dev/null || true)"',
    '  printf "CARD\\t%s\\t%s\\n" "$card" "$id"',
    '  for pcmDir in "$cardDir"/pcm*p; do',
    '    [ -d "$pcmDir/sub0" ] || continue',
    '    statusFile="$pcmDir/sub0/status"',
    '    hwFile="$pcmDir/sub0/hw_params"',
    '    state="$(sed -n "s/^state:[[:space:]]*//p" "$statusFile" 2>/dev/null | head -n 1)"',
    '    stateLc="$(printf "%s" "$state" | tr "[:upper:]" "[:lower:]")"',
    '    [ "$stateLc" != "closed" ] && [ -n "$stateLc" ] || continue',
    '    name="$(sed -n "s/^name:[[:space:]]*//p" "$pcmDir/info" 2>/dev/null | head -n 1)"',
    '    printf "PCM\\t%s\\t%s\\t%s\\t%s\\n" "$pcmDir" "$card" "$id" "$name" "$state"',
    '    while IFS= read -r line; do printf "HW\\t%s\\t%s\\n" "$pcmDir" "$line"; done < "$hwFile" 2>/dev/null || true',
    '    while IFS= read -r line; do printf "STATUS\\t%s\\t%s\\n" "$pcmDir" "$line"; done < "$statusFile" 2>/dev/null || true',
    '  done',
    'done',
  ].join('\n');

  try {
    const result = await execFileImpl(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', target, `bash -lc ${shellQuote(script)}`],
      { timeout: 5000, maxBuffer: 512 * 1024 },
    );
    return normalizeAlsaHardwareProbe(String(result?.stdout || ''));
  } catch {
    return { available: false, devices: [], activeDevice: null, state: 'unavailable' };
  }
}

export function registerConfigMoodeAudioInfoRoutes(app, deps = {}) {
  const requireTrackKey = deps.requireTrackKey;
  const getQobuzNowPlaying = deps.getQobuzNowPlaying;
  const readAlsaHardware = deps.probeAlsaHardware || (() => probeAlsaHardware());
  const getDeviceMeta = deps.fetchMoodeDeviceMeta || fetchMoodeDeviceMeta;
  const getSourceAudio = deps.getSourceAudio;
  const getActiveRadioStream = deps.getActiveRadioStream;
  const getLiveRadioAudio = deps.getLiveRadioAudio;

  app.get('/config/moode/audio-info', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const base = String(MOODE_BASE_URL || '').trim().replace(/\/+$/, '');
      const url = `${base}/audioinfo.php`;

      let meta = { deviceName: '', piModel: '', sessionId: '' };
      try {
        meta = await getDeviceMeta();
      } catch {}

      const sessionId = String(meta?.sessionId || '').trim();
      const headers = /^[A-Za-z0-9._-]+$/.test(sessionId)
        ? { cookie: `PHPSESSID=${sessionId}` }
        : undefined;

      let qobuz = null;
      try {
        qobuz = typeof getQobuzNowPlaying === 'function' ? await getQobuzNowPlaying() : null;
      } catch {}
      const diagnosticsRequested = /^(?:1|true|yes|on)$/i.test(String(
        req.query?.diagnostics || req.query?.includeDiagnostics || '',
      ).trim());

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4500);
      let r;
      try {
        r = await fetch(url, {
          cache: 'no-store',
          ...(headers ? { headers } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
      const html = await r.text().catch(() => '');
      if (!r.ok || !html) {
        if (!qobuz?.active) {
          return res.status(502).json({ ok: false, error: `audioinfo fetch failed (${r.status})`, url });
        }
      }

      let rows = parseAudioInfoHtml(html);

      // Enrich fields that are often blank in audioinfo.php depending on moOde session context.
      try {
        for (const row of rows) {
          const sec = String(row?.section || '').trim();
          const key = String(row?.key || '').trim();
          const val = String(row?.value || '').trim();
          if (sec === 'Audio Device' && key === 'Device' && (!val || val === '—') && meta.deviceName) row.value = meta.deviceName;
          if (sec === 'Audio Device' && key === 'Pi model' && (!val || val === '—') && meta.piModel) row.value = meta.piModel;
        }
      } catch {}

      let audio = null;
      let alsa = null;
      let sourceAudio = null;
      if (qobuz?.active || diagnosticsRequested) {
        alsa = await readAlsaHardware().catch(() => null);
      }
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
          const source = rows.find((row) => (
            String(row?.section || '').trim() === 'Input / Output'
              && String(row?.key || '').trim().toLowerCase() === 'source'
          ))?.value;
          const sourceValue = String(source || '').trim();
          if (sourceValue
            && !/^(?:not playing|unknown|—)$/i.test(sourceValue)
            && !/^[a-z][a-z\d+.-]*:\/\//i.test(sourceValue)) {
            sourceAudio = await getSourceAudio(sourceValue).catch(() => null);
          }
        }
      }
      if (qobuz?.active) {
        const enriched = buildQobuzAudioInfo({ moodeRows: rows, qobuz, alsa });
        rows = enriched.rows;
        audio = enriched.audio;
      }

      const fetchedAt = new Date().toISOString();
      let diagnostics = null;
      if (diagnosticsRequested) {
        diagnostics = buildAudioInfoDiagnostics({
          moodeRows: rows,
          alsa,
          qobuz,
          sourceAudio,
          capturedAt: fetchedAt,
        });
        rows = normalizeLegacyAudioInfoRows(rows, {
          sourceFile: diagnostics.sourceFile,
        });
      }
      const sections = rows.reduce((acc, row) => {
        if (!acc[row.section]) acc[row.section] = [];
        const { section: _section, ...rest } = row;
        acc[row.section].push(rest);
        return acc;
      }, {});

      const view = String(req.query?.view || 'sections').trim().toLowerCase();
      const payload = {
        ok: true,
        sourceUrl: url,
        rowCount: rows.length,
        fetchedAt,
        view,
      };
      if (audio) {
        payload.playback = {
          source: 'qobuz-connect',
          renderer: 'pibuz',
          state: String(qobuz?.state || '').trim().toLowerCase() || 'unknown',
          active: true,
        };
        payload.audio = audio;
      }
      if (diagnostics) payload.diagnostics = diagnostics;
      if (view === 'rows') {
        payload.rows = rows;
      } else if (view === 'both' || view === 'all') {
        payload.rows = rows;
        payload.sections = sections;
      } else {
        payload.sections = sections;
      }

      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
