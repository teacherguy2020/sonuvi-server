# Settings restart flow

Save responses with restartRequired open a modal explaining that changes are saved but need a restart. Restart now checks availability, requests the fixed Sonuvi API/web pair, and waits for a different API instance plus both active units before reporting recovery. Later performs no restart; Restart Server remains available. Unsaved edits block restart. The modal lives in the same-origin app shell document so full-height iframes cannot place it off-screen.

Browser routes /__controller/configuration/restart[/status] use existing cookie/CSRF checks and forward to administrator-authorized /v1/admin/configuration/master/restart[/status]. No target or command options are accepted. Reuses the existing narrow Polkit restart policy; hosts without operator provisioning report unavailable, not success. See docs/runbooks/sonuvi-config-maintenance.md for policy installation and verification.

Updated: 2026-11-13
