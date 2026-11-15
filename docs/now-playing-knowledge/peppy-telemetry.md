# Peppy telemetry on the current HTTPS server

The API is loopback-only. Do not point moOde at port 3101. The dedicated machine ingestion routes are PUT https://sonuvi.local/__peppy/vumeter and /__peppy/spectrum. They require the dedicated Bearer credential, validate bounded telemetry bodies, and forward only to the fixed local meter endpoints. Browser cookies cannot authorize ingestion. Paired browsers read /peppy/vumeter and /peppy/spectrum through the existing authenticated gateway.

The server credential is configured by SONUVI_PEPPY_TOKEN_FILE in the web service. The moOde copy is root-only /etc/sonuvi-peppy-token. Patched senders must read that file into the Authorization header, verify the server certificate using the system trust store, and use bounded HTTP timeouts. Never put credentials in URLs or browser instructions. Preserve these sender patches when upgrading moOde.

Enable enable_peppyalsa using moOde settings, keep the /tmp/peppymeter and /tmp/peppyspectrum FIFO paths, output.http=True, and the headless meter output.display=False. Enable peppymeter.service and peppy-spectrum-bridge.service. Target restoration must preserve the HTTPS addresses. URL configuration alone does not prove success: verify fresh changing nonzero meter levels and spectrum bins during real audio and verify them in the browser. Applying ALSA routing can briefly restart playback; preserve the queue.

The Peppy editor pushes the selected, bounded profile through the administrator/CSRF-protected `/__controller/configuration/display` action. The saved profile is restored if the restricted display switch fails. Do not reuse legacy browser-url, last-profile POST or port-8101 transport. Feedback is returned to the visible editor button.

Artwork cache-busting uses the gateway-supported `_` and `t` query parameters. Readiness refreshes every ten seconds while visible. App lights independently probe API status, web release, meter freshness and a bounded live MPD status query; a configured hostname is not connectivity proof. PeppyALSA green means audio data received, not an SSH configuration inspection. Alexa remains unverified until an actual connectivity check.

Updated: 2026-11-14

## Mills display power
Config → Mills Display Wake controls Mills wake (`plugins.millsDisplay.enabled`). It applies live and separately reports authenticated machine-request freshness. The root-only curl adapter uses a distinct playback-state credential, never the browser cookie or Peppy ingestion credential. See `ops/moode-overrides/display-state/README.md`. Default is disabled; provisioning and actual DPMS verification are separate from saving the setting.
