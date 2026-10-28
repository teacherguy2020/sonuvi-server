# Sonuvi Server — DeepWiki Architectural Review (2026-10)

## Review status

- **Review date:** 2026-10-20
- **DeepWiki entry point:** [Sonuvi Server overview](https://deepwiki.com/teacherguy2020/now-playing/1-overview)
- **DeepWiki publication timestamp shown by the mirror:** 2026-10-20T12:20:14.694701
- **DeepWiki source revision:** dee06724c3549b9ab87fc70412ce1043572befab
- **Current repository revision:** 8c194c2f2ec2f90fe858b79529d8fbce3460f7b4
- **Current branch:** main
- **Repository state at review start:** clean; local main and origin/main were identical
- **Review artifact:** this document only; it is uncommitted in an isolated detached worktree

This is an analysis-first audit. No production code, API contract, service,
deployment, iOS repository, or current main worktree was changed.

## Executive assessment

DeepWiki is useful and generally accurate as a compact orientation to the
original Sonuvi enhancement layer: moOde/MPD remains a foundational playback
domain, the API and static web host form the application tier, the display
router is a deliberate stability boundary, and the legacy control surface is
protected by a Track Key.

Its coverage is not a current architectural review of the repository,
however. The overview navigation does not expose the complete numbered
hierarchy. A recursive traversal of every same-repository DeepWiki link found
and fetched 79 URL variants; after normalizing duplicate aliases and two
non-page trailing artifacts, it covered **77 canonical numbered pages across
sections 1–11**. Every canonical page reported the same publication timestamp
and source revision recorded above. No same-repository DeepWiki page linked by
the traversed hierarchy was left unvisited.

The complete page inventory was:

- **1 — Overview:** Overview; System Architecture; Installation and Setup;
  Key Concepts.
- **2 — User Interfaces:** User Interfaces; Application Shell; Now Playing
  Displays; Mobile Controller Dashboard; Kiosk Mode; Diagnostics Interface;
  Tablet Controller; Library Browse Panes; Desktop Display; Mobile Display.
- **3 — Display Enhancement System:** Display Enhancement System; Overview
  and Push Model; Peppy Builder and Renderer; Player Builder and Renderer;
  Display Router; Audio Data Pipeline; Peppy Skin Assets and Export.
- **4 — Queue Management:** Queue Management; Queue Wizard Interface; Filter
  Builder; Vibe Discovery; Playlist and Podcast Queues; Live Queue Editing.
- **5 — Media Library:** Media Library; Library Health Dashboard; Static Album
  Art; Animated Art System; Metadata Inspector; Podcast Management; Radio
  Station Browser.
- **6 — Playback Features:** Playback Features; Now Playing System; Transport
  Controls; Ratings and Favorites; Progress and State Tracking; Listen on
  Device; Listening History and Scrobbling.
- **7 — External Integrations:** External Integrations; Alexa Voice Control;
  moOde Integration; Last.fm Vibe Discovery; YouTube Proxy; iTunes and Motion
  Art APIs; Seeburg and Multiphone Jukebox Integrations; Mills Throne Jukebox
  Integration; Echo Link Volume Bridge; UPnP Control Point and Qobuz Connect.
- **8 — Theme & Customization:** Theme & Customization; Theme Token System;
  Theme Editor; Responsive Layouts; Peppy Skins and Customization.
- **9 — Backend API:** Backend API; API Architecture; Core Endpoints; MPD
  Integration; SSH Bridge; Cache Systems; Mobile and CarPlay API; Audio Info
  and Source Diagnostics.
- **10 — Configuration & Administration:** Configuration & Administration;
  Configuration Interface; Runtime Verification; Service Control; Diagnostics
  Tools; moOde Overrides and Ops Units.
- **11 — Development:** Development; Development Setup; API Extension; UI
  Component Patterns; Testing and Debugging; Documentation Pipeline; Public
  Sonuvi Site and CI.

The relevant
[UPnP Control Point & Qobuz Connect](https://deepwiki.com/teacherguy2020/now-playing/7.9-upnp-control-point-and-qobuz-connect)
page therefore is part of the full audit, not an isolated exception. The
traversal also checked each page's same-repository navigation links; external
source/documentation references were treated as evidence to compare against
the current checkout rather than as additional DeepWiki pages.

The reviewed pages point at dee06724. Current main contains a later,
material change set: 15 files differ from that revision, with 986 insertions
and 72 deletions. The delta includes the Qobuz Connect control/release
lifecycle, mobile routes, current UPnP session handling, and the associated
tests and documentation. Page 7.9 provides meaningful coverage of UPnP,
mobile UPnP, Qobuz observation, identity boundaries, tests, and the iOS
handoff, but it still describes the older read-only Qobuz control boundary.
The initial claim that only four pages existed was incorrect; the complete
77-page inventory above is the basis for the findings below.

**Overall classification: PARTIALLY CORRECT, materially incomplete for the
current Server.** DeepWiki is safe as a legacy-topology starting point. It
must not be treated as the current source of truth for playback authority,
queue ownership, authentication, Qobuz, UPnP, mobile contracts, or iOS
architecture.

Direct requests to DeepWiki returned a Vercel HTTP 429 challenge during this
audit. The pages were reviewed through the read-only Jina mirror, which
returned page text, links, source references, and revision identifiers. The
mirror did not expose a complete tree from the overview alone, so the audit
followed section-parent links recursively and verified the resulting full
same-repository inventory rather than treating the overview navigation as
complete.

## 1. Comparison baseline

### Repository state

| Item | Result |
| --- | --- |
| Branch | main |
| Local HEAD | 8c194c2 — fix(upnp): wait for renderer readiness before play |
| origin/main | 8c194c2 |
| Ahead/behind | 0 / 0 |
| Worktree | Clean |
| DeepWiki revision | dee06724 — Revise README for improved clarity and details |
| Current-vs-DeepWiki delta | 15 files; 986 insertions, 72 deletions |

The current revision includes, among other changes:

- Qobuz Connect control and release code
- the PiBuZ Qobuz control adapter
- mobile Qobuz, UPnP, local-source, playback-event, and history routes
- current UPnP renderer-session/readiness logic
- audio and route-contract tests
- current Qobuz and UPnP documentation updates

The review did not clean, reset, stash, rebase, merge, deploy, restart, or
commit anything in the active repository.

### Authority order used for the comparison

The comparison followed the repository's documented precedence:

1. Current source code and verified repository contracts
2. Canonical editable documentation in docs/wiki-source/
3. Root documentation and runbooks
4. DeepWiki's derived pages

DeepWiki was used as an independent architectural description, not as an
authority.

## 2. Coverage comparison

| Area requested for review | DeepWiki coverage | Current assessment |
| --- | --- | --- |
| System overview and legacy topology | Strong | Mostly VERIFIED |
| Backend services and routing | High-level only | PARTIALLY CORRECT; current route families are much broader |
| moOde/MPD integration | Strong | VERIFIED for the MPD domain; incomplete as a whole-system model |
| Playback authority and state | Legacy MPD-centered view | PARTIALLY CORRECT and potentially misleading without source qualification |
| Queue management and Queue Wizard | Not meaningfully covered | Incomplete |
| Vibe Radio and Last.fm | Not meaningfully covered | Incomplete |
| Listening history and scrobbling | Page 6.6 is titled for this topic, but its body explicitly says the supplied material does not establish history/scrobbling and instead documents About/Apple enrichment | DeepWiki coverage is mislabeled and does not establish the current shared event pipeline |
| Library and metadata | Substantial pieces across sections 5, 6.6, and 7.5 | Useful orientation, but the current provider-neutral About/Apple contract and ownership are clearer in canonical docs |
| Display, Peppy, Player, visualizer, kiosk | Good legacy coverage | Mostly VERIFIED; operational details need current deployment links |
| Classic/controller/tablet/mobile interfaces | Partial; page 7.9 covers mobile UPnP and handoff boundaries | Current bearer contract is broader than the reviewed DeepWiki material |
| UPnP control point and renderer | Substantial coverage on page 7.9 | Useful and mostly aligned, but current readiness/control details need re-checking |
| Qobuz Connect | Substantial observation/integration coverage on page 7.9 | Observation is useful; control/release behavior is outdated at dee06724 |
| Audio Info and source diagnostics | Substantial coverage in page 9.7 | Foundation is source-backed; current mobile wrapper, freshness, and revision-specific fields still need reconciliation |
| Alexa and external integrations | Partial Alexa mention | Incomplete; Seeburg, Multiphone/Mabel, Mills, Echo Link, and current boundaries are absent |
| Deployment, configuration, and services | Installer-oriented | PARTIALLY CORRECT; live Pi5 deployment and recovery model are absent |
| Testing and troubleshooting | Minimal | Incomplete |
| Native iOS boundary | Partial page-7.9 handoff coverage | Standalone device-owned catalog direction remains incomplete |

## 3. DeepWiki claim classification

### VERIFIED claims

The following claims are supported by the current source and documentation,
with the scope qualifications noted below:

1. **The application has a moOde/MPD foundation, an app-host API/web tier,
   and browser/display surfaces.** The current root
   [ARCHITECTURE.md](../../ARCHITECTURE.md) and
   [architecture.md](architecture.md) describe this same split.

2. **The API and static web service are normally separate listeners.** The
   documented defaults remain API port 3101 and static UI port 8101. The
   stable display router is intentionally served from the UI surface rather
   than being tied to a fragile display implementation.

3. **The public state routes are central integration surfaces.** The
   /now-playing and /next-up family remains important to displays, controllers,
   and integrations, although current source-specific state is richer than
   the DeepWiki description implies.

4. **Track Key protection remains real for the classic/server control
   surface.** DeepWiki correctly identifies a bearer-like Track Key boundary
   for legacy control and configuration routes. This is not the only
   authentication domain in the current system.

5. **moOde/MPD integration uses the host's existing player state and tools
   rather than replacing moOde.** The current implementation still uses MPD
   and moOde-specific integration paths for MPD playback, queue, metadata,
   and hardware-facing behavior.

6. **The display layer has explicit modes and a builder-first Peppy path.**
   The current display and Peppy documentation supports the DeepWiki
   description of a stable display entry point, mode selection, and
   generated renderer state.

7. **The UI commonly observes normalized server state rather than directly
   coupling every surface to MPD.** This remains a useful design principle,
   but the normalized state now also has Qobuz, UPnP, radio, AirPlay, and
   device/mobile qualifications.

### PARTIALLY CORRECT claims

1. **“MPD is the audio authority.”**

   This is correct for the MPD playback domain. It is not a universal
   authority statement for the Server. Current playback authority is
   source- and target-dependent:

   - MPD/moOde owns the Home/local/radio paths that use MPD.
   - Qobuz Connect is observed and controlled through the enhanced PiBuZ
     receiver, with a separate remote queue and playback state.
   - UPnP has a Sonuvi control-point/renderer session and logical queue
     boundary; it is not just an MPD stream label.
   - native iOS playback has device-local state and uses Server contracts for
     shared observation/history during the transition.

   The current [playback-authority-by-mode.md](playback-authority-by-mode.md)
   already has the right direction but needs Qobuz and current UPnP sections.

2. **“The API is a stable router over moOde/library state.”**

   The API is still a stable control-plane boundary, but it now owns or
   mediates more than moOde/library state: mobile bearer sessions, Qobuz/PiBuZ
   observation and control, UPnP discovery and renderer sessions, audio
   diagnostics, history events, metadata enrichment, and external hardware
   integrations.

3. **“Track Key is the primary authorization model.”**

   Track Key remains primary for the classic web/controller routes. Native
   mobile routes use signed bearer sessions and scoped media/radio tickets.
   Mobile routes must not be described as raw Track-Key or raw MPD access.
   The current [mobile-auth.mjs](../../src/lib/mobile-auth.mjs) and
   [api-endpoint-catalog.md](api-endpoint-catalog.md) establish the split.

4. **“UPnP is a stream-like playback mode.”**

   That shorthand appears in the older overview material, while DeepWiki
   page 7.9 provides a much more accurate control-point, renderer-session,
   mobile-bridge, and logical-queue description. The 7.9 treatment is a
   valuable architectural insight. Current main still extends it with the
   newer readiness polling, stale-observation protection, and duplicate-Play
   handling, so the page remains revision-stale rather than being absent or
   fundamentally wrong.

5. **“Installation is represented by the installer and systemd/PM2
   configuration described by DeepWiki.”**

   The installer concepts are still useful. The live operational model also
   includes the Pi5 deployment helper, the installed systemd service,
   path-specific restart behavior, host-key pinning, and post-deployment
   verification. DeepWiki's excerpt did not establish the actual unit
   contents or the current Pi5 recovery procedure.

6. **“The API and web host are the main application boundary.”**

   This remains true, but source-specific remote systems and native mobile
   clients introduce explicit ownership boundaries inside that application
   boundary. A single “Server controls the player” statement is too broad.

### OUTDATED descriptions or implications

1. **The analyzed revision is outdated.** DeepWiki's source references stop at
   dee06724. Current main adds the Qobuz, mobile, and current UPnP changes
   listed in the baseline.

2. **The implied UPnP capability is outdated.** Current UPnP is a guarded
   control-point and renderer-session subsystem, not merely a stream-like
   display mode.

3. **The apparent completeness of the route inventory is outdated.** Pages
   9.2, 9.6, and 9.7 cover important API and diagnostics families, but they
   predate the current main route set. Current Server additions include the
   expanded Qobuz controls/release lifecycle, mobile UPnP mutations,
   local-source, playback-event, history, and revision-specific audio-info
   behavior.

4. **The deployment description is operationally incomplete.** It does not
   describe the current primary Pi5 deployment helper, live service restart
   rules, or the verification requirements used for current backend changes.

5. **The documentation corpus itself has moved.** The repository's canonical
   editable knowledge base is docs/wiki-source/, with focused source-backed
   pages and runbooks. DeepWiki should not be treated as a second maintained
   documentation hierarchy.

### INCORRECT when interpreted as a current complete architecture

No isolated sentence in the reviewed DeepWiki pages was proven flatly false
against current source when read as a description of the original
moOde-centered foundation. The following interpretation would be incorrect:

> Sonuvi Server is only an MPD/moOde enhancement layer with one queue, one
> control authority, one Track-Key authorization model, and no independent
> Qobuz, UPnP, mobile, or native-device ownership boundaries.

That is not the current architecture. The safer classification for individual
DeepWiki statements is PARTIALLY CORRECT, with the completeness implication
classified as INCORRECT.

### UNVERIFIED claims

The following could not be established from the available DeepWiki material
and were not asserted as current facts:

- exact contents, ordering, dependencies, and failure behavior of every
  systemd unit
- exact PM2 ecosystem behavior in the current deployment
- whether every installer option still matches the live Pi5 installation
- current runtime behavior of the live service, because this audit did not
  restart services, deploy, or perform live playback tests
- current Qobuz account/library behavior beyond the repository contracts
- runtime behavior of external hardware that is separately maintained

These require source inspection, deployment inspection, or a deliberately
authorized runtime test; they should not be inferred from DeepWiki.

## 4. Current architectural relationships DeepWiki does not fully capture

### 4.1 Multiple playback authorities and targets

The current system is better represented as a set of source/target domains
than as a single player:

| Domain | State/control owner | Queue or identity boundary | Server role |
| --- | --- | --- | --- |
| Home/local/radio through moOde | moOde/MPD | MPD queue and MPD/file-derived identity | Control, normalization, queue shaping, history observation |
| Qobuz Connect | Enhanced PiBuZ receiver for remote playback | Remote Qobuz queue/occurrence and PiBuZ observation | Observe, expose status/queue, issue guarded controls, perform explicit handoff/release |
| UPnP/OpenHome renderer | Sonuvi UPnP control point plus selected renderer | Process/session-owned logical queue and renderer transport | Discover, select, preflight, control, serialize startup, expose sanitized state |
| Native iOS playback | iOS device | Device-owned native queue/cache/catalog direction | Current contracts, metadata/identity bridge, playback-event/history ingestion |
| AirPlay and other external paths | External receiver/target | Source-specific external transport | Observe and normalize where supported; do not assume MPD ownership |

The important distinction is between **who currently plays bytes**, **who
owns the queue**, **who owns identity**, and **who reports shared history**.
Those are not always the same component.

### 4.2 Multiple queues

The current documentation distinguishes playback from queue shaping, but it
needs a single cross-system matrix. At minimum, the Server now has:

- the moOde/MPD live queue
- the Qobuz remote queue, including occurrence-preserving jump/control
- the UPnP logical queue and renderer session
- native iOS Home/device queues
- saved Qobuz queues, which are durable remote captures rather than the live
  MPD queue

Queue position, upcoming items, duplicates, persistence, and control commands
therefore require source-specific semantics. A generic “Next Up is the
queue” explanation is unsafe.

### 4.3 Multiple authentication domains

The current authorization boundaries are not interchangeable:

- Track Key for classic/server control and configuration
- signed mobile bearer sessions with scopes and expiry
- short-lived mobile media/radio tickets where required
- provider/receiver credentials and internal PiBuZ access
- network and renderer trust boundaries for UPnP

The mobile boundary deliberately avoids exposing raw Track Keys, MPD paths,
filesystem paths, or provider credentials to the native app.

### 4.4 Multiple identity systems

Track Keys, MPD file identity, Qobuz/PiBuZ identifiers, UPnP object/resource
references, and mobile opaque IDs are not interchangeable. The history
pipeline must qualify and deduplicate at the appropriate boundary instead of
assuming that a displayed title or artwork URL is a canonical identity.

### 4.5 Shared history and scrobbling

The current history design is a server-side event pipeline:

1. source-specific observation or an explicit mobile playback event enters the
   Server
2. the Server resolves/validates identity and source attribution
3. qualification and deduplication are applied
4. local history is recorded
5. Last.fm submission is performed asynchronously when eligible

The MPD poller remains important, but it is not the only possible event
source. Qobuz and Sonuvi-owned UPnP playback require suppression or
qualification rules so that MPD observations do not create duplicate history.
Native iOS reports through POST /v1/mobile/playback/events; it does not submit
directly to Last.fm.

The existing
[centralized-playback-history-and-scrobbling.md](centralized-playback-history-and-scrobbling.md)
documents most of this well, but its current-mode wording and review date
need reconciliation.

### 4.6 Audio diagnostics distinguish facts from configuration

The current Audio Info contract separates:

- source-reported format
- decoded PCM
- configured output
- hardware-measured output
- processing and volume configuration
- conversion uncertainty
- freshness and diagnostic provenance

Configured moOde output is not proof of measured DAC output. A stopped MPD
stream is not proof that a Qobuz or external stream has no open hardware
path. DeepWiki page 9.7 covers the underlying moOde, ALSA, and source-probe
distinction, while the current
[diagnostics-interface.md](diagnostics-interface.md) and mobile contract add
the repository-specific sanitization, freshness, and measured/configured
semantics that still require reconciliation.

### 4.7 Metadata enrichment is provider-neutral

The current About architecture presents provider-neutral metadata to clients,
with optional Apple Music editorial enrichment and bounded caching. Playback
must not depend on an About lookup. DeepWiki covers portions of this through
the Media Library, Metadata Inspector, iTunes/Motion Art, and page-6.6 About
material, but page 6.6 is mislabeled as listening history and the current
provider-neutral contract is clearer in
[about-metadata.md](about-metadata.md) and
[apple-about-metadata.md](apple-about-metadata.md).

## 5. Newer subsystem findings

### Qobuz Connect

Current source and documentation establish a working Server/PiBuZ bridge
with separate observation and guarded control responsibilities:

- the mobile API exposes Qobuz snapshot, queue, saved-queue, artwork, and
  playback-control routes
- supported controls include play, resume, pause, next, previous, seek, and
  queue occurrence jump
- the control adapter performs freshness/expectation checks and read-after-
  write verification where possible
- explicit renderer release/handoff is a separate lifecycle operation
- Qobuz playback is not the same thing as browsing an authenticated Qobuz
  library in the Sonuvi catalog
- Qobuz queue occurrences and duplicates must be preserved

Relevant source includes
[pibuz-qobuz-control.mjs](../../src/lib/pibuz-qobuz-control.mjs),
[qobuz-connect-control.mjs](../../src/lib/qobuz-connect-control.mjs),
[qobuz-connect-release.mjs](../../src/lib/qobuz-connect-release.mjs), and
[mobile.routes.mjs](../../src/routes/mobile.routes.mjs).

The existing
[28-qobuz-connect-now-playing.md](../runbooks/28-qobuz-connect-now-playing.md)
contains useful provenance and release material, but parts of its Phase 1
description are now stale: it still describes the adapter as read-only and
the earlier worktree as intentionally undeployed, while current main exposes
the control routes and the tested release lifecycle. The historical Phase 1
language should be separated from the current implementation before that
runbook is used as an agent instruction.

The Qobuz media-server experiment in
[29-upnp-queue-and-qobuz-media-server-poc.md](../runbooks/29-upnp-queue-and-qobuz-media-server-poc.md)
must remain clearly separate from the working PiBuZ/Qobuz Connect path.

### UPnP and renderer control

The current UPnP architecture includes:

- discovery and renderer selection
- browse/search and resource selection
- renderer capability and transport inspection
- preflight and session ownership
- readiness polling before Play
- stale-observation protection
- duplicate-Play prevention after ambiguous SOAP responses
- logical queue and occurrence control
- mobile sanitization and authorization

The recent current-main change specifically waits for the expected renderer
URI and readiness conditions before issuing Play, with a bounded fallback.
DeepWiki page 7.9 captures the main control-point and queue protocol. Current
main extends that description with the newer failure-sensitive readiness,
stale-observation, and duplicate-Play behavior.

The current
[upnp-control-point.md](upnp-control-point.md) is the right canonical home,
but should cross-link the current session/readiness behavior and explicitly
state which state belongs to the renderer, the Sonuvi control point, or MPD.

### Audio diagnostics

The current GET /v1/mobile/audio-info contract is a sanitized mobile wrapper
around the Track-Key-protected moOde/audio diagnostics path. It returns
versioned, structured information and distinguishes measured values from
configured values and unknown conversion. The mobile response does not expose
filesystem paths, raw diagnostic commands, or private connection details.

DeepWiki page 9.7 covers the foundation of this behavior: the protected
moOde/audio-info path, optional ALSA measurement, local source probing, and
sanitized mobile diagnostics. It does not establish the current main
revision's complete mobile wrapper, freshness fields, Qobuz/source handling,
or exact privacy-redaction contract. This is therefore a reconciliation gap,
not an absence of DeepWiki coverage.

### Listening history

The current history implementation is broader than MPD polling:

- source attribution is explicit
- canonical/opaque identity resolution is validated
- qualification and deduplication are server-owned
- MPD observations remain a production input
- mobile native playback reports progress/history through the mobile event
  route
- source-specific suppression prevents duplicate Qobuz/UPnP observations
- Last.fm submission is asynchronous and does not define local history

The DeepWiki page titled
[Listening History and Scrobbling](https://deepwiki.com/teacherguy2020/now-playing/6.6-listening-history-and-scrobbling)
is a material documentation-generation defect: its own text says the supplied
files do not establish local history or Last.fm behavior, while the sources it
actually discusses are `about-card.js`, `about.service.mjs`, and
`apple-about.service.mjs`. Page 7.9 does not fill that gap. The current
history/scrobbling pipeline therefore remains absent from the reviewed
DeepWiki content, and the mislabeled 6.6 page must not be treated as evidence
for it.

### External hardware and integrations

The current API registers and/or mediates several separately owned systems,
including Seeburg, Multiphone/Mabel, Mills, Echo Link, moOde, AirPlay,
UPnP, Qobuz/PiBuZ, Alexa, radio, podcasts, and YouTube. The Server is not
the implementation owner of every external system. The integration boundary
should identify for each system:

- device/service owner
- Server responsibility
- direction of control and observation
- credentials and trust boundary
- history/scrobble attribution
- failure/recovery behavior

DeepWiki's Alexa and moOde coverage is not enough to establish that matrix.

## 6. Canonical documentation comparison

### Strong existing material

The following pages are more current or more nuanced than the corresponding
DeepWiki coverage:

- [architecture.md](architecture.md) — explains the API control plane,
  display renderer, queue/playback mediation, and integration boundaries
- [deployment-and-ops.md](deployment-and-ops.md) — explains app-host,
  moOde-host, and host-override responsibilities and restart verification
- [diagnostics-interface.md](diagnostics-interface.md) — documents measured
  versus configured audio information
- [mobile-now-playing.md](mobile-now-playing.md) — documents the mobile
  bearer boundary, local-source manifest, playback events, and sanitized
  state
- [mobile-live-queue.md](mobile-live-queue.md) — documents target-owned
  queues and current Qobuz/mobile queue semantics
- [centralized-playback-history-and-scrobbling.md](centralized-playback-history-and-scrobbling.md)
  — documents shared history and Last.fm qualification
- [about-metadata.md](about-metadata.md) and
  [apple-about-metadata.md](apple-about-metadata.md) — document provider-
  neutral About enrichment and optional Apple credentials
- [deepwiki-structure-mapping.md](deepwiki-structure-mapping.md) — already
  establishes that DeepWiki-style organization should inform, not replace,
  the canonical wiki

### Gaps and contradictions

| Existing page | Finding | Recommended treatment |
| --- | --- | --- |
| architecture.md | Strong conceptual model, but its integration summary is mostly pre-Qobuz/mobile/modern-UPnP | Add a current source/authority matrix and link to existing focused pages |
| system-overview.md | Broad overview omits Qobuz, UPnP control point, native iOS, and external hardware ownership | Add a concise current-system map, not a second hierarchy |
| api-service-overview.md | Describes Track Key as the main request distinction and does not fully explain bearer/mobile scope | Add authentication domains and route-family ownership |
| api-endpoint-catalog.md | Has a useful mobile section, but current Qobuz Connect and mobile UPnP routes are not fully cataloged | Add current route families, auth, mutation, and source-ownership notes |
| playback-authority-by-mode.md | Correctly says authority is mode-dependent, but lacks Qobuz Connect and modern UPnP ownership | Add source/target/control/state distinctions |
| queue-and-playback-model.md | Separates queue from playback but lacks a cross-system queue matrix | Add MPD, Qobuz, UPnP, saved-queue, and native-device semantics |
| integrations.md | Omits Qobuz/PiBuZ, UPnP, Echo Link, native iOS, and current mobile contracts | Make this the integration ownership index |
| centralized-playback-history-and-scrobbling.md | Strong content, but current mode wording/review date need reconciliation | Update current MPD/Qobuz/UPnP behavior and resolve shadow/active wording |
| diagnostics-interface.md | Strong Audio Info semantics | Cross-link from API and mobile pages; keep measured/configured distinctions prominent |
| mobile-now-playing.md | Strong current mobile boundary | Cross-link Qobuz/UPnP route families and explicitly label transition versus target architecture |
| runbooks/28-qobuz-connect-now-playing.md | Contains stale read-only and undeployed Phase 1 statements | Correct historical/current separation before relying on it |
| runbooks/29-upnp-queue-and-qobuz-media-server-poc.md | Historical PoC language and old test/deployment notes can be confused with working Qobuz Connect | Mark status and boundaries clearly |
| deployment-and-ops.md | More operationally accurate than DeepWiki, but should mention the current Pi5 helper and file-scoped restart rule | Add a short current deployment reference |

The existing structure is sufficient. This audit does not recommend creating
a parallel DeepWiki-derived hierarchy.

## 7. Documentation improvement plan

Prioritized work should remain within docs/wiki-source/ and existing
runbook families:

### Priority 0 — correct agent-facing contradictions

1. Update runbooks/28-qobuz-connect-now-playing.md to distinguish the
   historical read-only Phase 1 adapter from the current guarded playback
   controls and release/restart lifecycle.
2. Mark the Qobuz media-server PoC in runbooks/29 as separate from the working
   PiBuZ bridge and refresh historical test/deployment statements.
3. Add a warning to playback-authority-by-mode.md that MPD authority is
   domain-specific, not universal.

### Priority 1 — add one coherent current architecture map

1. Extend architecture.md with a compact matrix for:
   - playback/source authority
   - queue owner
   - identity owner
   - authentication boundary
   - history event path
2. Extend integrations.md as the ownership index for moOde, Qobuz/PiBuZ,
   UPnP, native iOS, Alexa, Seeburg, Multiphone/Mabel, Mills, Echo Link,
   radio, podcasts, YouTube, and Last.fm.
3. Extend api-service-overview.md and api-endpoint-catalog.md with current
   mobile bearer, Qobuz, UPnP, Audio Info, local-source, playback-event, and
   history route families.
4. Extend queue-and-playback-model.md with the multiple-queue matrix.

### Priority 2 — reconcile focused contracts

1. Refresh centralized-playback-history-and-scrobbling.md with current
   Qobuz/UPnP suppression and MPD mode wording.
2. Cross-link diagnostics-interface.md, mobile-now-playing.md, and the
   current source implementation so measured/configured/unknown fields remain
   consistent.
3. Cross-link upnp-control-point.md to current readiness, stale-session, and
   duplicate-Play behavior.
4. Add current deployment-helper and service-verification notes to
   deployment-and-ops.md.

### What not to do

- Do not copy DeepWiki pages into docs/wiki-source/.
- Do not create a second DeepWiki-shaped navigation tree.
- Do not describe planned native catalog ownership as implemented.
- Do not collapse MPD, Qobuz, UPnP, and native iOS queues into one generic
  queue contract.
- Do not expose raw Track Keys, MPD paths, filesystem paths, or provider
  credentials in mobile documentation.

## 8. Server/iOS architectural boundary

DeepWiki page 7.9 covers part of the UPnP/Qobuz handoff boundary, but it does
not settle the current standalone native iOS transition or the approved
device-owned catalog target.

### Current Server responsibilities

During the transition, the Server currently provides or mediates:

- existing opaque mobile track identities and metadata resolution
- Home queue/playback contracts
- current mobile now-playing, next-up, Audio Info, and queue contracts
- Qobuz Connect observation/control contracts
- UPnP discovery/control contracts
- local-source manifest availability
- native playback-event ingestion for shared history
- server-side qualification, deduplication, and Last.fm submission

### Current native-client responsibilities

The native client owns its device UI, local playback mechanisms, and local
storage/cache behavior. It uses scoped Server contracts for shared state,
identity resolution, local-source availability, and history observation rather
than receiving raw server internals.

### Target architecture not yet implemented

The approved direction is an iOS-device-owned canonical Sonuvi Catalog with
provider aggregation, persistent recording identity, attached-SSD
observations/cache, and server-independent native playback. The target
catalog authority, provider aggregation, canonical enrichment, and
server-independent playback are not implemented in the current Server.

Documentation and future changes must label these as target behavior. They
must not silently replace current opaque MobileTrack, Home queue, or mobile
contract semantics.

### Shared contracts that matter now

- GET /v1/mobile/local-source/manifest
- POST /v1/mobile/playback/events
- GET /v1/mobile/audio-info
- current mobile now-playing/next-up and queue contracts
- Qobuz Connect and mobile UPnP contracts where the native client uses them

The iOS client should remain on these explicit contracts. It should not
reimplement Server-side playback arbitration or infer identity from artwork,
titles, raw paths, or provider-specific URLs.

## 9. Risks revealed by the comparison

1. **Authority confusion:** an MPD-only explanation can cause a future agent
   to mutate MPD while Qobuz or UPnP owns playback.
2. **Queue confusion:** treating Next Up, the MPD queue, a remote Qobuz queue,
   and a UPnP logical queue as interchangeable can lose occurrence identity
   or issue controls to the wrong target.
3. **Authentication confusion:** treating mobile bearer sessions as Track
   Keys can produce contract or security errors.
4. **Documentation drift:** stale Qobuz runbook statements currently conflict
   with current control code and can lead to an unnecessary read-only design.
5. **History duplication:** external-source and MPD observations must retain
   explicit suppression/qualification rules.
6. **Diagnostics overclaiming:** configured output must not be reported as
   measured hardware output.
7. **iOS future-state leakage:** target device-owned catalog behavior must not
   be presented as current implementation.
8. **DeepWiki revision skew:** a derived page can appear comprehensive while
   predating a large feature set; the analyzed revision must always be
   recorded beside conclusions.
9. **Operational mismatch:** installer documentation alone does not prove the
   live service lifecycle, deployment helper, restart behavior, or recovery
   state.

## 10. Highest-priority recommendations

1. Treat DeepWiki as a useful legacy orientation and independent terminology
   review, not as an architectural source of truth.
2. Correct the stale Qobuz runbook before using it as an AI/developer
   instruction.
3. Add one source/authority/queue/identity/auth/history matrix to the existing
   architecture and playback pages.
4. Make integrations.md and api-endpoint-catalog.md current indexes for the
   newer Qobuz, UPnP, mobile, iOS, and external-hardware surfaces.
5. Keep current and target iOS architecture explicitly separated.
6. Preserve the canonical docs/wiki-source/ hierarchy and use focused pages
   only where an existing hub cannot carry a contract safely.
7. When using a future DeepWiki review, record its revision and compare it to
   HEAD before accepting any architectural claim.

## 11. Remaining uncertainties

This audit intentionally stopped at source/documentation comparison. The
following remain outside its evidence:

- live behavior of every external renderer and hardware integration
- current service state on the deployed Pi5
- exact systemd/PM2 unit behavior where DeepWiki did not include the files
- whether every current deployment host has the same configuration
- provider-side Qobuz behavior outside the PiBuZ/Server contracts
- native iOS implementation details beyond the Server-facing contract

Those questions require separate, explicitly authorized runtime or repository
audits. They do not weaken the main conclusion: DeepWiki accurately captures
the older Sonuvi foundation, but current architectural continuity depends on
the source-backed boundaries documented above.
