# Sonuvi Server — DeepWiki before-and-after comparison

**Review date:** 2026-10-28. **Status:** analysis only; stop for review. No recommendations implemented.

## Executive assessment

The refresh is real. DeepWiki indexes **`4bf8889a767e167f50566ec4e193d4b625c2c1f2`**, not the previous `dee06724c3549b9ab87fc70412ce1043572befab`. This is also local `main`, local `origin/main`, and the remote advertised `main` at verification. The index includes the October documentation reconciliation **and** newer Server implementation/tests.

DeepWiki now understands several important boundaries better: MPD is explicitly not universal; native bearer authentication is visible at the architecture level; the mislabeled history page now explains actual ingestion, qualification and scrobbling; Pi5 deployment is documented. These are meaningful improvements, but do not establish that the entire refreshed analysis is more accurate. Cross-page contradictions, misleading diagrams, inaccurate route names and incomplete native/handoff coverage remain.

**All 77 current substantive page bodies were obtained and read.** The historical worktrees preserve the old report and its 77-topic inventory, not full old page bodies. Consequently this is a **page-by-page reconstructed assessment**, not a literal text diff. Three current pages support a material-improvement classification; 73 have insufficient historical text for reliable change classification; one is new. A removed old page makes the union 78 topics.

The most persuasive evidence for the documentation hypothesis is the history correction: its central implementation files did not change between indexed revisions, while the revised canonical explanation is directly cited. This is evidence of association, not a controlled proof of causation.

## 1. Baselines and repository history

| Baseline | Revision | Index/commit information |
|---|---|---|
| Previous DeepWiki | `dee06724c3549b9ab87fc70412ce1043572befab` | Reported publication `2026-10-20T12:20:14.694701`; source commit `2026-10-20T11:50:09Z` |
| Documentation reconciliation | `f5db417528d0c206fd32ccba890a6ad3f57abed9` | Committed `2026-10-20T19:13:18-05:00`; 44 documentation/generated-documentation files, +820/−131 |
| Current DeepWiki | `4bf8889a767e167f50566ec4e193d4b625c2c1f2` | `generated_at: 2026-10-28T05:07:32.726834`; index ID `v1.9.9.5/PUBLIC/teacherguy2020/now-playing/4bf8889a` |
| Local main / origin/main / remote main | `4bf8889a767e167f50566ec4e193d4b625c2c1f2` | Source commit `2026-10-23T10:25:03-05:00` |

The index-generation timestamps have **no timezone suffix**; they are reproduced verbatim rather than silently converted to Chicago time. Both old indexed revision and reconciliation commit are ancestors of the new revision. There is **no indexed-to-main source delta**. Other unmerged worktrees are not the audited baseline.

### Exact indexed revision delta

`dee06724c3549b9ab87fc70412ce1043572befab..4bf8889a767e167f50566ec4e193d4b625c2c1f2` contains **14 commits, 74 changed files, 4,722 insertions and 261 deletions**. A binary image is also in the file delta; line totals are Git's textual totals.

| Commit | Change | Attribution category |
|---|---|---|
| `cc9e746` | Restore Qobuz receiver after Home handoff | Implementation, tests, contract/runbook |
| `8c194c2` | Wait for UPnP renderer readiness | Implementation, tests, contract |
| `673e503` | Preserve first audit | Historical documentation evidence |
| `f5db417` | Reconcile architecture documentation | Root docs, canonical wiki, API/handoff references, generated views |
| `a9f089d` | Bearer mobile Home controls | Implementation, tests, contracts |
| `bddd071` | Mobile repeat mode and native Vibe preview | Implementation, tests, contracts |
| `9603b14` | Mobile JSON transport/proxy hardening | Implementation, tests |
| `7e82355` | Mobile Consume | Implementation, tests, contracts |
| `65929ba` | Mobile Home history and queue paging | Implementation, tests, contracts |
| `50bc3a6` | iOS screenshot in README | Presentation/documentation |
| `c4569bd` | README captions | Documentation |
| `10898a0` | DeepWiki badge | Documentation/discovery |
| `1f86641` | Badge fix | Documentation/discovery |
| `4bf8889` | Alexa tablet artwork backdrop | Application UI |

