# api config and runtime endpoints

## Purpose

This page documents the config- and runtime-oriented endpoint families exposed by the app-host API service.

It exists because the wiki now has strong config-surface coverage, but the actual API routes behind those surfaces are still distributed across feature pages.

This page consolidates those config/runtime endpoint families into one API-centered view.

## Why this page matters

These endpoints are some of the most operationally important routes in the system.
They are the routes that:
- load and save runtime config
- verify host/runtime assumptions
- repair environment issues
- check Alexa provisioning state
- maintain the ratings persistence layer
- control runtime-adjacent services
- inspect moOde browser-target state

This is a large part of the app’s control plane.

## Auth / protection model

Many administrative handlers require `x-track-key`, but authentication is
**method-specific**, not guaranteed by the `/config` prefix.
`GET /config/runtime` is an unguarded legacy browser bootstrap and returns
configuration, including the full stored config. `POST /config/runtime` and
`POST /config/runtime/check-env` require the Track Key. Treat bootstrap and
configuration reads as part of the trusted deployment boundary, not as proof
that secrets are safe behind universal route middleware.

Native clients use the mobile bearer contracts and must not bootstrap by
fetching this admin configuration. See the [method-level authentication map](api-service-overview.md#method-level-boundaries-not-one-prefix-wide-policy).
The environment-check route is **`POST /config/runtime/check-env`**;
`/config/runtime/check` is not an alias. This connectivity/path check is not a
universal playback or audio-quality health verdict.

## Route family overview

## 1. Runtime config load/save

The foundational route family is centered on:
- `/config/runtime`

### Observed usage
Across Config and related pages, this route is used to:
- load current runtime config
- save structured config changes
- save full raw config via the advanced JSON editor
- load feature-specific data such as:
  - track key
  - Alexa config
  - notification config
  - Last.fm config
  - path/runtime config

### Common patterns
Observed request shapes include:
- config save payloads shaped like:
  - `{ config: { ... } }`
- full-config save payloads shaped like:
  - `{ fullConfig: full }`

### Why it matters
This is the main config state authority exposed to the UI.

## 2. Runtime environment verification

This family is centered on:
- `POST /config/runtime/check-env`

### Observed purpose
Used by the Network & Runtime card to validate:
- MPD connectivity
- SSH connectivity to moOde
- path existence/health

### Observed input shape
Current wiki work shows request payloads shaped like:
- `{ mpdHost, mpdPort, sshHost, sshUser, paths }`

### Observed output role
The response appears to contain or imply values like:
- `sshOk`
- `mpdOk`
- path-check results

These are used to drive:
- lights/pills
- runtime readiness
- feature-gating behavior

### Why it matters
This is one of the key operational verification routes in the project.

## 3. Runtime repair: podcast-root creation

This family includes:
- `POST /config/runtime/ensure-podcast-root`

### Observed purpose
Used when Podcasts is enabled but the expected podcast root is missing.

### Observed input shape
Current wiki work shows request payloads including:
- `sshHost`
- `sshUser`
- `podcastRoot`

### Why it matters
This is a repair/action route, not just inspection.
It shows the runtime family owns environment-fix actions as well as verification.

## 4. Alexa provisioning check

This family includes:
- `POST /config/alexa/check-domain`

### Observed purpose
Used by the Config Alexa setup card to verify whether the configured public domain is reachable.

### Observed input shape
Current wiki work shows payloads shaped like:
- `{ domain }`

### Observed behavior
The route is used to report:
- reachable vs not reachable
- status-code-aware results
- health-state updates for Alexa pill/light UI

### Why it matters
This is the clearest Alexa setup verification route currently documented.

## 5. Ratings maintenance family

This family includes:
- `GET /config/ratings/sticker-status`
- `GET /config/ratings/sticker-backups`
- `POST /config/ratings/sticker-backup`
- `POST /config/ratings/sticker-restore`

### Observed purpose
These routes support:
- sticker DB existence/status checking
- backup inventory listing
- backup creation
- destructive restore from selected backup

### Why it matters
This is one of the clearest examples of the config/runtime API family acting as an operational maintenance subsystem.

## 6. Service-control family

Current documented example includes mpdscribble routes:
- `GET /config/services/mpdscribble/status`
- `POST /config/services/mpdscribble/action`

### Observed purpose
These routes support:
- status refresh
- explicit start/stop actions

### Why it matters
This family shows that the config/runtime API does not only save settings. It also controls live services.

## 7. moOde browser-target / display-control family

Current documented example includes:
- `GET /config/moode/browser-url/status`

### Observed purpose
Used to verify whether the moOde browser target URL is pointed at the expected now-playing display URL.

### Why it matters
This connects Config directly to live moOde display-routing state.

## 8. Podcast automation family that overlaps config/runtime use

Current documented routes include:
- `GET /podcasts/nightly-status`
- `POST /podcasts/nightly-run`

### Why it belongs near this page
These are not under `/config/`, but current wiki work shows they are part of the operational config story around podcast automation and cron setup.

So they belong near this family even if they are not inside the same path prefix.

## Relationship between these endpoint groups

A good current interpretation is:
- `/config/runtime` is the config state authority
- `/config/runtime/check-env` and `/config/runtime/ensure-podcast-root` are environment verification/repair routes
- `/config/alexa/*` owns Alexa setup verification
- `/config/ratings/*` owns ratings persistence maintenance
- `/config/services/*` owns service-control actions
- `/config/moode/*` owns moOde-target inspection/control helpers
- `/podcasts/*` overlaps as feature-specific automation that still participates in the config/runtime story

That is a useful route-family map even before the wiki becomes fully exhaustive per endpoint.

## Common endpoint traits in this family

Common traits include:
- track-key protection on sensitive routes
- UI-facing operational status results
- mixed inspection + mutation responsibilities
- tight coupling to host/runtime reality rather than purely abstract config storage

This is a control-plane API family, not just a CRUD family.

## Relationship to existing wiki pages

This page should stay linked with:
- `api-service-overview.md`
- `config-interface.md`
- `config-network-and-runtime.md`
- `config-ratings.md`
- `config-lastfm-and-scrobbling.md`
- `config-notifications.md`
- `config-alexa-setup.md`
- `config-podcasts-and-library-paths.md`
- `config-display-and-render-features.md`
- `config-advanced-json.md`

## Things still to verify later

Future deeper API work should clarify:
- full request/response shapes for each route
- whether additional `/config/services/*` families exist beyond mpdscribble
- whether there are write-side `/config/moode/*` helpers beyond the currently documented status route
- whether some config save flows hit additional route families not yet captured in current UI-driven documentation

## Current status

At the moment, this page gives the wiki a real API-centered map of the config/runtime control plane.

That is a big improvement over having these endpoints documented only piecemeal through surface pages.

*Last reviewed: 2026-10-28 America/Chicago*
