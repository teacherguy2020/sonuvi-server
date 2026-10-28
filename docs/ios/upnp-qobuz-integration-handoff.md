# Sonuvi Server → Native iOS UPnP / Qobuz Integration Handoff

**Status:** Server-side reference for Codex; bearer mobile UPnP bridge, explicit confirmed renderer takeover, and source-independent approved-renderer transport control deployed; no native iOS changes included
**Verified:** 2026-10-14, America/Chicago
**Server:** Sonuvi on 10.0.0.4 (sonuvi.local), deployed at /opt/now-playing
**Native target:** /Users/brianwis/.openclaw/workspace/now-playing-ios

This is a technical contract derived from deployed Server source, tests, and
read-only live responses. It records what exists now and what native iOS still
needs. It does not authorize Qobuz authentication, credential handling, direct
SOAP, or native iOS implementation.

## Codex Quick Start

1. Read now-playing-ios/AGENTS.md, now-playing-ios/docs/architecture.md, and
   now-playing-ios/docs/decisions.md.
2. Read the Server implementations:
   - src/routes/upnp.routes.mjs
   - src/lib/upnp-control-point.mjs
   - src/lib/upnp-playback-queue.mjs
   - src/lib/upnp-playback-session.mjs
   - src/routes/mobile.routes.mjs
   - src/routes/mobile-upnp.routes.mjs
   - src/lib/mobile-upnp-sanitize.mjs
   - src/routes/art.routes.mjs
