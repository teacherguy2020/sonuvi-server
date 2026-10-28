---
title: display-enhancement-peppy-player-flow
page_type: child
topics:
  - display
  - peppy
  - player
  - moode
confidence: high
---

# display enhancement, peppy, and player flow

## Purpose

This page documents the builder-first display-enhancement system around:
- Peppy
- Player
- Visualizer
- the stable moOde router target

It exists because the general display branch already explains the broad structure, but this specific branch needs a more concrete operational description.

Use this page when the question is:
- how does moOde Display Enhancement actually work?
- what is the stable display target model?
- how do Peppy and Player differ from kiosk shell mode?
- how do VU and spectrum data reach the browser-based display system?
- what boot-persistence or bridge-mode caveats matter here?

## Why this page matters

The most important truth in this branch is:
- this is a **builder-first display system**, not just a set of standalone display pages

That means the intended workflow is not:
- edit random host files
- point moOde at different raw pages manually every time

The intended workflow is:
- design a display composition in the UI
- push that composition through a stable router target
- let the app-host own mode switching and persisted display state

That is the core design idea.

## What this branch includes

The display-enhancement branch revolves around these pages:
- `peppy.html`
- `player.html`
- `player-render.html`
- `visualizer.html`
- `display.html`

A useful split is:
- **designer surfaces**
  - `peppy.html`
  - `player.html`
  - `visualizer.html` when used with its control layer
- **runtime renderer surfaces**
  - `player-render.html`
  - `visualizer.html`
  - `peppy.html`
- **router surface**
  - `display.html`

## Relationship to the config feature

This system is enabled through the Config feature:
- `features.moodeDisplayTakeover`

Useful companion page:
- `config-display-and-render-features.md`

Practical meaning:
- when moOde Display Enhancement is disabled, these display-tooling flows should not be treated as active mainline UI paths

## Stable target URL model

One of the most important operational facts is:
- moOde should generally point at one stable browser target URL

Recommended target:

```text
http://<WEB_HOST>/display.html?kiosk=1
```

For moOde r1034 and later, this Target URL must be portless. The LAN proxy
serves the display route on HTTP port 80 and forwards it to the Sonuvi
web service; do not use `:8101` in moOde's Target URL field.

Why this matters:
- users should not have to keep changing the moOde Web UI target URL whenever they switch among Peppy, Player, and Visualizer
- `display.html` acts as the stable router layer
- the chosen mode/profile is stored separately and resolved by the app-host

## Router behavior

`display.html` reads saved display-profile state and resolves one of these runtime modes:
- `displayMode=peppy` -> `peppy.html`
- `displayMode=player` -> `player-render.html`
- `displayMode=visualizer` -> `visualizer.html`
- `displayMode=moode` -> `http://moode.local/index.php`

That means router target and active display mode are intentionally decoupled.

## Why kiosk is not the same thing as Peppy or Player

A key branch distinction is:
- **Peppy / Player / Visualizer** are display modes or renderers
- **kiosk** is a shell/presentation mode

This matters because it is easy to confuse:
- the stable router target ending in `?kiosk=1`
- actual kiosk shell behavior elsewhere in the repo

In this branch, the important thing is not kiosk shell routing.
The important thing is:
- the router target is stable
- display mode selection is persisted separately

## Builder-first display design

This project intentionally combines multiple display concerns into one builder-driven design flow.

The aim is not just to pick meter art.
The aim is to build a complete display composition involving:
- meter geometry
- meter skin or display style
- typography
- progress style
- metadata visibility
- theme language
- source-sensitive display behavior

That is why this branch should be understood as a builder system rather than a loose collection of pages.

## Peppy data pipeline: VU and spectrum

One of the most concrete truths in this branch is that the browser display does **not** read ALSA directly.

Instead, the system uses HTTP bridge surfaces.

## 1. VU feed

Producer:
- moOde peppymeter path

API ingest:
- `PUT /peppy/vumeter`

UI read:
- `GET /peppy/vumeter`

## 2. Spectrum feed

Producer:
- peppyspectrum FIFO reader bridge

API ingest:
- `PUT /peppy/spectrum`

UI read:
- `GET /peppy/spectrum`

Practical meaning:
- the browser-side Peppy/visualizer flow is downstream of an HTTP-fed data bridge, not direct device access

## Bridge-mode exclusivity rule

This is one of the highest-value operational guardrails.

Rule:
- fullscreen native `spectrum.py` and the HTTP spectrum bridge should not both act as concurrent readers of `/tmp/peppyspectrum`

Required mode split:
- **Skins/WebUI mode**
  - bridge ON
  - native fullscreen spectrum OFF
- **Native fullscreen spectrum mode**
  - bridge OFF
  - native fullscreen spectrum ON

Why this matters:
- if both readers are active, spectrum behavior can become unstable or misleading
- this is an integration/runtime rule, not just a UI preference

## Required HTTP targets in bridge mode

For WebUI/bridge mode, the moOde-side targets should resolve to the app-host API.

Expected targets:
- Peppy VU target -> `http://sonuvi.local:3101/peppy/vumeter`
- Peppy Spectrum target -> `http://sonuvi.local:3101/peppy/spectrum`
- Spectrum update period -> `0.05`

The exact host may vary by environment, but the operational point stays the same:
- browser-driven display mode depends on API-hosted VU/spectrum ingress paths

