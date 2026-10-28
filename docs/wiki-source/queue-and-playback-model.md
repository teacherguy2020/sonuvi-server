---
title: queue-and-playback-model
page_type: parent
topics:
  - queue
  - playback
  - api
  - controller
confidence: high
---

# queue and playback model

## Purpose

This page establishes the current conceptual model for playback and queue behavior in the `now-playing` system.

It exists because playback and queue behavior are some of the most important remaining high-value knowledge gaps in the wiki.

We already have many relevant pieces documented across:
- controller/now-playing surfaces
- playback troubleshooting
- integration notes
- API endpoint pages

But we do not yet have one page that says plainly:
- what playback control is
- what queue control is
- how they differ
- how they intersect
- where MPD, app routes, and user-facing surfaces fit into the model

This page is that foundation.

## Relevant source files

This page is branch-oriented rather than file-complete, but these areas are especially relevant when grounding queue-management behavior:
- `controller-queue.html`
- `queue-wizard.html`
- `src/routes/` queue and playback routes
- queue-affecting controller actions in controller-family pages
- backend queue/playback services and route ownership material

## Queue management at a glance

If you need the compressed branch model first, use this:
- **queue management** is about shaping, preserving, replacing, cropping, and navigating queued playback state
- **playback behavior** overlaps heavily with queue behavior, but they are not identical concepts
- the queue branch includes both direct queue control and wizard-style queue construction flows
- many apparent queue bugs are really mode/authority/ownership issues upstream of the visible queue surface

That is why this branch should be read as a management system, not just a list of queue UI pages.

## Why this page matters

A lot of practical confusion in this project comes from mixing together several things that are related but not identical:
- transport control
- queue inspection
- queue mutation
- queue shaping/curation
- playback-mode-specific authority
- display/presentation side effects

Without a model page, those concepts stay scattered across pages and are easy to blur together.

## Read this branch in this order

If you are trying to understand the queue branch as a system, read in this order:
1. [queue-and-playback-model.md](queue-and-playback-model.md)
2. [controller-queue-interface.md](controller-queue-interface.md)
3. [queue-wizard-internals.md](queue-wizard-internals.md)
4. [api-playback-and-queue-endpoints.md](api-playback-and-queue-endpoints.md)
5. [playback-authority-by-mode.md](playback-authority-by-mode.md)

Then move into troubleshooting or ownership pages when the issue becomes mode-specific or backend-specific.

## High-level model

A good current interpretation is:
- **playback control** is about the current transport state and what is actively playing next or now
- **queue control** is about what items are present and in what order
- **queue shaping** is a richer layer above raw queue mutation, where the system previews, filters, or restructures what should be played
- **controller surfaces** are usually the initiators of these actions
- **app-host API routes** are usually the control plane through which those actions become real
- **MPD** remains a core playback/queue truth source, but the app frequently mediates, enriches, or translates what that truth means for visible behavior

Alexa-originated controller requests are an important exception to Alexa-mode
queue behavior: `in the theater` requests fill and play the normal moOde/MPD
queue, while Echo-targeted requests retain Alexa-specific queue handling.

That is the model the rest of this page tries to preserve.

## Core distinction: playback vs queue

## Playback control
Playback control means actions such as:
- play
- pause
- resume
- next/skip
- previous/back (where supported)
- other direct transport-style actions

Current wiki work already shows direct playback route usage such as:
- `/config/diagnostics/playback`

### Working interpretation
A good current interpretation is:
- playback control acts on the current transport/session state
- it is concerned with what is playing or should immediately happen to playback
- it is not primarily about restructuring the whole queue

## Queue control
Queue control means operations such as:
- inspect queue contents
- append an item or items
- replace the queue
- crop/truncate a queue variant
- load a set of items derived from a search, album, playlist, or other selection

Current wiki work already shows concrete queue-affecting behavior such as:
- YouTube queue submission via `/youtube/queue`
- queue modal / embedded queue loading through `controller-queue.html`
- queue-wizard preview/apply flows for album-level actions

### Working interpretation
A good current interpretation is:
- queue control is about what is available to be played and in what order
- some queue operations are small and direct
- some queue operations are structured/curated and happen through higher-level tools like queue-wizard

## Queue shaping / curation
This is the richest layer and one of the most important to keep separate.

