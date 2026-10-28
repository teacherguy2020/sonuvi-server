# DeepWiki-informed documentation refinement — review before commit

**Status: approved for commit/push on 2026-10-28, subject to final verification.**
**Source baseline:** `4bf8889a767e167f50566ec4e193d4b625c2c1f2`.
**Branch/worktree:** `docs/deepwiki-refinement-20261028` in
`/Users/brianwis/.openclaw/workspace/now-playing-docs-refinement-20261028`.

## 1. Timestamp investigation performed before canonical edits

The Server ingestion route, the existing Server-owned iOS handoff and the API
fixture agree on **`startedAtMs`**. The canonical history page's `startedAt`
wording was wrong. A mocked-handler probe confirms exact timestamp propagation,
default state/request time, and timestamp bounds. Supplying only `startedAt`
returns success but silently uses request time.

Classification: **documentation mismatch confirmed; shipped-client
interoperability not verified**. No actual current native payload was available,
and the iOS repository was not inspected. The conditional runtime concern is
reported separately in [runtime-contract-concerns.md](runtime-contract-concerns.md),
not patched. Contract agreement is not a claim that every deployed client sends
the right field.

## 2. Audio Info UI hypothesis and revised assessment

Brian confirmed that the modal/drawer → dedicated-screen change is in
**Sonuvi iOS**, not the Server web UI.

| Evidence | Old indexed Server `dee06724` | Current indexed Server `4bf8889a` |
| --- | --- | --- |
| Web entry | `controller-tablet.html`, `tabletAudioInfoBtn` | Same action/button |
| Web presentation | `audioInfoModal`, `openAudioInfoModal()` | Same modal and byte-identical handler |
| Web data route | `/config/moode/audio-info?view=rows&diagnostics=1` | Same |
| Mobile data adapter | `/v1/mobile/audio-info` | Byte-identical handler; overall mobile file changed for other features |
| Audio implementation | `audio-info.mjs`, `source-audio.mjs`, audio-info route, source-audio UI helper | All four files byte-identical |
| Dedicated Server Audio Info HTML route | None identified | None identified |
| iOS presentation | Old native presentation not archived in Server | Dedicated screen confirmed by Brian; no Swift/navigation code inspected |

The tablet file's indexed delta is Alexa artwork work, not an Audio Info
navigation refactor. [Exact hashes/handler comparison](audio-ui-index-evidence.json)
record the evidence. Do not infer iOS source changes from the Server index.

### Where refreshed DeepWiki covers Audio Info

| DeepWiki page | Substantive current coverage, not merely a file listing |
| --- | --- |
| 2.5 Diagnostics Interface | API/request console and previews; audio files listed as sources, but no substantive Audio Info contract explanation |
| 2.6 Tablet Controller | General controller/settings and browser ALSA mute; not a dedicated Audio Info navigation explanation |
| 3.5 Audio Data Pipeline | Meter/spectrum producers, FIFO and PUT/GET samples; not equivalent to source/configured/measured diagnostics |
| 9 Backend API / 9.1 API Architecture | Audio route registration and probe topology; useful backend placement |
| 9.3 MPD Integration | Substantive `audioinfo.php`, independent ALSA and ffprobe/source-codec discussion |
| 9.6 Mobile & CarPlay API | No substantive audio-info endpoint or dedicated native-screen discussion |
| 10.4 Diagnostics Tools | Short independent ALSA probe section, not the complete evidence model |

**Revised verdict:** consolidating implementation details under Backend API/MPD/
Diagnostics is a reasonable classification choice. Losing a numbered leaf is
not, by itself, a capability regression. The unsupported causal claim would be
that the native UI restructuring caused DeepWiki's Server reclassification:
there is no matching indexed Server UI/adapter change or preserved old/new
native evidence demonstrating that link.

A narrower discoverability/coverage gap remains: current DeepWiki does not
connect user entry points, the sanitized mobile contract and the full
source/decoded/configured/measured/freshness/uncertainty model. The original
comparison's “structural regression” should be read with this qualification.
Its accepted report/ledger remain byte-for-byte preserved; this follow-up records
the new evidence instead of rewriting that historical audit.

