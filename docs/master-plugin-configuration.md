# Master plugin configuration overhaul

## Approved target — 2026-11-13

One authoritative master JSON; built-in configuration plugins; shared web/iOS
administrator API. Brian approved implementation in isolated worktrees only,
without delegation, deployment, release publication or production credential
changes. Source: pasted-text-1794573279298---f657320f-3e15-455e-8bfb-1d6d6dc4ef75.txt.

## Current baseline and audit

Server baseline: 98e2cab. iOS unified baseline: 99d7005.
Separate uncommitted iOS pairing/setup changes are preserved in the original
friendly-storage checkout and require reconciliation before integration.

Existing reads merge base JSON with data/native-configuration.json, then apply
environment overrides and projection defaults. Native writes target the overlay;
browser writes target base JSON. Thus browser saves can be shadowed by native
settings. Many src/config.mjs values are captured at startup; API readback does
not prove that a running consumer has applied an edit.

## Implementation sequence

1. Registry, document validation, revision store, reversible migration.
2. Unified administrator API, runtime and legacy adapters.
3. Web shared-draft forms/JSON and plugin credential actions.
4. Native iOS parity and Guided Setup initialization.
5. Last.fm consumers, authorization, Vibe and scrobbling; remaining integrations.
6. Isolated migration, concurrency, browser, native and installer verification.

## Acceptance

Implementation is in progress. No deployment or physical acceptance performed.
Real Last.fm recommendations and accepted scrobbles require external verification;
mock/unit results must be reported separately.

## Development checkpoint

### Active continuation — 2026-11-13

Last.fm owner API actions now save protected API credentials, start/complete the
existing browser authorization flow, retain authorized username, and disconnect.
The web plugin exposes these actions separately from ordinary draft Save. A marked
owner-managed credential file wins over stale process-environment credentials on
restart; legacy unmarked files keep their previous precedence. Scrobbling reloads
credentials per submission; fixture tests cover rotation/disconnect and accepted
versus ignored submissions. Last.fm metadata readers now use the canonical
adapter and authorized identity with optional public-username fallback.

More environment mappings cover playback/playlists, Harmony, Echo Link and Apple
Music metadata. Ratings/diagnostics readers now use the adapter. Alexa event writes
use a separate data file for master installations, preserving master bytes.
Full migration of old event records and all enablement semantics remains open.

Latest focused Server run: 46 passed, zero failed. Earlier full suite: 835 total,
817 passed, 11 failed, 7 skipped. Failures include obsolete legacy UI assertions,
real removed moOde/Qobuz UI parity, and four macOS systemd adapter fixtures.
Do not call the full suite green or silently remove parity tests.

iOS isolated worktree now has master JSON models, shared-draft/conflict handling,
fixed owner API operations over existing direct and pinned-SSH transports, and
an initial native Settings editor with raw JSON and Last.fm actions. Four focused
Swift tests passed; Simulator build is being collected in the active turn. Native
UI acceptance, unsaved navigation handling and validation detail remain unfinished.

Still required: complete direct-reader audit; inline credential migration and
installer permission provisioning; actual operational checks; moOde/Qobuz controls;
iOS validation and regression completion; Guided Setup migration/initialization;
reproducible candidate; live Last.fm and physical acceptance. No commit, push,
release, physical-client operation or live-host mutation has occurred.

Resume implementation update: transaction activation now backs up and consolidates
ordinary settings, removes migrated native overlays, supports checked rollback,
and rejects invalid input without changing originals. Inline credential transfer
remains explicitly blocked, not silently lost. API/web startup derives supported
environment values from the master. This is not yet a complete direct-reader audit.
Legacy native and browser saves reject master-format writes rather than flattening
or overwriting the document; older editing clients must upgrade.

