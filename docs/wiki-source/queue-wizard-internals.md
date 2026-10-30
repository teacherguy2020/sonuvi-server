---
title: queue-wizard-internals
page_type: companion
topics:
  - queue
  - playback
  - controller
  - integration
confidence: high
---

# queue-wizard internals

## Purpose

This page documents the current internal model of Queue Wizard in the `now-playing` system.

The wiki no longer needs to talk about Queue Wizard as a vague advanced feature.
Current evidence already supports a stronger statement:
- Queue Wizard is a real queue-shaping layer
- it sits above raw queue mutation
- it uses preview/apply semantics
- it is called by substantive controller/now-playing surfaces
- it intersects with Last.fm / Vibe-driven queue creation

## Scope

What this page now treats as established:
- Queue Wizard is the queue-shaping and queue-curation layer of the system
- it is not the same thing as the queue page
- preview/apply is one of its defining patterns
- album-level and feature-driven queue generation belong here

What still needs deeper code-first proof elsewhere:
- the exact complete route list
- the exact owning route file(s)
- the exact helper/service chain behind every Queue Wizard action
- the full request/response contract family

So this page documents Queue Wizard as a structurally understood layer, while leaving deeper endpoint ownership proof to companion pages.

## Why Queue Wizard matters

Queue Wizard is one of the strongest signs that `now-playing` is not merely a thin MPD remote.

It shows that the system can:
- compute or assemble a candidate queue change
- preview that change before committing it
- apply richer queue logic than simple append/play/replace primitives
- connect discovery or curation features to queue mutation

That makes Queue Wizard one of the main app-side intelligence layers in the playback model.

## High-level role

Queue Wizard is the queue-shaping and queue-curation layer of the system.

It sits above:
- raw transport
- raw queue mutation

It is where feature-side intent becomes a deliberate queue plan.

This makes it the natural companion to:
- `queue-and-playback-model.md`
- `api-playback-and-queue-endpoints.md`
- `controller-queue-interface.md`

## Queue Wizard versus raw queue mutation

## Raw queue mutation
Raw queue mutation means operations like:
- append item(s)
- replace queue
- crop queue

These are direct queue-changing actions.

## Queue Wizard
Queue Wizard adds a richer layer on top.

Its job is queue shaping, including:
- previewing queue changes before apply
- album-level queue planning
- structured queue shaping rather than one raw append call
- feature-driven queue generation from discovery/curation flows

This should stay explicit:
Queue Wizard is not merely another label for “add to queue.”
It is a higher-order control path.

For the retrieval-oriented distinction between Queue Wizard and the queue interface surface, see:
- `queue-interface-vs-queue-wizard.md`

## Current known semantics

## 1. Preview / apply pattern
This is the strongest current signal.

Queue Wizard computes or assembles a candidate queue change, supports preview, and apply commits the change.

That is exactly the pattern that separates it from raw queue primitives.

## 2. Album-level queue actions
Current wiki work already references queue-wizard preview/apply behavior for album actions.

That means Queue Wizard is one of the places where media/library structures become queue plans.

## 3. Feature-driven queue shaping
Queue Wizard is connected to features beyond plain playback control.

The config/Last.fm work already shows:
- when Last.fm is enabled/configured, Vibe tools are available in Queue Wizard

That means Queue Wizard is also part of discovery/curation-driven queue generation, not just deterministic local album actions.

## Current known caller surfaces

Based on current wiki work, Queue Wizard clearly intersects with these surface families.

## 1. Substantive `controller-now-playing*` pages
Current evidence already shows queue-wizard preview/apply behavior in the substantive `controller-now-playing*` family.

Those pages are some of the clearest known callers of Queue Wizard behavior.

## 2. Controller-side queue and now-playing interactions more broadly
Current controller/now-playing documentation already makes it clear that queue shaping is a first-class controller behavior.

Queue Wizard belongs in the same practical branch as queue display and playback control, but it owns a different layer.

## 3. Last.fm / Vibe discovery tooling
The config branch already shows that Last.fm/Vibe configuration unlocks Queue Wizard-adjacent tools.

