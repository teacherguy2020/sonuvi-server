# controller tablet anatomy

## Purpose

This page documents the internal anatomy of `now-playing/controller-tablet.html`.

It exists because `controller-tablet.html` is one of the densest and most important pages in the project.
It is not just “the tablet interface.”
It is a composite shell with:
- a now-playing header
- integrated transport controls
- quick search
- library/category entrypoints
- recent-content rails
- tablet-specific next-up and action bars
- kiosk-pane embedding behavior
- multiple modal/workflow surfaces
- strong profile/layout/device-preset logic

This page is meant to help future agents answer a question like:
- “if I need to change a specific region inside `controller-tablet.html`, where do I start?”

## Why anatomy matters here

The tablet page is exactly the kind of page where branch-level documentation is not enough.

Real tasks are likely to sound like:
- adjust the now-playing header
- change the tablet next-up bar
- improve the quick search area
- tweak the library rows
- change the recent rails
- fix the kiosk pane behavior
- change the audio info modal
- alter the live queue row actions

Those are anatomy questions, not just branch questions.

## High-level role of `controller-tablet.html`

A good current interpretation is:
- `controller-tablet.html` is a tablet-oriented controller shell
- it is also a kiosk-adjacent shell for some profiles/layouts
- it combines multiple major surface regions in one page rather than acting as only a thin frame
- it contains substantial device-preset/layout logic that materially changes behavior and structure

So this page should be understood as a multi-region orchestration shell, not just a resized controller.

## Main anatomical regions

The current page anatomy is best understood as these major regions:

1. kiosk/editor control strip
2. now-playing header card
3. integrated transport controls
4. quick search strip
5. library/category list
6. recent-content region
7. tablet next-up / action bars
8. kiosk pane iframe region
9. album / artist / audio-info modal family
10. device-preset and layout-profile logic

## 1. Kiosk/editor control strip

### What it is
This is the top control strip anchored by:
- `#kioskCtl`
- `#kioskSizeSel`
- `#kioskPushBtn`
- `#kioskPushStat`

### What it does
This region appears only in certain kiosk/editor contexts and acts as the tablet page’s local control strip for sizing/pushing kiosk-like output.

### Why it matters
It is one of the clearest places where `controller-tablet.html` overlaps with kiosk/designer/runtime-admin behavior rather than being only a tablet control shell.

### Companion pages
- `tablet-kiosk-shell-differences.md`
- `kiosk-interface.md`
- `display-launch-and-wrapper-surfaces.md`
- `display-issue-triage-runbook.md`

## 2. Now-playing header card

### What it is
The now-playing header card is the major top-left now-playing region anchored by:
- `#npCard`
- `.npTap`
- `.np`
- `#npArtWrap`
- `#art`
- `#npPersonnelBody`
- `#line1`
- `#line2`
- `#line3`
- `#line2Stars`

### What it does
This region is the tablet shell’s summary of current playback state, including:
- album art
- personnel flip card
- title/artist/album lines
- inline rating display
- podcast seek controls
- tablet-inline next-up in some layouts

### Why it matters
This is one of the most visually important parts of the page and one of the clearest places where now-playing truth, display behavior, and tablet layout logic all meet.

### Key ownership anchors
- DOM region: `#npCard`, `.np`, `#npArtWrap`
- companion pages:
  - `now-playing-surface-variants.md`
  - `playback-authority-by-mode.md`
  - `fragile-behavior-ownership.md`

## 3. Integrated transport controls

### What it is
Inside the now-playing header card, the tablet page includes a dedicated transport-control cluster anchored by:
- `#npCtrls`
- buttons with `data-np-act`

Visible actions include:
- repeat
- previous
- toggle / play-pause
- next
- pause
- play
- shuffle

### What it does
This region provides shell-local transport and playback controls rather than delegating transport entirely to another child page.

### Why it matters
This is one of the clearest reasons `controller-tablet.html` is a real controller shell rather than just a navigation page.

### Companion pages
- `queue-and-playback-model.md`
- `api-playback-and-queue-endpoints.md`
- `playback-issue-triage-runbook.md`

## 4. Quick search strip

### What it is
The quick search region is anchored by:
- `#homeQuickSearch`
- `#homeQuickKb`
- `#homeQuickClear`
- `#homeQuickResults`
- `.quickWrap`

### What it does
This is the tablet shell’s quick entrypoint for search and jump-to behavior.

### Why it matters
Quick search is one of the highest-value action areas on a tablet shell. It is also likely to interact with browse-index/local derived-state behavior rather than only raw live queries.

The tablet quick search (`#homeQuickSearch`) searches artists, albums, track titles, and playlists. Track results include artist/album context and carry their exact library file as the action value, so duplicate title tags remain distinct. The persistent app-shell hero search (`#heroQuickSearch`) also searches genres and exposes three actions for each result: play (replace and start), add (append to the live queue), and add to playlist (open a modal to append to an existing playlist or create a new one). Its playlist action calls `POST /config/queue-wizard/add-to-playlist`, which uses MPD's `addplaylist` command to append directly to the saved playlist.

