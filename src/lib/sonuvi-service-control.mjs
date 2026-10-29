export const SONUVI_SERVICES = Object.freeze(['sonuvi-api.service', 'sonuvi-web.service']);
export const SONUVI_RESTART_POLICY = 'sonuvi-pair-polkit-v1';
const OPTIONS = Object.freeze({ timeout: 5000 });
const UNAVAILABLE = 'Automatic restart unavailable. An administrator must restart sonuvi-api.service and sonuvi-web.service together and verify health.';

export async function checkSonuviRestart(execFileP, policyFor = () => process.env.SONUVI_SERVICE_RESTART_POLICY) {
  // Polkit only lets trusted action owners (systemd) query with unit/verb
  // details. Do not grant the API that trust or pretend pkcheck can probe it.
  // The root-managed unit opts in after the operator verifies the exact rule.
  // This flag grants no privilege: systemd enforces Polkit on RestartUnit.
  if (await policyFor() !== SONUVI_RESTART_POLICY) throw new Error(UNAVAILABLE);
  for (const unit of SONUVI_SERVICES) {
    const { stdout } = await execFileP('/usr/bin/systemctl', [
      'show', unit, '--property=LoadState,ActiveState', '--no-pager',
    ], OPTIONS);
    const state = Object.fromEntries(String(stdout).trim().split('\n').map(line => line.split('=')));
    if (state.LoadState !== 'loaded' || state.ActiveState !== 'active') throw new Error(UNAVAILABLE);
  }
  return { available: true, authorization: 'operator-configured-polkit', permissionProbe: 'not-performed', services: [...SONUVI_SERVICES] };
}

export function registerSonuviRestartRoutes(app, {
  requireTrackKey, execFileP, policyFor, log = { error() {} },
}) {
  let pending = false;
  app.get('/config/restart-services/status', async (req, res) => {
    if (!requireTrackKey(req, res)) return;
    try {
      return res.json({ ok: true, ...await checkSonuviRestart(execFileP, policyFor) });
    } catch {
      return res.json({ ok: true, available: false, services: [...SONUVI_SERVICES], reason: UNAVAILABLE });
    }
  });
  const handler = async (req, res) => {
    if (!requireTrackKey(req, res)) return;
    if (Object.keys(req.body || {}).length) return res.status(400).json({ ok: false, error: 'Restart accepts no targets or options' });
    if (pending) return res.status(409).json({ ok: false, error: 'Restart already pending' });
    pending = true;
    try {
      await checkSonuviRestart(execFileP, policyFor);
      // Flush the acknowledgement before scheduling termination of this API.
      // Acceptance is not a claim that systemd has completed (or queued) it.
      res.once('close', () => { if (!res.writableFinished) pending = false; });
      res.once('finish', () => {
        execFileP('/usr/bin/systemctl', [
          '--no-ask-password', '--no-block', 'restart', ...SONUVI_SERVICES,
        ], OPTIONS).catch(() => {
          pending = false;
          log.error?.('[config/restart] Sonuvi restart request failed; administrator action required');
        });
      });
      return res.status(202).json({
        ok: true, restartAccepted: true, restartQueued: false, restarted: false,
        services: [...SONUVI_SERVICES], message: 'Restart accepted; verify both services recover.',
      });
    } catch {
      pending = false;
      return res.status(503).json({ ok: false, restartAccepted: false, restarted: false, error: UNAVAILABLE });
    }
  };
  app.post('/config/restart-api', handler);
  app.post('/config/restart-services', handler);
}
