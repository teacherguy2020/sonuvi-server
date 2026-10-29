# moOde watchdog reference files

These files are sourced from the moOde project runtime on a live system and are provided as version-specific references for the remote-display wake/blanking fix.

## Files

- `watchdog.sh.upstream-20260302.example`
  - Baseline backup copy from `/var/www/daemon/watchdog.sh.bak.20260302-190700`
- `watchdog.sh.patched.example`
  - Patched live copy from `/var/www/daemon/watchdog.sh`
- `watchdog-remote-display.patch`
  - Unified diff between the above two files
- `worker-local-display-blanking.patch`
  - Version-scoped unified diff that makes an attached local display participate
    in the blanking countdown and reads external Sonuvi playback state safely.
- `watchdog-local-display-wake.patch`
  - Version-scoped unified diff that restarts `localdisplay` after a generalized
    local-display/Peppy blank.

## Version scope

The two 2026-10-29 attached-display patches were prepared against the following
read-only runtime baselines on the moOde host:

- `/var/www/daemon/worker.php`
  - SHA-256: `f7472ffba6ecc58414abfee29930e826f1b4075c2cd55c3ea0952c325e107412`
- `/var/www/daemon/watchdog.sh`
  - SHA-256: `48bba33b81de2ffd1bf454fb802edc9c1f19470a0fc49ef56990747adbf37a8e`

They are not generic moOde drop-ins. First stage the target files and verify
each patch with `patch --dry-run -p0`; inspect the resulting diff before any
separately authorized live application. The repository test suite replays both
patches against minimized GPL-attributed fixtures. No patch in this directory
is applied to a live host by the repository.

## License / credit

- Origin: moOde audio player project (`/var/www/daemon/watchdog.sh`)
- Copyright: The moOde audio player project / Tim Curtis
- License: **GPL-3.0-or-later**

These reference files remain under their upstream GPL terms.
Do not relicense them under this repository's root Unlicense.

## Usage guidance

Prefer applying a patch/diff to a matching moOde version rather than blindly
replacing `worker.php` or `watchdog.sh`. moOde updates can change their
internals across releases.
