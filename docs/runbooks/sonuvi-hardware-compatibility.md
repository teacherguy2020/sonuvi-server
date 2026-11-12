# Restricted legacy hardware compatibility

Status: implementation; activation is a separate operator-controlled action.

The separate optional HTTP listener supports existing Seeburg/Mills Pico clients and the Mac Mabel bridge. It is **not** another binding of the general API. Native administration stays on `127.0.0.1`; browser HTTPS and DLNA remain unchanged. No automatic enablement, DNS change, secret migration, or client redirection occurs.

## Configuration

Use the installation's existing root-managed protected service environment file (`/var/lib/sonuvi/protected/now-playing.env` on the disposable VM). Keep secrets out of mutable configuration, logs, command arguments, commits and public web roots. Preserve its existing ownership/mode and unrelated entries. Environment changes require an explicitly authorized service restart after deploying the reviewed immutable release.

Required when enabling:

| Setting | Meaning |
|---|---|
| `SONUVI_HARDWARE_ENABLED=1` | Explicit opt-in; absent or0 disables |
| `SONUVI_HARDWARE_HOST` | Exact assigned private LAN IPv4 address; no wildcard, loopback, hostname or Tailscale address |
| `SONUVI_HARDWARE_PORT` | Explicit unprivileged port separate from API/web/DLNA; proposed VM3103 |
| `SONUVI_HARDWARE_CLIENTS` | JSON map of exact private client IPv4 addresses to role arrays: `seeburg`, `mills`, `mabel` |
| `TRACK_KEY` | Existing compatible protected legacy credential; never generated/replaced implicitly |
| `SONUVI_API_LISTEN_HOST=127.0.0.1` | Required; listener refuses to enable otherwise |

For Mills clients, `HARMONY_HOST`, `HARMONY_HUB_ID`, and `HARMONY_DENON_DEVICE_ID` must be supplied. Existing `HARMONY_PORT`, `HARMONY_DOMAIN`, `HARMONY_INPUT_PHONO`, `HARMONY_INPUT_AUX1` semantics remain unchanged. Missing prerequisites fail startup before listeners are started, rather than claim a partially operational hardware feature.

A proposed VM endpoint is `http://10.0.0.65:3103`. This is a proposal, not proof of deployment. An initial client map could grant Seeburg at its verified reserved address and the actual Mac source address their respective roles. Confirm current addresses/reservations before configuring; do not grant a subnet or guess the Mills address. Mabel and Seeburg can be enabled without a Mills role while Harmony configuration is pending.

Read-only installed readiness inspection (root may be needed to read the process environment):

```sh
node scripts/check-hardware-compatibility.mjs --pid <API_PID> --api-port 3101
```

It reports presence/status only, never credential values, and does not start services. Effective configuration validation is not proof of reachability.

## Allowed contracts

All requests require `X-Track-Key`. Query-string credentials, browser tokens/cookies, bearer grants and dispatch headers cannot authenticate the listener. Source roles use the real socket peer, never forwarding headers.

- Seeburg: POST `/integrations/seeburg/selection` `{number:1..100,dryRun?:boolean}`, GET `/integrations/seeburg/playlist`.
- Mills: empty POST `/integrations/mills/start` and `/integrations/mills/stop`, POST `/integrations/mills/selection` `{slot:1..20}`, GET `/integrations/mills/status`.
- Mabel: POST `/integrations/multiphone/selection` `{number:1..1000,dryRun?:boolean,deferPlayback?:boolean}`; GET its `/playlist`; GET `/now-playing`; GET `/config/browse/artist-albums?artist=...` and `/config/browse/album-tracks?artist=...&album=...`; POST `/mpd/start-queue`, `/mpd/start-song`, `/mpd/play-artist`, `/mpd/play-album`, `/mpd/play-playlist`, `/queue/mix` with validated current bridge fields.

The Mabel role does not imply any other `/mpd`, `/queue`, `/config`, native-admin, pairing/enrollment, installer or maintenance access. Exact paths/methods only; no normalization aliases, duplicated query keys, unknown fields, query auth or general proxying. Plain HTTP is retained specifically for existing firmware; restrict it to the trusted LAN and allowlisted clients. It is not cryptographic per-device identity: clients possessing the shared key on the same allowed address share its assigned roles.

Requests are bounded to16KiB,8KiB headers,32 connections,120 requests/minute/source and15-second body deadline. Responses are bounded to4MiB with a90-second upstream deadline. Fresh headers go only to fixed127.0.0.1 API port; no incoming admin/dispatch/forwarding identity is forwarded. Redirects are not followed and cookies are not returned. Shutdown closes both clients and in-flight upstream requests. Never retry a timed-out playback request automatically; its effect may already have happened.

## Client migration and rollback (not automatic)

1. Preserve old client endpoints and credential/config state. Verify exact release, disabled-default behavior and native loopback bind.
2. Install/enable only under deployment authority. Confirm LAN reachability, source-role rejection, missing/wrong credential403, matching key plus invalid selection400, and blocked administration/maintenance404. Use a read-only mapping request next. Do not submit a valid selection merely to test auth.
3. Coordinate a quiet test window: the VM can target the **same physical moOde player** as production. Mills transitions also switch the amplifier. Do not exercise two controller servers concurrently on the same player during validation.
4. Seeburg: update `API_HOST`/`API_PORT` in Pico main.py only after proof. Existing firmware has no Settings address control. Preserve on-device secrets; the local checkout may not contain its deployed key. MicroPython runtime reflashing is not required merely to change these constants.
5. Mills: set `NOW_PLAYING_URL` in its secrets.py; no main.py logic change needed. Validate one complete start/selection/stop cycle and restoration.
6. Mabel: change the Mac LaunchAgent's `--now-playing-url` to the selection endpoint and reload only under authority. Its derived base URL follows automatically. No Pico trigger/firmware change. Test browse, deferred selection, stable-song-ID start and a normal trigger separately.
7. Test one device at a time, then restore its prior endpoint before the next. Roll back listener enablement/configuration and release through existing supported procedures if checks fail; never widen the API binding.

## Hostnames

Pico clients use socket.getaddrinfo; ordinary DNS names are accepted by their code, but exact firmware mDNS support is not established. Mac Mabel can use macOS-resolved hostnames without trigger changes. Do not assume changing to sonuvi.local targets the VM: on2026-11-11 it resolved to production10.0.0.4. Prefer a router-managed ordinary DNS record (e.g. sonuvi.home.arpa) and reservations if supported; do not use .local as a unicast alias. No hostname/DNS changes are part of this implementation.

Last updated: 2026-11-11
