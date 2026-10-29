# 15) moOde remote display blanking fix (wake-on-play)

## Problem
When moOde local display target URL is set to an external page (for example
`http://sonuvi.local/display.html?kiosk=1`), screen blanking/wake behavior
can break:

- Blanking appears inconsistent or immediately wakes.
- With `wake_display=1`, display can be forced back on repeatedly.

This applies to all attached-display presentations: Player, Peppy, and the
Sonuvi/Kiosk display. Kiosk is a presentation mode, but it still uses
the local display path and must not be excluded from blanking.

## Root Cause
On moOde Pi4 (`moode.local`), watchdog remote wake logic in:

- `/var/www/daemon/watchdog.sh`

was checking playback via:

- `http://<local_display_host>/command/?cmd=get_output_format`

For host `sonuvi.local:8101`, that endpoint does not exist (`404`), causing false-positive wake decisions.

## Fix Applied (2026-03-02)
Patched `/var/www/daemon/watchdog.sh` remote branch to query:

- `http://<host>:3101/now-playing`

and wake when either:

- `state == "play"` for ordinary Now-Playing playback, or
- `isAirplay == true` for AirPlay playback, or
- `isUpnp == true` for UPnP playback (MPD may not own the active audio path), or
- `millsMode == true` / `displayMode == "mills"` for display-only Mills playback
  (MPD intentionally reports `pause` while the physical record is playing).

This preserves wake-on-play while using external target URL control and keeps the display awake during AirPlay and UPnP playback.

### Attached-display blanking (moOde r1034+)

The external watchdog controls wake-on-play, but it does not start the
blanking countdown. In r1034, `worker.php` invokes the blanking routine only
when `peppy_display=1`. If the attached display is Player or an external
Sonuvi/Kiosk page (`local_display=1`, `peppy_display=0`), paused playback
therefore never reaches the blanking routine.

Extend the worker's display condition to include `local_display`, and make
the routine evaluate the authoritative source. For an external target,
query `http://<now-playing-host>:3101/now-playing`; treat `state=play`,
`isAirplay=true`, and `isUpnp=true` as active. Treat `pause` and `stop` as
inactive so the configured blank timeout can expire.

The watchdog wake branch must also treat an active `local_display` the same
as `peppy_display` when `peppy_scn_blank_active=1`: clear that flag and restart
`localdisplay`. Sending only `xset dpms force on` is insufficient after the
worker has turned the HDMI output off with `xrandr --off`.

This is a version-sensitive moOde core-file change. Back up and syntax-check
`/var/www/daemon/worker.php` after every moOde upgrade; do not copy an old
worker wholesale over a new release.

### Version-specific patch artifacts

The implementation is captured as reviewable, replay-tested unified diffs:

- `docs/references/moode/worker-local-display-blanking.patch`
- `docs/references/moode/watchdog-local-display-wake.patch`

They target the recorded 2026-10-29 `worker.php` and `watchdog.sh` hashes
in `docs/references/moode/README.md`. Stage matching files, run
`patch --dry-run -p0`, and inspect the diff before any separately authorized
live application. The source artifacts themselves do not modify a moOde host.

## How to apply on a new moOde host

> Use this only when local display target URL points to an external host
> (`http://<other-host>/...`). For moOde r1034+, use the portless LAN-proxy
> URL in the Target URL field; the `:3101` API port below is a separate
> playback-state endpoint used by the watchdog patch.

1. Backup watchdog file:

```bash
sudo cp -a /var/www/daemon/watchdog.sh /var/www/daemon/watchdog.sh.bak.$(date +%s)
```

2. Edit watchdog remote-display wake check in:

- `/var/www/daemon/watchdog.sh`

Replace the remote playback probe that calls:

- `http://<host>/command/?cmd=get_output_format`

with a now-playing API probe:

- `http://<host>:3101/now-playing`

and gate wake on JSON playback state:

- wake only if `state == "play"`.

3. Reload the watchdog process after patching:

```bash
sudo killall -s 9 watchdog.sh || true
sudo bash -c '/var/www/daemon/watchdog.sh 3 >/dev/null 2>&1 &'
```

4. Apply the attached-display worker change described above, then restart
the worker using the release-appropriate method. Confirm Player, Peppy, and
Kiosk behavior separately; allow the configured blank interval to elapse.

Restart the local display as well if Chromium still has the old target in
`/home/moode/.xinitrc`:

```bash
grep -- '--app=' /home/moode/.xinitrc
sudo systemctl restart localdisplay
```

### Reference logic (shell sketch)

```bash
state=$(curl -fsS "http://$host:3101/now-playing" \
  | python3 -c 'import sys,json; print((json.load(sys.stdin).get("state") or "").strip())' 2>/dev/null || true)
if [ "$state" = "play" ]; then
  # wake display path
fi
```

## Live Environment Details (example)
- moOde host: `moode@moode.local`
- External UI host: `sonuvi.local` (or your API host/IP)
- Display page: `:8101/display.html`
- Playback API: `:3101/now-playing`

## Verification
1. Confirm local display URL:
   - `sqlite3 /var/local/www/db/moode-sqlite3.db "select value from cfg_system where param='local_display_url';"`
2. Confirm patched line exists:
   - `grep -n "External Now-Playing targets" /var/www/daemon/watchdog.sh`
3. Confirm behavior:
   - With `wake_display=1`, screen wakes on active play state and no longer false-wakes from `/command/` 404s.

## Reference files in this repo (drop-in + patch)

For convenience, this repo includes version-specific reference artifacts:

- `docs/references/moode/watchdog.sh.upstream-20260302.example`
- `docs/references/moode/watchdog.sh.patched.example`
- `docs/references/moode/watchdog-remote-display.patch`
- `docs/references/moode/worker-local-display-blanking.patch`
- `docs/references/moode/watchdog-local-display-wake.patch`

Recommended order:

1. Try patch/diff approach first.
2. Use full drop-in example only if your moOde version closely matches the reference baseline.

## License / credit (moOde)

These watchdog reference files are derived from moOde project files and retain upstream licensing:

- Copyright: The moOde audio player project / Tim Curtis
- License: **GPL-3.0-or-later**

See `docs/references/moode/README.md` and `THIRD_PARTY_LICENSES.md`.

## Rollback
Restore backup copy (created before patch) from `/var/www/daemon/watchdog.sh.bak.*` and restart watchdog.
