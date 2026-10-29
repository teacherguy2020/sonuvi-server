# Deployment hardening H3.5 — clean provenance and integration review

> Historical hardening/rehearsal design, not a current installation recipe. See [current source baseline](sonuvi-source-baseline.md) and [Server operations](sonuvi-server-operations.md).

**Scope:** local engineering review only. No Pi5 access, deployment, service
restart, data migration, credential rotation, Git commit, merge, rebase,
cherry-pick, or push occurred.

## Repository preflight

| Worktree | Branch | HEAD | Status |
| --- | --- | --- | --- |
| deployment hardening | `codex/deployment-hardening-h1-20261024` | `4bf8889a767e167f50566ec4e193d4b625c2c1f2` | H1–H3.5 dirty set under review |
| engineering main | `main` | `4bf8889a767e167f50566ec4e193d4b625c2c1f2` | unchanged |
| audio quality | `codex/audio-quality-catalog-phase1-20261024` | `4bf8889a767e167f50566ec4e193d4b625c2c1f2` | separate dirty worktree; untouched |

At review time the deployment worktree has 83 tracked modifications and 33
untracked source/documentation files (including this report). The only ignored
worktree material is `node_modules/` (2,027 entries). Disposable H3/H3.5
artifacts live under `/tmp`, not in the worktree, and are not commit inputs.

## A. Complete change inventory

### H1 production-parity regression coverage

- `test/mobile-pibuz-qobuz.test.mjs`
- `test/named-qobuz-queue-service.test.mjs`

These add mobile bearer-contract and saved-Qobuz-queue regression coverage; no
production implementation is changed in this group.

### H2 public runtime-configuration security

Browser compatibility/auth changes:

- Pages: `alexa.html`, `app.html`, `config.html`,
  `controller-albums.html`, `controller-artists.html`,
  `controller-genres.html`, `controller-ipad.html`,
  `controller-iphone.html`, `controller-kiosk.html`,
  `controller-mobile-settings.html`, `controller-mobile.html`,
  `controller-now-playing-grid.html`, `controller-now-playing-ipad.html`,
  `controller-now-playing-iphone.html`, `controller-now-playing-tablet.html`,
  `controller-now-playing.html`, `controller-nowplaying-iphone.html`,
  `controller-playlists.html`, `controller-podcasts.html`,
  `controller-queue-wizard.html`, `controller-queue.html`,
  `controller-radio.html`, `controller-tablet-settings.html`,
  `controller-tablet.html`, `controller-upnp.html`,
  `controller-visualizer.html`, `controller.html`, `diagnostics.html`,
  `display.html`, `displays.html`, `index.html`, `index1080.html`,
  `kiosk-designer.html`, `kiosk.html`, `library-health.html`, `mobile.html`,
  `peppy.html`, `player-render.html`, `player.html`, `podcasts.html`,
  `queue-wizard.html`, `radio-eval.html`, `radio.html`, `theme.html`,
  `visualizer.html`, and `youtube.html`.
- Browser scripts: `scripts/alexa.js`, `scripts/echo-link-volume.js`,
  `scripts/hero-transport.js`, `scripts/index-ui.js`,
  `scripts/mobile-pairing-ui.js`, `scripts/now-playing-art.js`,
  `scripts/podcasts.js`, `scripts/upnp-now-playing.js`,
  `scripts/web-stream.js`, and new `scripts/runtime-auth.js`.
- API/security helpers: `src/lib/runtime-config-projection.mjs`,
  `src/lib/atomic-file.mjs`, `src/lib/track-key-auth.mjs`, and the relevant
  hunks in `src/config.mjs`, `src/routes/config.runtime-admin.routes.mjs`,
  and `moode-nowplaying-api.mjs`.
- Tests: `test/runtime-browser-auth.test.mjs`,
  `test/runtime-config-projection.test.mjs`, and
  `test/track-key-auth.test.mjs`.

This group replaces raw config serialization with literal public/admin
projections, protects administration with a configured operator key, rejects
arbitrary config writes, removes server-delivered browser credentials, redacts
public error output, and removes the repository Track Key fallback.

### H2 shared runtime-state abstraction

- Core/config: `src/config.mjs`, `src/config/load-config.mjs`,
  `src/lib/runtime-state-paths.mjs`, `src/lib/browse-index.mjs`,
  `src/lib/listening-history.mjs`, `src/lib/mobile-push-store.mjs`,
  `src/lib/mobile-video-catalog.mjs`, and `src/lib/source-audio.mjs`.
- Routes: `src/routes/config.alexa-alias.routes.mjs`,
  `config.controller-profile.routes.mjs`, `config.diagnostics.routes.mjs`,
  `config.endless-vibe.routes.mjs`,
  `config.library-health-animated-art.routes.mjs`,
  `config.library-health-read.routes.mjs`,
  `config.queue-wizard-apply.routes.mjs`,
  `config.queue-wizard-basic.routes.mjs`,
  `config.queue-wizard-preview.routes.mjs`,
  `config.queue-wizard-vibe.routes.mjs`,
  `config.runtime-admin.routes.mjs`, `mobile.routes.mjs`,
  `multiphone.routes.mjs`, `podcasts-download.routes.mjs`,
  `podcasts-subscriptions.routes.mjs`, and `seeburg.routes.mjs`.
