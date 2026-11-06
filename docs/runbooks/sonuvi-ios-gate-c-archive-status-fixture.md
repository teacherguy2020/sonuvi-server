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
/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs
/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs
/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
```

`sonuvi-stage` has sudo authority only for those invocations. Password/root
authentication, TTY, agent/X11/port forwarding, and tunnelling are disabled.

### `stage_release`

Send one UTF-8 JSON header, ending in one LF, then raw archive bytes with no
framing, compression, or trailing bytes:

```json
{"operation":"stage_release","envelope":{"<exact signed release envelope>":"..."}}
```

The header limit is 64 KiB. Trusted anchors are read only from the root-owned
`/etc/sonuvi/release-trust-anchors.json`. The signed envelope fixes release
identity, architecture, byte count, and SHA-256; the helper streams to a
protected temporary location, validates all requirements, extracts with
path-containment/no-follow checks, then makes the final tree read-only.

```text
releaseId: sonuvi-24d0758d0475602a90232dd47bbd46aa01d5e8fd7489187741591bc092101e58
archive:   53,448,704 bytes
sha256:    198a8dd89c66b332121394083b82d1c73b62da9fa28b8de2798ab9f280bd716e
```

> **Published artifact:** the above immutable bundle was rebuilt after the
> first-install bridge and staged-installer stdin correction. The actual
> extracted release and bootstrap-kit copies both pass `node --check`; older
> signed artifacts remain preserved and unmodified.

Success returns `ok: true` and `state: "staged"`; a complete retry returns
`state: "already_staged"` without a second extraction. Malformed JSON,
oversized headers, truncated/altered/trailing archive bytes, incompatible
metadata, symlinks, unexpected entries, and unauthorized operations return
`ok: false` with a nonzero exit. A caller that loses the final response retries
the identical stream: `already_staged` means completion occurred; an SSH
interruption leaves no final release tree.

### `status`

Send only:

```json
{"operation":"status","attemptId":"boot_fixture_archive_status_20261105"}
```

The seeded record is bound to `fixture_target_20261105` and returns
`sonuvi.bootstrap-status.v1`, phase `release_acquisition`, one `waiting` event,
`next: "observe"`, and `terminal: false`. Unknown/stale attempts are rejected
with `bootstrap_attempt_not_found`. Polling is read-only: reconnects return the
same state and leave the durable state/journal bytes unchanged.

### `activate_first_install`

The fixture first proves `/opt/sonuvi/current` is absent, then stages the
verified immutable archive and invokes the new fixed bridge with a signed
envelope, `boot_fixture_first_install_20261105`, the target's own machine ID,
and `fixture-server`. It accepts no caller path, command, or release ID.
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
baseline, immutable lab artifacts, or SFTP fixture.

## Helper identity

The source and in-container helper hashes match:

```text
sonuvi-release-stage.mjs:          22bc925a46681c80dd81a351288f12b920a25073bfbffbc3e410b4decbf3165b
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
input, an actual midstream SSH kill, status reconnect, first installation from
verified staging with no pre-existing current pointer, attempt/machine
binding, lock/replay safety, privilege boundaries, and arbitrary-command
rejection. It stops at administrator enrollment and never runs controller
authorization.
