# Deployment Hardening H3: Immutable Release Builder and Local Rollback Harness

> Historical hardening/rehearsal design, not a current installation recipe. See [current source baseline](sonuvi-source-baseline.md) and [Server operations](sonuvi-server-operations.md).

## Status and authorization boundary

This is **engineering-only H3 material**. It creates only disposable local
artifacts and layouts. It does not contact, stage, change, or restart the Pi5,
does not migrate runtime state, and does not change a live Caddy or systemd
unit. H3 commands deliberately refuse a layout under `/opt`.

No production release is authorized by this document.

## Source provenance and development snapshots

`scripts/build-release.mjs` requires all of the following explicit inputs:

```text
--source-worktree <absolute Git worktree root>
--output-root <absolute new artifact directory>
--dependency-root <absolute verified Linux/ARM64 dependency directory>
```

The builder never derives source from its own script location. It resolves the
selected worktree through Git, requires that the passed path is exactly the
resolved worktree root, and rejects anything other than the `now-playing`
project with the expected API entrypoint and config module. The manifest records
branch, Git HEAD, Git tree, and dirty status.

Dirty worktrees fail closed by default. A development-only build must use
`--allow-dirty-snapshot` and repeat `--approved-untracked <relative-file>` for
every untracked source file it intends to include. The snapshot:

- copies regular tracked files at their selected working-tree content;
- includes only the named untracked files;
- records a sorted content inventory and content hash;
- excludes Git metadata, node modules, secrets, credentials, environment files,
  runtime data, caches, logs, music/media files, and temporary output; and
- labels itself `development-only-dirty-snapshot`, never as a clean Git
  revision.

`--production` accepts only a clean worktree. H3 intentionally does **not**
accept an unsigned dirty snapshot as a production input. A future signed-snapshot
path must verify a separately reviewed signature and trust root before it can be
considered equivalent to a reviewed immutable revision.

## Target-compatible dependencies

The existing development `node_modules` contains native macOS Sharp artifacts,
so it is never copied into a release. Build a dependency tree separately:

```text
node scripts/prepare-target-dependencies.mjs \
  --source-worktree <absolute-worktree> \
  --output-root <new-disposable-directory> \
  --allow-dirty-snapshot \
  --target-image node:20.19.5-bookworm-slim
```

The helper runs `npm ci --omit=dev --include=optional` inside Docker with
`--platform linux/arm64`, mounts source read-only, and writes only to the
requested disposable output. It verifies that Sharp's Linux/ARM64 binary is
loadable, records the Docker image digest, Node/npm versions, lockfile hash,
native artifacts, package inventory, and complete dependency-tree hash in
`target-dependencies.json`.

The release builder rejects a dependency directory when its metadata is absent,
the lockfile hash differs, the target is not Linux/ARM64, native artifacts are
macOS-shaped, or the inventory has changed. H4 must compare the staged Pi5 Node
runtime to the manifest's recorded Node version before activation.

External runtime dependencies are intentionally declared rather than bundled:
`python3`, `mpc`, `ffmpeg`, `ffprobe`, `metaflac`, `curl`, `ssh`, `scp`, plus the
Vibe Python packages `python-mpd2`, `requests`, and `mutagen`. MPD access,
moOde SSH, outbound provider HTTPS, and read-only CIFS music access are also
runtime prerequisites.

## Artifact and manifest

The builder creates a new directory only. Its payload contains:

```text
<release>/
  moode-nowplaying-api.mjs
  src/                         API code and release runtime helpers
  scripts/serve-public-web.mjs
  scripts/verify-current-release.mjs
  build_moode_index.py
  lastfm_vibe_radio.py
  skins/                       required source material for Peppy export
  config/now-playing.config.example.json
  node_modules/                verified Linux/ARM64 production tree
  public/                      H2 allowlisted static assets only
    release.json               safe web release identity
  release-manifest.json
```

It excludes `.env` files, credentials, private keys, Git metadata, runtime
databases, browse indexes, source-audio caches, history, queues, preferences,
logs, music, temporary products, test files, and source-only deployment tools.
No absolute development path is permitted in the manifest.

`release-manifest.json` uses `sonuvi.release-manifest.v1` and contains:

- a content-derived release ID (timestamps are non-identity metadata);
- Git/source snapshot provenance and dirty status;
- target OS/architecture, Node/npm versions, Docker build identity, and lockfile
  hash;
- dependency package/native-file inventory hashes;
- complete deploy-payload file inventory hashes;
- H2 public-asset inventory/hash and a safe `public/release.json` identity;
- configuration-key names and shared-state directory names, without values;
- supported browse-index schemas (`v1`, `v2` for this H3 branch);
- required API/web services and expected entrypoints; and
- external command, Python-package, service, and access prerequisites.

