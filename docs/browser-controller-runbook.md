# Authenticated browser controllers

Set the same high-entropy value in both services as `SONUVI_CONTROLLER_WEB_SECRET`. Configure `SONUVI_CONTROLLER_WEB_ORIGIN=https://controller.example`; terminate HTTPS at an explicitly trusted loopback proxy and set `SONUVI_CONTROLLER_TRUST_LOOPBACK_PROXY=1` only when that proxy is local. Plain LAN HTTP intentionally returns a setup error instead of minting a browser session.

Open `/controller-tablet.html` or `/controller-mobile.html`, start pairing, scan the short-lived QR using an already trusted Sonuvi mobile controller, and approve its verification code. The browser receives only HttpOnly, SameSite=Strict, bounded session cookies; it never receives a Track Key or mobile bearer token. Logout is available at `POST /__controller/logout` with the session CSRF token.

Run the harness (it starts and cleans up both fixture listeners):

`SONUVI_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/browser-controller-integration.mjs`

On Linux with Playwright Chromium installed, omit `SONUVI_BROWSER_EXECUTABLE`.
