# Native administrator session contract

**Status:** Server foundation only. It introduces no configuration mutation
API, DLNA listener, controller privilege, direct LAN HTTP path, or iOS UI.

**Release availability:** This helper is source for the next reviewed Server
release; it is not present in the already-published immutable Gate C archive.
An existing Server, including the disposable VM, must first receive that future
signed release through the normal approved activation path. Do not copy this
script into an installed release or modify the current release in place.

## Transport and privilege boundary

The iOS client first verifies the existing pinned SSH host key and opens the
same authenticated SSH connection used by Gate C. It invokes exactly this
root-only command; neither the command path nor an argument is client-chosen:

```text
/usr/bin/sudo -S -k -p '' -- /usr/bin/node /opt/sonuvi/current/scripts/sonuvi-admin-session.mjs
```

The existing SSH private-key reconnect remains password-free. `sudo` retains
the Gate C explicit local-administrator authorization boundary for session
issuance; no `NOPASSWD` rule or privileged daemon is added. The password is
the first stdin line only and is never part of JSON, an argument, a log, or
persistent state.

After issuance, iOS opens the existing pinned SSH `direct-tcpip` channel to
`127.0.0.1:3101` and presents the returned administrator token only in an
`Authorization: Bearer` header. The Server must not expose this token or a
native administrator API through LAN HTTP.

## Typed request

The helper accepts exactly one JSON object. `nonce` is 16+ random bytes encoded
as base64url, `expiresAt` is a canonical UTC ISO-8601 timestamp no more than
five minutes ahead, and `administratorProof` is an IEEE-P1363 P-256 signature
encoded as base64url.

```json
{
  "contract": "sonuvi.administrator-session-request.v1",
  "operation": "issue_session",
  "targetIdentity": "sonuvi-target-v1-<64-lowercase-hex>",
  "administratorDeviceId": "<enrolled-device-id>",
  "nonce": "<base64url-random>",
  "expiresAt": "2026-11-08T12:05:00.000Z",
  "administratorProof": "<P-256-IEEE-P1363-base64url>"
}
```

The signed UTF-8 message is exactly:

```text
sonuvi-administrator-session-v1
issue_session
<targetIdentity>
<administratorDeviceId>
<nonce>
<expiresAt>
```

The proof key is the SPKI captured at first-administrator enrollment. The
Server checks its hash, target binding, device ID, signature, expiry, and a
root-owned one-time nonce ledger before creating the existing 15-minute ES256
administrator bearer. The ledger stores only SHA-256 nonce hashes and expiry;
it never stores a proof, raw nonce, Track Key, controller credential, or token.

Success is the only response that contains the ephemeral token:

```json
{
  "ok": true,
  "contract": "sonuvi.administrator-session.v1",
  "state": "issued",
  "role": "administrator",
  "administratorId": "adm_<opaque>",
  "expiresAt": "2026-11-08T12:15:00.000Z",
  "administratorAccessToken": "<ES256-bearer>"
}
```

The client holds that token in memory only. It must not place it in Keychain,
preferences, diagnostics, a recovery checkpoint, or logs.

## Legacy rebind

Old Gate C administrator records have only a public-key hash. They fail closed
with `administrator_rebind_required`; a controller bearer, legacy web Track
Key, SSH login, or a claimed device ID alone cannot issue a session.

The explicit recovery path requires the same pinned SSH connection, an
interactive local `sudo` authorization, the recorded administrator device ID,
and a proof from the administrator device key. The supplied SPKI must hash to
the legacy record's stored public-key hash; it cannot be a replacement key. It
sends this exact operation:

```json
{
  "contract": "sonuvi.administrator-session-request.v1",
  "operation": "rebind_administrator",
  "targetIdentity": "sonuvi-target-v1-<64-lowercase-hex>",
  "administratorDeviceId": "<existing-enrolled-device-id>",
  "administratorPublicKey": "<P-256-SPKI-base64url>",
  "nonce": "<base64url-random>",
  "expiresAt": "2026-11-08T12:05:00.000Z",
  "administratorProof": "<P-256-IEEE-P1363-base64url>"
}
```

Its message appends the canonical SPKI as a seventh line after `expiresAt`.
The helper accepts this operation only for a legacy record, rotates the
Server's ES256 signing material, persists the matching v2 SPKI verifier, and
returns `administrator-rebound` without a bearer. iOS then makes a separate
`issue_session` request. If the original administrator proof key or device ID
is unavailable, no remote recovery is permitted; an authorized local recovery
ceremony is required before a replacement key can be bound.
