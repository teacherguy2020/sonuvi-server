# Music-only album presentation

Canonical documentation: [Media Library](../wiki-source/media-library.md).

`isMusicLibraryTrack` excludes explicit podcast/video flags, dedicated
Podcasts/Video(s) path segments and video file extensions. Titles are not used.
Recent-album caches and fallback grouping filter before limits; browser album
projections read music from the existing index without rewriting it. Native
catalogs keep every track ID/file lookup but create albums/artists from music
only. Home album shelves also reject known stale nonmusic rows.

Keep Podcasts/Videos navigation, media catalogs, files, playlist entries,
queues and opaque IDs intact. Do not fix this by deleting media or resetting
the source index. Mixed collections retain their audio tracks and counts.

Validation and rollout: workspace sonuvi-team/music-only-albums-20261116.

Updated: 2026-11-16
