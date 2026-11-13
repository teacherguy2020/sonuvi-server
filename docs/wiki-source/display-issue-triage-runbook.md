# display issue triage runbook

## Purpose

This runbook gives a practical triage order for display- and presentation-side problems in `now-playing`.

It is meant for issues like:
- the wrong display surface showing up
- Player / Peppy / Visualizer / Kiosk confusion
- iframe-vs-top-level differences
- wrong routed page vs wrong final render target
- moOde browser target or display-mode mismatches
- visible art/metadata/presentation problems that may actually be route/runtime/integration problems

The goal is to answer practical questions like:
- what surface am I actually looking at?
- which page owns this visible behavior first?
- is this a page bug, a route-backed data bug, or a host/runtime mismatch?
- do I debug on the app host, the moOde host, or both?

## Why this page matters

Display issues are easy to mis-triage in this project because:
- there are multiple real display families
- some pages are routers or wrappers rather than final render targets
- visible symptoms often cross page, route, cache, and host/runtime boundaries
- the moOde host can diverge from app-host expectations

So “the display is wrong” is not enough of a diagnosis.

## Core rule

When a display issue appears, triage in this order:
1. **identify the actual surface/mode**
2. **identify the primary page owner**
3. **decide whether the issue is page-owned, route-owned, or host/runtime-owned**
4. **check historically fragile display paths**
5. **verify the right host-side effect**

## Step 1: identify the actual display surface or mode

Start by classifying what the user is actually seeing.

## A. Browser/TV display surface
Usually means:
- `display.html`
- `index.html`
- a classic browser-based now-playing presentation

Use this classification when:
- the issue is on a browser or TV-like presentation surface
- the symptom looks like display-router or classic now-playing behavior

## B. Player display mode
Usually means:
- Player as the display mode
- `player-render.html` as the final render surface
- `player.html` as the Player designer/preview surface

Use this classification when:
- the display is clearly in Player mode
- the visible problem may be in the Player render target rather than the Player designer

## C. Peppy display mode
Usually means:
- `peppy.html`
- possibly a Peppy skin-specific issue rather than a general display issue

Use this classification when:
- the symptom is specific to Peppy presentation
- the problem may actually be with the selected Peppy skin or Peppy-targeted display/runtime control

## D. Visualizer display mode
Usually means:
- `visualizer.html`
- or a wrapper/host page such as `controller-visualizer.html`

Use this classification when:
- the display is clearly in Visualizer mode
- the issue may belong to the wrapper host instead of the final visualizer page

## E. Kiosk presentation/shell mode
Usually means:
- `kiosk.html`
- controller-backed kiosk mode
- `kiosk-designer.html` if the issue is in the authoring/push path rather than the live kiosk experience

Use this classification when:
- the symptom is about kiosk routing, kiosk presentation, embedded panes, or kiosk push/preview behavior

## Important guardrail
Do not blur these categories.
In the wiki’s current terminology:
- **Player / Peppy / Visualizer** = display/render modes
- **Kiosk** = presentation/shell mode
- **designer/helper surfaces** = `player.html`, `kiosk-designer.html`, `displays.html`, wrappers

If you classify the wrong thing, you will open the wrong file first.

## Step 2: identify the primary page owner

After you classify the surface, decide which top-level page owns the visible behavior first.

## If the issue is classic display routing or browser display behavior
Start with:
- `display.html`
- `index.html`

Why:
- `display.html` is the display router
- `index.html` owns important top-level vs embedded display behavior

## If the issue is Player mode
Start with:
- `player-render.html` for the final visible render
- `player.html` only if the issue is really about design/preview/push behavior

Why:
- the Player designer is not the same thing as the Player render surface

## If the issue is Peppy mode
Start with:
- `peppy.html`

Why:
- this page is both a real Peppy display surface and a Peppy-oriented config/control surface
- some issues may actually be Peppy-skin-specific rather than generic mode failures

