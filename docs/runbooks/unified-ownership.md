# Unified ownership implementation ledger

Updated: 2026-11-12. This branch is development-only. No deployment authorized.

## Current: revocable controller session foundation

Shared-state installations construct `DeviceSessionRegistry` under
`<stateRoot>/data/device-sessions/`. Its private service-owned JSON registry is
atomically replaced under an exclusive lock with file/directory fsync. It stores
device IDs, random session generations, controller role and timestamps, not
access or refresh credentials. Missing/corrupt/insecure state fails closed;
existing persistence is never silently recreated. A crashed writer's lock needs
operator inspection, not timed lock stealing. Maximum 10,000 records; revoked
records are not evicted to make space.

New pairing/enrollment grants use an additive signed `sid` claim. Existing
clients treat access/refresh strings as opaque, so their wire response does not
change. Access, renewal, pairing approval, browser controller dispatch, and
media/radio/animation tickets consult the same registry. Revocation affects
subsequent requests, not bytes already transmitted or an already-open stream.

An existing signed legacy credential remains controller-only. Authenticated
renewal registers it without invalidating its current access or refresh token.
Revocation writes a permanent tombstone even for an unmigrated known device ID.
Explicit re-pairing issues a new generation without reviving older or legacy
credentials. No migration grants administrator authority.

New APIs (mobile API must be enabled):

- `POST /v1/mobile/session/logout`: bearer-authenticated; revokes that device.
- `GET /v1/admin/devices`: existing root-established admin authorization;
  returns non-secret registered device metadata.
- `DELETE /v1/admin/devices/:deviceId`: same admin authorization; revokes one
  device, including a legacy device identified by its existing ID.

Legacy non-shared-state source checkouts retain their previous behavior;
device-management/logout APIs report unavailable without a registry. Existing
browser logout UI is not yet wired to the new revocation endpoint. Unmigrated
devices are not enumerable until their first renewal. Legacy credentials are
still replayable until their specific grant is revoked; legacy compatibility
must not be described as proof-bound session rotation.

## Current: root-bound direct login and host recovery

`POST /v1/auth/configure` requires an existing root-issued administrator bearer.
It establishes a username and a distinct Sonuvi password (12+ characters,
maximum 1024 UTF-8 bytes), salted with 32 random bytes and hashed with scrypt
N=32768/r=8/p=3. The private account file is bound to the existing owner and
root authority generation. Neither SSH passwords nor root proof tokens are
stored. Explicit `replace: true` revokes prior administrator login grants before
committing a replacement. Account locks and generation checks reject stale
in-flight logins. Normal controller credentials cannot configure an account.

`POST /v1/auth/login` accepts username/password/deviceName and optional
`controllerOnly: true`. Every login receives a server-generated device ID and
independent revocable access/refresh grant. Normal owner login is an admin;
controller-only login and existing pairing never confer admin. Access is
15 minutes for an admin (including refresh); durable renewal remains separately
revocable. The owner login currently supports one human account per Server;
additional devices share that login, not each other's tokens.

`GET /v1/auth/status` reports non-secret ownership/login availability and a
stable Server ID. These routes accept TLS or the existing actual-loopback
SSH/proxy boundary, never direct plaintext LAN requests or a spoofed forwarded
header. Browser Origin checks precede credential use. Login attempts are
bounded globally, per socket source and account; KDF concurrency is capped.
Unknown-user and wrong-password responses use the same public error.

The fixed root-only `scripts/sonuvi-owner-recovery.mjs` handles a lost original
administrator key or an established host without Sonuvi ownership. Its bounded
stdin request includes a fresh signed P-256 proof, nonce, expiry, and expected
target identity. It independently derives the local target; rejects non-root,
substituted/expired/replayed proof; rotates the root signing authority; and
returns a five-minute ownership proof through private SSH stdout. There is no
HTTP wrapper, no caller-supplied path/command and no unprivileged sudoers rule.
Recovery preserves stable Server/owner identity but requires re-establishing
the durable login against the new authority generation. Existing ordinary
playback grants are not promoted or globally erased by this root operation.
The CLI preserves root:sonuvi/0640 verifier access; protected keys remain root
only. Invocation requires the existing installed layout and service account.

Tests cover real root-bound account enrollment, no plaintext persisted
credentials, separate devices, controller denial, credential replacement,
in-flight login races, root revocation, rate limits, transport/origin rejection,
lost-key recovery, identity preservation and replay rejection. These are local
fixtures, not host deployment acceptance.

## Approved target, not implemented here yet

iOS Bonjour/direct login and automatic
post-install enrollment; TV discovery and local secure destination handoff;
browser login and administrator device UI; native integration of fixed host
recovery and first-account configuration. Root signer, installer host-key
pinning, release verification, privilege checks and ownership remain boundaries.

Universal Links are not operational: the audited iOS entitlement lacks
associated-domains and the public Sonuvi AASA URL returned 404. A practical
fallback and real transport are required before TV journey acceptance.

## Verification

Registry tests cover independent revocation/restart, authenticated migration,
tombstones, old-generation rejection, all token scopes and browser dispatch,
missing/corrupt/permissive/symlink persistence and interrupted writer locks.
Route tests cover logout, blocked refresh/migration replay, controller denial at
admin routes and unaffected second-device renewal. Full source tests and Linux
ownership fixture results are recorded in the task evidence, not inferred from
deployment history. No physical-client or four-journey acceptance is claimed.
