# radio metadata eval interface

## Purpose

This page documents `now-playing/radio-eval.html`, the radio metadata evaluation console in the `now-playing` ecosystem.

This page exists because `radio-eval.html` is not a listener-facing playback UI. It is an operator/developer inspection surface for evaluating how radio stream metadata is being parsed, enriched, and judged.

Important historical note:
- this page was also created as a live debugging surface at `http://10.0.0.4:8101/radio-eval.html`
- its practical purpose was to track Apple-enrichment success and failure during radio listening, using radio station metadata as the enrichment input

It is best understood as a diagnostics-oriented quality-evaluation tool for the radio metadata pipeline.

Current important field expectation:
- the table should show the exact raw full metadata string emitted by the station, not only split artist/title/album fields
- in current practice, that raw full value may come from the same original station metadata string currently represented in the raw title field, so the UI should prefer the exact original raw string instead of leaving `Full` blank
- for classical/WFMT-style metadata, false-positive iTunes matches should be treated conservatively; if the matched work title does not meaningfully overlap the original raw station string, the match should be rejected rather than labeled `GOOD`
- this conservative classical-title rejection logic is now landed in `now-playing/moode-nowplaying-api.mjs`, pushed to GitHub `main`, and deployed on `10.0.0.4`
- ordinary non-classical metadata now tries the Server's authenticated Apple
  Music Catalog Search authority before the public iTunes Search fallback.
  Catalog results must pass strict artist/title matching; concurrent snapshots
  share one lookup, and rate limiting honors the provider's bounded retry
  window. The evaluation reason `ok:catalog-search` denotes that path.

## Why this page matters

Radio metadata is one of the most fragile parts of the broader `now-playing` system.

It sits at the boundary between:
- raw stream metadata
- parsed artist/title/album values
- enrichment/lookup attempts
- final display-quality outcomes

That makes `radio-eval.html` important because it exposes the intermediate states, not just the final now-playing result.

It gives operators a way to inspect whether radio metadata handling is:
- good enough
- partially usable
- clearly broken or misleading

## Important file

Primary file:
- `now-playing/radio-eval.html`

Related pages:
- `diagnostics-interface.md`
- `integrations.md`
- `playback-mode-troubleshooting.md`
- future radio/stream metadata pages

## High-level role

A good current interpretation is:
- `radio-eval.html` is a diagnostics/evaluation console for radio metadata quality
- it is aimed at inspecting parsing and enrichment results across recent radio log entries
- it helps assess how well the system is turning raw radio metadata into something display-worthy

## Major visible UI areas

Repo-visible structure shows a compact diagnostics layout with:
- API base field
- limit field
- refresh button
- clear-log button
- auto-refresh toggle
- status text
- tabular results area

This is clearly a live inspection console rather than a user-facing polished surface.

## Core controls

Observed controls include:
- `#apiBase`
- `#limit`
- `#refresh`
- `#clear`
- `#auto`
- `#status`
- `#rows`

These controls support both one-shot inspection and repeated live monitoring.

## Important functions / logic blocks

## `defaultApiBase()`
This function determines what API host to use by default.

Observed behavior includes:
- if current page is being served on port `8101`, default API base becomes `:3101`
- otherwise it uses the current host/origin

This reflects the familiar split between display-host/browser-served surfaces and app-host API surfaces.

## `load()`
This is the main data-loading function.

Observed behavior includes:
- read `limit`
- resolve API base
- fetch:
  - `GET /debug/radio-metadata-log?limit=<n>`
- parse returned rows
- reverse them for display
- render each row into the evaluation table
- update status with loaded count

This is the core inspection workflow.

## `verdict(r)`
This is one of the most important functions in the page.

It assigns a client-side quality verdict to each row.

Observed logic includes:
- treat entries as `GOOD` when:
  - an iTunes URL/trackUrl/albumUrl exists, or
  - the reason starts with `ok:`
- treat entries as `PARTIAL` when:
  - the reason suggests insufficient metadata, or
  - the reason includes `skip:`, or
  - parsed and raw titles are close enough to suggest partial success
