# Config maintenance on a managed Sonuvi release

- Browser entrypoint: HTTPS on the proxy origin (443, normally omitted).
  Direct HTTP uses API3101 and web8101. Neither direct port is a TLS listener.
- Server access uses the existing masked Track Key in the browser's
  x-track-key header. It is not a setting to save or a credential to rotate.
  Native iOS bearer tokens and pairing remain separate.
- Save sends only changed, allowlisted editable fields. The server rejects
  protected credential fields even when empty and merges changes into the
  existing configuration. A no-op does not rewrite the file. Environment-
  managed values are read-only; omitted/redacted paths and credentials persist.
- Last.fm account authorization and credential replacement are operator-managed.
  Configuration/session presence does not prove that a scrobble was accepted.
- SSH restriction is unchanged. The runtime diagnostic GET checks MPD and
  configured local paths separately; remote paths/status and moOde-owned sticker
  maintenance are explicitly unavailable. No ssh-copy-id or blanket sudo.

## Narrow restart permission

The API service retains NoNewPrivileges. Do not use sudo from that sandbox.
On systems with systemd and Polkit, render
ops/polkit/50-sonuvi-restart.rules.in with the actual verified service User and
install the reviewed file root:root0644 in /etc/polkit-1/rules.d.
The rule grants only org.freedesktop.systemd1.manage-units with verb restart
for sonuvi-api.service or sonuvi-web.service to that user. It grants no other
unit, verb, reboot or remote-host permission. Existing service units and their
hardening are not relaxed. Roll back by removing only this added rule.

Verify the actual API process with a root-run pkcheck for both allowed restarts
and denied units/verbs, without executing any operation. Detailed Polkit queries
are reserved to trusted callers: do NOT grant the API that authority or weaken
its sandbox. After checking the installed rule, add
Environment=SONUVI_SERVICE_RESTART_POLICY=sonuvi-pair-polkit-v1 to the API unit.
This root-managed opt-in grants no privilege; systemd still checks Polkit on
each actual RestartUnit request. Without it the UI reports unavailable.
GET /config/restart-services/status checks that policy opt-in and both active
units; it explicitly reports operator-configured authorization, not a live
permission probe. POST accepts no target/options, authenticates the operator,
prechecks the pair, and flushes HTTP202 before
requesting systemd's noninteractive nonblocking restart of that exact pair.
202 is acceptance, not a completed/healthy restart. Failures are logged without
subprocess output; no legacy/PM2 fallback or automatic retry occurs.

## Update and verification

Use the existing reviewed clean-source release builder and staged-release
verification/publication process. Retain the prior release and small unit/
pointer/checkpoint control-file copies. Do not overwrite a live release, use
the retired installer, recopy persistent data or change protected H4C state.
Verify configuration/schema and actual service-account permissions before
switching the release. Preserve environment-file ordering and physical
SONUVI_RELEASE_ROOT; retain the current symlink as the public release pointer.

Test Save and Restart only against isolated fixtures, never by clicking their
production controls. Verify live authenticated GETs, HTTPS, immutable release
identity, history/settings/credentials/library/queue preservation after the
authorized update. Audible integration tests and Caddy reboot require separate
operator coordination/approval.

Last updated: 2026-10-28.
