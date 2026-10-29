import fs from 'node:fs/promises';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { writeJsonAtomically } from '../lib/atomic-file.mjs';

const DEFAULT_PROFILE = {
  devicePreset: 'mobile',
  theme: 'auto',
  layout: 'home-rail',
  showRecent: true,
  recentSource: 'albums',
  recentRows: ['albums', 'playlists', 'podcasts', 'radio'],
  colorPreset: 'ocean',
  recentCount: 18,
  customColors: {
    primaryThemeColor: '#0b111c',
    secondaryThemeColor: '#1f2a3d',
    primaryTextColor: '#f3f6ff',
    secondaryTextColor: '#9eb3d6',
  },
};

function sanitizeProfile(input = {}) {
  const p = (input && typeof input === 'object') ? input : {};
  const colorPreset = String(p.colorPreset || DEFAULT_PROFILE.colorPreset).toLowerCase();
  const recentSource = String(p.recentSource || DEFAULT_PROFILE.recentSource).toLowerCase();
  const ccIn = (p.customColors && typeof p.customColors === 'object') ? p.customColors : {};
  const hex = (v, fb) => {
    const s = String(v || '').trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fb;
  };
  const customColors = {
    primaryThemeColor: hex(ccIn.primaryThemeColor, DEFAULT_PROFILE.customColors.primaryThemeColor),
    secondaryThemeColor: hex(ccIn.secondaryThemeColor, DEFAULT_PROFILE.customColors.secondaryThemeColor),
    primaryTextColor: hex(ccIn.primaryTextColor, DEFAULT_PROFILE.customColors.primaryTextColor),
    secondaryTextColor: hex(ccIn.secondaryTextColor, DEFAULT_PROFILE.customColors.secondaryTextColor),
  };
  const allowedRows = [
    'albums', 'playlists', 'podcasts', 'radio', 'queue',
    'lastfm-topalbums', 'lastfm-topartists', 'lastfm-toptracks', 'lastfm-recenttracks',
    'local-topalbums', 'local-topartists', 'local-toptracks', 'local-recenttracks',
  ];
  const inRows = Array.isArray(p.recentRows) ? p.recentRows.map((x) => String(x || '').toLowerCase().trim()) : [];
  const dedup = [];
  for (const r of inRows) {
    if (!allowedRows.includes(r)) continue;
    if (dedup.includes(r)) continue;
    dedup.push(r);
    if (dedup.length >= 4) break;
  }
  for (const r of DEFAULT_PROFILE.recentRows) {
    if (dedup.length >= 4) break;
    if (!dedup.includes(r)) dedup.push(r);
  }

  return {
    devicePreset: String(p.devicePreset || DEFAULT_PROFILE.devicePreset),
    theme: String(p.theme || DEFAULT_PROFILE.theme),
    layout: String(p.layout || DEFAULT_PROFILE.layout),
    showRecent: Boolean(p.showRecent ?? DEFAULT_PROFILE.showRecent),
    recentSource: ['albums','podcasts','playlists','radio'].includes(recentSource) ? recentSource : DEFAULT_PROFILE.recentSource,
    recentRows: dedup,
    colorPreset: String(colorPreset || DEFAULT_PROFILE.colorPreset),
    recentCount: Math.max(6, Math.min(30, Number(p.recentCount || DEFAULT_PROFILE.recentCount) || DEFAULT_PROFILE.recentCount)),
    customColors,
  };
}

export function registerConfigControllerProfileRoutes(app, deps) {
  const { requireTrackKey } = deps;
  const profilePath = runtimeStatePaths().controllerProfilePath;

  app.get('/config/controller-profile', async (_req, res) => {
    try {
      const raw = await fs.readFile(profilePath, 'utf8').catch(() => '');
      const parsed = raw ? JSON.parse(raw) : {};
      return res.json({ ok: true, profile: sanitizeProfile(parsed) });
    } catch (e) {
      return res.json({ ok: true, profile: { ...DEFAULT_PROFILE }, warning: e?.message || String(e) });
    }
  });

  app.post('/config/controller-profile', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const profile = sanitizeProfile(req.body?.profile || req.body || {});
      await writeJsonAtomically(profilePath, profile);
      return res.json({ ok: true, profile });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
