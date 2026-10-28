import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APNS_ENVIRONMENT,
  APNS_KEY_ID,
  APNS_PRIVATE_KEY,
  APNS_PRIVATE_KEY_PATH,
  APNS_TEAM_ID,
  APNS_TOPIC,
  MPD_HOST,
  MOODE_SSH_HOST,
  MOODE_SSH_USER,
} from '../config.mjs';
import { createLastfmIndexResolver } from '../lib/lastfm-library-match.mjs';
import { normalizeMoodeBaseUrl } from '../lib/moode-url.mjs';
import { registerSonuviRestartRoutes } from '../lib/sonuvi-service-control.mjs';
import { exchangeLastfmToken, lastfmAuthorizationUrl, requestLastfmToken } from '../../scripts/lastfm-authorize.mjs';

const execFileP = promisify(execFile);
let pendingLastfmAuthorization = null;

function lastfmFingerprint(value) {
  const raw = String(value || '');
  return raw ? crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12) : '';
}

async function readEnvFileValues(envPath) {
  const raw = await fs.readFile(envPath, 'utf8').catch(() => '');
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(LASTFM_API_KEY|LASTFM_API_SECRET|LASTFM_SESSION_KEY)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function writeEnvValues(envPath, updates) {
  const original = await fs.readFile(envPath, 'utf8').catch(() => '');
  const keys = new Set(Object.keys(updates));
  const seen = new Set();
  const lines = original.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(LASTFM_API_KEY|LASTFM_API_SECRET|LASTFM_SESSION_KEY)\s*=/);
    if (!match || !keys.has(match[1])) return true;
    if (seen.has(match[1])) return false;
    seen.add(match[1]);
    return false;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (value !== null) lines.push(`${key}=${String(value)}`);
  }
  const next = `${lines.filter((line, index, all) => !(index === all.length - 1 && line === '')).join('\n')}\n`;
  const tmp = `${envPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, next, { mode: 0o600 });
  await fs.rename(tmp, envPath);
  await fs.chmod(envPath, 0o600).catch(() => {});
}

function currentLastfmCredentials(envValues) {
  return {
    apiKey: String(process.env.LASTFM_API_KEY || envValues.LASTFM_API_KEY || '').trim(),
    apiSecret: String(process.env.LASTFM_API_SECRET || envValues.LASTFM_API_SECRET || '').trim(),
    sessionKey: String(process.env.LASTFM_SESSION_KEY || envValues.LASTFM_SESSION_KEY || '').trim(),
  };
}

function pickPublicConfig(cfg) {
  const c = cfg || {};
  const n = c.notifications || {};
  const tn = n.trackNotify || {};
  const po = n.pushover || {};
  const apns = n.apns || {};
  const apnsTopic = String(apns.topic || APNS_TOPIC || 'com.brianwis.sonuvi').trim();
  const apnsEnvironment = String(apns.environment || APNS_ENVIRONMENT || 'auto').trim().toLowerCase();
  const apnsConfigured = Boolean(
    APNS_KEY_ID
    && APNS_TEAM_ID
    && (APNS_PRIVATE_KEY || APNS_PRIVATE_KEY_PATH)
    && apnsTopic
  );

  const cfgLastfm = String(c.lastfm?.apiKey || '').trim();
  const envLastfm = String(process.env.LASTFM_API_KEY || '').trim();
  const moodeHost = String(c.moode?.sshHost || c.mpd?.host || MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
  const moodeBaseRaw = String(c.moode?.baseUrl || '').trim();

  return {
    projectName: c.projectName || 'now-playing',
    trackKey: String(process.env.TRACK_KEY || c.trackKey || '1029384756'),
    environment: c.environment || 'home',
    timezone: c.timezone || 'America/Chicago',
    ports: c.ports || { api: 3101, ui: 8101 },
    lastfm: {
      configured: Boolean(envLastfm || cfgLastfm),
    },
    alexa: {
      enabled: Boolean(c.alexa?.enabled ?? true),
      publicDomain: String(c.alexa?.publicDomain || ''),
      skillId: String(c.alexa?.skillId || ''),
      webhookPath: String(c.alexa?.webhookPath || '/alexa'),
      routeWebhookUrl: String(c.alexa?.routeWebhookUrl || ''),
      stopWebhookUrl: String(c.alexa?.stopWebhookUrl || ''),
      artistAliases: c.alexa?.artistAliases || {},
      albumAliases: c.alexa?.albumAliases || {},
      playlistAliases: c.alexa?.playlistAliases || {},
      unresolvedArtists: Array.isArray(c.alexa?.unresolvedArtists) ? c.alexa.unresolvedArtists : [],
      heardArtists: Array.isArray(c.alexa?.heardArtists) ? c.alexa.heardArtists : [],
      unresolvedAlbums: Array.isArray(c.alexa?.unresolvedAlbums) ? c.alexa.unresolvedAlbums : [],
      heardAlbums: Array.isArray(c.alexa?.heardAlbums) ? c.alexa.heardAlbums : [],
      unresolvedPlaylists: Array.isArray(c.alexa?.unresolvedPlaylists) ? c.alexa.unresolvedPlaylists : [],
      heardPlaylists: Array.isArray(c.alexa?.heardPlaylists) ? c.alexa.heardPlaylists : [],
    },
    notifications: {
      trackNotify: {
        enabled: !!tn.enabled,
        pollMs: Number(tn.pollMs || 3000),
        dedupeMs: Number(tn.dedupeMs || 15000),
        alexaMaxAgeMs: Number(tn.alexaMaxAgeMs || 21600000),
      },
      pushover: {
        token: String(po.token || ''),
        userKey: String(po.userKey || ''),
      },
      apns: {
        configured: apnsConfigured,
        topic: apnsTopic,
        environment: apnsEnvironment,
      },
    },
    paths: c.paths || {},
    mpd: {
      host: String(c.mpd?.host || ''),
      port: Number(c.mpd?.port || 6600),
    },
    moode: {
      sshHost: String(c.moode?.sshHost || ''),
      sshUser: String(c.moode?.sshUser || ''),
      baseUrl: moodeBaseRaw ? normalizeMoodeBaseUrl(moodeBaseRaw, moodeHost) : '',
    },
    runtime: {
      publicBaseUrl: String(c.runtime?.publicBaseUrl || ''),
      trackCacheDir: String(c.runtime?.trackCacheDir || ''),
      artCacheDir: String(c.runtime?.artCacheDir || ''),
      artCacheLimit: Number(c.runtime?.artCacheLimit || 0),
    },
    display: {
      idleBrandLine: String(c.display?.idleBrandLine || '').trim() || 'Clem’s Place',
      idleMessageLine: String(c.display?.idleMessageLine || '').trim() || 'The record room is quiet',
    },
    features: {
      podcasts: Boolean(c.features?.podcasts ?? true),
      ratings: Boolean(c.features?.ratings ?? true),
      radio: Boolean(c.features?.radio ?? true),
      albumPersonnel: Boolean(c.features?.albumPersonnel ?? true),
      mpdscribbleControl: Boolean(c.features?.mpdscribbleControl ?? false),
      moodeDisplayTakeover: Boolean(c.features?.moodeDisplayTakeover ?? true),
      lastfm: Boolean(c.features?.lastfm ?? false),
    },
  };
}

function withEnvOverrides(cfg) {
  const out = pickPublicConfig(cfg);
  const cfgLastfm = String((cfg || {}).lastfm?.apiKey || '').trim();
  const envLastfm = String(process.env.LASTFM_API_KEY || '').trim();

  if (process.env.TRACK_NOTIFY_ENABLED != null) {
    out.notifications.trackNotify.enabled = /^(1|true|yes|on)$/i.test(String(process.env.TRACK_NOTIFY_ENABLED));
  }
  if (process.env.TRACK_NOTIFY_POLL_MS) {
    out.notifications.trackNotify.pollMs =
      Number(process.env.TRACK_NOTIFY_POLL_MS) || out.notifications.trackNotify.pollMs;
  }
  if (process.env.TRACK_NOTIFY_DEDUPE_MS) {
    out.notifications.trackNotify.dedupeMs =
      Number(process.env.TRACK_NOTIFY_DEDUPE_MS) || out.notifications.trackNotify.dedupeMs;
  }
  if (process.env.TRACK_NOTIFY_ALEXA_MAX_AGE_MS) {
    out.notifications.trackNotify.alexaMaxAgeMs =
      Number(process.env.TRACK_NOTIFY_ALEXA_MAX_AGE_MS) || out.notifications.trackNotify.alexaMaxAgeMs;
  }

  if (process.env.PUSHOVER_TOKEN) out.notifications.pushover.token = String(process.env.PUSHOVER_TOKEN);
  if (process.env.PUSHOVER_USER_KEY) out.notifications.pushover.userKey = String(process.env.PUSHOVER_USER_KEY);

  if (process.env.MPD_HOST) out.mpd.host = String(process.env.MPD_HOST);
  if (process.env.MPD_PORT) out.mpd.port = Number(process.env.MPD_PORT) || out.mpd.port;
  if (process.env.MOODE_SSH_HOST) out.moode.sshHost = String(process.env.MOODE_SSH_HOST);
  if (process.env.MOODE_SSH_USER) out.moode.sshUser = String(process.env.MOODE_SSH_USER);
  if (process.env.MOODE_BASE_URL) {
    out.moode.baseUrl = normalizeMoodeBaseUrl(
      process.env.MOODE_BASE_URL,
      out.moode.sshHost || out.mpd.host || MOODE_SSH_HOST || MPD_HOST || 'moode.local',
    );
  }
  if (process.env.PUBLIC_BASE_URL) out.runtime.publicBaseUrl = String(process.env.PUBLIC_BASE_URL);

  out.lastfm = { configured: Boolean(envLastfm || cfgLastfm) };

  return out;
}

function validateConfigShape(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') errors.push('config must be an object');
  if (!cfg.ports || typeof cfg.ports.api !== 'number' || typeof cfg.ports.ui !== 'number') {
    errors.push('ports.api and ports.ui must be numbers');
  }
  if (cfg.alexa?.enabled && !String(cfg.alexa?.publicDomain || '').trim()) {
    errors.push('alexa.publicDomain is required when alexa.enabled=true');
  }
  return errors;
}

function sshArgsFor(user, host, extra = []) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    ...extra,
    `${user}@${host}`,
  ];
}

function shQuoteArg(s) {
  const v = String(s ?? '');
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

async function sshBashLc({ user, host, script, timeoutMs = 20000, maxBuffer = 10 * 1024 * 1024 }) {
  return execFileP('ssh', [...sshArgsFor(user, host), 'bash', '-lc', shQuoteArg(String(script || ''))], {
    timeout: timeoutMs,
    maxBuffer,
  });
}

function parseKvOutput(stdout = '') {
  const out = {};
  String(stdout || '').split(/\r?\n/).forEach((line) => {
    const m = String(line || '').match(/^([A-Z_]+)=(.*)$/);
    if (!m) return;
    out[m[1]] = m[2];
  });
  return out;
}

async function getMpdscribbleStatus({ user, host }) {
  const script = [
    'svc="mpdscribble.service"',
    'if systemctl list-unit-files "$svc" --no-legend >/dev/null 2>&1; then INSTALLED=1; else INSTALLED=0; fi',
    'ACTIVE=$(systemctl is-active "$svc" 2>/dev/null || true)',
    'ENABLED=$(systemctl is-enabled "$svc" 2>/dev/null || true)',
    'echo "INSTALLED=$INSTALLED"',
    'echo "ACTIVE=$ACTIVE"',
    'echo "ENABLED=$ENABLED"',
  ].join('; ');

  const { stdout } = await sshBashLc({ user, host, script, timeoutMs: 12000 });
  const kv = parseKvOutput(stdout);
  const installed = String(kv.INSTALLED || '0') === '1';
  const activeRaw = String(kv.ACTIVE || '').trim().toLowerCase();
  const enabledRaw = String(kv.ENABLED || '').trim().toLowerCase();
  const running = activeRaw === 'active';

  return {
    ok: true,
    service: 'mpdscribble.service',
    manager: 'systemd',
    host,
    user,
    installed,
    running,
    status: installed ? (running ? 'running' : (activeRaw || 'stopped')) : 'not-installed',
    activeRaw,
    enabled: enabledRaw === 'enabled',
    enabledRaw,
  };
}

export function registerConfigRuntimeAdminRoutes(app, deps) {
  const { requireTrackKey, log, getLocalHistoryItems, trackKey = '' } = deps;
  const configPath = process.env.NOW_PLAYING_CONFIG_PATH || path.resolve(process.cwd(), 'config/now-playing.config.json');
  const peppyLastPushPath = path.resolve(process.cwd(), 'data/peppy-last-push.json');

  async function localHistoryFallback(req, { kind, limit, period = 'overall', windowDays = 0 } = {}) {
    if (typeof getLocalHistoryItems !== 'function') return null;
    const items = await getLocalHistoryItems({
      kind,
      limit,
      period,
      windowDays,
      baseUrl: `${req?.protocol || 'http'}://${String(req?.get?.('host') || '').trim()}`,
      trackKey,
    });
    return {
      ok: true,
      source: 'local-history',
      provider: 'local-history',
      username: '',
      period,
      items: Array.isArray(items) ? items : [],
    };
  }

  app.get('/config/runtime', async (req, res) => {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      return res.json({ ok: true, configPath, config: withEnvOverrides(cfg), fullConfig: cfg });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const lastfmEnvPath = () => process.env.LASTFM_ENV_FILE || path.resolve(process.cwd(), '.env');
  const lastfmStatus = async () => {
    const values = await readEnvFileValues(lastfmEnvPath());
    const creds = currentLastfmCredentials(values);
    let cfg = {};
    try { cfg = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}
    const vibeKey = String(cfg?.lastfm?.apiKey || '').trim();
    return {
      apiKeyConfigured: Boolean(creds.apiKey), apiSecretConfigured: Boolean(creds.apiSecret),
      sessionConfigured: Boolean(creds.sessionKey), authorized: Boolean(creds.apiKey && creds.apiSecret && creds.sessionKey),
      apiKeyLength: creds.apiKey.length, apiSecretLength: creds.apiSecret.length,
      credentialsDistinct: Boolean(creds.apiKey && creds.apiSecret && creds.apiKey !== creds.apiSecret),
      apiKeyFingerprint: lastfmFingerprint(creds.apiKey), vibeApiKeyConfigured: Boolean(vibeKey),
      vibeApiKeyFingerprint: lastfmFingerprint(vibeKey), sameAsVibeKey: Boolean(creds.apiKey && vibeKey && creds.apiKey === vibeKey),
      mpdMode: String(process.env.LASTFM_MPD_MODE || 'shadow'),
    };
  };

  app.get('/config/lastfm/status', async (req, res) => {
    try { if (!requireTrackKey(req, res)) return; return res.json({ ok: true, ...(await lastfmStatus()) }); }
    catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/config/lastfm/credentials', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const apiKey = String(req.body?.apiKey || ''), apiSecret = String(req.body?.apiSecret || '');
      if (!apiKey || !apiSecret) return res.status(400).json({ ok: false, error: 'API key and API secret are required' });
      if (/\s|["']/.test(apiKey) || /\s|["']/.test(apiSecret)) return res.status(400).json({ ok: false, error: 'Credentials must not contain whitespace or quote characters' });
      if (apiKey === apiSecret) return res.status(400).json({ ok: false, error: 'API key and API secret must differ' });
      await writeEnvValues(lastfmEnvPath(), { LASTFM_API_KEY: apiKey, LASTFM_API_SECRET: apiSecret, LASTFM_SESSION_KEY: null });
      process.env.LASTFM_API_KEY = apiKey; process.env.LASTFM_API_SECRET = apiSecret; delete process.env.LASTFM_SESSION_KEY;
      pendingLastfmAuthorization = null;
      return res.json({ ok: true, ...(await lastfmStatus()) });
    } catch (e) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/config/lastfm/authorize/start', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const creds = currentLastfmCredentials(await readEnvFileValues(lastfmEnvPath()));
      if (!creds.apiKey || !creds.apiSecret) return res.status(400).json({ ok: false, error: 'Sonuvi Last.fm API key and secret are not configured' });
      const token = await requestLastfmToken({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
      pendingLastfmAuthorization = { token, expiresAt: Date.now() + 600000 };
      return res.json({ ok: true, authorizationUrl: lastfmAuthorizationUrl(creds.apiKey, token), expiresInSeconds: 600 });
    } catch (e) { return res.status(502).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/config/lastfm/authorize/complete', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      if (!pendingLastfmAuthorization || pendingLastfmAuthorization.expiresAt < Date.now()) { pendingLastfmAuthorization = null; return res.status(400).json({ ok: false, error: 'No pending Last.fm authorization; start a new authorization' }); }
      const creds = currentLastfmCredentials(await readEnvFileValues(lastfmEnvPath()));
      const session = await exchangeLastfmToken({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, token: pendingLastfmAuthorization.token });
      await writeEnvValues(lastfmEnvPath(), { LASTFM_SESSION_KEY: session.sessionKey });
      process.env.LASTFM_SESSION_KEY = session.sessionKey; pendingLastfmAuthorization = null;
      return res.json({ ok: true, authorized: true, username: session.username, ...(await lastfmStatus()) });
    } catch (e) { return res.status(502).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get('/config/lastfm/top-tracks', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const apiKey = String(process.env.LASTFM_API_KEY || cfg?.lastfm?.apiKey || '').trim();
      const username = String(cfg?.lastfm?.username || '').trim();
      if (!apiKey || !username) {
        const fallback = await localHistoryFallback(req, {
          kind: 'top-tracks',
          limit: Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18)),
          period: String(req.query?.period || cfg?.lastfm?.period || 'overall').trim().toLowerCase(),
          windowDays: Number(req.query?.windowDays || cfg?.lastfm?.topTracksWindowDays || 0) || 0,
        });
        if (fallback) return res.json(fallback);
      }
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      if (!username) return res.status(400).json({ ok: false, error: 'Last.fm username is not configured' });

      const period = String(req.query?.period || cfg?.lastfm?.period || '1month').trim().toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18));
      const windowDaysRaw = Number(req.query?.windowDays || cfg?.lastfm?.topTracksWindowDays || 0);
      const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? Math.max(1, Math.min(60, Math.floor(windowDaysRaw))) : 0;

      let items = [];
      if (windowDays > 0) {
        const cutoffSec = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000);
        const seenNowPlaying = new Set();
        const agg = new Map();
        for (let page = 1; page <= 6; page++) {
          const ru = new URL('https://ws.audioscrobbler.com/2.0/');
          ru.searchParams.set('method', 'user.getrecenttracks');
          ru.searchParams.set('user', username);
          ru.searchParams.set('api_key', apiKey);
          ru.searchParams.set('format', 'json');
          ru.searchParams.set('limit', '200');
          ru.searchParams.set('page', String(page));
          const rr = await fetch(ru.toString(), { headers: { 'accept': 'application/json' } });
          const rj = await rr.json().catch(() => ({}));
          const rows = Array.isArray(rj?.recenttracks?.track) ? rj.recenttracks.track : [];
          let oldHit = false;
          for (const x of rows) {
            const nowPlaying = String(x?.['@attr']?.nowplaying || '').toLowerCase() === 'true';
            const title = String(x?.name || '').trim();
            const artist = String(x?.artist?.['#text'] || x?.artist?.name || '').trim();
            const ts = Number(x?.date?.uts || 0) || 0;
            if (!title || !artist) continue;
            if (!nowPlaying && ts && ts < cutoffSec) {
              oldHit = true;
              continue;
            }
            const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
            if (nowPlaying) {
              if (seenNowPlaying.has(key)) continue;
              seenNowPlaying.add(key);
            }
            const cur = agg.get(key) || { track: title, artist, playcount: 0, url: String(x?.url || '').trim() };
            cur.playcount += 1;
            if (!cur.url) cur.url = String(x?.url || '').trim();
            agg.set(key, cur);
          }
          if (oldHit) break;
        }
        items = Array.from(agg.values()).sort((a, b) => Number(b.playcount || 0) - Number(a.playcount || 0)).slice(0, limit).map((x) => ({
          kind: 'lastfm-track',
          title: String(x.track || '(track)').trim(),
          track: String(x.track || '').trim(),
          artist: String(x.artist || '').trim(),
          album: '',
          playcount: Number(x.playcount || 0) || 0,
          url: String(x.url || '').trim(),
          art: '',
          file: '',
        }));
      } else {
        const url = new URL('https://ws.audioscrobbler.com/2.0/');
        url.searchParams.set('method', 'user.gettoptracks');
        url.searchParams.set('user', username);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('format', 'json');
        url.searchParams.set('period', period);
        url.searchParams.set('limit', String(limit));

        const r = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
        const j = await r.json().catch(() => ({}));
        const rows = Array.isArray(j?.toptracks?.track) ? j.toptracks.track : [];
        items = rows.map((x) => {
          const title = String(x?.name || '').trim();
          const artist = String(x?.artist?.name || '').trim();
          const playcount = Number(x?.playcount || 0) || 0;
          return {
            kind: 'lastfm-track',
            title: title || '(track)',
            track: title,
            artist,
            album: '',
            playcount,
            url: String(x?.url || '').trim(),
            art: '',
            file: '',
          };
        }).filter((x) => String(x.title || '').trim());
      }

      const mpdHost = String(cfg?.mpd?.host || process.env.MPD_HOST || MPD_HOST || 'localhost').trim();
      const trackKey = String(process.env.TRACK_KEY || cfg?.trackKey || '').trim();
      const hostHdr = String(req.get('host') || '').trim();
      const baseUrl = hostHdr ? `${req.protocol || 'http'}://${hostHdr}` : '';
      const resolver = await createLastfmIndexResolver({ mpdHost, baseUrl, trackKey });

      for (const it of items) {
        const hit = resolver.resolveTrack({ track: String(it.track || '').trim(), artist: String(it.artist || '').trim() });
        if (!hit) continue;
        it.file = String(hit.file || '').trim();
        if (String(hit.album || '').trim()) it.album = String(hit.album || '').trim();
        it.mbTrackId = String(hit.mbTrackId || '').trim();
        it.mbAlbumId = String(hit.mbAlbumId || '').trim();
        it.mbArtistId = String(hit.mbArtistId || '').trim();
        it.art = String(hit.art || '').trim() || it.art;
      }

      const out = items.map((x) => ({ ...x, art: String(x.art || '').trim() || '/icons/icon-192.png' }));
      return res.json({ ok: true, username, period, items: out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/lastfm/recent-tracks', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const apiKey = String(process.env.LASTFM_API_KEY || cfg?.lastfm?.apiKey || '').trim();
      const username = String(cfg?.lastfm?.username || '').trim();
      if (!apiKey || !username) {
        const fallback = await localHistoryFallback(req, {
          kind: 'recent-tracks',
          limit: Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18)),
        });
        if (fallback) return res.json(fallback);
      }
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      if (!username) return res.status(400).json({ ok: false, error: 'Last.fm username is not configured' });

      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18));
      const url = new URL('https://ws.audioscrobbler.com/2.0/');
      url.searchParams.set('method', 'user.getrecenttracks');
      url.searchParams.set('user', username);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('extended', '0');

      const r = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      const rows = Array.isArray(j?.recenttracks?.track) ? j.recenttracks.track : [];

      const mpdHost = String(cfg?.mpd?.host || process.env.MPD_HOST || MPD_HOST || 'localhost').trim();
      const trackKey = String(process.env.TRACK_KEY || cfg?.trackKey || '').trim();
      const hostHdr = String(req.get('host') || '').trim();
      const baseUrl = hostHdr ? `${req.protocol || 'http'}://${hostHdr}` : '';

      const resolver = await createLastfmIndexResolver({ mpdHost, baseUrl, trackKey });
      const items = [];
      for (const x of rows) {
        const track = String(x?.name || '').trim();
        const artist = String(x?.artist?.['#text'] || x?.artist?.name || '').trim();
        if (!track) continue;
        const hit = resolver.resolveTrack({ track, artist });
        items.push({
          kind: 'lastfm-track',
          title: track,
          track,
          artist,
          album: String(hit?.album || x?.album?.['#text'] || '').trim(),
          file: String(hit?.file || '').trim(),
          mbTrackId: String(hit?.mbTrackId || '').trim(),
          mbAlbumId: String(hit?.mbAlbumId || '').trim(),
          mbArtistId: String(hit?.mbArtistId || '').trim(),
          url: String(x?.url || '').trim(),
          art: String(hit?.art || '').trim() || '/icons/icon-192.png',
        });
      }

      return res.json({ ok: true, username, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/lastfm/top-artists', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const apiKey = String(process.env.LASTFM_API_KEY || cfg?.lastfm?.apiKey || '').trim();
      const username = String(cfg?.lastfm?.username || '').trim();
      if (!apiKey || !username) {
        const fallback = await localHistoryFallback(req, {
          kind: 'top-artists',
          limit: Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18)),
          period: String(req.query?.period || cfg?.lastfm?.period || 'overall').trim().toLowerCase(),
        });
        if (fallback) return res.json(fallback);
      }
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      if (!username) return res.status(400).json({ ok: false, error: 'Last.fm username is not configured' });

      const period = String(req.query?.period || cfg?.lastfm?.period || '1month').trim().toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18));
      const url = new URL('https://ws.audioscrobbler.com/2.0/');
      url.searchParams.set('method', 'user.gettopartists');
      url.searchParams.set('user', username);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('format', 'json');
      url.searchParams.set('period', period);
      url.searchParams.set('limit', String(limit));

      const r = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      const rows = Array.isArray(j?.topartists?.artist) ? j.topartists.artist : [];
      const mpdHost = String(cfg?.mpd?.host || process.env.MPD_HOST || MPD_HOST || 'localhost').trim();
      const trackKey = String(process.env.TRACK_KEY || cfg?.trackKey || '').trim();
      const hostHdr = String(req.get('host') || '').trim();
      const baseUrl = hostHdr ? `${req.protocol || 'http'}://${hostHdr}` : '';

      const resolver = await createLastfmIndexResolver({ mpdHost, baseUrl, trackKey });
      const items = [];
      for (const x of rows) {
        const artist = String(x?.name || '').trim();
        const playcount = Number(x?.playcount || 0) || 0;
        const hit = resolver.resolveArtist({ artist });
        items.push({
          kind: 'lastfm-artist',
          title: artist || '(artist)',
          artist,
          playcount,
          file: String(hit?.file || '').trim(),
          mbTrackId: String(hit?.mbTrackId || '').trim(),
          mbAlbumId: String(hit?.mbAlbumId || '').trim(),
          mbArtistId: String(hit?.mbArtistId || '').trim(),
          url: String(x?.url || '').trim(),
          art: String(hit?.art || '').trim() || '/icons/icon-192.png',
        });
      }

      return res.json({ ok: true, username, period, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/lastfm/top-albums', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const apiKey = String(process.env.LASTFM_API_KEY || cfg?.lastfm?.apiKey || '').trim();
      const username = String(cfg?.lastfm?.username || '').trim();
      if (!apiKey || !username) {
        const fallback = await localHistoryFallback(req, {
          kind: 'top-albums',
          limit: Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18)),
          period: String(req.query?.period || cfg?.lastfm?.period || 'overall').trim().toLowerCase(),
        });
        if (fallback) return res.json(fallback);
      }
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Last.fm API key is not configured' });
      if (!username) return res.status(400).json({ ok: false, error: 'Last.fm username is not configured' });

      const period = String(req.query?.period || cfg?.lastfm?.period || '1month').trim().toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 18) || 18));
      const url = new URL('https://ws.audioscrobbler.com/2.0/');
      url.searchParams.set('method', 'user.gettopalbums');
      url.searchParams.set('user', username);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('format', 'json');
      url.searchParams.set('period', period);
      url.searchParams.set('limit', String(limit));

      const r = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      const rows = Array.isArray(j?.topalbums?.album) ? j.topalbums.album : [];

      const mpdHost = String(cfg?.mpd?.host || process.env.MPD_HOST || MPD_HOST || 'localhost').trim();
      const trackKey = String(process.env.TRACK_KEY || cfg?.trackKey || '').trim();
      const hostHdr = String(req.get('host') || '').trim();
      const baseUrl = hostHdr ? `${req.protocol || 'http'}://${hostHdr}` : '';

      const resolver = await createLastfmIndexResolver({ mpdHost, baseUrl, trackKey });
      const items = [];
      for (const x of rows) {
        const album = String(x?.name || '').trim();
        const artist = String(x?.artist?.name || '').trim();
        const playcount = Number(x?.playcount || 0) || 0;
        const hit = resolver.resolveAlbum({ album, artist });
        items.push({
          kind: 'lastfm-album',
          title: album || '(album)',
          album,
          artist,
          playcount,
          file: String(hit?.file || '').trim(),
          mbTrackId: String(hit?.mbTrackId || '').trim(),
          mbAlbumId: String(hit?.mbAlbumId || '').trim(),
          mbArtistId: String(hit?.mbArtistId || '').trim(),
          url: String(x?.url || '').trim(),
          art: String(hit?.art || '').trim() || '/icons/icon-192.png',
        });
      }

      return res.json({ ok: true, username, period, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/peppy/last-profile', async (_req, res) => {
    try {
      const raw = await fs.readFile(peppyLastPushPath, 'utf8');
      const j = JSON.parse(raw || '{}');
      return res.json({ ok: true, profile: j });
    } catch {
      return res.json({ ok: true, profile: null });
    }
  });

  app.get('/peppy/live', async (req, res) => {
    try {
      const hostHdr = String(req.get('host') || '').trim().replace(/:\d+$/, '') || 'localhost';
      const fallback = `http://${hostHdr}:8101/display.html?kiosk=1`;
      const raw = await fs.readFile(peppyLastPushPath, 'utf8').catch(() => '');
      const j = raw ? JSON.parse(raw) : null;
      const url = String(j?.url || '').trim() || fallback;
      return res.redirect(302, url);
    } catch {
      const hostHdr = String(req.get('host') || '').trim().replace(/:\d+$/, '') || 'localhost';
      return res.redirect(302, `http://${hostHdr}:8101/display.html?kiosk=1`);
    }
  });

  app.post('/peppy/last-profile', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const visIn = (req.body && typeof req.body.visualizer === 'object') ? req.body.visualizer : {};
      const visPreset = String(visIn?.preset || '').trim().toLowerCase();
      const visEnergy = Number(visIn?.energy);
      const visMotion = Number(visIn?.motion);
      const visGlow = Number(visIn?.glow);
      const incoming = {
        url: String(req.body?.url || '').trim(),
        skin: String(req.body?.skin || '').trim(),
        theme: String(req.body?.theme || '').trim(),
        meterType: String(req.body?.meterType || '').trim(),
        fontMode: String(req.body?.fontMode || '').trim(),
        fontSize: String(req.body?.fontSize || '').trim(),
        linearStyle: String(req.body?.linearStyle || '').trim(),
        linearSize: String(req.body?.linearSize || '').trim(),
        meterMode: String(req.body?.meterMode || '').trim(),
        colorMode: String(req.body?.colorMode || '').trim(),
        spectrumColor: String(req.body?.spectrumColor || '').trim(),
        spectrumEnergy: ['off','low','medium','high'].includes(String(req.body?.spectrumEnergy || '').trim()) ? String(req.body?.spectrumEnergy || '').trim() : '',
        spectrumPeak: ['off','short','medium','long','hold'].includes(String(req.body?.spectrumPeak || '').trim()) ? String(req.body?.spectrumPeak || '').trim() : '',
        sensitivity: ['low','medium','high','ultra'].includes(String(req.body?.sensitivity || '').trim()) ? String(req.body?.sensitivity || '').trim() : '',
        smoothing: ['off','low','medium','high'].includes(String(req.body?.smoothing || '').trim()) ? String(req.body?.smoothing || '').trim() : '',
        normalization: Number(req.body?.normalization),
        displayMode: String(req.body?.displayMode || '').trim(),
        playerSize: String(req.body?.playerSize || '').trim(),
        visualizer: {
          preset: visPreset || '',
          energy: Number.isFinite(visEnergy) ? Math.max(1, Math.min(10, visEnergy)) : NaN,
          motion: Number.isFinite(visMotion) ? Math.max(1, Math.min(10, visMotion)) : NaN,
          glow: Number.isFinite(visGlow) ? Math.max(1, Math.min(10, visGlow)) : NaN,
        },
      };
      let prev = {};
      try {
        const rawPrev = await fs.readFile(peppyLastPushPath, 'utf8');
        prev = JSON.parse(rawPrev || '{}') || {};
      } catch {}
      const merged = {
        url: incoming.url || String(prev?.url || '').trim() || 'http://sonuvi.local:8101/display.html?kiosk=1',
        skin: incoming.skin || String(prev?.skin || '').trim() || 'blue-1280',
        theme: incoming.theme || String(prev?.theme || '').trim() || 'midnight-blue',
        meterType: incoming.meterType || String(prev?.meterType || '').trim() || 'circular',
        fontMode: incoming.fontMode || String(prev?.fontMode || '').trim() || 'ui-sans',
        fontSize: incoming.fontSize || String(prev?.fontSize || '').trim() || 'm',
        linearStyle: incoming.linearStyle || String(prev?.linearStyle || '').trim() || 'continuous',
        linearSize: incoming.linearSize || String(prev?.linearSize || '').trim() || 'm',
        meterMode: incoming.meterMode || String(prev?.meterMode || '').trim() || 'segmented',
        colorMode: incoming.colorMode || String(prev?.colorMode || '').trim() || 'classic',
        spectrumColor: incoming.spectrumColor || String(prev?.spectrumColor || '').trim() || 'theme',
        spectrumEnergy: incoming.spectrumEnergy || String(prev?.spectrumEnergy || '').trim() || 'medium',
        spectrumPeak: incoming.spectrumPeak || String(prev?.spectrumPeak || '').trim() || 'medium',
        sensitivity: incoming.sensitivity || String(prev?.sensitivity || '').trim() || 'medium',
        smoothing: incoming.smoothing || String(prev?.smoothing || '').trim() || 'low',
        normalization: Number.isFinite(incoming.normalization) && incoming.normalization > 0 ? incoming.normalization : (Number(prev?.normalization) > 0 ? Number(prev.normalization) : 100),
        displayMode: incoming.displayMode || String(prev?.displayMode || '').trim() || 'peppy',
        playerSize: incoming.playerSize || String(prev?.playerSize || '').trim() || '1280x400',
        visualizer: {
          preset: incoming.visualizer.preset || String(prev?.visualizer?.preset || '').trim() || 'classic',
          energy: Number.isFinite(incoming.visualizer.energy) ? incoming.visualizer.energy : (Number.isFinite(Number(prev?.visualizer?.energy)) ? Math.max(1, Math.min(10, Number(prev.visualizer.energy))) : 6),
          motion: Number.isFinite(incoming.visualizer.motion) ? incoming.visualizer.motion : (Number.isFinite(Number(prev?.visualizer?.motion)) ? Math.max(1, Math.min(10, Number(prev.visualizer.motion))) : 6),
          glow: Number.isFinite(incoming.visualizer.glow) ? incoming.visualizer.glow : (Number.isFinite(Number(prev?.visualizer?.glow)) ? Math.max(1, Math.min(10, Number(prev.visualizer.glow))) : 6),
        },
        ts: Date.now(),
      };
      await fs.mkdir(path.dirname(peppyLastPushPath), { recursive: true });
      await fs.writeFile(peppyLastPushPath, JSON.stringify(merged, null, 2));
      return res.json({ ok: true, profile: merged });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/runtime/resolve-host', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const host = String(req.body?.host || '').trim();
      if (!host) return res.status(400).json({ ok: false, error: 'host is required' });
      const r = await dnsLookup(host, { family: 4 });
      return res.json({ ok: true, host, address: String(r?.address || ''), family: Number(r?.family || 4) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/runtime/check-env', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const mpdHost = String(req.body?.mpdHost || MPD_HOST || 'moode.local').trim();
      const mpdPort = Math.max(1, Math.min(65535, Number(req.body?.mpdPort || 6600) || 6600));
      const sshHost = String(req.body?.sshHost || MOODE_SSH_HOST || mpdHost || 'moode.local').trim();
      const sshUser = String(req.body?.sshUser || MOODE_SSH_USER || 'moode').trim();
      const paths = req.body?.paths || {};

      let sshOk = false;
      let mpdOk = false;
      let sshError = '';
      let mpdError = '';

      try {
        await sshBashLc({ user: sshUser, host: sshHost, script: 'echo ok', timeoutMs: 8000 });
        sshOk = true;
      } catch (e) {
        sshError = e?.message || String(e);
      }

      try {
        await execFileP('mpc', ['-h', mpdHost, '-p', String(mpdPort), 'status'], { timeout: 8000 });
        mpdOk = true;
      } catch (e) {
        mpdError = e?.message || String(e);
      }

      const checks = [
        ['musicLibraryRoot', String(paths.musicLibraryRoot || '')],
        ['moodeUsbMount', String(paths.moodeUsbMount || '')],
        ['piMountBase', String(paths.piMountBase || '')],
        ['podcastRoot', String(paths.podcastRoot || '')],
      ].filter(([, p]) => !!p.trim());

      const pathChecks = [];
      for (const [name, p] of checks) {
        let exists = false;
        try {
          const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script: `if [ -d ${shQuoteArg(p)} ] || [ -f ${shQuoteArg(p)} ]; then echo YES; else echo NO; fi`, timeoutMs: 6000 });
          exists = String(stdout || '').includes('YES');
        } catch (_) {}
        pathChecks.push({ name, path: p, exists });
      }

      return res.json({ ok: true, sshOk, mpdOk, sshError, mpdError, pathChecks, mpdHost, mpdPort, sshHost, sshUser });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/runtime/ensure-podcast-root', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const sshHost = String(req.body?.sshHost || MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
      const sshUser = String(req.body?.sshUser || MOODE_SSH_USER || 'moode').trim();
      const podcastRoot = String(req.body?.podcastRoot || '').trim();
      if (!podcastRoot) return res.status(400).json({ ok: false, error: 'podcastRoot is required' });

      const pQ = shQuoteArg(podcastRoot);
      const script = [
        `sudo install -d -m 0775 ${pQ}`,
        `if [ -d ${pQ} ]; then echo OK; else echo FAIL; fi`,
      ].join('; ');

      const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 });
      const ok = String(stdout || '').includes('OK');
      if (!ok) return res.status(500).json({ ok: false, error: `Unable to create ${podcastRoot}` });
      return res.json({ ok: true, podcastRoot, created: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/services/mpdscribble/status', async (req, res) => {
    try {
      let cfg = {};
      try {
        cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      } catch {}
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const status = await getMpdscribbleStatus({ user: sshUser, host: sshHost });
      return res.json(status);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/services/mpdscribble/action', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const action = String(req.body?.action || '').trim().toLowerCase();
      if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ ok: false, error: 'action must be start|stop|restart' });
      }

      let cfg = {};
      try {
        cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      } catch {}

      const controlsEnabled = Boolean(cfg?.features?.mpdscribbleControl ?? false);
      if (!controlsEnabled) {
        return res.status(403).json({ ok: false, error: 'mpdscribble controls are disabled in config features' });
      }

      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const cmd = `sudo -n systemctl ${action} mpdscribble.service || systemctl ${action} mpdscribble.service`;
      await sshBashLc({ user: sshUser, host: sshHost, script: cmd, timeoutMs: 15000 });
      const status = await getMpdscribbleStatus({ user: sshUser, host: sshHost });
      return res.json({ ok: true, action, ...status });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/alexa/check-domain', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      let domain = String(req.body?.domain || '').trim();
      if (!domain) return res.status(400).json({ ok: false, error: 'domain is required' });

      if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`;
      let u;
      try { u = new URL(domain); } catch { return res.status(400).json({ ok: false, error: 'invalid domain/url' }); }

      const target = `${u.origin}/now-playing`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);

      let reachable = false;
      let statusCode = 0;
      let errMsg = '';
      try {
        const r = await fetch(target, { method: 'GET', signal: ctrl.signal });
        statusCode = Number(r.status || 0);
        reachable = r.ok || (statusCode >= 200 && statusCode < 500);
      } catch (e) {
        errMsg = e?.message || String(e);
      } finally {
        clearTimeout(t);
      }

      return res.json({ ok: true, domain: u.hostname, url: target, reachable, statusCode, error: errMsg || '' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/runtime', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const incoming = req.body?.config;
      const fullIncoming = req.body?.fullConfig;
      if ((!incoming || typeof incoming !== 'object') && (!fullIncoming || typeof fullIncoming !== 'object')) {
        return res.status(400).json({ ok: false, error: 'Missing JSON body { config: {...} } or { fullConfig: {...} }' });
      }

      let current = {};
      try {
        current = JSON.parse(await fs.readFile(configPath, 'utf8'));
      } catch {}

      const next = (fullIncoming && typeof fullIncoming === 'object')
        ? fullIncoming
        : {
            ...current,
            ...incoming,
            alexa: {
              ...(current.alexa || {}),
              ...(incoming.alexa || {}),
              artistAliases: (incoming?.alexa && Object.prototype.hasOwnProperty.call(incoming.alexa, 'artistAliases'))
                ? (incoming.alexa.artistAliases || {})
                : ((current.alexa || {}).artistAliases || {}),
              albumAliases: (incoming?.alexa && Object.prototype.hasOwnProperty.call(incoming.alexa, 'albumAliases'))
                ? (incoming.alexa.albumAliases || {})
                : ((current.alexa || {}).albumAliases || {}),
              playlistAliases: (incoming?.alexa && Object.prototype.hasOwnProperty.call(incoming.alexa, 'playlistAliases'))
                ? (incoming.alexa.playlistAliases || {})
                : ((current.alexa || {}).playlistAliases || {}),
              unresolvedArtists: Array.isArray(incoming?.alexa?.unresolvedArtists)
                ? incoming.alexa.unresolvedArtists
                : ((current.alexa || {}).unresolvedArtists || []),
              heardArtists: Array.isArray(incoming?.alexa?.heardArtists)
                ? incoming.alexa.heardArtists
                : ((current.alexa || {}).heardArtists || []),
              unresolvedAlbums: Array.isArray(incoming?.alexa?.unresolvedAlbums)
                ? incoming.alexa.unresolvedAlbums
                : ((current.alexa || {}).unresolvedAlbums || []),
              heardAlbums: Array.isArray(incoming?.alexa?.heardAlbums)
                ? incoming.alexa.heardAlbums
                : ((current.alexa || {}).heardAlbums || []),
              unresolvedPlaylists: Array.isArray(incoming?.alexa?.unresolvedPlaylists)
                ? incoming.alexa.unresolvedPlaylists
                : ((current.alexa || {}).unresolvedPlaylists || []),
              heardPlaylists: Array.isArray(incoming?.alexa?.heardPlaylists)
                ? incoming.alexa.heardPlaylists
                : ((current.alexa || {}).heardPlaylists || []),
            },
            ports: { ...(current.ports || {}), ...(incoming.ports || {}) },
            paths: { ...(current.paths || {}), ...(incoming.paths || {}) },
            display: { ...(current.display || {}), ...(incoming.display || {}) },
            notifications: {
              ...(current.notifications || {}),
              ...(incoming.notifications || {}),
              trackNotify: {
                ...((current.notifications || {}).trackNotify || {}),
                ...((incoming.notifications || {}).trackNotify || {}),
              },
              pushover: {
                ...((current.notifications || {}).pushover || {}),
                ...((incoming.notifications || {}).pushover || {}),
              },
              apns: {
                ...((current.notifications || {}).apns || {}),
                ...((incoming.notifications || {}).apns || {}),
              },
            },
          };

      if (next.moode && typeof next.moode === 'object') {
        const moodeHost = String(next.moode.sshHost || next.mpd?.host || next.mpd?.hostname || MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
        const moodeBaseRaw = String(next.moode.baseUrl || '').trim();
        next.moode = {
          ...next.moode,
          baseUrl: moodeBaseRaw ? normalizeMoodeBaseUrl(moodeBaseRaw, moodeHost) : '',
        };
      }

      const errs = validateConfigShape(next);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

      await fs.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      log.debug('[config/runtime] updated', { configPath });

      const cfgLastfm = String(next?.lastfm?.apiKey || '').trim();
      if (cfgLastfm) process.env.LASTFM_API_KEY = cfgLastfm;

      return res.json({
        ok: true,
        message: 'Config saved. Environment overrides still take precedence; an administrator may need to restart both Sonuvi services.',
        config: withEnvOverrides(next),
        fullConfig: next,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  registerSonuviRestartRoutes(app, { requireTrackKey, execFileP });

  app.get('/config/moode/display/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = "db=/var/local/www/db/moode-sqlite3.db; if [ -f \"$db\" ]; then sqlite3 \"$db\" \"select value from cfg_system where param='peppy_display' limit 1;\"; else echo ''; fi";
      const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 });
      const raw = String(stdout || '').trim();
      const mode = (raw === '1' || /^on$/i.test(raw)) ? 'peppy' : 'webui';
      return res.json({ ok: true, mode, raw, sshHost, sshUser });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/moode/peppymeter/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = "pgrep -af 'peppymeter|PeppyMeter|peppy_meter' >/tmp/np-peppy-ps.txt 2>&1 || true; "
        + "cnt=$(grep -c . /tmp/np-peppy-ps.txt 2>/dev/null || echo 0); "
        + "if [ \"$cnt\" -gt 0 ]; then echo RUNNING:1; else echo RUNNING:0; fi; "
        + "echo COUNT:$cnt; cat /tmp/np-peppy-ps.txt 2>/dev/null || true";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 });
      const out = String(stdout || '');
      const running = /RUNNING:1/.test(out);
      const count = Number((out.match(/COUNT:(\d+)/)?.[1] || '0')) || 0;
      const lines = out
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter((s) => s && !/^RUNNING:|^COUNT:/.test(s));
      return res.json({ ok: true, sshHost, sshUser, running, count, duplicate: count > 1, processes: lines.slice(0, 20), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/peppymeter/start', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = "pgrep -af 'peppymeter|PeppyMeter|peppy_meter' >/tmp/np-peppy-ps-before.txt 2>&1 || true; "
        + "beforeCnt=$(grep -c . /tmp/np-peppy-ps-before.txt 2>/dev/null || echo 0); "
        + "echo BEFORE:$([ \"$beforeCnt\" -gt 0 ] && echo 1 || echo 0); echo BEFORE_COUNT:$beforeCnt; "
        + "if [ \"$beforeCnt\" -gt 1 ]; then pkill -f 'peppymeter|PeppyMeter|peppy_meter' >/tmp/np-peppy-kill.log 2>&1 || true; sleep 1; fi; "
        + "(sudo -n systemctl restart peppymeter.service || sudo -n systemctl restart peppymeter || systemctl restart peppymeter.service || systemctl restart peppymeter || true) >/tmp/np-peppy-start.log 2>&1; "
        + "sleep 1; pgrep -af 'peppymeter|PeppyMeter|peppy_meter' >/tmp/np-peppy-ps-after.txt 2>&1 || true; "
        + "afterCnt=$(grep -c . /tmp/np-peppy-ps-after.txt 2>/dev/null || echo 0); "
        + "echo AFTER:$([ \"$afterCnt\" -gt 0 ] && echo 1 || echo 0); echo AFTER_COUNT:$afterCnt; "
        + "echo START_LOG_BEGIN; cat /tmp/np-peppy-start.log 2>/dev/null || true; echo START_LOG_END; cat /tmp/np-peppy-ps-after.txt 2>/dev/null || true";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 15000 });
      const out = String(stdout || '');
      const beforeRunning = /BEFORE:1/.test(out);
      const running = /AFTER:1/.test(out);
      const beforeCount = Number((out.match(/BEFORE_COUNT:(\d+)/)?.[1] || '0')) || 0;
      const count = Number((out.match(/AFTER_COUNT:(\d+)/)?.[1] || '0')) || 0;
      const psLines = out
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter((s) => s && !/^BEFORE:|^AFTER:|^BEFORE_COUNT:|^AFTER_COUNT:|^START_LOG_BEGIN$|^START_LOG_END$/.test(s));
      return res.json({ ok: true, sshHost, sshUser, beforeRunning, beforeCount, running, count, duplicate: count > 1, processes: psLines.slice(0, 20), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/moode/peppyalsa/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = "echo PEPPYALSA:$(sudo -n moodeutl -d -gv enable_peppyalsa 2>/dev/null || true); echo ALSA_LOOPBACK:$(sudo -n moodeutl -d -gv alsa_loopback 2>/dev/null || true)";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 10000 });
      const out = String(stdout || '');
      const peppyAlsaRaw = (out.match(/PEPPYALSA:([^\r\n]*)/)?.[1] || '').trim();
      const alsaLoopbackRaw = (out.match(/ALSA_LOOPBACK:([^\r\n]*)/)?.[1] || '').trim();
      const enabled = peppyAlsaRaw === '1';
      return res.json({ ok: true, sshHost, sshUser, enabled, peppyAlsaRaw, alsaLoopbackRaw, stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/peppyalsa/ensure', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = "before=$(sudo -n moodeutl -d -gv enable_peppyalsa 2>/dev/null || true); "
        + "echo BEFORE:$before; "
        + "if [ \"$before\" != \"1\" ]; then "
        + "  c=$(mktemp); "
        + "  curl -fsS -c \"$c\" http://localhost/per-config.php >/dev/null 2>&1 || true; "
        + "  curl -fsS -b \"$c\" -c \"$c\" -X POST -d 'enable_peppyalsa=1&update_enable_peppyalsa=novalue' http://localhost/per-config.php >/tmp/np-peppyalsa-post.log 2>&1 || true; "
        + "  rm -f \"$c\"; "
        + "  sleep 1; "
        + "fi; "
        + "after=$(sudo -n moodeutl -d -gv enable_peppyalsa 2>/dev/null || true); "
        + "loop=$(sudo -n moodeutl -d -gv alsa_loopback 2>/dev/null || true); "
        + "echo AFTER:$after; echo LOOPBACK:$loop; "
        + "echo POST_LOG_BEGIN; cat /tmp/np-peppyalsa-post.log 2>/dev/null || true; echo POST_LOG_END";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 15000 });
      const out = String(stdout || '');
      const beforeRaw = (out.match(/BEFORE:([^\r\n]*)/)?.[1] || '').trim();
      const afterRaw = (out.match(/AFTER:([^\r\n]*)/)?.[1] || '').trim();
      const loopbackRaw = (out.match(/LOOPBACK:([^\r\n]*)/)?.[1] || '').trim();
      const enabled = afterRaw === '1';
      return res.json({ ok: enabled, sshHost, sshUser, beforeRaw, afterRaw, loopbackRaw, changed: beforeRaw !== afterRaw, stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/display', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const mode = String(req.body?.mode || '').trim().toLowerCase();
      if (!['peppy', 'webui'].includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode must be peppy or webui' });
      }

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const moodeBaseRaw = String(cfg?.moode?.baseUrl || '').trim();
      const mpdHost = String(cfg?.mpd?.host || MPD_HOST || 'moode.local').trim();
      const moodeBase = normalizeMoodeBaseUrl(moodeBaseRaw, mpdHost);
      const cmd = encodeURIComponent(`set_display ${mode}`);
      const baseNoSlash = moodeBase.replace(/\/$/, '');
      const urls = [
        `${baseNoSlash}/command/?cmd=${cmd}`,
        `${baseNoSlash}/command/?cmd=set_display ${mode}`,
        `${baseNoSlash}/command/?cmd=set_display%20${mode}`,
      ];

      let okResp = null;
      const attempts = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { method: 'GET' });
          const txt = await r.text().catch(() => '');
          attempts.push({ url, status: r.status, body: String(txt || '').slice(0, 200) });
          if (r.ok) {
            okResp = { url, status: r.status, body: txt };
            break;
          }
        } catch (e) {
          attempts.push({ url, status: 0, body: e?.message || String(e) });
        }
      }

      if (!okResp) return res.status(502).json({ ok: false, error: 'moode command failed', moodeBase, attempts });

      // Enforce display-mode side effects over SSH because some moOde builds
      // accept set_display but leave localdisplay/chromium running.
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      let enforce = { ran: false, stdout: '', stderr: '' };
      if (sshHost) {
        const script = mode === 'peppy'
          ? "sudo -n systemctl stop localdisplay.service >/tmp/np-display-enforce.log 2>&1 || true; sudo -n systemctl stop peppy-spectrum-bridge.service >>/tmp/np-display-enforce.log 2>&1 || true; sudo -n pkill -f '/opt/peppyspectrum/spectrum.py' >>/tmp/np-display-enforce.log 2>&1 || true; sudo -n bash -lc 'cd /opt/peppyspectrum; nohup python3 /opt/peppyspectrum/spectrum.py >>/tmp/np-display-enforce.log 2>&1 &' || true; sleep 1; echo CFG:$(moodeutl -q \"SELECT value FROM cfg_system WHERE param='peppy_display';\" | tail -n1); echo CHROM:$(pgrep -c -f '[c]hromium-browser --enable-pinch --app=' || true); echo SPECTRUM:$(pgrep -c -f '/opt/peppyspectrum/spectrum.py' || true); tail -n 30 /tmp/np-display-enforce.log || true"
          : "sudo -n pkill -f '/opt/peppyspectrum/spectrum.py' >/tmp/np-display-enforce.log 2>&1 || true; sudo -n systemctl start peppy-spectrum-bridge.service >>/tmp/np-display-enforce.log 2>&1 || true; sudo -n systemctl start localdisplay.service >>/tmp/np-display-enforce.log 2>&1 || true; sleep 1; echo CFG:$(moodeutl -q \"SELECT value FROM cfg_system WHERE param='local_display';\" | tail -n1); echo CHROM:$(pgrep -c -f '[c]hromium-browser --enable-pinch --app=' || true); echo SPECTRUM:$(pgrep -c -f '/opt/peppyspectrum/spectrum.py' || true); tail -n 30 /tmp/np-display-enforce.log || true";
        const r = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 18000 }).catch(() => ({ stdout: '', stderr: '' }));
        enforce = { ran: true, stdout: String(r?.stdout || '').trim(), stderr: String(r?.stderr || '').trim() };
      }

      return res.json({ ok: true, mode, moodeBase, url: okResp.url, response: String(okResp.body || '').slice(0, 300), attempts, enforce });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/native-peppy', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const moodeBaseRaw = String(cfg?.moode?.baseUrl || '').trim();
      const mpdHost = String(cfg?.mpd?.host || MPD_HOST || 'moode.local').trim();
      const moodeBase = normalizeMoodeBaseUrl(moodeBaseRaw, mpdHost);
      const baseNoSlash = moodeBase.replace(/\/$/, '');

      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();

      // Guard: native peppy will show black screen if output.display = False.
      if (sshHost) {
        const g = await sshBashLc({
          user: sshUser,
          host: sshHost,
          script: "grep -E '^output\.display\s*=\s*' /etc/peppymeter/config.txt | tail -n 1 || true",
          timeoutMs: 8000,
        }).catch(() => ({ stdout: '', stderr: '' }));
        const line = String(g?.stdout || '').trim();
        if (/=\s*false\s*$/i.test(line)) {
          return res.status(409).json({
            ok: false,
            error: 'native peppy blocked: /etc/peppymeter/config.txt has output.display = False',
            guard: { config: '/etc/peppymeter/config.txt', line },
          });
        }
      }

      await fetch(`${baseNoSlash}/command/?cmd=set_display%20peppy`, { method: 'GET' }).catch(() => null);
      await fetch(`${baseNoSlash}/command/?cmd=restart_local_display`, { method: 'GET' }).catch(() => null);

      let killOut = '';
      if (sshHost) {
        const k = await sshBashLc({ user: sshUser, host: sshHost, script: "pkill -f chromium-browser || true; sleep 1; pgrep -af chromium-browser || true", timeoutMs: 12000 }).catch(() => ({ stdout: '', stderr: '' }));
        killOut = `${String(k?.stdout || '').trim()} ${String(k?.stderr || '').trim()}`.trim();
      }
      return res.json({ ok: true, moodeBase, sshHost, sshUser, killOut });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/browser', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const target = String(req.body?.target || '').trim().toLowerCase();
      if (!['nowplaying', 'webui'].includes(target)) {
        return res.status(400).json({ ok: false, error: 'target must be nowplaying or webui' });
      }

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHdr = String(req.get('host') || '').trim();
      const appHost = hostHdr.replace(/:\d+$/, '') || 'localhost';
      const stamp = Date.now();
      const nowPlayingUrl = `http://${appHost}:8101/index.html?sw=${stamp}`;
      const webUiUrl = `http://localhost/?sw=${stamp}`;
      const url = target === 'nowplaying' ? nowPlayingUrl : webUiUrl;

      const pre = target === 'webui'
        ? `curl -fsS 'http://localhost/command/?cmd=set_display%20webui' >/dev/null 2>&1 || true; `
        : '';
      const post = target === 'webui'
        ? `; curl -sG --data-urlencode 'cmd=restart_local_display' http://localhost/command/ >/dev/null 2>&1 || true`
        : '';
      const script = `${pre}DISPLAY=:0 chromium-browser ${shQuoteArg(url)} >/tmp/chromium-switch.log 2>&1 & disown; sleep 1${post}; tail -n 12 /tmp/chromium-switch.log || true`;
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 14000 });
      return res.json({ ok: true, target, url, sshHost, sshUser, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/moode/browser-url/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });
      const script = "APP_LINE=$(grep -E -- '--app=' /home/moode/.xinitrc | tail -n 1 || true); RUN_LINE=$(pgrep -af 'chromium-browser.*--app=' | head -n 1 || true); echo \"APP_LINE:$APP_LINE\"; echo \"RUN_LINE:$RUN_LINE\"";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 9000 });
      const out = String(stdout || '');
      const appLine = (out.match(/APP_LINE:(.*)/) || [,''])[1].trim();
      const runLine = (out.match(/RUN_LINE:(.*)/) || [,''])[1].trim();
      const appUrl = (appLine.match(/--app=\"([^\"]+)\"/) || appLine.match(/--app=([^\s]+)/) || [,''])[1].trim();
      const runUrl = (runLine.match(/--app=\"([^\"]+)\"/) || runLine.match(/--app=([^\s]+)/) || [,''])[1].trim();
      return res.json({ ok: true, sshHost, sshUser, appLine, runLine, appUrl, runUrl, stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/browser-url', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const rawUrl = String(req.body?.url || '').trim();
      if (!/^https?:\/\//i.test(rawUrl)) {
        return res.status(400).json({ ok: false, error: 'url must start with http:// or https://' });
      }

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const script = `python3 - <<'PY'\nfrom pathlib import Path\nimport re\np=Path('/home/moode/.xinitrc')\nurl=${shQuoteArg(rawUrl)}\ntry:\n    s=p.read_text()\n    # Normalize any malformed/duplicated --app token to exactly one URL.\n    # Handles forms like: --app="u""u" ... and unquoted --app=u\n    s2=re.sub(r'--app="[^"]*"(?:"[^"]*")+', f'--app="{url}"', s)\n    s2=re.sub(r'--app="[^"]*"', f'--app="{url}"', s2)\n    s2=re.sub(r'--app=[^\\s\\\\]+', f'--app="{url}"', s2)\n    p.write_text(s2)\nexcept Exception:\n    pass\nprint('xinitrc updated')\nPY\n# Restart local display (authoritative)\nsudo -n systemctl restart localdisplay.service >/tmp/chromium-switch.log 2>&1 || true\nsleep 2\ntail -n 20 /tmp/chromium-switch.log || true`;
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 18000 });
      const verifyScript = `APP_LINE=$(grep -E -- '--app=' /home/moode/.xinitrc | tail -n 1 || true); RUN_LINE=$(pgrep -af '/usr/lib/chromium-browser/chromium-browser .*--app=' | grep -F -- ${shQuoteArg(rawUrl)} | head -n 1 || true); echo "APP_LINE:$APP_LINE"; echo "RUN_LINE:$RUN_LINE"`;
      const v = await sshBashLc({ user: sshUser, host: sshHost, script: verifyScript, timeoutMs: 10000 }).catch(() => ({ stdout: '', stderr: '' }));
      const vOut = String(v?.stdout || '');
      const verified = vOut.includes('RUN_LINE:') && !/RUN_LINE:\s*$/.test(vOut);
      try {
        const u = new URL(rawUrl);
        const skin = String(u.searchParams.get('skin') || '').trim();
        const theme = String(u.searchParams.get('theme') || '').trim();
        let prev = {};
        try {
          const rawPrev = await fs.readFile(peppyLastPushPath, 'utf8');
          prev = JSON.parse(rawPrev || '{}') || {};
        } catch {}
        await fs.mkdir(path.dirname(peppyLastPushPath), { recursive: true });
        await fs.writeFile(peppyLastPushPath, JSON.stringify({
          ...prev,
          url: rawUrl,
          skin: skin || String(prev?.skin || '').trim(),
          theme: theme || String(prev?.theme || '').trim(),
          ts: Date.now(),
        }, null, 2));
      } catch {}
      return res.json({ ok: true, url: rawUrl, effectiveUrl: rawUrl, verified, sshHost, sshUser, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), verify: vOut.trim(), verifyErr: String(v?.stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/moode/peppy-vumeter-target/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHeader = String(req.headers?.host || '').trim();
      const hostNoPort = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
      const apiHost = String(cfg?.apiHost || cfg?.apiNodeIp || hostNoPort || req.hostname || '').trim();
      if (!apiHost) return res.status(400).json({ ok: false, error: 'Could not determine API host. Set apiHost (or apiNodeIp) in Config.' });
      const apiPort = Number(cfg?.ports?.api || 3101) || 3101;
      const expectedTargetUrl = `http://${apiHost}:${apiPort}/peppy/vumeter`;
      const expectedUpdatePeriod = '0.033';

      const script = "python3 - <<'PY'\nfrom pathlib import Path\ncfg=Path('/etc/peppymeter/config.txt')\nraw=''\nreadok=0\nif cfg.exists():\n    try:\n        raw=cfg.read_text()\n        if raw:\n            readok=1\n    except Exception:\n        raw=''\nsec=''\ntarget=''\nperiod=''\nfor ln in raw.splitlines():\n    s=ln.strip()\n    if not s or s.startswith('#') or s.startswith(';'):\n        continue\n    if s.startswith('[') and s.endswith(']'):\n        sec=s[1:-1].strip().lower()\n        continue\n    if sec!='http.interface' or '=' not in s:\n        continue\n    k,v=s.split('=',1)\n    k=k.strip().lower(); v=v.strip()\n    if k=='target.url': target=v\n    elif k=='update.period': period=v\nprint(f'READ_OK:{1 if readok else 0}')\nprint(f'TARGET:{target}')\nprint(f'PERIOD:{period}')\nPY";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 });
      const out = String(stdout || '');
      const readOk = (out.match(/READ_OK:(.*)/) || [,''])[1].trim() === '1';
      const targetUrl = (out.match(/TARGET:(.*)/) || [,''])[1].trim();
      const updatePeriod = (out.match(/PERIOD:(.*)/) || [,''])[1].trim();
      const targetOk = !!targetUrl && targetUrl === expectedTargetUrl;
      const periodOk = !!updatePeriod && updatePeriod === expectedUpdatePeriod;
      return res.json({ ok: true, sshHost, sshUser, expectedTargetUrl, expectedUpdatePeriod, readOk, targetUrl, updatePeriod, targetOk, periodOk, configOk: readOk && targetOk && periodOk, stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/peppy-vumeter-target', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHeader = String(req.headers?.host || '').trim();
      const hostNoPort = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
      const apiHost = String(req.body?.apiHost || cfg?.apiHost || cfg?.apiNodeIp || hostNoPort || req.hostname || '').trim();
      if (!apiHost) return res.status(400).json({ ok: false, error: 'Could not determine API host. Set apiHost (or apiNodeIp) in Config or pass apiHost.' });
      const apiPort = Number(cfg?.ports?.api || 3101) || 3101;
      const updatePeriod = String(req.body?.updatePeriod || '0.033').trim() || '0.033';
      const targetUrl = `http://${apiHost}:${apiPort}/peppy/vumeter`;

      const script = `python3 - <<'PY'\nfrom pathlib import Path\nimport re, time\np=Path('/etc/peppymeter/config.txt')\nurl=${shQuoteArg(targetUrl)}\nperiod=${shQuoteArg(updatePeriod)}\nif not p.exists():\n    raise SystemExit('missing /etc/peppymeter/config.txt')\ns=p.read_text()\nbackup = p.with_name(f"config.txt.bak-{int(time.time())}")\nbackup.write_text(s)\nif re.search(r'^\[http\.interface\]\s*$', s, flags=re.M):\n    blk = re.search(r'^\[http\.interface\]\s*$([\s\S]*?)(?=^\[|\Z)', s, flags=re.M)\n    body = blk.group(1) if blk else ''\n    if re.search(r'^\s*target\.url\s*=.*$', body, flags=re.M):\n        body = re.sub(r'^\s*target\.url\s*=.*$', f'target.url = {url}', body, flags=re.M)\n    else:\n        body += ('\n' if body and not body.endswith('\n') else '') + f'target.url = {url}\n'\n    if re.search(r'^\s*update\.period\s*=.*$', body, flags=re.M):\n        body = re.sub(r'^\s*update\.period\s*=.*$', f'update.period = {period}', body, flags=re.M)\n    else:\n        body += f'update.period = {period}\n'\n    s = s[:blk.start(1)] + body + s[blk.end(1):]\nelse:\n    if not s.endswith('\n'): s += '\n'\n    s += f'\n[http.interface]\ntarget.url = {url}\nupdate.period = {period}\n'\np.write_text(s)\nprint('updated')\nprint(f'target.url = {url}')\nprint(f'update.period = {period}')\nprint(f'backup = {backup}')\nPY`;

      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script: `sudo -n bash -lc ${shQuoteArg(script)}`, timeoutMs: 16000 });
      return res.json({ ok: true, sshHost, sshUser, targetUrl, updatePeriod, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/moode/peppy-spectrum-target/status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHeader = String(req.headers?.host || '').trim();
      const hostNoPort = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
      const apiHost = String(cfg?.apiHost || cfg?.apiNodeIp || hostNoPort || req.hostname || '').trim();
      if (!apiHost) return res.status(400).json({ ok: false, error: 'Could not determine API host. Set apiHost (or apiNodeIp) in Config.' });
      const apiPort = Number(cfg?.ports?.api || 3101) || 3101;
      const expectedTargetUrl = `http://${apiHost}:${apiPort}/peppy/spectrum`;
      const expectedUpdatePeriod = '0.05';

      const script = "python3 - <<'PY'\nfrom pathlib import Path\nimport configparser\np=Path('/etc/peppyspectrum/config.txt')\ncp=configparser.ConfigParser()\nif not p.exists():\n    print('READ_OK:0'); print('TARGET:'); print('PERIOD:'); raise SystemExit(0)\ncp.read(p)\nprint('READ_OK:1')\nprint('TARGET:' + cp.get('http.interface','target.url',fallback='').strip())\nprint('PERIOD:' + cp.get('http.interface','update.period',fallback='').strip())\nPY";
      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 12000 });
      const out = String(stdout || '');
      const readOk = (out.match(/READ_OK:(.*)/) || [,''])[1].trim() === '1';
      const targetUrl = (out.match(/TARGET:(.*)/) || [,''])[1].trim();
      const updatePeriod = (out.match(/PERIOD:(.*)/) || [,''])[1].trim();

      const normalizeHost = (h = '') => {
        const x = String(h || '').trim().toLowerCase();
        if (!x) return '';
        if (x === '127.0.0.1' || x === '::1' || x === 'localhost') return 'localhost';
        return x;
      };
      const equivalentTarget = (a = '', b = '') => {
        try {
          const ua = new URL(a);
          const ub = new URL(b);
          if (ua.protocol !== ub.protocol) return false;
          const pa = ua.port || (ua.protocol === 'https:' ? '443' : '80');
          const pb = ub.port || (ub.protocol === 'https:' ? '443' : '80');
          if (pa !== pb) return false;
          if (ua.pathname !== ub.pathname) return false;
          const ha = normalizeHost(ua.hostname);
          const hb = normalizeHost(ub.hostname);
          if (ha === hb) return true;
          if ((ha === 'localhost' && hb === normalizeHost(apiHost)) || (hb === 'localhost' && ha === normalizeHost(apiHost))) return true;
          return false;
        } catch {
          return false;
        }
      };

      const targetOk = !!targetUrl && equivalentTarget(targetUrl, expectedTargetUrl);
      const periodOk = !!updatePeriod && updatePeriod === expectedUpdatePeriod;
      return res.json({ ok: true, sshHost, sshUser, expectedTargetUrl, expectedUpdatePeriod, readOk, targetUrl, updatePeriod, targetOk, periodOk, configOk: readOk && targetOk && periodOk, stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/peppy-spectrum-target', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHeader = String(req.headers?.host || '').trim();
      const hostNoPort = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
      const apiHost = String(req.body?.apiHost || cfg?.apiHost || cfg?.apiNodeIp || hostNoPort || req.hostname || '').trim();
      if (!apiHost) return res.status(400).json({ ok: false, error: 'Could not determine API host. Set apiHost (or apiNodeIp) in Config or pass apiHost.' });
      const apiPort = Number(cfg?.ports?.api || 3101) || 3101;
      const updatePeriod = String(req.body?.updatePeriod || '0.05').trim() || '0.05';
      const targetUrl = `http://${apiHost}:${apiPort}/peppy/spectrum`;

      const script = `python3 - <<'PY'\nfrom pathlib import Path\nimport configparser, time\np=Path('/etc/peppyspectrum/config.txt')\nurl=${shQuoteArg(targetUrl)}\nperiod=${shQuoteArg(updatePeriod)}\nif not p.exists():\n    raise SystemExit('missing /etc/peppyspectrum/config.txt')\ncp=configparser.ConfigParser()\ncp.read(p)\nif not cp.has_section('http.interface'):\n    cp.add_section('http.interface')\ncp.set('http.interface','target.url',url)\ncp.set('http.interface','update.period',period)\nif not cp.has_section('current'):\n    cp.add_section('current')\nif not cp.has_option('current','max.value'):\n    cp.set('current','max.value','100')\nbackup = p.with_name(f"config.txt.bak-{int(time.time())}")\nbackup.write_text(p.read_text())\nwith p.open('w') as f:\n    cp.write(f)\nprint('updated')\nprint(f'target.url = {url}')\nprint(f'update.period = {period}')\nprint(f'backup = {backup}')\nPY\n# Restart spectrum process so config is re-read\npkill -f 'python3 spectrum.py' >/dev/null 2>&1 || true\n/var/www/util/start-peppy.sh spectrum >/dev/null 2>&1 || true\nsleep 1\npgrep -af 'python3 spectrum.py' | head -n 1 || true`;

      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script: `sudo -n bash -lc ${shQuoteArg(script)}`, timeoutMs: 18000 });
      return res.json({ ok: true, sshHost, sshUser, targetUrl, updatePeriod, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/peppyspectrum/ensure', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const sshHost = String(cfg?.moode?.sshHost || cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || '').trim();
      const sshUser = String(cfg?.moode?.sshUser || MOODE_SSH_USER || 'moode').trim();
      if (!sshHost) return res.status(400).json({ ok: false, error: 'moode.sshHost or mpd.host is required in config' });

      const hostHeader = String(req.headers?.host || '').trim();
      const hostNoPort = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
      const apiHost = String(req.body?.apiHost || cfg?.apiHost || cfg?.apiNodeIp || hostNoPort || req.hostname || '').trim();
      if (!apiHost) return res.status(400).json({ ok: false, error: 'Could not determine API host. Set apiHost (or apiNodeIp) in Config or pass apiHost.' });
      const apiPort = Number(cfg?.ports?.api || 3101) || 3101;
      const targetUrl = `http://${apiHost}:${apiPort}/peppy/spectrum`;
      const updatePeriod = String(req.body?.updatePeriod || '0.05').trim() || '0.05';

      const script = `TARGET_URL=${shQuoteArg(targetUrl)}\nUPDATE_PERIOD=${shQuoteArg(updatePeriod)}\nsudo -n python3 - <<'PY'\nfrom pathlib import Path\nimport configparser, time, os\np=Path('/etc/peppyspectrum/config.txt')\nif not p.exists():\n    raise SystemExit('missing /etc/peppyspectrum/config.txt')\ncp=configparser.ConfigParser()\ncp.read(p)\nif not cp.has_section('current'):\n    cp.add_section('current')\ncp.set('current','base.folder','/opt/peppyspectrum')\nif not cp.has_section('http.interface'):\n    cp.add_section('http.interface')\ncp.set('http.interface','target.url',os.environ.get('TARGET_URL','').strip())\ncp.set('http.interface','update.period',os.environ.get('UPDATE_PERIOD','0.05').strip())\nbackup = p.with_name(f"config.txt.bak-{int(time.time())}")\nbackup.write_text(p.read_text())\nwith p.open('w') as f:\n    cp.write(f)\nprint('updated')\nprint('target.url = ' + cp.get('http.interface','target.url',fallback=''))\nprint('update.period = ' + cp.get('http.interface','update.period',fallback=''))\nprint(f'backup = {backup}')\nPY\nsudo -n ln -sfn /etc/peppyspectrum/config.txt /opt/peppyspectrum/config.txt\n# Skins mode defaults: bridge ON, fullscreen spectrum OFF\nsudo -n pkill -f '/opt/peppyspectrum/spectrum.py' >/dev/null 2>&1 || true\nsudo -n systemctl start peppy-spectrum-bridge.service >/dev/null 2>&1 || true\nsudo -n systemctl restart localdisplay.service >/dev/null 2>&1 || true\nsleep 1\necho BRIDGE:$(systemctl is-active peppy-spectrum-bridge.service || true)\necho SPECTRUM:$(pgrep -c -f '/opt/peppyspectrum/spectrum.py' || true)`;

      const { stdout, stderr } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 22000 });
      return res.json({ ok: true, sshHost, sshUser, targetUrl, updatePeriod, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/moode/library-update', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const host = String(cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
      const port = Number(cfg?.mpd?.port || 6600) || 6600;
      const { stdout, stderr } = await execFileP('mpc', ['-h', host, '-p', String(port), 'update']);
      return res.json({ ok: true, host, port, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/peppy/skins/export', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const { stdout, stderr } = await execFileP('node', ['scripts/export-peppymeter-skins.mjs'], { cwd: process.cwd() });
      return res.json({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/peppy/skins/deploy', async (req, res) => {
    if (!requireTrackKey(req, res)) return;
    return res.status(410).json({ ok: false, error: 'disabled: remote moode skin deploy is locked down; use Push Peppy to moOde URL mode' });
  });

  app.post('/config/peppy/skins/activate', async (req, res) => {
    if (!requireTrackKey(req, res)) return;
    return res.status(410).json({ ok: false, error: 'disabled: native peppymeter activation is locked down; use Push Peppy to moOde URL mode' });
  });

  app.post('/config/moode/reboot', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const moodeBaseRaw = String(cfg?.moode?.baseUrl || '').trim();
      const mpdHost = String(cfg?.mpd?.host || MOODE_SSH_HOST || MPD_HOST || 'moode.local').trim();
      const moodeBase = normalizeMoodeBaseUrl(moodeBaseRaw, mpdHost);
      const url = `${moodeBase}/command/?cmd=reboot`;

      const r = await fetch(url, { method: 'GET' });
      const txt = await r.text().catch(() => '');
      if (!r.ok) return res.status(502).json({ ok: false, error: `moode reboot failed (${r.status})`, detail: txt.slice(0, 300), url });
      return res.json({ ok: true, url, response: String(txt || '').slice(0, 300) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

}
