# Displays: Push to moOde

Each Displays button now chooses its explicit Player, Peppy, Visualizer or Kiosk
mode. The signed-in administrator browser uses its cookie and CSRF token; no
track key is exported. The API checks current administrator authority.

The server uses a dedicated fixed-command display SSH identity, not the legacy
unrestricted shell route or the readonly diagnostic identity. Canonical HTTPS
origin is provisioned on both ends. Success requires matching mode/URL and
verified persistent database, startup script and Chromium process state.

See `ops/moode-overrides/sonuvi-display/ROLLOUT.md` for provisioning, verification
and rollback. Existing display profile options are preserved. Failure is shown
beside the button and the prior profile/startup target is restored when possible.

Updated: 2026-11-14 America/Chicago.