- Supporting/runtime hunks: `scripts/export-peppymeter-skins.mjs`,
  `scripts/lastfm-authorize.mjs`, and `moode-nowplaying-api.mjs`.
- Tests: `test/runtime-state-paths.test.mjs` and
  `test/config-immutable-state.test.mjs`, plus the shared-state case in
  `test/lastfm-authorize.test.mjs`.

`SONUVI_STATE_ROOT`/`SONUVI_CONFIG_ROOT` preserve legacy locations when unset
and move default persistent/regenerable/protected writes outside an immutable
release when set. H3.5 additionally closes config-level relative override
escapes for track/art caches and mobile token/catalog paths, and routes the
standalone Last.fm authorization CLI through the same protected config root.

### H2 allowlisted public web root

- `src/lib/public-web-root.mjs`
- `src/lib/public-web-server.mjs`
- `test/public-web-root.test.mjs`
- `test/public-web-server.test.mjs`

The generated root uses a positive allowlist and rejects dotfiles, directories,
traversal, and symlink escapes. The real-project test also verifies the PWA
manifest, start URL, and declared icons. The repository currently has no
service-worker source; there is no service-worker lifecycle to preserve.

### H3 immutable artifact, manifest, and runtime tooling

- `src/lib/release-artifact.mjs`
- `src/lib/release-runtime.mjs`
- `scripts/build-release.mjs`
- `scripts/prepare-target-dependencies.mjs`
- `scripts/verify-release.mjs`
- `scripts/stage-release.mjs`
- `scripts/serve-public-web.mjs`
- `scripts/verify-current-release.mjs`
- Relevant immutable-static/health hunks in `moode-nowplaying-api.mjs`
- `test/release-artifact.test.mjs`
- `test/release-runtime.test.mjs`

H3.5 adds static relative-import closure verification and includes the existing
`scripts/lastfm-authorize.mjs` helper required by runtime-admin routes. It also
pins immutable API static serving to the release's verified `public/` directory.

### H3 paired activation and rollback

- `src/lib/release-activation.mjs`
- `test/release-activation.test.mjs`

The fixture transaction verifies candidate/previous artifacts, shared config
and schema compatibility, API/web identity and health, atomic pointer switching,
rollback, interrupted recovery, and an existing activation lock.

### H3 systemd/Caddy candidates and documentation

- `ops/systemd/now-playing.service.h3.template`
- `ops/systemd/now-playing-web.service.h3.template`
- `ops/caddy/sonuvi.caddyfile.h3.template`
- `docs/runbooks/30-deployment-hardening-h2.md`
- `docs/runbooks/31-deployment-hardening-h3.md`
- `docs/runbooks/32-deployment-hardening-h3.5.md`

These are candidate templates/runbooks only. They are not installed or active.

### Excluded or unrelated material

- Ignored `node_modules/` is development dependency output and excluded from
  Git and release snapshots.
- Disposable release artifacts/dependency trees are outside the worktree under
  `/tmp`; retain them only as local audit evidence, never as commit input.
- No `.env`, private key, database, cache, log, music, runtime state, or backup
  file is in the dirty set.
- Pre-existing screenshot/review scripts outside this dirty set contain a
  historical static test key. They are excluded from release payloads and were
  not modified here; clean them in a separate credential-hygiene change rather
  than smuggling unrelated edits into deployment hardening.

## B. Security and runtime-state findings

Corrected during H3.5:

1. Runtime administration now fails closed if no operator key is configured;
   `/config/runtime/admin` and config writes cannot inherit legacy open access.
2. Public runtime-config read failures return a generic message rather than a
   filesystem error containing a private path.
3. The release-contained config code no longer has a static fallback operator
   credential. Immutable releases reject protected requests without an explicit
   external/configured key.
4. Immutable config-level relative writable overrides are contained below the
   shared cache/protected roots or rejected if they traverse outward.
5. Immutable API static serving is pinned to `<release>/public`; an arbitrary
   absolute static root cannot expose release code or shared state.
6. Release build and verification now check static runtime import closure;
   missing helpers fail before staging.
7. The standalone Last.fm authorization CLI now resolves its default
   credential file through the runtime-state resolver, so shared-root mode
   cannot fall back to a release-local `.env`.

Current boundary evidence:

- Public `/config/runtime` is an explicit allowlist; admin projection requires
  the Track Key and never returns keys, tokens, raw config, or filesystem paths.
- Artifact application files have no data/var/log/cache/backup/credential paths,
  no application symlinks, and no Mac development path. Normal internal npm
  executable symlinks remain inside `node_modules` and are inventory-verified.
- In immutable mode every known writable Sonuvi state path resolves outside the
  release tree. Intended external writes remain external: MPD playlists,
  podcast/music roots, remote moOde operations, and private `/tmp` scratch
  work protected by the proposed `PrivateTmp` setting. The Last.fm CLI follows
  the same mapping for its protected credential file.

