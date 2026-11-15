# Fresh installer candidate — 2026-11-14

Baseline: 2eb94eaaf1ff731dcb5b3afd318282b970027260. Debian 13 ARM64; generated release dependencies require the packaged Node ABI. This candidate is NOT a disk image or backup of the working VM.

## Included host parity

- Fresh administrator identity/signing material, mobile secrets and private LAN TLS authority. No existing credentials, controller pairings, sessions, share mounts or user configuration are imported.
- API and web use Type=exec, dedicated non-login sonuvi user, existing strict service confinement. Library setup resolves actual UID/GID and retains read-only CIFS ordering; no hard-coded account IDs.
- Fresh HTTPS443 uses the generated per-server LAN hostname/certificate and a separate private session store, while native8443 and fallback8444 remain. The existing local TLS renewal timer maintains all three listeners. Only the web service receives CAP_NET_BIND_SERVICE. This deliberately replaces the VM-specific friendly-domain override and separate certificate/renewal arrangement; browser trust of the new private root is still required. Existing customized deployments must NOT replace their units with these fresh templates.
- Root-managed Polkit grants ONLY restart of sonuvi-api.service and sonuvi-web.service to sonuvi. No sudo, arbitrary unit or start/stop permission. Debian bootstrap installs polkitd.
- Example configuration is generic, not the maintainer's personal settings. Fresh configuration disables MPD/moOde until configured and does not enable custom jukebox integrations.
- Fresh and upgrade bootstrap inventories are generated from source, never copied from the installed VM.

## Optional companion enrollment (not automatic)

Mills, Seeburg, Multiphone, display switching, telemetry and Alexa remain optional. They require installation-specific enrollment, not credentials in the release.

Use the packaged root-only `scripts/sonuvi-optional-machine-credentials.mjs` with `peppy` or `moode-state` to create a new root:sonuvi0640 token and corresponding web Environment override. It never prints the token. An administrator securely provisions that new token on the intended moOde sender, using the newly installed server's origin and trusted CA; do not use insecure TLS. Restart the two Sonuvi services after enrollment. The helper does NOT enable Mills or change plugin settings.

Display switching uses `ops/moode-overrides/sonuvi-display/ROLLOUT.md` from the matching source checkout: generate a new dedicated SSH identity, verify/pin the actual moOde host key, enroll the source-bound restricted public key and root-owned helper, then opt in to SONUVI_MOODE_DISPLAY_PROTOCOL=v1. Never reuse the VM SSH key or blindly trust ssh-keyscan output. Set the API's SONUVI_CONTROLLER_WEB_ORIGIN to the new browser HTTPS origin if required by the selected display flow. moOde wake/LED installation follows `ops/moode-overrides/display-state/README.md`; these are companion device changes, not Server image contents.

Alexa public HTTPS is separate from private browser HTTPS. When explicitly configuring Alexa, install Caddy and the packaged sonuvi-alexa-public.service plus reconcile service/timer, create /etc/sonuvi and Caddy's private state/account, disable the generic Caddy service to prevent competing listeners, and enable only sonuvi-alexa-public-reconcile.timer. Domain, port forwarding and Alexa account credentials are per-install inputs. Do not carry over the working VM's public-domain configuration. See the existing Alexa public HTTPS runbook/source units for details.

## Playback baseline

The last Apple TV repair was CLIENT commit 7e74314acf6f78927c0be572ec64e3fd15959e65: authorization AND prefetch request original files. Server transcoding remains disabled by default. A server installer cannot repair an old Apple TV binary; fresh-VM tests must use a client containing that fix.

## Acceptance remaining

Install on an isolated fresh Debian 13 ARM64 VM using this signed artifact and exact bootstrap capsule/digests. Verify initial ownership/pairing, persistent config/credentials, HTTPS trust/renewal, Settings restart, library setup, original-file playback, reboot/mount ordering and optional integrations after enrollment. Check port443 availability before starting; do not displace other services. No working VM or Pi5 change is authorized by candidate creation. Do not call this fresh-install proven before the real VM trial.
