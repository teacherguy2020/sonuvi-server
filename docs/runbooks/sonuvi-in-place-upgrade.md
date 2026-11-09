# In-place upgrade implementation checkpoint — 2026-11-09

## Current implementation and validation

Validation performed 2026-11-09 from the completed source worktree:

- Focused release-transaction, release metadata, SFTP bootstrap, v2 kit,
  distribution, response-contract, and systemd-adapter tests: **36 passed, 0 failed**.
- Full Server regression (`TMPDIR=/private/tmp npm test`, after restoring the
  exact lockfile dependencies): **649 passed, 1 skipped, 0 failed**.
- Disposable Debian 13 ARM64 systemd integration: **4 checks passed** for
  successful activation, health-failure rollback, interrupted recovery, and
  exact process release identity/startup-checkpoint preservation.
- Shell syntax, changed JavaScript syntax, and `git diff --check`: passed.

These are source/fixture validation results, not a signed release, publication,
or upgrade of the paired disposable VM.

`src/lib/release-activation.mjs` remains the sole release transaction. Its
installed mode accepts an explicit state root and is distinct from first
install. It never creates the layout, initializes configuration, enrolls an
administrator, edits SSH authorization, or changes controller credentials.
Before its exclusive lock or adapter call, it validates separate physical
code/state roots, ownership and permissions, both immutable releases, signed
metadata and manifest digest, the exact previous release ID, and catalog
schema compatibility.

The installed mode uses `release-upgrade-state.json` under the existing state
checkpoints directory, with the existing activation state contract. It does
not overwrite `release-activation-state.json`. That distinction is necessary:
the installed `verify-current-release.mjs` permits only candidate startup
phases and the exact release ID. A `rolling-back` checkpoint for the new
candidate cannot start the old binary. Checkpoint ownership/group/mode must
also remain service-readable; the generic atomic writer defaults to 0600.

`src/lib/sonuvi-linux-systemd-upgrade.mjs` is the concrete Linux adapter. It
accepts only the two existing API/web units, snapshots their exact bytes,
effective configuration, ownership/mode, and the release-specific startup
checkpoint before stopping either service. It does not change unit enablement,
drop-ins, administrator/controller files, configuration, identity, or library
state. It atomically changes only the two release-bound environment lines,
reloads systemd, starts both services, checks their live `/proc` release
identity, and verifies API `/health` plus web `/release.json` against the exact
candidate. `ExecStart` runtime PID/timing fields and unordered systemd
dependency lists are normalized only for comparison; their configuration is
still compared.

The adapter retries only bounded transport-unavailable health reads while a
new process starts. A valid but mismatched health response is a hard failure.
Before each start it invokes `systemctl reset-failed` for the two fixed units,
which clears start-rate failure counters without changing service definitions
or enablement. The upgrade journal is `release-upgrade-state.json`; the
existing `release-activation-state.json` format remains owned by the installed
startup verifier and is restored byte-for-byte on rollback/recovery.

The tests cover signed metadata, manifest mismatch, expected previous
identity, untrusted roots, successful activation, missing quiescence,
unbound health, rollback failure, and recovery. An actual Debian 13 ARM64
systemd integration fixture is defined at
[`test/fixtures/systemd-upgrade/`](../../test/fixtures/systemd-upgrade/) and
run with [`scripts/test-linux-systemd-upgrade-fixture.sh`](../../scripts/test-linux-systemd-upgrade-fixture.sh).
It uses only a network-isolated disposable Docker container and generated
fixture releases. It exercises real `systemctl`, process identity, HTTP
health, state preservation, rollback, and interrupted recovery; it does not
modify the paired Gate C VM.

The paired production-like VM has NOT been upgraded. This is Linux adapter
integration evidence, not deployment or disposable-VM acceptance.

## Fixed existing-install invocation contract

This is the fixed server-side handoff expected from a compatible iOS Gate C
client. Every connection and command remains on the existing pinned SSH
channel; signed metadata is obtained from the fixed HTTPS release endpoint and
verified against the already provisioned Ed25519 anchor. A client that only
knows bootstrap kit v1 cannot invoke this path; the coordinated client release
must support bootstrap version 2, the v2 SFTP paths, and the fixed capsule
below. No alternate signing key, arbitrary shell, first-install activation,
or server-side URL fetch is introduced.

1. Verify the target preflight identity and pinned SSH key. Read the installed
   release identity through the existing fixed API `GET /health` over the
   pinned tunnel; require `sonuvi.health.v1`, `ok: true`, and a valid
   `release.releaseId`. Confirm the same ID from fixed web `GET /release.json`.
   The root-side transaction independently checks the actual `current` pointer
   against the submitted previous ID. Verify the v2 signed release envelope
   and require `bootstrap.version: 2`.
2. Transfer the exact signed bootstrap archive over SFTP to
   `~/.local/share/sonuvi-bootstrap-v2/sonuvi-bootstrap-kit-v2.tar`, using the
   existing no-resume temporary/final-file rules and the envelope's digest.
3. Invoke the fixed v2 capsule with only its validated digest and byte count:
   `/usr/bin/sudo -S -k -p '' /bin/sh -s -- <sha256> <bytes>`.
   The capsule source is `scripts/sonuvi-sftp-bootstrap-activate-v2.sh`; it
   accepts no remote path or command. It requires an existing Gate C install,
   an existing root-owned system trust anchor, and byte-identical v2-kit trust
   material. It never provisions/changes the trust anchor or changes services.
