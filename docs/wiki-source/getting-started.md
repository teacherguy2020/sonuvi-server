---
title: getting started
page_type: hub
topics:
  - ops
  - runtime
  - config
confidence: high
---

# Getting Started

This describes the current Sonuvi installation boundary. Sonuvi is a
moOde-focused enhancement platform: it runs a web UI and API on an app host and
uses MPD, moOde, SSH, and HTTP integrations to provide richer playback,
metadata, queue, display, and controller experiences.

## Recommended topology

Run Sonuvi on a separate Linux/Raspberry Pi host from the moOde player.
The split keeps UI/API work independent from the audio host while allowing the
API host to reach moOde over the LAN.

| Role | Typical service | Default port |
| --- | --- | --- |
| Sonuvi UI | static HTML/CSS/JavaScript | `8101` |
| Sonuvi API | Node/Express service | `3101` |
| moOde MPD | MPD on the player host | `6600` |

## Install

Use the [Sonuvi Server operations guide](../runbooks/sonuvi-server-operations.md).
The production model is systemd (`sonuvi-api.service`, `sonuvi-web.service`),
immutable releases under `/opt/sonuvi`, and writable state under `/var/lib/sonuvi`.
PM2 and the legacy installer are not the current production startup mechanism.
The old installer and file-push helper fail without making changes.

This branch does not include the complete reviewed release tooling. Obtain an
approved artifact and deployment procedure; do not treat a main checkout or
these unit templates as a complete installation bundle. Historical validation
notes remain in [install-and-validation.md](install-and-validation.md).

## Configure the first connection

1. Open `config.html` on the Sonuvi UI host.
2. Set the moOde/MPD host and port.
3. Preserve the approved operator authentication and separate native-device pairing.
4. Use the release's validated configuration/protected environment and managed SSH paths.
5. Do not use Config Save/Restart to bootstrap an immutable installation: Save
   still has known protected-field incompatibilities. A hardened service may
   reject automatic restart; an administrator must restart the API/web pair
   together and verify health. Never weaken its sandbox or restart legacy units.

Use [config-interface.md](config-interface.md) for the page model and
[config-network-and-runtime.md](config-network-and-runtime.md) for connection
and path verification details.

## Verify the first run

Check these in order:

1. `GET /now-playing` returns JSON from the API.
2. `GET /next-up` returns the current queue view.
3. `app.html` or a controller page loads from the UI host.
4. MPD transport changes from the controller reach moOde.
5. The display route loads if moOde is configured to use Sonuvi.

The operator-facing checks are collected in
[configuration-and-administration.md](configuration-and-administration.md) and
[install-and-validation.md](install-and-validation.md).

## Choose the next path

- Learn the user-facing features → [using-now-playing.md](using-now-playing.md)
- Configure displays → [displays.md](displays.md)
- Connect external systems → [integrations.md](integrations.md)
- Understand the code and API → [developer-reference.md](developer-reference.md)
- Diagnose a failure → [troubleshooting-and-technical-notes.md](troubleshooting-and-technical-notes.md)

*Last reviewed: 2026-10-28 America/Chicago*