### Companion pages
- `queue-and-playback-model.md`
- `source-map.md`
- future deeper search/browse mapping if added later

## 5. Library/category list

### What it is
The library/category list is anchored by:
- `#libraryList`
- `.row`
- `.rowWrap`

Visible row targets include:
- Playlists
- Artists
- Albums
- Genres
- Podcasts
- Radio
- Queue Wizard
- Live Queue
- Visualizer
- Settings

### Special row behavior
The Live Queue entry has a richer wrapped row form with:
- `data-row-wrap="live-queue"`
- queue actions via `data-queue-act`

Visible row-level queue actions include:
- Vibe
- Crop
- Clear

### Why it matters
This list is not just navigation. At least some rows expose richer action behavior directly in the tablet shell.

### Companion pages
- `queue-wizard-internals.md`
- `controller-queue-interface.md`
- `kiosk-right-pane-routing.md`
- `embedded-pane-contracts.md`

### Settings child pane

The Settings row opens `controller-tablet-settings.html` inside the tablet shell. In addition to theme, visualizer, and recent-row preferences, it contains the local **Keep display awake** toggle and the Listen on Device playback options. The playback options can mute moOde's local ALSA output while the browser stream is active, restore ALSA on stop, and optionally send `mpc stop` when the browser listener stops. They are stored through `scripts/client-preferences.js` in the versioned `nowplaying.clientSettings.v1` origin-local object under `webStreamAutoMuteAlsa` and `webStreamStopMpd`, and the Settings pane's **Apply** button sends the values to the parent tablet shell.

`controller-tablet.html` owns the actual Screen Wake Lock lifecycle. It requests a screen lock only while the preference is enabled and the page is visible, releases it when the page is hidden or the preference is disabled, and retries after pageshow, focus, visibility, and orientation changes. The preference is deliberately not part of the shared server controller profile because it is device/display-specific.

The tablet page is also the direct implementation target for the `/controller-ipad` installed web-app identity. Its manifest uses the tablet icon family, and its opaque `black` status-bar treatment avoids the iPadOS installed-app vignette that appeared with `black-translucent` while retaining `viewport-fit=cover` and the existing safe-area geometry.

## 6. Recent-content region

### What it is
The recent-content region is anchored by:
- `#recentTitle`
- `#recentRail`
- `#recentPeekRail`
- `#railModeBtn`
- `#ipadRecentGrid`
- `#ipadRailAlbums`
- `#ipadRailPodcasts`
- `#ipadRailPlaylists`
- `#ipadRailRadio`

### What it does
This region provides the tablet shell’s recent-content browsing and switching behavior.

It can behave as:
- a single rail
- a peek rail
- or a multi-pane recent grid, depending on layout/profile/device mode

### Why it matters
This is one of the strongest anatomy regions where device preset and layout mode materially reshape the page.

### Companion pages
- `tablet-interface.md`
- `tablet-kiosk-shell-differences.md`
- `fragile-behavior-ownership.md`

## 7. Tablet next-up / action bars

### What they are
The tablet page includes additional tablet-specific summary bars anchored by:
- `#tabletTopCards`
- `#tabletNextUpBar`
- `#tabletNextUpRow`
- `#tabletNextUpArt`
- `#tabletNextUpText`
- `#tabletActionBar`
- `#tabletQueuePos`
- `#tabletAudioInfoBtn`
- plus inline next-up anchors inside the now-playing card:
  - `#tabletNextUpInline`
  - `#tabletNextUpArtInline`
  - `#tabletNextUpTextInline`

### What they do
These appear to be tablet-specific summary/action regions that surface queue position, next-up state, and an audio-info entrypoint in layouts where the tablet shell has room for extra contextual bars.

### Why they matter
This is likely one of the clearest examples of the tablet page having richer shell-specific queue/playback summary behavior than other controller surfaces.

### Companion pages
- `controller-queue-interface.md`
- `playback-authority-by-mode.md`
- `playback-issue-triage-runbook.md`

## 8. Kiosk pane iframe region

### What it is
The right-pane/embedded child region is anchored by:
- `#kioskPane`
- `#kioskPaneFrame`

### What it does
This region appears to host child pages inside a pane context and is one of the tablet page’s most important orchestration features.

### Why it matters
This region is likely where the tablet shell most strongly overlaps with kiosk-style pane routing and embedded child contracts.

### Companion pages
- `embedded-pane-contracts.md`
- `kiosk-right-pane-routing.md`
- `genre-pane-messaging.md`
- `visualizer-in-embedded-mode.md`

## Web tablet versus native Audio Info