Queue shaping means things like:
- previewing an album-level queue plan before applying it
- replacing or cropping queue contents intentionally
- building a queue from higher-level feature flows rather than one raw append action
- using feature-side tools like Vibe / Last.fm / YouTube / album drill-downs to generate queue changes

### Why this matters
This is where the project becomes more than a thin MPD remote.
It starts acting like a curation layer on top of playback primitives.

## Current actor model

A useful current model is:

### 1. User-facing surfaces initiate intent
Typical initiators include:
- `controller-now-playing*` pages
- mobile/tablet/controller shells
- YouTube page
- queue surfaces
- possibly kiosk-embedded queue/now-playing actions

### 2. App-host routes mediate the action
The app-host API often acts as the control plane that:
- accepts the action
- translates it into queue/playback semantics
- coordinates with MPD and related helpers
- sometimes mixes in additional app-side logic or integration behavior

### 3. MPD remains an important underlying truth source
The wiki already shows enough to say:
- MPD is still foundational for playback/control behavior
- but the system often wraps MPD truth with route-side and feature-side logic

### 4. Visible surfaces re-render from resulting state
After the action, now-playing/controller/display surfaces reflect the updated playback and queue state, often through route-backed derived state rather than a direct raw MPD dump alone.

## Current queue and playback ownership matrix

| Target or queue | Queue owner | Transport owner | Mutation boundary |
| --- | --- | --- | --- |
| Home moOde (including Alexa local/theater requests) | Server-mediated MPD queue | moOde/MPD | Supported Home contracts; Alexa is the request origin, not a second queue |
| Echo-targeted Alexa | Server/skill queue coordination and remembered-track state | Echo AudioPlayer consumes the skill-provided stream | Do not equate the coordination queue with the physical audio output or apply local/theater display rules |
| Qobuz Connect | PiBuZ remote queue | PiBuZ/Qobuz Connect receiver | Read through the versioned mobile snapshot; guarded controls use fresh ownership, current-track/queue CAS fields, and read-after-write verification |
| UPnP | Sonuvi process-local logical queue | Selected UPnP renderer/session | Queue revision and renderer/session generation are required; renderer MPD queue and resource URLs are not client contracts |
| This iPhone/iPad | Native device queue for current playback surfaces | Native player for authorized local/server media | Device queue actions stay device-local; Server history events and existing opaque `MobileTrack` identities remain shared contracts |
| Saved Qobuz queue | Server-owned ordered occurrences | Played later through the Qobuz Connect target | Capture requires stable confirmed ownership; play uses explicit confirmation and typed operation status |

This matrix separates queue ownership from playback authority. A controller
can display a queue without owning the renderer, and an integration such as
Alexa can originate a request without becoming the queue authority.

### Transition and native-device boundaries