The actual config.html now mounts the editor. Browser modules are included in the
release public allowlist; the old page is retained only as an unserved reference
in docs/legacy-config-reference.html. Isolated Chromium interaction verifies form
to JSON, JSON to form, invalid plugin draft retention, and Save feedback. This uses
a mocked API, not physical Safari or live service acceptance. Thirty focused
configuration/runtime/migration/gateway/public packaging tests plus that browser
test passed on this resume. iOS, credentials, full runtime audit and installer
integration remain unfinished. No production changes, commit, push or release.

Next action: finish credential migration/actions and full ordinary-reader audit,
then iOS/installer parity and broader regression testing. Work remains in progress.

### Continuation — November 13, latest local verification

Guided Setup now edits MPD, moOde and library sections through the shared
revision-checked master store, rather than writing music-setup.env. It checks
the master before host mutations, records the saved revision, and keeps share
credentials and the read-only mount unit separate. Atomic master saves preserve
file owner/group as well as mode, including saves by the privileged setup helper.
Setup host-side failure recovery still needs disposable Linux acceptance.

Protected APNs credential clearing also clears the legacy key-path fallback.
APNs readiness requires a topic; notification status distinguishes Pushover
and APNs; Alexa distinguishes its skill endpoint from Homebridge webhooks.
None of these configured flags claim successful external operation.

Latest focused run: 37/37 tests passed (master store, migration transaction,
draft/browser using real shared API/store, runtime, Last.fm credentials, generic
credentials, music setup). An additional status API run passed 5/5 after that
suite. Log: /tmp/sonuvi-master-plugin-focused-20261113-latest.log.
Earlier full macOS run: 838 tests, 827 pass, 4 Linux ownership failures, 7 skips;
those four systemd tests separately passed in isolated node:22-bookworm Linux.
These are automated fixtures, not live-host acceptance.

Latest iOS Simulator build passed, exit 0, 88.1 seconds; log
/Volumes/SammySSD/Sonuvi-Codex/sonuvi-ios-codex/logs/20261113-073829-728127-simulator-build.log.
Native focused tests passed, exit 0, log 20261113-074001-527663-swift-test.log.
Full native regression completed successfully (oceanic-harbor, exit 0):
1,183 tests executed, 8 skipped, 0 failures. Log:
/Volumes/SammySSD/Sonuvi-Codex/sonuvi-ios-codex/logs/20261113-074028-470916-swift-test.log.
Next action: finish upgrade migration activation/recovery. Existing-install upgrade wiring remains incomplete; do not
deploy this candidate. Latest native generic credential/Qobuz edits compile in
Simulator; physical acceptance remains undone. No commit, push, release,
live-host or physical-client change.

### Earlier checkpoint (historical)

Implemented, not deployed: built-in registry; master validation/revision store;
pure legacy migration planner and compatibility mapping; shared administrator
API handlers and existing-owner authorization wiring; browser session/CSRF
transport; draft synchronization model; unmounted schema-driven editor component.

Last.fm: Vibe now consults the protected credential reader. The scrobbler checks
Last.fm's accepted count and ignored result instead of treating HTTP 200 as
acceptance. Historical Pi5 commit 35df541 contains the same HTTP-only acceptance
behavior; it is useful parity evidence but not proof of correct acceptance.

Verification: 28 focused master/draft/API/native-authority/scrobble tests passed;
19 gateway/legacy-workspace/Vibe regression tests passed (47 total). Web component
has syntax verification only, no browser acceptance. No real Last.fm call made.

Next action: complete reversible on-disk migration and runtime consumer cutover,
then mount/test the editor, implement credential actions and native iOS parity.
The legacy runtime still uses its original configuration sources: the overhaul
is NOT complete. API registration alone does not activate the new master format.
The migration planner must not be used as an installation migration executor.
It produces credential transfer values; never log the plan wholesale.

Remaining: full schema/core validation, custom integration mappings, apply
serialization, plugin operational providers, credential ownership/permissions,
on-disk backup/rollback, installer cutover, iOS UI/transport, browser acceptance,
real service acceptance. Original source checkouts and live hosts untouched.


