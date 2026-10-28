# glossary

## Purpose

This page defines project-specific terms and names used across the `now-playing` system and this knowledge base.

It is meant to reduce ambiguity for future agents and for Brian when discussing:
- subsystems
- interfaces
- integrations
- operational concepts

## How to use this page

Use this page when:
- a term appears repeatedly across multiple wiki pages
- two nearby concepts are easy to blur together
- you need a stable project-specific meaning before making implementation or documentation decisions

This page is not meant to replace deeper branch pages. It is meant to stabilize vocabulary before or while reading them.

## Core project terms

- **now-playing** — the overall project/system described by this wiki; a media-control and presentation system with UI, playback, display, integration, and operational concerns.
- **media library** — the area of the system concerned with browsing and managing available media content.
- **playlist management** — the feature area concerned with organizing and controlling playlists.
- **queue wizard** — a documented interface/feature area for managing queue-oriented playback flow.
- **filter builder** — a documented interface/feature area for filtering or shaping content selection.
- **transport controls** — playback-control actions and surfaces.
- **ratings / favorites** — the feature area for user curation and preference marking.
- **animated art system** — the feature area concerned with animated visual art presentation.
- **art caching system** — the subsystem for caching artwork or presentation assets.
- **kiosk mode** — a display-oriented operating mode focused on a dedicated presentation surface.

## Identifiers and credentials

| Term | Meaning / non-equivalence |
| --- | --- |
| `TRACK_KEY` / admin Track Key | Shared credential used by particular legacy/admin handlers; not a song identifier or universal route policy |
| Mobile bearer session | Scoped authorization for supported native API operations; not the refresh credential or web Track Key |
| Refresh credential / media ticket | Renewal credential and short-lived byte-delivery authorization respectively; neither defines catalog identity |
| Mobile `trackId` / `MobileTrack` | Server-resolved opaque catalog identity; current mapping can include edition/folder disambiguation |
| History `trackKey` | Stored media identity field; despite the historical name, not the admin shared secret |
| MPD song ID / queue item | Queue-occurrence handle, not a globally durable catalog identity |
| UPnP selection reference | Server-issued handle to a trusted provider item; resource URL and renderer session are different objects |
| Queue revision / session generation | Concurrency/ownership guards; refresh after conflict, do not replay stale intent |
| Qobuz queue fingerprint / current-track guard | Compare-and-swap evidence for guarded remote control, not a credential |
| Local-source manifest | Mapping from accepted identity to available relative bytes; not a new device catalog |

See [authentication enforcement](api-service-overview.md#method-level-boundaries-not-one-prefix-wide-policy),
[catalog ownership](media-library.md#catalog-identity-and-byte-ownership), and
[history schema](centralized-playback-history-and-scrobbling.md).

## Playback and observation vocabulary

- **Playback authority:** the current domain permitted to control output;
  distinct from the controller that originated a request or a UI showing it.
- **Release/handoff:** explicit transition between owners with confirmation;
  availability, metadata or a successful poll alone is not ownership proof.
- **Server-mediated UPnP:** Sonuvi owns logical queue/session and delegates
  transport to a renderer; native UPnP can be a different controller/owner.
- **Listen on Device:** browser stream/output coordination, not automatically
  the native iOS playback-event pipeline.
- **Mills display surrogate:** temporary digital metadata work for a physical
  record session, with MPD state snapshot/restoration; not independent MPD audio.
- **Vibe job versus preview:** Server queue-building work versus native
  recommendation preview that does not mutate Home playback.
- **Radio holdback / optimistic UI:** bounded metadata-stability and UI
  reconciliation techniques; neither changes the real playback authority.
- **Audio provenance / freshness:** where an audio value came from and when
  it was observed; configured chain, decoded PCM and measured ALSA are not
  interchangeable. See [Audio Info evidence roles](diagnostics-interface.md#what-audio-info-can-establish).
- **Atomic replacement:** readers can see a completed replacement instead of
  partial output; this does not by itself prove power-loss durability/fsync.

These definitions reuse useful concepts from the external glossary but are
checked against Sonuvi source. Meter producers PUT samples to Server;
Peppy browser renderers GET samples. Installed moOde overrides exist even
though Sonuvi is not a wholesale fork of moOde.

## Interfaces and surfaces

- **display pages** — documented display-oriented pages/surfaces used for showing project output.
- **mobile controller** — the mobile-facing control surface for interacting with the system remotely.
- **queue wizard interface** — the queue-specific user-facing interface.
- **filter builder** — both a feature area and a user-facing interface for selection/filter logic.
- **radio stations** — the user-facing area for station-oriented playback sources.
- **media library view** — the browsing surface for available content.

## Integrations and external systems

- **MPD** — Music Player Daemon integration used by the project’s playback/control ecosystem.
- **moOde** — an important display/runtime-side external system in this project’s environment and integration model.
- **YouTube** — an external content/integration source documented in the project.
- **GET / POST request flows** — documented request patterns used where the system interacts through HTTP/API-style operations.
- **header auth** — documented request/auth pattern using headers instead of query parameters.

## Operational vocabulary

- **runtime verification** — the practice of checking what is actually running and whether the system is behaving correctly.
- **service control** — starting, stopping, or otherwise managing the runtime services/processes behind the system.
- **configuration management** — the operational/configuration layer for system behavior and setup.
- **API host / webAPI machine** — the host or machine context used for API-side operation in the docs.
- **Chromium process** — a runtime/browser-process concept important enough to have dedicated checks in the documentation.
- **wake display configuration** — configuration related to waking or controlling display state.

## Relationship to other pages

This page should stay closely linked with:
- [README.md](README.md)
- [system-overview.md](system-overview.md)
- [architecture.md](architecture.md)
- [deepwiki-structure-mapping.md](deepwiki-structure-mapping.md)

## Terms needing clarification

These terms are already useful, but still need tighter definitions over time:
- some documented surfaces still need precise file/service ownership mapping in `source-map.md`
- some feature-area terms still need deeper behavioral definitions from repo reality, not only doc titles
- `moOde` and `MPD` are clearly important, but later versions of this page should explain more precisely how each one participates in current live operation

Distinctions future agents should not blur:
- a documented feature area is not automatically the same thing as its implementation ownership
- system-level/runtime configuration is not the same thing as application-level state or UI behavior
- project-wide terminology is not the same thing as Brian-specific local-environment terminology

Good follow-up glossary targets:
- tighter definitions for terms whose behavior is still only partially mapped
- a later mapping-oriented glossary layer for file/service ownership if that becomes useful
- deeper integration vocabulary once MPD/moOde/request-flow ownership is mapped more precisely

*Last reviewed: 2026-10-28 America/Chicago*
