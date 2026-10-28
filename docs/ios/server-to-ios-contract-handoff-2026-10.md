# Sonuvi Server → Native iOS contract handoff

**Status:** P0 Server bearer capabilities implemented in source; no iOS repository changes included
**Verified:** 2026-10-20, America/Chicago
**Server target:** Sonuvi Server deployment target (installation-specific host
and path intentionally omitted)

This is the concise contract handoff for the separate iOS integration audit.
It describes current Server behavior and calls out the approved future catalog
architecture without presenting that future as implemented.

## Authentication boundary

- Native callers use `Authorization: Bearer <mobile-api access token>` for
  `/v1/mobile/*`. The access token currently lasts 12 hours; the refresh token
  uses the separate `mobile-refresh` scope and lasts up to 365 days.
- `POST /v1/mobile/session` accepts `{ "deviceId": "..." }` with
  `X-Mobile-Enrollment-Code`. `POST /v1/mobile/session/refresh` uses
  `X-Mobile-Refresh-Token`; the explicit legacy migration header is
  `X-Mobile-Session-Migration: 1`. Pairing routes provide the approved
  display/request flow. A Track Key is never a native credential.
- Media and radio playback use short-lived, device/track- or station-scoped
  tickets. They are not catalog identities or replacements for the bearer
  session.
- Native clients must not receive or send Track Keys, raw MPD/file paths,
  renderer URLs, Qobuz credentials, Last.fm credentials, or Alexa secrets.

## Current API contracts to verify

| Contract | Request | Current Server boundary |
| --- | --- | --- |
| Current state | `GET /v1/mobile/now-playing` | Source-aware sanitized Home state; inspect `source`, `isUpnp`, `isStream`, `isPodcast`, queue fields, and `track` rather than calling `/now-playing` directly |
| Home transport | `POST /v1/mobile/now-playing/control` | Bearer-only typed Home play/pause/stop/next/previous/repeat/consume and bounded relative/percentage seek; delegates to the guarded Server authority |
| Home repeat mode | `POST /v1/mobile/now-playing/control` with `{"action":"repeatMode","mode":"off|all|one"}` | Deterministically selects MPD repeat/single state and returns authoritative mode readback; preserves the legacy repeat toggle |
| Home Consume | `POST /v1/mobile/now-playing/control` with `{"action":"consume","state":"on|off"}` or `{"action":"consume"}` | Bearer-only deterministic or legacy-toggle Consume control; returns authoritative `state` and `consumeOn` readback without accepting a Track Key |
| Next Up | `GET /v1/mobile/next-up` | Target-aware successor; Home moOde/Alexa and native-device queues do not share one inferred position |
| Home queue | `GET /v1/mobile/queue` plus `/queue/items/:queueItemId/*` and `/queue/actions` | Bearer queue handles are opaque and current-snapshot scoped; mutations affect Home moOde/MPD only and require refresh after mutation |
| Physical shuffle undo | `POST /v1/mobile/queue/actions` with `{"action":"undoshuffle"}` | Restores the guarded one-level physical upcoming-queue shuffle when the queue snapshot is still valid; returns a sanitized queue |
| Explicit Vibe seed | `POST /v1/mobile/queue-wizard/vibe` with canonical `trackId` | Resolves the canonical catalog record and reuses Queue Wizard's seeded builder; returns only an opaque job handle and safe request identity |
| Native-device Vibe preview | `POST /v1/mobile/vibe/preview` with canonical `trackId` | Reuses the dry-run Vibe engine and returns only exact-catalog canonical recommendations; does not mutate Home or external playback authority |
| Audio diagnostics | `GET /v1/mobile/audio-info` | Safe `audio-info.v1` rows/provenance; configured output, decoded PCM, and measured ALSA hardware output are distinct |
| Local bytes | `GET /v1/mobile/local-source/manifest` | Maps canonical IDs to relative local availability (`relativePath`/`contentPath` where present); stale/disconnected bytes are cache misses, not identity changes |
| Native history | `POST /v1/mobile/playback/events` | Requires Server-resolvable `trackId` and valid `sessionId`; explicit supported `state` recommended (defaults to `progress`); optional `elapsedSec`, `durationSec`, `startedAtMs` |
| Recent history | `GET /v1/mobile/history/recent` | Server-owned recent-history projection; native code does not scrobble directly |

Native playback events are resolved by the Server and recorded with source
`ios-device` and session identity `mobile:<sessionId>`. The Server decides
qualification, deduplication, local history, and Last.fm submission.

### Playback-event timestamp and qualification

The input timestamp is **`startedAtMs`**, Unix epoch milliseconds, not
`startedAt`. A finite positive timestamp is bounded to the preceding seven
days through request time; omission/invalid value uses request time. The
recorded native handoff and Server handler agree on this field. This verifies
the published contract, not the currently shipped iOS serializer.

Catalog, Server-resolved radio and podcast identities are supported; arbitrary
client paths or UPnP selection references are not accepted as media identity.
An accepted event is not automatically a qualified play. See the canonical
[playback-event schema](../wiki-source/centralized-playback-history-and-scrobbling.md)
for defaults, identity resolution, thresholds and deduplication.

