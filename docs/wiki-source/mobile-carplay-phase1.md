---
title: mobile-carplay-phase1
page_type: guide
topics:
  - api
  - ios
  - carplay
  - security
confidence: medium
---

# Native iPhone/iPad/CarPlay Phase 1

This page documents the current gated server/client foundation for the native
iPhone, iPad, and CarPlay project. It is separate from the existing browser/
PWA controller. Device playback is local to the selected Apple device;
Home moOde and Alexa remain explicit server-managed targets.

## Phase 1 boundary

The canonical flow is:

```text
iPhone/iPad + Tailscale
        |
        | HTTPS /v1/mobile
        v
Sonuvi app host
        |
        | server-side opaque-ID resolution
        v
canonical track -> SSD/cache/server byte resolution -> native playback
```

The attached SSD is a local audio source/cache below the same canonical track
and queue model. It does not become a second library or offline mode. The
first source-resolution slice uses the authenticated local-source manifest,
checks exact canonical IDs and file size, and falls back to the existing media
authorization when the SSD is disconnected, missing a track, or stale. The
manifest's `contentPath` is relative to the folder selected on the portable
volume, so that folder's name does not have to match the moOde library root.

## Server implementation

Source files:

- `src/routes/mobile.routes.mjs` — versioned mobile API routes.
- `src/lib/mobile-auth.mjs` — signed access, refresh-session, and media-ticket tokens.
- `src/lib/mobile-track-identity.mjs` — opaque IDs and sanitized catalog views.
- `src/routes/track.routes.mjs` — shared byte-range and MP3-transcode helpers;
  the existing `/track` behavior remains unchanged.
- `src/routes/art.routes.mjs` — shared authorized artwork resolver/cache.
- `src/lib/mobile-pairing.mjs` — ephemeral single-use pairing challenges,
  device proof verification, approval state, and app completion.
- `src/lib/listening-history.mjs` — shared server-side history qualification
  used by MPD observation and native device playback events.
- `Sources/NowPlayingCarPlayCore/LocalSourceResolver.swift` — canonical-ID
  local byte resolution without a local catalog or queue.
- `scripts/mobile-pairing-ui.js` — shared display-side pairing widget used by
  Config and Controller Settings.

The route registration is always present in source but is disabled unless
`MOBILE_API_ENABLED=1` and both mobile secrets are configured.

### Mobile session lifetime

The native app receives a short-lived 12-hour bearer access token plus a
separate one-year refresh credential during enrollment or device pairing. The
refresh credential is stored in the iOS Keychain, never placed in the QR
payload, and is used automatically after an authenticated request receives a
401. The app retries that request once with the renewed access token, so normal
use does not require signing in every 12 hours. A new pairing is only needed
when the refresh credential expires or the mobile API signing secret is
rotated. The refresh route is `POST /v1/mobile/session/refresh` with the
credential in `X-Mobile-Refresh-Token`. During the rollout, an updated app can
also migrate an existing signed-but-expired legacy access token once, so
current installations do not need to pair again merely to receive the new
refresh credential.

## Environment configuration

These values belong in the host’s private environment, never in the iOS app
or source control:

```text
MOBILE_API_ENABLED=1
MOBILE_API_SECRET=<persistent random signing secret>
MOBILE_TRACK_ID_SECRET=<persistent random ID secret>
MOBILE_API_ENROLLMENT_CODE=<temporary operator enrollment code>
MOBILE_PUBLIC_BASE_URL=https://<tailnet-now-playing-name>
MOBILE_TRACK_CACHE_DIR=/tmp/now-playing/mobile-track-cache
MOBILE_TRANSCODE_TRACKS=1
```

`MOBILE_API_SECRET` is not `TRACK_KEY`. Rotating the track-ID secret changes
catalog IDs and therefore requires the client’s catalog cache to be rebuilt.

## Live tailnet transport

The remote mobile path is deployed on the Sonuvi host through Tailscale.
The installation-specific MagicDNS hostname is deliberately kept in the
private host environment rather than committed to the repository.

The live transport is:

```text
iPhone/iPad with Tailscale connected
        |
        | HTTPS, tailnet only, TCP 443
        v
Tailscale Serve on the Sonuvi host
        |
        | proxy to http://127.0.0.1:3101
        v
Sonuvi mobile API
```

Operational requirements and boundaries:

- `tailscaled` is enabled and running on the Sonuvi host.
- Tailscale HTTPS/Serve provides the trusted certificate and maps the
  tailnet-only HTTPS hostname to the local API port.
