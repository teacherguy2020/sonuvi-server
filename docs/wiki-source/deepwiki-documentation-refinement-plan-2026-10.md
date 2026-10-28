# Sonuvi documentation refinement plan — October 2026 DeepWiki comparison

**Status: proposed only.** No canonical edits, code changes, deployment, commits, pushes or iOS assignments authorized by this plan. Evidence and finding IDs are in [the comparison report](deepwiki-comparison-2026-10.md); full page coverage is in [the ledger](../../audit-evidence/page-ledger.md).

## Priorities and scope

Critical means likely to mislead a client integration or the understanding of a trust boundary; it is **not** a declaration of a newly proven deployed vulnerability. Important items improve architectural onboarding and prevent ownership/diagnostic mistakes. Informational items tighten terminology/navigation. Prefer editing the existing pages listed here; do not create another competing architecture layer.

## Critical

### C1. Correct playback-event input contract

**Scope:** shared Server/iOS contract. **Finding:** F07. **Primary file:** `docs/wiki-source/centralized-playback-history-and-scrobbling.md`. **Cross-check:** `docs/ios/server-to-ios-contract-handoff-2026-10.md`, `docs/wiki-source/mobile-carplay-phase1.md` and the existing API catalog.

Smallest change:

- Replace the input field `startedAt` with **`startedAtMs`**; state timestamp units and the current bounds/default.
- Name `state` explicitly, document its allowed values, and distinguish recommended explicit reporting from the implementation's default `progress` when omitted.
- Describe Server resolution of catalog, radio and podcast identities, not catalog-only resolution. Avoid suggesting arbitrary client filesystem identity is accepted.
- Include one request example with opaque track ID, stable session ID, state, elapsed/duration seconds and `startedAtMs`.
- Preserve the separate local-play/Last.fm thresholds, session deduplication and asynchronous submission model. Keep documented active deployment versus default/rollback configuration distinct.

**Source:** `src/routes/mobile.routes.mjs:4857–4936`; `src/lib/listening-history.mjs`; `src/lib/lastfm-scrobbler.mjs`.

**Acceptance:** every documented input matches the route; missing-state/default and radio/podcast cases are acknowledged; no client Last.fm responsibility is implied. Use existing tests/contracts for verification; no production mutation is needed.

### C2. Make authentication and trust boundaries method-specific

**Scope:** Server documentation plus shared native pairing contract. **Findings:** F01–F03.

**Files:**

- `docs/wiki-source/api-service-overview.md` — qualify the authentication-domain table.
- `docs/wiki-source/api-config-and-runtime-endpoints.md` — explicitly distinguish runtime GET bootstrap from guarded POST/admin actions.
- `docs/wiki-source/mobile-carplay-phase1.md` — add or tighten a three-actor pairing diagram beside the already-correct endpoint table.
- `docs/wiki-source/glossary.md` — define credential versus opaque identity terms; C2 shares edits with I3 below.

Smallest change:

1. Replace blanket `/config/*` protection language with a representative **method + path + authentication + intended trust context** table. The code's runtime GET is unguarded and returns configuration; some legacy ratings/podcast writes also do not call `requireTrackKey` per handler. Do not imply all old writes are uniformly protected.
2. Distinguish authorized web display (Track Key), authorized already-paired native display (bearer), and unpaired requesting device (challenge + public-key proof + poll token). Approval has its additional display token/code requirements.
3. Separate `TRACK_KEY` shared credential, mobile bearer session, refresh credential, media ticket, opaque mobile `trackId`, history `trackKey`, MPD file/song occurrence and UPnP/Qobuz identities. Never include actual secret values.
4. State deployment/network assumptions as assumptions. A browser bootstrap or UI gate is not an independently enforced security perimeter.

**Source:** `config.runtime-admin.routes.mjs:309,963`; `rating.routes.mjs`; `podcasts-download.routes.mjs`; `mobile.routes.mjs:2364–2488`; `mobile-auth.mjs:140–145`.

**Acceptance:** readers cannot infer that an unpaired native app needs the admin key, that all `/config` methods enforce it, or that a stable track ID grants media access. Any code-hardening question discovered while documenting this must be separately scoped; this plan does not change auth behavior.

## Important

### I1. Teach authority transitions, not only a static mode list

**Scope:** Server and shared Server/iOS contracts. **Findings:** F04/F05.

**Files:** `docs/wiki-source/playback-authority-by-mode.md`, `queue-and-playback-model.md`, `upnp-control-point.md`; cross-link `docs/runbooks/28-qobuz-connect-now-playing.md` and `docs/ios/server-to-ios-contract-handoff-2026-10.md`.

Add a concise transition table: **current owner → requested target → authorized command → release/readiness evidence → conflict response → authoritative reread**. Distinguish:

- MPD Home queue;
- PiBuZ/Qobuz Connect receiver and remote queue;
- Server UPnP logical queue/session and renderer generation/readiness;
- native-device queue/playback;
- native UPnP versus Server-mediated UPnP;
- Alexa request origin versus Echo-targeted audio output.

Explicitly show Qobuz release before Home retry, UPnP readiness/generation/revision protection and `409 HOME_PLAYBACK_OWNERSHIP_CONFLICT`. Link existing detailed contracts instead of copying endpoint inventories. Do not describe upmpdcli Qobuz MediaServer proof-of-concept as the working PiBuZ Connect control path.

**Acceptance:** a new reader can choose the correct state/control owner and explain why automatic takeover is not always valid. Existing detailed source-backed contracts remain authoritative.

### I2. Restore audio-contract discoverability without duplicating it

**Scope:** Server documentation and shared diagnostic DTO semantics. **Finding:** F06.

**Files:** `docs/wiki-source/diagnostics-interface.md` (small summary/link edit only), `api-service-overview.md`, `api-state-truth-endpoints.md`, `playback-features.md`, `mobile-now-playing.md`.

Place an early “What Audio Info proves” link/summary leading to the existing `audio-info.v1` contract:

- reported source format;
- decoded PCM;
- configured path;
- measured ALSA endpoint;
- processing/volume provenance;
- freshness;
- unknown intermediate conversion.

Retain encoded-source bitrate versus calculated decoded throughput and lossy bit-depth distinction. Do not rewrite accurate diagnostics semantics merely because DeepWiki removed its own leaf. Do not claim DeepWiki currently asserts bit-perfect output; the issue is missing explanation, not that specific false statement.

**Acceptance:** readers reach the full contract from architecture, playback, diagnostics and mobile hubs in one direct link; measured endpoint format is never equated to end-to-end bit-perfect proof.

### I3. Fill the library/identity ownership teaching gap

**Scope:** Server documentation with shared future-direction boundary. **Findings:** F03/F13.

**Files:** `docs/wiki-source/media-library.md`, `glossary.md`, `core-concepts.md`; cross-link `mobile-carplay-phase1.md`, `apple-about-metadata.md` and October handoff.

Replace the old branch-scaffold emphasis with a compact table for **source observation, accepted identity, browse/catalog owner, playable-byte location/access, queue owner and optional enrichment**. Explain that Server can read mounted media and deliver authorized bytes even when moOde provides library/playback metadata. A relative-path manifest maps identity to availability; it is not a new identity system.

Label device-owned canonical catalog/provider aggregation as **target architecture**, not completed functionality. Keep optional Apple About enrichment downstream of accepted identity, independent of playback/history. Avoid claiming one identifier namespace spans every source without translation.

**Acceptance:** readers can distinguish a library index, a media store/mount, a queue entry, a delivery ticket and optional enrichment; device-local and Server-mediated access are not conflated.

### I4. Link the current native contract from established hubs

**Scope:** shared Server/iOS contract/navigation. **Finding:** F05.

**Files:** `docs/wiki-source/mobile-carplay-phase1.md`, `mobile-now-playing.md`, `mobile-live-queue.md`, `mobile-feature-surfaces.md`, `api-service-overview.md`.

Add a short current-capabilities pointer to the October handoff rather than maintaining another long API table. Include bearer Home controls, repeat/Consume readback, native Vibe preview versus Home Queue Wizard jobs, queue paging, local-source manifest and playback-event reporting. Document recent-history projection as last-played seed data, not live state or a command to overwrite a nonempty device queue.

**Acceptance:** current behavior is discoverable despite historical “phase 1” page naming; the implementation status of each native direction remains explicit. Do not infer native client completion from Server endpoint availability.

### I5. Clarify runtime transport and display-effect ownership

**Scope:** Server/operations/display integration. **Findings:** F09–F11/F14/F18.

**Files:** `docs/wiki-source/architecture.md`, `api-service-overview.md`, `display-enhancement-peppy-player-flow.md`, `integrations.md`; links to existing deployment/recovery runbooks.

Add two compact mappings:

1. **Protocol/owner:** direct MPD TCP, moOde HTTP, SSH administration/procfs, UPnP SOAP and PiBuZ control. Do not claim generic `execFile` proves all remote-shell quoting.
2. **Display effects:** builder intent → profile persistence → explicit host push/reload → router load → iframe renderer. Meter producers PUT samples; browser renderers GET them. Profile save alone does not restart Chromium.

Retain portless moOde r1034 Target URL guidance. Label lingering `:8101` runtime fallbacks as legacy implementation context requiring separate evaluation, not an instruction to change deployment. Explain that “no core fork” coexists with installed moOde overrides and their recovery provenance.

Keep correct `/config/runtime/check-env` spelling in the current reference; no new route or documentation page is needed to mirror DeepWiki's typo.

