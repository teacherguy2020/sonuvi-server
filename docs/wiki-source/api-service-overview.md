# api service overview

## Purpose

This page introduces the API service layer in the `now-playing` system.

It exists because the wiki already documents many API calls indirectly through interface and feature pages, but it does not yet have a dedicated API-centered parent page.

This page is meant to be that parent page.

## Relevant source files

This page is branch-oriented rather than file-complete, but these areas are especially relevant when grounding the Backend API branch:
- `moode-nowplaying-api.mjs`
- `src/routes/`
- `src/services/`
- route and service helpers that shape `/now-playing`, queue, config/runtime, and integration behavior

## Backend API at a glance

If you need the compressed branch model first, use this:
- **state truth endpoints** shape the visible current-state contract
- **playback and queue endpoints** control and mutate active playback state
- **config and runtime endpoints** expose the operational control plane
- **integration endpoints** bridge external systems such as YouTube, radio, Alexa, and adjacent integration flows
- **the API branch is not generic plumbing**; it is one of the main behavior-ownership surfaces in the project

That is why this branch should be read as a true top-level system branch.

## Why this page matters

A lot of the system’s real behavior is not owned only by HTML pages or frontend scripts.
It is mediated through an app-host API service that:
- serves config and runtime state
- accepts privileged maintenance actions
- exposes playback and queue controls
- powers feature-specific bridges like YouTube and radio evaluation
- coordinates with MPD, moOde, and other runtime-adjacent services

Without an API-centered page, the wiki stays too UI-centric.

## Read this branch in this order

If you are trying to understand the Backend API as a system, read in this order:
1. [api-service-overview.md](api-service-overview.md)
2. [api-state-truth-endpoints.md](api-state-truth-endpoints.md)
3. [api-playback-and-queue-endpoints.md](api-playback-and-queue-endpoints.md)
4. [api-config-and-runtime-endpoints.md](api-config-and-runtime-endpoints.md)
5. [api-youtube-radio-and-integration-endpoints.md](api-youtube-radio-and-integration-endpoints.md)
6. [api-endpoint-catalog.md](api-endpoint-catalog.md)

Then move into route ownership or troubleshooting pages when the question becomes service-specific or bug-specific.

## High-level role of the API service

A good current interpretation is:
- the API service is the app-side control plane of the system
- frontend/controller/admin pages call into it over HTTP
- it is one of the main places where UI intent turns into operational behavior

That makes it more than “backend plumbing.”
It is one of the project’s primary architectural surfaces.

## What the API service appears to own

Based on current wiki work and repo-visible interface behavior, the API service appears to own or mediate at least these route families:

- config and runtime state
- environment verification and maintenance
- playback and queue actions
- ratings database maintenance
- YouTube search/resolve/playlist/queue flows
- radio metadata debug/evaluation flows
- Alexa domain verification and related setup checks
- service-control actions such as mpdscribble control
- moOde browser-target inspection and related display-control helpers
- podcast automation/status helpers

This is enough already to justify a dedicated API branch in the wiki.

## Relationship to the rest of the system

The API service sits between several major layers:

### 1. UI / surface layer
Pages like:
- `config.html`
- `diagnostics.html`
- `youtube.html`
- `radio-eval.html`
- controller and kiosk pages

call into the API service to do real work.

### 2. Integration layer
The API service is one of the places where the system touches:
- MPD
- moOde
- YouTube
- Last.fm-related workflows
- Alexa-adjacent setup and routing

### 3. Operational/runtime layer
The API service also owns or mediates actions that depend on:
- track-key-protected maintenance calls
- SSH-backed runtime verification
- local-host state
- service status and restart-sensitive behavior

So the API service is not purely a business-logic layer or a transport wrapper. It is where several layers collide.

## Request model

The current wiki already makes several request-pattern facts clear:

- HTTP GET and POST are both used heavily
- many privileged or maintenance-sensitive operations require a track key
- the track key is commonly sent as:
  - `x-track-key`
- header-based auth matters enough to be called out explicitly in the integration docs

### Method-level boundaries, not one prefix-wide policy

A route's sensitivity does not establish its enforcement. The current Server
contains trusted-LAN legacy endpoints as well as explicitly authenticated APIs.
UI feature gates, a private hostname, and possession of an opaque track ID are
not substitutes for a route's actual authorization check.

| Method / path | Implemented credential boundary | Intended caller / limitation |
| --- | --- | --- |
| `GET /config/runtime` | No `requireTrackKey` in this handler | Legacy browser bootstrap returns configuration; do not describe the whole `/config/*` prefix as authenticated |
| `POST /config/runtime` and `POST /config/runtime/check-env` | Track Key | Web/operator configuration and environment checks |
| `POST /config/diagnostics/playback` | Track Key plus source-ownership guards | Classic web/operator control |
| `POST /rating`, selected `/podcasts/*` writes | No Track-Key check in those legacy handlers | Not evidence of a uniform protected-write boundary; review exact method before exposing it |
| `POST /v1/mobile/now-playing/control`, `POST /v1/mobile/playback/events`, `GET /v1/mobile/audio-info` | Mobile bearer with `mobile-api` scope | Native operations; no client Track Key or raw MPD path |
| `POST /v1/mobile/session` / `/session/refresh` | Enrollment code / refresh credential respectively | Bootstrap/renewal exceptions to ordinary bearer requests |
| Pairing challenge / approval | Track Key for an authorized web display, or existing bearer for an authorized native display; approval also needs display token and verification code | Separate from the unpaired device's challenge/public-key proof and poll token |
| Ticket-authorized media/radio GET | Short-lived scoped media/radio ticket | Player delivery request; ticket is not a catalog identity or general bearer session |

