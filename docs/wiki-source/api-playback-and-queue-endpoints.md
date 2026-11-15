# api playback and queue endpoints

## Purpose

This page documents the playback- and queue-oriented endpoint families that are already visible through current wiki work.

It exists because playback and queue control are central to the system, but their API coverage has so far been scattered across now-playing, display, kiosk, and integration pages.

This page is the API-centered starting point for that branch.

## Important scope note

This page is intentionally careful.

It documents the playback/queue route families that are already evidenced by current wiki work, including:
- direct playback control calls already observed in controller/now-playing pages
- queue-affecting YouTube submission
- queue-wizard preview/apply flows already seen from current surfaces
- queue-related embedded/controller loading patterns where the UI is clearly API-backed even if the exact backend route family is not yet fully inventoried

So this is a real page, but not yet the final exhaustive queue-route catalog.

## Why this page matters

Playback and queue control are some of the most important practical behaviors in the project.

They are where the system turns user actions into:
- play / pause / skip behavior
- queue mutation
- album/playlist insertion
- kiosk/controller-side control changes
- display-side push behavior that can affect active playback/presentation workflows

Without an API-centered page, those behaviors remain too tied to individual surfaces.

## Auth / request model

Current wiki work shows several repeated patterns here:
- HTTP GET and POST are both used
- some families are explicitly track-key-protected
- queue- and playback-affecting behavior often sits close to controller/UI actions rather than being hidden behind a deeply abstracted backend model

This matches the broader route-heavy architecture already documented elsewhere.

## 1. Direct playback control family

Current wiki work already shows direct playback control calls such as:
- `/config/diagnostics/playback`

### Where it shows up
This route family is already documented as appearing in the substantive `controller-now-playing*` pages.

### Current role
A good current interpretation is:
- this route family accepts direct transport-style playback commands from controller/now-playing surfaces
- it is part of the app-host control plane for transport behavior

### Why it matters
This is one of the clearest examples of controller-side UI actions mapping directly into a route family that changes active playback behavior.

### Browser Listen on Device bridge

The shared `scripts/web-stream.js` helper uses the same authenticated control
plane for browser-local listening:

- after the existing direct `audio.play()` call, it sends
  `POST /config/diagnostics/playback` with `{"action":"play"}` so a paused
  moOde stream resumes;
- when the device-local stop preference is enabled, stopping the browser
  listener sends the same endpoint with `{"action":"stop"}`; and
- when the device-local ALSA preference is enabled, it uses
  `GET`/`POST /mpd/local-output` to mute ALSA while listening and restore it on
  stop. The HTTP Server output used by the browser stream is not disabled.

These requests occur after playback startup; they are not prerequisites for the
gesture-sensitive `audio.play()` call. The webstream itself remains a direct
MPD HTTP stream and is not cached by a service worker.

## 2. Queue-wizard preview/apply family

Current wiki work repeatedly references:
- queue-wizard preview/apply flows for album-level actions

### Where it shows up
This behavior is already documented in:
- `now-playing-surface-variants.md`
- related controller-family observations

### Current role
A good current interpretation is:
- there is a queue-wizard route family that supports previewing and applying queue changes before committing them
- it is used for album-level and likely broader queue-shaping actions

### Why it matters
This means queue manipulation in the project is not just “append one thing.”
It includes a richer curation/control workflow.

### Important note
The exact route names for the queue-wizard family are not yet fully enumerated in current wiki work, so this page keeps that claim at the route-family level rather than pretending to have a full exact list prematurely.

## 3. YouTube queue submission family

Current wiki work already shows one concrete queue-affecting integration family:
- `POST /youtube/queue`

### Current role
This endpoint is used to push one or many resolved YouTube items into the playback queue.

### Documented request shape
Current wiki work shows fields like:
- `url`
- `urls`
- `mode`

with queue modes including:
- `append`
- `crop`
- `replace`

### Why it matters
Even though it lives under a feature-specific integration branch, this is also one of the most explicit queue-mutation endpoints currently documented.

It belongs in playback/queue coverage as much as in integration coverage.

## 4. Embedded queue loading patterns

Current wiki work shows recurring controller-side queue behavior such as:
- queue modal with embedded `controller-queue.html`
- queue modal with embedded `controller-queue.html?embedded=1`

### What this tells us
A good current interpretation is:
- queue inspection and queue control are first-class controller behaviors
- the queue UI is embedded in several important controller/now-playing surfaces
- there is clearly a backend/API contract behind the queue page, even though the exact route list is not yet fully inventoried in the current wiki

### Why it matters
This is a reminder that queue coverage is broader than the few route names we have already captured explicitly.

## 5. Display-push routes that overlap playback/presentation control

Current wiki work on `displays.html` already shows:
- `POST /config/moode/browser-url`
- `POST /peppy/last-profile`

### Why these belong here at all
These are not pure playback routes.
But they do sit close to the operational playback/presentation boundary because they influence what live display and controller surfaces are active on moOde.

In this system, display selection and playback experience are often tightly coupled enough that they deserve mention in the playback/control API map.

## Relationship between these families

A good current interpretation is:
- direct transport routes handle immediate playback actions
- queue-wizard routes handle richer queue shaping and preview/apply flows
- integration-specific queue routes like `/youtube/queue` feed content into the queue subsystem
- queue pages in controller/kiosk contexts are UI shells over a deeper queue API contract not yet fully inventoried here
- some display-push routes overlap operational playback/presentation control enough to remain adjacent to this branch

## What this page is not yet

This page is not yet the final exhaustive queue API inventory.

In particular, it does **not yet** fully enumerate:
- every queue route
- every playback transport action name
- every queue-wizard route name
- every request/response shape used by controller queue pages

That still needs deeper code-first route tracing.

## Relationship to existing wiki pages

This page should stay linked with:
- `queue-and-playback-model.md`
- `api-service-overview.md`
- `api-endpoint-catalog.md`
- `api-state-truth-endpoints.md`
- `api-config-and-runtime-endpoints.md`
- `api-youtube-radio-and-integration-endpoints.md`
- `now-playing-surface-variants.md`
- `display-launch-and-wrapper-surfaces.md`
- future queue/control drill-down pages

## Things still to verify later

Future deeper API work should clarify:
- the exact route names and contracts behind queue-wizard preview/apply
- the exact route family behind embedded/controller queue pages
- the full command contract for `/config/diagnostics/playback`
- how much queue control is MPD-direct versus app-mediated route logic

## Current status

At the moment, this page gives the API branch a credible playback/queue overview without pretending we already have the full route inventory.

That is the right tradeoff for now:
- real route families
- explicit known endpoints
- honest gaps called out for later deeper mapping

## Native Home transport authentication (2026-11-12)

`POST /v1/mobile/now-playing/control` forwards its validated paired-controller bearer to the fixed loopback diagnostics endpoint. Internal dispatch rechecks the token, device session, exact route, and typed operation. No operator Track Key is required. Redirects, arbitrary targets, operator actions, and unrecognized fields remain blocked. iPad, iPhone, and Apple TV share this path. Consume accepts its existing toggle or explicit on/off state. Native queue Shuffle/Undo/Crop and canonical Queue Wizard application also use this bridge. Native queue application has a separate route/body allowlist; it does not expand the browser proxy. All other legacy internal feature adapters are unchanged.
