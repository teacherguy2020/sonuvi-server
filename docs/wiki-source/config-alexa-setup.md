# config alexa setup

## Purpose

This page documents the Alexa setup portion of `now-playing/config.html`.

It exists because the Config page owns the provisioning/setup side of the Alexa integration, while the separate `alexa.html` page owns the correction/review side.

This page is about the setup layer:
- enablement
- public domain
- Homebridge start/stop action webhook URLs
- domain reachability checks
- Alexa Developer Console skill and interface requirements
- setup-state visual feedback

## Alexa Developer Console requirements

The repository-side skill is branded **Sonuvi**. In the Alexa Developer
Console, use:

- **Skill display name:** `Sonuvi`
- **Invocation name:** `sonuvi audio`
- **Build → Interfaces:** enable **Audio Player**

The Audio Player interface is required for Echo playback and for the skill's
`AudioPlayer.Play`, `AudioPlayer.Stop`, and playback lifecycle events. This is
separate from the interaction model JSON and from the Lambda ZIP. Keep the
existing intent names, API contracts, and playback behavior unchanged.

## Why this page matters

Alexa support in this system is not only a matter of turning a feature on.
It also depends on:
- whether Alexa support is enabled
- whether a public domain is configured
- whether that public domain is actually reachable
- whether start/stop Alexa actions have the correct Homebridge webhook URLs

That makes the Config page the provisioning/control-plane side of Alexa.

## Important file

Primary file:
- `now-playing/config.html`

Related pages:
- `config-interface.md`
- `config-feature-breakdown.md`
- `alexa-interface.md`
- `integrations.md`

## High-level role

A good current interpretation is:
- `config.html` owns Alexa setup/provisioning state
- `alexa.html` owns Alexa corrections, recently-heard review, and operator guidance
- both pages are part of the Alexa branch, but they serve different jobs

That split is one of the most important things to preserve in the wiki.

## Main visible controls

Observed Alexa setup UI elements include:
- `featureAlexaSkill`
- `alexaDomain`
- `checkAlexaDomainBtn`
- `alexaDomainCheckStatus`
- `alexaDomainLight`

There is also wider shell-level health feedback through:
- `alexaHint`
- `alexaPill`

## 1. Alexa enablement

Observed behavior includes:
- Config loads enable state from:
  - `c.alexa?.enabled`
- Save assembly persists:
  - `alexa.enabled`

### Why it matters
This is the top-level switch for whether Alexa integration is active in the config model.

## 2. Public domain configuration

Observed field includes:
- `alexaDomain`

Observed save behavior persists this to:
- `alexa.publicDomain`

### Why it matters
The public domain appears to be a core requirement for Alexa reachability.
The page also uses domain presence/absence as a major signal in its status lights and pill state.

### Health-state behavior from config load
Observed behavior includes:
- if Alexa is disabled:
  - hint becomes `disabled`
  - Alexa pill is `off`
  - domain light is neutral
- if enabled but domain missing:
  - hint becomes `missing domain`
  - Alexa pill is `warn`
  - domain light is bad
- if enabled and domain present:
  - hint becomes masked domain text like `moode.••••••••.com`
  - Alexa pill becomes good
  - domain light becomes good

This means the Config page is actively interpreting Alexa setup state, not merely storing values.

## 3. Homebridge Alexa actions and state

The Config page retains two webhook fields:

- `alexa.routeWebhookUrl` → Homebridge `/api/v1/actions/alexa-start`
- `alexa.stopWebhookUrl` → Homebridge `/api/v1/actions/alexa-stop`

These actions trigger Matter switches that Alexa routines use to start or stop
Alexa playback. Alexa Mode itself is a separate Matter status switch. Homebridge
reports that status to the authenticated `POST /integrations/alexa/state`
endpoint with `{"state":"on"}` or `{"state":"off"}`.

The state endpoint is idempotent and does not invoke either webhook or alter
MPD/moOde playback.

The Homebridge VirtualControls plugin also provides these Alexa actions:

- `/api/v1/actions/alexa-start` → Alexa Start Trigger
- `/api/v1/actions/alexa-stop` → Alexa Stop Trigger
- `/api/v1/actions/alexa-pause` → Alexa Pause Trigger
- `/api/v1/actions/alexa-resume` → Alexa Resume Trigger
- `/api/v1/actions/alexa-next` → Alexa Next Trigger
- `/api/v1/actions/alexa-finished` → Alexa Mode OFF after natural completion

The first five action switches are momentary routine triggers. The final
action is an idempotent state action: it turns only the Alexa Mode status
switch off and does not stop MPD or invoke the Alexa Stop Trigger.

Natural Alexa completion is determined by the skill, not by MPD queue length.
When `PlaybackNearlyFinished` finds no successor, the skill persists the
current token as a final-track candidate. A matching `PlaybackFinished` event
then calls the authenticated `POST /alexa/natural-finish` endpoint. This
endpoint derives the sibling `/api/v1/actions/alexa-finished` URL from the
configured Alexa start webhook and clears Sonuvi Alexa state only after
the Homebridge action succeeds.

## 4. Domain reachability check

This is one of the most important active setup workflows in the Config page.

Observed function includes:
- `checkAlexaDomain()`

### Observed behavior
- requires track key
- requires a public domain value
- disables the check button while running
- updates `alexaDomainCheckStatus`
- sends:
  - `POST /config/alexa/check-domain`
- includes:
  - `Content-Type: application/json`
  - `x-track-key`
  - `{ domain }`
