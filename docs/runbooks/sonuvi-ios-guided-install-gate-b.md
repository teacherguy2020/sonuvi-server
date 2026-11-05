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

## Gate B1.5 secure bootstrap foundation

Status: **PARTIAL; isolated and tested, not a live transport or VM result.**

### Bootstrap transport contract

`src/lib/sonuvi-bootstrap-security.mjs` defines version 1 JSON-lines protocol
validation for only these operations: `preflight`, `install`, `status`,
`enrollment_create`, and `enrollment_claim`. It rejects command-, path-, and
credential-shaped payload fields. SSH remains a transport only: a future Swift
client must use strict host-key pinning, explicitly ask before first trust, and
reject a changed key. The implementation includes the matching host-key policy
and structured response envelope, but deliberately does not embed an SSH
client or expose a Server network endpoint yet.

Initial authentication is therefore **proposed**: a prepared target must be
reached through a user-selected SSH account/key or an explicit one-time
bootstrap credential outside command arguments and logs. A future fixed remote
bootstrap executable may accept only the protocol records above, bind every
request to its pinned machine identity and installation attempt, and resume by
reading that attempt's durable journal.

### Privileged-operation boundary

`src/lib/sonuvi-privileged-provisioning.mjs` provides an injected, constrained
host adapter for fixture and future root-owned-helper use. Its exact allowlist
is: `write_units`, `daemon_reload`, `enable_start`, `verify_health`, and
`cleanup_attempt`. It accepts no executable, arbitrary service, arbitrary path,
or shell fragment. Only `sonuvi-api.service` and `sonuvi-web.service` can be
enabled/started; cleanup requires an attempt-specific ownership marker. The
caller must supply the same target identity and attempt ID for every operation.

This is not yet installed as sudo, polkit, setuid, daemon, or remotely exposed
host service. That integration requires a separate least-privilege packaging
review and is still a Gate B2 prerequisite.

### First-administrator enrollment lifecycle

`FirstAdministratorEnrollment` creates a random short-lived enrollment token,
persists only its SHA-256 hash, and binds the pending claim to the target
identity and installation attempt. An exclusive state lock serializes competing
claims. A successful claim stores the administrator device ID and public-key
hash, permanently consumes the enrollment state, and causes all later/replayed
claims to fail. Expired or revoked pending claims cannot be used. The raw token
is never written into journal/state records.

This is a local enrollment primitive, not a public route. It remains separate
from controller/mobile bearer sessions and the historical Track Key. Pairing
handoff and a durable administrative credential format are intentionally not
yet implemented.

### Security review

| Threat | Current B1.5 behavior | Remaining work |
| --- | --- | --- |
| Unknown/changed SSH host key | Explicit first trust only; changed key fails | Native SSH/keychain implementation |
| Arbitrary remote command | Protocol and privileged adapter reject it | Fixed remote helper packaging |
| Competing claims/replay | Exclusive lock, hash comparison, claimed terminal state | Crash-safe claim transaction review on target filesystem |
| Expired enrollment | Explicit expiry and no claim | UI recovery flow |
| Controller-to-admin escalation | No bearer/Track Key accepted by enrollment | Admin credential/API design |
| Secret/log leakage | Token is hash-only at rest; protocol rejects sensitive named fields | End-to-end process/SSH audit |

### B1.5 tests and dependency result

`test/sonuvi-bootstrap-security.test.mjs` exercises host-key pinning, explicit
first trust, changed-key refusal, fixed-operation validation, enrollment
expiry/replay/target binding, and constrained privileged cleanup. After the
authorized `npm ci --ignore-scripts` from the existing lockfile, the complete
suite passed: **562/562**. It did not alter dependency definitions. The local
audit reported nine upstream advisories; no dependency upgrade was performed.

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

Gate B1.5 is **PARTIAL**, not PASS: isolated policy/provisioning/enrollment
primitives and regressions are in place, but a real fixed SSH bootstrap helper,
least-privilege host packaging, administrator credential/API design, pairing
handoff, and a disposable-VM acceptance run remain. The VM must stay off until
separately authorized for Gate B2. The production Pi5, moOde, and the baseline
remain out of scope.

## Gate B1.6 fresh-install integration and VM readiness

Status: **PARTIAL; integrated fixtures pass, but no target-side privilege
package, public admin API, pairing handoff, or VM validation exists.**

### Packaged helper and integrity model

The fixed JSON-lines entry point is `scripts/sonuvi-bootstrap-helper.mjs`; it
is now included in immutable release artifacts and its static import closure is
verified with the release. `src/lib/sonuvi-bootstrap-helper.mjs` supplies a
versioned helper descriptor and SHA-256 verification. The future iOS client
must receive the expected digest from a trusted signed Sonuvi release manifest
or separately pinned distribution metadata—not from the same download channel
as an untrusted helper. It stages the helper in a fixed target-owned location,
verifies before invocation, and removes only its own verified staging file.

