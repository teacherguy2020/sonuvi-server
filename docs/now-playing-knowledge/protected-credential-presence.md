# Protected credential saved state

The Settings editor uses each protected credential's `status[plugin].credentials[field]` boolean, never the aggregate plugin configured state. Alexa route and stop webhooks therefore display independent Saved / Not saved labels and masked Saved placeholders. Stored values are never inserted into inputs. Missing status is shown as unavailable, not falsely unsaved. Save responses and subsequent server refreshes update presence; untouched inputs retain stored values.

Updated: 2026-11-13
