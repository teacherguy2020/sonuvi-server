# H4C.4A synthetic rehearsal preflight

> Historical hardening/rehearsal design, not a current installation recipe. See [current source baseline](sonuvi-source-baseline.md) and [Server operations](sonuvi-server-operations.md).

**Status:** local design and mock validation only. This runbook does not
authorize starting an API or web candidate, Pi5 access, production-state or
credential access, artifact transfer, or a Caddy/systemd change.

## Purpose

H4C.4A proves the containment primitives needed for a later, separately
approved H4C.4B rehearsal. It prepares only fictional state and a no-start
container plan. The plan has no host-published ports and does not route through
Caddy.

## Verified local boundary

The local Docker daemon is Linux/ARM64 and its backing disk is on SammySSD.
The cached `node:20.20.1-bookworm-slim` image was exercised with generic mock
processes only. The probe verified all of the following without DNS queries or
production endpoint requests:

- An `--internal` bridge permits a synthetic API/web peer pair while exposing
  no default route.
- `--network none` exposes only loopback.
- Generic containers have no Docker-socket mount, use a read-only root,
  unprivileged/private PID and IPC namespaces, `no-new-privileges`, and no
  added capabilities.
- A synthetic release bind mount rejects writes; a synthetic disposable-state
  mount accepts and removes a test write.
- The cached image reports Linux/ARM64 Node `v20.20.1`.

The reusable, mock-only verifier is:

```sh
node scripts/h4c4a-network-probe.mjs --scratch-parent <empty-SammySSD-directory>
```

It creates uniquely named Docker resources and a temporary synthetic directory,
then removes exactly those resources in `finally`. It never accepts a Sonuvi
release path and cannot start Sonuvi.

## Synthetic state

`scripts/h4c4a-create-synthetic-state.mjs` creates one fresh, empty-root-only
fixture. It rejects existing roots, symlinks, broad permissions, unexpected
files, secret-shaped field names, non-loopback integration endpoints, real
media paths, enabled Alexa/push features, and non-v2 browse indexes.

The fixture contains fictional JSON only:

- `library-browse-index.json` using `now-playing.browse-index.v2`, with two
  `Synthetic/…` tracks;
- source-audio cache v1, controller profile, playlist cache, radio metadata,
  disabled Endless Vibe state, empty jukebox queue state, and inert Peppy
  display bookkeeping;
- a non-secret immutable configuration with loopback-only MPD/moOde values;
- empty `cache`, `logs`, `checkpoints`, and `protected` directories.

It contains no music, podcast content, real catalog data, credentials, tokens,
SSH material, or `.env` file. The closed inventory is rechecked before a
rehearsal plan is emitted.

The only supported cleanup path requires both the root and its exact marker
identity:

```sh
node scripts/h4c4a-remove-synthetic-state.mjs \
  --state-root <exact-synthetic-root> \
  --fixture-id <exact-marker-id>
```

It refuses an unmarked directory and never prunes Docker, worktrees, images,
volumes, releases, or other directories.

## No-start preflight plan

`scripts/h4c4a-rehearsal-preflight.mjs` creates a declarative plan only. It
has no process-spawning code and explicitly rejects `--start`.

It requires:

1. An explicit, existing release root that passes the artifact's own manifest
   verifier and confirms that exact root, plus an explicit
   `--expected-release-id` matching the reviewed content-derived release ID.
   The preflight compares the artifact's runtime-contract modules with its
   local trusted contracts before importing the artifact's capability gate, so
   a changed worktree cannot silently validate a different runtime.
2. Clean Git provenance (`dirty: false` and
   `clean-git-worktree-snapshot`), Linux/ARM64 target metadata, and Node 20
   compatibility.
3. An explicit closed synthetic-state root created by this runbook.
4. Different non-production API and web ports. H4C.4A uses `31901` and
   `31902`; the API receives `PORT=31901`, the static web process receives
   `SONUVI_WEB_PORT=31902`, and neither is published to the host or LAN.