The helper consumes at most one bounded JSON request per line and returns one
structured response. It supports only the B1.5 fixed operations, binds each
request to attempt and target identity, has a bounded timeout, and emits no
credential material. Its source entry point intentionally has no installed
privileged dispatcher yet; invoking that unconfigured entry point fails closed.

### Integrated installation state machine

`FreshInstallOrchestrator` coordinates real injected operations in this order:

`preflight → release_verification → checkpoint → configuration → activation →
health_verification → administrator_enrollment → awaiting administrator claim
→ pairing_ready → complete`.

Every start/pass/fail record is appended to the existing fsync-backed JSONL
journal and an atomic installation state is written after each durable phase.
An interrupted observer can read the journal and state, but the implementation
does **not** claim an in-flight host operation survives process termination.
Failure records `recoverable-incomplete`; first-release cleanup never claims a
previous release exists.

### Administrator authority

`AdministratorAuthority` completes a successful enrollment claim into a
separate protected administrator identity and random signing key. It issues
short-lived administrator-only tokens and `requireAdministratorAuthorization`
validates them independently of mobile bearer sessions and the Track Key. No
HTTP route is registered yet: a future native-admin route layer must be
reviewed separately rather than widening existing configuration authentication.
Revocation removes this authority's protected identity/key material. Existing
mobile pairing behavior is unchanged; the first-controller pairing handoff is
therefore still **blocked**, not replaced.

### Privilege boundary and target readiness

The constrained adapter remains an injected fixture seam with only the fixed
unit/systemd/health/attempt-cleanup operations. It is not a sudo policy,
setuid executable, polkit action, root daemon, or generic remote command API.
The exact target packaging and lifecycle (including how temporary elevation is
approved and removed) need a dedicated Linux security review before Gate B2.

### B1.6 validation and npm advisories

Focused helper/authority/orchestration/fresh-install/release tests pass
**28/28**. The full suite passes **566/566** on repeat. One initial concurrent
run observed an existing listening-history shadow-mode assertion before its
asynchronous qualification completed; that test passed in isolation and on the
full repeat, with no bootstrap code on its path. `npm audit` reports nine
upstream advisories: 2 critical, 5 high, and 2
moderate. Direct runtime dependencies implicated include `fast-xml-parser`
(critical), `sharp` (high), `undici` (high), and `express` through `qs`.
`fast-xml-parser` is reachable through UPnP/XML parsing and these issues must
be addressed by a separately authorized dependency-maintenance release before
production promotion or public bootstrap exposure. No dependency versions were
changed in this work.

## Gate B2 readiness package

Status: **PARTIAL; package-level readiness improved, but no target-side
least-privilege installer or VM acceptance exists.**

### Dependency remediation

The locked production dependency set is updated to `express` 5.3.0,
`fast-xml-parser` 5.12.0, `sharp` 0.35.5, and `undici` 6.29.1. A post-update
`npm audit --json` reports zero vulnerabilities. XML/DIDL/SOAP, mobile HTTP,
bootstrap, and full-suite compatibility tests are required evidence for this
major Express / Sharp update. The supported Node floor is now **20.9.0**,
because patched Sharp requires it; fresh-host preflight must reject older Node
runtimes. No production host was changed.

### First-controller handoff

`authorizeFirstController` requires a valid administrator-only token before
issuing the existing `mobile-api` / mobile-refresh bearer format for the
controller device. It records only a hash of its access token with the
administrator identity in protected state. The administrator token is never
embedded in the controller token, and a controller token cannot satisfy the
administrator guard. This is an internal integration primitive, not a newly
registered HTTP endpoint; existing pairing routes and production behavior stay
unchanged pending a dedicated route/API review.

### Candidate manifest

`buildGateB2ReadinessPackage` produces a non-executing, protected manifest of
the fixed helper, lockfile, and canonical service templates. It records each
SHA-256 and does not start a service, access a VM, or invoke host privilege.
The immutable release artifact itself must still be built and verified using
the ARM64 dependency pipeline during the separately authorized VM acceptance
preflight.

### Remaining Gate B2 blockers

1. A reviewed target-side package for the fixed helper plus a one-time,
   least-privilege elevation mechanism. No generic sudo rule, setuid helper,
   or network service is authorized or implemented.
2. A reviewed native-admin route/API layer and integration of first-controller
   handoff with existing pairing endpoints.
3. An ARM64 candidate artifact/release manifest built with Node 20.9+ and the
   updated dependencies.
4. Separate approval to boot the disposable VM and execute the controlled
   acceptance procedure.

## Executable fresh-install path (2026-11-04)

Status: **implemented and fixture-tested; pending ARM64 VM acceptance.**

