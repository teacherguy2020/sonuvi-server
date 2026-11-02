---
title: Mobile Home Discovery Rows
page_type: reference
topics:
  - api
  - ios
  - controller
  - security
confidence: high
---

# Mobile Home Discovery Rows

The native iPhone and iPad clients use the same server-owned discovery-row
sources as `controller-tablet`. The mobile API exposes a sanitized,
provider-aware representation rather than making Swift call Track-Key or
admin endpoints directly.

## Route

```http
GET /v1/mobile/home/rows
Authorization: Bearer <mobile-session-token>
```

The session must have the existing `mobile-api` bearer scope. A Track Key
header, an absent token, or an invalid token is not sufficient.

The server reads the authenticated user’s sanitized controller profile and
uses its `recentRows` selection as the first four shelves. It then returns
every other supported source below those selected shelves. When no valid
selection is available, the server uses the controller defaults:

```json
["albums", "playlists", "podcasts", "radio"]
```

Native Settings saves the ordered selection through the bearer-authenticated
profile route:

```http
POST /v1/mobile/home/profile
Authorization: Bearer <mobile-session-token>
Content-Type: application/json
```

The request body contains only the selected row IDs:

```json
{
  "recentRows": ["lastfm-toptracks", "lastfm-topartists", "albums", "radio"]
}
```

Native Settings sends this request automatically when a shelf picker changes;
the **Save now** control is retained only as a retry path after a failed
request. Restore defaults sends the same route with the four controller
defaults.

The server merges the selection into the existing controller profile, applies
the same allowed-source, uniqueness, four-row limit, and default-fill rules
used by the web settings, and returns the sanitized profile. Other profile
settings are preserved. The native client does not call the Track-Key-protected
web configuration route directly.

The response is:

```json
{
  "ok": true,
  "rows": [
    {
      "id": "albums",
      "title": "Recently Added Albums",
      "provider": "now-playing",
      "source": "albums",
      "available": true,
      "items": [
        {
          "id": "itm_opaque_id",
          "kind": "album",
          "title": "Example Album",
          "subtitle": "Example Artist · 10 tracks",
          "artist": "Example Artist",
          "album": "Example Album",
          "provider": "now-playing",
          "source": "albums",
          "artworkUrl": "https://host/v1/mobile/home/artwork/har_opaque_id",
          "albumItem": {
            "id": "alb_opaque_id",
            "title": "Example Album",
            "artist": "Example Artist",
            "trackCount": 10,
            "artworkUrl": "https://host/v1/mobile/artwork/alb_opaque_id"
          }
        }
      ]
    }
  ]
}
```

Every item is normalized for native rendering and preserves enough identity
for existing album, artist, playlist, track, play, and queue actions. Opaque
track/album/artist/playlist IDs are server-issued. Raw MPD file values,
filesystem paths, MPD song IDs, Track Keys, and provider credentials are not
returned.

The response order is stable: the profile's four selected `recentRows` come
first, followed by every remaining supported source in the published source
vocabulary. An unavailable producer is still represented honestly by an
unavailable or empty row, rather than being silently omitted.

The response also includes `localRecentHistory`: a bounded, sanitized,
row-shaped local-history payload outside `rows`. The server fetches it even
when `local-recenttracks` is not selected in `recentRows`, so native features
such as **Recent Genres** can use recent tracks without requiring a visible
Local Recently Played shelf. It may be unavailable or empty when no usable
local listening history exists.

## Supported sources

The source vocabulary follows the tablet controller:

| Source | Label | Provider | Existing producer |
| --- | --- | --- | --- |
| `albums` | Recently Added Albums | Now Playing | `/recent/albums` |
| `playlists` | Recent Playlists | Now Playing | `/recent/playlists` |
| `podcasts` | Recent Podcasts | Now Playing | `/recent/podcasts` |
| `radio` | Favorite Radio Stations | Now Playing | radio favorites |
| `queue` | Live Queue | Now Playing | authenticated MPD queue snapshot |
| `lastfm-topalbums` | Top Albums | Last.fm | `/config/lastfm/top-albums` |
| `lastfm-topartists` | Top Artists | Last.fm | `/config/lastfm/top-artists` |
| `lastfm-toptracks` | Top Tracks | Last.fm | `/config/lastfm/top-tracks` |
| `lastfm-recenttracks` | Recently Played | Last.fm | `/config/lastfm/recent-tracks` |
| `local-topalbums` | Local Top Albums | local-history | `/config/listening-history/top-albums` |
| `local-topartists` | Local Top Artists | local-history | `/config/listening-history/top-artists` |
| `local-toptracks` | Local Top Tracks | local-history | `/config/listening-history/top-tracks` |
| `local-recenttracks` | Local Recently Played | local-history | `/config/listening-history/recent-tracks` |