- reports either:
  - reachable URL + status code
  - not reachable result
  - or explicit failure state

### Why it matters
This is a real verification workflow, not just a config field.
It gives the operator direct feedback on whether the configured Alexa domain appears externally reachable.

## 5. Setup-state UI helpers

Observed logic includes:
- `syncAlexaCardVisibility()`
- `syncAlexaDomainUi()`

### Working interpretation
These helper functions appear to manage:
- whether Alexa setup fields should be visually emphasized or gated
- whether the domain-check button should be visible
- whether the current input state should change the domain-light appearance

This means the page is trying to guide operators through setup states rather than present a static form.

## Automatic verification behavior

Observed config-load behavior includes:
- when Alexa is enabled
- and a public domain exists
- and a track key is available
- the page auto-runs `checkAlexaDomain()` after load

### Why it matters
That means the page is not waiting passively for the operator to ask for verification.
It proactively checks the configured domain when conditions are right.

This is a useful quality-of-life behavior and an important part of how the setup flow actually feels.

## Explicit handoff to the dedicated Alexa page

The Alexa section in Config explicitly says:
- Alexa corrections and misheard review moved to the dedicated `alexa.html` page
- Config is the source of truth for enable/domain setup
- the Alexa page focuses on corrections and misheard review

### Why it matters
This is the strongest explicit evidence of the intended split.

A good wiki distinction is therefore:
- `config-alexa-setup.md` = provisioning/setup/control-plane view
- `alexa-interface.md` = correction/review/usage-guidance view

## Hidden compatibility elements

The Alexa block keeps several legacy IDs in hidden markup for script compatibility, including alias/review-related containers and JSON textarea fields.

### Working interpretation
This suggests the Alexa configuration surface evolved over time:
- earlier versions likely mixed setup and correction features more directly on Config
- newer structure has moved correction/review work into the dedicated Alexa page
- some hidden compatibility markup remains to avoid breaking existing script logic

That is historically interesting and practically relevant.

## Important API surface

The key explicit Alexa setup endpoint visible here is:
- `POST /config/alexa/check-domain`

The rest of the Alexa setup behavior appears to be persisted through the broader config save path rather than separate Alexa-only save endpoints.

## User/operator workflow model

A useful current setup workflow is:

### Initial provisioning workflow
1. enable Alexa support
2. enter public domain
3. enter the Homebridge start and stop action webhook URLs if Alexa controls are needed
4. save config
5. verify domain reachability

### Verification workflow
1. review Alexa pill/hint state
2. inspect domain light and status text
3. run or re-run domain check
4. correct domain if it is missing or unreachable

### Ongoing maintenance workflow
1. keep enable/domain/webhook values current in Config
2. use the dedicated Alexa page for corrections and misheard cleanup

## Architectural interpretation

A good current interpretation is:
- this Config block is the Alexa provisioning layer
- it exposes both configuration fields and validation feedback
- it should be treated as the setup/control-plane half of the Alexa branch

## Relationship to other pages

This page should stay linked with:
- `config-interface.md`
- `config-feature-breakdown.md`
- `alexa-interface.md`
- `integrations.md`

## Things still to verify

Future deeper verification should clarify:
- the webhook actions trigger Homebridge/Matter routines, while the state endpoint receives status feedback
- what URL/path the domain checker probes behind the scenes
- whether additional Alexa provisioning requirements exist outside what Config currently exposes
- whether the hidden legacy Alexa DOM elements can eventually be removed or are still functionally required

## Current status

At the moment, this page gives the Alexa setup block in Config the right scope.

It is not the corrections page.
It is the provisioning page for:
- enablement
- public domain
- Homebridge webhook actions and Alexa Mode integration
- reachability verification
- setup-state feedback

## Public HTTPS readiness (2026-11-13)

The master Alexa plugin stores `publicDomain`; it does not install a public certificate or modify router forwarding. Settings distinguishes saved configuration from verified endpoint access and unverified playback. The administrator-only **Check Alexa connection** action uses the saved hostname, verifies public IPv4 DNS, normal public TLS trust/hostname matching, and the `/now-playing` JSON route. It sends no credentials, follows no redirects, and will not probe private/special-use addresses. Its result expires after one minute. Server-origin success is not external Alexa playback proof; NAT loopback can cause a local probe to fail even when external access works.

Keep the private `sonuvi.local` browser listener separate. Public certificate issuance/renewal, restricted Alexa API/audio routing, router ingress, and Lambda API_BASE/PUBLIC_TRACK_BASE/TRACK_KEY must all be established before playback can work. Restarting the API cannot provision these prerequisites.

Last updated: 2026-11-13

### Managed public endpoint

On a host provisioned with `sonuvi-alexa-public.service` and `sonuvi-alexa-public-reconcile.timer`, the saved JSON hostname and enable flag are reconciled every minute by `scripts/sonuvi-alexa-public-https.mjs`. Caddy obtains/renews a public certificate using TLS-ALPN-01 and serves only the explicit Alexa route/method allowlist. The private local browser stays on 443; Eero maps external TCP443 to internal TCP9443. No port80 is required. Invalid or disabled Alexa config stops the public listener. The service marker means provisioning is installed, not that issuance or external playback succeeded. Ordinary hosts without this provisioning continue to show the explicit missing-setup guidance.

Public proxy upstream Host is pinned to the loopback API authority. Artwork handlers perform same-origin internal lookups; forwarding the public Host causes a public HTTP detour and can exceed the iOS notification extension eight-second image deadline. Verified symptom: local thumbnail5ms, publictimeout8002ms.
