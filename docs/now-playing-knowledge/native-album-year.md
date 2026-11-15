# Native album release years

Native catalog track and album projections preserve indexed year/date metadata for presentation. Raw album titles and opaque track/album IDs remain unchanged. Album projection uses the first available year among its tracks; missing metadata remains null. iOS formats the suffix, not the server.

MPD browse ingestion includes `%date%`; existing persisted indexes need the supported browse-index rebuild to populate it. No MPD database update or audio-file write is required.

Updated: 2026-11-14