Canonical documentation now describes the dedicated **native** screen and the
still-existing **web** modal separately. No obsolete iOS drawer instructions or
new Server HTML route were introduced. Exact native navigation implementation
remains outside this Server-only review.

## 3. Corrections implemented

1. **Pairing/authentication:** distinguish authorized web display, existing
   bearer-authorized native display and new unpaired device; correct actor
   flow. Document runtime GET bootstrap and method-specific legacy exceptions,
   plus enrollment/refresh/ticket exceptions to ordinary bearer requests.
2. **Authority/handoff:** add explicit Qobuz release and confirmation, Home
   conflicts, UPnP revision/generation/readiness and native queue boundaries.
   Separate Alexa request origin, coordination queue and actual Echo output.
3. **Audio Info:** add client entry points, data-route map, provenance summary
   and navigation links without duplicating the detailed diagnostic DTO.
4. **History:** correct `startedAtMs`, state default, identity resolver cases,
   qualification versus acceptance, session deduplication and independent About
   enrichment. Remove a diagram implying unimplemented browser/Alexa reporters.
5. **Catalog/native boundaries:** fix “Server queue authoritative on device”
   wording; distinguish accepted identity, mounted/local bytes, delivery tickets,
   device queue and future device-owned catalog architecture.
6. **SSH/display/runtime:** document direct MPD TCP versus HTTP/SSH/SOAP/PiBuZ;
   distinguish profile persistence, explicit host push, router iframe selection
   and producer-to-consumer meter flow. Keep `/config/runtime/check-env` and
   portless moOde r1034 target guidance; label legacy fallbacks.
7. **Glossary:** incorporate useful identity, authority, handoff, revision,
   session, Vibe, radio-holdback and provenance vocabulary in Sonuvi's existing
   glossary; reject external diagram/ownership inaccuracies rather than copying
   DeepWiki prose.

## 4. Exact documentation source files changed

All existing canonical edits, in priority groups (17 wiki pages + 2 Server-owned
handoff documents):

- `docs/wiki-source/api-service-overview.md`
- `docs/wiki-source/api-config-and-runtime-endpoints.md`
- `docs/wiki-source/mobile-carplay-phase1.md`
- `docs/wiki-source/playback-authority-by-mode.md`
- `docs/wiki-source/queue-and-playback-model.md`
- `docs/wiki-source/upnp-control-point.md`
- `docs/wiki-source/diagnostics-interface.md`
- `docs/wiki-source/controller-tablet-anatomy.md`
- `docs/wiki-source/playback-features.md`
- `docs/wiki-source/api-state-truth-endpoints.md`
- `docs/wiki-source/centralized-playback-history-and-scrobbling.md`
- `docs/wiki-source/media-library.md`
- `docs/wiki-source/glossary.md`
- `docs/wiki-source/architecture.md`
- `docs/wiki-source/display-enhancement-peppy-player-flow.md`
- `docs/wiki-source/mobile-now-playing.md`
- `docs/wiki-source/documentation-sources-audit.md`
- `docs/ios/server-to-ios-contract-handoff-2026-10.md`
- `docs/ios/upnp-qobuz-integration-handoff.md`

`docs/ios/` above is inside **Sonuvi Server**, not the separate iOS repository.
Every edited wiki page has an updated bottom timestamp. New audit/review
artifacts are not new overlapping feature manuals.

### Preserved and added review documents

- `docs/wiki-source/deepwiki-comparison-2026-10.md` — accepted report, unchanged.
- `docs/wiki-source/deepwiki-documentation-refinement-plan-2026-10.md` — accepted plan, unchanged.
- `audit-evidence/` — complete accepted 77-page ledger, linked revision and
  source-check evidence, historical report copies and integrity manifest. Full
  current bodies and raw retrieval artifacts remain byte-preserved in the
  durable archive below and the untouched comparison worktree; those bulk
  crawler files are excluded from the commit and user-facing documentation.
