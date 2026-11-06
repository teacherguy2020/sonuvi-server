# Gate C Server contract for native iPad installation

**Status:** implementation contract and local test coverage complete; no
production change, GitHub push, merge, or VM mutation. This document is the
handoff for the native iOS transport. It supplements the accepted Gate B2
runbook and does not replace its first-administrator/controller separation.

## Security boundary

Every bootstrap operation travels over the iPad's pinned SSH connection. The
iPad never sends an arbitrary command, path, package name, URL, or service
name. It may invoke only the fixed operations below after explicit host-key
confirmation and SSH authentication.

The SSH host key proves that the iPad is talking to the pinned SSH endpoint;
it does **not** prove the target's machine identity. The fixed target
preflight derives a non-secret identity from local `/etc/machine-id`; every
root-side mutating operation derives that value again and rejects a mismatch.
Thus a changed/cloned machine ID, a different pinned SSH host, or a replayed
attempt cannot be converted into a successful release stage or installation
merely by reusing a preflight response.

The fresh-install API now binds to `127.0.0.1`. Administrator enrollment,
first-controller authorization, and normal controller bearer traffic are sent
to that loopback API over SSH `direct-tcpip`; they must not use LAN HTTP.

## 1. Signed release descriptor

The release distributor emits a canonical JSON payload, signed with a pinned
Ed25519 public key. iOS pins the same public key as the target's root-owned
`/etc/sonuvi/release-trust-anchors.json` map. The key map is not supplied by
the client and is not mutable bootstrap input.

```json
{
  "contract": "sonuvi.gate-c-release-envelope.v1",
  "keyId": "sonuvi-release-2026",
  "payload": {
    "contract": "sonuvi.gate-c-release-metadata.v1",
    "releaseId": "sonuvi-<64 lowercase hex>",
    "manifestSha256": "<64 lowercase hex>",
    "target": { "os": "linux", "architecture": "arm64" },
    "artifact": {
      "format": "sonuvi.release-tar.v1",
      "sha256": "<64 lowercase hex>",
      "bytes": 123
    },
    "bootstrap": { "version": 1, "sha256": "<64 lowercase hex>" },
    "issuedAt": "2026-11-05T00:00:00.000Z",
    "expiresAt": "2026-11-12T00:00:00.000Z"
  },
  "signature": "<base64url Ed25519 signature over canonical payload>"
}
```

There is deliberately no artifact URL, command, destination path, or
architecture override. The descriptor binds the bootstrap-kit digest, tar
byte count/digest, immutable release ID, manifest digest, ARM64 Linux target,
and expiry. Unknown key IDs, invalid signatures, URL fields, expired metadata,
different byte counts, or digest mismatches fail closed.

## 2. Fixed target preflight and prerequisite remediation

Before privilege authorization, iOS runs exactly this read-only command over
the authenticated pinned SSH session after it has independently verified and
staged the signed bootstrap-kit archive:

```text
/usr/bin/tar --extract --file "$HOME/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar" --to-stdout -- scripts/sonuvi-target-preflight.sh | /bin/sh
```

It accepts no arguments and returns exactly one JSON record:

```json
{
  "contract": "sonuvi.gate-c-target-preflight.v1",
  "operation": "target_preflight",
  "targetIdentity": {
    "contract": "sonuvi.gate-c-target-identity.v1",
    "algorithm": "sha256-machine-id",
    "value": "sonuvi-target-v1-<64 lowercase hex>"
  },
  "compatibility": {
    "os": "debian",
    "architecture": "arm64",
    "systemd": true,
    "supported": true
  }
}
```

The raw machine ID is never returned. `targetIdentity.value` is the only
identity value iOS may retain and send to subsequent fixed operations. A
malformed record, unexpected fields, `supported: false`, a changed identity,
or an unsupported Debian/ARM64/systemd target is terminal before
installation. This is a fixed inspection only; it exposes no caller path,
command, or general-purpose host inspection.

`scripts/sonuvi-debian-node-bootstrap.sh` is the root-only fixed remediation
operation invoked by the bootstrap activation capsule. Its `install` action
is the only mutating prerequisite remediation operation.

It accepts no package/repository/source arguments, never edits APT sources,
and uses only configured official Debian repositories. It preserves compatible
dependencies and otherwise installs this fixed package allowlist:

`nodejs`, `ffmpeg`, `python3`, `python3-mpd`, `python3-mutagen`,
`python3-requests`, `mpc`, `flac`, `curl`, and `openssh-client`.

It never requires or installs npm for the packaged runtime. It validates Node
20.9+, Python imports, and the required executable set after APT completes.
An unavailable repository or a Debian release that cannot provide Node 20.9+
returns an explicit failure.

