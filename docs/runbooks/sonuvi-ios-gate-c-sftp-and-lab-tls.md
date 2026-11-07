# Gate C fixed SFTP staging and lab TLS trust

**Contracts:** `sonuvi.gate-c-sftp-bootstrap.v1` and
`sonuvi.gate-c-lab-tls-trust.v1`
**Scope:** temporary lab support for the existing native Guided Setup. These
contracts add no listener, daemon, generic remote shell, file browser, or
production trust exception.

## 1. Fixed SFTP bootstrap-kit staging

The target already supplies authenticated OpenSSH and its standard `sftp`
subsystem. Gate C uses that subsystem only for the initial bootstrap kit,
because a blank target has no Node.js, npm, or Sonuvi helper to receive a
framed upload. It does **not** use SCP, an HTTP upload endpoint, a new daemon,
or a client-selected remote path.

### Preconditions

Before opening SFTP, iOS must have completed all of the following locally:

1. Pin and verify the SSH host key, then authenticate the selected Linux
   account. A changed key fails; it is never replaced automatically.
2. Fetch the fixed lab bootstrap artifact over the fixed TLS endpoint using
   the policy in section 2.
3. Verify the signed Ed25519 release envelope, signer key ID, expiry,
   Linux/ARM64 target, and `payload.bootstrap.sha256`.
4. Verify the downloaded `sonuvi-bootstrap-kit-v1.tar` SHA-256 against that
   signed digest. The current lab artifact is 157,184 bytes. Its size is also
   capped at 16 MiB by this contract.

The SFTP upload never grants execution authority. It is merely a transfer of
bytes that were already authenticated by the iOS release verifier.

### Namespace and permitted operations

After the SFTP subsystem is active, the client issues `REALPATH "."`. Its
canonical absolute result is the authenticated account's only permitted home
directory for this operation. It must be non-root, POSIX-canonical, absolute,
and contain neither `.` nor `..` segments. A chroot/mapping whose realpath
cannot be reconciled with the account's normal home directory fails closed;
there is no alternate path entry field.

From that result `<home>`, the only writable namespace is:

```text
<home>/.local/share/sonuvi-bootstrap-v1
```

The only upload names are:

```text
sonuvi-bootstrap-kit-v1.tar.partial
sonuvi-bootstrap-kit-v1.tar
```

The native client may use only these SFTP operations, with paths derived by
the contract rather than caller input:

1. `REALPATH .`; then `LSTAT` the returned home to record its authenticated
   UID.
2. Require OpenSSH `statvfs@openssh.com` for that home and require free space
   of at least the kit size plus 32 MiB. Absence or malformed output is
   `sftp_capacity_unavailable`; do not upload.
3. For each of `.local`, `share`, and `sonuvi-bootstrap-v1`, `LSTAT`; create a
   missing directory with mode `0700`, then `LSTAT` and `SETSTAT` it to exactly
   `0700`. Existing entries must be directories, non-symlinks, owned by the
   authenticated UID, and mode `0700` exactly.
4. `LSTAT` any stale partial. Only a regular, non-symlink, authenticated-UID
   file with mode `0600` and size at most the declared kit size may be
   removed. Any other stale object is `sftp_staging_recovery_required`.
5. Open the fixed partial name with `CREATE|EXCL|WRITE`; stream sequentially
   from offset zero only, never sparse writes or resume offsets. The iOS side
   hashes and counts every write.
6. Close, `LSTAT`, and require a regular non-symlink `0600` file, same UID,
   and exact expected byte count. Verify the local transfer digest again.
7. Atomically rename the partial name to the fixed final name in the same
   directory. A pre-existing final file is a recovery error, never an
   overwrite. `LSTAT` the final file and repeat the type/UID/mode/size check.

Interruption policy is deliberately simple: discard/reject the partial object
as described above and restart at byte zero. No Range-like or append resume is
allowed. The SFTP client must not call `CHMOD`/`CHOWN` on anything outside this
namespace, use `SYMLINK`, read arbitrary files, or enumerate directories.

### Root activation after upload

The only privileged operation is the reviewed fixed capsule in
[`scripts/sonuvi-sftp-bootstrap-activate-v1.sh`](../../scripts/sonuvi-sftp-bootstrap-activate-v1.sh).
It is delivered as exact application-owned stdin, never selected by the user
or fetched from the target. Its shell command is one of these fixed forms:

```text
capsule SHA-256: 5a12aeea3a5ae0dda1fbc8ceb599ee27e0da93055603effff5fd7b559a50f3df
```

