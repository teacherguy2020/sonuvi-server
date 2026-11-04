# Gate B: fresh-install and iOS bootstrap audit

Status: **BLOCKED for controlled installation**. This document distinguishes
implemented contracts from proposed work. It does not authorize deployment.

## Verified reusable release components

| Component | Status | Fresh-host suitability |
| --- | --- | --- |
| ARM64 dependency preparation | Implemented (`scripts/prepare-target-dependencies.mjs`) | Build-time only; does not provision a host. |
| Immutable artifact builder/verifier | Implemented (`scripts/build-release.mjs`, `scripts/verify-release.mjs`) | Reusable after an artifact is independently transferred to the target. |
| Staging/promotion | Implemented (`scripts/stage-release.mjs`, `scripts/promote-staged-release.mjs`) | Promotion is intentionally constrained to `/opt/sonuvi`; it does not initialize a host. |
| Runtime preflight | Implemented (`scripts/verify-release-runtime.mjs`) | Requires pre-existing shared state/configuration and optional topology inputs. |
| Transactional activation | Implemented (`src/lib/release-activation.mjs`) | Upgrade-only: requires a verified previous release and pre-existing shared configuration. |
| Legacy installer | Retired (`scripts/install.sh`) | Must remain retired. |

The current runtime lifecycle is correctly fail-closed for an established
Server. It cannot be used as a blank-host installer because it has no
host-provisioning adapter, no initial configuration initializer, no first
release activation path, and no systemd service adapter.

## Implemented bootstrap contract

`src/lib/sonuvi-bootstrap-contract.mjs` defines protocol v1 request validation
and JSON-ready stage events. It is implemented and tested, but it does **not**
install or activate a release yet.

Request fields: protocol version, opaque request ID, optional approved release
ID and manifest SHA-256, and schema-limited non-secret options. Fields whose
names imply credentials are rejected.

Stage identifiers: `preflight`, `release_acquisition`, `release_verification`,
`checkpoint`, `dependency_setup`, `configuration`, `activation`,
`health_verification`, `administrator_enrollment`, `pairing_ready`, `complete`.

Events contain a stage, state, timestamp, optional measured progress, and a
stable error code. Progress is optional and is not synthesized where no
measurable unit exists.

## Gate B1 isolated implementation (not VM-accepted)

`src/lib/sonuvi-fresh-install.mjs` now implements and tests a deliberately
narrow fresh-host adapter core. It is not a network listener and has no shell,
SSH, or arbitrary-command capability.

- `classifyFreshInstallHost` returns one of `fresh_eligible`,
  `already_installed`, `incomplete_installation`, `unsupported_host`,
  `conflicting_installation`, or `requires_recovery`. Inaccessible or partial
  state is never treated as empty.
- `initializeFreshHostLayout` creates Sonuvi-owned state only after a fresh
  classification. Its initial configuration is non-secret, localhost-only,
  uses an empty local library, and has no moOde, production host, or copied
  credential dependency.
- `renderFreshSystemdUnits` and `provisionFreshSystemdUnits` materialize only
  the reviewed API/web unit files and refuse to overwrite a different unit.
  The future privileged transport still owns `daemon-reload`, enable, and
  start; no general privileged execution interface was introduced.
- `appendFreshInstallJournal` writes fsync-backed JSONL stage events and
  `writeFreshInstallState` records an atomically replaced durable state file.
  Both redact sensitive named fields.
- `src/lib/sonuvi-first-release.mjs` adds an initial activation seam. It
  verifies the staged artifact, never invents a previous release, and removes
  only the pointer it created if API/web verification or health fails. The
  verified candidate remains for diagnosis or explicit recovery.

The existing upgrade transaction in `src/lib/release-activation.mjs` is
unchanged and remains the only path for upgrades with a retained release.

### Gate B1 state model

`preflight -> release_acquisition -> release_verification -> checkpoint ->
dependency_setup -> configuration -> activation -> health_verification ->
administrator_enrollment -> pairing_ready -> complete`.

Only `preflight`, configuration persistence, unit-file provisioning, durable
journal/state persistence, and first-release activation are implemented in
the isolated adapter. A failure before a first current-pointer is created
leaves no release selected. A failure after selection removes that pointer,
records `recoverable-incomplete`, and invokes the narrowly supplied rollback
adapter; it cannot "roll back" to a nonexistent release.

