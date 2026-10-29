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
is applied automatically; a live host is changed only by an explicitly
authorized deployment.

## Current live installation and upgrade rule

On 2026-10-29, the two patches above were applied on `moode@10.0.0.254`
only after their exact baseline SHA-256 values matched, both dry runs
succeeded, and the staged diffs were inspected. The live post-apply hashes are:

- `worker.php`: `b8b6f623dc54a7d0d55b852a7aa32b5543221efc50f922dc0f95bc780491b819`
- `watchdog.sh`: `d0ac04a6894745bd1467ed61736e4d402089390a6998e07d65430400866e46f2`

The worker and watchdog were syntax-checked, restarted, and verified on the
physical display. The configured `scn_blank` value was `600` seconds then;
that is a moOde setting, not a patch constant.

After every moOde upgrade:

1. Record the new moOde version and fresh SHA-256 values for both target files.
2. Stage both patches, run `patch --dry-run -p0`, and inspect each resulting diff.
3. If either patch does not apply cleanly, stop and derive a reviewed,
   release-specific equivalent; never copy an old daemon file over an upgrade.
4. Back up, apply, syntax-check, and restart both daemon files.
5. Verify real paused/stopped blanking and playback wake on the physical display.

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