On a truly blank target the signed bootstrap kit must be transferred through
the fixed `sonuvi.gate-c-sftp-bootstrap.v1` contract and its
`bootstrap.sha256` verified before the iPad invokes the fixed root
preflight/install operation. The authoritative transfer, no-follow copy,
root-side rehash, and SFTP recovery details are in
[`sonuvi-ios-gate-c-sftp-and-lab-tls.md`](sonuvi-ios-gate-c-sftp-and-lab-tls.md).
The iOS adapter needs a new typed bootstrap-kit operation for this; it must
not substitute generic remote execution.

## 3. Staging and activation

After prerequisites are present, iOS sends one framed stream to the fixed
root helper `scripts/sonuvi-release-stage.mjs`:

1. One UTF-8 JSON line:
   `{ "operation": "stage_release", "envelope": ..., "attemptId": "boot_<opaque-id>", "targetIdentity": "sonuvi-target-v1-..." }`.
2. The exact number of raw tar bytes declared by the signed descriptor.

The helper uses only the root-owned trust-anchor map and fixed staging roots:

- temporary upload: `/var/lib/sonuvi-bootstrap/uploads`
- immutable verified candidate:
  `/var/lib/sonuvi-bootstrap/releases/<releaseId>`

It hashes the stream before extraction, verifies the signed descriptor,
verifies the raw `release-manifest.json` digest, runs the existing
`verifyReleaseArtifact` verifier, makes the resulting tree read-only, and
never overwrites an existing release. Repeating the exact release returns
`already_staged`; a different candidate cannot replace it. Before consuming
archive bytes it rederives the local target identity and checks Debian/ARM64
compatibility. Success writes a root-owned `release_staged` binding for the
exact release ID, target identity, and attempt ID.

First installation then uses this one fixed, root-authorized bootstrap command
(no release ID, filesystem path, or command text is interpolated by iOS):

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
```

Its complete typed input is:

```json
{
  "operation": "activate_first_install",
  "envelope": { "<exact signed release envelope>": "..." },
  "attemptId": "boot_<opaque-id>",
  "targetIdentity": "<preflight machine identity>",
  "serverIdentity": "<validated local server label>"
}
```

The helper reads its root-owned trust anchors, derives `releaseId` exclusively
from the valid signed envelope, rederives and confirms `targetIdentity`,
requires the durable prior `release_staged` binding, re-hashes the staged
manifest, re-verifies the immutable artifact, and requires a root-owned
non-writable staged tree. It invokes only
the verified staged
`scripts/sonuvi-target-installer.mjs` through fixed `/usr/bin/node`; the
client cannot select a script, argument, or filesystem path. The target
installer remains the sole installer implementation and retains the Gate B2
artifact verifier, service provisioner, first-release transaction,
administrator authority, and first-controller handoff.

Success returns only this sanitized result:

```json
{
  "ok": true,
  "contract": "sonuvi.gate-c-first-install.v1",
  "state": "awaiting-administrator-enrollment",
  "releaseId": "sonuvi-<64 lowercase hex>",
  "attemptId": "boot_<opaque-id>",
  "targetIdentity": "<preflight machine identity>"
}
```

An exact replay after durable completion returns `state: "already_activated"`
without executing another installer. A held lock or an in-progress attempt
returns `first_install_activation_in_progress`; an interrupted or failed
attempt is recorded as `recoverable-incomplete` and returns
`first_install_recovery_required` on retry. Mismatched machine/release/attempt
bindings, unsigned metadata, altered/missing staging, conflicting existing
installation state, and insufficient root authorization fail closed.

### One-use interactive privilege authorization

Gate C uses the host's existing Debian `sudo` password policy; it installs no
privileged daemon and no `NOPASSWD` rule. For every root operation, iOS asks
the user to explicitly authorize that operation, opens a fresh pinned SSH
channel, and sends the password as the first UTF-8 line of stdin followed by
the operation's already-defined request bytes. The password is never an SSH
command argument, JSON field, URL, log, journal event, or persistent state.

Each command uses `sudo -S -k -p '' --`: `-S` consumes only that first stdin
line and `-k` invalidates any cached sudo credential before execution. The
root helper receives only the remaining typed payload. No authorization token
is stored; its lifetime is one command execution. The root helpers then bind
that explicit authorization to the locally rederived target identity, attempt
ID, and Ed25519-verified release envelope. Durable stage/activation state
rejects replay.

The native adapter may invoke only these fixed privilege commands:

```text
/usr/bin/sudo -S -k -p '' -- /bin/sh -s -- <verified-kit-sha256> <verified-kit-bytes>
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs
```

The first command receives only the reviewed bootstrap activation capsule on
stdin after the password. The remaining commands receive only their documented
typed stdin payload after the password. A missing/wrong password, sudo exit
`77`, a closed channel, or an unparseable result is explicit authorization
failure: iOS must not retry with a different command or retain a password.

## 4. Durable progress and reconnect

The bootstrap bridge and target installer write sanitized, fsync-backed JSONL
events before the normal Sonuvi state root exists at:

`/var/lib/sonuvi-bootstrap/attempts/<attemptId>/{state.json,journal.jsonl}`

The bridge records `release_verification` and `activation` started/passed or
failed transitions; the target installer records prerequisite, configuration,
checkpoint, health, and administrator-enrollment transitions. Once the
installation layout exists, it also writes the established Gate B2 journal at
`/var/lib/sonuvi/install/journal.jsonl`. Events remain versioned
`sonuvi.fresh-install-journal.v1` records with `eventId`, `attemptId`, target
identity, stage, state, timestamp, and optional safe error.

The new fixed root status helper consumes only:

```json
{ "operation": "status", "attemptId": "boot_<opaque-id>" }
```

Before a release has been activated, iOS invokes that operation at the fixed
root-owned bootstrap-kit path:

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs
```

