# Christmas Vinyl HD metadata

WALM Christmas Vinyl emits title-first ICY text, for example:
`Christmas Auld Lang Syne by Bobby Darin - Christmas Vinyl on walmradio.com`.
The shared radio normalizer strips the anchored station suffix and splits at the
last standalone, case-insensitive BY. Preserve the raw text. Match only Christmas
Vinyl station names or WALM hosts with Christmas stream paths, never other radio
stations. Keep the generic music profile; this is not classical metadata.

Both canonical Now Playing and native radio enrichment use this normalizer.
Existing artwork matching and caches remain unchanged; no exact album constraint
is added. Live iTunes trial returned two exact artist/title matches, and artwork
from The 25th Day of December with Bobby Darin downloaded successfully.

Updated: 2026-11-14
