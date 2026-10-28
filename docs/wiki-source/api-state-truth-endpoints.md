---
title: api-state-truth-endpoints
page_type: child
topics:
  - api
  - playback
  - queue
  - runtime
confidence: high
---

# api state truth endpoints

## Purpose

This page documents the most important state/truth endpoints in the `now-playing` app-host API.

It exists because some endpoints matter far more than a simple inventory entry suggests, especially:
- `/now-playing`
- `/next-up`
- Alexa now-playing aliases
- nearby state surfaces such as `/track`

These are not just random routes.
They are some of the system’s central truth surfaces.

## Why this page matters

A lot of visible system behavior depends on these endpoints.
They are where:
- playback-mode-aware truth gets translated into a user-visible payload
- queue head / next-up state gets normalized
- fallback behavior becomes presentation truth when stronger truth is unavailable
- controller/display surfaces pull their most important visible state

That means these routes deserve stronger treatment than a one-line catalog mention.

## Primary owner

The strongest current owner for the core now-playing state surfaces is:
- `now-playing/moode-nowplaying-api.mjs`

Related supporting owners include:
- `src/routes/track.routes.mjs`
- nearby playback/queue/control route files

## Endpoint: `GET /now-playing`

### Why it is important
This is one of the most important visible-state endpoints in the system.

A good current interpretation is:
- `/now-playing` is not a trivial pass-through
- it is a mode-aware, fallback-aware presentation endpoint
- it often acts as the final visible truth consumed by controller/display surfaces

### Strong current evidence from source
Direct source inspection shows:
- a `debug=1` mode
- stale/last-good behavior through `serveCached(...)`
- response preservation using `lastNowPlayingOk` and `lastNowPlayingTs`
- 503 fallback if no last-good payload exists
- heavy mode/metadata interpretation logic in the route body itself
- radio-specific parsing and guardrails inside the handler

### Important practical behaviors
Source evidence shows that `/now-playing` includes or implies:
- last-good response preservation
- stale-response behavior with `_stale` / `_staleAgeMs`
- mode-sensitive metadata interpretation
- radio-specific cleanup and lookup-guard logic
- more than one truth path being normalized into one payload

### What not to assume
Do **not** assume:
- `/now-playing` is just raw MPD state
- stale-looking output automatically means a bug
- radio-mode output should behave like local-file mode output
- visible truth from `/now-playing` is mode-agnostic

### Best companion pages
- `playback-authority-by-mode.md`
- `queue-and-playback-model.md`
- `fragile-behavior-ownership.md`
- `api-endpoint-catalog.md`

## Endpoint: `GET /next-up`

### Why it is important
`/next-up` is the nearest companion to `/now-playing` for queue-head truth.
It is one of the clearest user-visible next-item endpoints.

### Strong current evidence from source
Direct source inspection shows:
- `debug=1` mode
- local moOde/MPD-backed lookup flow
- special handling for AirPlay
- `nextsong` / `nextsongid` interpretation from moOde status
- fallback to MPD playlist lookup by position or id
- stream/YouTube-specific interpretation of the upcoming item
- art selection logic that differs for file versus stream targets

### Important practical behaviors
Source evidence shows:
- AirPlay may intentionally return `next: null`
- invalid or absent nextsong state may intentionally return `next: null`
- stream and YouTube next-up items are interpreted differently from local files
- art URL selection depends on whether the next item is a file or stream

### What not to assume
Do **not** assume:
- `/next-up` always has a next item
- AirPlay should behave like local queue playback here
- the upcoming item’s art/title/artist are always plain MPD file metadata

### Best companion pages
- `queue-and-playback-model.md`
- `playback-authority-by-mode.md`
- `controller-queue-interface.md`
- `api-endpoint-catalog.md`

## Endpoint: `GET /alexa/now-playing`

### Why it is important
This is a semantic alias/helper route for Alexa-specific visible state.

### Strong current evidence from source
Direct source inspection shows:
- age/freshness handling with `maxAgeMs`
- response fields including `fresh` and `ageMs`
- a `nowPlaying`-like payload derived from remembered Alexa state
- `alexaMode: true`
- state derived from the in-memory `alexaWasPlaying` object

### Current interpretation
A good current interpretation is:
- `/alexa/now-playing` is not the same as the normal `/now-playing` path
- it is an Alexa-memory/helper truth surface used for voice-mode continuity

## Endpoint: `GET /alexa/next-up`

### Why it is important
This endpoint clarifies one subtle truth decision.

### Strong current evidence from source
Direct source inspection shows:
- `/alexa/next-up` returns a `307` redirect to `/now-playing`

### Current interpretation
That means Alexa “next up” is intentionally aliased to the broader visible now-playing semantics, not implemented as a separate complex route.

## Endpoint: `GET /track`

### Why it is important
`/track` is a more focused track-level state/data surface.
It matters, but it is not the same thing as `/now-playing`.

### Current interpretation
A good current interpretation is:
- `/track` is closer to track-specific lookup/data retrieval
- `/now-playing` is closer to mode-aware user-visible presentation truth

That distinction should stay explicit.

## Audio Info is evidence, not playback authority

Open [Audio Info](diagnostics-interface.md#audio-info-entry-points-and-presentation)
through the appropriate client entry: the dedicated native iOS screen or the
Server web tablet Audio info action. The [diagnostics contract](diagnostics-interface.md#audio-info-diagnostics-contract)
separates source, decoded PCM, configured chain, measured ALSA, processing,
freshness and conversion uncertainty. It does not replace source ownership or
prove bit-perfect playback from endpoint format alone.

## Core distinctions to preserve

### `/now-playing` vs `/track`
- `/now-playing` = richer visible-state presentation truth
- `/track` = track-level data surface

### `/now-playing` vs `/next-up`
- `/now-playing` = current visible now-playing truth
- `/next-up` = upcoming item truth, with mode-specific null/fallback behavior

### Alexa helper routes vs normal playback routes
- Alexa helpers preserve voice-mode continuity/state memory
- they are not just synonyms for every normal playback route

## Suggested starting paths by question

### If the visible current song/art/status looks wrong
Start with:
1. `api-state-truth-endpoints.md`
2. `playback-authority-by-mode.md`
3. `fragile-behavior-ownership.md`

### If next-up behavior looks wrong
Start with:
1. `api-state-truth-endpoints.md`
2. `queue-and-playback-model.md`
3. `controller-queue-interface.md`

### If Alexa-visible state looks wrong
Start with:
1. `api-state-truth-endpoints.md`
2. `alexa-interface.md`
3. `playback-authority-by-mode.md`

## Relationship to existing API pages

This page should stay linked with:
- `api-service-overview.md`
- `api-endpoint-catalog.md`
- `api-playback-and-queue-endpoints.md`
- `queue-and-playback-model.md`
- `playback-authority-by-mode.md`

## Current status

At the moment, this page makes the most important state/truth endpoints more explicit.

That should help future agents avoid treating `/now-playing` as just another route in the list when it is really one of the project’s central presentation-truth surfaces.

*Last reviewed: 2026-10-28 America/Chicago*
