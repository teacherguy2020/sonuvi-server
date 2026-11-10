# Gate C v2 bootstrap-kit replacement contract

Status: source implementation and disposable Linux validation only. This is
not a signed capsule, publication, or target deployment.

## Purpose and trust boundary

The iOS app supplies the fixed `scripts/sonuvi-sftp-bootstrap-activate-v2.sh`
capsule through the existing interactive-sudo SSH operation. The root-installed
kit does not execute or authorize that capsule. The capsule is pinned by the
iOS source; before candidate code is made active, it independently verifies
the signed release envelope using `/etc/sonuvi/release-trust-anchors.json`,
the content-addressed kit digest and size, the exact v2 kit inventory, and
trust-anchor continuity by exact key IDs and Ed25519 SPKI public-key material.
Equivalent PEM/JSON serialization whitespace is not treated as a key change.
Candidate files are treated only as data during verification.

The v2 staging directory is unchanged:

```text
<SFTP home>/.local/share/sonuvi-bootstrap-v2/
```

The verified final kit path is:

```text
sonuvi-bootstrap-kit-v2-<64 lowercase hex SHA-256>.tar
```

An in-progress upload uses the same digest with `.tar.partial`. A staged file
is reusable only after the client checks its content digest. The privileged
capsule independently opens the exact final path without following symlinks,
checks owner/mode/size, copies it into a root-only transaction directory, and
checks the digest again.

## Replacement request

`sonuvi.gate-c-bootstrap-kit-replacement.v1` accepts only the fixed operation
`replace_bootstrap_kit`. Its command arguments are, in order:

1. Durable `bkr_<UUIDv4>` operation ID.
2. Locally re-derived `sonuvi-target-v1-*` identity.
3. Expected currently installed Server release ID.
4. Expected active bootstrap-kit SHA-256.
5. Signed replacement release ID.
6. Signed replacement kit SHA-256.
7. Signed replacement kit byte count.
8. Base64url signed release envelope.

The root capsule verifies all bindings: local target identity, current release
pointer and manifest identity, active kit marker and full inventory, signed
envelope/key/expiry, replacement release identity, version 2, kit digest/size,
candidate manifest key/release/target, exact tree, and unchanged trust-anchor
key IDs and public-key material. The signed release ID must differ from the
current installed release.
No caller-supplied paths, services, helper names, URLs, or shell fragments are
accepted.

## Durable transaction and atomic promotion

The common admission lock is:

```text
/var/lib/sonuvi-bootstrap/bootstrap-admission.lock
```

