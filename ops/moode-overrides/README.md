# moOde local overrides (tracked)

These files are live-system overrides on `moode@10.0.0.254` and are mirrored here for versioning/recovery.

## Files mirrored

- `etc/systemd/system/airplay-json.service`
- `var/www/daemon/aplmeta-reader.sh`
- `usr/local/bin/airplay-json-watchdog.sh`
- `etc/systemd/system/airplay-json-watchdog.service`
- `etc/systemd/system/airplay-json-watchdog.timer`
- `etc/systemd/system/moode-worker-watchdog.service`
- `etc/systemd/system/moode-worker-watchdog.timer`
- `usr/local/bin/moode-worker-watchdog.sh`
- `etc/systemd/system/nowplaying-peppy-targets.service`
- `usr/local/bin/nowplaying-peppy-targets.sh`
- `etc/systemd/system/upmpdcli.service.d/10-qobuz-session-permissions.conf`
- `upmpdcli-qobuz-oauth.patch`
- `test-upmpdcli-qobuz-oauth-hardening.py`
- `sonuvi-readonly/dispatcher.py` (reviewed candidate update; not deployed by
  this repository change)

## Why

- Keep AirPlay metadata pipeline stable (single instance + restart loop).
- Auto-heal high CPU runaway in `shairport-sync-metadata-reader`.
- Ensure local moOde edits are not lost and are auditable in git.

The broader upgrade failure chain and recovery order are documented in
[`docs/runbooks/25-moode-upgrade-failure-chain.md`](../../docs/runbooks/25-moode-upgrade-failure-chain.md).

## Qobuz plugin security override

The installed moOde `upmpdcli-qobuz 1.9.17-1moode1` package contains a small
local security patch. The tracked
[`upmpdcli-qobuz-oauth.patch`](./upmpdcli-qobuz-oauth.patch) removes raw OAuth
request/code/token values from plugin logs, requires a real token and user ID
before saving the session, and makes the callback page report the actual
success/failure result. It does not change Qobuz endpoints, request
parameters, or token exchange behavior.

The systemd drop-in sets `UMask=0077`, and the Qobuz cache directory must be
mode `0700`. The regression harness verifies source syntax, log redaction,
success/failure responses, incomplete-exchange handling, and live cache/umask
metadata without reading cache contents or contacting Qobuz.

After a moOde/upmpdcli package upgrade, do not blindly reapply the patch:
record the new package version and hashes, back up the exact three source
files, inspect the diff context, apply only if it matches, then run:

```bash
sudo python3 ops/moode-overrides/test-upmpdcli-qobuz-oauth-hardening.py \
  --source-root /usr/share/upmpdcli/cdplugins/qobuz \
  --cache-dir /var/cache/upmpdcli/qobuz \
  --check-live-permissions
```

If the patch does not apply cleanly, stop and review the new package source.
Never print the Qobuz cache or paste authorization material into a terminal
log or chat. Keep Qobuz authorization/policy review separate from this local
security override.

## Sonuvi read-only Audio Info dispatcher

`sonuvi-readonly/dispatcher.py` is the proposed next revision of the existing
forced-command dispatcher for the Server's dedicated moOde key. It adds exactly
one literal read operation: `sonuvi-readonly-v1 audio-info-snapshot`.

That operation has no caller-supplied paths, SQL, URLs, shell fragments, or
subprocess arguments. It reads the current moOde session internally, requests
the local `audioinfo.php` page with that session, reads MPD state, and reads
active ALSA procfs parameters. Its response deliberately excludes the session
identifier. Per-stage failures are returned as bounded status codes so the
Server can distinguish unavailable collection from stopped playback.

This tracked artifact does **not** authorize or perform an installation on
moOde. A separately approved, controlled moOde override update is required
before a Server release can enable the matching
`SONUVI_MOODE_READONLY_PROTOCOL=v1` client path. Preserve the forced-command
and `restrict` key options; do not replace them with an unrestricted shell or
sudo access.

The staged, independently reversible rollout and acceptance plan is
[`sonuvi-readonly/ROLLOUT.md`](./sonuvi-readonly/ROLLOUT.md). It is a
supervised runbook only; it does not authorize a production change.

## Current behavior

- `airplay-json.service` runs `/var/www/daemon/aplmeta-reader.sh`.
- `airplay-json-watchdog.timer` runs every 30s.
- Watchdog restarts `airplay-json.service` after sustained metadata-reader CPU > 40%.
- `moode-worker-watchdog.timer` checks the stock moOde worker and configured
  AirPlay receiver every 30s. It recovers a dead worker even when inherited
  helper locks remain, and uses moOde's renderer restart path for a failed
  `shairport-sync` service.