5. `SONUVI_EXECUTION_MODE=rehearsal`, a matching
   `SONUVI_REHEARSAL_STATE_ROOT`, disabled external reads, and no credential,
   SSH-agent, or production integration environment variables.

The later candidate topology is deliberately constrained to an internal Docker
bridge:

```text
disposable probe container ── internal bridge ── API :31901
                                              └── web :31902

No host-published ports, no Caddy, no LAN route, no Docker socket
```

Both future candidate containers have a read-only root and release mount. The
API alone receives the shared synthetic state writable plus small `tmpfs` mounts
for cache/logs/checkpoints; the static web process sees that same state root
read-only and has only a small `/tmp` `tmpfs`. Neither has privileges/capabilities
or a host PID/IPC namespace. The API target is 0.75 CPU, 768 MiB, and 128 PIDs;
the web target is 0.25 CPU, 192 MiB, and 32 PIDs.

## Capability-gate expectation

The preflight actively requires rehearsal mode and the existing runtime gate.
The associated regression coverage exercises adapter-boundary denials for MPD,
PiBuZ/Qobuz, UPnP/DLNA, Last.fm, APNs/push, Alexa diagnostics, Harmony,
restricted SSH, podcast writes, generic child processes/fetch, unknown
adapters, background Endless Vibe work, and writes outside synthetic state.
Docker isolation is independent defense in depth; neither control is treated
as sufficient alone.

AirPlay and any unclassified external adapter are not live-tested in H4C.4A:
they remain denied by the generic process/fetch boundary and lack a route in
the container proof. H4C.4B must retain both checks and report any startup-time
path that needs an additional explicit adapter assertion.

## Current artifact gate

H4C.4A.1 recovered a local-only clean ARM64 artifact from committed source
`b0984e6c054b6bdd170c5a151e770c20f8759ddb`. Its content-derived release ID
is `sonuvi-08ce3ea8518684432461c02f4fc820aacb5934275bb35f0a83c090871de5a5a9`.
It remains an engineering artifact only: it is neither staged nor associated
with a candidate process. A future H4C.4B operation must re-run the
manifest/identity check and provide this exact ID explicitly; the preflight
will fail rather than use the dirty worktree or any source fallback.

## H4C.4B execution result — 2026-10-25

H4C.4B added a separate one-shot plan-to-Docker execution adapter. It accepts
only a newly verified H4C.4A plan, pins the manifest-backed release ID and
Linux/ARM64 Node image digest, rejects host/home/music/Docker-socket mounts and
credential-shaped environment variables, requires read-only release mounts,
and creates a protected one-shot evidence record immediately before candidate
startup. It never treats a preflight pass as execution authorization.

One bounded API/web start was attempted with a fictional 11-file state fixture.
Both processes started from the pinned artifact, then were explicitly stopped,
verified exited, and removed. The release manifest and disposable fixture were
unchanged; the exact fixture was then removed. No H4C.4B Docker resources
remain.

The disposable peer could not start because its initial Docker local log-driver
settings used `max-file=1`, which Docker rejects when compression is enabled.
Consequently, no HTTP/API/web acceptance requests ran and the rehearsal did
**not** pass. The peer setting is corrected to two bounded 2 MiB retained log
files and validated with a generic non-Sonuvi container, but a second candidate
start is deliberately not automatic: it requires a new H4C.4B authorization.

The protected result record is outside Git and release artifacts.

## H4C.4B.1 correction and provenance gate — 2026-10-25

The peer failure was isolated to Docker's log-driver validation; it did not
reach a Sonuvi API or web acceptance request. The execution adapter now creates
and inspects **all three** containers before either candidate process can
start. The peer shares only the web network namespace, has no bind mounts,
uses interactive stdin for its bounded test program, and retains two 2 MiB
local log files. A no-start Linux/ARM64 Docker probe verified the API, web,
and peer configurations and removed exactly its three containers and internal
network afterward.

The prior service-worker check was an obsolete expectation, not a missing
asset: the product has PWA manifests/icons but no registered or bundled
service-worker lifecycle. The acceptance peer now requires the PWA manifest
and verifies that `/service-worker.js` remains unavailable, rather than
claiming a limitation or exposing a new public asset.