The capsule creates/validates that root-owned lock under the existing
root-owned mode-0700 bootstrap directory and acquires it non-blocking before
starting Node or reading mutable privileged helper paths. Updated iOS clients
must hold this same lock around root-side release staging, activation, and
recovery by running fixed helpers through `/usr/bin/flock` before
`/usr/bin/node` is started. The unprivileged SFTP upload itself does not take
the root lock: it uses a digest-specific name, exclusive temporary creation,
and no-overwrite promotion, so distinct kits do not share a mutable destination.
The fixed example is:

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/flock -n /var/lib/sonuvi-bootstrap/bootstrap-admission.lock /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v2/scripts/sonuvi-release-stage.mjs
```

The same fixed prefix applies to `sonuvi-existing-install-upgrade.mjs` and
`recover_interrupted_upgrade`; the Server contract module exposes only these
fixed helper paths. It does not change sudoers or grant additional
passwordless authority. The v1 first-install path is unchanged.

Historical v2 helpers do not know the common lock. Before the first
replacement, the operator must provide an exclusive maintenance window; the
capsule also rejects if it observes any running fixed historical privileged
bootstrap/release helper or an unresolved release transaction. This process
check is an additional guard, not a substitute for the exclusive window.

Bootstrap replacement journals live below:

```text
/var/lib/sonuvi-bootstrap/bootstrap-kit-replacements/<operation-id>/journal.json
```

Journal files are root-owned mode 0600 inside root-owned mode-0700
directories. They bind the target, prior Server release, prior kit digest,
replacement release, replacement digest/size, signed-envelope digest, and
operation identity. Candidate extraction is staged in that same filesystem.
Promotion uses Linux `renameat2(RENAME_EXCHANGE)` only. If the kernel/filesystem
does not support this operation, replacement fails closed; no two-rename or
copy/delete fallback is permitted. After exchange, the former active kit is
retained at `<operation-dir>/previous` for rollback.

Bootstrap journal states are `preparing`, `prepared`, `promoted`,
`committed`, `rollback_prepared`, `rolled_back`, and
`aborted_before_promotion`. Recovery compares the durable state with the
verified active/candidate/previous markers, then finalizes or aborts without
deleting evidence. Repeat invocation with the same operation ID succeeds only
when every recorded binding and the active/previous trees still verify.

The Server release transaction remains separate and continues to own
`/var/lib/sonuvi/checkpoints/release-activation.lock` and
`release-upgrade-state.json`. A present release lock, corrupt journal, or
nonterminal journal blocks bootstrap replacement/rollback. If bootstrap
rollback itself was interrupted while a Server release transaction is
unresolved, recovery retains the newer kit required by that transaction.

## Fixed recovery and rollback calls

Recovery command arguments are:

```text
recover_bootstrap_kit_replacement <operation-id> <target-identity>
```

Explicit rollback command arguments are:

```text
rollback_bootstrap_kit <operation-id> <target-identity> <replacement-kit-sha256> <previous-kit-sha256>
```

Both use the same pinned capsule source and interactive-sudo framing. Recovery
is safe to repeat; it does not execute code from the replacement archive.
Rollback is permitted only from a committed replacement, verifies both kit
trees and the target, and refuses while Server release recovery is pending.
Normal replacement preserves the existing Server identity, configuration,
administrator/controller records, library/index state, and SSH authorization
because it swaps only `/var/lib/sonuvi-bootstrap/bootstrap-kit-v2`.

Responses are one bounded JSON object on stdout. A bounded diagnostic on
stderr is a fixed typed code for wrapper-level failures. Once the Node capsule
is running, it uses
`sonuvi_bootstrap_kit_replacement_v1:<typed-code>:<fixed-phase>`; both fields
are allowlisted, and the phase is selected from the operation state rather
than arbitrary exception text. The response carries only a reviewed state/code
and operation, target, release and kit bindings. It never includes paths,
exception text, archive contents, credentials, or key material.

The implementation's fixed capsule SHA-256 is
`6535738585f8f14c4f0c8b43ee927c6a7195041c881ced9b5470693140bad88d`.
This is source identity only: it is not a signed or published artifact.

## Required iOS integration

The current Server-side source contract is not yet an iOS client integration.
Before a live migration, the iOS change must:

1. Pin the capsule digest above and use the existing v2 content-addressed SFTP
   directory and filename, without changing the v1 first-install path.
2. Invoke `replace_bootstrap_kit` through the existing interactive-sudo SSH
   framing with the exact target, installed-release, prior-kit, signed-release,
   replacement-kit digest/size, operation ID, and verified signed envelope.
3. Strictly decode the bounded typed response; expose the fixed recovery and
   rollback operations without accepting arbitrary command/path input.
4. Acquire the common admission lock before running the replaceable root-side
   release-stage, activation, or recovery helper. Keep the SFTP upload itself
   unprivileged, digest-addressed, exclusive, and no-overwrite.
5. Preserve the v1 first-install behavior and the existing TLS, Ed25519, SSH
   host-key, and interactive privilege checks.

The initial transition from historical helpers must only run after confirming
exclusive maintenance: those old processes do not honor the new lock. The
capsule's process scan is an additional guard, not a complete substitute for
that operational precondition.

## Historical compatibility and publication

The migration fixture uses the actual published historical kit
`91b2d8cc171e5106ca87102a50e3e29392680f52b748c02ac9c5926a71d1b63d` and the
actual corrected kit
`aec02a0ad716f6c979b2b2099099d913bee773e651f7159c402b022dfe113243`. It also
uses their published release envelopes and the actual historical/current
Server archives. Generated fixtures supplement negative and interruption
cases; they do not replace the historical transition test.

The source commit produces a new fixed capsule digest. The next v2 signed
publication must be rebuilt from one clean committed source revision and must
bind that exact capsule in the approved iOS inventory/command contract. The
existing trust anchor, TLS/SPKI pins, release endpoint, and immutable older
directories are not changed by this source task. Signing, publication, and
deployment remain separate approvals.
