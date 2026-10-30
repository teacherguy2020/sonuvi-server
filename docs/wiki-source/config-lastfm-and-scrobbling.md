# config lastfm and scrobbling

## Purpose

This page documents the Last.fm and scrobbling-related portions of `now-playing/config.html`.

## Current Sonuvi model

The former mpdscribble control card and hero scrobble controls have been
removed from the user-facing UI. Sonuvi now owns the centralized Last.fm
submission path for both MPD/moOde and non-MPD playback. The live deployment
uses `LASTFM_MPD_MODE=active`; `mpdscribble.service` is disabled and is not
part of the setup workflow.

The Config page has two intentionally separate Last.fm areas:

- **Sonuvi Last.fm scrobbling**: server-only Sonuvi API key, API secret, and
  one-time account authorization/session setup.
- **Last.fm (Vibe metadata)**: the existing Vibe API key, username, and row
  presentation settings in `now-playing.config.json`.

The Sonuvi secret and session key are stored only in the protected server
environment (`.env`). They must not be placed in browser storage, the Vibe
config JSON, logs, diagnostics, API responses, or Git.

It exists because the Config page contains two tightly related but distinct
clusters:
- Sonuvi Last.fm scrobbling authorization
- Last.fm / Vibe metadata configuration

These should be documented together because they are operationally connected, but they should not be collapsed into one indistinguishable feature.

## Why this page matters

This cluster is important because it connects:
- runtime scrobble generation
- Last.fm identity/configuration
- Vibe/discovery behavior
- homepage/row presentation choices
- service-control actions

That means the Config page here is simultaneously:
- a service-control console
- an integration setup surface
- a curation/discovery feature switchboard

## Important file

Primary file:
- `now-playing/config.html`

Related pages:
- `config-interface.md`
- `config-feature-breakdown.md`
- `integrations.md`
- future queue/vibe pages

## High-level model

A good current interpretation is:
- Sonuvi is the scrobble/runtime-service side
- Last.fm is the external account and discovery/integration side
- Vibe depends on its separate Last.fm metadata settings being configured
- playback clients report activity; the backend applies qualification,
  deduplication, local-history, and Last.fm policy

That distinction is one of the main points this page should preserve.

## 1. Sonuvi Last.fm scrobbling

Observed UI elements include:
- `sonuviLastfmApiKey`
- `sonuviLastfmApiSecret`
- `sonuviLastfmStatus`
- `sonuviLastfmSaveBtn`
- `sonuviLastfmAuthorizeBtn`
- `sonuviLastfmCompleteBtn`
- `sonuviLastfmRefreshBtn`

### Purpose and workflow
The Sonuvi card lets an operator configure and authorize the server-side
Last.fm application without exposing credentials to playback clients:

1. Enter the Sonuvi API key and API secret.
2. Choose **Save credentials**. This replaces the server-side Sonuvi values
   and clears any old session key so reauthorization is explicit.
3. Choose **Authorize Sonuvi** and approve the application in Last.fm.
4. Return to Config and choose **Complete authorization**.
5. Refresh the status and confirm the account is authorized.

The corresponding protected endpoints are:
- `GET /config/lastfm/status`
- `POST /config/lastfm/credentials`
- `POST /config/lastfm/authorize/start`
- `POST /config/lastfm/authorize/complete`

All four require the existing Track Key. Status responses contain only safe
configuration state, lengths, and short fingerprints; they never return a
secret, session key, token, or signature.

## 2. Last.fm / Vibe configuration

Observed UI elements include:
- `featureLastfm`
- `lastfmApiKey`
- `lastfmUsername`
- `lastfmRecentsReplaceRadio`
- `lastfmRecentsMode`

### Why this block matters
This is the Last.fm identity and behavior layer for the project.
It appears to affect:
- whether Last.fm-backed features are enabled
- what account/API identity is used
- whether Last.fm replaces the Favorite Radio row
- what flavor of Last.fm content is shown in that row
- whether Vibe tools are meaningfully available

### Config fields and semantics
Observed fields include:
- API key
- username
- replace-radio toggle
- row mode options:
  - `toptracks`
  - `recenttracks`
  - `topartists`
  - `topalbums`

This means the Config page is not just turning Last.fm on/off. It is also shaping how Last.fm-derived UI behavior presents.

### Important UI hints
The Config page explicitly notes:
- when enabled/configured, Vibe tools are available in Queue Wizard
- the Last.fm row relies on scrobble history
- mpdscribble is typical, but not the only possible scrobble source
- the API host needs certain Python dependencies for Vibe:
  - `python3-mpd`
  - `python3-requests`
  - `python3-mutagen`

### Endless Vibe

Endless Vibe is a Live Queue mode in the tablet controller that uses this same Last.fm/Vibe configuration. When enabled, it automatically extends playback whenever the currently playing local track becomes the final queue item. It first plans a 12-track final queue (the active seed plus local additions) using the V2 planner, then crops to the seed and applies that completed plan while preserving playback.

The mode is deliberately more resilient than a one-shot Vibe action: it plans before MPD mutation, suppresses duplicate refresh jobs, and retains the active seed if no usable local matches are found. If the seed ends during planning, the server resumes the newly extended queue. Its browser-local toggle is off by default and does not change the global Last.fm feature setting.

