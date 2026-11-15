# Production-parity runtime integration

Source provenance: production reference `f5df18b`, the approved native-admin
preservation patch `b7d32cd4a480fc2e91b40bd72f11cde34ffee860`, and the bounded
runtime integration commit in this branch. The native administrator API remains
native-only; no browser route is added.

## DLNA boundary

DLNA is disabled by default. Enable `features.dlnaMediaServer` (or the explicit
environment switch) **and** set `DLNA_LAN_ADDRESS` to a selected RFC1918 IPv4
interface and `DLNA_PORT` to a dedicated valid port (default 3102). It creates
a separate HTTP listener containing only DLNA descriptors, SOAP, media,
artwork, and the public app icon. The authenticated API remains on its existing
listener (including loopback port 3101 deployments). SSDP starts only after the
dedicated listener has started; rehearsal/tests never start it. DLNA identity
is persisted under the mutable runtime state root, never an immutable release.
