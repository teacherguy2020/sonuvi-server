import fs from 'node:fs/promises';
import net from 'node:net';
import { resolveMoodeSshProfile } from './moode-ssh-profile.mjs';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

export const SSH_RESTRICTED = Object.freeze({
  ok: false, available: false, code: 'SONUVI_SSH_RESTRICTED',
  error: 'Remote SSH is restricted by this release. Restoration requires separate operator authorization; this does not indicate a bad SSH key or an MPD failure.',
});

// Listener reachability, not a claim that every application feature is healthy.
// Only loopback is probed; this is not a caller-controlled network scanner.
export function checkLocalListener(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = reachable => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function runtimeDiagnostics(cfg, {
  environment = process.env, execFileP, stat = fs.stat, access = fs.access,
  checkListener = checkLocalListener,
} = {}) {
  const statePaths = runtimeStatePaths({ env: environment });
  const profile = resolveMoodeSshProfile({ env: environment, statePaths });
  const mpdHost = String(environment.MPD_HOST || cfg.mpd?.host || '').trim();
  const mpdPort = Number(environment.MPD_PORT || cfg.mpd?.port || 6600);
  let mpdOk = false;
  try {
    if (mpdHost) {
      await execFileP('mpc', ['-h', mpdHost, '-p', String(mpdPort), 'status'], { timeout: 8000 });
      mpdOk = true;
    }
  } catch {}
  const pathChecks = [];
  for (const [name, scope] of [['musicLibraryRoot', 'remote'], ['moodeUsbMount', 'remote'], ['piMountBase', 'local'], ['podcastRoot', 'local']]) {
    const configuredPath = String(cfg.paths?.[name] || '').trim();
    let status = !configuredPath ? 'not-configured' : scope === 'remote' ? 'restricted' : 'unavailable';
    if (configuredPath && scope === 'local') {
      try { status = (await stat(configuredPath)).isDirectory() ? 'present' : 'not-directory'; }
      catch (error) { status = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
    }
    pathChecks.push({ name, scope, status });
  }
  let identityReadable = false, knownHostsReadable = false;
  if (profile.immutable) {
    try { await access(profile.identityPath, fs.constants.R_OK); identityReadable = true; } catch {}
    try { await access(profile.knownHostsPath, fs.constants.R_OK); knownHostsReadable = true; } catch {}
  }
  const [apiListening, webListening] = await Promise.all([
    checkListener(Number(environment.PORT || cfg.ports?.api || 3101)),
    checkListener(Number(environment.SONUVI_WEB_PORT || cfg.ports?.ui || 8101)),
  ]);
  return {
    ok: true, mpdOk, mpdStatus: mpdOk ? 'reachable' : 'unavailable',
    listeners: {
      api: apiListening ? 'listening' : 'unavailable',
      web: webListening ? 'listening' : 'unavailable',
    },
    ssh: { status: profile.immutable ? 'restricted' : 'not-tested', identityReadable, knownHostsReadable,
      reason: profile.immutable ? SSH_RESTRICTED.error : 'Remote SSH was not exercised by this read-only status check.' },
    pathChecks,
  };
}
