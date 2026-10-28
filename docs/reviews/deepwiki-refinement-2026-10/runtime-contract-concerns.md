# Playback-event runtime contract investigation

Review date: 2026-10-28. Server baseline: `4bf8889a767e167f50566ec4e193d4b625c2c1f2`.

## Conclusion

**Confirmed documentation defect; no demonstrated shipped-client interoperability defect.**
The Server handler and the existing Server-owned iOS payload contract agree on
`startedAtMs`. The old canonical history prose incorrectly named `startedAt`.
The currently shipped iOS serializer/payload was not independently inspected:
the iOS repository was out of scope, and no captured native request was
available during this review. Do not promote contract agreement into a claim
of end-to-end runtime verification.

## Evidence checked before canonical edits

- `src/routes/mobile.routes.mjs:4857–4936`: `trackId` and valid `sessionId`
  required; `state` defaults to `progress`; accepted states are start, playing,
  progress, pause, stop and ended. The route reads `Number(body.startedAtMs)`.
- `docs/ios/upnp-qobuz-integration-handoff.md`, existing bearer-route table:
  payload already specifies `startedAtMs?` before this refinement.
- `test/mobile-api.test.mjs`, native playback event case: supplies `startedAtMs`
  and checks canonical identity/history routing; it is not a captured iOS payload.
- `src/lib/listening-history.mjs`: retains the start timestamp when establishing
  the active observation, qualifies by elapsed/duration, and deduplicates by
  persisted session ID.
- `src/lib/lastfm-scrobbler.mjs`: converts stored start milliseconds to seconds
  for the external submission timestamp.

## Executable behavior probe

The [probe](timestamp-contract-probe.mjs) invokes the actual Server route with
mock catalog/history dependencies, a fictional local test bearer, no listener,
no live network and no persistent playback state. [Results](timestamp-contract-results.json):

| Request case | Observed behavior |
| --- | --- |
| `startedAtMs` with a valid past millisecond timestamp | Exact timestamp preserved |
| Only `startedAt` | HTTP 200, field ignored; request time used |
| Omitted state and timestamp | `progress` and request time used |
| Future timestamp | Clamped to request time |
| Timestamp older than seven days | Clamped to seven-day boundary |

All five assertions passed. No production code or iOS code was changed.

## Remaining runtime concern, separate from documentation correction

If an actual native client sends only `startedAt`, Server does not reject it:
it silently uses request time. This would distort the recorded/Last.fm start
instant (especially if the first report arrives late), while duration/elapsed
qualification and canonical identity resolution follow their existing rules.
The route also accepts numeric conversion of `startedAtMs`; epoch seconds
mistakenly supplied in that field would be clamped rather than interpreted as
seconds. Clients should send epoch milliseconds explicitly.

This is a **conditional interoperability risk**, not evidence that the current
client does it. A redacted current request or a separately authorized native
serializer review is the remaining end-to-end check. No compatibility alias,
stricter validation, production patch or iOS task is silently included in this
documentation change set.

Last reviewed: 2026-10-28 America/Chicago.
