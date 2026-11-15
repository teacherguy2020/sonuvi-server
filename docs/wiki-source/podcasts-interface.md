---
title: podcasts interface
page_type: child
topics:
  - integration
  - library
  - playback
confidence: high
---

# Podcasts Interface

The Podcasts feature manages RSS subscriptions and local episode files. It
combines a user-facing subscription/episode workflow with configuration and
storage administration.

## User workflow

1. Add a podcast by RSS URL.
2. Refresh feeds.
3. Set per-show auto-download behavior and batch limits.
4. Open a subscription to play, queue, download, or delete episodes.
5. Use retention settings to keep local storage bounded.

## Administration boundary

Podcast roots, nightly cleanup, path mapping, and automation belong with
[config-podcasts-and-library-paths.md](config-podcasts-and-library-paths.md).
Episode parsing, local indexes, playlists, artwork, and now-playing
enrichment are implementation concerns documented there and in the API/source
maps.

The native iPhone/iPad controller mirrors the same subscription and episode
workflow through bearer-authenticated mobile routes. See
[Native Mobile Feature Surfaces](mobile-feature-surfaces.md) for the safe DTO
and playback-target split. The Home **Recent Podcasts** shelf uses an opaque
subscription ID and a flip face with **Play Newest** (front of queue), **Load**
(replace with downloaded episodes oldest-to-newest), and **Open**. These
actions are backed by the mobile podcast routes and never expose the podcast
media path to the app. For playback, the server keeps the episode's canonical
`mpdPath` as the source of truth for moOde and resolves that same path through
the configured podcast mount for native-device media downloads; it does not
assume podcasts live in the general music directory. Both native-device and
Home moOde podcast transport surfaces expose the same relative seek actions as
the web controller: **Back 15 seconds** and **Forward 30 seconds**. Native
playback seeks the AVPlayer item directly; Home moOde sends the existing
Track-Key-protected `seekrel` action.

## Related pages

- [using-now-playing.md](using-now-playing.md)
- [config-podcasts-and-library-paths.md](config-podcasts-and-library-paths.md)
- [media-library.md](media-library.md)
- [configuration-and-administration.md](configuration-and-administration.md)

*Last reviewed: 2026-10-02 06:12 America/Chicago*

## Authenticated LAN browser and migrated test servers — 2026-11-11

Immutable Server subscriptions are read from the shared runtime podcast-map
directory (`/var/lib/sonuvi/cache/podcasts/maps/subscriptions.json` by default),
not from the music-library catalog or the legacy `paths.subscriptionsJson`
setting. A fresh Server has no subscriptions. To populate a disposable replica,
copy the subscription/map metadata separately, remap `mapJson`/`outM3u` into its
local shared state, and point `paths.podcastRoot` and each subscription `dir`
at the actual podcast media mount. Keep test media read-only and automated
downloads disabled; do not run a second production download/cleanup job.

The authenticated browser permits only the bounded, CSRF-protected
`POST /podcasts/episodes/list` read (existing subscription RSS plus limit).
Download, delete, refresh, and subscription mutations are not enabled by this
read allowance. Playlist covers use existing bearer playlist IDs/artwork through
the cookie-authenticated HTTPS gateway, rather than direct moOde HTTP images.

*Last reviewed: 2026-11-11 America/Chicago*
