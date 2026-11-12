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

## Approved target, not implemented here yet

Durable Sonuvi username/password login; root-authorized first account setup and
recovery; role-scoped device login; iOS Bonjour/direct login and automatic
post-install enrollment; TV discovery and local secure destination handoff;
browser login and administrator device UI. Root signer, installer host-key
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
