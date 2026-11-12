# Unified ownership implementation ledger

Updated: 2026-11-12. This branch is development-only. No deployment authorized.
Brian separately authorized a ready iPad candidate installation; Server/VM/Pi
deployment and release-endpoint publication remain excluded.

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
browser logout revokes its own grant (using refresh proof if access expired),
and reports when upstream revocation cannot be confirmed. Unmigrated
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

## Current: fresh-install native LAN HTTPS and browser login

Fresh privileged activation provisions a unique P-256 TLS authority bound to
the existing stable Server ID. Root private keys remain under root-only
`protected/local-tls/authority`; a root:sonuvi/0640 atomic leaf bundle lives at
`config/local-tls.json`. Native port 8443 accepts only the exact local Host,
same-origin requests and existing `/v1/` routes. It does not expose legacy
Track-Key routes. Per-Server `.local` names and `_sonuvi._tcp` advertisements
use standard Avahi; advertisements are hints, never enrollment evidence.

The fixed root renewal unit issues 90-day leaf certificates and preserves the
enrolled root; a daily timer renews with a 30-day margin. Listeners reload only
validated bundles with unchanged identity/anchor. Root expiry/replacement
requires explicit re-enrollment, not a silent new trust root. IPv4 Ethernet/Wi-Fi
LAN advertisement is implemented; IPv6-only LAN acceptance remains open.

Privileged `/v1/auth/configure` returns public `sonuvi.local-tls-trust.v1`
material over the existing pinned SSH channel. Identical credential retries
are idempotent. The installing phone obtains its own administrator login grant
over that channel and verifies local HTTPS before handoff. Old signed packages
without this contract cannot complete the new native installer flow.

Browser login uses `/__controller/login-status`, `/__controller/login`, and a
private HttpOnly/Secure/SameSite=Strict cookie; no bearer or refresh token is
returned to page JavaScript. Existing session renewal/persistence remains.
`/__controller/devices` lists/revokes devices through Server-checked admin
authorization, with CSRF validation for mutations. Loading a web page confers
no authority. The private-browser fallback runs separately on port 8444 and
requires explicit browser root trust; native pinning does not grant Safari
trust. Never bypass a certificate warning or submit passwords over HTTP.

Authenticated browsers also inspect/approve short-lived native TV presentations
through `/__controller/device-pairings/:id` and `/:id/approve` (or reject), with
the existing Server proof, comparison code and CSRF checks. A browser does not
need to have created the TV request and never receives the TV poll token or
resulting credential. A non-secret `#pair-tv=<presentationId>` link pre-fills
the browser review UI; it does not authenticate or authorize anyone.

`GET /v1/auth/local-trust` requires Server-verified administrator access and
exports only the public trust record plus its complete certificate SHA-256.
The browser exposes it through authenticated `/__controller/local-trust` and
**Local device trust**. An additional native client can import the record and
independently compare the complete fingerprint on that already-trusted browser.
This supports exceptional TV recovery without a signed-in iPhone. The public
document grants neither ownership nor a device session; browser approval is
still required. Never obtain the comparison fingerprint from the same untrusted
discovery or certificate-warning screen being enrolled.

## Approved public browser path and remaining integration

Public per-Server HTTPS under a Sonuvi-controlled domain is the preferred
Safari path, not mandatory private CA installation. Standard ACME DNS-01
allows issuance with no inbound port forwarding. The existing public TLS
listener accepts protected certificate/key files; no production DNS/issuance
service has been built, contacted or deployed by this change.

The future service must allocate opaque non-reassigned names, bind DNS/ACME
updates to the Server's enrolled identity, accept CSRs (never private keys),
publish private LAN A/AAAA answers, and support automated ARI-aware renewal.
No Sonuvi/cloud account, password, device bearer, playback, or native login
depends on it. Certificate replacement must validate chain/name/key before
atomic activation; native offline trust is independent. Exact service endpoint,
domain ownership, provider credentials and production deployment are external
dependencies, not invented defaults. DNS rebinding filters may block public
names resolving to private IPs; offer the explicit local-browser fallback and
native LAN operation without weakening TLS. One home router accepted an
independent public test name returning a private address; that is not proof
of all routers or the future Sonuvi service.

TV discovery/local secure handoff is implemented on the coordinated native
branches using a short-lived TLS-PSK channel and existing Server presentations.
Native fixed host recovery UI, public certificate renewal/service integration
and four-journey physical acceptance remain open. Root signer, installer host-key pinning, signed release
verification, sudo and immutable activation remain unchanged boundaries.

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

2026-11-12 final local TLS/web regression: 774 tests, 763 passed, 7 skipped, 4 macOS
chown fixture failures also present on baseline. Those four passed in a
read-only, network-disabled Linux container. Subsequent focused TLS/browser
integration: 9/9 passed, including real TLS handshake, hostname/Host rejection,
explicit private browser root trust, session restart and independent revocation.
Browser-TV approval and public trust export also passed real API/gateway
fixtures. Latest full log: `server-final-regression-2.log` in task evidence.
