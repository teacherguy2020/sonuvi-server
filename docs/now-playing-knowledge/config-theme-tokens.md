# Configuration theme tokens

The configuration collection uses the app's existing --theme-* roles: bg,
text/text-secondary, hero-card-bg, rail-border, card-secondary-fill, tab-bg/text,
tab-active-bg/text, and tab-hover-bg. Default colors match app defaults, not a
separate collection palette. Primary/selected controls use the active token pair.

The configuration page’s inline presentation helper reads same-origin parent computed tokens when embedded,
observing root token and mode changes without applying the shell's generic CSS
layout overrides. Standalone mode reads existing origin-local clientSettings.app
presentation preferences with legacy themeTokens/np-theme fallbacks. Cross-tab
storage changes refresh the palette; the helper never writes preferences or
server configuration. Restart dialogs use the same token roles in their owning
document (the shell document when embedded). The helper is bundled inside the existing allowlisted config.html, so an older
installed release verifier can safely admit the update without an asset-policy change. Prior responsive card/form fixes remain unchanged.

Tests exercise actual packaged page assets in Chromium and WebKit, checking
computed color roles, standalone preferences, cross-tab updates, app iframe token
changes, dark/light mode, and the shell-owned restart dialog. Network mutations
are forbidden in the theme tests. Related config save/credential tests remain.