That makes this section both a feature setup surface and a documentation surface for prerequisites.

The native iPhone/iPad Endless Vibe toggle is intentionally separate from this
server setting. The device currently reuses the existing Track-Key-protected
seeded Vibe preview and canonical catalog resolution; it does not run `lastfm_vibe_radio.py`
or store Last.fm API/session credentials. This keeps the server as the shared
Last.fm/index authority while allowing the device queue and playback to remain
local.

### Vibe planner v2

On 2026-10-30, an isolated runtime trial validated a richer Vibe planner using
the existing protected `LASTFM_API_KEY`; no credentials were created, copied,
or exposed. It builds a local MPD metadata index, plans a small 12-entry queue
before mutation, and only then applies local matches. This source revision
uses that planner for normal Vibe and server-side Endless Vibe. Native-device
behavior remains unchanged.

## Save/load behavior

Observed Vibe config-load behavior includes:
- feature state from `c.features?.lastfm`
- API key from runtime/full config or local secret cache
- username from runtime/full config
- recents replace-radio toggle from full config
- recents mode from full config
- localStorage caching of Last.fm API key

Observed Vibe config-save behavior includes:
- `features.lastfm`
- `lastfm.apiKey`
- `lastfm.username`
- `lastfm.recentsReplaceRadio`
- `lastfm.recentsMode`

This shows a split between:
- top-level feature enablement
- nested Last.fm-specific config payload

## Secret handling

Sonuvi credentials are deliberately **not** cached in localStorage. The Vibe
API key remains part of the existing metadata configuration path; it is not
used as a fallback for Sonuvi authorization or scrobbling.

## Visibility / gating behavior

Observed code includes `syncLastfmCardVisibility()`.

Working interpretation:
- the Last.fm card is dynamically gated based on whether the feature is enabled and/or whether API-key state is present
- the UI is trying to help the operator distinguish between disabled, partially configured, and configured states

## Important relationships

## Sonuvi scrobbling versus Vibe metadata
These are related but not identical:

- Sonuvi scrobbling uses `LASTFM_API_KEY`, `LASTFM_API_SECRET`, and
  `LASTFM_SESSION_KEY` from the server environment.
- Vibe metadata uses the existing `lastfm.apiKey` and `lastfm.username` from
  `config/now-playing.config.json`.
- The two API keys must not be silently substituted for one another.
- mpdscribble is not part of the active setup or control workflow.

When something breaks, check the appropriate side:
- Is Sonuvi authorization complete and is `LASTFM_MPD_MODE` correct?
- Is the backend receiving qualified playback events?
- Are Vibe username/key and its host dependencies configured?

## Last.fm versus UI row behavior
`lastfmRecentsReplaceRadio` and `lastfmRecentsMode` show that Last.fm is not just a backend integration.
It directly affects what the user sees in certain UI rows.

So this is both:
- an integration setting
- a user-facing content-selection behavior

## Important endpoints / action surfaces

The Sonuvi setup endpoints are listed above. The legacy mpdscribble service
endpoints may remain for compatibility and diagnostics, but they are not
linked from the Config page and must not be used as the active scrobbling
workflow.

## User/operator workflow model

A useful current workflow model is:

### Sonuvi authorization workflow
1. enter the Sonuvi API key and secret
2. save the credentials
3. authorize Sonuvi in Last.fm
4. complete authorization in Config
5. confirm the authorized status

### Last.fm/Vibe setup workflow
1. enable Last.fm
2. enter API key and username
3. choose whether Last.fm replaces the Favorite Radio row
4. choose row mode
5. save config
6. verify Vibe behavior or homepage/row behavior afterward

### Troubleshooting workflow
1. verify Sonuvi authorization status and server environment values
2. verify the playback event appears in local history with its source and
   qualification state
3. verify the Last.fm submission state and Last.fm account history
4. verify Vibe's separate username/key and required Python dependencies
5. check whether row behavior matches the configured mode

## Architectural interpretation

A good current interpretation is:
- this config cluster bridges runtime service state and feature-layer discovery behavior
- it is both operational and user-facing in effect
- it is one of the stronger examples of Config mixing service control with product behavior configuration

## Relationship to other pages

This page should stay linked with:
- `config-interface.md`
- `config-feature-breakdown.md`
- `integrations.md`
- future queue/Vibe/scrobbling pages

## Things still to verify

Future deeper verification should clarify:
- how Vibe uses Last.fm data after config is saved
- whether mpdscribble is the default live scrobble source in Brian’s current setup or only a supported path
- what exact status payload the mpdscribble status endpoint returns
- which UI surfaces consume `lastfmRecentsReplaceRadio` and `lastfmRecentsMode` most directly

## Current status

At the moment, this page gives the Last.fm/scrobbling config cluster the right level of seriousness.

It is not just “put in an API key.”
It is:
- service control
- feature enablement
- discovery/Vibe setup
- row-behavior shaping
- prerequisite-aware integration config

*Last reviewed: 2026-10-30 America/Chicago*