After activation, the same status helper is also part of the immutable Server
release. Both copies are fixed members of `sonuvi.gate-c-bootstrap-kit.v1` and
the signed release inventory; no status command or path is supplied by iOS.

It returns `sonuvi.bootstrap-status.v1` with immutable attempt/target/release
identity, phase, `next`, terminal flag, and the combined redacted event
snapshot. It creates no state, starts no service, and cannot duplicate an
installation. iOS should poll it after reconnect; it must never call the
installer merely to resume observation.

Installation stops at `administrator_enrollment: waiting`. The existing fixed
administrator bootstrap then creates/claims the short-lived enrollment proof;
the existing tunnel-only `/v1/admin/bootstrap/first-controller` endpoint
issues separate controller credentials. These remain three distinct phases.

## 5. Supported post-install controller transport

Gate C uses a managed pinned SSH tunnel rather than pretending the current
plain HTTP LAN API is safe:

- While the app is foreground-active, maintain or reopen a pinned SSH
  connection and a `direct-tcpip` channel to `127.0.0.1:3101`.
- On background expiration, close the tunnel; do not attempt a perpetual iOS
  background connection. On resume, authenticate again, revalidate the same
  host key, and reopen the tunnel before using controller credentials.
- Controller access/refresh tokens stay device-only in Keychain. Administrator
  authority is in-memory and is discarded after first-controller issuance.
- A future direct LAN path is allowed only after a separately reviewed HTTPS
  listener with verifiable server identity and matching iOS trust policy.

## Structured errors and recovery

| Condition | Server result | iOS behavior |
| --- | --- | --- |
| unknown/mismatched signer | `release_trust_anchor_unavailable` / signature error | stop; do not download or stage |
| unsupported/expired metadata | metadata validation error | choose a supported release |
| archive digest/length mismatch | release artifact mismatch | discard bytes and retry verified transfer |
| incompatible Debian/runtime | bounded bootstrap exit 78–83 | show prerequisite/repository failure |
| interrupted install | status phase/events | reconnect and observe; never start a duplicate attempt |
| enrollment expiry/replay | existing enrollment error | create a new enrollment, never reuse proof |
| controller handoff failure | existing first-controller error | retain SSH trust; retry only authorization |

## Native archive/status acceptance fixture

The dedicated disposable Debian ARM64 fixture is ready at `127.0.0.1:2225` for
the native archive streamer and durable status poller. It uses the real fixed
helpers, an explicit SSH pin, a localhost-only relay to an egress-isolated
root-helper container, and the current signed immutable archive. Its exact
credentials path, operation strings, release identity, helper hashes, reset
procedure, and validated failure semantics are in
[the archive/status fixture handoff](sonuvi-ios-gate-c-archive-status-fixture.md).
The current signed lab bundle includes the corrected status helper in both the
bootstrap kit and immutable release. Its fixed HTTPS identity, complete hashes,
and independent trust requirements are in the
[lab-distribution handoff](sonuvi-ios-gate-c-lab-distribution.md). Older
immutable artifacts remain preserved but are not the current iOS input.

## Remaining acceptance requirements

1. iOS must retrieve and independently verify the current lab-only signed
   bundle through the pinned distribution endpoint, then add typed SFTP
   bootstrap-kit transfer, the reviewed fixed
   activation capsule, framed archive streaming, and fixed status commands to
   its existing SwiftNIO adapter; no UI redesign is necessary.
2. A fresh minimal Debian ARM64 clone—separate from the preserved B2 VM and
   baseline—must prove the full native iPad flow. The preserved B2 VM is only
   suitable for read-only tunnel verification.
