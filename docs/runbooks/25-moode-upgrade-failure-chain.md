# moOde upgrade failure chain and recovery map

This page records the September 2026 recovery of the Sonuvi installation
after a moOde upgrade. It exists because several independent-looking symptoms
were actually consequences of the same operational problem: working local
customizations were stored in mutable moOde files, while the upgrade restored
stock files and left some runtime services in a partially healthy state.

## The short version

The upgrade did not break one feature. It caused drift in several layers:

1. The external Target URL/display behavior depended on version-sensitive
   changes in moOde's `/var/www/daemon/worker.php` and `watchdog.sh`.
2. The stock worker later died. Its PID file was stale, and helper daemons had
   inherited the worker's exclusive lock, so a normal restart reported
   `Already running` even though no healthy worker existed.
3. AirPlay could appear enabled at the systemd level while the actual
   `shairport-sync` process was gone.
4. The upgrade reset Peppy configuration to stock values: the VU target,
   HTTP output flag, VU input FIFO, spectrum target, and spectrum FIFO.
5. The spectrum bridge remained enabled but pointed at the obsolete FIFO, so
   it failed rather than producing data.

The durable solution is now split correctly:

- version-sensitive moOde core patches remain documented and must be checked
  after each upgrade;
- systemd timers supervise the worker and AirPlay receiver;
- the AirPlay metadata path has one tracked reader, one expected FIFO, and a
  read-only end-to-end health check;
- a separate boot/upgrade restore service re-applies the Sonuvi Peppy
  targets and FIFO paths;
- live verification checks processes, config, and fresh data rather than only
  checking whether a unit is loaded.

## What changed and why the old setup drifted

For a long time the system worked because the live moOde host contained the
right edits. The problem was that those edits were not all in the same kind of
durable layer:

| Layer | Where the behavior lived | What an upgrade could do |
| --- | --- | --- |
| External display blanking/wake | `/var/www/daemon/worker.php` and `watchdog.sh` | Replace the files with stock, version-specific logic |
| Target URL / Chromium launch | moOde database and `/home/moode/.xinitrc` | Reset or leave the database and launch command disagreeing |
| Worker/AirPlay runtime health | Processes and inherited locks | Leave a stale PID/lock or a dead receiver after an unclean restart |
| Peppy VU/spectrum routing | `/etc/peppymeter/config.txt` and `/etc/peppyspectrum/config.txt` | Restore stock localhost/obsolete FIFO settings |
| Spectrum transport | `peppy-spectrum-bridge.service` plus `/tmp/peppyspectrum` | Keep the service enabled while its source path no longer exists |

The original fixes were not inherently wrong. The missing piece was an
explicit inventory and automatic reapplication layer for the host-side files
that moOde owns. A future upgrade must be treated as a reset of those files,
not as a routine application restart.

## Display and Target URL chain

There are two different display concerns and they must not be conflated.

### 1. Target URL and browser launch

For moOde r1034 and later, the local display Target URL is the portless LAN
proxy URL:

```text
http://sonuvi.local/display.html?kiosk=1
```

The Now Playing playback-state API remains a separate endpoint:

```text
http://sonuvi.local:3101/now-playing
```

Check both the moOde database and Chromium launch command after an upgrade:

```bash
sqlite3 /var/local/www/db/moode-sqlite3.db \
  "select value from cfg_system where param='local_display_url';"
grep -- '--app=' /home/moode/.xinitrc
```

### 2. Blanking and wake decisions

The external Target URL does not itself implement the blanking countdown.
On the affected moOde release, the stock worker entered its display-blanking
loop only when `peppy_display=1`. An external Sonuvi/Kiosk page uses
`local_display=1`, so the worker needed the version-specific extension
documented in [`15-moode-remote-display-blanking-fix.md`](15-moode-remote-display-blanking-fix.md).

The worker-side external-display decision must query:

```text
http://sonuvi.local:3101/now-playing
```

