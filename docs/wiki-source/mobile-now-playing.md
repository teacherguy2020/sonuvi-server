# Mobile Home moOde Now Playing

This page defines the bearer-authenticated current-state contract used by the
native iPhone/iPad client. It keeps the controller-tablet `/now-playing`
truth surface authoritative without exposing its Track-Key/admin boundary to
the mobile app.

## Endpoint

```http
GET /v1/mobile/now-playing
Authorization: Bearer <mobile-session-token>
```

The route requires the existing `mobile-api` bearer scope. A Track Key alone
must receive HTTP 401. The native client never calls `/now-playing` directly.

This is a Server-backed current-state contract. It does not make the current
Server catalog permanent: the approved native target is an iOS-device-owned
canonical catalog with provider observations and server-independent native
playback, but identity merging, enrichment conflict rules, and synchronization
contracts for that target are not implemented here. Until those contracts are
approved, the client must treat the Server's opaque `MobileTrack` identity and
the routes in this page as authoritative for Home playback, metadata, artwork,
and history handoff.

## Response

```json
{
  "ok": true,
  "available": true,
  "title": "Example Track",
  "artist": "Example Artist",
  "album": "Example Album",
  "displayLine3": "Example Album",
  "artworkUrl": "https://host/v1/mobile/home/artwork/har_opaque",
  "state": "play",
  "isPlaying": true,
  "durationSec": 214.2,
  "elapsedSec": 35,
  "queueTrack": 3,
  "queueTotal": 171,
  "stationName": null,
  "stationLogoUrl": null,
  "isStream": false,
  "isPodcast": false,
  "isRadio": false,
  "isAirplay": false,
  "isUpnp": false,
  "isYoutube": false,
  "about": null,
  "aboutStatus": "no-data",
  "aboutProvider": null,
  "appleMusicUrl": null,
  "radioYear": null,
  "track": null,
  "isFavorite": true,
  "rating": 4,
  "ratingDisabled": false
}
```

`track` is the existing sanitized `MobileTrack` shape when the current queue
item belongs to the mobile catalog. It is null for streams or other items
that do not have a catalog identity. `available: false` is a valid empty or
temporarily unavailable state and is not an API error.

`queueTrack` and `queueTotal` describe the queue only when that information is
authoritative. During ordinary Home moOde playback, both fields identify the
current position and total MPD queue length. During fresh Alexa playback,
`queueTrack` is null because Alexa's AudioPlayer position is not an MPD
position, but `queueTotal` remains the full logical server queue length used by
Live Queue. If that queue read is temporarily unavailable, it falls back to
the known Alexa buffer count: one for the current item, or two when the
recorded ENQUEUE successor is present. The native iPad summary therefore shows
the full count without pretending to know an Alexa track position.

For a music-bearing radio stream, the ordinary `title`, `artist`, `album`, and
`artworkUrl` fields reflect the existing conservative server-side metadata
pipeline. That pipeline cleans station metadata, rejects likely talk/news/
sports content, and only promotes a verified Apple match. Ordinary
non-classical artist/title pairs try the Server's authenticated Apple Music
Catalog Search authority first, using strict artist/title acceptance, fixed
Apple endpoints, no redirect following, and short per-track single-flight
coordination. The older public iTunes matcher remains the bounded fallback;
the specialized classical/curated paths retain its existing context-aware
rules rather than accepting a generic Catalog result.

When a match exists, `radioYear` is populated when available and
`appleMusicUrl` contains the exact matched track URL (falling back to the
matched album URL). The mobile route only emits HTTPS URLs on Apple-controlled
`music.apple.com` or `itunes.apple.com` hosts; untrusted or non-Apple links
become `null`. Provider tokens, raw stream URLs, redirect targets, and
provider error bodies are never part of the mobile contract.

For radio streams, `stationName` and `stationLogoUrl` identify the live
station independently of the current song. `artworkUrl` may therefore be
matched song artwork while `stationLogoUrl` remains the protected station
logo. The mobile route accepts the canonical station aliases
`stationName`, `radioStationName`, and `displayStationName`, preserving the
station identity even when the current payload has been replaced with a
matched iTunes title, artist, album, and artwork. Native clients should
present the station identity below the album metadata and must not substitute
song artwork for the station logo.

When the stream does not publish a station name, the canonical and mobile
routes resolve the current stream URL through the configured radio-logo alias
map before falling back to the stream host. This keeps stations such as Jazz24
visible even when iTunes supplies the current song and album metadata.