See [runtime methods](api-config-and-runtime-endpoints.md),
[the pairing protocol](mobile-carplay-phase1.md#local-device-pairing), and
[identifier versus credential terms](glossary.md#identifiers-and-credentials).
This is a source-level description, not a fresh verification of network exposure
or a claim that every legacy endpoint has been hardened.

## Authentication domains and the Server/iOS boundary

Native callers use supported mobile bearer contracts; enrollment, renewal,
pairing and media-ticket delivery have the specific boundaries above. The
Server resolves opaque mobile IDs and owns target guards, history qualification
and provider credentials. Native clients report intent and observations; they
do not receive admin Track Keys, raw MPD paths or provider secrets.

Current Home control, deterministic repeat/Consume, native Vibe preview and
queue paging are documented in the [October Server/iOS handoff](../ios/server-to-ios-contract-handoff-2026-10.md).
Audio provenance and entry points are in [Audio Info](diagnostics-interface.md#audio-info-entry-points-and-presentation).

## Current route-family map

This is a working route-family map, not yet the final exhaustive inventory.

### Config / runtime family
Examples already documented elsewhere include route families under:
- `/config/runtime`
- `/config/alexa/*`
- `/config/ratings/*`
- `/config/services/*`
- `/config/moode/*`

These routes appear to handle:
- config load/save
- environment checks
- feature-specific verification
- service control
- ratings maintenance
- moOde target URL inspection

### Playback / queue / control family
Current wiki pages already show playback/control calls such as:
- playback control endpoints under config/diagnostics-style route families
- queue-affecting actions used by controller and now-playing surfaces

This family still needs its own dedicated API page.

### YouTube integration family
Current wiki coverage already shows:
- `/youtube/search`
- `/youtube/playlist`
- `/youtube/resolve`
- `/youtube/queue`

This is already one of the clearest feature-specific endpoint groups.

### Radio debug / evaluation family
Current wiki coverage already shows:
- `/debug/radio-metadata-log`
- `/debug/radio-metadata-log/clear`

This is a diagnostics/debug route family rather than an end-user feature family.

### Podcast automation family
Current config work already shows:
- `/podcasts/nightly-status`
- `/podcasts/nightly-run`

This appears to be a small automation-focused route family.

### Native mobile contract family

The current shared Server/iOS surface is the bearer family under
`/v1/mobile`. Its high-value contracts include:

- now-playing, next-up, Audio Info, catalog, artwork, playlists, and the
  Home moOde queue;
- Qobuz Connect snapshot, queue, guarded transport, saved queues, and
  explicit release/handoff;
- UPnP discovery, sanitized browse/search, renderer/session transport, and
  revision/session-generation-bound logical queues;
- `GET /v1/mobile/local-source/manifest` for canonical-ID-to-local-byte
  availability; and
- `POST /v1/mobile/playback/events` plus
  `GET /v1/mobile/history/recent` for native observation and recent history.

The approved device-owned canonical catalog is a future architecture. The
current Server-backed `MobileTrack` and these route contracts remain the
implementation boundary until identity and synchronization rules are designed
and approved.

## Architectural interpretation

A good current interpretation is:
- the API service is not just a generic REST surface
- route families often map directly to feature ownership and operational workflows
- some routes are thin helpers, but many appear to be first-class ownership points for system behavior

This matches the broader architectural lesson already documented elsewhere:
- the project is route-heavy
- important logic often lives close to feature routes rather than being cleanly hidden behind a single deep service layer

## What this page is not yet

This page is intentionally a parent overview, not the full endpoint catalog.

It does **not yet** attempt to fully list:
- every route
- every request body
- every response shape
- every caller file

That should happen in dedicated child pages.

## Candidate child pages

The next sensible API-centered child pages are:

### `api-config-and-runtime-endpoints.md`
Now serves as the API-centered drill-down for:
- `/config/runtime`
- `/config/runtime/check-env`
- `/config/runtime/ensure-podcast-root`
- `/config/alexa/check-domain`
- ratings endpoints
- service-control endpoints
- moOde/browser-url endpoints

### `api-playback-and-queue-endpoints.md`
Now serves as the API-centered drill-down for playback-control and queue-shaping actions used by controller and now-playing surfaces.

### `api-endpoint-catalog.md`
Now serves as the source-driven inventory page for concrete endpoints found directly in source files, grouped by family with owner-file visibility and explicit proof limits.

### `api-state-truth-endpoints.md`
Now serves as the focused explanation page for the most important state/truth surfaces such as `/now-playing`, `/next-up`, and Alexa-adjacent visible-state helpers.

### `api-youtube-radio-and-integration-endpoints.md`
Now serves as the API-centered drill-down for:
- `/youtube/*`
- radio debug/eval endpoints
- related feature-specific integration families

### `api-diagnostics-and-maintenance-endpoints.md`
For diagnostics- and maintenance-heavy route families that cut across features.

## Relationship to existing wiki pages

This page should stay linked with:
- [integrations.md](integrations.md)
- [architecture.md](architecture.md)
- [config-interface.md](config-interface.md)
- [youtube-interface.md](youtube-interface.md)
- [radio-metadata-eval-interface.md](radio-metadata-eval-interface.md)
- config child pages that already document endpoint families indirectly

## Current status

At the moment, this page gives the wiki an API-centered entry point it was missing.

That matters because the project is not only:
- a collection of UI pages
- or a collection of integration notes

It is also an API-driven app-host service whose route families are one of the main ways the system actually works.

*Last reviewed: 2026-10-28 America/Chicago*