## If the issue is kiosk presentation behavior
Start with:
- `kiosk.html`
- `controller.html` or controller-backed kiosk surfaces if the live kiosk path redirects there
- `kiosk-designer.html` only if the issue is preview/push/design-related

Why:
- kiosk often behaves like a launcher/bridge into controller-backed behavior, not a simple standalone render page

## If the issue is controller-embedded display behavior
Start with:
- the parent controller page (`app.html`, `controller-tablet.html`, `controller-mobile.html`, or `controller.html`)
- then the embedded child surface if needed

Why:
- the visible symptom may be owned by the parent shell, the child surface, or their embedded contract

## Step 3: decide what layer most likely owns the symptom

After the page owner is chosen, decide which layer likely owns the real problem.

## A. Page-owned symptom
Signs:
- the wrong layout or wrong visible behavior appears only on one page/surface
- a designer/helper surface behaves differently from the actual render target
- embedded vs top-level differences are obvious

Check first:
- the relevant top-level HTML page
- page-specific runtime logic
- page-specific CSS/styling assumptions

## B. Route-backed support/data symptom
Signs:
- the page renders, but art/text/mode/state is wrong
- a visible surface looks wrong because support data is wrong
- mode switching, runtime status, art, browse, or queue support behavior seems incorrect

Check first:
- `src/routes/art.routes.mjs`
- `src/routes/config.runtime-admin.routes.mjs`
- `src/routes/config.diagnostics.routes.mjs`
- `src/routes/config.controller-profile.routes.mjs`
- other route-family owners if the visible path depends on them

## C. Host/runtime-owned symptom
Signs:
- the route says success, but the moOde box still shows the wrong thing
- browser target or display mode is wrong on the real display host
- wake/display-state behavior disagrees with app-side expectations

Check first:
- `src/routes/config.runtime-admin.routes.mjs`
- `local-environment.md`
- moOde-side override docs/material
- real moOde host outcome

## Important guardrail
A visible symptom can cross more than one layer.
Do not stop at the first plausible explanation if the live behavior still disagrees.

## Step 4: check the historically fragile display paths

These are the display-side paths most likely to waste time if you do not recognize them early.

## Fragile path A: iframe vs top-level rendering
Check when:
- embedded preview looks correct but top-level does not
- top-level looks correct but routed/embedded context does not
- background/layer behavior differs by context

Start with:
- `index.html`
- `display.html`
- `scripts/index-ui.js`
- `styles/index1080.css`

Guardrails:
- do not assume it is only CSS
- determine whether the current page is the host/router or final render target
- preserve intentional embedded/top-level differences unless you understand why they exist

## Fragile path B: routed page vs final render target confusion
Check when:
- `display.html` is involved
- a wrapper/helper/designer page is visible in the workflow
- Player or Visualizer is being routed or wrapped

Typical mistakes:
- blaming `player.html` when `player-render.html` owns the visible result
- blaming a wrapper page when the real issue is in the final child surface
- blaming the render target when the router chose the wrong mode upstream

Guardrails:
- always ask: is this page the router, the wrapper, the designer, or the real render target?

## Fragile path C: app-host vs moOde-host mismatch
Check when:
- API endpoints say success but the box display is still wrong
- browser URL or display mode changes appear ineffective
- local wake/display behavior seems inconsistent with app code

Start with:
- `src/routes/config.runtime-admin.routes.mjs`
- `local-environment.md`
- real moOde host verification
- override docs/material in `integrations/moode/` and `ops/moode-overrides/`

Guardrails:
- route success is not enough
- if the result is supposed to appear on the moOde box, verify it there

## Fragile path D: mode-sensitive art/display truth
Check when:
- art or metadata seems wrong on a display surface
- the visible issue changes by playback mode
- fallback art or stale-looking art may actually be intentional degraded behavior

Start with:
- playback mode classification
- `playback-authority-by-mode.md`
- `src/routes/art.routes.mjs`
- relevant display surface afterward

Guardrails:
- classify playback mode first
- do not assume one universal art/status authority
- preserve last-good/fallback behavior unless you know it is wrong