Reproducible full evidence: [commit list](../../audit-evidence/indexed-commits.txt), [all changed paths](../../audit-evidence/indexed-delta-files.txt), [per-file numstat](../../audit-evidence/indexed-delta-numstat.tsv), [exact binary-capable patch](../../audit-evidence/indexed-delta.patch), [reconciliation patch](../../audit-evidence/reconciliation.patch), [baseline checks](../../audit-evidence/baselines.json).

### Preserved worktrees and historical evidence

All paths below are under `/Users/brianwis/.openclaw/workspace/` unless stated otherwise.

| Worktree | HEAD | Evidence and preservation status |
|---|---|---|
| `now-playing-deepwiki-audit-2026-10` | `8c194c2f2ec2f90fe858b79529d8fbce3460f7b4` | Original untracked `docs/wiki-source/deepwiki-architecture-review-2026-10.md`; left untouched |
| `now-playing-deepwiki-publication-2026-10` | `1b2ce6a3c6c501fe360a3e8be651ba04da13c050` | Publication-era committed report; clean, untouched |
| `now-playing-deepwiki-reconcile-2026-10` | `f5db417528d0c206fd32ccba890a6ad3f57abed9` | Reconciled canonical docs/report and Git history; clean, untouched |
| `/private/tmp/sonuvi-deepwiki-audit.cmzGLM/now-playing` | registered at `8c194c2…` | Missing directory, prunable registration; **not pruned or modified** |
| `now-playing-deepwiki-comparison-20261028` | `4bf8889a…` | New detached analysis worktree based on current origin/main |

Read-only searches of these historical trees and likely workspace/temporary evidence locations found **no complete archived old page bodies and no separate original URL-level ledger**. This is a bounded search result, not proof that no backup exists anywhere. Copies of the three preserved reports are retained in `audit-evidence/old-report-*.md`; originals remain in place.

The old report itself is inconsistent: its complete inventory includes Queue Wizard, Vibe, hardware integrations and testing, while parts of its coverage table still describe them as missing. Those absence claims are **not** used to manufacture apparent improvements. Specific supported findings—especially the old 6.6 About-only body—are more useful than that stale summary table.

## 2. Retrieval, recursion and coverage

Direct DeepWiki access returned HTTP 429. A read-only Jina Reader fallback initially returned article-only Markdown; its link graph reached only the root alias and four overview topics. That was **not** treated as completion.

A bounded fallback request for HTML (`X-Return-Format: html`) returned the complete navigation and React Flight payload. The payload contains **all 77 substantive Markdown documents**, not merely their titles. Extraction resolves each wiki page's content reference, validates its declared UTF-8 byte length, and stores a separate Markdown file plus SHA-256 hash. Every body, including diagrams, was then read. This is 77 retrieved bodies, **not a claim of 77 individual successful HTTP requests**.

Navigation, parent/child relationships, fragment links and same-repository absolute/relative links were traversed to closure. The 77 navigation entries and 77 extracted bodies agree; 122 body-link edges were recorded; no unresolved same-repository documentation target remains. Requests used bounded concurrency (two workers with pacing in the initial crawler); the HTML fallback avoided hammering 77 separate routes. All final page metadata agrees on the new indexed revision and generation timestamp.

| Milestone | Current pages | Meaning |
|---|---:|---|
| Discovered | **77** | Canonical numbered pages across sections 1–12 |
| Retrieved/read | **77** | Full substantive Markdown bodies, byte-validated and read |
| Compared | **77** | 76 reconstructed historical assessments + one new-page presence comparison |
| Verified | **77** | Selected significant architectural claims checked against current source/contracts |
| Literal old/new body diffs | **0** | Old full bodies unavailable |
| Current unavailable/unread/excluded pages | **0** | No current page silently skipped |

“Verified” does **not** mean every sentence is correct or every runtime was tested. It means a page's significant architectural claims were checked; erroneous claims count as checked, not as endorsed. Source windows and conclusions are preserved. No application tests, deployed-service probes or iOS code inspection were performed.

### Ledger and exact exclusions

