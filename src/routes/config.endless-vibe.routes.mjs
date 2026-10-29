import fs from 'node:fs/promises';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { writeJsonAtomically } from '../lib/atomic-file.mjs';

const DEFAULT_ENABLED = false;

async function readSetting(settingsPath) {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return {
      enabled: parsed?.enabled === true,
      configured: true,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { enabled: DEFAULT_ENABLED, configured: false };
    }
    throw error;
  }
}

export function registerConfigEndlessVibeRoutes(app, deps = {}) {
  const requireTrackKey = deps.requireTrackKey;
  const settingsPath = deps.settingsPath
    || process.env.NOW_PLAYING_ENDLESS_VIBE_PATH
    || runtimeStatePaths().endlessVibePath;

  app.get('/config/endless-vibe', async (_req, res) => {
    try {
      const setting = await readSetting(settingsPath);
      return res.json({ ok: true, ...setting });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/config/endless-vibe', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled must be boolean' });
      }

      await writeJsonAtomically(settingsPath, {
        enabled: req.body.enabled,
        updatedAt: new Date().toISOString(),
      });
      return res.json({ ok: true, enabled: req.body.enabled, configured: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
}
