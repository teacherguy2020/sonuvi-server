# Authenticated browser controllers

The public web listener proxies only an explicit ordinary-controller read allowlist to the loopback API. Administration, configuration writes, refresh/rebuild/scanning, arbitrary artwork URLs and general-purpose proxying are not admitted. API port 3101 remains loopback-only.

## Transport configuration

Set `SONUVI_CONTROLLER_WEB_ORIGIN` to the exact public HTTPS origin (no path/query). Terminate TLS at the existing local proxy, preserve Host, replace forwarded-proto with `https`, and set `SONUVI_CONTROLLER_TRUST_LOOPBACK_PROXY=1` for that trusted loopback hop only. Remote forwarded headers never establish TLS trust. The local public listener must not be exposed as an alternative authenticated HTTP endpoint. `SONUVI_CONTROLLER_API_PORT` defaults to 3101.

No Track Key or additional shared secret is required on a fresh installation: pairing issues an ordinary mobile-controller access token. The web service holds it only in bounded process memory and forwards it to the loopback API for allowlisted requests; the API validates the existing mobile-api scope and expiry. It cannot authorize administrator routes. Optional legacy scoped-HMAC dispatch remains query-, expiry-, socket- and replay-bound; it is not needed for new sessions.

`allowLoopbackFixture` is an explicit constructor-only test option, never enabled by an environment variable or deployed command. HTTP LAN authentication fails closed. Host is checked independently of Origin; mutating session operations require a matching Origin, and logout/renewal additionally require CSRF. Cookie renewal never extends the original grant (maximum eight hours).

## Pairing and clients

Open `/controller-tablet.html` or `/controller-mobile.html`. The public listener supplies a non-secret mode marker, while legacy API-served pages retain their prior origin resolution. Browser mode never reads administrator configuration or a stored Track Key.

Start pairing; scan the QR using an already trusted Sonuvi mobile controller and compare the displayed verification code. The gateway creates and P-256-attests a unique browser presentation through the existing reverse-pairing API. Approval is never automatic. A nonce-bound poll consumes that real grant once and creates an HttpOnly, Secure, SameSite=Strict cookie. Neither the API token nor the refresh token is returned to browser JavaScript.

Album/artist browsing, quick search and recent albums reuse the Server's catalog routes and injected v3/fresh-install browse provider. The mobile recent rail no longer calls the administrative library-health route. Ordinary controller reads do not grant deployment, administrator or configuration-write access.

Animated art uses the existing shared discovery/cache implementation directly from the authenticated mobile route. Cached video is delivered under `/v1/mobile/animated-art/media/:name`, authorized by the normal bearer token or an expiring file-bound media ticket. Web clients use the same client resolver and a cookie-protected same-origin media URL. Realpath containment rejects cache symlink escapes. Legacy administrative lookup routes retain their existing protection and behavior.

## Acceptance commands

`node --test test/controller-gateway.test.mjs test/runtime-shutdown.test.mjs`

`SONUVI_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/browser-controller-integration.mjs`

The browser harness requires Playwright, Chrome, OpenSSL and FFmpeg. It uses an ephemeral self-signed TLS proxy, the actual pairing store/routes, disk-backed catalog adapter, real artwork decoding and generated H.264 playback. Only that isolated browser context accepts the fixture certificate. No browser network fulfillment or fake autoapproval endpoint is used. The source catalog/media and transport state are disposable inputs, not live provider acceptance. The harness deliberately does not register unrelated provider routes that could contact live services.

Run `scripts/dlna-lifecycle-integration.mjs` only in a disposable **internal-network** Linux container with `SONUVI_DISPOSABLE_MULTICAST_TEST=1`. It exercises real HTTP, SSDP multicast responses, three SIGTERM/SIGINT cleanup/restart cycles, exclusive port rebinding and `/proc/net/igmp` membership release. Never run it on the production LAN.

Production deployment, signing, VM replacement and physical listening are separate actions; these commands perform none of them.