- `docs/reviews/deepwiki-refinement-2026-10/` — this review, separate contract
  concern, source evidence, test/probe results, preservation record and file manifest.

The generated changes are the matching 17 wiki HTML pages, the two accepted
report HTML pages, and `docs/wiki-site/search-index.js`. Exact full paths for
**all** modified/untracked reviewable files are in
[changed-files.json](changed-files.json).

### Documentation tooling correction

`scripts/build_wiki_site.py` now rewrites `.md` to `.html` only for top-level
canonical pages the builder actually emits. Previously it rewrote handoff,
runbook and audit links into nonexistent HTML, producing ten broken generated
links during the first build. The narrow fix preserves external Markdown
paths/fragments. It changes documentation generation only, not production
application code, API behavior or deployment scripts.

## 5. Validation

- Existing focused tests: **113 passed, 0 failed** across mobile API, pairing,
  P0 contracts, history, Last.fm, Audio Info/source audio, Qobuz release and UPnP
  sessions. [Transcript](contract-tests.tap). Tests use local fixtures/mocks;
  they are not production or iOS runtime tests.
- Timestamp probe: **5 cases passed**; [results](timestamp-contract-results.json).
- Generator link projections: **7 cases passed**, including canonical,
  handoff, runbook, audit, external URL and fragment cases; [results](generator-checks.json).
- Site generation and repository link-check logs: [generation](generation-final.txt),
  [links](links-final.txt). No unresolved local file targets remain.
- Focused fragment checks, generation idempotence, source/evidence integrity and
  `git diff --check`: final results in [validation.json](validation.json).
- Remote external URLs were not live-crawled by the repository link checker.
  Production services and the iOS app were not exercised.

## 6. Preservation and Git/worktree state

The original comparison worktree and all older audit/reconciliation worktrees
remain unchanged. The complete accepted evidence also has a byte-checked durable
copy outside any worktree at:

`/Users/brianwis/.openclaw/workspace/artifacts/sonuvi/deepwiki-2026-10`

The original review was performed without committing, pushing or modifying
main. The approved final pass stages the focused documentation/evidence set,
then fast-forwards main and pushes only after fresh remote verification. No
reset, rebase, stash, prune, deployment, service restart, production-code or
iOS-repository change is included. Bulk crawler artifacts remain untracked in
the refinement worktree as well as in the durable archive.

**Approval:** Brian authorized commit, fast-forward integration and push after
final verification. The unverified current native event payload remains an
explicit limitation, not a hidden blocker or a fabricated pass.

## Final publishing verification

The offline GitHub Wiki export exposed the equivalent standalone-link issue in
`scripts/publish_github_wiki.py`: handoffs and evidence were turned into absent
Wiki page names. Its narrow documentation-only fix preserves canonical Wiki
slugs and sends standalone repository files to their GitHub `blob/main` URL.
No GitHub Wiki was pushed. See [final-verification.json](final-verification.json)
and [final-verification.py](final-verification.py) for executable generation,
navigation, search, publication and hygiene checks. Earlier validation logs are
preserved as the pre-approval snapshot, not a claim about the final staged set.

Last reviewed: 2026-10-28 America/Chicago.

### Final scope and archival checks

The final staged inventory is in [final-staged-files.json](final-staged-files.json);
[archive-packaging.json](archive-packaging.json) distinguishes 18 committed
evidence files from 132 retained bulk crawler files. The full 152-artifact
archive (150 evidence files plus the two reports) was SHA-256 checked against
the untouched original worktree. Both accepted reports remain byte-identical.

The historical `.patch` evidence contains literal single-space diff context
lines. Unfiltered `git diff --cached --check` reports those as trailing spaces;
all actual refinements pass with only these two historical patches excluded.
Their original hashes are retained rather than corrupting the archived diff
syntax. Secret-pattern scans and installation-path classifications are recorded
in [hygiene-checks.json](hygiene-checks.json). Installation paths in retained
historical/review provenance and existing examples are not live credentials;
the offline public Wiki export's existing path redaction remains verified.