4. Stage the immutable archive via
   `/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-release-stage.mjs`.
   Preserve the existing stage framing: first sudo-password stdin line, then
   the fixed JSON header and signed archive stream. The helper validates the
   envelope, attempt/target binding, archive length/digest and release
   manifest before marking the attempt `release_staged`.
5. Invoke upgrade activation with the same interactive sudo stdin framing and
   one bounded JSON request on the helper's remaining stdin:
   `/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-existing-install-upgrade.mjs`.
   The request is exactly
   `{"operation":"activate_existing_install","attemptId":"<bound attempt>","targetIdentity":"<verified target>","expectedPreviousReleaseId":"<observed current>","envelope":<verified envelope>}`.
   The helper accepts no paths, service names, commands, URLs, or arbitrary
   release IDs. It independently re-verifies the envelope and current release.
6. For interrupted activation only, after reconnecting and verifying the same
   target identity, invoke the same fixed Node helper with
   `{"operation":"recover_interrupted_upgrade","targetIdentity":"<verified target>"}`.
   It uses the durable upgrade journal and saved unit/checkpoint backup; it
   does not rerun candidate activation.
7. Treat success only as the fixed typed response with the exact candidate and
   previous IDs, attempt, target, and transaction UUID. Then verify both
   service identities/health and normal authenticated controller access.

## Rollback and interrupted recovery

The transaction restores the verified previous pointer and calls `rollback()`.
The adapter stops the candidate services, restores unit/checkpoint bytes and
ownership/mode from its root-only per-transaction backup, reloads systemd,
clears start-rate failure counters, starts the previous pair, then verifies
their actual process release identity and bounded HTTP health before the
transaction reopens traffic. It never executes candidate code as a recovery
step. If the previous release is missing/corrupt, saved state fails integrity
checks, services cannot start, or old health fails, the upgrade lock remains
and the response is recovery-required. Activation is not retried automatically.

If the process stops during the earlier host-side release copy, before the
transaction journal is created, retry is allowed only when the exact
`.staging/<release-id>` child verifies as the signed immutable release. A
partial or mismatched child is left untouched and returns a typed staging
failure; this procedure never deletes or overwrites it. Preserve it for
inspection and obtain a separately reviewed cleanup/recovery step if needed.

This is code rollback only. Runtime writes made while candidate services run
are not reversed by a symlink switch. Persistent schema migration is excluded
from this increment. The protected backup and explicit restore authorization
are required for any subsequent data rollback.

## Legacy administrator identity

Upgrade preserves the legacy-v1 record unchanged. The first administrator
session must return `administrator_rebind_required`. Only an explicit
`rebind_administrator` request with original device ID, fresh P-256 proof,
matching original SPKI hash, pinned SSH and interactive sudo can upgrade the
record. Rebind rotates administrator signing material and returns no bearer;
issue a separate session afterward. Controller authority and SSH access do not
authorize rebind. Missing original proof requires an approved local recovery
ceremony; no remote replacement/enrollment is permitted. Rebind occurs after
upgrade acceptance, not inside release activation or rollback.

## Historical candidate and remaining release/deployment gates

The earlier untouched application candidate (historical; not suitable for this
upgrade) was:

- Source: `4bb67b8e8a5ab4a0e9bb7feba622abea76538208`.
- ID: `sonuvi-de601336d24fcba9a97c18037319def54edabdead221fa2115a662c2f37293dd`.
- Root: `/Volumes/SammySSD/Sonuvi-Codex/sonuvi-native-settings-candidate-20261109-4bb67b8/release`.
- Manifest SHA-256: `06c0a02d61b624bea685c9c417cccf3116f439557c6196c5a578983ab40ab771`.
- Artifact verifier rerun successfully on 2026-11-09. Source remains clean.

That candidate predates this upgrade transaction and v2 bootstrap adapter. It
must not be represented as containing them. The completed source commit must
be the source of a new ARM64 application archive; adding these `src/` files
changes the release payload identity, so the older release ID cannot be reused.

The new upgrade transaction and adapter are copied into the separate
`sonuvi-bootstrap-kit-v2.tar` by
`createGateCUpgradeBootstrapKit()`. The normal ARM64 release packaging also
includes these `src/` modules in its payload, but the root-only upgrade
entrypoint is delivered by the v2 kit. Therefore both artifacts must be built
from the same clean source checkpoint. The v2 kit manifest binds the exact
files, release ID, target and existing key ID; the canonical signed release
envelope binds its SHA-256 and `bootstrap.version: 2` alongside the archive
bytes/digest and release-manifest digest. The existing distribution endpoint
selects the fixed v1 or v2 kit filename from that signed version; no second
distribution service is required.

No signing or publication occurred in this task. The protected signer must
build both artifacts from the committed clean source, sign the canonical
metadata with the existing Ed25519 key, independently verify the envelope and
all hashes, and publish a new immutable directory using the existing TLS/SPKI
identity. The current read-only distribution service has no signing key.
Return the envelope and artifact digests, exact HTTPS endpoint, signer
continuity, and archive provenance for review. Do not relabel the old unsigned
candidate, replace a published release, or use a new key.

OPEN: no new signed v2 publication is available yet, and no updated iOS
client has been implemented/validated to transfer and invoke this versioned
path. Do not upgrade the paired VM until the signing custodian publishes the
new artifacts and the compatible client command/capsule is reviewed. No VM,
service, iOS, production, baseline, or current publication was changed by
this Server implementation task.

No VM, service, iOS, production, baseline, or current publication was changed.
