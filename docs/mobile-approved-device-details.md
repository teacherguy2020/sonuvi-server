# Approved device details

`GET /v1/mobile/devices` remains readable by approved controllers. It now advertises
`detailsAvailable: true`, and `managementAvailable` only when the same bound
credential passes existing administrator authorization and the listener permits
administrator routes. The native-only remote listener still blocks `/v1/admin/`.
No approval, token lifetime, role assignment or route allowlist is broadened.

Each active entry includes its public approval ID, label/current flag, role/status,
created/updated timestamps and optional display hints: `deviceType`, `platform`,
`osVersion`, `appVersion`, `browser`, `lastSeenAt`, `lastSeenAddress`,
`lastAddressSeenAt`, `connectionKind`. Timestamps are Unix milliseconds. These are
approval records, not unique physical-device identities or online presence.

Only an authenticated request can update connection observations; the registry
rechecks the same grant under its existing writer lock. Observations never create,
renew or restore approval. Same-address writes are limited to once per minute per
API process; an address change is recorded immediately. Display-metadata failure
must not fail otherwise valid authorization. Revocation remains authoritative.

IP comes only from the request socket, not client-supplied forwarding headers.
Loopback/unknown addresses are recorded as proxied with no invented device IP.
An earlier direct address remains available with its separate observation time.
Existing records are not backfilled. A proxy-only device can legitimately have no
IP recorded. Browser/OS names are coarse User-Agent display hints, not authority;
raw User-Agent strings, tokens, session IDs and administrator IDs are not exposed.

`POST /v1/mobile/devices/self` optionally accepts bounded deviceType/platform/
osVersion/appVersion alongside its required label. It still rejects another
approval ID, role or claimed IP. Old label-only clients remain compatible.

Removal uses the unchanged `DELETE /v1/admin/devices/:deviceId` administrator-only
endpoint. Native UI confirms the named approval and verifies the follow-up list;
self-removal verifies rejection before clearing that Server's local credentials.
It does not delete libraries/files, infer success from an uncertain timeout, or
retry an uncertain mutation. Controller, pinned-SSH and native-only remote paths
must not advertise a removal action they cannot perform.
