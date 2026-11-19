# Configuration collection layout

Config cards use labelled sections with in-flow icon/status headers, headings,
descriptions and footers. Avoid using fieldset/legend floats with absolutely
positioned card decorations: WebKit places the legend outside the normal flex
flow and allows the description to overlap both icon and status. Chromium alone
does not reproduce that failure. Nested form fieldsets remain semantic fieldsets.

Cards reflow from three columns to two at 1050px and one at 560px. Expanded
settings span the collection and use shrinkable form columns, stacking on phones.
Credential saved-state hints occupy their own row. Long labels/text wrap; JSON
textareas stay within the card. Configuration and authentication contracts are
unchanged. Open details are restored using the owning plugin card, not a nested
fieldset.

Regression: test/config-layout-browser.test.mjs runs actual page assets and real
configuration schemas in Chromium and WebKit at 1200,1024,768,560,390 and320px.
It checks card containment/non-overlap, page overflow and expanded form controls.
Other configuration browser tests retain save/credential/restart coverage.
