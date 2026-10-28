# Sonuvi HTTPS proxy
Sonuvi's API stays on plain HTTP3101 and its web server on plain HTTP8101.
Caddy accepts HTTPS443 and routes API paths to3101 and pages/assets to8101.
The browser uses same-origin URLs on HTTPS and direct API3101 from HTTP8101.

The adjacent Caddyfile is a starting example, not an installer and not a replacement
for an existing configuration. In particular, merge /peppy/* into the API matcher
of each existing Sonuvi site. Preserve existing certificates, bind addresses,
Tailscale, Alexa, stream and moOde artwork routes. If Tailscale Serve owns443 on
its address, preserve or configure explicit Caddy LAN binds; do not reset Serve.

Validate the merged configuration with caddy validate before a controlled reload.
Install/trust Caddy's local root CA on clients for the sonuvi.local internal-TLS site.
Do not send HTTPS directly to3101 or8101; those listeners remain HTTP.
No SSH permission or credential change is required for browser URL routing.