## Boot-persistence caveat

A high-value operational lesson from the source docs is:
- some moOde builds may lose or reset Peppy HTTP target settings on reboot

Most likely effect:
- spectrum falls back or stops working correctly after reboot
- VU or display behavior no longer matches the expected browser-driven path

## Recommended mitigation

Use moOde startup hook behavior to restore the expected target configuration after boot.

Typical expectations of the restore logic:
- restore `/etc/peppyspectrum/config.txt` HTTP target
- restore `/etc/peppymeter/config.txt` HTTP target
- ensure `/opt/peppyspectrum/config.txt` points to `/etc/peppyspectrum/config.txt`
- start `peppy-spectrum-bridge.service`

This matters because the design intent is:
- normal users should not need to hand-edit config files repeatedly just to keep the display system alive after reboot

## Quick verify after boot

Useful checks:

```bash
curl -s http://127.0.0.1:3101/peppy/vumeter
curl -s http://127.0.0.1:3101/peppy/spectrum
```

Expected result:
- both return fresh data
- spectrum should expose non-empty bins while audio is active

## Peppy builder model

`peppy.html` is not just a static display page.
It is a composition builder.

Important builder axes include:
- preset
- meter type
- circular skin
- linear style
- linear size
- spectrum color/theme
- spectrum energy
- spectrum peak behavior
- font style
- font size
- sensitivity
- smoothing
- theme preset

Why this matters:
- the user-facing design model is feature-rich enough that future agents should not collapse it mentally into just "Peppy skin selection"

## Meter-type interpretation

Useful split:
- **circular** -> classic dual VU style
- **linear** -> horizontal rail style
- **spectrum** -> multi-band spectrum renderer inside the same display composition family

That means Peppy is really a broader display-composition family, not just one old-school meter skin.

## Save vs push distinction

This is another important operator-facing rule.

## Save as preset

Meaning:
- stores profile in preset list
- convenience for future builder reuse
- does **not** by itself retarget the moOde display

## Push to moOde

Meaning:
- sends active profile state to the API
- updates or relies on the stable router target
- makes the selected display mode/profile live on the moOde browser display

This distinction matters because otherwise it is easy to think a saved preset should already be live on the room display.

## Push flow summary

A practical push flow looks like:
1. build or adjust profile in UI
2. push chosen mode to app-host state
3. ensure moOde browser target points to stable router URL
4. let `display.html` resolve the chosen renderer/profile

This is the core operational model of the system.

### Implementation effects and data direction

```text
Builder intent -> profile persistence (POST /peppy/last-profile)
Explicit Push -> host/browser targeting or reload action
Router load -> GET /peppy/last-profile -> set renderer iframe src
moOde meter/spectrum producer -> PUT samples -> Server -> GET samples -> browser
```

`POST /peppy/last-profile` writes profile state; it does not itself run SSH or
restart Chromium. `display.html` reads the profile once on load and assigns
its iframe `src`; it does not perform a `location.replace` renderer redirect
or continuously poll that profile. Explicit push/reload is a separate effect.
The builder/host actions, persisted profile and active renderer must therefore
be inspected separately when an apparent push does not become visible.

For moOde r1034+, retain the portless Target URL guidance above. Some runtime
fallback strings still contain `:8101`; those are legacy implementation
context, not instructions to reintroduce that port in moOde's target field.

Browser skins use `assets/peppy/catalog.json`; native skin export reads
`skins/*/meter.json` and currently selects 1280×400 circular definitions.
Runtime assets, authored definitions and exported artifacts are not one
interchangeable source of truth.

## Player branch

The Player family in this branch includes:
- `player.html` as the builder/designer surface
- `player-render.html` as the runtime renderer

This is conceptually similar to the Peppy split:
- design on one page
- render on another
- let the router target stay stable

## Visualizer branch within display enhancement

Visualizer participates in the same stable-router ecosystem.

Useful companion page:
- `visualizer-in-embedded-mode.md`

Important truth here:
- Visualizer is a real peer display mode in the router model
- it is not only an embedded controller-pane feature

## Verification points

If this branch seems broken, the highest-value first checks are:

### Router-target check
- is moOde pointing to `display.html?kiosk=1` as intended?

### Runtime mode check
- what `displayMode` is currently stored/resolved?

### Feed check
- do `/peppy/vumeter` and `/peppy/spectrum` return live data?

### Boot-persistence check
- did a reboot wipe the expected moOde-side HTTP targets?

### Exclusivity check
- is native fullscreen spectrum competing with the HTTP bridge?

These checks usually beat guessing at CSS or renderer internals first.

## Best companion pages

- `display-interface.md`
- `display-launch-and-wrapper-surfaces.md`
- `config-display-and-render-features.md`
- `visualizer-in-embedded-mode.md`
- `local-environment.md`
- `deployment-and-ops.md`

## Current status

At the moment, this page should be treated as the concrete operational reference for the builder-first display-enhancement system.

The main truths it preserves are:
- the stable router target is intentional
- Peppy/Player/Visualizer are renderer-style display modes
- kiosk is a different concept from those renderer modes
- browser-driven display behavior depends on API-hosted VU/spectrum bridge data
- boot persistence and bridge-mode exclusivity are real operational guardrails

*Last reviewed: 2026-10-28 America/Chicago*