A queue snapshot is not permission to take over its output. Follow the
[release/handoff table](playback-authority-by-mode.md#release-and-handoff-are-explicit-transitions)
before crossing MPD, Qobuz or Server UPnP ownership.
For **This iPhone/iPad**, the device owns playback order/state; Server catalog
IDs and authorized media bytes do not make the Home MPD queue authoritative.
Native UPnP also differs from the Server's logical UPnP queue/session.
The future device-owned canonical catalog is not implemented by these Server
contracts; see [catalog and byte ownership](media-library.md#catalog-identity-and-byte-ownership).

`GET /v1/mobile/history/recent` supplies a last-played seed for an empty display
queue, not current now-playing truth or permission to overwrite an existing
queue. Native Vibe preview returns recommendations without mutating Home;
Queue Wizard jobs are for intentional Server queue work. See the
[October native handoff](../ios/server-to-ios-contract-handoff-2026-10.md).

## Current known playback/queue route families

This page is not yet the final route catalog, but we already know enough to identify major families.

## Direct playback family
Current concrete evidence includes:
- `/config/diagnostics/playback`

This is the clearest currently documented direct transport control route family.

## Queue-wizard family
Current evidence includes:
- preview/apply flows repeatedly documented in controller/now-playing pages

The exact route list is still not fully enumerated, but this family clearly exists and is important.

## YouTube queue family
Current concrete evidence includes:
- `POST /youtube/queue`

With queue modes including:
- `append`
- `crop`
- `replace`

This is both an integration route and a queue-mutation route.

## Embedded queue surface
Current evidence includes:
- `controller-queue.html`
- `controller-queue.html?embedded=1`

This tells us queue inspection/control is a first-class surface, even though its backend route family still needs deeper proofing.

## Display/presentation overlap family
Current evidence includes:
- `POST /config/moode/browser-url`
- `POST /peppy/last-profile`

These are not pure queue/playback routes, but in this system they sit close enough to operational playback/presentation control that they belong adjacent to the model.

## MPD versus app-side mediation

One of the most important things the wiki now knows is:
- this project is not just a direct MPD thin client

Current evidence supports a more nuanced model:
- MPD primitives are foundational
- app-side route families often mediate queue/playback-related behavior
- some route modules mix MPD truth with moOde-side truth and app-side shaping logic
- visible playback state, queue state, art, and current-song interpretation can depend on playback mode and route-side logic, not only on raw MPD state

### Practical implication
Future agents should not assume:
- “queue behavior” = raw MPD queue only
- “playback behavior” = raw MPD transport only
- “what the user sees” = direct unmediated backend state

There is usually an app-side translation layer involved.

## Relation to playback mode

Playback and queue behavior are not completely mode-agnostic.

Current wiki work already shows that the broader playback authority model changes depending on mode:
- local file
- AirPlay
- UPnP
- radio/stream
- fallback/unresolved

### Why it matters here
Even when transport and queue controls exist across modes, the meaning of:
- current song
- art
- next up
- fallback behavior
- visible queue consequences

can differ by playback mode.

So a full playback/queue understanding will eventually need a companion page on playback authority by mode.

## Relation to display and controller surfaces

Playback and queue behavior are tightly tied to controller surfaces.

Current wiki evidence shows:
- `controller-now-playing*` pages issue playback actions
- they also trigger album/artist drill-down and queue-related actions
- queue UI can appear as embedded modal content
- kiosk/controller/display distinctions change where the user sees playback/queue behavior, but not the importance of the underlying control model

### Practical implication
Playback/queue documentation should stay linked to:
- controller branch pages
- display branch pages where display push changes operational playback/presentation behavior
- API pages that describe the control-plane route families

## Current known queue mutation patterns

Even without a full route catalog, current wiki work already supports at least these queue mutation patterns:

### Direct append
- add content to the existing queue

### Replace
- replace current queue contents with a new set

### Crop
- a queue-shaping variant explicitly surfaced in YouTube queue submission

### Preview/apply
- richer queue-wizard pattern where the operator/user previews a queue shape before committing it

### Embedded queue inspection
- view queue state from controller/now-playing contexts via embedded queue surfaces

This is already enough to show that queue behavior is multi-layered.

## What this page does not yet claim

This page is intentionally foundational, not a replacement for the endpoint
catalog. It now records the current high-value route families and ownership
rules, but it is not a generated inventory of every route or request field.

It does not attempt to reproduce every queue-wizard route, embedded UI helper,
or MPD command sequence. Those details belong in the endpoint catalog and
source-specific pages linked below.

Those are the next-level proofing tasks.

## Relationship to other pages

This page should stay linked with:
- [api-playback-and-queue-endpoints.md](api-playback-and-queue-endpoints.md)
- [api-service-overview.md](api-service-overview.md)
- [now-playing-surface-variants.md](now-playing-surface-variants.md)
- [youtube-interface.md](youtube-interface.md)
- [playback-mode-troubleshooting.md](playback-mode-troubleshooting.md)
- [integrations.md](integrations.md)

## What should follow this page

The next highest-value companion pages are:
- [playback-authority-by-mode.md](playback-authority-by-mode.md)
- [queue-wizard-internals.md](queue-wizard-internals.md)
- [controller-queue-interface.md](controller-queue-interface.md)

[playback-authority-by-mode.md](playback-authority-by-mode.md) now serves as the companion page for mode-specific playback/art/status authority.

[queue-wizard-internals.md](queue-wizard-internals.md) now serves as the sharper internal model page for Queue Wizard as the queue-shaping and preview/apply layer.

[controller-queue-interface.md](controller-queue-interface.md) now serves as the dedicated queue-surface page for standalone and embedded queue UI behavior.

Those would turn this conceptual model into a much stronger engineering map.


## Current status

At the moment, this page gives the wiki the foundational distinction it was missing:
- playback control
- queue control
- queue shaping/curation
- controller/API/MPD roles
- display/presentation overlap

That is enough to make the rest of the Phase 2 work more coherent.

*Last reviewed: 2026-10-28 America/Chicago*