3. Do not make iOS call /upnp/* with the Track Key. Those are web/admin
   contracts. Use the implemented /v1/mobile/upnp/* bearer bridge.
4. Start with Moode DLNA browsing through that bridge before Qobuz. The Qobuz
   MediaServer is discoverable, but its catalog is not authenticated.
5. For a user-confirmed renderer handoff, use the dedicated
   `POST /v1/mobile/upnp/queues/:queueId/takeover` route, or send the literal
   JSON boolean `takeover:true` on an explicit Play Now request to
   `POST /v1/mobile/upnp/queues/:queueId/play`; ordinary queue play remains
   fail-closed when another source owns the renderer.
6. When an approved renderer is already playing an external UPnP queue, first
   call `GET /v1/mobile/upnp/renderers/:deviceId/transport`. Use its explicit
   capability booleans and then the matching `POST .../transport/*` route for
   Pause, Resume, Stop, Seek, Next, or Previous. Do not use the renderer
   transport route for Sonuvi-owned queue playback; use the queue routes so
   revisions and session generations remain authoritative.
7. Keep separate identities for canonical/native catalog tracks, UPnP provider
   items, selection references, queue items, playback sessions/generations,
   Track Key credentials, and mobile bearer credentials.

The Server-side bearer bridge described in section 4 is now implemented. It
reuses the existing control point, queue, and session managers; it does not
create a second UPnP engine or queue.

## 1. Architecture

~~~text
Native iOS
    │  current bearer mobile API: catalog/Home queue/now-playing/artwork/media
    │  bearer mobile UPnP API: /v1/mobile/upnp/*
    ▼
Sonuvi Server 10.0.0.4
    │
    ├── SSDP control point ──► UPnP MediaServers
    │                          ├── Moode DLNA / MiniDLNA :8200
    │                          └── upmpdcli Qobuz MediaServer :49152
    │
    ├── trusted UPnP session/queue ──► Moode UPnP renderer 10.0.0.254
    │                                    └── moOde / MPD / CAVALLI DAC
    │
    ├── ordinary MPD/Home queue and playback routes
    │
    └── Qobuz Connect observation ──► Pibuz/Qobuz Connect metadata path
~~~

- Sonuvi Server owns UPnP discovery, DIDL-Lite normalization, trusted resource
  selection, queue revisions, playback ownership, and renderer commands.
- Moode DLNA is a browsable, provider-neutral MediaServer.
- The upmpdcli Qobuz MediaServer is advertised and discoverable, but its Qobuz
  catalog currently requires account authorization.
- The Moode UPnP renderer is the only approved Sonuvi playback renderer.
  Discovered Denon and Sony renderers are observable but not trusted for
  Sonuvi playback.
- MPD remains the normal moOde playback engine and Home queue. The Sonuvi
  logical UPnP queue is separate from the MPD Live Queue UI.
- Pibuz/Qobuz Connect is a separate playback/metadata source. Its
  qobuz-connect observation is not proof that the Qobuz ContentDirectory is
  authenticated.
- Native iOS should consume the implemented Server-mediated bearer contract. It
  should not send SSDP, SOAP, raw LAN URLs, or Track-Key requests.

The native catalog decisions remain authoritative: the device-owned catalog is
the target; current Server MobileTrack IDs are transitional provider
identities. A UPnP item ID is not a canonical recording identity.

## 2. Deployment and Live Evidence

The current Server branch is `main` at the previously committed checkpoint:

    3b969f6 fix: clear stale motion art on UPnP playback

The source-independent renderer transport patch remains an intentional
uncommitted working-tree change; no commit or push was performed for this
deployment.

The deployed transport files and verified hashes are:

    src/lib/upnp-control-point.mjs 538d9fbd55308990d1ad1d59536ee1f76ae530e7ccc740fa9be6f652e8dedc9d
    src/lib/upnp-playback-session.mjs
                                   fc10cfa79e5f75ebd53b1c6d680f4cb5bcc5bc3223523ed903dcbf5a9690652e
    src/lib/mobile-upnp-sanitize.mjs
                                   1e2faee41307549a8148d1b347b6ac5d23f542ded157f15c5a6bca0fb8e30518
    src/routes/mobile-upnp.routes.mjs
                                   23e959bcea82af466b75f6251a56addfbea2beda62c2d790374905d53c8f6561

Before deployment, the exact previous deployed files were backed up at:

    /var/backups/sonuvi-mobile-upnp-20261013T090551Z/

The exact pre-takeover runtime files were additionally backed up at:

    /var/backups/sonuvi-upnp-takeover-20261013T120825Z-2/

The pre-cleanup-fix deployed session file was also backed up at:

    /var/backups/sonuvi-upnp-takeover-20261013T121134Z-safety/

The exact pre-compatibility-fix mobile route was also backed up at:

    /var/backups/sonuvi-upnp-play-now-20261013T201124Z/

The exact pre-transport files were additionally backed up at:

    /var/backups/sonuvi-upnp-renderer-transport-20261014T204331Z/

The verified backup hashes were:

    src/lib/upnp-control-point.mjs 8b6e45ae3954a3a3ae3938a7765f4f2c2d932c756c924682425de287bd1a66a3
    src/lib/upnp-playback-session.mjs
                                   4fd9c4c81c8a6015757f0145da886a5ba9aecee7b0cfa4384f5e3da500b08550
    src/lib/mobile-upnp-sanitize.mjs
                                   54aed918b50e0ba7b333d552ab68861e578d677fb3c4948df9cd07f9d3c42113
    src/routes/mobile-upnp.routes.mjs
                                   b14979dcbab79742b1a5f548f4b67a8c285c1fcbbca4b900c9ca6c4597bfdad2

The backup hashes were the previous deployed entrypoint
`f6fc2a9f64395d0b4b0dd016cc1bf924a4aa1bf35bcab2e23de78a0538eff8fa` and
mobile route
`f209a1d3de1bebc613ac96fea0d24264373f8a8acb1eab3ce136c0dce000f6d3`.
`now-playing.service` was restarted for the takeover deployment and its
follow-up cleanup safety fix, and the Play Now compatibility correction; each
check reported active with `ExecMainStatus=0`. Read-only post-deployment
probes returned 401 for `/v1/mobile/upnp/devices` and an unauthenticated
`/play` request, and 403 for the unchanged Track-Key web `/upnp` route. No
authenticated operation, playback, or queue mutation was performed.

For the 2026-10-14 source-independent transport deployment, the service
restart again reported `active` with `ExecMainStatus=0`; the four deployed
hashes above matched their local files. The new bearer transport route
returned HTTP 401 without a mobile session, and the unchanged Track-Key web
route returned HTTP 403. Before restart, the read-only Now Playing response
reported active Sonuvi UPnP playback for Pat Metheny / *Bright Size Life*.
After verification, the moOde read-only `mpc` check was idle/current-empty;
no stop or other playback command was issued by this deployment.

now-playing.service is active. Read-only discovery returned six responses with
no failures. Relevant devices:

| Role | Friendly name | Server device ID | UDN |
|---|---|---|---|
| MediaServer | Moode DLNA | 14b8790012d75fc0c519288c | uuid:4d696e69-444c-164e-9d41-88a29e103726 |
| MediaServer | Moode UPNP-mediaserver | 6365885b99171b2ba8bb7e6c | uuid:6ac11c35-e5bd-e575-dac0-88a29e103726 |
| approved renderer | Moode UPNP | ae286f5fad0ff19f541251bc | uuid:5e211097-4658-5161-a661-88a29e103726 |

The same discovery saw a Denon renderer, a Sony UBP-X700 renderer, and a Hue
Bridge. They are not approved playback renderers.

Read-only live observations:

- GET /upnp/queue returned an inactive/null Sonuvi UPnP queue.
- Moode DLNA root browse returned Browse Folders, Music, Pictures, and Video.
- Qobuz Account status was not_connected with authentication not_verified.
- Browsing the Qobuz root returned HTTP 424, code QOBUZ_AUTH_REQUIRED.
- Approved Moode renderer inspection reported STOPPED/OK/1 and audio sinks
  including audio/flac and audio/mpeg.
- No playback or queue mutation was performed for this handoff.

Post-takeover-deployment read-only verification also found six SSDP responses
with no discovery failures, the Qobuz MediaServer advertised, and the approved
Moode renderer responding with STOPPED and 15 advertised/read-only AVTransport
actions. A direct browse of `0$qobuz$` still timed out (`UPNP_TIMEOUT`, HTTP
502 at the control-point boundary), which is consistent with the documented
unfinished Qobuz catalog authorization; no authenticated Qobuz request was
made. The current live MPD/Now Playing payload did identify the M1 UMS media
resource family at `10.0.0.68:5001/ums/...`; it is observed media, not an
approved Sonuvi renderer target. No separate UMS device identity was present
in the Server's SSDP discovery result.

## 3. Authentication Boundaries

### Web/admin UPnP routes

The deployed /upnp/* routes use the existing Track Key in the x-track-key
header or k query parameter. A missing or wrong key returns HTTP 403 with the
text response Forbidden.

This is a web/admin control credential, not a native session credential and not
a recording identity. Native iOS must not embed it, request it from the user,
or put it in a URL.

### Existing native mobile session

The mobile API is enabled only when its configured mobile secrets and feature
flag are present. A paired native client uses:

    Authorization: Bearer <mobile-api access token>

The access token has scope mobile-api and a default 12-hour lifetime. The
refresh token has scope mobile-refresh and a default 365-day lifetime. Invalid
or expired access credentials return:

    HTTP 401
    {"ok":false,"error":"mobile session is missing or expired"}

Bootstrap:

    POST /v1/mobile/session
    X-Mobile-Enrollment-Code: <enrollment code>
    {"deviceId":"<validated device id>"}

Response shape:

    {"ok":true,"tokenType":"Bearer","accessToken":"...","refreshToken":"...","expiresAt":"...","deviceId":"..."}

Refresh:

    POST /v1/mobile/session/refresh
    X-Mobile-Refresh-Token: <refresh token>

Token values in these examples are placeholders and must never be logged or
included in documentation.

Existing pairing routes create and complete challenges, list/submit requests,
approve/reject requests, and cancel challenges. QR payloads do not contain
access tokens. Reuse this pairing design; do not create a second enrollment
mechanism for UPnP.

### Implemented mobile access

The bearer mobile API now exposes the UPnP-specific routes in section 4. They
require the same mobile-api access token as the existing catalog routes and do
not accept a Track Key fallback. The bridge returns opaque device IDs,
selection references, queue IDs, session IDs, and generations, while omitting
device-description URLs, service URLs, raw media-resource URLs, MPD queue
entries, signed stream URLs, SOAP input, and Qobuz account material.

## 4. Complete Integration-Related API Inventory

This is the complete inventory of deployed UPnP, Qobuz-status, and relevant
native mobile contracts. Unrelated podcast, radio, video, and catalog routes
remain in src/routes/mobile.routes.mjs.

### 4.0 Implemented bearer mobile UPnP bridge

All routes in this subsection require the mobile API to be enabled and require:

    Authorization: Bearer <mobile-api access token>

Missing, invalid, or expired credentials use the existing response:

    HTTP 401
    {"ok":false,"error":"mobile session is missing or expired"}

The bridge is registered by `src/routes/mobile.routes.mjs` and implemented in
`src/routes/mobile-upnp.routes.mjs`. It uses runtime getters for the control
point, session manager, and queue manager because those managers are initialized
after mobile route registration during Server startup.

#### Discovery and read-only capabilities

| Method and path | Query/request | Response and behavior |
|---|---|---|
| `GET /v1/mobile/upnp/devices` | Optional `refresh=1` | Returns only normalized MediaServers and the approved renderer at the configured renderer host. Other renderers are not returned as approved targets. |
| `GET /v1/mobile/upnp/devices/:deviceId` | Opaque device ID | Describes a MediaServer or the approved renderer. Other device roles return HTTP 400 `UPNP_WRONG_DEVICE_ROLE`. |
| `GET /v1/mobile/upnp/media-servers/:deviceId/capabilities` | Opaque MediaServer ID | Returns ContentDirectory action/capability flags and sanitized service identity. |
| `GET /v1/mobile/upnp/renderers/:deviceId/capabilities` | Opaque approved renderer ID | Returns read-only renderer/protocol/AVTransport capability state. It does not grant playback ownership. |
| `GET /v1/mobile/upnp/renderers/:deviceId/transport` | Opaque approved renderer ID | Returns source-aware, read-only transport capabilities for the approved renderer. It does not mutate playback. |
| `GET /v1/mobile/upnp/preflight` | Required `rendererId` | Performs the existing read-only MPD, Qobuz Connect, renderer, and ownership preflight. `mutationExecuted` is always `false`. |

Discovery response example (URLs intentionally absent):

    {
      "ok": true,
      "responseCount": 3,
      "failures": [{"code":"UPNP_TIMEOUT"}],
      "mediaServers": [{
        "id": "<opaque-device-id>",
        "udn": "uuid:<provider-udn>",
        "deviceType": "urn:schemas-upnp-org:device:MediaServer:1",
        "roles": ["media-server"],
        "friendlyName": "Moode DLNA",
        "available": true,
        "services": [{
          "serviceType": "urn:schemas-upnp-org:service:ContentDirectory:1",
          "serviceId": "urn:upnp-org:serviceId:ContentDirectory",
          "version": "1",
          "actions": ["Browse", "Search"]
        }]
      }],
      "approvedRenderer": {
        "id": "<approved-renderer-id>",
        "udn": "uuid:<renderer-udn>",
        "roles": ["media-renderer"],
        "friendlyName": "Moode UPNP",
        "approved": true,
        "available": true
      }
    }

Renderer preflight preserves safe ownership facts only:

    {
      "ok": true,
      "qobuz": {"active": false, "suppressMpdHistory": false},
      "mpd": {"state":"stop","playlistLength":2,"playlistVersion":"9"},
      "renderer": {
        "id":"<approved-renderer-id>",
        "transport":{"state":"STOPPED","status":"OK","speed":"1"},
        "media":{"currentUriPresent":false,"nextUriPresent":false},
        "loadedMedia":false,
        "currentActions":["Play","Stop"],
        "protocolInfo":{"available":true,"source":[],"sink":[]},
        "avTransportActions":["SetAVTransportURI","Play","Pause","Stop"]
      },
      "playbackMutationAvailable":true,
      "mutationExecuted":false
    }

The response never contains `location`, `scpdUrl`, `controlUrl`,
`eventSubUrl`, current media URIs, MPD file paths, queue hashes, or raw
renderer XML.

#### Source-independent approved-renderer transport

These routes are the separate transport authority for the configured and
approved moOde renderer. They require the same bearer session as the rest of
the mobile UPnP bridge. They do not adopt, replace, or mutate Sonuvi's logical
UPnP queue.

| Method and path | Request | Semantics |
|---|---|---|
| `GET /v1/mobile/upnp/renderers/:deviceId/transport` | None | Re-reads the approved renderer and Qobuz ownership state. Returns `source`, `owner`, `queueAuthority`, transport state, and capability booleans. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/pause` | Empty JSON body | Pauses an externally controlled active UPnP renderer session when the renderer advertises Pause. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/resume` | Empty JSON body | Resumes an externally controlled paused UPnP renderer session through AVTransport Play at speed 1. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/stop` | Empty JSON body | Stops an externally controlled active UPnP renderer session. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/seek` | `{\"positionSeconds\": number}` | Seeks an active external track with a known duration through `REL_TIME`. The value must be finite, non-negative, no more than 24 hours, and no greater than the advertised duration. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/next` | Empty JSON body | Advances an external renderer queue only when `GetMediaInfo` reports more than one track and the renderer advertises Next. |
| `POST /v1/mobile/upnp/renderers/:deviceId/transport/previous` | Empty JSON body | Moves backward under the same renderer-queue authority conditions as Next. |

Example external capability response:

    {
      "ok": true,
      "renderer": {
        "id": "<approved-renderer-id>",
        "udn": "uuid:<renderer-udn>",
        "friendlyName": "Moode UPNP"
      },
      "source": "external-upnp",
      "owner": "external",
      "queueAuthority": "renderer",
      "queueRouteRequired": false,
      "capabilities": {
        "pause": true,
        "resume": false,
        "stop": true,
        "seek": true,
        "next": true,
        "previous": true,
        "queueEdit": false
      },
      "controlsAllowed": ["pause", "stop", "seek", "next", "previous"],
      "transport": {
        "state": "PLAYING",
        "status": "OK",
        "speed": "1",
        "relativeTime": "00:00:12",
        "trackDuration": "00:03:21",
        "positionSeconds": 12,
        "durationSeconds": 201,
        "trackNumber": 1,
        "numberOfTracks": 8,
        "currentMediaPresent": true
      },
      "approved": true,
      "verified": true,
      "mutationExecuted": false
    }

Mutation responses repeat the source-aware state and add `action`,
`mutation`, and `mutationExecuted:true`. The server confirms the resulting
renderer state before returning success. For Seek, confirmation is within
three seconds of the requested position; for Next/Previous, the track number
or current media identity must change. A command that the renderer accepts but
does not confirm returns HTTP 409 `UPNP_TRANSPORT_UNCONFIRMED`.

`source` and `queueAuthority` have these meanings:

- `external-upnp` / `renderer`: the approved renderer has a current UPnP
  media URI and its renderer-reported queue has more than one track. Basic
  transport is allowed according to the capability booleans; queue editing is
  never exposed by these routes.
- `upnp-sonuvi` / `sonuvi`: the current URI matches Sonuvi's owned session.
  Renderer transport mutation returns `UPNP_QUEUE_AUTHORITY_REQUIRED`; use
  `/v1/mobile/upnp/queues/:queueId/*` with its revision and generation.
- `qobuz-connect` / `unavailable`: Qobuz Connect is active or its history
  suppression state is active. No renderer transport mutation is sent.
- `unknown`: the renderer is transitioning, in error, or otherwise cannot be
  classified safely. No mutation is sent.
- `external-upnp` / `unavailable` or `unknown`: the renderer queue cannot be
  proven to contain multiple controllable tracks, so Next/Previous fail with
  `UPNP_EXTERNAL_QUEUE_UNAVAILABLE`.

All renderer transport mutations are serialized by the existing UPnP session
mutation lock. They use only the bounded AVTransport actions Pause, Play,
Stop, Seek, Next, and Previous with instance 0. No arbitrary SOAP action,
media URL, Qobuz credential, signed resource, or MPD queue mutation is exposed.
An active ordinary MPD file or AirPlay marker that does not match the
renderer-reported media URI makes ownership `unknown`, so no renderer command
is sent.

#### ContentDirectory browse, search, and artwork

| Method and path | Parameters | Response and behavior |
|---|---|---|
| `GET /v1/mobile/upnp/media-servers/:deviceId/browse` | `objectId`, `browseFlag`, `filter`, `startingIndex`, `requestedCount`, `sortCriteria` | Uses the existing bounded Browse call and returns normalized containers/tracks plus opaque `selectionRef` values. Defaults are `0`, `BrowseDirectChildren`, `*`, `0`, `100`, and empty sort criteria. |
| `GET /v1/mobile/upnp/media-servers/:deviceId/search` | `containerId`, `searchCriteria`, `filter`, `startingIndex`, `requestedCount`, `sortCriteria` | Uses the existing Search call and returns normalized results. Search remains provider-capability dependent. |
| `GET /v1/mobile/upnp/media-items/:selectionRef/artwork` | Opaque selection reference | Returns the Server-fetched image bytes with the trusted Content-Type and `Cache-Control: private, max-age=300`. It requires bearer auth. |

Browse/search item response example:

    {
      "kind":"item",
      "id":"<provider-item-id>",
      "parentId":"<provider-parent-id>",
      "title":"Fixture Track",
      "artist":"Fixture Artist",
      "album":"Fixture Album",
      "class":"object.item.audioItem.musicTrack",
      "selectionRef":"<short-lived-selection-reference>",
      "mediaServerId":"<opaque-device-id>",
      "mediaServerUdn":"uuid:<provider-udn>",
      "artworkAvailable":true,
      "resources":[{
        "protocolInfo":"http-get:*:audio/flac:*",
        "mimeType":"audio/flac",
        "duration":"0:03:21.000",
        "durationSeconds":201,
        "sampleFrequency":96000,
        "bitsPerSample":24,
        "audioChannels":2
      }]
    }

The mobile representation deliberately omits `artworkUrl`, `uri`, and
`protocolAdditionalInfo`. Browse/search responses retain the selectionRef
contract: references are process-local, tied to the trusted Server-side
selection cache, and expire after approximately 15 minutes. Native code must
refresh the browse result rather than persist or reconstruct a reference.

#### UPnP queue and transport

The bridge keeps the existing logical UPnP queue separate from
`GET /v1/mobile/queue` (the Home/MPD queue). It does not expose standalone
session selection/load/play routes; queue creation and queue `play` use the
existing session manager internally.

| Method and path | Body/query | Mutation semantics |
|---|---|---|
| `POST /v1/mobile/upnp/queues` | `{rendererId,itemRefs}`; `selectionRefs` and `itemRef` are accepted aliases | Creates the one process-local logical queue. Returns HTTP 201 and `mutationExecuted:false`. |
| `GET /v1/mobile/upnp/queue` | None | Current queue snapshot without requiring a queue ID. Read-only. |
| `GET /v1/mobile/upnp/queues/:queueId` | Opaque queue ID | Read-only queue snapshot. |
| `POST /v1/mobile/upnp/queues/:queueId/items` | `{itemRefs,revision}`; aliases accepted | Adds trusted selections; revision required. `mutationExecuted:false`. |
| `DELETE /v1/mobile/upnp/queues/:queueId/items/:itemId` | `revision` body or query | Removes an item subject to existing active-item guards. `mutationExecuted:false`. |
| `POST /v1/mobile/upnp/queues/:queueId/clear` | `revision` body or query | Clears the queue and stops its owned session. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/reorder` | `{itemId,toIndex,revision}` | Reorders the logical queue. `mutationExecuted:false`. |
| `POST /v1/mobile/upnp/queues/:queueId/takeover` | `{confirm:true,itemId?,index?,revision,sessionGeneration?}` | Explicitly releases a supported active owner of the approved renderer, starts the selected trusted item, and returns the authoritative queue/session state. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/play` | `{itemId?,index?,revision?,autoplay?,takeover?,sessionGeneration?}` | Selects/loads/plays through the existing session manager. Literal `takeover:true` routes this explicit Play Now request through the guarded takeover operation; omitted/false remains ordinary fail-closed Play. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/resume` | `{revision?,autoplay?}` | Resumes the owned session. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/pause` | `{revision?}` | Pauses the owned session. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/stop` | `{revision?}` | Stops and releases the owned session. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/next` | `{revision?,autoplay?}` | Advances through the logical queue. `mutationExecuted:true`. |
| `POST /v1/mobile/upnp/queues/:queueId/previous` | `{revision?,autoplay?}` | Moves backward through the logical queue. `mutationExecuted:true`. |

Queue responses preserve the existing identity/ownership fields:

    {
      "ok": true,
      "active": false,
      "queue": {
        "queueId":"<opaque-queue-id>",
        "revision":4,
        "rendererId":"<approved-renderer-id>",
        "items":[{
          "queueItemId":"<opaque-queue-item-id>",
          "selectionRef":"<selection-reference>",
          "mediaServerId":"<opaque-device-id>",
          "mediaItemId":"<provider-item-id>",
          "title":"Fixture Track",
          "artist":"Fixture Artist",
          "album":"Fixture Album",
          "artworkAvailable":true,
          "resource":{"mimeType":"audio/flac","durationSeconds":201}
        }],
        "currentIndex":-1,
        "currentItemId":"",
        "sessionId":"",
        "sessionGeneration":"",
        "playbackState":"stopped",
        "lastConfirmedRendererState":"",
        "lastError":null,
        "persistence":"memory"
      },
      "mutationExecuted":false
    }

An accepted takeover response also contains a safe operation result:

    {
      "ok":true,
      "takeover":{
        "confirmed":true,
        "stoppedMpd":false,
        "stoppedRenderer":true
      },
      "mutationExecuted":true,
      "mutation":"QueueTakeover"
    }

`confirm` must be the JSON boolean `true`; the dedicated path and confirmation
are both required. `revision` is always required. `sessionGeneration` must
match the queue snapshot when the queue still has one; a mismatch returns
`UPNP_SESSION_GENERATION_CONFLICT`. `itemId` or `index` selects the target;
when neither is supplied the current item is used, or the first item if the
queue has no current item.

Takeover support is intentionally narrow:

- An active MPD source may be stopped through the existing Server MPD command
  adapter, then UPnP ownership is established.
- An active transport on the approved Moode renderer may be stopped when the
  renderer advertises a current safe `Stop` action.
- The UPnP takeover API cannot release Qobuz Connect. It returns
  `UPNP_QOBUZ_TAKEOVER_UNSUPPORTED` without stopping or changing Qobuz. The
  separate authenticated Config action `POST /config/qobuz/session/release`
  now provides the explicit Qobuz renderer-release path.
- Transitioning, error, unavailable, or uncertain renderer state is rejected.
- An active Sonuvi session is rejected; takeover never force-replaces a
  Sonuvi-owned session.

For native Play Now callers that already use the ordinary `/play` route, a
literal JSON `takeover:true` is accepted as the explicit intent and is mapped
to the same guarded takeover operation. It is not accepted on Add, Resume,
Pause, Next, or Previous. A missing or non-boolean flag remains ordinary Play
and therefore continues to reject active MPD/Qobuz/external ownership.

The server re-reads Qobuz, MPD, and renderer state immediately before release
and again before starting the trusted item. If release succeeds but loading or
playing fails, the response is HTTP 502 `UPNP_TAKEOVER_START_FAILED`; the old
owner is not automatically restored and the logical queue is left stopped.
If a release command fails, the response is HTTP 409
`UPNP_TAKEOVER_STOP_FAILED` with only boolean stop results. No raw resource
URLs, credentials, signed URLs, or SOAP arguments are returned. Cleanup after a
start failure stops the renderer only when its current URI still matches the
selected trusted resource; it does not stop a different owner that appeared
during the handoff.

Transport state can also be read without changing it:

    GET /v1/mobile/upnp/sessions/:sessionId
    GET /v1/mobile/upnp/sessions/:sessionId/transport

Those responses preserve `sessionId`, `generation`, `ownsAudio`, renderer
identity, transport state, queue baseline length/version, `queueChanged`, and
`mutationCount`, but omit baseline MPD entries, raw artwork, and raw resource
URLs. Transport controls are never accepted as arbitrary SOAP actions.

#### Error schema and ownership rules

Errors use the existing HTTP status categories and a mobile-safe JSON shape:

    {"ok":false,"error":"The UPnP queue changed; refresh it and try again.",
     "code":"UPNP_QUEUE_REVISION_CONFLICT",
     "details":{"currentRevision":5}}

The bridge preserves these important status/code combinations:

| Status | Codes | Meaning |
|---:|---|---|
| 400 | `UPNP_BAD_REQUEST`, `UPNP_WRONG_DEVICE_ROLE`, `UPNP_INVALID_MEDIA_ITEM` | Invalid request or unsupported device/item role. |
| 404 | `UPNP_QUEUE_ITEM_NOT_FOUND`, device/session errors | Opaque handle is unavailable. |
| 409 | `UPNP_QUEUE_REVISION_CONFLICT`, `UPNP_QUEUE_STALE`, `UPNP_STALE_MEDIA_ITEM`, `UPNP_SESSION_GENERATION_CONFLICT`, `UPNP_OWNERSHIP_LOST`, `UPNP_OWNERSHIP_UNCERTAIN`, `UPNP_QOBUZ_ACTIVE`, `UPNP_QOBUZ_TAKEOVER_UNSUPPORTED`, `UPNP_MPD_ACTIVE`, `UPNP_MPD_TAKEOVER_UNSUPPORTED`, `UPNP_RENDERER_ACTIVE`, `UPNP_RENDERER_TAKEOVER_UNSUPPORTED`, `UPNP_TAKEOVER_ACTIVE_SESSION`, `UPNP_TAKEOVER_STOP_FAILED`, `UPNP_TAKEOVER_STATE_CHANGED`, `UPNP_QUEUE_AUTHORITY_REQUIRED`, `UPNP_TRANSPORT_BAD_STATE`, `UPNP_TRANSPORT_UNSUPPORTED`, `UPNP_EXTERNAL_QUEUE_UNAVAILABLE`, `UPNP_TRANSPORT_UNCONFIRMED` | Refresh state, resolve ownership, use the authoritative queue route, or wait for the source/renderer to reach a safe state. |
| 424 | `QOBUZ_AUTH_REQUIRED` | Qobuz container was reached but catalog authentication is required. |
| 428 | `UPNP_QUEUE_REVISION_REQUIRED` | A destructive queue mutation omitted its revision. |
| 502 | `UPNP_TAKEOVER_START_FAILED` | The prior owner was released but the selected trusted item did not start. |
| 503 | `UPNP_RENDERER_UNAVAILABLE` | The approved renderer cannot be reached or used. |

The mobile bridge returns only allowlisted public messages and, for revision
conflicts, the integer `currentRevision`. It does not forward exception text,
tokens, authorization codes, provider URLs, signed resources, or private MPD
details. Native clients must not automatically retry destructive operations
after 409/428; reread the authoritative queue/session first.

Every route in this table requires the web/admin Track Key.

| Method and path | Request | Response/semantics |
|---|---|---|
| GET /upnp/devices | Query refresh=1 forces discovery; otherwise cached/cooldown discovery | {ok:true,discoveredAt,responseCount,failures,devices} |
| GET /upnp/devices/:deviceId | Opaque server device ID | {ok:true,device} |
| GET /upnp/media-servers/:deviceId/capabilities | MediaServer device ID | {ok:true,device,service,browse,search,actions,searchCapabilities,sortCapabilities} |
| GET /upnp/media-servers/:deviceId/browse | objectId default 0; browseFlag default BrowseDirectChildren; filter default *; startingIndex default 0; requestedCount default 100; sortCriteria default empty | {ok:true,device,objectId,browseFlag,startingIndex,requestedCount,numberReturned,totalMatches,updateId,items} |
| GET /upnp/media-servers/:deviceId/search | Required searchCriteria; containerId default 0; filter, startingIndex, requestedCount, sortCriteria | {ok:true,device,containerId,searchCriteria,startingIndex,requestedCount,numberReturned,totalMatches,updateId,items} |
| GET /upnp/media-items/:selectionRef/artwork | Trusted recent track selection reference | Binary image; Cache-Control private, max-age=300 |

Browse flags are BrowseMetadata and BrowseDirectChildren. Pagination is
bounded to starting index 0..10,000,000 and requested count 0..500. Object IDs,
criteria, filters, and sort criteria have bounded lengths and reject controls.

For the Qobuz namespace, only a timeout under 0$qobuz$ is classified as
authentication-required:

~~~text
HTTP 424
{"ok":false,"error":"Qobuz account authorization is required before this catalog can be browsed.","code":"QOBUZ_AUTH_REQUIRED"}
~~~

Other timeouts are not automatically classified as authentication failures.

Unless a route explicitly returns a binary response, UPnP failures use:

    {"ok":false,"error":"<safe message>","code":"UPNP_ERROR","details":{}}

The status is the route-specific 4xx/5xx status when known, otherwise 502.
Clients should branch on stable code values and treat the message as display
text, not as a protocol discriminator.

### 4.2 Track-Key renderer inspection

| Method and path | Request | Response/semantics |
|---|---|---|
| GET /upnp/renderers/:deviceId/capabilities | Query approved=1 requests approved-renderer validation; probeState=0 skips state probing; default probes | {ok:true,device,inspection,approved?,playbackMutationAvailable:false,avTransportActions,connectionManagerActions} |
| GET /upnp/preflight | Query rendererId=device ID | Read-only {ok:true,qobuz,mpd,renderer,playbackMutationAvailable:true,mutationExecuted:false} |

The capability endpoint is observational even when it lists advertised
actions. The approved renderer must be the configured Moode host, currently
expected as 10.0.0.254, and must satisfy AVTransport and ConnectionManager
requirements.

Preflight checks Qobuz Connect activity, MPD activity, renderer state,
ownership uncertainty, and the MPD queue baseline. It performs no mutation.

### 4.3 Track-Key standalone sessions

| Method and path | JSON request | Response/semantics |
|---|---|---|
| POST /upnp/sessions | {itemRef,rendererId} | HTTP 201; selects a trusted recent Browse/Search item; {ok:true,...sessionSnapshot,mutationExecuted:false} |
| GET /upnp/sessions/:sessionId | None | Authoritative snapshot; renderer state is polled |
| GET /upnp/sessions/:sessionId/transport | None | Alias for session snapshot |
| POST /upnp/sessions/:sessionId/load | None | SetAVTransportURI; mutationExecuted true, mutation SetAVTransportURI |
| POST /upnp/sessions/:sessionId/play | None | Play at speed 1; mutation Play |
| POST /upnp/sessions/:sessionId/pause | None | Pause; mutation Pause |
| POST /upnp/sessions/:sessionId/stop | None | Stop; mutation Stop |

Session IDs and generations are opaque. Default session TTL is 30 minutes.
States include selected, loaded, playing, paused, ownership-lost,
renderer-unavailable, queue-changed, and stopped.

The session snapshot includes active, sessionId, generation, state, ownsAudio,
createdAt, expiresAt, renderer identity, the trusted item and public resource
format, transport state/status/speed/relative time/duration, the MPD queue
baseline hash/length/playlist version, queueChanged, mutationCount, and
lastError. It does not expose a client-controlled playback URL.

### 4.4 Track-Key logical queue

| Method and path | JSON request | Response/semantics |
|---|---|---|
| POST /upnp/queues | {rendererId,itemRefs?} | HTTP 201; approved renderer only; revision 1 with items, otherwise 0 |
| GET /upnp/queues/:queueId | None | Authoritative queue snapshot |
| GET /upnp/queue | None | Current process-local queue snapshot |
| POST /upnp/queues/:queueId/items | {itemRefs or selectionRefs or itemRef,revision} | Adds trusted items; mutation QueueAdd |
| DELETE /upnp/queues/:queueId/items/:itemId | Revision in body or revision query | Removes item; mutation QueueRemove |
| POST /upnp/queues/:queueId/clear | {revision} | Stops owned session and empties queue; QueueClear |
| POST /upnp/queues/:queueId/reorder | {itemId,toIndex,revision} | Reorders; QueueReorder |
| POST /upnp/queues/:queueId/play | Optional {itemId,index,revision,autoplay}; autoplay defaults true | Select/load/play; QueuePlay |
| POST /upnp/queues/:queueId/resume | Optional {itemId,index,revision,autoplay} | Resume/play; QueueResume |
| POST /upnp/queues/:queueId/pause | Optional {revision} | Pause; QueuePause |
| POST /upnp/queues/:queueId/stop | Optional {revision} | Stop while retaining queue; QueueStop |
| POST /upnp/queues/:queueId/next | Optional {revision,autoplay} | Advance; QueueNext |
| POST /upnp/queues/:queueId/previous | Optional {revision,autoplay} | Move back; QueuePrevious |

Successful mutations return:

    {"ok":true,"queue":{...},"mutationExecuted":true,"mutation":"QueueAdd"}

Reads set mutationExecuted false. The queue snapshot shape is:

~~~json
{
  "active": false,
  "queue": {
    "queueId": "...",
    "revision": 6,
    "rendererId": "...",
    "items": [],
    "currentIndex": -1,
    "currentItemId": null,
    "sessionId": null,
    "sessionGeneration": null,
    "playbackState": "stopped",
    "lastConfirmedRendererState": "STOPPED",
    "lastError": null,
    "persistence": "memory"
  }
}
~~~

The live inactive response was:

    {"ok":true,"active":false,"queue":null,"mutationExecuted":false}

### 4.5 Qobuz Account status

    GET /config/qobuz/account/status

This is Track-Key protected and read-only. Current live response:

~~~json
{
  "ok": true,
  "state": "not_connected",
  "reason": "The Qobuz MediaServer is available, but Qobuz account authorization has not been verified.",
  "checkedAt": "2026-10-13T09:45:59.294Z",
  "mediaServer": {
    "discovered": true,
    "id": "6365885b99171b2ba8bb7e6c",
    "udn": "uuid:6ac11c35-e5bd-e575-dac0-88a29e103726",
    "friendlyName": "Moode UPNP-mediaserver",
    "contentDirectory": true,
    "rootBrowse": true
  },
  "authentication": {
    "state": "not_verified",
    "verified": false,
    "lastVerifiedAt": null
  }
}
~~~

It never returns passwords, tokens, application credentials, authorization
codes, raw plugin configuration, private logs, or signed stream URLs.

Project status for this handoff is that Pibuz/Qobuz Connect playback is
operational, the Qobuz developer-access request has been sent, and the
Qobuz Account UI is present while Connect remains disabled. The
upmpdcli MediaServer is enabled and discoverable, but catalog authentication
is not complete.

### 4.6 Existing bearer mobile routes

The mobile API must be enabled. Ordinary calls below require a valid bearer
`mobile-api` session; the media-delivery GET instead validates the scoped
short-lived media ticket issued by the bearer-authorized request. Pairing and
enrollment have their own [credential boundaries](../wiki-source/mobile-carplay-phase1.md#local-device-pairing).

| Method and path | Request | Current purpose |
|---|---|---|
| GET /v1/mobile/now-playing | None | Sanitized native DTO from canonical /now-playing; no-store |
| GET /v1/mobile/next-up | None | Native Next Up; not the UPnP queue |
| GET /v1/mobile/queue | None | Native/Home MPD queue; not the UPnP queue |
| POST /v1/mobile/queue/items | {mode:"append",trackId} | Adds canonical catalog track to Home MPD queue |
| POST /v1/mobile/queue/items/:queueItemId/play | None | Plays Home MPD queue item |
| DELETE /v1/mobile/queue/items/:queueItemId | None | Removes Home MPD queue item |
| POST /v1/mobile/queue/items/:queueItemId/move | {toPosition} | Reorders Home MPD queue item |
| POST /v1/mobile/queue/actions | {action:"clear"|"crop"|"shuffle"|"shufflequeue"} | Home MPD action; not UPnP |
| GET /v1/mobile/artwork/:trackId | Canonical trackId | Authenticated catalog artwork |
| POST /v1/mobile/media-authorizations | {trackId,format:"mp3"|"original"} | Short-lived canonical media ticket |
| GET /v1/mobile/media/:trackId | Query ticket | Serves media after mobile-media ticket validation |
| GET /v1/mobile/audio-info | None | Sanitized Moode/audio rows and optional playback information |
| GET /v1/mobile/local-source/manifest | None | Canonical-ID-to-relative-file availability |
| POST /v1/mobile/playback/events | {trackId,sessionId,state?,elapsedSec?,durationSec?,startedAtMs?} | Records native observation with source ios-device |
| GET /v1/mobile/history/recent | None | Recent native-visible history seed |

Playback events accept start, playing, progress, pause, stop, and ended; omitted
state defaults to progress. `startedAtMs` is Unix epoch milliseconds, not
`startedAt`. Use the [canonical ingestion schema](../wiki-source/centralized-playback-history-and-scrobbling.md)
for identity resolution, timestamp bounds and qualification. This
is not an UPnP queue/session event contract and expects a canonical/mobile
track identity, not a UPnP selection reference.

## 5. ContentDirectory Contract

### Discovery

The control point sends bounded SSDP requests to 239.255.255.250:1900 for
MediaServer and MediaRenderer types. Defaults are 3500 ms discovery timeout,
4500 ms HTTP timeout, and 3000 ms discovery cooldown. Native clients should
normally ask Sonuvi for a source snapshot rather than run SSDP themselves.

Use the UDN/UUID as the durable provider/device identity. The Server deviceId
is an opaque route handle and should be stored only alongside UDN, name, and
availability.

### Browse and search

ContentDirectory IDs are provider-scoped opaque strings. Root is conventionally
0, but clients must use returned IDs and preserve the selected MediaServer.
Do not assume Artist → Album → Track. The live Moode root exposes Folders,
Music, Pictures, and Video.

Search is available only when advertised. Moode DLNA currently advertises:

    dc:creator, dc:date, dc:title, upnp:album, upnp:actor, upnp:artist,
    upnp:class, upnp:genre, @id, @parentID, @refID

Sort capabilities are provider-advertised.

### DIDL-Lite normalization

Normalized item/container fields include:

    kind, id, parentId, refId, restricted, title, creator, artist, artists,
    albumArtist, album, trackNumber, class, artworkUrl, duration,
    durationSeconds, resources

Resource fields may include:

    uri, protocolInfo, mimeType, protocolAdditionalInfo, duration,
    durationSeconds, size, bitrate, sampleFrequency, bitsPerSample,
    audioChannels, resolution

Only HTTP(S) resources are retained. Resource URIs are not client-controlled
playback inputs.

### Selection references

Only track results from recent browse/search receive a generated opaque
selectionRef. Containers have an empty selection reference. References are
random, process-local, tied to the trusted device/location, and expire after
15 minutes. Invalid references produce UPNP_INVALID_MEDIA_ITEM; expired ones
produce HTTP 409 UPNP_STALE_MEDIA_ITEM.

The queue does not persist raw resource URIs because providers may return
signed or short-lived URLs. A future mobile API must preserve that property.

### Artwork

The Server fetches artwork server-side, checking HTTP(S), host/location trust,
redirect safety, image MIME type, and a 2 MiB response bound. Clients must not
fetch raw LAN artwork URLs supplied by DIDL-Lite.

## 6. UPnP Queue, Playback, and Concurrency

The logical queue is memory-only with persistence memory, bounded to 500 items.
A single add request is bounded to 100 items. Duplicate tracks are allowed
and receive distinct generated queue item IDs.

Queue item identity is separate from provider identity:

    queueItem.id
    queueItem.selectionRef
    queueItem.mediaServerId
    queueItem.mediaItemId
    queueItem.parentId
    metadata and public resource format fields

The public queue item omits the raw resource URI.

Every mutation requires an integer revision:

    HTTP 428, code UPNP_QUEUE_REVISION_REQUIRED
    HTTP 409, code UPNP_QUEUE_REVISION_CONFLICT, details {currentRevision}

On conflict, refresh authoritative state and show a non-destructive conflict
message. Do not automatically retry a destructive mutation.

Unknown/stale queue handles return HTTP 409 UPNP_QUEUE_STALE. Removing the
active item returns HTTP 409 UPNP_QUEUE_CURRENT_ITEM_ACTIVE. Missing item IDs
return HTTP 404 UPNP_QUEUE_ITEM_NOT_FOUND.

sessionId identifies a playback session. sessionGeneration/generation
identifies its ownership generation. Both are opaque. Queue contents alone do
not prove ownership.

Before ownership is granted, the Server checks that Qobuz Connect is
inactive, MPD is not playing/paused, the approved renderer is available and
stopped, ownership is not uncertain, and the MPD queue baseline is recorded.
External URI/ownership changes produce UPNP_OWNERSHIP_LOST. MPD queue changes
produce UPNP_QUEUE_CHANGED. Renderer absence produces HTTP 503
UPNP_RENDERER_UNAVAILABLE; renderer failures produce UPNP_RENDERER_ERROR.

While Sonuvi owns UPnP playback, conflicting MPD mutations return HTTP 409:

    {"ok":false,"unavailable":true,"source":"upnp-sonuvi","error":"MPD playback and queue controls are unavailable while Sonuvi UPnP owns the renderer"}

The queue poller runs by default every 1000 ms, minimum 500 ms. It advances
only after a previously playing item is observed stopped near its duration and
ownership remains valid. Poll failures and ownership uncertainty do not
advance the queue.

The AVTransport allowlist is:

    SetAVTransportURI, Play, Pause, Stop, Seek, Next, Previous,
    GetTransportInfo, GetPositionInfo, GetCurrentTransportActions, GetMediaInfo

SetPlayMode, repeat, and shuffle remain unavailable. Seek is exposed only for
an active external track with a known duration and an advertised Seek action;
Next/Previous are exposed only when the renderer reports a multi-track queue.

## 7. Now Playing and Source Arbitration

### Sonuvi-owned UPnP

An active session returns:

    source: upnp-sonuvi
    transport: upnp
    controller: sonuvi
    streamKind: upnp
    isUpnp: true
    isStream: true
    renderer: {id, udn, friendlyName}
    upnpItem: {...}
    upnpFormat: {...}
    state: play | pause | stop
    elapsed, duration, percent

This is authoritative only while the session is loaded, playing, or paused and
still owns the renderer. A stopped, expired, or taken-over session must not
leave a native UI believing it owns playback.

### Qobuz Connect

The separate Qobuz observation returns:

    source: qobuz-connect
    isQobuz: true
    qobuzConnect: true
    streamKind: qobuz-connect
    isUpnp: false
    sourceFormat, outputFormat, elapsed, duration

The Server can retain a last good payload briefly during a transport error,
marks it stale, and expires it. Qobuz Connect is not the Sonuvi UPnP queue and
is not controlled through /upnp/queues.

### Local MPD/Home playback

Normal local payloads come from moOde/MPD state and do not use the
upnp-sonuvi ownership marker. Normal local tracks generally have isStream
false, isUpnp false, and an empty streamKind. The native mobile queue is the
Home MPD queue, not the Sonuvi UPnP queue.

### External UPnP observation

The Server may observe an MPD/stream item with streamKind upnp and isUpnp true,
but that alone does not mean Sonuvi owns it. There is no separate guaranteed
source value external-upnp in the generic `/v1/mobile/now-playing` payload.
Native code must treat only source upnp-sonuvi plus the Sonuvi
controller/queue state as Sonuvi-owned. For an approved renderer, the new
bearer `GET /v1/mobile/upnp/renderers/:deviceId/transport` contract is the
authoritative source-independent classification and capability check. It may
report external-upnp even when the generic Now Playing DTO's `controls.allowed`
array is empty; the native client must not infer renderer capabilities from
that generic array.

### Control matrix

| Active source/condition | Interpretation | Allowed action |
|---|---|---|
| Local MPD/Home | Existing MPD/Home source | Existing bearer Home-queue contracts; do not route to UPnP |
| upnp-sonuvi | Sonuvi owns approved Moode renderer | `/v1/mobile/upnp/queues/*` controls only while `ownsAudio` is true |
| Qobuz Connect | Pibuz/Connect observation | Display only unless a separate control contract is approved |
| External UPnP on approved renderer | Not Sonuvi-owned | Use the bearer renderer transport routes for confirmed Pause/Resume/Stop/Seek/Next/Previous when their capability response allows it; queue edits remain disabled |
| Unknown/uncertain | Unsafe ownership | Disable unsafe transport and refresh |

The current web reference bridge is scripts/upnp-now-playing.js. It polls
/now-playing and /upnp/queue, routes owned transport to the logical queue, and
disables repeat, shuffle, and seek. The mobile bridge exposes the same
source-aware policy through the bearer `/v1/mobile/upnp/*` routes.

The bearer `GET /v1/mobile/now-playing` DTO now adds sanitized source fields:

    source: mpd | upnp-sonuvi | qobuz-connect | external-upnp | unknown
    controller: sonuvi | qobuz-connect | ""
    transport: upnp | ""
    renderer: {id, udn, friendlyName} | null
    ownsAudio: boolean
    generation: string
    transportState: string
    queueChanged: boolean
    upnpItem: normalized item | null
    upnpFormat: safe resource format | null
    controls: {allowed: [String], unsupported: [String]}

Only `upnp-sonuvi` with `controller: sonuvi` and `ownsAudio: true` enables
owned UPnP queue controls. For that source the allowed set is `play`,
`pause`, `resume`, `stop`, `next`, and `previous`; `seek`, `repeat`, and
`shuffle` are explicitly unsupported. MPD/Home controls remain on the
existing mobile Home queue contracts. Qobuz Connect and unknown ownership
remain read-only. External playback on the approved renderer has a separate
source-independent transport contract; it never grants queue edit authority
and never implicitly triggers takeover.

An owned UPnP session suppresses duplicate MPD history through
shouldSuppressMpdHistory(). The native event route records ios-device
observations; it is not a new UPnP scrobbling contract.

## 8. Artwork and Audio Information

The web /now-playing path updates the Server artwork cache from trusted UPnP
art and returns a Server-owned /art/current.jpg-style URL in albumArtUrl. It
also carries a display/source artwork field for the web client. Native should
use an authenticated mobile proxy, not an arbitrary provider URL.

The existing native-safe catalog artwork route is:

    GET /v1/mobile/artwork/:trackId

It accepts a canonical mobile catalog ID, not a UPnP selectionRef. The new
UPnP artwork route is:

    GET /v1/mobile/upnp/media-items/:selectionRef/artwork

It is bearer-authenticated and fetches the trusted artwork server-side. Native
code must not use the raw artwork URL from DIDL-Lite.

UPnP resource metadata may expose MIME type, protocol info, duration, bitrate,
sample frequency, bit depth, channels, and resolution. These are provider
metadata, not verified DAC output.

The existing bearer route GET /v1/mobile/audio-info returns sanitized rows from
the Moode audio-info integration. The Track-Key web source is
GET /config/moode/audio-info?view=rows|sections|both|all. Remote DAC/output
information is available only when the moOde diagnostic source reports it.
Idle/unavailable data must remain visibly unavailable.

Local source probing in scripts/source-audio.js provides cached sample rate,
bit depth, and channel information for local files; it is not live UPnP/DAC
verification.

## 9. Security Contract

Existing Server protections include:

- HTTP(S)-only trusted endpoint validation, no URL credentials, private/local
  target limits, and unsafe-redirect rejection;
- DTD/entity rejection and bounded XML/SOAP responses;
- DIDL metadata treated as data, not HTML;
- no raw client media URL accepted for playback;
- recent trusted Browse/Search selection references only;
- server-side artwork fetch with host, MIME, size, and redirect checks;
- configured Moode renderer host allowlist;
- no Qobuz password, token, application credential, auth code, raw config,
  private log, or signed stream URL in status responses;
- ownership checks and conflicting MPD mutation guards;
- scoped mobile bearer tokens and short-lived mobile media tickets.

Native iOS must never store/request the Track Key, call raw SOAP/SSDP as a
replacement for Server policy, accept arbitrary LAN URLs, inject a Qobuz URL,
receive Qobuz credentials/tokens/codes, use a friendly name as identity, retry
destructive commands after a revision conflict, infer ownership from queue
contents, or treat Qobuz Connect as Qobuz catalog authentication.

## 10. Native iOS Implementation Guidance

These are recommendations, not deployed routes.

Use separate Codable models:

    UPnPDevice, UPnPMediaServer, UPnPRenderer,
    UPnPMediaServerCapabilities, UPnPContainer, UPnPMediaItem,
    UPnPResourceFormat, UPnPBrowsePage, UPnPSearchPage,
    UPnPQueue, UPnPQueueItem, UPnPPlaybackSession, UPnPNowPlaying

Do not reuse MobileTrack as a UPnP item. Preserve selectionRef, queueItemId,
sessionId, and sessionGeneration as distinct opaque fields.

The deployed contract supports a native `MobileUPnPService` actor with these
methods:

    discover(force:)
    capabilities(for:)
    rendererTransportCapabilities(for:)
    rendererPause(for:)
    rendererResume(for:)
    rendererStop(for:)
    rendererSeek(for:positionSeconds:)
    rendererNext(for:)
    rendererPrevious(for:)
    browse(server:object:page:)
    search(server:container:criteria:page:)
    artwork(forSelection:)
    queue()
    addToQueue(selectionRefs:revision:)
    removeFromQueue(itemId:revision:)
    reorderQueue(itemId:toIndex:revision:)
    play(itemId:index:revision:)
    pause(revision:)
    resume(revision:)
    stop(revision:)
    next(revision:)
    previous(revision:)

Map these methods to the exact routes in section 4.0. Use the existing bearer
session transport, async calls,
typed errors, and an actor to serialize commands. Refresh authoritative state
after 409/428 conflicts. Do not run an independent playback clock when elapsed
position is unavailable.

UI guidance:

- Keep Music Sources provider-neutral and UDN-backed.
- Keep UPnP and Home MPD queues separate.
- For upnp-sonuvi, use the logical queue routes and preserve revision and
  session-generation checks.
- For external playback on the approved renderer, fetch the separate renderer
  transport capability response and enable only the returned actions. Queue
  editing remains disabled.
- Disable unsupported seek/repeat/shuffle rather than simulating them.
- Use Server-proxied artwork and show unavailable states.
- Preserve the source while navigating and avoid SSDP on every screen.

Follow native decision D-012: explicit user-initiated discovery against the
configured Sonuvi Server; do not launch-time scan the LAN. The current
discovery reference is http://sonuvi.local:3101/now-playing.

## 11. Staged Acceptance Plan

### Stage 0: Mobile contract

Exercise the deployed bearer discovery, browse/search, renderer preflight,
queue revisions and session generations, source-aware Now Playing, artwork,
and stable error schemas before native network calls.

### Stage 1: Moode DLNA browse

Discover by UDN; browse root and nested Folders/Music; verify pagination,
empty/error states, normalized metadata, duration, art, resource formats,
stale selection errors, and queue separation.

### Stage 2: Queue

Add bounded tracks; verify order, generated IDs, revision increments, duplicate
semantics, remove, reorder, stale revisions, and no destructive auto-retry.
Exercise takeover only as a separately confirmed operation, including stale
session-generation rejection and Qobuz refusal.

### Stage 3: Controlled playback

After separate playback approval, preflight with MPD/Qobuz Connect idle; play
one DLNA item; verify upnp-sonuvi, metadata, proxied art, elapsed position,
renderer state, pause/resume, next/previous, direct selection, stop, ownership
guards, and logical queue retention.

Do not initiate Qobuz authentication in the DLNA stage.

### Stage 3a: Source-independent renderer transport

With an externally initiated multi-track UPnP session already present, read the
renderer transport capability endpoint; verify source classification, bearer
authentication, Pause/Resume/Stop, bounded Seek, Next/Previous confirmation,
and the no-queue/uncertain/Qobuz conflict responses. Verify that no Sonuvi
queue revision, session generation, MPD queue, history, or Last.fm state is
created or changed by these operations.

### Stage 4: Source regression

Test local MPD, owned UPnP, Qobuz Connect observation, external UPnP
observation, renderer unavailable, and unknown ownership. Verify controls and
history behavior.

### Stage 5: Qobuz

Only after a separate authentication/policy decision and mobile API review:
verify Account status, browse provider-scoped containers, preserve provenance,
and use the same trusted Server renderer boundary. This handoff does not
authorize this stage.

## 12. Tests

Server coverage:

- test/upnp-control-point.test.mjs
- test/upnp-playback-queue.test.mjs
- test/upnp-playback-session.test.mjs
- test/upnp-renderer-transport.test.mjs
- test/upnp-web-controller.test.mjs
- test/mobile-upnp.routes.test.mjs
- test/config.qobuz-account.routes.test.mjs
- test/qobuz-connect.test.mjs

Native tests should cover bearer auth and expiry; UDN versus route identity;
browse/search/pagination; malformed artwork/resources; revision required and
conflict errors; session-generation/ownership loss; all source-control states;
no credential/token/signed-URI/LAN-URL leakage; artwork transitions; and
separate queues.

Server test command:

    npm test

It runs node --test test/*.test.mjs. The mobile bridge regression file covers
bearer enforcement, Track-Key rejection, device/renderer URL redaction,
browse/search normalization, selection references, bounded artwork,
preflight/session sanitization, queue revision forwarding, safe Qobuz errors,
source-aware Now Playing control classification, and explicit takeover
confirmation/redaction. The complete verification for this handoff passed
248/248 tests, including active, paused, and idle MPD Play Now takeover,
literal mobile `takeover:true` forwarding, repeated Play Now behavior, Qobuz
refusal, release-failure cleanup, start-failure cleanup, ordinary-play gating,
and queue revision/session-generation/concurrency conflicts. The additional
renderer-transport coverage verifies bearer route enforcement, external
Pause/Resume/Stop/Seek/Next/Previous confirmation, renderer-queue authority,
uncertain-state rejection, Qobuz protection, unconfirmed actions, and
serialized commands.

## 13. Known Limitations

1. Sonuvi logical-queue repeat and shuffle remain unavailable. Seek is not a
   Sonuvi queue operation; source-independent Seek is conditional on an active
   external track with a known duration and renderer-advertised Seek action.
   Source-independent Next/Previous likewise require a renderer-reported
   multi-track queue.
2. The logical UPnP queue is process-memory only and is not fully persisted
   across Server restarts.
3. UPnP playback can replace or affect the MPD queue baseline. The session
   reports UPNP_QUEUE_CHANGED but does not provide automatic MPD queue restore.
4. There is no new UPnP-specific history/scrobbling contract. Owned UPnP
   playback suppresses duplicate MPD history; native device playback uses
   ios-device events.
5. Qobuz MediaServer discovery is complete, but catalog authentication is not.
   The Qobuz Account UI is present and Connect remains disabled pending an
   approved authorization mechanism.
6. The bearer mobile bridge and source-independent renderer transport bridge
   are implemented, but native iOS still needs to consume and acceptance-test
   these routes.
7. Explicit renderer takeover is Server-side only; native iOS must provide a
   clear confirmation UI and send a fresh queue revision (and current session
   generation when present). The dedicated takeover route requires
   `confirm:true`; the existing Play Now route accepts only the literal JSON
   boolean `takeover:true` and maps it to the same guarded operation.

## 14. API Gaps Before Native Implementation

1. Native iOS must integrate and acceptance-test the deployed bearer routes,
   including the separate renderer transport capability and mutation routes;
   no native changes are included in this Server task.
2. UPnP history decision: define event identity/deduplication if UPnP playback
   should contribute to shared history; do not overload ios-device events.
3. Qobuz catalog authentication and policy approval remain unresolved. The
   bridge deliberately reports `QOBUZ_AUTH_REQUIRED` without starting login.
4. Queue persistence, repeat/shuffle, and any additional mobile-safe source
   controls remain outside this milestone. Source-independent renderer Seek,
   Next, and Previous are available only under the conditional contract in
   section 4.0.

Until the native acceptance stage is complete, Codex should not reuse Track-Key
web routes or send direct UPnP traffic from the iOS app.

## 15. Source Reference Map

| Concern | Authoritative source |
|---|---|
| UPnP routes/errors | src/routes/upnp.routes.mjs |
| SSDP, DIDL-Lite, trust, artwork, renderer validation | src/lib/upnp-control-point.mjs |
| Queue/revision semantics | src/lib/upnp-playback-queue.mjs |
| Session ownership/Now Playing DTO | src/lib/upnp-playback-session.mjs |
| Server setup, poller, MPD guard | moode-nowplaying-api.mjs |
| Qobuz Connect identity/staleness | src/lib/qobuz-connect.mjs |
| Qobuz Account status | src/routes/config.qobuz-account.routes.mjs |
| Bearer mobile contract | src/routes/mobile.routes.mjs, src/routes/mobile-upnp.routes.mjs, src/lib/mobile-upnp-sanitize.mjs |
| Native architecture | now-playing-ios/docs/architecture.md and decisions.md |
| Web source-aware behavior | scripts/upnp-now-playing.js |
| Operational UPnP/Qobuz notes | docs/runbooks/28-qobuz-connect-now-playing.md, docs/runbooks/29-upnp-queue-and-qobuz-media-server-poc.md, and docs/wiki-source/upnp-control-point.md |

No moOde/Pibuz configuration, Qobuz authentication, or native iOS source was
modified. This handoff accompanies the Sonuvi-only bearer mobile UPnP bridge
implementation and its regression tests.

*Contract clarification reviewed: 2026-10-28 America/Chicago*
