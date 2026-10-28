# Sonuvi Server: release layout and boot operations

Reference: the working Pi5 installation, inspected 2026-10-28. This is an
operator guide, not a new installer or authorization to change a host.

## Current production contract

| Purpose | Current path / unit |
| --- | --- |
| Immutable application releases | `/opt/sonuvi/releases/<release-id>` |
| Active release pointer | `/opt/sonuvi/current` |
| Runtime state, data, caches | `/var/lib/sonuvi` |
| Validated non-secret configuration | `/var/lib/sonuvi/config` |
| Protected environment, SSH material | `/var/lib/sonuvi/protected` |
| API | `sonuvi-api.service`, HTTP 3101 |
| Public web/assets | `sonuvi-web.service`, HTTP 8101 |
| Browser HTTPS | Existing Caddy proxy, 443; same-origin API routes |
| Manual rollback installation | `/opt/now-playing`, preserved, not running |

Do not overwrite protected H4C `/opt/sonuvi/shared`, `/etc/sonuvi`, or
`/run/sonuvi`. The separate moOde host and its sticker/ratings databases are
outside this Server operation. Preserve Caddy/Tailscale configuration and routes.
Ports 3101/8101 are plain HTTP upstreams, not independent HTTPS listeners.

## Installation and publication boundary

The reviewed immutable-release builder, verifier, public-only server and runtime
state support currently live in the approved release lineage, not all in this
main checkout. **These templates are not a complete fresh installer.** Obtain a
reviewed artifact and its exact manifest/revision/hash before deployment. Never
substitute a main checkout, invoke the retired installer, run the legacy
uninstaller, or patch individual files into an immutable release.

Use the existing approved artifact-publication and backup/rollback procedure:
verify the artifact and required runtime assets/dependencies; publish root-owned
non-secret directories with traversal permissions (normally 0755); preserve
credential permissions; verify the physical release path and activation
checkpoint; validate configuration as the service account. Do not bypass the
activation verifier or copy legacy source over new code.

The templates in `ops/systemd/sonuvi-api.service.in` and
`ops/systemd/sonuvi-web.service.in` mirror the working reference units.
Render only these site-specific placeholders in a separate staging area:

- `@SERVICE_ACCOUNT@`: existing service user and matching group.
- `@RELEASE_ID@`: verified immutable artifact identity.
- `@MUSIC_LIBRARY_ROOT@`: actual API-host library mount, not a moOde-local path.

Use safe literal values with no whitespace/newlines, quoting, or systemd
specifier characters; do not substitute untrusted text. `SONUVI_RELEASE_ROOT`
must resolve to the **physical** `/opt/sonuvi/releases/<release-id>`, not
`/opt/sonuvi/current`. Keep the normal current symlink for WorkingDirectory.
Check all optional EnvironmentFiles and overrides in their actual precedence
order; a later empty value must not overwrite a required existing credential.
The retained `/etc/now-playing/apns-provider.env` is an intentional existing
credential path, not a legacy service startup instruction.

Before stopping anything, validate both rendered units, real service-account
traversal/read access, the actual activation verifier with each unit's effective
environment, dependencies and mount readiness. Do not start a replacement against
state still being written by the legacy server. Follow the approved consistent
backup/transfer procedure for an actual migration; an ordinary boot-role change
does not justify a backup restore or data transfer.

## Commit boot roles on an already accepted running installation

First inspect enablement, dependencies, system/user units (including lingering),
all timers, cron, rc.local/init scripts, PM2 saved processes and watchdog scripts.
Do not assume disabling a system service also disables user/PM2 startup.

On the reference host the old watchdog is blocked by all three:

1. Persistent root-owned mode-0600 marker:
   `/var/lib/now-playing-maintenance/legacy-watchdog.inhibit`.
2. Existing `now-playing-watchdog.service.d/90-sonuvi-maintenance.conf`:
   `ConditionPathExists=!/var/lib/now-playing-maintenance/legacy-watchdog.inhibit`.
3. The watchdog script itself checks that same marker and exits before restarting.

Retain those controls and disable its timer. A runtime-only mask would not
survive reboot. If any control is absent or another activator exists, stop and
resolve that specific path before changing boot roles. Do not disable unrelated
monitoring; the reference heartbeat timer only logs and does not restart services.

Once the live pair is healthy and legacy services are stopped:

```sh
sudo systemctl enable sonuvi-api.service sonuvi-web.service
sudo systemctl disable now-playing.service now-playing-web.service now-playing-watchdog.timer
systemctl is-enabled sonuvi-api.service sonuvi-web.service
systemctl is-active sonuvi-api.service sonuvi-web.service
systemctl is-enabled now-playing.service now-playing-web.service now-playing-watchdog.timer
systemctl is-active now-playing.service now-playing-web.service now-playing-watchdog.timer
```

The last two commands are expected to report disabled/inactive and exit nonzero.
These enable/disable commands neither start nor stop services. Do not add
`--now`. Preserve unit files and `/opt/now-playing` for manual rollback.
The reference user-level `now-playing.service` is also disabled/inactive, with
no lingering or reverse dependencies; PM2 has no daemon or saved startup dump.

API requires the library mount and network-online; web Requires/After API.
Both use Restart=on-failure, not the legacy restart watchdog. This is process
failure recovery, not a replacement functional-health watchdog. The retained
heartbeat's old service labels are not Sonuvi acceptance evidence.

Recheck unit validation and dependency graphs, PIDs, HTTP/HTTPS, Tailscale,
pinned administrator SSH, and protected state/config hashes. No actual reboot
acceptance is claimed until a separately authorized reboot and functional test.

## Maintenance and manual rollback

Config Save has unresolved protected-field incompatibilities on the deployed
immutable release. Do not use it as a migration/config conversion tool. The
repository restart handlers target the Sonuvi pair only, report queued rather
than completed restart, and do not grant privileges or fall back to legacy/PM2.
NoNewPrivileges on the reference units can require administrator action.
Those source changes do not change a deployed artifact.

For a separately authorized restart, restart both units together (web depends on
API), then verify service and application health. Do not weaken the sandbox to
enable a web-button restart.

Manual rollback remains possible: stop both Sonuvi services, verify quiescence
and state compatibility, then use the reviewed allowlisted rollback procedure
only if needed and authorized. Never extract an entire archive at `/`.
Do not automatically restore data. After legacy health is verified, reverse
the boot roles and restore the watchdog's original behavior through the reviewed
rollback procedure (including its persistent inhibit). Never re-enable legacy
monitoring while Sonuvi owns production ports/state.

*Last reviewed: 2026-10-28 America/Chicago*
