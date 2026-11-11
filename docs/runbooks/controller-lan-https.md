# Authenticated controllers on a private LAN

The immutable public web service can terminate HTTPS directly. The API and native administrator boundary remain loopback-only. No SSH tunnel, external proxy, Track Key or shared web secret is required for browsers.

## Installation settings

Set these in a service drop-in for `sonuvi-web.service` after provisioning an installation-specific certificate with the LAN IP in its Subject Alternative Name:

- `SONUVI_CONTROLLER_WEB_ORIGIN=https://<LAN-IP>:8443`
- `SONUVI_WEB_HOST=0.0.0.0`
- `SONUVI_WEB_PORT=8101`
- `SONUVI_WEB_TLS_PORT=8443`
- `SONUVI_WEB_TLS_CERT=<absolute certificate PEM path>`
- `SONUVI_WEB_TLS_KEY=<absolute protected key path>`
- `SONUVI_WEB_CA_CERT=<absolute public CA certificate path>` (optional download)
- `SONUVI_CONTROLLER_SESSION_FILE=<absolute private session JSON path>`
- `SONUVI_CONTROLLER_TRUST_LOOPBACK_PROXY=0`

The certificate key must be readable only by the service and administrator, outside the release public root. Keep the CA signing key root-only. The session file's parent must be a real directory, owned by the web service account, mode0700; an existing file must be a regular service-owned mode0600 file. Browser grants never enter source, public assets or browser storage. Origin changes deliberately reject old persisted sessions rather than transferring grants to another origin.

HTTP8101 redirects GET/HEAD paths to the exact configured HTTPS origin. HTTP mutations are rejected. The existing loopback `/release.json` health contract remains HTTP200 so the signed native upgrade coordinator can verify the installed release. The optional `/sonuvi-browser-ca.crt` on HTTP serves only the public certificate; verify its administrator-provided SHA256 fingerprint before installing trust. No private key is downloadable.

## Browser setup

1. Trust this installation's CA certificate on the device/browser once. Do not disable TLS validation globally.
2. Open `https://<LAN-IP>:8443/controller-tablet.html?pane=kiosk-albums.html` (or the mobile controller).
3. Choose **Start trusted-device pairing**.
4. On an already paired browser choose **Pair a browser**, refresh requests, and enter the code displayed on the new browser. The code must match before approval. A compatible trusted native controller can also approve through the existing reverse-pairing protocol.

The first trusted browser still requires an already-authorized controller's approval. Do not add an unauthenticated auto-approval or administrator endpoint to the web gateway. Browser sessions persist across web service restart, but are bounded by the original controller grant and a maximum eight hours. A restart during a pending pairing requires starting that pairing again.

## Controller contracts

The browser gateway explicitly allows playlist previews, album-health reads, radio presets and the existing read-only radio-preview POST. POST reads require same-origin and per-session CSRF plus bounded JSON validation on both the web and API sides. Administration and unlisted mutations are not exposed. Radio favorites use the shared credential-free radio service; they do not fetch an internal Track-Key-protected route.

## Verification

Run `node --test test/controller-gateway.test.mjs test/public-web-server.test.mjs test/public-web-tls.test.mjs` and `scripts/browser-controller-integration.mjs` with a real Chromium executable. Then verify an installed signed release from separate clean browser contexts: direct TLS, fresh pairing approved through the UI, radio catalog, playlist preview, source artwork/video, and retained session after a coupled API/web restart. Never test playback mutations against production moOde without authorization.

Updated: 2026-11-11