The browse-index adapter now has an explicit rehearsal mode. It accepts only a
validated v2 fixture located below `SONUVI_REHEARSAL_STATE_ROOT`; it refuses a
missing, malformed, escaped, or non-v2 fixture and denies a forced refresh or
index build. It cannot invoke `mpc`, reach MPD, rebuild the catalog, probe
source files, or write an index in rehearsal. Production behavior keeps its
existing MPD freshness/check-and-build path. Focused coverage proves the
rehearsal path makes zero subprocess calls even when the injected `mpc`
executable is available.

This is a runtime-source correction. Accordingly, runtime-contract parity now
includes `src/lib/browse-index.mjs`. The historical clean artifact remains
manifest-valid, but its parity check correctly rejects it because it still has
the older direct-`mpc` implementation. No second candidate start was made.
A scoped commit and a new clean Linux/ARM64 artifact with independent manifest
and Node 20.20.1 verification are required before the one authorized retry can
be considered.

## H4C.4B.2 successful synthetic rehearsal — 2026-10-25

The corrected one-shot adapter subsequently completed one bounded local
rehearsal from the clean ARM64 release built at `bfc253c3673fa2c277f63128a59c534340b43761`.
The API `/health` and web `/release.json` returned the same release identity;
the peer accepted only the fictional v2 catalog, public configuration, and
PWA manifest. Protected configuration and private state remained unavailable,
and the current product contract correctly reported no service worker.

The isolated peer had no default route or external DNS. Rehearsal denials
covered MPD, Qobuz, UPnP, Last.fm, Alexa, queue, and WebSocket mutations. The
adapter verified unchanged release/state snapshots and removed exactly its API,
web, peer, and internal-network resources. This is a synthetic acceptance
result only: it establishes neither Pi5 readiness nor production authorization.

## H4C.4C reusable release-acceptance gate

The reusable gate formalizes this sequence:

```text
Build → Verify → Isolate → Start → Test → Stop → Verify cleanup
```

Its commands deliberately remain separate:

1. Create a new marked fictional fixture with
   `scripts/h4c4a-create-synthetic-state.mjs`.
2. Run `scripts/h4c4-artifact-browse-isolation.mjs` against the immutable
   release. This imports only the artifact's browse adapter in a Linux/ARM64
   container with `--network none`, a read-only release mount, a read-only
   fixture mount, and an instrumented `mpc`. It must record zero `mpc`
   invocations, zero MPD attempts, zero catalog writes, fixture acceptance,
   and fail-closed missing/refresh/rebuild behavior. It never starts API or
   web entrypoints.
3. Create a protected preflight record with
   `scripts/h4c4-release-acceptance-gate.mjs --mode preflight`. It requires a
   pinned release ID, source commit/tree, manifest-backed inventory, the
   artifact-isolation evidence, and the closed fixture. The resulting record
   is private mode `0600`, hash-bound, explicitly `preflight-only`, and sets
   `executionAuthorized: false`.
4. A later, separately authorized rehearsal may use
   `--mode execute` only with that unchanged record and the exact
   release-scoped `--execute-once` value. The command rechecks the artifact
   manifest, clean source provenance, fixture, and plan before it delegates to
   the three-container adapter. A successful preflight is never startup
   permission.
5. `--mode cleanup` removes only the marked fixture named by the protected
   record. The execution adapter independently removes only its labeled
   Docker API/web/peer/network resources.

The gate's mandatory assertions cover API/web release-identity parity,
fictional catalog behavior, public-configuration allowlisting, protected-path
denial, current PWA contract, adapter-boundary side-effect denials, no
production mounts or credentials, no external route/DNS, read-only release
hashes, disposable write boundaries, and exact cleanup. The rehearsal image
requires Node at startup; declared external integration tools may remain
absent only when the adapter verifies that their integrations are disabled.

All acceptance evidence is local and protected. It is not part of the release
artifact and it never grants production deployment, migration, or activation.

*Last updated: 2026-10-25 America/Chicago*