- `MOBILE_PUBLIC_BASE_URL` is set to the HTTPS Tailscale hostname without a
  port, path, query string, or fragment. Pairing QR payloads use this value.
- Tailscale Funnel is not enabled. The API is not exposed to the public
  Internet.
- Tailscale membership is network access only; the mobile app still requires
  its own pairing-issued bearer session and short-lived media tickets.
- The iOS/iPadOS Tailscale app must be connected before the native client can
  reach the server away from the home LAN.

The current music files remain on the existing home storage path. The Now
Playing host resolves opaque mobile track IDs and reads its existing local
mount of the moOde library; the native client never receives an SMB path,
MPD path, or filesystem permission. The moOde player host does not need its
own Tailscale installation for this playback path, and SMB/MPD/moOde services
must not be exposed directly to the tailnet client.

After changing `MOBILE_PUBLIC_BASE_URL`, generate a fresh pairing QR. A device
that was paired against the old home-LAN URL must be re-paired so its stored
API base URL is replaced with the HTTPS tailnet URL. A simple transport check
from a Tailscale-connected device is the unauthenticated controller-profile
endpoint:

```text
https://<tailnet-now-playing-name>/config/controller-profile
```

It should return the normal JSON profile response. This checks DNS, Tailscale
reachability, certificate trust, Serve, and the local API proxy without
exposing a bearer token.

## API contract

### Enrollment

```http
POST /v1/mobile/session
X-Mobile-Enrollment-Code: <temporary code>
Content-Type: application/json

{"deviceId":"iphone-brian"}
```

The response contains a short-lived 12-hour bearer access token and a separate
one-year refresh token. The native app must store both in the iOS Keychain and
must never place the refresh token in a QR payload or display-side response.
The enrollment code remains an operator-managed bootstrap credential; it is not
used as a bearer token.

### Silent session renewal

```http
POST /v1/mobile/session/refresh
X-Mobile-Refresh-Token: <refresh token>
```

The refresh route verifies the HMAC signature, `mobile-refresh` scope,
expiration, and device ID using `MOBILE_API_SECRET`. It returns a fresh
12-hour `accessToken`, its `expiresAt`, the device ID, and the refresh token.
It does not require a Track Key. Native clients should call it after a normal
mobile request receives `401 mobile session is missing or expired`, update the
Keychain access token, and retry the original request once.

During migration, an existing installation may send its old signed access
token as `Authorization: Bearer ...` together with
`X-Mobile-Session-Migration: 1` to receive the new token pair. Expired access
tokens are accepted only on this migration route; ordinary mobile routes still
reject them. A rotated `MOBILE_API_SECRET` invalidates both refresh tokens and
this migration path. The current implementation is stateless, so there is no
per-device refresh-token revocation store; secret rotation is the revocation
mechanism.

### Local-device pairing

The server/display half of the native-app pairing flow is implemented in this
repository. It is available from:

- the authenticated **Config** page in `app.html` (`config.html`); and
- **Controller → Settings** (`controller-tablet-settings.html`).
- an already-paired native iPhone/iPad in **Settings → Add another device**.

The browser surfaces use the same API and shared browser widget. The native
display uses those same pairing endpoints and QR protocol; it is not a second
pairing implementation.

Pairing is disabled unless `MOBILE_API_ENABLED=1` and both mobile signing
secrets are configured. Browser displays continue to require a real Now
Playing Track Key as their display authorization/CSRF-equivalent; an already-
authenticated native device uses its existing bearer session instead. No
cookie session is introduced.

#### Pairing actors and credential flow

The **authorized display** and **requesting unpaired device** are different
roles. An already-paired iPhone/iPad may act as the authorized display using
its existing bearer session; it does not need the web/admin Track Key.

```text
Authorized display                 Server                  New native device
(web Track Key OR existing bearer)
  create challenge ----------------->
  <-------------------- QR payload
  show QR ----------------------------------------------------> scan
                                      <---- challenge + signed public-key proof
  list requests + display token ---->
  approve + display token + code --->
                                      <---- completion poll + private poll token
                                      ----> access/refresh credentials
```

The QR is not an access credential and contains neither Track Key nor bearer,
display, or poll token. The new device cannot approve itself just by possessing
the QR. Use the exact endpoint/credential table below rather than a diagram
that labels the new app's first request “Admin Track Key.”

#### Protocol

1. An authorized web display (Track Key) or already-paired native display
   (bearer session) calls `POST /v1/mobile/pairing/challenges`.