When editorial data is available, `about` contains the normalized server-owned
editorial object and `aboutStatus` is `available`; `aboutProvider` identifies
the provider without exposing provider credentials. An explicit non-available
status tells native clients not to show stale text. Older servers may omit the
status/provider siblings, in which case a non-empty `about.text` remains usable.

## Home transport controls

The P0 Server capability for native Home transport is a single typed,
bearer-authenticated route:

```http
POST /v1/mobile/now-playing/control
Authorization: Bearer <mobile-session-token>
Content-Type: application/json
```

The request body is one of these forms:

```json
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

`seekRelative.seconds` must be a non-zero integer from `-600` through `600`.
`seekPercent.percent` must be a finite number from `0` through `100`; the
Server rounds it to the whole percentage accepted by the existing playback
authority. Unknown fields, raw MPD paths, renderer URLs, and Track-Key-only
requests are rejected. `previous` is translated to the existing server-side
`prev` action, and `repeat` toggles the existing Home repeat mode. `consume`
without a `state` preserves the existing blind Consume toggle; when supplied,
`state` must be exactly `on` or `off` and selects the Consume state
deterministically. The `repeatMode` action selects its mode deterministically:
`off` means MPD `repeat off`/`single off`, `all` means `repeat on`/`single off`,
and `one` means `repeat on`/`single on`. The legacy `repeat` toggle remains
unchanged; `repeat-mode` is accepted as a compatibility spelling of
`repeatMode`.

Success responses contain only the normalized action and safe state:

```json
{"ok":true,"action":"seekRelative","seconds":-30}
{"ok":true,"action":"repeat","repeatOn":true}
{"ok":true,"action":"consume","state":"on","consumeOn":true}
{"ok":true,"action":"repeatMode","mode":"one","repeatMode":"one","repeatOn":true,"singleOn":true}
```

`consume` responses always include authoritative MPD readback as both
normalized `state` and boolean `consumeOn`, including for the blind-toggle form.
Invalid states return `400` `MOBILE_CONSUME_STATE_INVALID_REQUEST`; unavailable
or mismatched authoritative readback returns `502`
`MOBILE_CONSUME_READBACK_MISMATCH`. `repeatMode` responses include the
authoritative MPD readback as `mode` and `repeatMode`, plus `repeatOn` and
`singleOn`. Invalid modes return `400` `MOBILE_REPEAT_MODE_INVALID_REQUEST`; a
failed authoritative readback returns `502`
`MOBILE_REPEAT_MODE_READBACK_MISMATCH`.

The route delegates to the existing guarded playback authority, so it does
not release or take over Qobuz Connect or Sonuvi UPnP. If Qobuz owns playback,
the response for any Home mutation, including Consume, is `409` with
`code: "HOME_PLAYBACK_OWNERSHIP_CONFLICT"` and
`source: "qobuz-connect"`; the client must call the explicit
`POST /v1/mobile/qobuz-connect/release` contract first and retry after
confirmed release. Sonuvi UPnP ownership returns the same `409` code with
`source: "upnp-sonuvi"`; the client must use the UPnP mobile contract instead.
Existing web/controller Track-Key routes remain unchanged.

## Current-track controls

The native client may read and change favorite/rating state through the same
bearer-authenticated current-track contract. The mobile read is derived from
the canonical `/now-playing` snapshot, including its `isFavorite`, `rating`,
and `ratingDisabled` fields. Mutations resolve the file from that same
canonical snapshot (falling back to the current mobile queue item only when
the snapshot has no file), then pass it server-side to the existing file-aware
favorite/rating routes. The client never submits an MPD file path or
rating-file path.

```http
POST /v1/mobile/now-playing/favorite
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"favorite":true}
```

```http
POST /v1/mobile/now-playing/rating
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"rating":4}
```

The mutation routes reuse the existing server-side `/favorites/toggle` and
`/rating` behavior internally. Their responses contain only sanitized state:

```json
{"ok":true,"isFavorite":true,"disabled":false}
{"ok":true,"rating":4,"ratingDisabled":false,"disabled":false}
```

For radio/stream items, AirPlay, an unavailable current item, or a local item
that is not in the mobile catalog, the read returns `isFavorite: false`,
`rating: 0`, and `ratingDisabled: true`; the mutation routes return successful
no-op responses with `disabled: true`. A Track Key without a mobile bearer
session receives HTTP 401. The mobile response never passes through the
canonical `file` or `ratingFile` fields.

## Native device track favorites

When the iPhone or iPad is the playback target, the native client can read and
change favorite state for a canonical catalog track without controlling the
Home moOde queue:

```http
GET /v1/mobile/catalog/tracks/:trackId/favorite
Authorization: Bearer <mobile-session-token>

