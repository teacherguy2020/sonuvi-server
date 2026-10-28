---
title: deployment-and-ops
page_type: support
topics:
  - ops
  - runtime
  - environment
  - controller
confidence: high
---

# deployment and ops

## Purpose

This page explains how changes in `now-playing` actually become live.

A better way to think about this page is:
- not “what are the operational themes?”
- but “if I change **this kind of thing**, what actually happens next?”

So the point of this page is to help answer:
- what did I actually change?
- which machine or process does that affect?
- does the change usually need only refresh/verification, or also restart?
- what should I verify afterward?

## The main operational lesson

The most important thing to learn from this system is:

> a change can succeed at one layer and still fail to produce the effect you actually care about.

Examples:
- an endpoint can return success, but the moOde display target still may not have changed
- a UI file can look correct in a normal browser, but still be wrong in kiosk or embedded mode
- config can be written successfully, but startup-captured behavior may not change until restart
- app-host logic can be correct while the visible result is still wrong on the moOde host

That is the real operational shape of the project.

## The system has more than one operational plane

A useful concrete split is:

### 1. App host plane
This is where the app-host API and served UI live.
Typical examples:
- `moode-nowplaying-api.mjs`
- `src/routes/*.mjs`
- `app.html`, `controller.html`, `kiosk.html`, `visualizer.html`
- browser JS/CSS under the app tree

This plane owns things like:
- `/now-playing`
- `/next-up`
- controller/kiosk/display page serving
- queue/playback mediation logic
- config/runtime-admin routes

### 2. moOde host effect plane
This is where some display/runtime effects become visibly real.
Typical examples:
- browser target changes
- display target switching
- peppy/browser-mode effects
- some runtime-admin actions that reach across to the moOde host

This means an app-host route can be correct while the real display effect is still wrong.

### 3. Host override plane
This includes manual or mirrored host-side override material.
Typical examples:
- moOde-side override scripts
- host patches documented in `local-environment.md` or mirrored under ops/integrations material

This is separate from normal app-file deployment and should not be mentally collapsed into it.

## Current Server deployment boundary

The primary live app target is the configured Pi5 Sonuvi Server installation.
Use approved immutable artifacts, `/opt/sonuvi/current`, and
`sonuvi-api.service` / `sonuvi-web.service`. See
[Sonuvi Server operations](../runbooks/sonuvi-server-operations.md).
The old installer and `scripts/deploy-pi5-files.sh` now refuse mutations; copying
individual files into a release would invalidate its manifest.

- Frontend changes also require a verified release artifact; browser refresh alone
  does not deploy source changes.
- API and web form a coupled systemd pair. Restart both together when authorized;
  verify service readiness and the affected endpoint afterward.
- Verify the live `/now-playing`, `/next-up`, and relevant authenticated mobile
  route rather than relying on a successful copy or HTTP response alone.
- An alternate deployment checkout is not an active target and must not be used
  unless Brian explicitly requests that deployment target.

The moOde host is a separate operational plane. Qobuz release/handoff may use
the established guarded moOde/PiBuZ lifecycle, while UPnP renderer state and
Peppy/display overrides have their own recovery checks. A Server deployment,
a docs-only change, and an explicit live release action are different events;
do not claim one from evidence of another.

## Change type → effect → verify

This is the most useful part of the page.

## 1. If you changed a browser page or frontend-only asset

Typical examples:
- `controller.html`
- `app.html`
- `kiosk.html`
- `visualizer.html`
- CSS
- browser-side JS used by those pages

### What that usually means
You changed what the app host serves to the browser.

### What usually becomes live
- the new file content becomes live when the updated file is served
- a page refresh is often enough
- API restart is often unnecessary **if the change is truly frontend-only**

### What to verify
Verify the page in the real context that matters.

Examples:
- `controller.html` change → verify normal controller and kiosk/controller-backed behavior if relevant
- `visualizer.html` change → verify both fullscreen visualizer behavior and embedded pane behavior if relevant
- `kiosk.html` change → verify the redirect handoff path into `controller.html`, not just the standalone file

### Real lesson
Frontend-only does **not** mean “check in one browser tab and declare victory.”
It means “the server process may not need restart, but the real operating context still matters.”

## 2. If you changed route logic or service logic

Typical examples:
- `src/routes/*.mjs`
- service/helper code used by routes
- `moode-nowplaying-api.mjs`

### What that usually means
You changed app-host behavior, not just presentation.

### What usually becomes live
- the changed code must be loaded by the app-host process
- process restart may be needed, depending on how the runtime currently loads that code

### What to verify
First verify the route directly.
Then verify the surface that depends on it.

Examples:
- changed `/now-playing` logic in `moode-nowplaying-api.mjs`
  - verify `/now-playing` directly
  - then verify controller/display/kiosk surfaces that consume it
- changed queue route logic
  - verify the route first
  - then verify queue UI / next-up / playback behavior

### Real lesson
If the route is wrong, UI verification alone is too indirect.
If the route is right, UI verification still matters because some bugs are downstream of a correct route.

## 3. If you changed runtime-admin behavior

Typical examples:
- `src/routes/config.runtime-admin.routes.mjs`
- `/config/runtime/*`
- `/config/moode/*`
- `/config/services/*`
- `/config/restart-*`

### What that usually means
You changed control-plane behavior, not just config text.

### What usually becomes live
One of three things may be true:
- the route writes config only
- the route changes live app-host behavior immediately
- the route triggers host-side behavior on the moOde host or service layer