2. The server creates an in-memory challenge with a 90-second lifetime and a
   separate in-memory display approval token. It returns a QR image and safe
   display state.
3. The QR JSON contains exactly these fields:

   ```json
   {
     "protocol": "now-playing-mobile-pairing",
     "version": 1,
     "baseUrl": "https://<configured-server>",
     "challenge": "<opaque-high-entropy-value>",
     "expiresAt": 0
   }
   ```

   It never contains `MOBILE_API_SECRET`, `MOBILE_TRACK_ID_SECRET`, the
   enrollment code, Track Key, a bearer token, a display token, a poll token,
   a private key, or a filesystem path. `MOBILE_PUBLIC_BASE_URL` is preferred;
   otherwise the server derives the visible address from the request host.
   Configured URLs must be HTTP(S) URLs without credentials, query strings, or
   fragments.
4. The app creates an Ed25519 or P-256 key pair and submits
   `POST /v1/mobile/pairing/requests` with `challenge`, `deviceId`,
   `deviceName`, `deviceModel`, `publicKey`, `signature`, and
   `signatureAlgorithm`.
5. The signature proves possession of the private key over this exact UTF-8
   message, with normalized device fields:

   ```text
   now-playing-mobile-pairing-v1
   <challenge>
   <deviceId>
   <deviceName>
   <deviceModel>
   ```

   The server does not accept a no-proof fallback. Public keys may be PEM or
   base64url-encoded DER SubjectPublicKeyInfo. Ed25519 uses the raw signature
   algorithm; `ecdsa-p256-sha256` uses SHA-256 with the normal DER ECDSA
   signature encoding.
6. The app receives only a short-lived poll token, request ID, verification
   code, and expiry. The display polls
   `GET /v1/mobile/pairing/requests` with its separate display token and sees
   only safe device identity, code, status, and timestamps.
7. The display calls the approve or reject endpoint with the visible
   verification code. The first valid approval wins; all other pending
   requests on that challenge are rejected.
8. The app polls
   `GET /v1/mobile/pairing/requests/:requestId/complete` with its poll token.
   Only that app-held poll token can receive the normal mobile access and
   refresh tokens. The display never receives or displays those tokens.

Pairing endpoints:

| Method | Route | Credential | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/mobile/pairing/challenges` | Track Key (web) or bearer session (native) | Create challenge and QR data |
| GET | `/v1/mobile/pairing/requests` | Track Key/bearer session + display token | List pending requests |
| POST | `/v1/mobile/pairing/requests` | QR challenge + public-key proof | Submit app request |
| POST | `/v1/mobile/pairing/requests/:requestId/approve` | Track Key/bearer session + display token + code | Approve one request |
| POST | `/v1/mobile/pairing/requests/:requestId/reject` | Track Key/bearer session + display token + code | Reject one request |
| POST | `/v1/mobile/pairing/challenges/cancel` | Track Key/bearer session + display token | Cancel the display challenge |
| GET | `/v1/mobile/pairing/requests/:requestId/complete` | App poll token | Complete approved pairing and receive session |

Pairing state is intentionally memory-only in this server/display phase. A
server restart invalidates all challenges, display tokens, poll tokens, and
pending requests. Expired state is cleaned up on requests and by an unref’d
timer. Replays, use-after-approval, wrong display credentials, wrong codes,
expired challenges, and malformed proofs are rejected. No pairing secret or
token is written to logs.

The pre-existing `POST /v1/mobile/session` enrollment endpoint remains
backward-compatible while now returning the access/refresh token pair. The
native app may use pairing instead of the manual enrollment code; both the web
and native display sides now use the same pairing protocol.

### Catalog

Authenticated catalog routes:

- `GET /v1/mobile/catalog/stats`
- `GET /v1/mobile/catalog/artists`
- `GET /v1/mobile/catalog/artists/:artistId/albums`
- `GET /v1/mobile/catalog/albums`
- `GET /v1/mobile/catalog/albums/:albumId`
- `GET /v1/mobile/catalog/tracks/:trackId`
- `GET /v1/mobile/search?q=...`
- `GET /v1/mobile/artwork/:trackId`

Responses contain opaque IDs and metadata only. They do not contain MPD file
paths, filesystem paths, `TRACK_KEY`, MPD song IDs, or queue positions.

List responses are capped at 100 items per page. The native client follows
the `nextCursor`/`total` pagination contract so the Artists and Albums
surfaces load the complete catalog instead of stopping at the first page.
Album responses may also include `addedAt`, an opaque numeric timestamp used
only for native Newest Added and Oldest Added sorting. The timestamp is
enriched server-side from the existing library-health album metadata route;
the mobile client never receives its Track Key or filesystem paths.

Track IDs use an HMAC over MusicBrainz track identity when available. When a
MusicBrainz ID is absent, the server uses normalized metadata plus a
server-side path/parent-folder hint to keep duplicate editions separate. The
path is never returned to the client.

### Playlists

The playlist contract is documented in [Mobile Playlist API](mobile-playlists.md).
It provides bearer-authenticated playlist summaries and ordered entries using
opaque playlist and track IDs, plus the scoped Add to Playlist wrapper used by
native action pickers. Playlist membership is resolved through the server’s
existing MPD/catalog logic; raw playlist files and Track-Key/admin routes
remain server-only.

### Media

```http
POST /v1/mobile/media-authorizations
Authorization: Bearer <session-token>
Content-Type: application/json