### P0 Home controls and Queue Wizard seed

The new Server-side migration boundary is:

```http
POST /v1/mobile/now-playing/control
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"action":"play"}
{"action":"pause"}
{"action":"stop"}
{"action":"next"}
{"action":"previous"}
{"action":"repeat"}
{"action":"consume"}
{"action":"consume","state":"on"}
{"action":"consume","state":"off"}
{"action":"repeatMode","mode":"off"}
{"action":"repeatMode","mode":"all"}
{"action":"repeatMode","mode":"one"}
{"action":"seekRelative","seconds":-30}
{"action":"seekPercent","percent":50}
```

Relative seek accepts only a non-zero integer from `-600` through `600`.
Percentage seek accepts a finite number from `0` through `100` and is
rounded by the Server. Unknown fields and non-object bodies are rejected.
`repeatMode` strictly accepts only `off`, `all`, or `one`. The Server maps
those modes to MPD `single off`/`repeat off`, `single off`/`repeat on`, and
`single on`/`repeat on`, respectively, then returns authoritative `mode`,
`repeatMode`, `repeatOn`, and `singleOn` readback. The existing `repeat` action
remains a toggle; `repeat-mode` is accepted as a compatibility spelling. An
invalid mode returns `400 MOBILE_REPEAT_MODE_INVALID_REQUEST`; a readback
mismatch returns `502 MOBILE_REPEAT_MODE_READBACK_MISMATCH`.
`consume` without `state` preserves the existing blind toggle. When supplied,
`state` strictly accepts only `on` or `off`; the response returns the
authoritative normalized `state` and boolean `consumeOn`. Invalid state returns
`400 MOBILE_CONSUME_STATE_INVALID_REQUEST`; unavailable or mismatched readback
returns `502 MOBILE_CONSUME_READBACK_MISMATCH`.
Responses contain no raw command, MPD path, renderer URL, or Track Key.

The Home route delegates to the existing Server playback-authority guard. It
does not release or take over Qobuz Connect. While Qobuz owns the receiver it
returns `409` with `code: "HOME_PLAYBACK_OWNERSHIP_CONFLICT"` and
`source: "qobuz-connect"`. Sonuvi UPnP ownership returns the same `409` code
with `source: "upnp-sonuvi"`. Native code must call
`POST /v1/mobile/qobuz-connect/release`, wait for confirmed inactive ownership,
then retry the Home action.

For an explicit Vibe seed, native code sends:

```http
POST /v1/mobile/queue-wizard/vibe
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"trackId":"trk_opaque_id","targetQueue":12,"playNow":true,"keepPlaying":true}
```

The Server resolves `trackId`, derives artist/title internally, and invokes the
existing Queue Wizard seeded builder. `targetQueue` is an integer from 1
through 200. The `202` response is sanitized:

```json
{"ok":true,"accepted":true,"jobId":"vibe_job_opaque","trackId":"trk_opaque_id","targetQueue":12}
```

The no-`trackId` mobile Vibe form remains as a compatibility adapter for older
callers that seed from the current Home track. New native migration work must
use the canonical-ID form. The iOS repository is intentionally unchanged in
this Server-only phase.

### Native-device Vibe preview

This is separate from the Home Queue Wizard job above and is non-mutating:

```http
POST /v1/mobile/vibe/preview
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"trackId":"trk_opaque_id","targetQueue":12}
```

The Server resolves `trackId`, derives the seed internally, and invokes the
existing Vibe engine's dry-run path. It returns `200` with canonical IDs and
safe metadata only:

```json
{
  "ok": true,
  "kind": "native-device-vibe-preview",
  "trackId": "trk_opaque_id",
  "targetQueue": 12,
  "count": 2,
  "unresolvedCount": 0,
  "catalogBuiltAt": "2026-10-20T00:00:00.000Z",
  "tracks": [{"id":"trk_recommendation_1","title":"Example","artist":"Example Artist"}]
}
```

Returned candidates are resolved by exact server-side file identity into the
canonical mobile catalog. There is no title/artist fallback and no file path
in the response. Unresolved candidates are omitted and counted; if no
candidate resolves, the Server returns `422`
`MOBILE_VIBE_PREVIEW_UNRESOLVED`. Other errors are `400`
`MOBILE_VIBE_PREVIEW_INVALID_REQUEST`, `404 MOBILE_TRACK_NOT_FOUND`, `400
MOBILE_VIBE_INELIGIBLE_TRACK`, `504 MOBILE_VIBE_PREVIEW_TIMEOUT`, or sanitized
`502 MOBILE_VIBE_PREVIEW_FAILED` as applicable. `catalogBuiltAt` is the
catalog timestamp or `null`; each track uses the existing sanitized
`MobileTrack` DTO and bearer-protected artwork URL, never a file path.

The preview creates no Home Queue Wizard job, does not mutate Home MPD queue
or playback, saved queues, or physical shuffle state, and does not release or
take over Qobuz Connect or UPnP. The mobile caller sends only the bearer token
and canonical ID; the internal dry-run bridge and Track Key remain server-only.