The server invokes these existing producers internally. Local-history rows
remain local-history rows even when Last.fm is configured; Swift must use the
returned `provider` and `source` values rather than guessing from the title.
An unavailable or empty source is a valid row state and is returned with
`available: false` or an empty `items` array, not as a fabricated result.

The `queue` row is the upcoming portion of the current Live Queue. The server
filters the current item when it has a reliable queue head, while the full
queue remains available from the dedicated Live Queue destination. Queue
artwork and catalog identities use the same bearer-safe DTO boundary as other
track rows. Radio rows are station cards: the station logo and resolved
station name are shown, while stale stream-song `artist`/`album` metadata is
discarded. The current matched radio song remains in the Now Playing card.

The native client keeps this shelf tied to the same authority after the first
response: remote queue polling replaces only the queue row when tracks are
added or removed elsewhere, while a local device target derives the row from
the persisted native queue. Other discovery shelves are not reloaded for this
reconciliation.

Podcast playlists remain distinct from ordinary music playlists through the
shared server playlist classification. The mobile home row does not flatten
podcast content into the music-playlist row.

## Artwork boundary

Local library items use the existing Now Playing artwork cache through the
bearer-protected `/v1/mobile/artwork/...` URLs. Podcast and Last.fm artwork is
proxied through the server’s `/v1/mobile/home/artwork/...` route. Radio rows
use the same Now Playing station-logo resolver as the web controller and are
also exposed through that bearer-protected proxy.

Playlist rows are different from ordinary catalog rows: their `artworkUrl`
comes from the bearer-protected `/v1/mobile/playlists/:playlistId/artwork`
route, which serves the existing custom moOde playlist collage. The first
track’s album art is not used as a playlist substitute.

The native app never receives an external provider URL that it would fetch
without the mobile session. Artwork is therefore sourced from Now Playing’s
cache/resolvers, not moOde’s `coverart.php` or a raw filesystem path.

## Native behavior

The iPhone and iPad share the same `MobileHomeRow` models and API client.
Album, artist, and playlist items navigate into the existing native detail
surfaces. Catalog-backed track items also include their safe `albumItem`, so
tapping the track artwork opens that album and highlights the selected track;
the separate Play and Add controls remain available. The tablet can mirror
the configured row order; the phone renders the same rows as stacked
horizontal rails.

Podcast and radio rows render their server-owned artwork and metadata. Their
destination browsing/actions now use the separate bearer-authenticated
Podcasts and Radio contracts documented in
[Native Mobile Feature Surfaces](mobile-feature-surfaces.md); the native
client still does not fall back to the web Track-Key routes.

Home shelf action faces use the row source ID rather than the display title:

- `lastfm-toptracks`, `local-toptracks`, `lastfm-recenttracks`, and
  `local-recenttracks` expose **Play**, **Add**, and **Add to Playlist**.
- `albums`, `lastfm-topalbums`, and `local-topalbums` expose **Play**, **Add**,
  and **Add to Playlist**.
- `lastfm-topartists` and `local-topartists` expose **Shuffle**, **Play**, and
  **Add to Playlist**.
- `playlists` exposes **Play**, **Shuffle**, and **View**.
- `radio` exposes **Play** (front of Live Queue), **Add** (append), and
  **Unfavorite**. Radio items include an opaque `radioStationId` so these
  actions resolve the station server-side.
- `podcasts` exposes **Play Newest** (front of Live Queue), **Load** (replace
  the queue with downloaded episodes oldest-to-newest), and **Open**. Podcast
  items include an opaque `podcastId` for the subscription contract.
- `queue` exposes the upcoming queue as catalog-backed track items. Each queue
  item includes a separate opaque `queueItemId` for the exact current queue
  snapshot; the native artwork ellipsis flips to **Play now**, **Play next**,
  and **Remove**. The dedicated Live Queue destination remains the place for
  full queue browsing, drag/reorder, crop, clear, and shuffle operations.

The artwork remains the original destination/play action; only the upper-left
ellipsis control flips to the action face. Live Queue shelf cards do not render
the ordinary inline track action icon row. The radio and podcast queue
operations are backed by `POST /v1/mobile/radio/play-front`,
`POST /v1/mobile/podcasts/:podcastId/play-newest`, and
`POST /v1/mobile/podcasts/:podcastId/load`. The existing append/favorite and
podcast page contracts are reused for the other buttons.

## Security and verification

The route is registered beside the existing mobile playlist and queue routes
and uses the same bearer verification. Server tests cover missing, malformed,
and Track-Key-only authorization, normalized row mapping, provider labels,
opaque IDs, artwork proxy URLs, and the absence of MPD paths in serialized
JSON. The iOS project’s Swift tests and signed device build must remain green
when this endpoint changes.

*Last reviewed: 2026-10-31 08:25 America/Chicago*