### Explicit continuation authorization and implementation — 2026-11-13

Brian approved pasted-text-1794577531640---c5e3521e-bfd7-4216-b069-082f235ab2fa.txt:
finish the existing isolated Server/iOS implementation as the sole agent, prepare
and verify a local release candidate, but do not publish, modify the lab endpoint,
change live credentials, reset VMs or touch physical devices. No delegation.

Current source now includes guarded upgrade migration after both services stop,
effective-process-environment capture, transaction-bound permission restoration,
crash recovery (SIGKILL before and after master rename), and separate migration
of historical Alexa observations into data/alexa-events.json. Corrupt/missing
inputs fail closed; later administrator changes prevent destructive rollback.

Hardware inventory now includes stable hardware, mills, seeburg and multiphone
modules. The shared hardware listener preserves exact client role mappings and
remains disabled on fresh installs; external bridge firmware is not configured
by these settings. Ordinary music, sticker, playlist-artwork and podcast paths
are included in the master environment projection.

Brian confirmed Last.fm covers Vibe, personal shelves and scrobbling, and favors
deprecating the duplicate username entry. The username field is now schema-marked
deprecated and omitted from normal web/iOS forms, but retained in complete JSON
for legacy compatibility. Authorized identity wins; all four shelf endpoint
fixtures prove reuse of protected API access. Vibe requires API access; personal
shelves also require identity; scrobbling requires an authorized session. No
Last.fm password is collected. Live service acceptance remains unperformed.

Bootstrap inventories and native embedded v1/v2 capsules now include the new
configuration dependency closure. This requires new packaged Server material,
new bootstrap kits, matching native capsule bindings and release inventory
bindings before publication. Existing published inventories are not a release
candidate for these changed capsules.

Verification in this continuation: full Server macOS run excluding the Linux
systemd file: 851 tests, 844 pass, 7 skip, zero fail. Linux adapter/migration
focused run: 23 pass. Native original checkpoint: 1183 tests, 8 skip, zero fail.
The updated native regression exposed only old fixed capsule expectations;
those were updated to exact revised bytes and the focused upgrade suite passed.
Full updated native regression/build and final clean package remain to collect.

An earlier immutable development snapshot passed Debian ARM64 Node/Sharp,
real service-user master Save and credential persistence across a fresh process,
root-owned verifier protection, bundled assets, and packaged config.html browser
interaction. It predates the latest upgrade/hardware changes and is not the RC.
Actual v1 capsule acceptance passed in disposable Debian ARM64 (4/4 tests).

### Local immutable candidate verification

The implementation checkpoint is fead04e804a4f0a251acc13e6cdce20388522b4f.
Two clean ARM64 builds using identical inputs have identical manifests; the
fresh-install artifact is
sonuvi-c9e70d85d5d28e9d5bcbe3969211f3cc665b8fe46d366d28056e4446d645f89a.
The v1 fresh-install kit and envelope are locally signed and verified, not
published. Clean packaged Node/Sharp, actual sonuvi-user atomic Save, Last.fm
and notification credential persistence after a new process, verifier-file
protection and UI asset checks passed. Native full regression and Simulator
build passed after the capsule update; final acquisition pin validation follows.

The existing product deliberately has independent v1 fresh-install and v2
upgrade inventories. A documentation-only successor revision is used for the
v2 companion artifact so those fixed acquisition contracts have distinct
immutable release IDs and do not require conflicting envelopes at one URL.
Runtime implementation is unchanged from the fresh-install checkpoint. Both
remain local candidates until separate publication authorization.

Remaining acceptance: genuine Last.fm Vibe/scrobble service responses, APNs
registration/delivery, Alexa skill connectivity, hardware bridge operation,
Safari/iOS physical cross-client behavior, and the next physical-iPad clean
Debian installation. Fixture success is not physical or external acceptance.