- [Readable 77-page ledger](../../audit-evidence/page-ledger.md): one row per canonical URL, parent, comparison classification, assessment, action and source anchor.
- [Machine-readable ledger](../../audit-evidence/page-ledger.json): full titles/hierarchy, old/new revisions, timestamps, retrieval/comparison/verification status, hashes and extracted source references.
- [Coverage summary](../../audit-evidence/coverage-summary.json), [source checks](../../audit-evidence/source-checks.json), [link closure](../../audit-evidence/link-closure.json), [index metadata](../../audit-evidence/wiki-metadata.json).
- **Historical limitation:** all 77 old full bodies are unavailable. The readable ledger explicitly enumerates the 76 shared topics plus removed 9.7. No historical page received a literal content diff.
- External GitHub/source links are evidence, not additional DeepWiki pages. Other repositories, live deployment state and iOS implementation are out of scope.
- The original 79 URL variants are a historical report claim; their complete exact alias list was not preserved. The current repository-root alias is normalized to 1 Overview. Do not equate alias counts with page counts.

### Added, removed, renamed and changed

| Change | Result | Confidence |
|---|---|---|
| Added | [12 Glossary](https://deepwiki.com/teacherguy2020/now-playing/12-glossary) | High: absent from complete old inventory, present with full current body |
| Removed/consolidated | [9.7 Audio Info and Source Diagnostics — candidate old slug](https://deepwiki.com/teacherguy2020/now-playing/9.7-audio-info-and-source-diagnostics) | High for missing leaf; some themes now in 9.3/10.4, not a proven exact relocation |
| Candidate old 9.7 URL behavior | Mirror returns HTTP 200 **Overview**, not Audio Info | Slug reconstructed from title; fallback is not successful old-page recovery |
| Renamed/relocated slugs | None proven | Exact old URL ledger missing; punctuation/parenthetical-title variations do not establish renaming |
| Materially changed | 1.1 System Architecture; 6.6 Listening History & Scrobbling; 11.1 Development Setup | Reconstructed from specific old report findings |
| Other shared topics | 73 “Cannot determine reliably” | Current coverage/accuracy assessed, historical content change not measurable |

## 3. Five most important supported architectural improvements

These are five improved distinctions across **three** evidence-supported pages, not five independent textual diffs.

1. **Playback authority is domain-specific (1.1).** The new page explicitly says MPD “is not a universal authority” and separates Qobuz/PiBuZ and Sonuvi UPnP ownership. The old audit recorded an overbroad “MPD is the audio authority” framing. Current code supports separate Qobuz controllers, UPnP session/logical queue and MPD adapters. Native-device ownership and transition semantics still deserve stronger treatment.
2. **Native bearer authentication is visible in the architecture (1.1).** The new authentication section separates `/v1/mobile/*` sessions from the classic shared Track Key. The old audit identified the overbroad primary-Track-Key framing. This is an architecture-level improvement, not evidence that mobile coverage itself is new: old page 9.6 already existed.
3. **History is now actual history (6.6).** The old report explicitly says the former body disclaimed history evidence and instead explained About enrichment. The new page covers multi-source observations, qualification and the central JSONL store. `src/lib/listening-history.mjs` confirms qualification, persisted session deduplication and local append before asynchronous hooks.
4. **Last.fm responsibility is separated from observation (6.6).** The new page explains Server-owned submission, thresholds and active MPD mode instead of treating About as the history system. The threshold implementation is `max(30, min(duration/2, 240))`, tracks under 30 seconds do not qualify, unknown duration requires 240 seconds. The production active/mpdscribble-disabled statement is a **documented deployment state**, not freshly live-verified here. The rollback path remains legitimate and must not be called obsolete in all circumstances.
5. **Installation and Pi5 deployment are better distinguished (11.1).** The new page describes pinned-host file staging and backend-path restart behavior in `scripts/deploy-pi5-files.sh`; the old audit did not establish this operational model. Source confirms `src/*` and `moode-nowplaying-api.mjs` trigger restart, while frontend-only file deployment does not. No deployment was performed.

### Attribution: documentation versus implementation

| Improvement/evidence | Changed inputs | Most defensible interpretation |
|---|---|---|
| 1.1 qualified MPD and mobile auth, citing corrected ARCHITECTURE | Root architecture and canonical authority/API docs changed; some control implementation also changed | Documentation likely improved framing; combined inputs prevent exclusive attribution |
| 6.6 real history and Last.fm explanation cites reconciled history page | History/scrobbler/About implementation files unchanged across indexed delta; canonical history wording changed | Strongest documentation-associated improvement; regeneration/selection may also explain it |
| 11.1 Pi5 helper now explained | Helper unchanged; deployment/architecture docs newly foreground it | Documentation/navigation plausibly increased salience; analyzer variation remains possible |
| Repeat modes, Consume, bearer Home, native Vibe, JSON hardening | New code, tests and contract updates in indexed range | Any new treatment must be credited to combined implementation/docs/tests, not reconciliation alone |
| New Glossary and missing audio leaf | DeepWiki structure changed | Analyzer organization choice; no evidence repository demanded these exact changes |
| README screenshot/badge and tablet art fix | Later docs/UI commits | Confounders in the refreshed source set, not proof of architectural learning |

**Hypothesis verdict:** corrected GitHub documentation **appears to have helped**, particularly where new prose cites corrected docs over unchanged implementation. Causation is not proven: the refresh also includes code, tests, documentation navigation and an uncontrolled analysis rerun. The new index definitely incorporates reconciliation; missing current contracts cannot be excused as `dee06724` index lag.

## 4. Remaining inaccuracies and smallest useful corrections

### Five highest-priority gaps

1. **Authentication/trust boundaries:** wrong pairing actor/credential diagram, overbroad `/config/*` protection, and credential/identity terminology collision.
2. **Current playback handoffs and native contracts:** insufficient Qobuz release, UPnP readiness/generation guards, bearer Home operations and native-device versus Server queue explanation.
3. **Audio evidence and navigation:** loss of the dedicated audio leaf and inadequate source/decoded/configured/measured/freshness/uncertainty explanation.
4. **History contract fidelity:** repository `startedAt`/required-state/catalog-only wording and DeepWiki's remaining false About→history coupling.
5. **Runtime/control-plane boundaries:** false all-MPD-via-SSH, incorrect display-router effects/target URL and nonexistent runtime-check route.

The following register supplies the concrete claim, source, canonical assessment, classification and minimum correction. It deliberately distinguishes DeepWiki mistakes from defects in our own documentation.

| ID / pages | Problematic claim or omission | Actual implementation / contract | Canonical documentation assessment | Classification; smallest useful correction |
|---|---|---|---|---|
| F01 — 9.6 | Diagram: iOS app creates challenge using “Admin Track Key” | `src/routes/mobile.routes.mjs:2364–2488`: web display uses Track Key; already-paired native display uses bearer; unpaired device submits signed proof and polls; approval also requires display token/code | `mobile-carplay-phase1.md:194–279` already spells out actors and both authorized-display credentials | **DeepWiki interpretation error.** Add a compact three-actor diagram to the existing contract; do not give native app admin key |
| F02 — 10 / 1.3 / 12 | All `/config/*` protected; Track Key treated as universal write authorization | `config.runtime-admin.routes.mjs:309–317` has unguarded runtime GET returning config; POST is guarded at 963+. `rating.routes.mjs` and some podcast routes also lack per-handler Track-Key checks | `api-service-overview.md:135` uses broad `/config/*` family shorthand; method-level exceptions insufficiently visible | **Missing architectural explanation / documentation ambiguity.** Document method-specific trusted-LAN/admin/native boundaries and bootstrap exposure; do not claim a security boundary stronger than source. This audit does not assess live network exposure |
| F03 — 1.3 / 6.6 / 12 | Track Key credential and canonical catalog “Track Key” language collide | `mobile-auth.mjs:140–145` creates opaque `trk_` IDs; `mobile-track-identity.mjs` includes edition/folder disambiguation; history `trackKey` is identity, not `TRACK_KEY` secret | `glossary.md` is generic; canonical history itself uses overloaded Track Key terminology | **Missing architectural explanation.** Add identifier/credential/queue-occurrence/ticket table to existing glossary; cross-link contracts |
| F04 — 7.9 / 6.2 / 9.6 | Rich discovery/Qobuz observation but little current guarded control/release and UPnP startup lifecycle | `qobuz-connect-control.mjs:87`, `qobuz-connect-release.mjs`, `upnp-playback-session.mjs:886–1010,1208,1403`; bearer Home mapping at `mobile.routes.mjs:2234–2250,3890+` | Authority matrix, Qobuz runbook 28, UPnP page and October handoff already contain much of this | **DeepWiki interpretation/selection error**, not indexed-revision limitation. Add concise transition cross-links/state table rather than duplicating contracts |
| F05 — 9.6 / 4.3 | Missing current Home control, deterministic repeat/Consume, native Vibe preview, local manifest and event/recent-history boundaries | `mobile.routes.mjs:3443,3890,4813,4857,4981`; recent-history route supplies a last-played seed, not live state or queue mutation | `docs/ios/server-to-ios-contract-handoff-2026-10.md` already documents current endpoints and device-owned catalog as future direction | **DeepWiki interpretation/selection error.** Link current handoff from native/API hubs and explicitly distinguish web mobile, native playback and future catalog |
| F06 — old 9.7 / current 9.3,10.4 | Audio leaf removed; current pages do not explain full evidence model | `src/lib/audio-info.mjs:614–624`: conversion remains unknown; source probing in `source-audio.mjs`; mobile safe projection separate | `diagnostics-interface.md:261–330` already accurately distinguishes source, decoded PCM, configured output, measured ALSA, processing/volume, freshness and uncertainty | **DeepWiki coverage/navigation regression.** Promote existing contract links. No refreshed page found claiming bit-perfect output; do not invent that error |
| F07 — 6.6 / canonical history | Canonical input prose says `startedAt`, implies state required, catalog-only identity resolution | `mobile.routes.mjs:4857–4936`: `state` defaults to `progress`, timestamp is `startedAtMs`, radio/podcast identity resolution supplements catalog lookup | `centralized-playback-history-and-scrobbling.md:41–48,145–146` incomplete/inaccurate | **Sonuvi documentation error.** Correct input name/default/identity cases and give a minimal request example. Preserve shared qualification/deduplication rules |
| F08 — 6 / 6.6 | Parent diagram: AboutService “Fetch history records” from HistoryLib; 6.6 cites `config.lastfm.routes.mjs` | `src/services/about.service.mjs` is a 38-line provider resolver with no history access; Last.fm config routes are in `config.runtime-admin.routes.mjs` | `apple-about-metadata.md` and `about-metadata.md` already separate optional enrichment from history | **DeepWiki interpretation/citation error.** Cross-link independent flows; no new dependency or code change |
| F09 — 9.4 | “All interactions” with moOde/MPD funnel through SSH; generic wrapper proves sanitization | `src/services/mpd.service.mjs:107+` uses TCP `net.createConnection`; `exec.mjs` only wraps `execFile`; remote-shell safety is call-site-specific | Root architecture shows multiple protocols; API hub lacks a compact transport/effect map | **DeepWiki interpretation error / missing teaching layer.** Table TCP MPD, moOde HTTP, SSH administration and UPnP SOAP separately; avoid blanket sanitization guarantee |
| F10 — 3.4 / 3.1 | POST last-profile causes SSH restart; router `location.replace`; target example contains `:8101` | `config.runtime-admin.routes.mjs:721–789` writes profile only; `display.html:26–80` reads once and sets iframe src; legacy code fallbacks still contain `:8101` | `display-enhancement-peppy-player-flow.md:90–92` correctly requires portless moOde r1034 target and has Save/Push distinction | **DeepWiki interpretation error plus implementation/documentation ambiguity.** Diagram actual save/push/load effects and label legacy fallbacks; no code/target change in this audit |
| F11 — 10.2 | `POST /config/runtime/check` | Actual route `POST /config/runtime/check-env`, `config.runtime-admin.routes.mjs:807` | `api-config-and-runtime-endpoints.md:63–69` already correct | **DeepWiki interpretation/citation error.** Keep canonical route spelling; link endpoint inventory, no new documentation page needed |
| F12 — 9.5 | Atomic temp+rename patterns protect stores from power loss | Animated transcode rename at `config.library-health-animated-art.routes.mjs:148` gives replacement visibility; does not establish fsync durability or uniform JSON-store behavior | Existing library/cache docs do not provide a per-store durability contract | **DeepWiki overstatement / missing explanation.** Small cache inventory with provenance, invalidation, persistence and limitations; no implementation hardening implied |
| F13 — 5 | Server never hosts/stores music, only a moOde metadata facade | `mobile.routes.mjs:4813–4854` uses Server-accessible music root and availability manifest; media/ticket routes can deliver local bytes | `media-library.md` is an old branch scaffold; current handoff explains local-byte mapping | **Missing architectural explanation.** Add source/identity/catalog/byte-access ownership table, including device-native versus Server-mediated sources |
| F14 — 1.1 / 12 versus 7.2 / 10.5 | Integrates “without modifying” moOde installation | Repo has installed overrides, AirPlay reader/watchdog units, upgrade recovery scripts | Integration and ops pages already document those exceptions | **DeepWiki interpretation error.** Clarify no wholesale core fork does not mean no installed override; cross-link recovery provenance |
| F15 — 3.6 / 8.4 | Asset catalog treated as complete native export source | `export-peppymeter-skins.mjs:13–25` reads `skins/*/meter.json`, filters 1280×400/circular; browser reads assets catalog | Display documentation needs source-versus-derived asset distinction | **Missing architectural explanation / interpretation error.** One small authoring/export/runtime ownership table |
| F16 — 4.4 | Collage preview checks playlist name collision | `config.queue-wizard-collage.routes.mjs:98–116` builds JPEG and returns preview | Queue Wizard canonical internals should remain preview/apply/save specific | **DeepWiki interpretation error.** Cross-link actual save/apply routes; do not redesign collision handling |
| F17 — 11.5 | Runbooks and compatibility guides all generated from wiki-source | `build_wiki_site.py` generates wiki-site; `docs/README.md:17–30` explicitly retains standalone runbooks and guides | Existing source-layer documentation is already correct | **DeepWiki interpretation error.** No structural rewrite; reinforce source-layer links |
| F18 — 12 | Peppy browser produces PUT meter samples | API receives PUT samples, exposes GET with freshness (`moode-nowplaying-api.mjs:712,775`); browser consumes | Display/audio pipeline docs already explain producers | **DeepWiki diagram error.** Add producer/transport/consumer arrows to existing flow, not a new subsystem |

No identified omission of current main in this register is attributed to an old indexed SHA: the SHA matches. Future device-owned catalog work is intentionally not assumed implemented. Source citations pointing to old path names or nonexistent files are evidence-quality problems; a filename match alone was never treated as verification.

## 5. Complete-system assessment and useful insights

| Area | Current assessment |
|---|---|
| Alexa | Custom skill/Echo AudioPlayer and local trigger paths covered. Separate voice request origin from actual audio target; Echo-targeted playback is not proof MPD emits the bytes |
| Seeburg / Multiphone / Mabel | Real shared priority helpers and serialized queue mutation covered. Old report's absence claim is unreliable; Mabel remains the Multiphone integration context |
| Mills | Valuable physical-record/display-surrogate/MPD snapshot relationship; queue can be temporarily altered and restored, not literally untouched |
| Echo Link | Useful Python sidecar → loopback API → Server proxy boundary; credentials and hardware input/volume are not ordinary MPD volume |
| Qobuz / PiBuZ / UPnP | Substantial coverage exists; Connect receiver and remote queue must stay separate from optional upmpdcli Qobuz MediaServer proof-of-concept and generic UPnP source discovery |
| Radio / podcasts / YouTube | Holdback, download/retention and durable YouTube source-URL rewriting are useful source-backed explanations |
| Web controllers / displays / theme | Broad shell, iframe, renderer, token and optimistic-update coverage; some diagrams/owner filenames are wrong |
| Installer / deployment / recovery | Installer model and Pi5 helper explained; watchdog/override recovery present; no claim this static audit verifies live health/configuration |
| Security | Native sanitization/tickets explained, but blanket shared-key and pairing diagrams overstate/blur boundaries |
| Metadata / library | Optional About and provider caches useful; canonical identity versus credentials and storage/catalog ownership need a stronger existing-page teaching layer |

### Original, source-verified insights worth incorporating

1. **Stable identity is not a delivery address.** Saved YouTube playlists rewrite transient proxy URLs to source URLs (`config.diagnostics.routes.mjs:670–689`). Native track IDs and short-lived media tickets likewise serve different roles. This is a valuable cross-link between queue persistence, native media and UPnP selection references—not one universal identity algorithm.
2. **Separate intent, persisted configuration, host effect and rendering.** Player builders post an action; profile routes persist; host push controls deployment-side behavior; router reads a profile and selects an iframe. This four-stage explanation makes display failures easier to localize than “push updates the display.”
3. **Presentation reconciliation is not playback ownership.** `index-ui.js` holds optimistic favorites/ratings and extrapolates progress. These bounded UI mechanisms cannot override source authority or establish that a remote command succeeded.
4. **Physical jukebox handoff is a state-restoration problem.** Mills snapshots queue/status for a physical record while Multiphone/Seeburg serialize priority mutations. Cross-linking these with authority/handoff documentation exposes the shared need to preserve user queue intent without pretending the modes are identical.
5. **Cache behavior belongs to each owner.** Apple About positive/negative TTLs, radio stability state, art derivatives, source-probe stat invalidation and mobile catalog IDs have different invalidation semantics. A cache matrix should teach those differences rather than promise universal durability.
6. **Operational health is a chain, not one service flag.** AirPlay reader watchdog, moOde worker supervision, Peppy producer targets/FIFO consumers and browser render state are separate signals. Existing runbooks are the right source; improve cross-links instead of duplicating recovery instructions.

## 6. Regressions and limits

- **Proven structural regression:** old Audio Info leaf 9.7 is gone. Current 9.3/10.4 partially overlap its topic, but the full evidence model is less discoverable. Exact text loss cannot be measured without old bodies.
- **New page with errors:** Glossary adds useful navigation, but its producer-direction diagram and blanket no-modification claim are wrong. This is not proof an older glossary regressed; none existed in the inventory.
- **Residual cross-page contradictions:** improved 1.1 conflicts with universal-MPD/SSH shorthand elsewhere; improved 6.6 conflicts with the parent About→history diagram. These are current defects, not proven newly introduced regressions.
- **No reliable broad prose-regression count:** 73 shared pages remain historically indeterminate. “Cannot determine” is not “unchanged.”
- DeepWiki analysis/version changes were not controlled; mirror HTML verifies indexed content/metadata but is not a separate live runtime or deployment check.

## 7. Documentation refinement and Server → iOS handoff

See [the file-specific refinement plan](deepwiki-documentation-refinement-plan-2026-10.md). Favor correcting history input fields and trust-domain exceptions, then improving existing glossary/library/auth/authority/audio navigation. Keep accurate contracts intact.

For the iOS team, **review—not automatically assign**:

- Use bearer Home controls, deterministic `repeatMode`/Consume and native Vibe preview; interpret `409 HOME_PLAYBACK_OWNERSHIP_CONFLICT` through explicit Qobuz/UPnP handoff, not blind retries.
- Pairing has an authorized display actor and an unpaired requesting actor. An already-paired native display can authorize with bearer; no native admin Track Key is required.
- Playback events use `startedAtMs` and stable session IDs; Server owns qualification and Last.fm. Recent history is not live now-playing or automatic queue replacement.
- Preserve audio provenance/freshness and conversion uncertainty; no bit-perfect badge from ALSA alone.
- Native UPnP and Server-mediated UPnP differ. A device-owned canonical catalog remains a target architecture, not a completion claim established by this Server review.

No new implementation defect in the iOS repository is asserted: that repository was not opened or changed.

## 8. Deliverables and operational status

- This report: `docs/wiki-source/deepwiki-comparison-2026-10.md`.
- Plan: `docs/wiki-source/deepwiki-documentation-refinement-plan-2026-10.md`.
- Full bodies, raw HTML/Flight payload, scripts, ledgers, hashes, Git patches and historical report copies: `audit-evidence/`; [artifact guide](../../audit-evidence/README.md) and [validation result](../../audit-evidence/validation.json).
- New detached worktree: `/Users/brianwis/.openclaw/workspace/now-playing-deepwiki-comparison-20261028`, HEAD `4bf8889a767e167f50566ec4e193d4b625c2c1f2`.
- Only new untracked audit artifacts/reports; no tracked application or canonical document edits, staging, commit, push, merge or deployment. Old audit/reconciliation worktrees preserved; main remains clean.
- Verification is static source/contract analysis plus artifact-integrity checks. No application/service execution or test-suite pass is claimed.

**Stop for review.** Recommendations require a separate implementation decision.

Last reviewed: 2026-10-28 America/Chicago.