### Qobuz Connect

- Read `GET /v1/mobile/qobuz-connect` and
  `GET /v1/mobile/qobuz-connect/queue`. The snapshot is versioned as
  `qobuz-connect.v1` and includes source/owner, connection and receiver
  state, freshness, playback, current track, capabilities, and queue data.
- Supported guarded controls are `POST` routes for `play`, `resume`, `pause`,
  `next`, `previous`, `seek`, and `queue/jump` under
  `/v1/mobile/qobuz-connect/`.
- Seek requires the current `qobuzTrackId` and `positionSec`. Queue jump
  requires the target index/ID, opaque `queueFingerprint`, expected current
  index/count, and a non-shuffled queue. The fingerprint is a concurrency
  token, not a catalog identity.
- `POST /v1/mobile/qobuz-connect/release` is the explicit handoff to Home
  moOde. Treat success as authoritative only after the Server confirms
  inactive Qobuz ownership and enhanced receiver readiness. A failed or
  unconfirmed release must fail the Home action closed.
- Saved Qobuz queues are Server-owned ordered occurrences. Capture requires a
  stable confirmed-active cursor; play requires explicit confirmation and
  typed operation-status polling.

The Server does not authenticate a Qobuz account or expose Qobuz credentials
to iOS. The working Connect receiver/control boundary is PiBuZ.

### UPnP

Use the bearer bridge under `/v1/mobile/upnp/*`, not the Track-Key web/admin
`/upnp/*` routes. The bridge covers discovery, media-server capabilities and
browse/search, mediated artwork, renderer capabilities/transport, preflight,
sessions, and logical queues.

- Sonuvi owns the logical queue, queue `revision`, playback session, and
  renderer/session generation. The selected renderer executes transport.
- Queue mutations carry the current `revision`; transport is bound to the
  renderer/session generation. Responses expose `queueAuthority`, allowlisted
  capabilities, and last confirmed renderer state rather than raw device
  URLs.
- `POST /v1/mobile/upnp/queues/:queueId/takeover` requires explicit
  `confirm: true` and the current `sessionGeneration`. An explicit `takeover:
  true` on a Play Now request is the compatibility equivalent. Ordinary play
  does not silently take over active MPD, Qobuz, or uncertain renderer
  playback.
- Use queue routes for Sonuvi-owned playback so revision and generation
  guards remain authoritative. Use renderer transport routes only for the
  explicitly supported external-renderer transport case.

## Playback-authority rules

1. **Home moOde / Alexa:** Home moOde and Alexa local/theater requests use
   Server-mediated MPD queue/transport. Echo-targeted requests instead deliver
   audio through Echo AudioPlayer with Server/skill coordination; request
   origin, queue coordination and physical output are distinct. Before a
   Home mutation from Qobuz, release Qobuz first.
2. **Qobuz Connect:** PiBuZ owns the remote receiver/session and remote queue.
   `available` or `connected` is not enough; only fresh confirmed-active
   ownership permits guarded control. Qobuz playback is excluded from MPD
   history/scrobble attribution while PiBuZ owns the renderer.
3. **UPnP:** Sonuvi's logical queue/session is authoritative for Sonuvi-owned
   UPnP playback; the renderer's MPD queue is an implementation detail. Do not
   infer ownership from the renderer alone, and do not silently take over.
4. **This iPhone/iPad:** the current app may maintain a native device queue
   and play authorized local/server media, but current shared identities and
   metadata remain the Server's opaque `MobileTrack`/mobile contracts.
5. **History:** native code reports observations. The Server owns identity
   resolution, qualification, deduplication, local history, and Last.fm.

## Approved future boundary

The target architecture is an iOS-device-owned canonical Catalog with
provider observations, canonical enrichment, and server-independent native
playback. It is not implemented by these Server routes. Identity merging,
metadata-conflict rules, provider synchronization, and the final offline/
server-independent playback contract remain open design work and must be read
from `now-playing-ios/AGENTS.md`, `docs/architecture.md`, and
`docs/decisions.md` during the separate iOS audit.

## iOS audit checklist

- Confirm every native request uses the mobile bearer boundary and never a
  Track Key or raw integration URL.
- Replace legacy native calls to Track-Key playback and seeded-Vibe routes with
  the P0 contracts above during the separate iOS migration; use the native
  preview for device-owned recommendations and the Queue Wizard job only for
  intentional Home jobs. This handoff does not include that client change.
- Confirm the client treats `source`/ownership fields as authority signals,
  not titles/artwork/paths.
- Confirm Qobuz control uses the required current-track/CAS fields and release
  confirmation before Home mutations.
- Confirm UPnP queue revisions, session generations, and explicit takeover
  confirmation are preserved through the client model.
- Confirm SSD disconnect, stale manifests, and cache misses retain canonical
  track and queue identity.
- Confirm native progress events use stable session IDs and do not submit
  Last.fm credentials or duplicate scrobbles.

*Prepared: 2026-10-21 05:40 America/Chicago*

*Contract clarification reviewed: 2026-10-28 America/Chicago*
