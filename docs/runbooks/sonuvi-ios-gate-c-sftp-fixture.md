# Gate C disposable OpenSSH SFTP fixture

This is a **local protocol fixture**, not a Sonuvi target or an installer. It
exists to exercise the iOS native SFTP-v3 implementation against a fresh
OpenSSH server without writing to the successful Gate B2 VM or a baseline.

## Isolation and identity

- Docker image/context: `tools/sonuvi-gate-c-sftp-fixture/` (built and
  verified as `linux/arm64`)
- Lifecycle command: `scripts/sonuvi-gate-c-sftp-fixture.sh`
- Published listener: `127.0.0.1:2224` only.
- Docker network: dedicated bridge `sonuvi-gate-c-sftp-fixture-net`. Docker
  Desktop cannot publish a host port from `--internal`; the only published
  port is still the loopback mapping above. The jailed account has no shell,
  command, forwarding, tunnel, or other application-level outbound facility.
- Account: `sonuvi-sftp` (UID/GID `12001`), public-key authentication only.
- Chroot: `/srv/sonuvi-sftp-fixture/chroot`, root-owned and non-writable by
  the fixture account.
- Fixed writable namespace in the jailed SFTP view:
  `/staging/.local/share/sonuvi-bootstrap-v1`.
- SSH features disabled: shell, password auth, TCP/agent/X11 forwarding,
  tunnel, TTY, root login, and user environment.

The fixture contains no Sonuvi release kit, production file, service, volume,
sudo rule, or installer activation. Its runtime filesystem is the disposable
container layer. `reset` removes the container and all uploaded test bytes.

## Lab-only credentials

Credential files are protected outside the repository at:

```text
/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-sftp-fixture-20261105/
```

| Purpose | File | Exposure |
| --- | --- | --- |
| Fixture host identity | `ssh_host_ed25519_key` | mounted read-only; never copy or commit |
| iOS/native test-client private key | `client_ed25519` | test-only; never copy or commit |
| Client public key | `client_ed25519.pub` | mounted read-only into the fixture |

The fixture-only native-client key is therefore referenced, without its
contents, at:

```text
/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-sftp-fixture-20261105/client_ed25519
```

The host launcher requires the host private key to remain mode `0600`. The
iOS test must pin this exact current host identity and use strict host-key
checking:

```text
SHA256:e7tqr4fD34QF8ExnSLuNtuAMnpslx52KeikKaL4nwSg (ED25519)
```

## Lifecycle

```sh
scripts/sonuvi-gate-c-sftp-fixture.sh start
scripts/sonuvi-gate-c-sftp-fixture.sh status
scripts/sonuvi-gate-c-sftp-fixture.sh reset
scripts/sonuvi-gate-c-sftp-fixture.sh stop
scripts/verify-sonuvi-gate-c-sftp-fixture.sh
```

`start` refuses a pre-existing listener on port `2224`, builds the isolated
Debian/OpenSSH image, verifies the dedicated bridge network, and publishes
only `127.0.0.1:2224`. `reset` is the required cleanup after a
test: it forcibly removes only the named disposable fixture container, then
creates a fresh empty one. It never touches any VM, Docker volume, release
artifact, production service, or SSH configuration on the host.

## Protocol scope

The fixture provides stock `internal-sftp` only. It intentionally does not
implement application policy: the native Gate C adapter must still enforce
the fixed `REALPATH`, `LSTAT`, `statvfs@openssh.com`, UID/mode/type, bounded
transfer, partial-recovery, and atomic-rename sequence from
[`sonuvi-ios-gate-c-sftp-and-lab-tls.md`](sonuvi-ios-gate-c-sftp-and-lab-tls.md).

The chroot demonstrates that a client cannot read unrelated host paths. It
does not substitute for the real target-side root activation capsule, whose
home-directory reconciliation and no-follow validation were separately tested
against a disposable Debian ARM64 environment.

## Required acceptance checks

Use OpenSSH with `StrictHostKeyChecking=yes`, a fixture-only known-hosts file,
and the test private key. Verify:

1. Pinned host-key and public-key authentication succeed; wrong key rejects.
2. `sftp` negotiates the `internal-sftp` subsystem and resolves `/staging`.
3. Only the fixed staging tree accepts uploads; `mkdir`, `put` to partial,
   `chmod 0600`, and same-directory `rename` produce the expected final file.
4. A disconnected partial upload is removed and a new session starts from
   byte zero before atomic rename.
5. A symlink or a file where an expected directory belongs is detected and
   rejected by the native client before upload. Reset the fixture afterward.
6. Attempts to read `/etc/passwd`, escape with `..`, or authenticate without
   the fixture test key fail. No host filesystem is visible through the jail.

No fixture operation authorizes target bootstrap activation or a physical
iPad installation.

## Current validation record

The stock macOS OpenSSH client validated the running fixture at
`127.0.0.1:2224` using the pinned identity above. It confirmed public-key
authentication, forced SFTP-only access, `statvfs`/`df`, UID `12001` plus
mode `0700` staging directories, `0600` uploaded files, atomic rename, and
restart-from-zero after a partial file. It also rejected a mismatched host
key, an unauthorized client key, an outside-jail `/etc/passwd` read, and a
directory/file conflict. A test symlink is visible to SFTP so the native
client's required `LSTAT` rejection path can be exercised. The final reset
left the running fixture empty.