POST /v1/mobile/catalog/tracks/:trackId/favorite
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"favorite":true}
```

The server resolves the opaque canonical `trackId` to its catalog record and
keeps the source file private. It reuses the existing Favorites playlist
mutation internally and returns only `{ "ok": true, "isFavorite": true,
"disabled": false }`-style state. Stream, radio, podcast, and unavailable
items return a successful disabled response. The native client uses this
contract for the Like heart beside the device rating stars and applies the
same optimistic-update/rollback behavior.

## Direct device radio metadata

When the native client plays a station on the iPhone/iPad, it listens for the
stream's ICY/ID3 song metadata and submits the current song through:

```http
POST /v1/mobile/radio/metadata
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"stationId":"rad_opaque","artist":"Miles Davis","title":"Blue in Green"}
```

The server validates the station, runs the station-specific normalization
already used by Now Playing (including iHeart `StreamTitle` blobs), then
applies the same conservative radio guard and iTunes matcher used by
`/now-playing`. It returns protected matched artwork plus `title`, `artist`,
`album`, `year`, and a validated `appleMusicUrl`. When the canonical Now
Playing snapshot is the same radio song, it also returns its normalized
`about`, `aboutStatus`, and `aboutProvider` fields so direct native radio
playback receives the same editorial content as Home moOde/web playback. A
miss returns the normalized metadata with `matched: false`, so the native
player can still show the station's song title without presenting misleading
music artwork, links, or About text.

The canonical About fallback is attempted whenever the direct enrichment
response does not already contain About, including partial or timing-sensitive
Apple lookups. The server still requires the submitted song to match the
current canonical radio snapshot by verified Apple URL or normalized
artist/title/album before copying that editorial text.

For native track-change notifications, the corresponding radio playback event
is accepted by the shared history route but its APNs send is intentionally
deferred. Once this metadata response completes, the server sends one APNs
notification for the enriched song. The native UI continues to use protected
album artwork, while APNs receives the safe external artwork source because
the notification extension has no bearer session; unmatched streams use a
public station-art fallback. The validated Apple Music URL is included in the
APNs payload. This prevents a premature station-only alert and avoids a
duplicate notification for the same radio title.

### Silent Home moOde stream rows

Home moOde can briefly expose a radio queue row with only its stream URL while
the station logo is already available. The mobile queue adapter reuses the web
`/config/diagnostics/queue` resolver server-side in that case, filling the
station name, stream title, and protected station artwork without exposing the
MPD file or song ID. If canonical `/now-playing` reports the generic fallback
`Radio` / `Live Radio`, the bearer mobile snapshot prefers that resolved
current queue row. This keeps the Home moOde card and Live Queue row aligned
with the web queue during talk-radio streams such as 670 The Score.

When canonical `/now-playing` has a verified Apple Music/iTunes match for a
music-bearing radio stream, its matched `displayArtUrl` takes precedence over
the queue row's station-logo artwork. Unmatched radio content continues to use
the station logo, preserving conservative artwork behavior for talk, news, and
sports stations.

## Animated artwork lookup

The native client can ask the mobile API whether the existing Now Playing
animated-art cache has an H.264 loop for the current item:

```http
GET /v1/mobile/animated-art?artist=Artist&album=Album
Authorization: Bearer <mobile-session-token>
```

For a matched radio stream, the client sends the validated Apple Music URL
instead:

```http
GET /v1/mobile/animated-art?appleMusicUrl=https%3A%2F%2Fmusic.apple.com%2F...
Authorization: Bearer <mobile-session-token>
```

The server invokes the existing cache lookup internally and returns only:

```json
{"ok":true,"hasMotion":true,"mediaUrl":"https://host/config/library-health/animated-art/media/<opaque>.mp4"}
```

The iOS client never calls the Track-Key/admin lookup routes, sends no file
path or Track Key, and falls back to static artwork when `hasMotion` is false.
The returned media is either the server's opaque H.264 cache file or the
already-validated Apple-hosted MP4 URL from the existing matcher.

## Artwork and security

- Catalog-backed artwork uses `/v1/mobile/artwork/:trackId`.
- Rich moOde, AirPlay, station, and stream artwork is stored server-side
  behind an opaque `/v1/mobile/home/artwork/:artworkId` handle.
- The artwork handle route requires the same bearer session and proxies the
  image server-side.
- Radio station-list handles retain the stream source only on the server but
  use the catalog's canonical logo name through `/art/radio-logo.jpg?name=...`.
  This avoids a second SSH-backed stream-URL reverse lookup that can return
  404 for otherwise valid moOde logos, while preserving provider prefixes such
  as iHeart in the logo name even when the display station name is shortened.
  Queue/current-stream handles may still use the file-aware
  `/art/radio-logo.jpg?file=...` resolver for stream aliases.
- The response never includes a raw MPD file, MPD song ID, Track Key, local
  filesystem path, or Last.fm/provider credential.

## Native behavior

When Home moOde is selected, the iPhone/iPad polls this route and uses it for
the now-playing card and full Now Playing pane. Poll errors retain the last
successful card so a brief network failure does not look like playback
stopped. A verified radio match adds an external-link icon that opens the
Apple Music universal link; no icon is shown for misses or non-music radio.

The favorite heart and rating controls use the `isFavorite`, `rating`, and
`ratingDisabled` fields from this same polling response and the two mutation
routes above. They must remain hidden or disabled when `ratingDisabled` is
true, and must not attempt to target the home MPD queue directly.

Native artwork keeps the last successful image visible while a track-specific
artwork URL is fetched. Same-album transitions are album-scoped for animated
artwork lookup and do not reset the existing cover/action face merely because
the next track has a different canonical artwork URL.

## Current native contract navigation

The [October Server/iOS handoff](../ios/server-to-ios-contract-handoff-2026-10.md)
covers bearer Home controls, deterministic repeat/Consume, native Vibe preview
versus Home jobs, queue paging, local-byte mapping and history observations.
`GET /v1/mobile/history/recent` is a last-played seed, not current playback
truth or a command to replace a nonempty device queue.

## Native Home summary shelf

The iPad Home summary shelf uses the following bearer-authenticated contracts:

```http
GET /v1/mobile/next-up
Authorization: Bearer <mobile-session-token>