and regard `state=play`, `isAirplay=true`, and `isUpnp=true` as active. The
watchdog must use the same authority. The old stock probe of
`/command/?cmd=get_output_format` returns 404 for Sonuvi and can create
false wake behavior.

If the worker process is dead, neither the correct Target URL nor the correct
worker patch is enough: the blanking loop does not run at all. This was the
reason the display could remain awake after playback had stopped.

## Worker and AirPlay recovery

The worker's `/run/worker.pid` is not sufficient evidence of health. The
recovery check must validate both the PID and the command line:

```bash
pid=$(cat /run/worker.pid)
ps -p "$pid" -o pid,lstart,args
```

After the unclean worker failure, `peppy-gain.php`, `mountmon.php`, and
`mpdmon.php` had inherited the worker's exclusive flock on `/run/worker.pid`.
That produced the misleading sequence:

1. the worker was absent;
2. the PID file still existed or was stale;
3. a manual worker launch said `Already running`;
4. the real blocker was an inherited helper-daemon lock.

The tracked `moode-worker-watchdog` handles this every 30 seconds:

- checks `shairport-sync.service` **and** the actual `shairport-sync`
  process;
- asks moOde's `restart-renderer.php --airplay` path to recover AirPlay;
- validates `/var/www/daemon/worker.php` rather than trusting the PID file;
- stops only the known helper daemons when the worker is missing;
- waits for the flock to clear;
- launches the stock worker and verifies the new PID.

Files:

- `ops/moode-overrides/usr/local/bin/moode-worker-watchdog.sh`
- `ops/moode-overrides/etc/systemd/system/moode-worker-watchdog.service`
- `ops/moode-overrides/etc/systemd/system/moode-worker-watchdog.timer`

The supervisor does not replace moOde's worker or alter the TargetURL patch;
it makes the existing design recoverable when a process or inherited lock
fails.

## Peppy data chain

The Peppy designer warning was the useful clue:

```text
found: http://localhost:8000/vumeter
expected: http://sonuvi.local:3101/peppy/vumeter
```

The final installation-specific values are:

| Function | Correct value | Why it matters |
| --- | --- | --- |
| VU HTTP target | `http://sonuvi.local:3101/peppy/vumeter` | Sends VU data to the Sonuvi API |
| VU HTTP output | `output.http = True` | A correct target is useless when output is disabled |
| VU input FIFO | `[data.source] pipe.name = /tmp/peppymeter` | This is the FIFO produced by moOde's `peppyalsa` scope |
| Spectrum HTTP target | `http://sonuvi.local:3101/peppy/spectrum` | Sends spectrum data to the Sonuvi API |
| Spectrum FIFO | `[current] pipe.name = /tmp/peppyspectrum` | This is the shared FIFO used by moOde and the bridge |
| Spectrum update period | `0.05` | Keeps the visualizer responsive |

The VU input path belongs under `[data.source]`, not `[current]`. That
distinction mattered: the VU HTTP endpoint could be reachable and still
return fresh-looking zeroes when `output.http` or the input FIFO was wrong.

The spectrum bridge can also be `enabled` while being functionally dead if it
is still configured for `/home/pi/myfifosa`. Always check its active state and
the FIFO/data path together.

The tracked persistence layer is:

- `ops/moode-overrides/usr/local/bin/nowplaying-peppy-targets.sh`
- `ops/moode-overrides/etc/systemd/system/nowplaying-peppy-targets.service`

It runs at boot, before `peppy-spectrum-bridge.service`, is idempotent, and
preserves first-run backups as `*.bak.nowplaying-peppy`.

## AirPlay metadata persistence and post-upgrade check

The metadata path is separate from AirPlay audio playback:

```text
/tmp/shairport-sync-metadata
  -> airplay-json.service
  -> /var/www/daemon/aplmeta-reader.sh
  -> one shairport-sync-metadata-reader
  -> /var/www/util/aplmeta.py
  -> /var/local/www/aplmeta.txt + AirPlay covers
```