This anatomy describes the **Server web tablet controller**, not Sonuvi iOS.
The web **Audio info** action still opens `audioInfoModal`; iOS now uses a
dedicated Audio Info screen instead of its former drawer. Do not transfer the
web-modal instructions to native navigation. See [Audio Info entry points](diagnostics-interface.md#audio-info-entry-points-and-presentation)
for endpoints and evidence semantics.

## 9. Album / artist / audio-info modal family

### What it is
The tablet page includes multiple modal/workflow regions, including:
- `#audioInfoModal`
- `#audioInfoList`
- `#recentAlbumModal`
- `#recentAlbumTracks`
- `#recentArtistModal`
- `#recentArtistAlbumsGrid`
- related buttons like:
  - `#recentAlbumAppendBtn`
  - `#recentAlbumCropBtn`
  - `#recentAlbumReplaceBtn`
  - `#recentArtistShuffleBtn`

### What they do
These are shell-owned detail workflows for:
- audio info
- recent album drill-down
- recent artist drill-down
- album queue actions
- artist shuffle flows

### Why they matter
A request to “improve the tablet page” may actually be about one of these modal/workflow surfaces, not the main shell layout.

## 10. Device-preset and layout-profile logic

### What it is
`controller-tablet.html` contains substantial page-level logic for device presets and layout profiles.

Current visible examples include:
- `devicePreset`
- `tablet`
- `ipad11`
- `ipadModern`
- `ipadAir`
- `tabletLandscape`
- `ipad11Landscape`
- `kiosk1280`
- `kioskEditor`

### What it does
This logic materially changes:
- grid structure
- card sizing
- recent-rail layout
- art/control placement
- next-up/action-bar visibility
- embedded pane behavior
- kiosk/editor control behavior

### Why it matters
This is one of the biggest reasons `controller-tablet.html` needs anatomy documentation. Many visible regions are not static; they are profile-sensitive.

### Companion pages
- `tablet-kiosk-shell-differences.md`
- `kiosk-interface.md`
- `display-surface-troubleshooting.md`
- `display-issue-triage-runbook.md`

## Practical “where do I start?” map

### If asked to improve the tablet now-playing header
Open first:
- `#npCard`
- `.np`
- `#npArtWrap`
- `#line1`, `#line2`, `#line3`
- transport controls under `#npCtrls`

### If asked to improve the tablet next-up area
Open first:
- `#tabletNextUpBar`
- `#tabletNextUpText`
- `#tabletNextUpInline`
- queue/playback companion pages

### If asked to improve quick search
Open first:
- `.quickWrap`
- `#homeQuickSearch`
- `#homeQuickResults`
- search/browse-related shell logic

### If asked to improve the library/category list
Open first:
- `#libraryList`
- `.row`
- `.rowWrap`
- special Live Queue row action wiring

### If asked to improve recent rails or recents layout
Open first:
- `#recentRail`
- `#recentPeekRail`
- `#ipadRecentGrid`
- device-preset/layout logic that changes recent-region structure

### If asked to improve right-pane embedded behavior
Open first:
- `#kioskPane`
- `#kioskPaneFrame`
- embedded-pane contract and kiosk routing companions

### If asked to improve album/artist/audio info modal behavior
Open first:
- `#audioInfoModal`
- `#recentAlbumModal`
- `#recentArtistModal`
- related action buttons and modal population logic

## Anatomy rule for future agents

For `controller-tablet.html`, do not assume a requested change belongs to only one of these buckets:
- layout/CSS only
- playback logic only
- embedded child page only
- kiosk logic only

Always classify the target first:
- shell region
- shell region with route-backed state
- shell-owned modal/workflow
- embedded child pane
- device-preset/layout-profile behavior

That classification step should save a lot of wrong first guesses.

## Relationship to other pages

This page should stay linked with:
- `tablet-interface.md`
- `user-interfaces.md`
- `tablet-kiosk-shell-differences.md`
- `embedded-pane-contracts.md`
- `kiosk-right-pane-routing.md`
- `controller-queue-interface.md`
- `queue-wizard-internals.md`
- `source-map.md`
- `display-issue-triage-runbook.md`
- `playback-issue-triage-runbook.md`

## Current status

At the moment, this page gives the wiki its second real page-anatomy reference.

Its main job is to make explicit that `controller-tablet.html` is not just a tablet-themed controller page.
It is a multi-region orchestration shell with:
- now-playing header behavior
- integrated transport
- quick search
- category navigation
- recent-rail browsing
- tablet-specific next-up/action regions
- pane embedding
- modal workflows
- and heavy device-preset/layout logic.

Quick Search track results retain artist and album metadata in the result title tooltip and accessible label, which helps distinguish duplicate track titles without expanding the compact result row.

During Qobuz Connect ownership, the now-playing transport controls remain
visible but are disabled with an explicit unavailable tooltip. They are MPD
controls and cannot safely pause, seek, shuffle, or stop the Pibuz renderer;
the server-side diagnostics playback route enforces the same boundary for
clients that bypass this shell.

*Last reviewed: 2026-10-28 America/Chicago*
