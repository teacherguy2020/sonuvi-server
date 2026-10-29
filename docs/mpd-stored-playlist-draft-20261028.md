# MPD stored-playlist correction — accepted behavior

The prepared draft `28852f8` was finalized in accepted production source
`84b0ddff5b1042af1849f08dee181fbd7ccc9fa2`. The web-controller save-only operation
has user acceptance; remote cover installation does not. This supersedes the
historical draft's replacement and acceptance-pending descriptions.

## Queue Wizard save-only

`POST /config/queue-wizard/apply` with `saveOnly:true` uses the existing MPD TCP
adapter. It validates the name/URIs and available commands, builds a unique
`sonuvi-tmp-<uuid>` through `playlistadd`, verifies ordered URI readback (including
duplicates), then promotes with a non-overwriting `rename` to a new destination.
Existing names return HTTP409 `PLAYLIST_EXISTS` before writes. Public controller
and mobile adapters expose no overwrite option. The internal helper's explicit
replacement/recovery strategy remains separately tested, not publicly enabled.

Save-only never clears, replaces, adds to, starts, pauses, or shuffles the live
queue. It invokes no SSH/SCP. Failed construction cleans only its own temporary
playlist when possible; ambiguous promotion or failed cleanup yields explicit
errors/recovery names rather than a blind retry. MPD is not transactional, and
process/network loss can leave recovery playlists; no automatic sweeping exists.

## UI, authentication and covers

The web controller exposes **Queue Wizard → Preview → Save to playlist**.
It requires confirmed `playlistSaved` before claiming success and reports an
unconfirmed network response explicitly. A collage preview failure cannot block
saving. Collage generation is retained, but remote moOde cover installation is
unavailable and separately reported. Existing covers are not overwritten/deleted.
No new artwork storage system is included.

Protected controller routes retain Track Key checks. The native mobile backend
uses bearer authentication and forwards compatible success/errors/warnings.
Backend support does not establish native iOS button availability or acceptance;
iOS Queue Wizard UI/behavior is a separate follow-up. No native project changed.

## Individual-track Add to playlist and existing menus

Home/app, controller, tablet/mobile web, queue and album buttons share
`POST /config/queue-wizard/add-to-playlist`. Native
`POST /v1/mobile/queue-wizard/add-to-playlist` resolves opaque track IDs and
forwards to it. This pre-existing route uses `mpc addplaylist` (MPD playlistadd),
not SSH. Its existing ASCII-safe name restriction and possible partial multi-track
append on later failure remain unchanged. Browsing/preview/rename/removal formats
are unchanged; the existing playlist menu cache can take up to45 seconds.

Tests cover helper failure/cleanup/concurrency cases, real loopback MPD framing,
controller/native route compatibility, the existing append path and independent
collage failures. Production mutations are not part of automated reconciliation.
See [source baseline](runbooks/sonuvi-source-baseline.md).