- `moode-worker-watchdog.service` uses `KillMode=process` because the stock
  worker daemonizes into a child process. The default systemd control-group
  cleanup would otherwise kill the recovered worker as soon as the oneshot
  watchdog exits.
- `nowplaying-peppy-targets.service` restores the VU target, spectrum
  target, and shared spectrum FIFO after moOde boot or upgrade.

The read-only verification helper is tracked at
`integrations/moode/health-check.sh`. Run it from the admin machine; it is not
a moOde service and must not be installed as a second reader.

## Reader ownership after upgrades

The reader runs as root because aplmeta.py atomically replaces
/var/local/www/aplmeta.txt and writes AirPlay cover files. Keep exactly one
reader service active. If an upgrade or manual repair left
aplmeta-reader.service installed, disable it before enabling airplay-json.service:

    sudo systemctl disable --now aplmeta-reader.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now airplay-json-watchdog.timer
    sudo systemctl enable --now airplay-json.service

Do not use a second reader merely for verification. From the repository root,
run the non-destructive check while a newly played AirPlay track is active:

    ./integrations/moode/health-check.sh moode-pi http://sonuvi.local:3101

It verifies the active service and watchdog, rejects an active legacy reader,
counts exactly one `shairport-sync-metadata-reader` process, checks that
`/tmp/shairport-sync-metadata` is a FIFO, and compares fresh `aplmeta.txt`
metadata with Sonuvi's `/now-playing` response. It never changes services,
Shairport configuration, or metadata files.

## Deploy from repo to moOde

```bash
scp ops/moode-overrides/etc/systemd/system/airplay-json.service moode@10.0.0.254:/tmp/
scp ops/moode-overrides/etc/systemd/system/airplay-json-watchdog.service moode@10.0.0.254:/tmp/
scp ops/moode-overrides/etc/systemd/system/airplay-json-watchdog.timer moode@10.0.0.254:/tmp/
scp ops/moode-overrides/usr/local/bin/airplay-json-watchdog.sh moode@10.0.0.254:/tmp/
scp ops/moode-overrides/var/www/daemon/aplmeta-reader.sh moode@10.0.0.254:/tmp/
scp ops/moode-overrides/etc/systemd/system/moode-worker-watchdog.service moode@10.0.0.254:/tmp/
scp ops/moode-overrides/etc/systemd/system/moode-worker-watchdog.timer moode@10.0.0.254:/tmp/
scp ops/moode-overrides/usr/local/bin/moode-worker-watchdog.sh moode@10.0.0.254:/tmp/
scp ops/moode-overrides/etc/systemd/system/nowplaying-peppy-targets.service moode@10.0.0.254:/tmp/
scp ops/moode-overrides/usr/local/bin/nowplaying-peppy-targets.sh moode@10.0.0.254:/tmp/

ssh moode@10.0.0.254 '
  sudo install -m 644 /tmp/airplay-json.service /etc/systemd/system/airplay-json.service &&
  sudo install -m 644 /tmp/airplay-json-watchdog.service /etc/systemd/system/airplay-json-watchdog.service &&
  sudo install -m 644 /tmp/airplay-json-watchdog.timer /etc/systemd/system/airplay-json-watchdog.timer &&
  sudo install -m 644 /tmp/moode-worker-watchdog.service /etc/systemd/system/moode-worker-watchdog.service &&
  sudo install -m 644 /tmp/moode-worker-watchdog.timer /etc/systemd/system/moode-worker-watchdog.timer &&
  sudo install -m 755 /tmp/airplay-json-watchdog.sh /usr/local/bin/airplay-json-watchdog.sh &&
  sudo install -m 755 /tmp/moode-worker-watchdog.sh /usr/local/bin/moode-worker-watchdog.sh &&
  sudo install -m 755 /tmp/aplmeta-reader.sh /var/www/daemon/aplmeta-reader.sh &&
  sudo install -m 644 /tmp/nowplaying-peppy-targets.service /etc/systemd/system/nowplaying-peppy-targets.service &&
  sudo install -m 755 /tmp/nowplaying-peppy-targets.sh /usr/local/bin/nowplaying-peppy-targets.sh &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now airplay-json-watchdog.timer &&
  sudo systemctl enable --now moode-worker-watchdog.timer &&
  sudo systemctl enable --now nowplaying-peppy-targets.service &&
  sudo systemctl restart peppymeter.service &&
  sudo systemctl restart peppy-spectrum-bridge.service &&
  sudo systemctl restart airplay-json.service
'
```