```text
/usr/bin/sudo -S -k -p '' -- /bin/sh -s -- <64-lowercase-hex-kit-sha256> <decimal-kit-bytes>
```

Only the signed digest and bounded byte count are substituted after strict
validation. No pathname, package, URL, service, repository, or shell fragment
is substituted. For the password form, iOS writes one ephemeral password line
followed immediately by the immutable capsule source; it never records either
in logs, progress, models, or Keychain. If the account's existing sudo policy
does not authorize this command, the operation fails as `sudo_authorization`
without altering sudoers or retrying with a different account.

The capsule derives the account home itself from `SUDO_USER` and `getent`, so
the client never passes a target path. It rechecks all three user staging
directories and the final file for UID, `0700`/`0600` mode, regular type, and
no symlink. It then copies with GNU `dd iflag=nofollow` into a root-owned
temporary file, checks the exact byte count and SHA-256 there, rejects all
unexpected/archive-link entries, extracts only to the fixed root-owned
`/var/lib/sonuvi-bootstrap/bootstrap-kit-v1`, and atomically promotes that
directory. An existing promoted kit may only be reused if its root-owned marker
matches the same digest; a different or incomplete one is a recovery error.

Only after those checks does it execute the already-packaged fixed
`scripts/sonuvi-debian-node-bootstrap.sh install`. Thus SFTP bytes are not
executed merely because they arrived; the kit is re-hashed after a no-follow
copy into root ownership first. The capsule also verifies root-side free space
before copying/extracting. It requires ordinary Debian base utilities
(`sh`, `sudo`, `getent`, `dd`, `sha256sum`, `tar`, `find`, `stat`, and `df`),
not Node.js or npm.

The fixed extracted bootstrap-kit inventory is versioned as
`sonuvi.gate-c-bootstrap-kit.v1`. The complete regular-file allowlist is:

```text
etc/sonuvi/release-trust-anchors.json
scripts/sonuvi-bootstrap-status.mjs
scripts/sonuvi-debian-node-bootstrap.sh
scripts/sonuvi-first-install-activate.mjs
scripts/sonuvi-release-stage.mjs
src/lib/atomic-file.mjs
src/lib/public-web-root.mjs
src/lib/release-artifact.mjs
src/lib/runtime-capabilities.mjs
src/lib/runtime-config-security.mjs
src/lib/sonuvi-bootstrap-contract.mjs
src/lib/sonuvi-bootstrap-progress.mjs
src/lib/sonuvi-bootstrap-status.mjs
src/lib/sonuvi-fresh-install.mjs
src/lib/sonuvi-gate-c-first-install.mjs
src/lib/sonuvi-gate-c-release.mjs
src/lib/sonuvi-gate-c-staging.mjs
```

`scripts/sonuvi-bootstrap-status.mjs` is deliberately also present in the
immutable Server release. Before activation, iOS invokes the fixed bootstrap
copy; after activation, the release preserves the same durable-status behavior.
The actual packaged kit is verified against this exact inventory before it is
archived, and the capsule independently rejects any different extracted tree.

After successful prerequisite activation, the only release staging entrypoint
is the fixed root-owned path:

```text
/var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs
```

iOS sends the typed `stage_release` request (signed envelope, attempt ID, and
preflight target identity) followed by the immutable archive to that path. It
never derives a command or path from metadata. The staged release and the
later target installer retain their existing signatures, digest checks, fixed
roots, target/attempt binding, and durable status protocol.

