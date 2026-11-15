# Last.fm owner credential storage

Upgraded service units may retain LASTFM_ENV_FILE pointing at the legacy protected file. This remains a read source. Owner API writes use the dedicated service-owned protected/integrations/lastfm/credentials.env under SONUVI_STATE_ROOT. Marked owner values override legacy files and environment, including explicit empty session values on disconnect. Do not broaden permissions on the protected root.

The editor shows saved-presence indicators, inline action results, and an explicit Last.fm authorization link. Saved fields display a “Saved ••••••••” placeholder, not the actual value. Credentials do not need re-entry unless replacing them.

Updated: 2026-11-13
