# Sonuvi Server source baseline

Reconciled 2026-10-28 from GitHub main `97b41583d030881ba806dd663eccbaf3f8450415`
and accepted production source `84b0ddff5b1042af1849f08dee181fbd7ccc9fa2`.
This is a source reconciliation, not a deployment. The running artifact remains
unchanged. Main is the common starting point for subsequent development branches.

## Incorporated accepted changes

| Area | Source lineage | Included contract |
| --- | --- | --- |
| Immutable runtime | deployment-hardening lineage through `c169cc4` | external state/protected configuration; public asset allowlist/server; Track Key fail-closed checks; managed SSH/rehearsal capability boundaries; guarded subprocess promise-result fix |
| HTTPS/web compatibility | `5c9eb00`, `e8e6ff2` and equivalent existing-main commits | same-origin HTTPS, direct HTTP ports, nested preview/artwork URL handling |
| Config | `28ff24c` through `7b16aa0` | editable changed-only Save; no-op preservation; credential exclusion; masked server access; authenticated media-path readback; honest local/remote checks; paired Polkit restart contract |
| Radio | `cc1ada8` | shared moOde HTTP catalog/genres/favorites; stable station fields; explicit service error rather than false zero; controller/native authentication unchanged |
| Playlists | `28852f8`, finalized `84b0ddf` | MPD temporary playlist/readback/non-overwriting promotion; live queue isolation; explicit cleanup errors; existing per-track append unchanged; collage failure independent |
| Release support | accepted runtime lineage | ARM64 dependencies, artifact construction/inventory/import-closure/runtime verification, staging/promotion primitives, activation library and isolated synthetic acceptance tools/tests |

Radio browsing and web-controller Queue Wizard save-only have user acceptance.
The radio fixture contains242 stations/16 favorites; it is synthetic test data,
not an exported personal radio database.

## Main changes retained and reconciliation decisions

- Main's newer architecture/wiki/contract documentation and audit evidence are
  retained; production's older copies did not replace them.
- Retired `install.sh` and `deploy-pi5-files.sh` still fail closed. Current
  `ops/systemd/sonuvi-{api,web}.service.in` and the Echo Link release paths remain.
- Accepted Config restart behavior supersedes main's earlier sudo-based helper:
  exact Sonuvi pair, optional operator-managed Polkit opt-in, acknowledgement
  before termination, truthful availability, no legacy/PM2/sudo fallback.
  Retained main regression tests were reconciled to this newer contract.
- Shared application code is otherwise the accepted production version. The
  release builder's descriptive manifest now names the current Sonuvi units and
  environment-selected config/credential locations rather than old staging
  labels. This does not change application startup or install permissions.
- Stale cache-date assertions were updated without weakening artwork behavior
  checks; synthetic fixtures now use the platform temporary directory. Permission
  tests must run as an ordinary user, not root.
- A focused integration commit is based on existing main. Private deployment
  branch history is not merged wholesale. Existing worktrees and uncommitted
  feature drafts are preserved, not folded into this baseline.

## Reproducible source and artifact workflow

Use a clean checkout, the committed package lock, a pinned Linux/ARM64 Node20
build image and the existing scripts. No target host is involved in these steps.
Run tests as a non-root user with a physical, non-home temporary directory:
`TMPDIR=/private/tmp npm test` on macOS or `TMPDIR=/tmp npm test` on Linux.
Synthetic mount/path guards deliberately reject homes and symlinked roots.
Production dependencies and development browser
tools are distinct; host-native node_modules must not enter an ARM64 artifact.

```sh
npm ci
npm test

# Choose absolute, new output directories outside the source tree.
node scripts/prepare-target-dependencies.mjs \
  --source-worktree "$PWD" \
  --output-root /absolute/build/target-dependencies \
  --target-image node@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3
node scripts/build-release.mjs \
  --source-worktree "$PWD" \
  --dependency-root /absolute/build/target-dependencies \
  --output-root /absolute/build/release \
  --production
node scripts/verify-release.mjs --artifact-root /absolute/build/release
```

Dependency metadata binds the lockfile, package/native inventory, image and ABI.
An existing verified dependency bundle is reusable only when its lockfile and
inventory checks pass. A release ID incorporates source provenance and payload;
a new main revision is not expected to equal production's release ID or Git hash.
Do not use development dirty snapshots for production. Archive verification is
not host authorization and is not proof that optional integrations work.

## Remaining release-tooling boundaries

- The builder, public-only server, verifier, runtime state library, current
  service templates and synthetic acceptance tools are now in main.
- There is **no general fresh installer or one-command production activation CLI**.
  `stage-release`/`promote-staged-release` provide verified filesystem primitives;
  they are not the complete current service-account/unit/pointer/checkpoint/health
  orchestration. The activation library requires its explicit services adapter.
  Current host activation remains a separately reviewed operator procedure.
- Host-bound migration/SSH preflight (`h4c3b-preflight`), installation-specific
  activation wrappers, real trust records, H4C control files and credentials are
  deliberately not published. They are not application/runtime dependencies.
- `*.h3.template` and numbered H2/H3/H4 runbooks preserve historical staging and
  synthetic-rehearsal designs. Their older shared-root/legacy-unit/traffic-gate
  topology is not the current installation recipe. Use current `sonuvi-*.service.in`
  templates and [Server operations](sonuvi-server-operations.md). Genericized
  music-root placeholders must be rendered before using historical fixtures.
- The optional Echo Link sidecar source is tracked, but its Python helper is not
  included in the current release payload allowlist. Its source unit template is
  not proof of packaging or enablement; deployment of that optional sidecar and
  its virtual environment remains separate. It is not required by the accepted
  API/web runtime. No sidecar packaging or activation was added here.
- Native binaries/OS packages, the music mount, systemd/Polkit, protected environment
  files, HTTPS/Tailscale and provider setup remain external prerequisites. No
  installer, migration, trust, SSH permission or security-framework work is added.
- Some legacy compatibility defaults already present on main remain in source;
  they are not copied live installation data or a substitute for explicit site
  configuration. No live config, history, caches, databases or private key files
  are included in this reconciliation.

## Deliberately unfinished

- Collage preview generation works; remote moOde playlist-cover installation is
  unavailable. Existing covers remain untouched. No replacement storage design.
- Native iOS Queue Wizard save-only UI/behavior is a separate follow-up. Server
  bearer support is not evidence that a native button exists. No native source edits.
- General SSH diagnostics/remote maintenance, unrelated UI improvements, Qobuz
  lifecycle follow-ups and isolated unaccepted development drafts stay separate.

## Verification boundary

Regression coverage includes radio success/empty/error/authentication fixtures,
MPD creation/cleanup/concurrency/queue isolation, individual-track append/mobile
adapters, Config security/persistence, service policy, HTTPS/artwork routing,
immutable state/public serving, release verification and synthetic isolation.
Host and Linux/ARM64 checks use fixtures; they do not modify production playlists
or initiate playback. A source reconciliation must not redeploy/restart/reboot
production merely to make its Git hash match main.

See [Config maintenance](sonuvi-config-maintenance.md),
[playlist contract](../mpd-stored-playlist-draft-20261028.md), and
[Server operations](sonuvi-server-operations.md).
