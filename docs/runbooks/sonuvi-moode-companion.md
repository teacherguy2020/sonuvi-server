# Optional moOde companion enrollment

A fresh server has a new identity, TLS CA, and credentials. A server release
cannot inherit the old VM's moOde SSH source restriction, browser CA, Peppy
token, or approved browser session. **Server installation alone does not claim
moOde display/telemetry readiness.** This explicit companion step completes
that optional integration. No private state belongs in a distributable.

## Prerequisites

Use pinned administrative SSH to both hosts. moOde needs its stock local
browser display, PeppyMeter/PeppySpectrum, libnss3-tools (certutil), and PeppyALSA
enabled through stock moOde settings. Enrollment does not alter audio settings
or start playback. The server's canonical HTTPS URL must already respond with
a valid per-install certificate. The fresh installer provides the generated
LAN hostname on HTTPS443; use its root at
/var/lib/sonuvi/protected/local-tls/authority/root.pem.
A configured custom HTTPS alias must supply its actual issuing root instead.

## Supported enrollment

1. Read moOde /etc/ssh/ssh_host_ed25519_key.pub through the already pinned
   administrative connection. Never trust an unauthenticated keyscan.
2. On the server, as root, run the packaged
   scripts/sonuvi-moode-companion.py server-export with --origin,
   --ca-file, --server-address, --moode-address, and --moode-host-key.
   Pass the verified public host-key text as one argument.
3. The command creates/reuses dedicated server credentials, prepares fixed
   service overrides and writes root-only
   /var/lib/sonuvi/protected/moode-companion-enrollment.json.
   It never prints the credentials or rotates an existing token implicitly.
4. Transfer that file over the authenticated administrative SSH channel to
   moOde, root-owned0600. Transfer the script plus its ops/moode-overrides
   resources from the **same verified release**, preserving the relative
   layout. Run scripts/sonuvi-moode-companion.py moode-import --bundle PATH.
   It verifies the server certificate before changing trust, installs system
   and Chromium NSS trust, restricts a new key to the four display commands and
   the new server address, and enrolls TLS-verified telemetry senders.
5. Restart the Sonuvi API/web pair. Reopen/restart the local moOde browser,
   sign in/pair it through the normal supported flow if the server identity
   changed, and select a display using the authenticated Designer button.
   Enrollment never clones another server's browser login.
6. Verify all four pushes from the actual app.html iframe, all six Designer
   links, artwork, fresh VU/spectrum data while audio is playing, independent
   status indicators, and the physical display (no TLS error). Record queue
   IDs before/after; do not restore a queue over user playback changes.

Re-running the same enrollment retains credentials and does not duplicate key
authorization. A different server gets a different dedicated key/token.
Timestamped protected backups are retained on each host. Unrelated keys,
readonly SSH capability, audio configuration and playback are preserved.
Do not claim the integration ready if a prerequisite, browser pairing, or
physical-display verification remains incomplete.

## Release acceptance

Build only clean source containing the d11f2a1 baseline and subsequent fixes.
Production activation rejects dirty development snapshots and rejects a lower
compatibility generation. An intentional rollback remains a separate operation.
Use the active release's trusted activation path, not an older candidate's
activation module. Run production-source, Designer/CSRF, Peppy, mobile Home,
Queue Wizard and podcasts regressions against the exact packaged candidate.
Installer publication and native digest binding must reference that same
reviewed archive/bootstrap. A successful /health is not UI acceptance.