That means Queue Wizard is part of discovery-driven queue creation as well as local-library queue construction.

## Queue Wizard in the overall playback model

A useful layered model is:

### Layer 1: transport
- play
- pause
- next
- resume

### Layer 2: raw queue mutation
- append
- replace
- crop

### Layer 3: queue inspection
- queue page / embedded queue
- current queue visibility

### Layer 4: queue shaping / curation
- Queue Wizard
- album-level queue planning
- preview/apply semantics
- feature-driven queue generation

This makes Queue Wizard a Layer 4 concept.
That is why it feels more app-like and less like a thin playback remote.

## Current route knowledge

The wiki already supports the existence of:
- a Queue Wizard route family
- preview/apply semantics
- album-level actions

The remaining gap is not whether Queue Wizard is real.
The remaining gap is:
- the exact route names
- exact request/response shapes
- exact owning file/module chain

So the right current statement is:
- Queue Wizard is structurally understood
- its route/file ownership still needs deeper tracing

## Relationship to YouTube queueing

Current YouTube work shows direct queue submission through:
- `POST /youtube/queue`

That is direct feature-specific queue mutation.
Queue Wizard is the broader queue-shaping and curation layer.

They can overlap conceptually, but they should not be treated as identical.

## Relationship to embedded queue surfaces

Current controller work shows embedded queue loading through:
- `controller-queue.html`

That page is primarily queue inspection/control UI.
Queue Wizard is the higher-order queue-shaping logic that determines what the queue should become.

Again:
- queue page = inspect/control current queue
- Queue Wizard = plan/shape candidate queue

## What still needs proof

The deeper engineering follow-up should answer:
- what exact routes belong to Queue Wizard?
- which route module owns them?
- which helper/service files implement preview/apply behavior?
- which controller surfaces call which Queue Wizard endpoints?
- how do Last.fm/Vibe tools connect into Queue Wizard at the route level?

## Seeded Vibe route behavior

Direct seeded Vibe actions from queue/controller surfaces use:
- `POST /config/queue-wizard/vibe-seed-start`

Current traced ownership:
- route module: `src/routes/config.queue-wizard-vibe.routes.mjs`
- caller example: `controller-queue.html`

Important operational note from live code tracing:
- seeded Vibe starts should register a real Queue Wizard Vibe job so controller polling against `GET /config/queue-wizard/vibe-status/:jobId` works
- seeded Vibe starts should also run the same vibe-index readiness check used by the now-playing Vibe builder path
- without those two pieces, the UI can look like “nothing happened” even when a seed request was accepted, because the controller gets a `jobId` but has no status object to poll and no surfaced error if index prep fails

## Vibe planner v2 — 2026-10-30

This source revision uses planner v2 for the normal
`POST /config/queue-wizard/vibe-start` flow and the server-side Endless Vibe
handoff. Other seeded callers retain their established path until they are
migrated deliberately.

The design separates planning from MPD mutation:

1. Build a richer local MPD index containing normalized artist/title keys,
   MusicBrainz track IDs, and local artist/title/album/genre metadata.
2. Perform a small, time-bounded set of Last.fm discovery passes and resolve
   only local-library matches.
3. Select a queue plan before touching MPD. The selector rejects queued files,
   duplicate normalized tracks, and seasonal material; it prefers distinct
   artist families and albums before relaxing those constraints.
4. Apply rating filtering before queue mutation. A zero-result plan leaves the
   existing queue alone.
5. Only after a non-empty plan exists does the route crop to the active seed,
   disable MPD random mode, append the plan, and optionally play.

For the initial small-list trial, `targetQueue: 12` means **12 total queue
entries including the currently playing seed**. The planner produces the
remaining 11 additions. It uses up to three additional discovery expansions
only while strict variety is not yet possible, subject to the existing time
budget.

Live MPD verification was run from an isolated temporary copy of the new
scripts: a saved John Mayer seed plus 11 additions produced a 12-track playing
queue. All added tracks were local MPD files, random mode was off, the run
completed with no stderr output, and the final plan reached the strict variety
stage. The immutable release process is still the authority for making this
source revision active on the production server.

