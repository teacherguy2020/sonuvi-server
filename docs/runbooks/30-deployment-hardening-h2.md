# Deployment Hardening H2: Shared State and Public Surface

> Historical hardening/rehearsal design, not a current installation recipe. See [current source baseline](sonuvi-source-baseline.md) and [Server operations](sonuvi-server-operations.md).

## Status and scope

This is an engineering-only design and implementation record. It does not
change a running host, systemd unit, Caddy configuration, checkout, or runtime
data. A future release must opt in explicitly; legacy checkout-relative paths
remain the default when no shared-root environment variables are set.

## Runtime configuration boundary

`/config/runtime` is a public compatibility endpoint, not an administration
config dump. Its `sonuvi.runtime-public-config.v1` projection includes only:

- project name, environment, timezone, and API/UI ports;
- display copy and browser feature flags;
- Last.fm configured state; and
- Alexa enabled state.

It never returns a Track Key, provider tokens, APNs credentials, private URLs,
filesystem paths, host/user details, alias history, `configPath`, or a raw
`fullConfig` object.

The authenticated replacement is:

```text
GET /config/runtime/admin     # existing Track Key required
POST /config/runtime          # existing Track Key required
```

The administrator response uses `sonuvi.runtime-admin-config.v1`. It has an
explicit allowlist for editable operating settings and reports protected path
and credential *configured* states only. `POST /config/runtime` no longer
accepts `{ fullConfig }`; unknown input fields are dropped, and blank redacted
credentials/paths do not erase their persisted value. Configuration writes now
use an atomic same-directory replacement.

Browser control pages use `scripts/runtime-auth.js` solely to obtain an
operator key already stored in that browser by Config. It makes no network
request and is not a way to bootstrap a credential. A new browser/device must
be given its Track Key through an approved operator flow before it can perform
protected actions.

## Shared runtime-state contract

`src/lib/runtime-state-paths.mjs` defines
`sonuvi.runtime-state-paths.v1`.

| Setting | Purpose |
| --- | --- |
| `SONUVI_STATE_ROOT` (or legacy `NOW_PLAYING_STATE_ROOT`) | Enables the shared state layout. Must be absolute. |
| `SONUVI_CONFIG_ROOT` (or legacy `NOW_PLAYING_CONFIG_ROOT`) | Optional separately managed configuration/credential root. |
| Existing per-artifact variables | Continue to win. Relative overrides are contained under the shared root; absolute overrides are deliberate operator choices. |

With `SONUVI_STATE_ROOT=/opt/sonuvi/shared`, default locations are:

```text
shared/config/       runtime JSON and Last.fm environment file
shared/data/         browse index, source-audio cache, history, profiles,
                     playlists/radio state, video registry, future audio-quality
                     catalog/checkpoints
shared/cache/        art/track caches, thumbnails, podcast maps and downloads
shared/protected/    push token registry and saved Qobuz queues
shared/logs/         Sonuvi-owned logs
```

The resolver contains new writes inside the selected shared root, preserves
atomic persistence where used by state stores, and does not create directories,
migrate data, or delete legacy artifacts on its own. The legacy locations for
the browse index, source-audio cache, mobile registry, history, controller
profile, config file, Last.fm `.env`, saved Qobuz queues, and `/tmp` caches
remain unchanged until a shared root is deliberately configured.

## Public web root

`src/lib/public-web-root.mjs` builds a fresh `sonuvi.public-web-root.v1` from a
positive allowlist:

- explicit browser HTML pages and web manifests;
- explicit client JavaScript and CSS names;
- public `icons/` and allowed public `assets/` media/font types.

It excludes source modules, `config/`, `data/`, `var/`, logs, Git metadata,
dotfiles, CLI scripts, the Alexa skill implementation, dependencies, and all
symlinks. `resolvePublicWebAsset()` rejects dotfiles, encoded traversal,
directories, non-allowlisted names, and symlink escapes.

The builder creates a new target only and stages it before rename. It must not
be pointed at an active static root. H2 does **not** switch the current Python
server or Caddy to it.

## H3 service-hardening proposal (not activated)

After an isolated release and static-root smoke test, evaluate a service unit
along these lines:

```ini
[Service]
WorkingDirectory=/opt/sonuvi/current
Environment=SONUVI_STATE_ROOT=/opt/sonuvi/shared
EnvironmentFile=/etc/sonuvi/now-playing.env
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/sonuvi/shared
ReadOnlyPaths=/path/to/music-library
```

Use a dedicated service account only after validating all renderer, MPD,
PiBuZ, UPnP, Apple Music, Last.fm, and artwork access paths. `ReadWritePaths`
must include only the shared state areas actually needed; the music library and
release directory should be read-only. The public server must serve the built
public root via the resolver/allowlist, never the checkout root.

## H3 prerequisites

1. Create a disposable release candidate with `SONUVI_STATE_ROOT` and a
   configuration root; do not migrate production in place.
2. Copy or bind only reviewed shared state and secrets, with backups and
   ownership checks.
3. Run API, browser/PWA, and integration smoke tests against that candidate.
4. Validate static-root routing through Caddy without exposing dotfiles or
   source paths.
5. Test least-privilege systemd directives incrementally with MPD, PiBuZ,
   UPnP, artwork, podcasts, and mobile pairing.
6. Obtain separate approval before any service restart, state migration, or
   activation/rollback rehearsal.

*Last updated: 2026-10-24 America/Chicago*
