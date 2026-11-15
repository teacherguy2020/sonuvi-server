# Collection configuration interface

The web Config page uses the approved Collection design: sage-toned, symmetrical
three-column cards, two on tablets and one on phones. Search and category filters
operate locally; Configure expands the existing module controls. Master JSON is
under Advanced, retaining the same revision-checked draft and Save / Update.
Credential actions remain explicit immediate saves outside the JSON draft.

The app shell must not inject its generic theme or zero-padding normalization
into config.html; the Collection page owns its palette and responsive spacing.
Do not remove the authentication bootstrap, iframe resizing or restart handling.

Disabled custom integrations are discoverable through Add integration / Optional
integrations. Mills, Seeburg and Multiphone appear with enabled hardware bridges;
this is presentation only, not a new executable plugin loader or a config migration.
Enabled badges indicate preferences, not connectivity. Verified is reserved for
an explicit operational true status. Search, expanded panels and entered credentials
remain intact during ordinary interaction; refresh avoids replacing focused controls.

Browser regression uses real configuration validation/persistence and packaged
public serving, including app-frame credential and restart flows. Live verification
is read-only and must not save configuration or invoke playback to test styling.

Updated: 2026-11-14
