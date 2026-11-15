# Restricted moOde display switching

The administrator browser POST `/__controller/configuration/display` uses the
existing same-origin cookie/CSRF bridge to `/v1/admin/configuration/master/display`.
The API verifies current administrator authority. It accepts only player, peppy,
visualizer, or kiosk; URLs and shell commands are never accepted from the browser.
Saved profile options are retained; failed switching restores the prior profile.

## Provisioning

1. Back up moOde `.xinitrc`, its `cfg_system.local_display_url`, authorized_keys,
   and server configuration/protected state. Record playback and queue IDs.
2. Install `dispatcher.py` root-owned 0755 as
   `/usr/local/libexec/sonuvi-display-dispatch` and `apply.py` as
   `/usr/local/libexec/sonuvi-display-apply`.
3. Install root-owned `/etc/sonuvi-display.json` with the canonical HTTPS
   `origin`. Browser local display must already be enabled; this operation does
   not enable a different display stack or touch audio/playback settings.
4. Create a dedicated Ed25519 display key, not the existing readonly key. On
   moOde bind its public key to `restrict`, the fixed dispatcher, and the
   Sonuvi server source address. Permit sudo only for the four literal apply
   commands. Retain all existing keys and readonly authorization unchanged.
5. Store its private key and pinned moOde known_hosts under
   `SONUVI_SECRETS_ROOT/display-ssh/{display_ed25519,known_hosts}` readable only
   by the API service. Enable `SONUVI_MOODE_DISPLAY_PROTOCOL=v1` and set the
   API's `SONUVI_CONTROLLER_WEB_ORIGIN` to the same origin as the web service.
6. Build/sign/verify and activate the immutable server release using the normal
   guarded release procedure. Never patch the current release in place.
7. Verify all four administrator button actions. Each success requires the
   exact target in SQLite, startup script, and a running Chromium process.
   Check unchanged queue order and playback state. Retain one selected display.

The forced command accepts only `sonuvi-display-v1 MODE`. The privileged helper
uses no shell or caller-controlled path, serializes changes with a file lock,
updates SQLite using parameters, restarts only localdisplay.service, and restores
startup/database state on failed restart/readback. The client validates contract,
mode, URL and verified status. Readonly and arbitrary SSH stay separate/denied.

## Rollback

Restore the retained `.xinitrc` and only `local_display_url`, restart localdisplay,
remove only this dedicated authorized-key line and this operation's sudoers/file
installation, and restore the API drop-in. Roll back the server using the guarded
release mechanism and recorded previous release. Never remove unrelated keys,
change playback, or restore the entire live moOde database over newer settings.

Updated: 2026-11-14 America/Chicago.