## Endless Vibe behavior

The tablet controller's Live Queue surface also supports an **Endless Vibe** toggle in the queue header. This is a continuous queue-extension mode built on the seeded Vibe route rather than a separate Last.fm integration.

Current behavior:
- the shared Sonuvi setting is off by default and persists server-side in `data/endless-vibe.json`; legacy browser-local values are migrated when the queue surface first loads
- the toggle is shared across controllers that use the same Sonuvi instance
- the Sonuvi backend polls MPD while the setting is enabled and triggers only when a local music track is playing as the final queue item
- controller surfaces only read and change the shared setting; an open controller page is not required for monitoring or queue extension
- radio, podcast, and stream entries are excluded
- the current track's artist, title, and file become the next seed
- the seeded route runs with `keepPlaying: true` and `endless: true`, selecting the V2 planner path
- the V2 process is dry-run only: it plans a 12-track final queue (the active seed plus up to 11 local additions) before it is allowed to crop MPD
- after a non-empty local-file plan is read back, the server crops to the current seed, turns random off, and appends the planned tracks
- an empty or failed plan leaves the existing MPD queue alone
- if the seed naturally ends while the plan is being produced, Endless Vibe resumes the newly extended queue; ordinary one-shot queue builds do not force playback
- duplicate requests are suppressed while a Vibe job is starting or running

Endless Vibe intentionally differs from a one-shot seeded Vibe start: it is
triggered only at the final local MPD item and protects the active seed from a
failed or empty discovery result. Its V2 planner applies queue variety rules
before MPD is changed, rather than streaming legacy discovery results directly
into the queue.

## Native-device Endless Vibe

This is intentionally a separate mode from the server-global setting above.
The iPhone/iPad Live Queue stores its own `mobileDeviceEndlessVibeEnabled`
preference locally. When the selected target is This iPhone or This iPad, the
native model watches the current canonical device queue and begins a seeded
Vibe preview when five or fewer successors remain. The current track stays
playing; only future native queue items are replaced after the returned
artist/title candidates are resolved through the canonical mobile catalog.

The native watcher does not call `GET` or `POST /v1/mobile/endless-vibe`, so
turning it on cannot enable or disable the shared Home moOde/MPD watcher. The
Server exposes two separate bearer contracts for native migration:
`POST /v1/mobile/queue-wizard/vibe` creates the Home Queue Wizard job, while
`POST /v1/mobile/vibe/preview` invokes the existing dry-run Vibe engine and
returns only candidates resolved to canonical mobile track IDs. The preview
does not mutate the Home queue/playback or any Qobuz, UPnP, saved-queue, or
physical-shuffle state. The current iOS watcher still reuses the existing
Track-Key-protected seeded Vibe preview until that separate iOS migration is
made; this Server-only change does not alter the iOS repository. The Server
remains the Last.fm/index and catalog authority while playback and queue
ownership remain native. Last.fm write credentials are not copied into the
app.

## Relationship to other pages

This page should stay linked with:
- `queue-and-playback-model.md`
- `playback-authority-by-mode.md`
- `api-playback-and-queue-endpoints.md`
- `controller-queue-interface.md`
- `config-lastfm-and-scrobbling.md`
- `youtube-interface.md`
- `queue-interface-vs-queue-wizard.md`
- `mobile-feature-surfaces.md`

## Current status

This page now gives the wiki a sharper internal model of Queue Wizard:
- it is the queue-shaping layer
- it uses preview/apply semantics
- it is called by substantive controller/now-playing surfaces
- it intersects with discovery/curation features like Last.fm / Vibe
- its bearer mobile wrapper resolves opaque canonical IDs and applies to the
  selected target: Home moOde/ Alexa use the server queue, while This
  iPhone/This iPad receives the previewed tracks in the native device queue
- Add to Playlist, collage, and Vibe remain explicit server-side operations;
  the native client does not receive raw MPD paths or Track Keys

_Last updated: 2026-10-30 America/Chicago_
