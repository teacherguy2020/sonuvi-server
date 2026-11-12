# tablet interface

## Purpose

This page describes the tablet-oriented interface family in the `now-playing` ecosystem.

It exists because tablet usage is not just a resized desktop or mobile experience. The tablet branch appears to be one of the richest controller-facing surfaces in the system, combining:
- browse and discovery flows
- queue and playback control
- pane-embedded subviews
- kiosk-style display behavior
- settings/configuration affordances

That makes the tablet interface one of the most important surfaces to document in depth.

## Why the tablet interface matters

From the work so far, tablet-related surfaces appear to be a major convergence point for:
- controller-family interaction
- media-library browsing
- kiosk pane routing
- visualizer integration
- settings and presentation customization

The tablet shell also appears to clarify some architectural behaviors more explicitly than the main controller shell, especially around pane messaging and pane state.

So this page should serve as a major tablet-oriented hub, not just a device-size note.

## Important file

Primary file:
- `now-playing/controller-tablet.html`

Related pages already documented:
- `tablet-kiosk-shell-differences.md`
- `kiosk-right-pane-routing.md`
- `embedded-pane-contracts.md`
- `genre-pane-messaging.md`
- `visualizer-in-embedded-mode.md`

## Installed iPad web-app behavior

`controller-tablet.html` is the direct implementation page for the iPad/tablet Home Screen app. The tablet and iPad manifests intentionally share the stable `/controller-ipad` identity, direct `controller-tablet.html?devicePreset=ipadpro11-landscape` start URL, and tablet-specific icon family.

The page retains `viewport-fit=cover` and safe-area handling, but uses opaque `black` status-bar treatment. This is important: the prior `black-translucent` setting caused iPadOS to add a dark upper-edge vignette in the installed app, clouding the first action row. The `black` setting removed that effect in a newly created Home Screen app without moving the controller geometry.

The Settings row opens `controller-tablet-settings.html`, where the device-local **Keep display awake** preference and the Listen on Device preferences are exposed. The playback options can automatically mute moOde's local ALSA output while this browser is listening, restore ALSA when listening stops, and send `mpc stop` when the browser listener stops. They are stored in the versioned `nowplaying.clientSettings.v1` origin-local object and require the Settings pane's **Apply** button. The parent tablet shell owns the secure-context-gated Screen Wake Lock lifecycle and releases/reacquires it across visibility, focus, pageshow, and orientation changes.

The tablet shell also participates in metadata-only MediaSession support for Listen on Device. Current Now-Playing state supplies title, artist, album, and artwork after the existing gesture-safe persistent audio stream starts. No seek/playback action handlers are added for the continuous MPD stream.

## What the tablet interface appears to include

Based on current repo inspection and kiosk-branch work, the tablet interface appears to include at least:
- browse and category surfaces such as playlists, artists, albums, genres, podcasts, and radio
- queue access and queue-wizard-related flows
- recent-content rails and pane-open interactions
- right-pane embedded subviews in landscape or kiosk-like contexts
- visualizer access and visualizer-related state handoff
- tablet-specific settings surfaces
- kiosk-like display behavior when tablet shell is used in kiosk-oriented contexts

This means the tablet interface should be understood as a controller-and-presentation hybrid surface, not just a controller skin.

## Current architectural role

A useful current interpretation is:
- `controller-tablet.html` is one of the central orchestration shells of the UI
- it combines navigation, recent-content browsing, pane hosting, and profile-aware presentation
- it appears to support both ordinary tablet control usage and kiosk/presentation-adjacent usage

That gives it a broader role than a simple “tablet page.”

## Strongly related drill-down areas

The tablet interface already has several obvious branch areas.

### Tablet kiosk shell behavior
Current best page:
- [`tablet-kiosk-shell-differences.md`](tablet-kiosk-shell-differences.md)

Use this when the question is about:
- pane routing
- pane message handling
- prewarming
- kiosk-shell differences from the main controller shell

### Embedded pane contracts
Current best page:
- [`embedded-pane-contracts.md`](embedded-pane-contracts.md)