After a successful verified stage, first installation uses only this fixed
bootstrap command:

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
```

The client sends the typed `activate_first_install` request defined by the
Server contract: signed envelope, attempt ID, preflight machine identity, and
validated server identity only. It must not send a release ID, path, script,
or shell fragment. The bootstrap bridge independently binds those identities,
re-verifies the staged immutable release, and invokes the one packaged target
installer through fixed `/usr/bin/node`.

### Transfer errors and recovery

| Condition | Required result |
| --- | --- |
| SFTP unavailable, no `statvfs`, missing UID/mode attrs | `sftp_capability_unavailable`; no upload |
| Symlink, traversal, wrong UID/mode/type | `sftp_staging_rejected`; no activation |
| Disconnect or partial write | `sftp_transfer_interrupted`; reconnect and restart from zero |
| Final exists or root kit incomplete | `sftp_staging_recovery_required`; do not overwrite |
| Size/hash mismatch | `bootstrap_kit_verification_failed`; discard/re-download |
| Sudo denied/prompt fails | `sudo_authorization`; do not alter sudoers |
| Debian prerequisites fail | existing bounded Debian bootstrap result (78–83) |

## 2. Application-scoped lab TLS trust

The lab endpoint is intentionally self-signed, so normal system-chain trust
must fail. Gate C makes one **application-scoped** exception for the exact
service below; it does not alter device trust, `URLSession.shared`, or global
certificate handling.

```text
contract: sonuvi.gate-c-lab-tls-trust.v1
origin: https://M4-Mac-mini.local:9443
hostname: M4-Mac-mini.local
TLS minimum: 1.3
leaf certificate SHA-256: 0f60a0d502ff5fd397f6f14db9ab0680de26595e368072d46abadcfd546cec76
leaf SPKI SHA-256 (base64url): v5i8HdltMqwPlQJa8D1niB1NnqogY3CIbrKf5_4iLpc
validity: 2026-11-05T15:05:38Z through 2026-12-05T15:05:38Z
```

The public lab leaf certificate is a build-time resource recovered from the
protected local lab credential source and published for the lab iOS build at:

```text
/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/ios-inputs/sonuvi-gate-c-lab-distribution-tls-server-cert.der
```

It is not a private key and must not be fetched from the endpoint it is meant
to authenticate. The app bundles it only in the lab build that contains this
exact policy. The release Ed25519 anchor remains separate:

```text
DER SHA-256: 0f60a0d502ff5fd397f6f14db9ab0680de26595e368072d46abadcfd546cec76
subject/SAN: M4-Mac-mini.local
validity: 2026-11-05T15:05:38Z through 2026-12-05T15:05:38Z
```

The protected local source, the exported DER, and the active
`M4-Mac-mini.local:9443` listener were compared byte-for-byte before this
path was recorded. A TLS 1.3 hostname check with that local public anchor
succeeds only for the expected identity; a wrong hostname rejects.

```text
Ed25519 release signer SPKI SHA-256 (base64url):
w7kQBpYG5LGnoJvbAdiN1O7pde8QZkdEoJU0sIFjYkg
```

### Required Security.framework evaluation

For a `NSURLAuthenticationMethodServerTrust` challenge, the dedicated lab
`URLSession` delegate must first reject every host, port, scheme, redirect, or
authentication method other than the literal endpoint above. It then:

1. Creates `SecPolicyCreateSSL(true, "M4-Mac-mini.local" as CFString)` and
   assigns it to the supplied `SecTrust`.
2. Calls `SecTrustSetAnchorCertificates` with the bundled leaf certificate and
   `SecTrustSetAnchorCertificatesOnly(trust, true)`. No system or user trust
   anchor is accepted for this request.
3. Calls `SecTrustEvaluateWithError`. This enforces the policy hostname and
   current certificate validity before a credential is returned.
4. Obtains the evaluated leaf, compares its DER SHA-256 to the exact leaf
   digest above, then computes the leaf P-256 SubjectPublicKeyInfo SHA-256 and
   compares the result to the exact SPKI pin above.
5. Returns `URLCredential(trust: trust)` only if every check passed; otherwise
   it cancels the challenge with no retry or fallback.

For this P-256 leaf, `SecKeyCopyExternalRepresentation` yields the 65-byte
uncompressed X9.63 public point, not SPKI DER. The iOS helper must first
validate that representation (`0x04`, 65 bytes) and prepend the fixed P-256
SPKI DER prefix before hashing:

```text
3059301306072a8648ce3d020106082a8648ce3d030107034200
```

This preserves the existing SPKI pin rather than substituting a key-format or
certificate-hash pin. The separate leaf DER digest rejects a reissued or
changed certificate even if it reused the same public key.

Typed failures are terminal for the attempted download:

- wrong host/port/redirect: `lab_tls_endpoint_rejected`
- trust anchor, hostname, or validity failure: `lab_tls_anchor_rejected`
- changed leaf certificate: `lab_tls_leaf_changed`
- SPKI mismatch: `lab_tls_spki_mismatch`
- expired release envelope or bad Ed25519 signature: release verification
  failure, separate from TLS identity

## 3. iOS implementation boundary

The native adapter must expose two private typed operations only:

1. `stageVerifiedBootstrapKit` — implements the exact SFTP sequence above and
   returns a typed staging result; it has no public upload/path API.
2. `activateVerifiedBootstrapKit` — sends only the reviewed capsule and the
   digest/size already authenticated by the release verifier, then invokes the
   existing fixed release stager after Node is present.

Administrator credentials, controller credentials, release private keys, TLS
private keys, SSH passwords, and sudo passwords remain out of transfer logs
and durable progress. The fixed TLS policy authenticates the distribution
host; it does not authenticate a release. Ed25519 verification remains
mandatory before SFTP and before any privileged activation.
