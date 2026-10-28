const SERVICES = Object.freeze(['sonuvi-api.service', 'sonuvi-web.service']);

// Both units form one runtime: web Requires=api. Restarting only API can leave
// web stopped. Never fall back to legacy units or a possibly legacy PM2 process.
export async function queueSonuviRestart(execFileP) {
  for (const service of SERVICES) {
    const { stdout } = await execFileP('systemctl', [
      'show', service, '--property=LoadState', '--value',
    ], { timeout: 5000 });
    if (String(stdout).trim() !== 'loaded') {
      throw new Error('Sonuvi systemd units are not installed');
    }
  }
  // No sudoers or sandbox changes: hardened installations may deny this. The
  // caller must report that honestly and require an administrator, not retry.
  await execFileP('sudo', [
    '-n', 'systemctl', '--no-block', 'restart', ...SERVICES,
  ], { timeout: 5000 });
  return { ok: true, restarted: false, restartQueued: true, method: 'systemd', services: [...SERVICES] };
}

export function registerSonuviRestartRoutes(app, { requireTrackKey, execFileP }) {
  const handler = async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      return res.status(202).json(await queueSonuviRestart(execFileP));
    } catch {
      // Do not serialize subprocess output or pretend queueing proves health.
      return res.status(503).json({
        ok: false, restarted: false, restartQueued: false,
        error: 'Automatic Sonuvi restart unavailable. An administrator must restart sonuvi-api.service and sonuvi-web.service together and verify health.',
      });
    }
  };
  app.post('/config/restart-api', handler);
  app.post('/config/restart-services', handler);
}
