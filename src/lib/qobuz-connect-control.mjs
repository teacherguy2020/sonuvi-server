import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertMoodeRemoteTransport, resolveMoodeSshProfile } from './moode-ssh-profile.mjs';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const execFileP = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 35_000;

function text(value) {
  return String(value ?? '').trim();
}

function shQuoteArg(value) {
  const raw = String(value ?? '');
  return `'${raw.replace(/'/g, `\'"'"'`)}'`;
}

function sshArgsFor(user, host, script, profile) {
  if (profile?.immutable) {
    return [...profile.argsFor(host), 'bash', '-lc', shQuoteArg(script)];
  }
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    `${user}@${host}`,
    'bash', '-lc', shQuoteArg(script),
  ];
}

const RELEASE_SCRIPT = [
  'set -eu',
  'db=/var/local/www/db/moode-sqlite3.db',
  'sid=$(sqlite3 "$db" "select value from cfg_system where param=\'sessionid\'")',
  'test -n "$sid"',
  'result=$(curl -fsS --max-time 8 -b "PHPSESSID=$sid" -X POST --data "job=qobuzsvc" "http://127.0.0.1/command/renderer.php?cmd=disconnect_renderer")',
  'case "$result" in *"job submitted"*) ;; *) exit 4 ;; esac',
  'released=0',
  'for attempt in $(seq 1 40); do',
  '  if ! pgrep -x pibuz >/dev/null 2>&1; then',
  '    released=1',
  '    break',
  '  fi',
  '  sleep 0.25',
  'done',
  'if [ "$released" -eq 1 ]; then',
  '  sleep 0.5',
  '  sudo -n /usr/bin/systemd-run --unit=sonuvi-pibuz-b3-dev.service --collect --no-block --property=Type=simple --property=Restart=no --property=NoNewPrivileges=yes --property=LimitRTPRIO=20 /usr/bin/pibuz run >/dev/null',
  '  ready=0',
  '  for attempt in $(seq 1 40); do',
  '    if pgrep -x pibuz >/dev/null 2>&1 && ss -ltn | grep -q ":8182 " && ss -ltn | grep -q ":8183 " && pgrep -f "[/]avahi-publish-service .*_qobuz-connect.*_tcp 8183" >/dev/null 2>&1; then',
  '      ready=1',
  '      break',
  '    fi',
  '    sleep 0.25',
  '  done',
  '  if [ "$ready" -eq 1 ]; then',
  '    printf "submitted\\nreleased\\nrestarted\\nready\\n"',
  '  else',
  '    printf "submitted\\nreleased\\nrestarted\\n"',
  '  fi',
  'else',
  '  printf "submitted\\n"',
  'fi',
].join('\n');

function defaultRunCommand(command, args, options) {
  return execFileP(command, args, options);
}

/**
 * Control only the installed moOde Qobuz renderer lifecycle.
 *
 * The browser never receives a shell, SSH, or Pibuz surface. The fixed
 * backend operation reuses moOde's own renderer-disconnect path, which stops
 * the current Pibuz session and lets moOde restore its normal audio state.
 * The remote script then recreates the established enhanced development
 * receiver through systemd-run and reports confirmation only after its
 * process and control listeners are ready again. The API ownership probe
 * remains the fallback for installations that keep the daemon running.
 */
export function createQobuzConnectController({
  sshUser = 'moode',
  sshHost = '',
  runCommand = defaultRunCommand,
  capabilities = runtimeCapabilities(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const user = text(sshUser);
  const host = text(sshHost);
  const maxTimeMs = Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  let inFlight = null;

  async function release() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      if (!user || !host) throw new Error('Qobuz renderer SSH target is unavailable');
      const profile = resolveMoodeSshProfile({
        env: {
          ...env,
          MOODE_SSH_USER: user,
          MOODE_SSH_HOST: host,
        },
      });
      assertMoodeRemoteTransport('qobuz-renderer-release', { capabilities, profile });
      let result;
      try {
        result = await runCommand('ssh', sshArgsFor(user, host, RELEASE_SCRIPT, profile), {
          timeout: maxTimeMs,
          maxBuffer: 64 * 1024,
        });
      } catch (error) {
        // Some SSH/systemd combinations can return status 1 after the remote
        // script has already printed its explicit process-stop proof. Treat
        // that proof as authoritative; otherwise preserve fail-closed behavior.
        const stdout = text(error?.stdout);
        if (!/submitted/i.test(stdout) || !/(?:^|\n)released(?:\n|$)/i.test(stdout)) {
          throw new Error('The moOde Qobuz disconnect action failed');
        }
        result = { stdout };
      }

      const stdout = text(result?.stdout);
      if (!/submitted/i.test(stdout)) {
        throw new Error('The moOde Qobuz disconnect action was not accepted');
      }
      const released = /(?:^|\n)released(?:\n|$)/i.test(stdout);
      const restarted = /(?:^|\n)restarted(?:\n|$)/i.test(stdout);
      const ready = /(?:^|\n)ready(?:\n|$)/i.test(stdout);
      return {
        accepted: true,
        confirmed: released && restarted && ready,
      };
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return { release };
}

export const qobuzConnectControlDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
