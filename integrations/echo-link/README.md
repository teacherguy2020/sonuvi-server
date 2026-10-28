# Main Floor Echo Link volume control

This directory contains the isolated Python sidecar used to control the
`Main Floor Echo Link` through `alexapy`. The Node API proxies authenticated
browser requests to the sidecar; browsers never receive Alexa credentials.

## Local enrollment

Install the pinned dependency in the sidecar's dedicated virtual environment,
then run the enrollment helper locally. Store the resulting JSON outside the
repository with mode `0600`:

```text
/home/brianwis/.local/share/echo-link-volume/venv/
/home/brianwis/.local/share/echo-link-volume/alexa-credentials.json
```

The systemd template uses that virtual environment so `alexapy` is isolated
from the main Node service.

Do not commit the credentials, paste them into chat, or expose them through
the API or logs.

## Required deployment settings

The optional systemd unit reads these values from
`/var/lib/sonuvi/protected/echo-link.env` (operator-managed, mode `0600`).
Its application path is `/opt/sonuvi/current/integrations/echo-link/`.
Confirm the chosen release includes this integration before enabling the sidecar.
Adapt the example service user and virtualenv path to the host. Do not create
new credentials or enable an unused integration just to install Sonuvi.

```text
ECHO_LINK_ENABLED=1
# Optional; OAuth credentials identify the Amazon account when omitted.
# ECHO_LINK_EMAIL=...
ECHO_LINK_CREDENTIALS=/home/brianwis/.local/share/echo-link-volume/alexa-credentials.json
ECHO_LINK_STATE=/home/brianwis/.local/share/echo-link-volume/state.json
ECHO_LINK_PORT=8765
ECHO_LINK_DEVICE_TYPE=A27VEYGQBW3YR5
ECHO_LINK_DEVICE_SERIAL=...complete serial from alexapy...
ECHO_LINK_ACCOUNT_NAME=Main Floor Echo Link
```

The complete serial and device type identify the target. Account name is a
sanity check only. The sidecar binds to `127.0.0.1`.

The API also needs its existing Echo Link enablement/connection settings in its
approved protected environment. A sidecar-only environment file does not enable
the API integration. Preserve existing credentials/state paths; keep them outside
the immutable release. This optional template is not installed on the reference
Pi5 and is not enabled by the Sonuvi API/web boot configuration.

## State behavior

`state.json` stores the locally commanded desired volume and last nonzero
volume. Amazon readback may be null while idle and is never treated as zero.
Unmute fails safely if no previous nonzero volume is known.
