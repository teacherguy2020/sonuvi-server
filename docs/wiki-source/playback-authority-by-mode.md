---
title: playback-authority-by-mode
page_type: companion
topics:
  - playback
  - runtime
  - integration
  - api
confidence: high
---

# playback authority by mode

## Purpose

This page documents how playback truth changes depending on the active playback mode.

This is one of the most important operational truths in the project:
there is not one universal source of truth for:
- current song
- current art
- current status
- what should be shown to the user

The authority path depends on the active playback mode.

## Why this page matters

A lot of debugging confusion comes from asking the wrong first question.

The right first question is often not:
- what page is wrong?
- what route is wrong?

It is:
- **what playback mode are we in?**

Once that is known, the likely authority path narrows dramatically.

## Core model

Playback authority is mode-dependent.

The strong current model is:
- MPD remains important, but it is not the only truth source that matters for visible behavior
- art and current-song interpretation differ by mode even when transport still exists underneath
- app-host routes often translate multiple underlying truths into one visible result
- visible truth is frequently interpreted, normalized, or guarded rather than passed through raw

This page is the companion to `queue-and-playback-model.md`.

## Alexa request origin versus playback target

Alexa is a request origin, not necessarily the playback authority. Requests
using the leading `in the theater` routing phrase or trailing `locally` target
moOde/MPD and use
normal queue semantics:

- `requestOrigin: alexa`
- `playbackTarget: moode`
- `playbackMode: normal`

Only Echo-targeted Alexa playback should use Alexa remembered-track state,
synthetic queue handling, or Alexa-specific display treatment.

## Qobuz Connect authority overlay

Qobuz Connect is a distinct remote playback owner, not an alternate MPD
metadata label. The current Server contract normalizes PiBuZ state as
`source: "qobuz-connect"`, `owner: "pibuz"`, and `output: "moode"`. A session
being available or connected is not sufficient to call it active: transport
control requires a fresh snapshot with confirmed-active ownership, an active
receiver, and no stale state.

The guarded bearer routes are:

- `GET /v1/mobile/qobuz-connect` and `/queue` for the snapshot and ordered
  remote queue;
- `POST /v1/mobile/qobuz-connect/{play,resume,pause,next,previous,seek}` and
  `/queue/jump` for the supported transport operations; and
- `POST /v1/mobile/qobuz-connect/release` for the explicit handoff back to
  Home moOde.

Controls use current-track and opaque queue-fingerprint compare-and-swap
fields where applicable, then perform read-after-write verification. The
Server does not expose Qobuz credentials or claim to provide Qobuz catalog
authentication. A Home queue mutation must release and confirm Qobuz
ownership inactive before it starts competing MPD playback.

## Release and handoff are explicit transitions

| Current owner → intended target | Required behavior | Confirmation / conflict handling |
| --- | --- | --- |
| Home MPD → Home MPD | Use the applicable web or bearer Home contract | Read returned state; a UI optimistic hold is not command confirmation |
| Qobuz Connect → Home MPD | Explicit `POST /v1/mobile/qobuz-connect/release` before a Home action | Wait for confirmed release; receiver recovery/readiness is a separate result. Do not treat connected/available as fresh active ownership |
| Qobuz Connect → Qobuz control | Use fresh Connect snapshot and applicable current-track/queue-fingerprint guards | Read-after-write verification; refresh on conflict instead of replaying stale queue intent |
| MPD/other renderer owner → Sonuvi UPnP | Read preflight, then use the explicit confirmed takeover contract when permitted | Validate queue revision/session generation; Qobuz ownership is not silently taken over |
| Sonuvi UPnP → Home MPD | End the owned UPnP session through its contract before Home mutation | Refresh authoritative state; Home control reports `409 HOME_PLAYBACK_OWNERSHIP_CONFLICT` with source `upnp-sonuvi` while owned |
| Home → This iPhone/iPad | Select native-device playback and its device queue | Server media authorization/metadata/history do not transfer device playback authority to MPD |