Use this when the question is about:
- embedded child behavior
- `embedded=1`
- parent/child pane messaging
- pane close or semantic pane communication

### Genre/albums semantic pane drill-down
Current best page:
- [`genre-pane-messaging.md`](genre-pane-messaging.md)

Use this when the question is about:
- genre selection
- album drill-down from genre
- queue-wizard-backed filtered album loading

### Visualizer behavior within tablet shell contexts
Current best page:
- [`visualizer-in-embedded-mode.md`](visualizer-in-embedded-mode.md)

Use this when the question is about:
- visualizer pane behavior
- visualizer fullscreen handoff
- preset/energy/motion/glow handoff
- moOde push behavior tied to visualizer mode

## Anatomy companion page

- `controller-tablet-anatomy.md`

This is the anatomy-style companion page for the tablet branch.
Use it when the task is not just about the tablet interface in general, but about a specific region inside `controller-tablet.html` such as the now-playing header, transport controls, quick search strip, library/category list, recent rails, tablet next-up/action bars, kiosk pane, or modal family.

## Likely implementation dimensions

The tablet interface likely spans several implementation dimensions:
- main shell HTML in `controller-tablet.html`
- embedded child controller pages
- pane-routing logic
- profile/theme/color handling
- recent-content rails and content panes
- queue and browse data-loading calls
- tablet settings subviews
- visualizer and display-mode handoffs

So documenting the tablet interface fully will likely require both:
- shell-level documentation
- branch pages for major child flows

## What this page should eventually explain in more detail

A mature tablet interface page should eventually explain:
- what the main regions of the tablet shell are
- what actions users take there most often
- what pane-capable subviews exist
- how recent rails, library views, and queue views interact
- what settings/configuration features are tablet-specific
- how the tablet shell differs from desktop and mobile controller shells
- what files, functions, and API routes matter most in the tablet shell

## Related branch pages

- `controller-device-alias-pages.md`
- `now-playing-surface-variants.md`
- `api-playback-and-queue-endpoints.md`
- `controller-tablet-anatomy.md`

This is relevant when the tablet question starts from the device-named `controller-ipad.html` entrypoint rather than the real tablet shell.

`now-playing-surface-variants.md` is relevant when tablet investigation overlaps with the substantive `controller-now-playing*` family and its layout/device variants.

`api-playback-and-queue-endpoints.md` is relevant when the real question is about the control-plane routes behind tablet-side playback, queue, and queue-wizard actions.

`controller-tablet-anatomy.md` is relevant when the real question is not only “what is the tablet shell?” but “which region inside `controller-tablet.html` actually owns the thing I need to change?”

## Relationship to the rest of the wiki

This page should remain closely linked with:
- `user-interfaces.md` — top-level interface-family navigation
- `display-interface.md` — where tablet overlaps with display/presentation behavior
- `media-library.md` (future/expanding) — where tablet browse surfaces are likely central
- `queue-and-playback-control.md` (future/expanding) — where tablet queue/control flows are likely central
- `source-map.md` — when transitioning from interface understanding into files

## See also

- `tablet-kiosk-shell-differences.md`
- `embedded-pane-contracts.md`
- `genre-pane-messaging.md`
- `visualizer-in-embedded-mode.md`
- `phone-interface.md`
- `desktop-browser-interface.md`

## Current status

### Interaction note — 2026-11-12

In landscape, `#libraryList` is a nested two-column navigation scroller. Its
touch gestures remain owned by that scroller in both directions, including at
its top and bottom edges. The document-level pull-to-refresh handler clears
its tracking for library-originated or cancelled touches, so returning to the
Home row cannot reload the controller. Pull-to-refresh remains available for
ordinary page-level touches at the document top.

At the moment, this page is a tablet-oriented hub page rather than a fully exhaustive implementation guide.

That is intentional.

Its role is to establish the tablet interface as a first-class branch of the knowledge base and to connect it to the richer drill-down pages that already exist.

As the wiki grows, this page should become one of the main starting points for understanding how humans actually interact with the system in a controller-heavy, pane-rich, tablet-sized context.