**Acceptance:** a reader can distinguish state persistence, host effects and render effects, and find the correct recovery owner without treating SSH as universal.

## Informational

| Item | Existing files | Smallest proposed refinement | Scope / evidence |
|---|---|---|---|
| N1 Cache semantics | `media-library.md`, `library-health-interface.md`, `apple-about-metadata.md` | Small owner/provenance/TTL-or-invalidation/persistence table; distinguish atomic replacement from fsync durability; do not generalize one store's guarantees | Server; F12 |
| N2 About/history separation | `about-metadata.md`, `centralized-playback-history-and-scrobbling.md` | One explicit non-dependency sentence/cross-link: About enriches accepted identity; history does not obtain records through About resolver | Server/shared; F08 |
| N3 Skin asset ownership | `display-enhancement-peppy-player-flow.md`, `config-display-and-render-features.md` | Authoring `skins/*/meter.json` versus browser assets/catalog versus native exported definitions; state actual exporter resolution/type limits | Display integration; F15 |
| N4 Existing-doc navigation | `docs/README.md`, `documentation-sources-audit.md`, `queue-wizard-internals.md` | Preserve distinction between generated wiki views and standalone runbooks; link preview/apply/save responsibilities without copying DeepWiki collision diagram | Server; F16/F17 |
| N5 Operational cross-links | `deployment-and-ops.md`, `airplay-metadata-hardening.md`, `display-issue-triage-runbook.md` | Cross-link reader watchdog, worker supervision, Peppy producer/FIFO health and renderer status as separate failure domains | Operations; verified existing units/scripts |

These are navigation/teaching improvements, not evidence each existing page is wrong. Do not churn accurate prose solely to maximize changes.

## No change required

- The **core audio evidence contract** already states conversion uncertainty, provenance and freshness correctly. Improve access to it, not its truth model.
- The **pairing endpoint table and actor prose** already support Track Key web displays and bearer native displays. A diagram clarifies them; no protocol redesign is indicated.
- **Pi5 helper behavior** and current deployment documentation are supported by source. No deployment change or expansion of the restart rules follows from this audit.
- **Optional Apple About provider separation**, Last.fm qualification math and central deduplication model are sound; correct the specific event-input prose and cross-links only.
- **Queue Wizard, radio, podcasts, YouTube, Seeburg/Multiphone, Mills, Echo Link, themes and public-site CI** have substantial source-backed coverage. Do not create “missing subsystem” pages based on the first audit's stale absence table.
- Existing **runbooks and compatibility guides** are not obsolete simply because wiki-source is the canonical narrative. Keep their distinct maintenance role.
- No code change is proposed to make implementation match DeepWiki.

## Server → iOS handoff for review

No tasks are assigned to Jarvis iOS. No iOS repository files were inspected or modified.

1. **Event schema:** confirm use of `startedAtMs`, seconds for elapsed/duration, stable session IDs and supported identity paths. Server remains the history/Last.fm owner.
2. **Ownership:** confirm bearer Home routes and explicit conflict/release behavior; Qobuz, Server UPnP and native-device queues do not share one inferred authority.
3. **Pairing:** distinguish acting as an already-authorized display from enrolling a new device; native authorization is bearer, never an admin Track Key.
4. **Readback/preview:** use deterministic repeat/Consume readback and native Vibe preview; queue/history projections must not overwrite device-owned playback intent.
5. **Audio:** preserve evidence roles/freshness and “conversion unknown”; avoid unsupported bit-perfect conclusions.
6. **Future architecture:** Server endpoint availability and marketing pages do not establish completion of a device-owned catalog. Keep native UPnP and Server-mediated UPnP contracts separately labeled.

These are integration-review checkpoints grounded in existing Server contracts, not newly discovered iOS implementation bugs.

## Proposed execution sequence after review

1. Correct C1/C2 in existing source pages; review against exact route signatures and auth checks.
2. Add I1–I5 summaries/tables/cross-links without duplicating contract bodies.
3. Apply only useful informational edits; preserve stable pages listed under No change required.
4. Update bottom-of-page timestamps for every edited wiki page. Validate links and the repository's documentation checks; regenerate wiki-site only when the canonical changes are approved. Publication/commit/push remain separately scoped.
5. For the next DeepWiki comparison, retain full indexed page bodies, navigation, source revision/timestamps and hashes from this evidence set. If a new index appears, repeat recursive closure and distinguish four coverage milestones again.

## Review gate and current Git state

The two new reports and `audit-evidence/` are untracked in isolated detached worktree `now-playing-deepwiki-comparison-20261028` at `4bf8889a767e167f50566ec4e193d4b625c2c1f2`. Existing canonical documentation and application code are unchanged. No commit, push, deployment, service action or old-worktree mutation occurred.

**Stop here for review; do not execute this plan automatically.**

Last reviewed: 2026-10-28 America/Chicago.