{"trackId":"trk_...","format":"original"}
```

The client chooses `original` for FLAC and other iOS-native formats when the
**Prefer original audio quality** setting is enabled. It chooses `mp3` when
lower transfer size or broader compatibility is preferred; non-MP3 source
files are then transcoded into the temporary mobile cache. The response
contains a one-hour, track- and device-bound URL compatible with `AVPlayer`,
supports HTTP byte ranges, and does not alter MPD playback. Normal native
**Play** starts from this URL as soon as the player has buffered enough audio.
Playlist **Download & Play** starts from the same URL immediately, then
downloads a second copy in the background and installs it atomically for later
offline playback. The client never points `AVPlayer` at a partially written
local file. Cache eviction is a Phase 1 hardening item.

The ticket is the only credential accepted by the media route. The server
re-resolves the opaque ID and verifies the local file before serving it.

### Portable SSD path roots

The local-source manifest retains `relativePath` for server-side compatibility
and also supplies `contentPath`, which omits the server-only top-level music
directory. The iOS resolver uses `contentPath` relative to the user-selected
SSD folder, then checks containment, file type, format, and exact byte size.
Renaming the SSD's top-level folder is therefore unnecessary; only the content
below the selected root must match the manifest. Manifest requests are
revalidated and the server response is not cacheable so a changed SSD layout or
server mapping is observed without reinstalling the app.

### Native playback history

Native device playback reports canonical progress to:

```http
POST /v1/mobile/playback/events
Authorization: Bearer <session-token>
Content-Type: application/json

{"trackId":"trk_...","sessionId":"device-session","state":"progress","elapsedSec":78,"durationSec":214,"startedAtMs":1793180000000}
```

The Server resolves supported catalog/radio/podcast identity and feeds shared
history; the client cannot substitute a filesystem path. `startedAtMs` is Unix
epoch milliseconds; `startedAt` is not an alias. Omitted state defaults to
`progress`, although explicit reporting is recommended. See the full
[event schema and qualification rules](centralized-playback-history-and-scrobbling.md).
Local and remote bytes do not create different identity namespaces; Server
history/Last.fm ownership is implemented, not merely a future scrobble path.
Device playback order remains device-owned, not the Home MPD queue.

### Native radio streaming

Native radio playback is separate from Home moOde queue playback. The station
list continues to return an opaque station ID; the moOde `station.file` URL
stays server-side. The native client requests:

```http
POST /v1/mobile/radio/stream-authorizations
Authorization: Bearer <session-token>
Content-Type: application/json