Example sanitized journal record:

```json
{"contract":"sonuvi.fresh-install-journal.v1","attemptId":"boot_example","targetIdentity":"machine-id","stage":"activation","state":"started"}
```

### Administrator enrollment remains a blocker

No first-administrator enrollment endpoint or credential has been added.
Existing mobile pairing sessions and the historical Track Key are not safe
substitutes for administrator authority. A future implementation must use a
separate short-lived, single-use, server-and-attempt-bound enrollment proof
with expiry/replay protection and redacted diagnostics. This is a security
blocker for Gate B1 PASS and all live installation work.

### Native iOS handoff status

| Operation | Status |
| --- | --- |
| Preflight classifications and stable stage vocabulary | Implemented and tested locally |
| JSONL observation/resume of durable stage records | Implemented and tested locally |
| Initial layout/configuration and first-release pointer semantics | Implemented and tested locally |
| Privileged SSH/bootstrap command, artifact transport, service manager execution | Designed, not implemented |
| Administrator enrollment and post-enrollment pairing handoff | Blocked pending security design/review |
| Live VM acceptance | Not attempted; requires Gate B2 authorization |

The iOS client must treat this as a mockable local contract, not as an exposed
Server API. It must pin the SSH host key before invoking a future fixed,
structured bootstrap command and may resume observation of a known attempt
only after target identity matches.

## Required fresh-host adapter (remaining work)

The future privileged bootstrap command must:

1. verify Debian/ARM64, systemd, disk capacity, Node runtime compatibility, and
   absence of an existing Sonuvi layout;
2. create root-owned release/state directories and a non-login service account;
3. initialize minimum non-secret shared configuration from a reviewed schema;
4. verify a signed/hashed release artifact and publish it immutably;
5. render and install only the approved Sonuvi API/web systemd units;
6. perform first-release activation with a first-install checkpoint, rather
   than weakening upgrade rollback semantics;
7. report durable stage records that survive SSH/iOS disconnection; and
8. enter a short-lived first-administrator enrollment state.

It must be invocable from SSH and future administration tooling, with a fixed
command and structured I/O. It must not accept arbitrary shell, release URL,
or secret material from iOS.

## Administrator and pairing finding

Existing mobile pairing provides device-bound, short-lived proof-based pairing
and mobile bearer sessions. Existing `/config/*` routes are browser-oriented
and use the historical track-key authorization boundary. Neither is a first
administrator enrollment protocol. Gate B cannot claim secure fresh-server
enrollment until a separately reviewed administrator authority model is
implemented.

## Native configuration API coverage

| Area | Existing API/surface | Native-admin status |
| --- | --- | --- |
| Server identity/health | Health/runtime routes and release identity verifier | Read components exist; no versioned admin identity contract. |
| Library/catalog | `/v1/mobile/catalog/*`, `/v1/mobile/search`, config library-health routes | Mobile read coverage exists; administration/index jobs need a dedicated API. |
| Playback/moOde | `/v1/mobile/now-playing`, queue/control routes; config runtime/moOde routes | Controller APIs exist; configuration must be separated from controller scope. |
| DLNA | Existing DLNA/UPnP and web configuration behavior | No versioned native administrative contract. |
| Integrations | Config runtime/integration-specific routes | Browser-oriented; credentials must stay write-only/redacted. |
| Device access | `/v1/mobile/pairing/*`, sessions, push tokens | Pairing exists; administrator enrollment/revocation model is missing. |
| Updates/backups/maintenance | Release operations and guarded restart controls | No native asynchronous maintenance-job API. |

No draft `/v1/admin/*` endpoint is implemented. Any iOS work must use mocks
for those proposed endpoints until Server implementation and acceptance exist.

## Gate B next controlled action

Gate B1 is **PARTIAL**, not PASS: the isolated core and regressions are in
place, but the SSH/bootstrap transport, service-manager adapter, administrator
enrollment, and a disposable-VM acceptance run remain. The VM must stay off
until separately authorized for Gate B2. The production Pi5, moOde, and the
baseline remain out of scope.