### What to verify
You must verify the correct effect layer.

Examples:
- `/config/runtime/check-env`
  - verify returned checks/results
- `/config/moode/browser-url`
  - verify that the real moOde display target changed
- `/config/services/mpdscribble/action`
  - verify service status, not just response JSON

### Real lesson
A successful runtime-admin response does not automatically prove the intended host/runtime effect happened.

## 4. If you changed a state-truth endpoint

Typical examples:
- `/now-playing`
- `/next-up`
- Alexa state helpers
- nearby payload-normalization logic

### What that usually means
You changed one of the system’s central truth surfaces.

### What usually becomes live
- the app-host endpoint behavior changes
- every dependent surface may shift with it

### What to verify
Always verify the endpoint itself first.
Then verify the highest-value dependent surfaces.

Example:
- changed `/now-playing`
  - verify `/now-playing`
  - then verify controller shell, display target, and kiosk-visible now-playing behavior

### Real lesson
These are high-blast-radius changes.
They are not “just another backend route.”

## 5. If you changed a host override or host-side patch

Typical examples:
- moOde-side patch material
- host override scripts
- documented live patches in `local-environment.md`

### What that usually means
Normal app deploy assumptions are not enough.

### What to verify
- verify the real host state
- verify the real live effect on that host
- do not confuse mirrored repo material with already-applied host state

### Real lesson
The repo may document the override, but that does not guarantee the live machine is in sync.

## App host vs moOde host: the key question

When something changed and the visible system still looks wrong, ask:

### “Which machine should have changed?”

#### App host answers questions like:
- did the route change?
- did the served page change?
- did `/now-playing` output change?
- did controller/kiosk page logic change?

#### moOde host answers questions like:
- did the browser target change?
- did the actual room-facing display switch?
- did a host-side display/runtime action take effect?

This distinction explains a lot of false positives and false negatives during verification.

## Restart reality

A useful concrete rule is:
- not every change needs restart
- but route/service/startup-captured behavior is more restart-sensitive than page-only changes

### Often restart is not the first question
Examples:
- page markup or CSS changed
- browser-side JS changed

Start with:
- file served?
- page refreshed?
- correct real surface verified?

### Often restart becomes part of the question
Examples:
- route logic changed
- runtime behavior depends on startup-captured values
- env-backed config behavior changed

Start with:
- direct route verification
- then restart-sensitive reasoning if the live behavior didn’t change

For the more detailed restart reasoning, use:
- `restart-and-runtime-admin-troubleshooting.md`
- `backend-change-verification-runbook.md`

## What to verify after common change types

## Example: changed `controller.html`

Likely effect:
- app-host-served UI changed

Usually verify:
- normal controller view if relevant
- kiosk/controller-backed path if relevant
- embedded child interactions if relevant

Usually first question:
- did the new file get served and loaded in the real context?

## Example: changed `visualizer.html`

Likely effect:
- app-host-served visualizer behavior changed

Usually verify:
- fullscreen visualizer
- embedded visualizer if used in pane mode
- push-to-moOde behavior if relevant

Usually first question:
- is the visualizer wrong in the engine itself, or only in embedded/kiosk hosting?

## Example: changed `moode-nowplaying-api.mjs`

Likely effect:
- state-truth endpoint behavior changed
- visible downstream surfaces may also change

Usually verify:
- `/now-playing`, `/next-up`, or the specific endpoint directly
- then controller/display surfaces that consume the payload

Usually first question:
- did the central truth surface change as expected?

## Example: changed `config.runtime-admin.routes.mjs`

Likely effect:
- runtime-admin/control-plane behavior changed
- may affect app host, moOde host, or both

Usually verify:
- endpoint response
- actual target effect (service state, browser target, host result)

Usually first question:
- which machine or process was supposed to change?

## Example: changed moOde-side override material

Likely effect:
- real host behavior changed outside the normal app tree

Usually verify:
- live host state
- live effect on that host

Usually first question:
- am I verifying the real host, or just the mirrored repo copy?

## Best companion pages by question

### “What does Brian’s real setup look like?”
Use:
- `local-environment.md`

### “Do I need restart or only verification?”
Use:
- `restart-and-runtime-admin-troubleshooting.md`
- `backend-change-verification-runbook.md`

### “How do I verify a display-side change?”
Use:
- `display-issue-triage-runbook.md`
- `display-surface-troubleshooting.md`

### “How do I verify playback/state truth changes?”
Use:
- `playback-issue-triage-runbook.md`
- `playback-authority-by-mode.md`
- `api-state-truth-endpoints.md`

## What this page is now really teaching

The page is trying to teach these system truths:
- there is more than one operational plane in the project
- the app host and moOde host should not be collapsed mentally
- different change types become live in different ways
- the first verification question is often “what layer should have changed?”
- successful response, served file, and visible effect are three different things

## Relationship to other pages

This page should stay linked with:
- `local-environment.md`
- `config-network-and-runtime.md`
- `backend-change-verification-runbook.md`
- `restart-and-runtime-admin-troubleshooting.md`
- `display-issue-triage-runbook.md`
- `playback-issue-triage-runbook.md`

## Current status

At the moment, this page should be read as a practical change-type → effect → verify guide.

Its job is not to sound operational.
Its job is to help an agent decide:
- what kind of change was made
- which machine/process should actually be affected
- what must be checked next
- and why a “successful” result at one layer may still not mean the system changed in the way you intended.

*Last reviewed: 2026-10-28 America/Chicago*