For Qobuz-owned Home conflicts the same `409` code has source
`qobuz-connect`. A failed observation is not evidence of release. UPnP startup
uses bounded renderer URI/transport-readiness probes and session-generation
checks; stale observations cannot establish ownership for a newer session.
Probe fallbacks and duplicate-Play handling are implementation-specific, not
an unconditional guarantee that every renderer reports readiness.

See [Qobuz lifecycle and recovery](../runbooks/28-qobuz-connect-now-playing.md),
[UPnP session/queue contract](upnp-control-point.md), and
[current native controls](mobile-now-playing.md#home-transport-controls).
Working PiBuZ Connect control is separate from the upmpdcli Qobuz MediaServer
proof-of-concept; source discovery does not establish provider authentication.

## Mode 1: local file playback

## Authority model
Local file playback is the clearest case where MPD truth and local library/file truth align most directly.

Current-song and playback state are strongly grounded in MPD/local-file playback reality.
Art authority often resolves through moOde/local-file cover-art paths such as:
- moOde `coverart.php`
- local/current-art cache-backed fallbacks where relevant

## What that means practically
When the active mode is local file playback, first verify:
- MPD current song / queue state
- local file metadata identity
- local/moOde art resolution for that file/album

## Common failure shapes
- wrong or stale album art due to art caching/fallback behavior
- queue/current-song disagreement if app-side state lags behind underlying playback truth
- metadata quirks that still originate from file/library truth rather than stream heuristics

## Mode 2: AirPlay

## Authority model
AirPlay playback does not behave like plain local-file playback.

AirPlay metadata and art are strongly influenced by the AirPlay metadata path.
Current visible art/status often depends on:
- `aplmeta.txt`
- AirPlay-specific cover/metadata readers
- moOde current-song/status paths as interpreted for AirPlay

## What that means practically
When the active mode is AirPlay, first verify:
- whether AirPlay metadata is being produced/updated correctly
- whether the AirPlay metadata reader path is healthy
- whether art is coming from AirPlay metadata rather than file-library truth

## Common failure shapes
- missing or stale art because the AirPlay metadata path is unhealthy
- CPU/pathological reader behavior in AirPlay metadata tooling
- confusion caused by expecting local-file art rules to apply

## Important local-environment note
Current local-environment knowledge already shows that the AirPlay metadata path has local hardening/override behavior around `airplay-json`, watchdogs, and metadata readers.

So AirPlay is one of the strongest cases where Brian’s local runtime reality matters.

## Mode 3: UPnP

## Authority model
UPnP is its own branch, not a generic stream case.

Visible truth can combine:
- moOde current-song/status
- UPnP-specific resolution logic
- attempts to resolve apparently stream-like items back toward local-file cover/art truth when possible

## What that means practically
When the active mode is UPnP, first verify:
- moOde current-song/status for the active UPnP item
- whether the system is resolving the item back to a known local-file/library identity
- whether art is coming from UPnP item metadata versus a recovered local-file truth path

For playback authority, the current UPnP implementation adds a stricter
boundary: Sonuvi owns the logical queue and playback session, while the
selected renderer executes transport. The renderer's MPD queue is an
implementation detail. Queue mutations require the current revision, and
transport is bound to the renderer/session generation. A normal session will
not silently take over active MPD, Qobuz, or uncertain renderer playback;
explicit takeover requires confirmation and the current generation.

## Common failure shapes
- art not matching what a user expects because the resolution path did or did not successfully map back to local-file truth
- wrong assumptions caused by treating UPnP like simple radio/stream behavior
- mixed metadata/art results where more than one authority path is in play

## Mode 4: radio / stream

## Authority model
Radio/stream is one of the most nuanced authority paths in the project.

Raw stream metadata is often not trusted directly as final truth.
Visible output can be shaped by a chain including:
- station holdback policy
- metadata cleanup/normalization
- enrichment lookup attempts
- lookup guardrails/suppression
- station-logo fallback
- cache-backed or current-art fallback paths

## What that means practically
When the active mode is radio/stream, first verify:
- raw station metadata quality
- whether metadata holdback is intentionally delaying updates
- whether enrichment is being suppressed intentionally
- whether station-logo or fallback art is expected
- whether the final visible result is a deliberate fallback rather than a bug

## Common failure shapes
- users thinking missing enrichment is a bug when the system intentionally suppressed weak metadata
- users thinking delayed updates are a bug when holdback logic is active
- bogus album/year/link output from aggressive enrichment attempts if guardrails fail
- art confusion where station logo is correct but expected album art never had enough confidence to appear

## Important principle
Radio/stream behavior is not “whatever raw metadata says.”
It is an interpreted mode with its own quality-control logic.

## Mode 5: unresolved / fallback-driven case

## Authority model
Sometimes the system cannot confidently resolve a better authority path.

In those cases:
- fallback behavior becomes authoritative enough for presentation
- cache-backed current-art paths such as `/art/current.jpg` become the practical visible truth
- the system may preserve a last-known-good result rather than aggressively clearing the UI

## What that means practically
When the system is in an unresolved or degraded state, verify:
- whether last-good-render preservation is intentionally active
- whether fallback art is expected
- whether the current result is a degraded-but-correct presentation rather than a totally wrong one

## Common failure shapes
- assuming stale render means broken refresh when it may mean last-good preservation
- assuming fallback art means wrong route selection when it may mean insufficient confidence for richer truth

## Cross-mode principles

Several principles apply across all modes.

## 1. Do not assume one universal authority
There is no single always-correct answer like:
- MPD is always the truth
- the current page API response is always the truth

The correct answer depends on mode.

## 2. Visible truth is often app-mediated
What the user sees is often the result of:
- underlying playback state
- route-side interpretation
- metadata cleanup/enrichment/fallback logic
- display-side last-good or cache behavior

## 3. Art authority is especially mode-sensitive
Album art is one of the easiest places to get confused because:
- local file playback wants local file/art truth
- AirPlay wants AirPlay metadata truth
- UPnP may try to resolve back to file truth
- radio/stream may prefer station logos or guarded enrichment
- unresolved cases may rely on cache or fallback art

## 4. Troubleshooting should start with mode classification
Before opening random files, first classify the active mode.
That narrows the likely authority path dramatically.

## Suggested troubleshooting order by mode

### If local file
Check:
- MPD current song / queue
- local file/library identity
- moOde/local-file cover-art path

### If AirPlay
Check:
- AirPlay metadata path health
- `aplmeta.txt` / reader path
- AirPlay cover/metadata pipeline
- local overrides/watchdog behavior if relevant

### If UPnP
Check:
- moOde current-song/status
- UPnP-specific resolution logic
- whether fallback to local-file truth is expected/succeeding

### If Qobuz Connect
Check:
- the normalized snapshot's `ownershipState`, `receiverActive`, and `stale` fields
- whether the requested control was allowed by the fresh-active guard
- whether a Home action first completed the explicit release/handoff

### If radio/stream
Check:
- raw metadata quality
- holdback logic
- cleanup/normalization
- enrichment guardrails
- station-logo/fallback art path

### If unresolved/fallback-driven
Check:
- last-good-render preservation
- cache-backed art behavior
- whether degraded-but-stable output is expected

## Relationship to other pages

This page should stay linked with:
- `queue-and-playback-model.md`
- `playback-mode-troubleshooting.md`
- `api-playback-and-queue-endpoints.md`
- `api-state-truth-endpoints.md`
- `integrations.md`
- `gotchas-and-lessons.md`
- `local-environment.md`


## Current status

This page now gives the wiki one of the project’s most important operating rules:
- playback truth is mode-dependent
- art truth is mode-dependent
- visible output is often interpreted rather than raw
- debugging should begin with mode classification, not random file searching

*Last reviewed: 2026-10-28 America/Chicago*
