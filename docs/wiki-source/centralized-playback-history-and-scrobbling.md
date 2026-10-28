# Centralized playback history and scrobbling

## Phase-one architecture

Sonuvi receives playback observations from multiple sources and records
qualified plays in one local history:

```text
Implemented inputs: MPD observations + bearer native playback events
                         -> Server identity resolution and qualification
                         -> local history -> asynchronous Last.fm hook
Other source reporters: not implied by a display or playback feature existing
```

The event source is metadata on each play, not a separate statistics system.
Resolved catalog/source identity is distinct from the admin `TRACK_KEY`
credential; see [identifiers and credentials](glossary.md#identifiers-and-credentials).
Clients report activity; the Server decides qualification and deduplication.
Optional About enrichment is independent of this pipeline and does not fetch
history records on its behalf.

## Current source behavior

### MPD / moOde

moode-nowplaying-api.mjs polls MPD every five seconds. Local files that are
not streams, AirPlay, podcasts, or Alexa-mode playback enter the shared
history store as source "mpd".

MPD local history uses the existing conservative rule:

- the track must be at least 30 seconds long;
- the required played time is `max(30 seconds, min(50% of duration, 240
  seconds))`; and
- an unknown-duration track requires 240 seconds.

MPD Last.fm submission is now owned by Sonuvi in the live deployment.
`LASTFM_MPD_MODE=active` enables the backend hook, and `mpdscribble.service`
is disabled. The previous shadow mode and mpdscribble rollback path remain
documented below for safe recovery, but they are not the current production
state.

### iOS / CarPlay

The bearer-authenticated `POST /v1/mobile/playback/events` route accepts the
following implemented input contract (`src/routes/mobile.routes.mjs`):

| Field | Required / default | Meaning |
| --- | --- | --- |
| `trackId` | Required | Server-resolvable catalog ID, or supported opaque radio/podcast identity; never a client filesystem path or UPnP selection reference |
| `sessionId` | Required | At most 160 characters from letters, digits, `.`, `_`, `:`, `-`; stable across observations for one play, new for a distinct play |
| `state` | Recommended explicitly; omitted/empty defaults to `progress` | `start`, `playing`, `progress`, `pause`, `stop`, `ended` (normalized to lowercase) |
| `elapsedSec` | Optional; default zero | Nonnegative elapsed seconds, used for qualification |
| `durationSec` | Optional; catalog/source duration fallback | Duration seconds; unknown duration uses the longer qualification wait |
| `startedAtMs` | Optional; request-time default | Unix epoch **milliseconds**; finite positive input is clamped to the preceding seven days through current request time |

```json
{"trackId":"trk_opaque_example","sessionId":"device-play-001","state":"progress","elapsedSec":78,"durationSec":214,"startedAtMs":1793180000000}
```

Replace the illustrative ID/time with the actual Server-provided identity and
play start. **`startedAt` is not an alias.** The handler ignores that unknown
field and defaults the start time if `startedAtMs` is absent. Sending an ISO
string or epoch seconds under the wrong name is not a supported timestamp
contract. The [recorded iOS handoff](../ios/upnp-qobuz-integration-handoff.md#46-existing-bearer-mobile-routes)
already uses `startedAtMs`; do not infer the shipped client's serializer from
this Server-only verification.

The Server first resolves catalog identity, then supported `radio-...` and
`podcast-...` IDs through Server-owned station/episode data. Unresolved IDs
receive 404. The client cannot substitute its own `file` value. Observations
are stored as source `ios-device` and session identity `mobile:<sessionId>`;
clients never contact Last.fm directly.

An accepted `start` or `ended` event is not automatically a qualified play.
The shared duration/elapsed thresholds below still apply. Repeated progress,
pause/resume and ended observations retain the same session identity, yielding
at most one persisted local play and one hook attempt for that session.
The timestamp feeds history/Last.fm timing, while qualification uses elapsed
and duration; changing the timestamp alone does not qualify a play.

### Listen on Device and other sources

The current web repository does not contain a separate browser Listen on
Device playback reporter. The native mobile playback event route is the
existing supported non-MPD event path. Alexa, Seeburg, Multiphone, and Mills
playback are not silently attributed to this pipeline unless they explicitly
report a source event.

## Event record and diagnostics

The JSONL record contains the resolved playback metadata and state fields:

- trackKey
- source
- sessionId
- startedAtMs
- elapsedSec
- durationSec
- localPlayQualified
- lastfmEligible
- lastfmScrobbleState
- lastfmScrobbleError

History is stored on the Sonuvi host at:

- data/listening-history.jsonl
- data/listening-history.state.json

The files are runtime data and excluded from Git. Aggregation groups all
qualified sources by normalized artist/title or artist/album, while retaining
the original source on each event.

Track-key-authenticated GET /config/listening-history/events?limit=50 exposes
the recent persisted event records and their qualification/scrobble states for
diagnostics. It is intended for operator troubleshooting, not for playback
clients.

## Last.fm qualification and submission

For non-MPD sources, Sonuvi uses Last.fm's scrobble-style threshold:

- the track must be at least 30 seconds long;
- the required played time is `max(30 seconds, min(50% of duration, 240
  seconds))`; and
- if duration is unknown, 240 seconds of playback is required.

The backend submits track.scrobble asynchronously using server-side
LASTFM_API_KEY, LASTFM_API_SECRET, and LASTFM_SESSION_KEY values. A missing
configuration, timeout, or API failure is recorded as a state and cannot
delay or interrupt playback or local-history recording.

The Sonuvi API key, API secret, and session key are environment-only. The
Config page provides the protected credential and authorization workflow; the
CLI utility `scripts/lastfm-authorize.mjs` remains available for maintenance.
The Vibe API key and username stay in the existing config JSON and are not a
fallback for Sonuvi authentication. Sonuvi secrets and session keys never
appear in logs, diagnostics, API responses, browser storage, or Git.

Current production behavior:

- MPD: local history in Sonuvi and backend Last.fm submission.
- Non-MPD: local history in Sonuvi and backend Last.fm submission.
- mpdscribble: disabled; its files and configuration were not modified.

### MPD migration modes and rollback

The first MPD migration step is controlled by `LASTFM_MPD_MODE`, which
defaults to `shadow`. In shadow mode, qualifying MPD sessions use the shared
history qualification and deduplication path, resolve a canonical mobile
track ID when available, and record `lastfmScrobbleState`
`mpd-shadow-qualified`. Sonuvi does not submit those MPD sessions to Last.fm;
mpdscribble remains the sole MPD scrobbler.

`LASTFM_MPD_MODE=disabled` preserves the original mpdscribble-authoritative
diagnostic state without invoking the backend hook. `LASTFM_MPD_MODE=shadow`
allows qualification comparison without backend submission. The live system
uses `LASTFM_MPD_MODE=active` only while mpdscribble is disabled, after the
shadow comparison and duplicate-submission validation were completed.

The migration has been completed after non-MPD submission, shadow comparison,
and duplicate-submission validation. If rollback is required, stop or disable
Sonuvi MPD submission before re-enabling mpdscribble.

Qobuz Connect is intentionally excluded from this history path while PiBuZ
owns the renderer. UPnP Sonuvi playback suppresses the duplicate MPD-history
observation and records only through an explicit supported source event when
one exists. A remote source must not be attributed to MPD merely because the
renderer exposes an MPD-compatible transport.

## Canonical identity and unresolved events

Mobile events must resolve their identity against the Server catalog or the
supported Server-owned radio/podcast resolvers. Unknown IDs are rejected
rather than creating a client-invented identity. MPD events retain their
MPD file identity and use a canonical mobile track ID when available; they do
not invent another credential or identity when catalog mapping is unavailable.

## Reliability and deduplication

History is appended before the asynchronous Last.fm hook runs. The event
session ID is persisted, and status updates rewrite the event file atomically.
This means Last.fm failure cannot prevent local history. Repeated event
delivery finds the existing session and does not append or submit again.

## Future migration

The MPD migration has now been exercised in production. Retain the rollback
path and continue verifying that MPD, iOS, CarPlay, and other sources each
produce one local play and at most one Last.fm scrobble. If a rollback is ever
needed, stop Sonuvi MPD submission before re-enabling mpdscribble to avoid
double submissions.

*Last reviewed: 2026-10-28 America/Chicago*
