# In-place upgrade preparation — 2026-11-09

## Current implementation and validation

The existing `src/lib/release-activation.mjs` transaction now accepts an
explicit `stateRoot` for an already installed host. Omitting it retains the
historical disposable H3 behavior. Installed mode never creates the layout,
initializes configuration, enrolls an administrator, edits SSH authorization,
or changes controller credentials. It validates physical separate code/state
roots, ownership and permissions, verified previous/candidate artifacts,
the existing Gate C signature and manifest digest, the explicitly expected
previous release ID, and catalog schema compatibility before acquiring its
exclusive lock or calling the service adapter.

The installed mode uses `release-upgrade-state.json` under the existing state
checkpoints directory, with the existing activation state contract. It does
not overwrite `release-activation-state.json`. That distinction is necessary:
the installed `verify-current-release.mjs` permits only candidate startup
phases and the exact release ID. A `rolling-back` checkpoint for the new
candidate cannot start the old binary. Checkpoint ownership/group/mode must
also remain service-readable; the generic atomic writer defaults to 0600.

The same existing transaction performs pointer switch, paired service identity
verification, health verification, rollback, and interrupted recovery. Installed
mode requires explicit `{quiesced:true}` from `prepare()` and health containing
both `ok:true` and the expected `releaseId`; a boolean or service-active flag
alone is insufficient. An H3 traffic-marker file is NOT proof that Gate C
clients have been gated. A failed rollback retains the lock for explicit
recovery. Previous and candidate release directories are retained.

Offline tests cover signatures, manifest mismatch, expected previous identity,
unsafe roots, successful activation, missing quiescence, unbound health,
rollback failure and interrupted recovery. Synthetic administrator-v1,
administrator verifier, controller, Server identity, configuration, catalog,
and startup checkpoint bytes remain unchanged. These tests use an injected
service adapter; they are NOT a real systemd/VM upgrade acceptance.

Validation: full Server suite 636 passed, one environment-gated skip, zero
failures, using `TMPDIR=/private/tmp npm test` with loopback fixtures enabled.
Focused activation suite: 11 passed. `git diff --check` passed.

## Approved target procedure; not yet executable on the VM

1. Obtain deployment approval naming the VM machine/SSH identity, installed
   previous release, candidate release, and exact reviewed operator-helper
   revision. Reverify these identities through pinned SSH. Do not reset the VM.
2. Verify the Gate C envelope with the existing trusted Ed25519 public anchor,
   validity, Linux ARM64 target, archive length/digest, bootstrap digest and
   manifest digest. Use the existing bounded archive staging/verifier rules.
   Promote a verified immediate child of `.staging` using
   `promoteStagedHostRelease`; never overwrite a release or change `current`
   during staging. Recheck runtime ABI/prerequisites and service-user access.
3. Capture the effective API/web units and drop-ins, enablement, original
   startup checkpoint bytes/ownership/mode, and a consistent protected-state
   backup. Keep secrets out of the evidence report. Confirm the candidate
   requires no persistent schema migration; otherwise stop for a separately
   reviewed migration and data rollback plan.
4. A reviewed host service adapter must preserve all existing configuration,
   stop/drain both coupled units (without changing enablement), verify they
   cannot auto-restart during the switch, and return confirmed quiescence.
   Do not reuse first-install `enableAndStart`/`disableAndStop`, account
   provisioning, signing-material initialization, or enrollment routines.
5. Update only necessary release-specific unit environment values, preserving
   unrelated directives/drop-ins. Persist recovery material before modifying
   units. After the pointer switch, publish a service-readable, old-verifier-
   compatible startup checkpoint for the candidate, reload units, and start
   API/web. The operator adapter must verify actual process release identity
   and HTTP API/web health, not infer identity from a requested release ID.
6. Commit only after both services and authenticated controller access pass.
   Keep the previous immutable release and original unit/checkpoint backup.
   Do not rewrite first-install attempt or enrollment journals as an upgrade.

## Rollback and interrupted recovery

The existing transaction restores the verified previous pointer and calls the
adapter's `rollback()`. That adapter must stop both candidate services, restore
the original unit bytes/drop-ins and startup checkpoint including permissions,
reload systemd, then start the old pair. Verify their actual release identity,
HTTP health, and controller access before reopening traffic. Never execute
code from a corrupt candidate during recovery. If the previous release is
missing/corrupt, units cannot be restored, or old health fails, leave the lock
and services gated; report manual recovery required. Do not retry activation.

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

## Candidate and open deployment gates

The untouched application candidate is:

- Source: `4bb67b8e8a5ab4a0e9bb7feba622abea76538208`.
- ID: `sonuvi-de601336d24fcba9a97c18037319def54edabdead221fa2115a662c2f37293dd`.
- Root: `/Volumes/SammySSD/Sonuvi-Codex/sonuvi-native-settings-candidate-20261109-4bb67b8/release`.
- Manifest SHA-256: `06c0a02d61b624bea685c9c417cccf3116f439557c6196c5a578983ab40ab771`.
- Artifact verifier rerun successfully on 2026-11-09. Source remains clean.

These operator transaction changes are a separate source checkpoint, not
part of that immutable candidate. Rebuilding the application from this newer
commit would produce a different release identity; never relabel it as the
candidate above. Do not run an unreviewed copied helper as root.

OPEN: no callable protected signing/publishing command or signer-provider
interface was found in the reviewed repository or public lab distribution
handoff. The distribution service is GET/HEAD-only and contains no signing
key. The signing custodian must package the exact verified candidate and
reviewed bootstrap, use the existing Ed25519 signer to sign canonical Gate C
metadata (new validity, exact manifest/archive/bootstrap digests and archive
length), independently verify it, and publish a NEW immutable directory with
checksums and signer/TLS continuity evidence. Return envelope digest, all
artifact digests, and the exact HTTPS location. Do not substitute a new key,
modify the current release, or claim the unsigned directory is deployable.

OPEN: a concrete host service adapter/entrypoint with the unit/checkpoint
preservation and HTTP/process checks above has NOT been implemented or
validated on Linux systemd. The existing first-install adapter fabricates a
release ID from `is-active` and changes enablement, so it is not suitable.
Before VM deployment, implement/review this adapter against the actual
read-only effective unit inventory, test it in an isolated systemd fixture,
and bind its exact source/hash to operator authorization. This document and
the offline transaction tests do not close that gate.

No VM, service, iOS, production, baseline, or current publication was changed.