Remaining limitations:

- Legacy checkout mode intentionally remains compatible and may retain its
  historical no-key behavior outside the immutable release path; treat it as
  unsafe for production upgrades.
- Caddy is unavailable on the M4 environment, so candidate syntax was not
  parser-validated.
- No local fixture can prove Pi5 service identity, device/network access, or
  playback-integration parity.

## C. Reproducibility evidence

Two independent clean disposable builds use Docker `linux/arm64` with
`node:20.19.5-bookworm-slim` (Node `v20.19.5`, npm `10.8.2`) and the same
approved dirty snapshot. They produced the same dependency-tree hash,
release ID, manifest bytes, and artifact file content with a fixed build
timestamp. The independent verifier accepted both artifacts.

Build timestamp is intentionally metadata, not release identity. A third build
with a one-second-later timestamp retained the same release ID and identical
non-manifest payload; only `build.timestamp` differed in the manifest.

This demonstrates deterministic content for the approved development snapshot,
not signed/reviewed production provenance. A production release still requires
a clean reviewed revision or separately approved signed snapshot.

## D. Proposed scoped commit sequence

1. **`test(qobuz): cover saved-queue production contracts`**
   - Files: the two H1 tests above.
   - Dependency: existing Qobuz/mobile implementation at `4bf8889`.
   - Test: focused named-Qobuz/mobile test files.
   - Risk: contract expectations only; no runtime mutation.

2. **`security(runtime-config): redact public config and require explicit operator auth`**
   - Files: public/admin projection, atomic helper, Track Key helper, browser
     auth helper/pages/scripts, runtime-admin route security hunks, and the
     Track Key hunks of config/API bootstrap; associated three test files.
   - Dependency: existing config route registration.
   - Test: runtime projection/browser auth/Track Key tests.
   - Risk: browsers need a locally stored operator key; unconfigured admin
     surfaces now fail closed.

3. **`refactor(runtime-state): move writable state behind shared roots`**
   - Files: state-path helper, config/load-config state hunks, listed state
     consumers/routes, Peppy export script, API state hunks, and state tests.
   - Dependency: commit 2 for overlapping config/runtime-admin hunks.
   - Test: runtime-state and immutable-config tests plus affected route tests.
   - Risk: immutable relative overrides are newly contained/rejected; legacy
     defaults remain compatible when shared-root mode is disabled.

4. **`security(public-web): generate and serve only allowlisted assets`**
   - Files: public-root/server modules and their tests.
   - Dependency: browser auth helper from commit 2 is allowlisted here.
   - Test: public-root/server/PWA tests.
   - Risk: newly added browser files require an explicit allowlist update.

5. **`build(release): verify immutable Linux ARM64 artifacts`**
   - Files: release artifact/runtime modules, build/verify/stage/serve scripts,
     immutable-static API hunks, and artifact/runtime tests.
   - Dependency: commits 2–4.
   - Test: artifact import-closure, manifest/tamper, target-dependency, and
     runtime identity tests.
   - Risk: deployment remains disabled until a clean reviewed source or signed
     snapshot and separately authorized Pi5 validation exist.

6. **`feat(release-activation): model paired API/web activation and rollback`**
   - Files: activation module and fixture tests.
   - Dependency: commit 5's manifest/staging layout.
   - Test: activation, rollback, lock, and interrupted-recovery fixtures.
   - Risk: fixture proof only; real systemd/Caddy traffic gating remains H4.

7. **`docs(ops): add deployment-hardening runbooks and candidate templates`**
   - Files: H2/H3/H3.5 runbooks and systemd/Caddy templates.
   - Dependency: all prior commits.
   - Test: static review plus `git diff --check`.
   - Risk: templates must not be installed without separate H4 approval.

`src/config.mjs`, `src/routes/config.runtime-admin.routes.mjs`, and
`moode-nowplaying-api.mjs` contain deliberately separable security/state/release
hunks; stage them by hunk when commits are authorized. Do not mix unrelated
audio-quality changes into this series.

## E. Integration readiness

Engineering main has not advanced from the shared base, so no current merge
conflict exists. The audio-quality worktree remains separate, but future
integration will overlap these files and needs an explicit conflict review:

- `moode-nowplaying-api.mjs`
- `src/lib/browse-index.mjs`
- `src/lib/source-audio.mjs`
- `src/routes/mobile.routes.mjs`

The release mechanism is inactive until systemd/Caddy templates are separately
adopted. Existing legacy operation remains available, but it is not a safe
deployment strategy for future production upgrades without explicit credentials
and shared state.

## Verification checklist

The final frozen review state is verified with:

1. Focused H1/H2/H3/H3.5 suites, including Last.fm shared-root coverage.
2. Full declared Node suite.
3. Syntax/module-import checks.
4. `git diff --check`.
5. Two independent Linux/ARM64 dependency/artifact builds from the exact
   approved snapshot, manifest verification, byte comparison, and a separate
   timestamp-variance comparison.

*Last updated: 2026-10-24 America/Chicago*
