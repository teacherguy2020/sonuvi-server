# Sonuvi Native Administration Integration Contract

This checkpoint combines the administrator-session foundation and the native
configuration API.  Its write surface is limited to the explicitly reviewed
MPD/moOde and media-path fields; it is source-level only and does not publish
a release, alter a Server installation, or change the iOS client.

## Required transport and authority

The iOS client uses the already authenticated, host-key-pinned SSH transport
to the Server's loopback API.  Native administration is a separate authority
from paired controller sessions and the legacy web Track Key.

1. A fresh install enrolls exactly one administrator P-256 public key using
   the existing first-administrator claim.
2. The enrolled device sends `sonuvi.administrator-session-request.v1` with
   `operation: "issue_session"`, the bound target identity, administrator
   device ID, a single-use nonce, a proof expiry no more than five minutes in
   the future, and an IEEE-P1363 SHA-256 P-256 proof over the canonical
   administrator-session message.
3. The root-only local issuer verifies the record, target, device, proof,
   expiry, and replay nonce.  It returns
   `sonuvi.administrator-session.v1` with a 15-minute ES256 bearer token.
4. The client supplies that token only as `Authorization: Bearer <token>` to
   the loopback native administrator reads and the single reviewed PATCH
   request.  Do not log it or persist it in iOS storage.

Ordinary controller tokens, SSH access alone, a claimed device ID, and the
legacy Track Key are not administrator authority.  The native endpoints return
`401 { "ok": false, "code": "administrator_authorization_required" }` for
all of them, including expired administrator tokens.

## Native endpoints

| Endpoint | Contract | Result |
| --- | --- | --- |
| `GET /v1/admin/configuration` | `sonuvi.admin.configuration.v1` | Sanitized runtime configuration, immutable Server identity/version, environment editability, and capabilities. |
| `GET /v1/admin/library/status` | `sonuvi.admin.library-status.v1` | Persisted/in-memory index and library-health status only; no scan or refresh is started. |
| `GET /v1/admin/dlna` | `sonuvi.admin.dlna.v1` | `status: "unavailable"`, `installed: false`, `reason: "not_installed_in_gate_c"`. |
| `PATCH /v1/admin/configuration` | `sonuvi.admin.configuration-update.v1` | Allowlisted MPD/moOde and media-path updates only; reuses the existing sanitizer, validation, and atomic persistence path. |

All configuration fields are the existing runtime projection.  No second
configuration store, web-endpoint invocation, host operation, raw
configuration file, secret, private key, or unrestricted path is exposed.
Environment-managed fields and unknown/secret fields are rejected; a
successful write returns the sanitized post-write projection and never
restarts services automatically.
Provider failures are fixed codes: `administrator_configuration_unavailable`
or `administrator_library_status_unavailable` (both HTTP 503).

## Existing legacy-v1 installations

Records that retain only `publicKeyHash` deliberately fail with
`administrator_rebind_required`.  Recovery is an explicit root-side
`rebind_administrator` request using the original P-256 SPKI and a fresh proof
bound to the stored target and device.  The issuer verifies the old hash and
proof, rotates its signing material, upgrades the record to v2, and returns no
bearer.  The client then makes a normal `issue_session` request.  A controller
credential, Track Key, SSH login, replacement key, or identity claim cannot
perform this recovery.

## Integration status

The integration test covers enrollment proof, session issuance, all three
authorized reads, response sanitization, controller/Track-Key rejection,
token expiry, expired proof rejection, and the legacy-v1 rebind flow.  Existing
web configuration tests remain authoritative for `config.html` behavior.

The current immutable Gate C archive predates these source changes.  Native
iOS wiring may proceed against this contract, but use on an installed Gate C
Server requires a future separately approved signed Server release and normal
installation path; this checkpoint does not hot-install or publish anything.