Keep exactly one reader owner. The known duplicate `aplmeta-reader.service`
must be disabled/inactive; do not create another reader to test recovery.
`airplay-json-watchdog.timer` supervises reader CPU only and does not change
Shairport's audio configuration.

After playing or changing to a new AirPlay track, run this read-only check from
the repository/admin machine:

```bash
./integrations/moode/health-check.sh moode-pi http://sonuvi.local:3101
```

It verifies the active reader service and watchdog, the absence of the
duplicate unit, exactly one reader process, the named FIFO, a fresh
`aplmeta.txt`, and matching AirPlay metadata/artwork in Sonuvi's
`/now-playing` response. An old `aplmeta.txt` or a reachable but mismatched
Sonuvi payload fails the check.

## Recovery procedure after a future moOde upgrade

Run this in order. Do not start by changing application code on the Pi5.

### A. Reapply/check version-sensitive moOde files

1. Confirm the moOde release.
2. Back up `/var/www/daemon/worker.php` and `watchdog.sh`.
3. Stage the matching `worker-local-display-blanking.patch` and
   `watchdog-local-display-wake.patch` from `docs/references/moode/`; run
   `patch --dry-run -p0` for each and inspect the resulting diffs.
4. Apply only version-appropriate diffs, then run `php -l` on `worker.php`
   and `bash -n` on `watchdog.sh`; restart both daemons.
5. Confirm the Target URL is portless and Chromium uses the same value.

Never copy an old `worker.php` wholesale over a new moOde release.

### B. Restore the tracked supervisors and Peppy persistence

Install the files from `ops/moode-overrides/`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now moode-worker-watchdog.timer
sudo systemctl enable --now nowplaying-peppy-targets.service
sudo systemctl restart peppymeter.service
sudo systemctl restart peppy-spectrum-bridge.service
```

The repository's [`ops/moode-overrides/README.md`](../../ops/moode-overrides/README.md)
contains the complete install command block.

### C. Verify each layer

```bash
systemctl is-active moode-worker-watchdog.timer
systemctl is-active nowplaying-peppy-targets.service
systemctl is-active peppymeter.service
systemctl is-active peppy-spectrum-bridge.service

cat /run/worker.pid
ps -p "$(cat /run/worker.pid)" -o pid,lstart,args

grep -nE 'target.url|update.period|output.http|pipe.name' \
  /etc/peppymeter/config.txt /etc/peppyspectrum/config.txt

curl -s http://sonuvi.local:3101/peppy/vumeter
curl -s http://sonuvi.local:3101/peppy/spectrum
```

For AirPlay metadata, use the dedicated check after a new AirPlay track:

```bash
./integrations/moode/health-check.sh moode-pi http://sonuvi.local:3101
```

Do not treat `systemctl is-active` alone as proof of metadata health. The
FIFO, reader count, timestamp, and Sonuvi payload must all agree. This check
is non-destructive and does not restart Shairport or add a reader.

Perform the `curl` checks while audio is active. VU should be fresh and
nonzero; spectrum should be fresh with a populated `bins` array. A service
being `active` without fresh data is not a successful verification.

### D. Exercise the actual user behaviors

- confirm the configured `scn_blank` interval; it is a moOde setting, not a hard-coded timeout;
- pause/stop local playback and allow that interval to pass;
- resume local playback and confirm wake;
- test AirPlay and confirm both audio and metadata;
- test Peppy needles and spectrum movement;
- test the external Target URL after a browser/display restart.

## What to remember next time

- A moOde upgrade is a reset of `/var/www` and selected `/etc` state.
- Separate application-host health from moOde-host health.
- For display issues, check Target URL, worker process, worker patch, and
  watchdog patch separately.
- For AirPlay, check the process, not only systemd's unit state.
- For Peppy, check target, output flag, input FIFO, bridge, and fresh API data.
- Do not infer data-path correctness from a loaded service or a reachable HTTP
  endpoint alone.
- Keep installation-specific behavior in tracked overrides and recovery
  services so a successful manual repair becomes the next boot's baseline.
