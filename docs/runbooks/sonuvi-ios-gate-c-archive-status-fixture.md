# Gate C archive/status acceptance fixture

## Purpose and boundary

This disposable Debian ARM64 Docker fixture exercises the real root-only Gate C
archive-stage, first-install bridge, and durable-status entrypoints. Its
fixture-only systemd shim admits only the fixed unit operations used by the
real packaged target installer; it never provides a shell or a second
installer implementation. It is separate from the B2 VM, pristine baseline,
and SFTP fixture.

It contains only fixed helpers and public signed release metadata. It mounts
only a test-only SSH host private key and test-only client **public** key—never
production data, credentials, volumes, a sudo shell, or Sonuvi service.

Each reset begins with no `/etc/sonuvi/release-trust-anchors.json` and no
promoted bootstrap tree. The fixture copies the exact verified bootstrap tar
to the staged account namespace, invokes the reviewed application-owned
activation capsule as root, and verifies the resulting anchor is a root-owned
non-symlink `0644` file byte-identical to the verified kit copy before any
`stage_release` request is accepted.

## Connection material

| Item | Value |
| --- | --- |
| Address | `127.0.0.1` |
| SSH port | `2225` |
| Account | `sonuvi-stage` |
| Host-key fingerprint | `SHA256:5B8LnCjCq80mVrqI5lhXg26sI49tK13isDs4XKC3AAA` |
| Test-only client key | `/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-archive-status-fixture-20261105/client_ed25519` |
| Test-only host public key | `/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-archive-status-fixture-20261105/ssh_host_ed25519_key.pub` |
| Control script | `scripts/sonuvi-gate-c-archive-status-fixture.sh` |

The key directory is mode `0700`; the private key is `0600`. These are
laboratory credentials: do not copy their contents into the app, release, or
logs. Native acceptance pins the fingerprint before authenticating.

The real root-helper container uses an internal Docker network with no egress.
A credential-less, read-only Node TCP relay alone publishes `127.0.0.1:2225`.
The relay has no mounts, capabilities, command API, or SSH termination; it can
relay only to the fixture's port 22. Host-key verification is end-to-end to the
fixture. No listener is bound outside localhost.

## Fixed SSH operations

The forced-command dispatcher admits exactly these byte-for-byte strings. Any
other command exits `126` with `operation_rejected`.

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
```

`sonuvi-stage` has sudo authority only for those invocations. Password/root
authentication, TTY, agent/X11/port forwarding, and tunnelling are disabled.

### `stage_release`

Send one UTF-8 JSON header, ending in one LF, then raw archive bytes with no
framing, compression, or trailing bytes:

```json
{"operation":"stage_release","envelope":{"<exact signed release envelope>":"..."},"attemptId":"boot_fixture_first_install_20261105","targetIdentity":"sonuvi-target-v1-<64 lowercase hex>"}
```

The header limit is 64 KiB. Trusted anchors are read only from the root-owned
`/etc/sonuvi/release-trust-anchors.json`. The signed envelope fixes release
identity, architecture, byte count, and SHA-256; the helper streams to a
protected temporary location, validates all requirements, extracts with
path-containment/no-follow checks, then makes the final tree read-only.

```text
releaseId: sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912
archive:   53,460,480 bytes
sha256:    4cc92d789d45f2cd9fb9f3f2abc66c0dfc524c4e06781f2727f6f8ed4829c0db
```

> **Published artifact:** the above immutable bundle contains the fixed
> `sonuvi.gate-c-stage-response.v1` error contract. The actual extracted
> release and bootstrap-kit copies both pass `node --check`; older signed
> artifacts remain preserved and unmodified.

Success returns `sonuvi.gate-c-stage-response.v1`, `ok: true`, and
`state: "staged"`; a complete retry returns `state: "already_staged"` without
a second extraction. Every stage failure returns only the same contract,
`operation: "stage_release"`, `ok: false`, and one reviewed code:
`stage_input_invalid`, `stage_release_identity_mismatch`,
`stage_release_digest_mismatch`, `stage_target_mismatch`,
`stage_attempt_mismatch`, `stage_conflict`, `stage_permission_denied`,
`stage_helper_unavailable`, or `stage_internal_error`. No raw exception text,
stack, path, or credential is client-visible. A caller that loses the final
response retries the identical stream: `already_staged` means completion
occurred; an SSH interruption leaves no final release tree.

### `status`

Send only:

```json
{"operation":"status","attemptId":"boot_fixture_archive_status_20261105"}
```

The seeded record is bound to the preflight-derived
`sonuvi-target-v1-<64 lowercase hex>` identity and returns
`sonuvi.bootstrap-status.v1`, phase `release_acquisition`, one `waiting` event,
`next: "observe"`, and `terminal: false`. Unknown/stale attempts are rejected
with `bootstrap_attempt_not_found`. Polling is read-only: reconnects return the
same state and leave the durable state/journal bytes unchanged.

### `activate_first_install`

The fixture first proves `/opt/sonuvi/current` is absent, then stages the
verified immutable archive and invokes the new fixed bridge with a signed
envelope, `boot_fixture_first_install_20261105`, the target's preflight
identity, and `fixture-server`. It accepts no caller path, command, or
release ID.
Successful activation returns
`sonuvi.gate-c-first-install.v1` / `awaiting-administrator-enrollment`,
creates the expected current pointer, and is visible through the durable
status helper with `next: administrator_enrollment`. An exact replay returns
`already_activated`; mismatched machine identity, an extra path field, stale
activation lock, and direct unprivileged execution are rejected.

## Lifecycle

```bash
# Create a fresh, ready fixture and deterministic durable state.
scripts/sonuvi-gate-c-archive-status-fixture.sh reset

# Show listener, pin, release, and network topology.
scripts/sonuvi-gate-c-archive-status-fixture.sh status

# Show root ownership/modes and in-container helper hashes.
scripts/sonuvi-gate-c-archive-status-fixture.sh inspect

# Destroy disposable containers; protected test keys remain in place.
scripts/sonuvi-gate-c-archive-status-fixture.sh stop
```

`reset` recreates all staging and attempt state. It does not touch the B2 VM,
baseline, immutable lab artifacts, or SFTP fixture. By default it uses the
currently published immutable lab bundle (including its packaged bootstrap
kit); environment overrides are only for a separately named candidate.

## Helper identity

The source and in-container helper hashes match:

```text
sonuvi-release-stage.mjs:          8ce5a8d9faea66cb26687355701ac150641968b52a7ea24d2faa201fd8e8ef39
sonuvi-bootstrap-status.mjs:       8beee776c14235f77499a5a3397b0e80a17722de77d00c15697ed55b8f18c5ac
sonuvi-first-install-activate.mjs: 0dbe409dd41d0d293be0b0edad01408c54bf8c3e8e3ece0536a3f28cf331a594
```

`/var/lib/sonuvi-bootstrap`, `attempts`, and `uploads` are root-owned `0700`;
`releases` is root-owned `0755`.

## Acceptance

```bash
scripts/verify-sonuvi-gate-c-archive-status-fixture.sh
```

The independent OpenSSH acceptance pins the host key and covers valid staging,
idempotent retry/lost-final-response, malformed/truncated/corrupt/trailing
input, bad signed metadata, target/attempt mismatch, helper unavailability,
staging conflict, an actual midstream SSH kill, status reconnect, first
installation from verified staging with no pre-existing current pointer,
lock/replay safety, privilege boundaries, arbitrary-command rejection, and an
explicit final Docker lifecycle status assertion. It stops at administrator
enrollment and never runs controller authorization.
