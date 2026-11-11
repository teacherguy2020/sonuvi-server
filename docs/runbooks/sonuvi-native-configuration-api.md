## In-progress configuration completion — 2026-11-11

Current isolated source adds the administrator-only configuration workspace and
configuration-only JSON transfer described in `native-configuration-completion-20261111.md`.
It is not installed on the VM. Live native administrative acceptance is blocked
by a preserved-enrollment/current-Simulator identity mismatch; no identity or
credential replacement has been performed. Historical statements below about
DLNA being unimplemented are superseded by the current Server runtime; the
new source corrects its native status projection. See
`server-web-access-audit-20261111.md` for the separate read-only8443 audit.

# Native configuration API — typed administrator projection and edits

This contract supplements the [native administrator session contract](sonuvi-native-administrator-session.md). It adds one narrowly allowlisted configuration mutation; it adds no scan, refresh, host command, DLNA server, or direct-LAN administration path.

## Transport and authorization

Obtain the short-lived ES256 administrator bearer through the root-only session issuer and hold it in memory only. Every endpoint requires:

```text
Authorization: Bearer <administrator-session-token>
```

The existing pinned SSH connection and `direct-tcpip` channel to `127.0.0.1:3101` remain the transport. Controller session bearers and the web Track Key receive HTTP `401`:

```json
{ "ok": false, "code": "administrator_authorization_required" }
```

## `GET /v1/admin/configuration`

Returns the existing sanitized runtime-administrator projection, not another configuration store. It includes server/release identity, selected runtime settings, MPD/moOde host settings, feature flags, and only the four already-approved media paths. It never returns Track Keys, API keys, tokens, private-key material, credential paths, raw configuration documents, or arbitrary filesystem locations.

```json
{
  "ok": true,
  "contract": "sonuvi.admin.configuration.v1",
  "server": {
    "name": "Sonuvi Server",
    "projectName": "Sonuvi",
    "version": "sonuvi-<release-digest>",
    "release": { "mode": "immutable-release", "releaseId": "sonuvi-<release-digest>" }
  },
  "configuration": {
    "contract": "sonuvi.runtime-admin-config.v1",
    "mpd": { "host": "moode.local", "port": 6600 },
    "moode": { "sshHost": "moode.local", "sshUser": "moode", "baseUrl": "http://moode.local" },
    "features": { "podcasts": true, "ratings": true, "radio": true },
    "deployment": { "immutable": true, "environmentManaged": ["mpdHost"] }
  },
  "editability": {
    "configuration": "administrator-editable",
    "mutationsAvailable": true,
    "environmentManaged": [{ "id": "mpdHost", "editable": false, "source": "environment" }]
  },
  "capabilities": {
    "configuration": { "read": true, "write": true },
    "library": { "status": true, "scan": false, "refresh": false },
    "dlna": { "status": true, "installed": false }
  }
}
```

If the existing runtime configuration cannot be read or projected, returns HTTP `503` with `administrator_configuration_unavailable`.

## `PATCH /v1/admin/configuration`

This is the only native configuration write. It requires the same short-lived
administrator bearer and accepts either the direct allowlisted object or the
canonical envelope:

```json
{
  "configuration": {
    "mpd": { "host": "moode.local", "port": 6600 },
    "moode": { "sshHost": "moode.local", "sshUser": "moode", "baseUrl": "http://moode.local" },
    "paths": {
      "musicLibraryRoot": "/srv/music",
      "moodeUsbMount": "/media/usb",
      "piMountBase": "/mnt/pi",
      "podcastRoot": "/srv/podcasts"
    }
  }
}
```

Only those fields are representable. Unknown sections, secret-bearing fields,
malformed values, and fields listed in `environmentManaged` are rejected before
the write. The route calls the existing `sanitizeRuntimeConfigUpdate`,
`mergeRuntimeConfig`, runtime-shape validation, immutable-runtime checks, and
atomic JSON writer; it does not create a second configuration store. A
successful response uses `sonuvi.admin.configuration-update.v1`, includes the
sanitized post-write projection, and sets `restartRequired: true` when a
service restart may be needed. The route never restarts services itself.

## `GET /v1/admin/library/status`

Returns only the current persisted Browse Index and in-memory Library Health state. It does not contact MPD, build an index, launch Library Health, or start a refresh. Counts are `null` when their source has not produced a result.

```json
{
  "ok": true,
  "contract": "sonuvi.admin.library-status.v1",
  "available": true,
  "counts": { "artists": 12, "albums": 34, "tracks": 56 },
  "indexing": {
    "lastSuccessfulAt": "2026-11-08T12:00:00.000Z",
    "databaseUpdatedAt": "2026-11-08T11:59:00.000Z",
    "running": false
  },
  "browseIndex": { "available": true, "source": "persisted", "refresh": { "running": false } },
  "libraryHealth": { "available": false, "lastSuccessfulAt": null, "refresh": { "running": false, "startedAt": null } }
}
```

Provider failure returns HTTP `503` with `administrator_library_status_unavailable`.

## `GET /v1/admin/dlna`

Gate C does not package the native DLNA MediaServer. This endpoint reports that fact and does not inspect or activate the historical DLNA branch:

```json
{
  "ok": true,
  "contract": "sonuvi.admin.dlna.v1",
  "status": "unavailable",
  "installed": false,
  "enabled": false,
  "reason": "not_installed_in_gate_c"
}
```

## Stable error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `administrator_authorization_required` | Missing, expired, controller, Track-Key, or invalid bearer. |
| 404 | `administrator_api_unavailable` | No configured administrator authority/configuration reader. |
| 404 | `administrator_configuration_mutation_unavailable` | The deployment exposes the read projection but not the native write callback. |
| 400 | `administrator_configuration_field_not_editable` | Unknown or secret-bearing native field. |
| 400 | `administrator_configuration_update_invalid` | Malformed value or failed runtime validation. |
| 409 | `administrator_configuration_field_managed` | The selected field is controlled by the deployment environment. |
| 503 | `administrator_configuration_update_failed` | The bounded atomic write failed. |
| 503 | `administrator_configuration_unavailable` | Runtime configuration could not be safely projected. |
| 503 | `administrator_library_status_unavailable` | A status provider could not produce its bounded response. |

Errors expose no provider exception text, paths, credentials, or diagnostics. This is source-only: a future signed Server release and separately approved installation are required before an existing Gate C Server exposes these endpoints.

### Immutable-install preference persistence

The root-owned base configuration and administrator verifier remain read-only to the API. Native writes persist only versioned portable application preferences in `data/native-configuration.json` (mode0600, within existing service-writable state). The shared startup loader, native workspace, diagnostics and web runtime reads merge that allowlisted document with the base. Identity, deployment, listeners, credentials, caches and raw configuration cannot be overridden. Malformed, oversized or symlink preference documents fail closed. Environment overrides still win. Startup-loaded features require a service restart; no new restart privilege is provided.

A fresh process restart test verifies the actual loader and unchanged base/verifier; Linux regression checks include the service ownership policy. Web raw/base-configuration writes are not granted new permissions by this change.