- otherwise classify as `BAD`

This is a key clue that the page is meant for evaluating metadata quality heuristically, not just displaying raw logs.

## `clear` action
Observed behavior includes:
- POST to:
  - `/debug/radio-metadata-log/clear`
- expect `{ ok: true }`-style success
- reload table after clearing

This makes the page useful for repeated evaluation sessions where an operator wants to reset the sample set.

## `auto` action
Observed behavior includes:
- toggles a 5-second polling interval
- repeatedly calls `load()`
- updates button text between:
  - `Auto: Off`
  - `Auto: On (5s)`

This makes the page useful as a live-watch console while testing radio streams or metadata logic.

## What each row shows

Each rendered row includes:
- sequence/index number
- ISO time
- timestamp
- station name
- stream URL
- raw metadata fields
  - artist
  - title
  - album
- parsed metadata fields
  - artist
  - title
  - album
  - performers
- lookup/enrichment info
  - lookup term
  - reason
- final verdict/result
  - GOOD / PARTIAL / BAD
  - plus any resolved URL

That row structure is extremely valuable because it makes the transformation pipeline visible:
- raw input
- parsed interpretation
- lookup attempt
- final quality judgment

## Important API calls

Based on current inspection, the main endpoints are:
- `GET /debug/radio-metadata-log?limit=<n>`
- `POST /debug/radio-metadata-log/clear`

These appear to be diagnostics/debug endpoints rather than normal end-user app routes.

## Relationship to radio/stream handling

This page should be understood as part of the radio/stream quality branch of the project.

It is especially relevant because radio metadata handling is known to be nuanced.
The broader system already has guardrails and fallback logic around:
- weak or misleading metadata
- strict station holdback behavior
- enrichment suppression when confidence is low
- station-logo fallback behavior
- stream-specific parsing differences

`radio-eval.html` appears to be one of the concrete tools for inspecting whether those decisions are working well in practice.

## User/operator workflow model

A useful current workflow model is:

### Review workflow
1. open `radio-eval.html`
2. choose API base if needed
3. set row limit
4. refresh
5. inspect row-by-row verdicts and reasons

### Testing workflow
1. clear log
2. trigger or wait for fresh radio metadata events
3. enable auto-refresh if needed
4. inspect whether parsing and lookup behavior improved or regressed

This makes the page especially useful during stream-specific debugging and metadata-rule tuning.

## Architectural interpretation

A good current interpretation is:
- `radio-eval.html` is a debug/QA console for radio metadata transformation quality
- it is not the radio playback UI itself
- it sits closer to diagnostics and integration inspection than to normal listener control surfaces

That makes it a high-value operator page even though it is visually simple.

## Relationship to other pages

This page should stay linked with:
- `diagnostics-interface.md`
- `integrations.md`
- `playback-mode-troubleshooting.md`
- future radio/stream metadata pages
- future enrichment/lookup documentation

## Things still to verify

Future deeper verification should clarify:
- where the backing `/debug/radio-metadata-log` rows are produced in app code
- whether the Catalog-first / iTunes-fallback balance needs station-specific
  tuning beyond the existing conservative classical controls
- how closely the client-side `GOOD/PARTIAL/BAD` verdict aligns with operator expectations in practice
- whether the page is used regularly during live metadata tuning or mainly as an occasional debug aid

## Current status

At the moment, this page already provides a clear view of `radio-eval.html` as a diagnostics/evaluation surface.

That is the right framing for now:
- it exposes the radio metadata pipeline
- it reveals parsing versus lookup outcomes
- it helps judge whether radio metadata is usable, questionable, or broken
- it preserves the original operational purpose of checking iTunes lookup success/problems during live radio listening

The evaluation rows now also record the shared server contract context:
profile, classification, confidence, reason codes, and the conservative
lookup decision. This makes station-specific parsing, suppression, and
holdback decisions inspectable without requiring the evaluator to reconstruct
them from the final artwork or provider URL.

## Timestamp

Last updated: 2026-10-31 America/Chicago
