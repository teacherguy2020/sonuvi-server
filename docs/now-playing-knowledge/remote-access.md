# Optional native remote access

Current implementation: Tailscale Serve terminates normal public-PKI HTTPS at the machine’s MagicDNS name and forwards only to a loopback native gateway on 8445. The gateway accepts mobile API/media and credential-free identity/remote discovery plus account login. Browser cookies, browser Origin requests, legacy controls and administrator configuration are rejected. No Funnel, router port forwarding, TLS bypass, root certificate replacement or new device grant is involved.

The fixed privileged `scripts/sonuvi-remote-setup.mjs` accepts only status/enable plus the existing SSH-verified target identity. It requires an already installed/running/signed-in Tailscale, refuses HTTPS443 conflicts/Funnel, preserves other routes, verifies Serve readback, then atomically records a root-owned remote address. It never installs software, logs in, resets Serve, changes ACLs, or changes other Tailscale preferences. Missing prerequisites remain explicit setup states.

GET /v1/auth/remote-access returns configured:false when absent. When configured it returns a five-minute public delegation signed by the current local TLS leaf. It binds contract, server identity, original enrolled local origin and exact HTTPS ts.net origin; native verifies the enrolled root chain, original hostname, certificate validity and ECDSA signature before attaching any credential to remote HTTPS. No private keys or device tokens are returned.

The app retains its original origin, trust, library and approval. The remote alias is stored separately in device-only Keychain. Native routing checks the remote proof without credentials, uses remote if reachable, otherwise probes the exact pinned local identity. Reads can reconnect; ambiguous mutations are never replayed. Finite media uses the existing asset-owned range loader. Live radio uses the same bounded loader with system PKI after remote verification. Administrator settings stay local-only.

Settings → Remote Access is available later. New native installation offers the same optional screen after music setup; Set up later makes no server mutation. Server prerequisites may require the owner to install/sign in to Tailscale separately. Installer distribution compatibility and physical cellular/CarPlay acceptance must be recorded separately; a source change or LAN test is not proof of either.

Historical regression: 2026-11-14 Pi5 fresh-install cleanup removed the exclusive previous Tailscale Serve route, while the new pairing bound the client to an enrolled .local origin. Tailscale remained running. Remote connectivity was not carried into the new install contract.

Updated: 2026-11-15 America/Chicago.
