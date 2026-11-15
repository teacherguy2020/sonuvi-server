# Designer navigation

Displays links open Player, Peppy, Visualizer, Index Display, Mobile Controller and Kiosk Designer. Player and Peppy editor navigation must not depend on features.moodeDisplayTakeover: that setting controls takeover operations, not access to local design controls. Neither initial URL parsing nor periodic runtime status refresh may redirect these designers to Config. Keep the existing takeover action gate unchanged.

Player target guidance uses the canonical HTTPS `/display.html?mode=player&kiosk=1` address. An unavailable/unauthorized target probe or empty response is unverified, not evidence of misconfiguration. Only a successful target read can report a different display. The app shell follows the same rule.

Updated: 2026-11-14