## Step 5: decide which host to verify

Display issues are often operationally split across hosts.

## Verify on app host first when:
- the page logic itself appears wrong
- route responses are wrong
- routed mode selection or support data seems wrong before reaching the display host

In Brian’s setup:
- app host = `10.0.0.4`

## Verify on moOde host first when:
- the display box is showing the wrong target despite app-side success
- runtime-admin actions appear ineffective
- wake/display/browser-target behavior seems inconsistent

In Brian’s setup:
- moOde host = `10.0.0.254`

## Practical host rule
If the symptom is “the moOde-attached display is still wrong,” then moOde-side verification is required even if the app-side API looks fine.

## Step 6: use the minimum verification set that matches the symptom

## Symptom type: wrong mode or wrong page showing
Verify:
- router/launcher choice first
- final render target second
- user-visible result on the real destination surface

## Symptom type: art/text looks wrong but page structure is fine
Verify:
- playback mode classification
- support route output
- display surface after refresh
- fallback/last-good expectations if relevant

## Symptom type: preview/designer differs from live target
Verify:
- designer/helper surface
- final render target
- actual routed/pushed live target on moOde if applicable

## Symptom type: runtime-admin display push looks ineffective
Verify:
- runtime-admin endpoint response
- browser-url/display-mode status if available
- real moOde-host visible result
- local override possibility if behavior still diverges

## Step 7: declare success only when the visible destination is correct

A display issue is not really solved when:
- one helper page looks correct
- one endpoint says success
- one embedded context works while the real target still fails

A display issue is solved when:
- the correct routed/rendered destination surface is identified
- the right layer has been checked
- the real visible destination now behaves correctly

## Quick heuristics

- If the issue is display-side, classify the surface before reading code.
- If `display.html` is involved, ask whether it chose the wrong target or whether the target itself is broken.
- If Player is involved, separate `player.html` from `player-render.html` immediately.
- If Peppy is involved, ask whether the problem is mode-wide or skin-specific.
- If Kiosk is involved, ask whether the problem is live kiosk behavior or kiosk designer/push behavior.
- If the moOde box still looks wrong, do not stop at app-side success.
- If the symptom changes between embedded and top-level contexts, widen the investigation immediately.

## Best companion pages

- `display-surface-troubleshooting.md`
- `display-interface.md`
- `backend-change-verification-runbook.md`
- `fragile-behavior-ownership.md`
- `local-environment.md`
- `route-ownership-map.md`
- `playback-authority-by-mode.md`

## Current status

At the moment, this page gives the wiki a more explicit display-side triage sequence.

It turns “the display looks wrong” into a better debugging order:
- classify the surface/mode
- identify the primary page owner
- decide which layer likely owns the symptom
- check known fragile display paths
- verify on the host where the real effect should appear

## moOde VM HTTPS wake/blanking repair (2026-11-11)

For the approved VM display origin `https://10.0.0.65:8443`, use the
version-bound patches and staging verifier in `docs/references/moode/`. Local
MPD play and active ALSA remain wake authority when the VM returns health-only,
paused, error, or expired-session data. The root-only VM curl configuration is
restricted to that exact origin; other display hosts retain the unauthenticated
bounded port-3101 probe. This does not restore display-only Mills after a VM
browser session expiry.

## Canonical Sonuvi hostname and moOde consumers (2026-11-12)

When the moOde display target changes from a VM address to
`https://sonuvi.local/`, inspect every state consumer, not just the browser
target. The PHP worker, wake watchdog, and physical RGB LED service each need
to query the canonical authenticated `/now-playing` route. A stale VM or Pi
URL can make the browser appear correct while blanking and LED state silently
fall back to inactive/local metadata.

Local MPD/ALSA remains authoritative for ordinary moOde playback. Mills,
AirPlay, and UPnP display-only state requires the root-only authenticated
curl configuration and a live pairing grant. A failed or expired grant must
not be mistaken for a server playback failure.

Last updated: 2026-11-12