The manifest does not recursively hash itself. Instead, it inventories every
payload file, recomputes the content-derived release ID, and cross-checks the
independent public identity file. This avoids an impossible self-referential
hash while still detecting missing, corrupted, added, or mismatched payload
content. It is integrity verification, not an authenticity signature.

Run the independent verifier before staging:

```text
node scripts/verify-release.mjs --artifact-root <artifact>
```

## Disposable immutable layout

H3 simulates the future shape below only under a local disposable root:

```text
<layout>/
  releases/<release-id>/       read-only after staging
  current -> releases/<id>     atomically renamed symlink
  shared/
    config/ data/ cache/ protected/ logs/ checkpoints/
  backups/                     retained; H3 never deletes releases/backups
```

`scripts/stage-release.mjs` verifies the source artifact before copying it,
verifies the staged copy again, then marks the staged tree read-only before an
atomic rename into `releases/`. It never runs `rsync --delete`, never touches
the legacy `/opt/now-playing` checkout, and refuses to overwrite an existing
release ID.

`SONUVI_STATE_ROOT` and `SONUVI_CONFIG_ROOT` select `shared/` in immutable
mode. H3 also moved the remaining ordinary checkout-local write targets into
that layout:

- radio-logo cache → `shared/cache/radio-logo-cache`;
- radio queue map, Vibe library index → `shared/data`;
- Vibe JSON scratch output → `shared/cache/tmp`;
- Vibe logs → `shared/logs/vibe`;
- Peppy generated exports → `shared/cache/exports/...`.

Legacy operation remains path-compatible when shared-root mode is disabled.
The Last.fm authorization CLI is not a release startup action; immutable
operation resolves `LASTFM_ENV_FILE` only beneath the root-managed
`SONUVI_SECRETS_ROOT` (normally `/etc/sonuvi`), never the shared config root.
Library-health image scratch files still use private temporary storage, not the
release tree.

## Paired activation and rollback model

`src/lib/release-activation.mjs` models a transaction using an explicit,
external activation lock and state record in `shared/checkpoints/`:

```text
preflight
  → prepare API + web candidates behind a service adapter
  → atomic current-symlink switch
  → verify API release ID and web release ID
  → API + web health checks
  → commit
```

Preflight verifies the candidate artifact, verifies a retained previous release,
requires the shared configuration file, checks writable shared directories, and
rejects an incompatible browse-index schema. On API/web startup or health
failure it restores the previous symlink, invokes adapter rollback, preserves
shared data and the candidate release, and records the result. Interrupted
activation recovery restores the retained previous pointer; if it cannot prove
that prior release still exists, it stops with `manual-recovery-required`.

A symlink switch alone cannot atomically replace two already-running processes.
The future systemd/Caddy adapter must therefore hold public traffic in a
maintenance/gated state while it starts both candidate services, compares API
`/health` against web `/release.json`, and commits only after both agree. H3
tests this contract with disposable service fixtures; it does not claim live
systemd paired-start proof.

## Static web, Caddy, and systemd candidates

`scripts/serve-public-web.mjs` serves only the H2 allowlisted root, with no
directory listing, dotfile serving, traversal, symlink escape, or checkout
fallback. `public/release.json` is the only generated metadata it exposes.

Candidate, **not installed**, files are:

- `ops/systemd/now-playing.service.h3.template`
- `ops/systemd/now-playing-web.service.h3.template`
- `ops/caddy/sonuvi.caddyfile.h3.template`

The units propose a dedicated `sonuvi` identity, `ProtectSystem=strict`,
`ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, read-only release
and music paths, and explicit shared/MPD-playlist write paths. They intentionally
leave outbound network capability available because MPD/moOde, PiBuZ/Qobuz,
UPnP/DLNA, AirPlay, Alexa, Last.fm, Seeburg, Multiphone, and Caddy require
integration-specific validation. Do not enable `PrivateDevices`, additional
address-family restrictions, or a new service identity until those integrations
have been exercised on a reversible candidate.

## H3 verification matrix

Focused tests cover:

- explicit worktree resolution and project mismatch rejection;
- dirty-source refusal and approved-untracked snapshot completeness;
- secret/runtime exclusion and manifest/path-leak checks;
- manifest/file/hash tamper and incomplete-transfer detection;
- Linux/ARM64 dependency metadata and native Sharp validation;
- public-root/static-server traversal, dotfile, and symlink denial;
- read-only staged release operation;
- shared-state path resolution and compatibility gating;
- paired API/web fixture activation, startup failures, health failures,
  rollback, interrupted recovery, missing previous release, missing config, and
  unwritable state handling.

Run the declared full Node suite and static checks before any H4 review. H3
fixture results demonstrate engineering behavior only; production readiness
requires a separately authorized Pi5 staging/validation plan.

*Last updated: 2026-10-25 America/Chicago*