GET /v1/mobile/audio-info
Authorization: Bearer <mobile-session-token>
```

`/v1/mobile/next-up` returns the web controller's target-aware successor. The
iPad presents it as **Next Playing** and opens the shared Live Queue when
tapped. The shelf also shows the current queue position/length from the
now-playing payload or the durable device queue.

When Live Queue is selected as a Home discovery row, the native remote poll
also reads the complete upcoming queue and reconciles that row. This covers
queue additions made by another controller; local playback uses the device
queue directly.

The Audio Info entry now opens a **dedicated native screen/page**, replacing
the earlier native drawer (product presentation confirmed 2026-10-28).
This is not the Server web tablet's still-existing modal, nor a new Server HTML
route. See [client entry points and provenance roles](diagnostics-interface.md#audio-info-entry-points-and-presentation).
The dedicated screen uses the same sanitized bearer diagnostics contract;
its navigation does not turn configured output into a hardware measurement.

`/v1/mobile/audio-info` invokes the existing Track-Key-protected moOde reader
server-side and returns sanitized `section`, `key`, and `value` rows plus an
optional fetch timestamp. Source/file-path rows are reduced to a source class
such as `Local file` or `Network stream`; the response never exposes the moOde
source URL, Track Key, MPD file path, raw admin response, or moOde PHP session
identifier to the native client.

When this route is opened, the Server requests the optional on-demand
diagnostics view from the Track-Key route. The response may include the
backward-compatible, versioned `diagnostics` object:

```json
{
  "version": "audio-info.v1",
  "capturedAt": "2026-10-15T18:00:00.000Z",
  "freshness": {
    "mode": "on-demand",
    "capturedAt": "2026-10-15T18:00:00.000Z",
    "hardwareMeasuredAt": "2026-10-15T18:00:00.000Z"
  },
  "renderer": "mpd",
  "sourceFormat": { "format": "FLAC 24 bit 96 kHz, Stereo", "bitDepth": 24, "sampleRateHz": 96000, "channels": 2 },
  "decodedPcm": { "format": "PCM 24 bit 96 kHz, Stereo", "bitDepth": 24, "sampleRateHz": 96000, "channels": 2 },
  "sourceFile": { "container": "FLAC", "codec": "FLAC", "codecStatus": "verified", "codecKind": "lossless", "bitDepth": 24, "bitDepthStatus": "verified", "sampleRateHz": 96000, "channels": 2, "encodedBitrateBps": 4200000, "encodedBitrateStatus": "reported", "valueType": "source-file" },
  "decodedAudio": { "format": "PCM", "codec": "PCM", "bitDepth": 24, "sampleRateHz": 96000, "channels": 2, "pcmBitrateBps": 4608000, "pcmBitrateStatus": "calculated", "valueType": "decoded-reported" },
  "configuredOutput": { "alsaMode": "plughw", "audioChain": "MPD → plughw → Device", "valueType": "configured", "measured": false },
  "hardwareOutput": { "format": "S32_LE", "bitDepth": 32, "sampleRateHz": 96000, "channels": 2, "valueType": "hardware-measured", "measured": true },
  "output": { "format": "S32_LE", "bitDepth": 32, "sampleRateHz": 96000, "channels": 2, "valueType": "hardware-measured", "measured": true },
  "processing": { "resampling": "Off", "replayGain": "off", "normalization": "off", "valueType": "configured", "measured": false },
  "volume": { "type": "Fixed (0dB output)", "valueType": "configured", "measured": false },
  "conversion": { "status": "unknown", "valueType": "not-measured", "measured": false }
}
```

`sourceFormat` and `decodedPcm` are moOde/renderer-reported values. The
additive `sourceFile` object is the authoritative normalized source view:
lossless PCM-based files may expose verified encoded bit depth, while AAC,
MP3, Opus, Vorbis, and other perceptual codecs expose encoded bitrate but
report source bit depth as `not-applicable`. `sourceFile.codecStatus` is
`verified` when the bounded local-file probe identified the codec, `reported`
when provider metadata supplied it, and `unavailable` otherwise.
`decodedAudio` describes decoder
PCM precision and a calculated nominal PCM throughput; it does not reuse the
encoded bitrate shown by moOde. `output` is the measured ALSA endpoint view.
The
`configuredOutput`, `processing`, and `volume` sections describe configured
state and are never presented as hardware measurements. `hardwareOutput` is
the bounded, read-only ALSA `/proc/asound` observation; it is absent or marked
unavailable when no playback stream exposes parameters. `conversion` remains
unknown because ALSA `hw_params` cannot prove every transformation before the
hardware endpoint.

When diagnostics are requested, the legacy mobile `Decoded to` row is also
corrected for verified lossy sources so an encoded bitrate is not displayed
as decoded PCM throughput. The ordinary non-diagnostics legacy response is
unchanged for compatibility.

## Local audio source/cache

For This iPhone/iPad, the device owns its playback queue/state. The current
shared Server catalog/`MobileTrack` contracts resolve identities and authorize
Server media access; the Home MPD queue is not the device's playback authority.
Local SSD/cache availability supplies bytes beneath that identity model, not
an automatic second catalog. A device-owned canonical catalog with provider
aggregation remains planned architecture; see [catalog and byte ownership](media-library.md#catalog-identity-and-byte-ownership).

The client obtains an authenticated availability manifest:

```http
GET /v1/mobile/local-source/manifest
Authorization: Bearer <mobile-session-token>
```

The response maps canonical track IDs to library-relative paths and integrity
evidence. The client validates the attached file and otherwise uses the normal
media authorization endpoint. SSD disconnect, absent files, stale size entries,
and reconnect are cache misses/recovery, not library or playback mode changes.

Native device playback reports progress through the same bearer session:

```http
POST /v1/mobile/playback/events
Authorization: Bearer <mobile-session-token>
Content-Type: application/json

{"trackId":"trk_...","sessionId":"device-session","state":"progress","elapsedSec":78,"durationSec":214,"startedAtMs":1793180000000}
```

The server resolves the track ID and feeds the shared listening-history
qualification/idempotency path. The client never submits a filesystem path,
synthetic SSD ID, or alternate queue identity.

The example timestamp is Unix milliseconds. `startedAt` is not accepted as an
alias; omission of `startedAtMs` uses request time. Explicit `state` is
recommended although omission defaults to `progress`. Use the full
[playback-event schema and qualification rules](centralized-playback-history-and-scrobbling.md)
for catalog, radio and podcast identity resolution and stable session IDs.

Native podcast playback is the feature-specific exception to the catalog ID
shape: the client uses an opaque `podcast-...` episode identity for its local
device queue, and the bearer route resolves that identity to the downloaded
episode's server-owned MPD path and metadata before recording history or
invoking the native APNs bridge. This keeps podcast paths out of the client
while allowing podcast starts to receive the same track-change notification
behavior as music.

*Last reviewed: 2026-10-31 America/Chicago*
