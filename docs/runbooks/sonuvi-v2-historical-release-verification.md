# Sonuvi v2 historical-release verification correction

Status: source-only correction ready for protected signing. This change does
not publish artifacts, activate a release, modify a VM, modify iOS, push, or
merge.

## Failure and correction

The first v2 in-place upgrade failed during `verifyReleaseArtifact()` while
the candidate verifier validated the installed historical release. The
historical release predates `scripts/sonuvi-admin-session.mjs`; applying the
current unversioned runtime-entrypoint list to that release rejected it before
the upgrade lock, journal, service adapter, or systemd activation ran.

The correction is in `src/lib/release-artifact.mjs`:

- Newly built releases declare `sonuvi.release-runtime.v2` and the complete
  current runtime-entrypoint set in their signed manifest structure.
- v2 manifests must retain that exact current set, including the administrator
  session entrypoint.
- Legacy manifests derive their runtime closure from the entrypoints actually
  recorded in their own signed file inventory. Their manifest inventory,
  payload hash, identity hash, target, dependency inventory, and outer signed
  release metadata remain mandatory.
- Inventory validation runs before runtime-closure validation, so missing or
  changed historical files still fail closed while a legitimately older
  runtime contract remains verifiable.

## Evidence

- `test/historical-release-compatibility.test.mjs` uses the actual historical
  archive `sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912`
  and the published v2 archive structure. It covers historical acceptance,
  v2 administrator-session retention, missing files, modified hashes, altered
  manifests, and invalid v2 entrypoint declarations.
- `scripts/test-linux-systemd-historical-fixture.sh` runs a fresh Debian ARM64
  systemd container with those real archives installed as root-owned immutable
  release trees. It proves activation, API/web identity and health checks,
  rollback, interrupted recovery, and preserved shared state.
- The existing `scripts/test-linux-systemd-upgrade-fixture.sh` remains green.

Validation performed for this correction:

- Focused correction/activation suite: **23 passed**.
- Historical systemd fixture: **3 passed**.
- Existing systemd fixture: **4 passed**.
- Complete Server suite with locked dependencies: **646 passed, 4 host-backed
  Mac systemd-fixture failures, 1 environment-gated skip out of 651**. The
  four failures are the pre-existing direct fixture `chown` limitation on the
  gateway's `/Users/.../.openclaw/tmp` bind layout; the Linux Docker fixture is
  the authoritative systemd execution proof.

## Protected signing handoff

The protected signing custodian must build a replacement release from the
exact correction commit containing this document. The previously published v2
archive, v2 bootstrap kit, envelope, release ID, and checksums must not be
reused.

1. Build a fresh Linux/ARM64 archive and matching v2 bootstrap kit from the
   clean correction commit.
2. Use the existing protected Ed25519 custodian and established signer key ID
   `sonuvi-lab-gate-c-20261105`; do not generate or substitute a key.
3. Bind the envelope to the newly built archive digest, byte count, manifest
   digest, bootstrap-v2 digest, target, and expiry. Publish only a new
   immutable directory through the established TLS/SPKI distribution identity.
4. Independently verify the archive, bootstrap capsule, manifest, envelope,
   and live TLS-served bytes before providing the iOS inventory.
5. Return the new release ID, manifest/archive/bootstrap/envelope SHA-256
   values and byte counts, signer key ID, and immutable endpoint. iOS must
   replace its approved-release inventory with those values; the old v2
   inventory is not compatible with this correction.

No signing or publication is authorized by this source handoff. Deployment
remains a separate approval step.