{"stationId":"rad_..."}
```

The response contains a station ticket URL for:

```http
GET /v1/mobile/radio/stream/:stationId?ticket=...
```

The server resolves the station URL, follows normal HTTP redirects, requests
ICY metadata when available, and proxies the live response to `AVPlayer`. The
radio ticket is scoped to the station and device. Radio is durationless and is
not downloaded into the local music cache. Existing `POST /v1/mobile/radio/play`
and `/queue` remain the Home moOde operations.

## Security boundary

- Tailnet access is required operationally, but is not treated as app auth.
- The app uses its own bearer session token.
- Media authorization is short-lived and bound to device, track, format, and
  expiration.
- Device pairing requires an app-generated public-key proof before approval
  can produce a session.
- The authenticated display sees a device identity and verification code, not
  a bearer token or private key.
- No permanent media URL or global Alexa `TRACK_KEY` is used.
- Alexa’s `/track` route remains separate.
- All route errors returned to the client are generic; internal logs must not
  include tokens or signed URLs.
- Tailscale Serve is tailnet-only; do not enable Funnel for the mobile API.
- The tailnet transport terminates at the Sonuvi host. Do not give the
  native app direct access to the moOde host, CIFS/SMB, MPD, or the library
  filesystem.

The Phase 1 enrollment code is intentionally a temporary POC mechanism and is
not single-use in this first implementation; rotate it after enrollment.
Before distribution, add persistent device sessions, refresh-token rotation,
revocation, rate limits, and audit-safe enrollment logging.

The `now-playing-ios` project implements the companion side of
the pairing contract: generate/store the device key in Keychain, encode the QR
payload, sign the canonical message, submit the pending request, poll with the
poll token, and store the completed session token in Keychain. This session
intentionally does not modify that sibling project or deploy this
server/display work.

## Current client boundary

The separate Apple client project is `../now-playing-ios` in the workspace. It
contains the shared Swift catalog/session/media models, bearer API client,
Keychain pairing, adaptive iPhone/iPad shell, canonical device Live Queue,
AVFoundation playback, Application Support cache, attached-SSD resolver,
native playback-history reporter, Siri/App Intents, and the standard CarPlay
template coordinator. See the native repository's
`docs/native-feature-surfaces.md` for the user-facing feature matrix.

### Current Server contract

The current Server remains authoritative for the existing opaque `MobileTrack`
identities, metadata, playlists, artwork, Home moOde/Alexa queue state, and
history qualification. A native device queue may hold those identities and
play authorized local/server media, but the Server still owns the shared
mobile contracts and the history/scrobble decision. The client never receives
raw MPD/file paths, Track Keys, Qobuz credentials, or Alexa credentials.

The concise contract checklist for the separate native-client audit is the
[Server → iOS contract handoff](https://github.com/teacherguy2020/now-playing/blob/main/docs/ios/server-to-ios-contract-handoff-2026-10.md).

The two contracts that connect local native playback back to the Server are:

- `GET /v1/mobile/local-source/manifest`, which reports canonical-ID to
  relative-file availability; a missing or stale local copy is a cache miss,
  not a new track identity; and
- `POST /v1/mobile/playback/events`, which accepts canonical progress events
  and lets the Server qualify history and Last.fm submission.

### Approved target, not current behavior

The approved future architecture is an iOS-device-owned canonical Catalog that
aggregates provider observations and can support server-independent native
playback. That target does **not** yet define or implement identity merging,
metadata-conflict resolution, provider synchronization, or the final
server-independent playback contract. This page must not turn those open
design questions into a claimed current API.

## Deployment and verification status

The server/display pairing flow and Tailscale transport were deployed and
verified on the live installation on 2026-09-27. The completed transport
checks were:

1. Tailscale was installed and authenticated on the Sonuvi host.
2. The host received a stable tailnet identity and MagicDNS name.
3. Tailscale Serve was configured as a tailnet-only HTTPS proxy to local API
   port `3101`; Funnel remains disabled.
4. Tailscale issued a trusted certificate for the MagicDNS hostname.
5. `MOBILE_PUBLIC_BASE_URL` was changed to that HTTPS hostname and the Sonuvi
   service was restarted successfully.
6. The pairing flow was tested from the Config and Controller Settings
   displays, and the native app completed pairing and catalog browsing.

Remaining native-client verification and hardening:

1. With Tailscale connected, confirm the controller-profile URL above from
   the iPhone and iPad.
2. Generate a fresh QR and re-pair any client that still has the old LAN URL.
3. Authorize a known MP3 and verify `206` range behavior from the tailnet.
4. Authorize one non-MP3 file and verify bounded transcoding/cache behavior.
5. Test the same media URL from AVFoundation while the phone is locked.
6. Confirm remote playback leaves the home MPD queue, Alexa playback, and
   moOde configuration unchanged.
7. With an attached SSD, verify the cache-miss matrix: disconnected source,
   absent canonical track, stale size entry, and reconnect. Each case must
   preserve the canonical track ID and fall back to remote media when needed.
8. Exercise all thirteen Home shelf sources and their actions, target handoff, Siri collection
   intents, and the playback-diagnostics toggle on unlocked devices.
9. For pairing, retain coverage for the QR payload, public-key proof, display
   approval, wrong code, replay/expiry, restart invalidation, and confirmation
   that the display never receives the session token.

Full SSD synchronization, server-side refresh-token revocation, remaining
Siri/Alexa physical acceptance, and CarPlay vehicle validation remain separate
follow-ups. The CarPlay Audio entitlement itself is
approved and configured in the signed native target.

*Last reviewed: 2026-10-28 America/Chicago*