`scripts/sonuvi-target-installer.mjs` is the fixed target-side entry point.
It is a local, root-only executable intended for an explicitly authorized
`sudo` invocation over the pinned SSH bootstrap transport. It reads one JSON
request from standard input and has no listener, shell parser, arbitrary
command field, configurable service field, or caller-controlled filesystem
path. Its only accepted fields are the installation attempt ID, target
identity, immutable release ID, and new Server identity.

`src/lib/sonuvi-target-installer.mjs` fixes the host locations to
`/opt/sonuvi`, `/var/lib/sonuvi`, `/etc/systemd/system`, and the verified
bootstrap staging location. It rejects an existing or incomplete Sonuvi
layout, requires Linux/ARM64, systemd, root authorization, at least Node
20.9, sufficient space, and a verified staged immutable artifact. It then
creates fresh state, copies and re-verifies the immutable release, writes only
the canonical API/web unit files, invokes only fixed `systemctl` verbs for
those two units, performs first-release activation, and stops at
`awaiting-administrator-enrollment`. It never invents a prior rollback
release. Failure removes only the candidate copied by this attempt; it does
not remove unrelated host state.

The installed Server registers `GET /v1/admin/bootstrap/status` and
`POST /v1/admin/bootstrap/first-controller` only when fresh-install
administrator authority exists. Both require the separate administrator
bearer token. The controller endpoint issues the existing mobile bearer/refresh
format and records only a token hash, so controller scope remains distinct
from administrator scope. Established installations with no administrator
authority retain a 404 at these routes.

This is not yet evidence of a physical ARM64 install: the target executable,
systemd behavior, artifact runtime closure, and APIs have passed isolated
fixtures only. Build the immutable ARM64 artifact from this committed source,
verify it with the normal release verifier, then use the preserved disposable
VM for the first controlled acceptance attempt after its separate authorization.

## Gate B2 administrator enrollment and first-controller handoff (2026-11-04)

Status: **implemented and fixture-tested; requires a new clean-VM acceptance
run.** This section supersedes the earlier historical notes that describe the
administrator route as unimplemented.

### Fixed enrollment transport

`scripts/sonuvi-admin-bootstrap.mjs` is a root-only, local companion to the
fixed target installer. It accepts exactly one JSON request over stdin for one
of two operations:

- `enrollment_create` creates a ten-minute, single-use first-administrator
  proof only when the durable first-install state is
  `awaiting-administrator-enrollment`.
- `enrollment_claim` consumes that proof with a P-256 device public key and a
  P-256 signature over the installation attempt, target identity, device ID,
  and proof value.

The helper reads the attempt and target identity from protected installation
state; callers cannot select another path, release, host, service, or command.
It stores only a SHA-256 enrollment-token verifier, public-key fingerprint,
and claim state. If the controller disconnects after the claim record is
durable but before completion is recorded, only the same enrollment token and
same P-256 device proof can resume that claim. The raw enrollment proof and
resulting short-lived administrator token exist
only in the encrypted SSH stdin/stdout exchange and must not be copied into
logs, journals, reports, process arguments, or persistent state.

Fresh installation creates a unique mobile API signing secret and a separate
P-256 administrator-signing key. The private administrator key and identity
remain root-only in `protected`; its non-secret verification key is provisioned
as `root:sonuvi` configuration so the unprivileged API can verify administrator
bearers without ever reading a private key.

### Controller handoff

After a successful claim, the existing
`POST /v1/admin/bootstrap/first-controller` route accepts only the separate
administrator bearer and issues the existing mobile access/refresh formats.
The resulting controller bearer cannot call administrator endpoints. The API
may record only the controller device ID and access-token hash in its approved
application data directory; it cannot write protected admin credentials,
configuration, checkpoints, or installation state. A second device is refused;
the same first device can be retried safely. Controller refresh tokens and
administrator-token verification survive a normal API/web restart because the
fresh per-server mobile secret and public verifier are durable.

### iOS/SSH sequence

1. Pin the target SSH host key and invoke the fixed installer with explicit
   local elevation.
2. Invoke `sonuvi-admin-bootstrap.mjs` `enrollment_create` through the same
   authenticated SSH session and retain the returned proof only in the native
   client's secure memory/keychain flow.
3. Create a P-256 device key locally, sign the documented claim tuple, and
   send the `enrollment_claim` JSON over SSH stdin. Never put the proof or
   administrator token on a command line.
4. Use the returned short-lived administrator bearer over the pinned local
   connection to call admin status and authorize the first controller.
5. Store only the normal mobile refresh credential for controller use; do not
   treat it as administrator authority.

Fixture coverage proves target/attempt binding, P-256 proof validation,
pending/expired/replayed-claim refusal, secret redaction, durable public-key
verification after restart, controller/admin separation, mobile refresh, and
first-controller uniqueness. Physical VM acceptance remains required before
marking Gate B2 complete.
