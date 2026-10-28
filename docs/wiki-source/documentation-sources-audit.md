---
title: documentation sources audit
page_type: support
topics:
  - ops
  - metadata
  - documentation
confidence: high
---

# Documentation sources audit

Last audited: 2026-09-22 (America/Chicago)

This page records the relationship among the repository documentation layers
and the separate GitHub-hosted Wiki before the documentation reorganization.
It is intentionally retained as a maintainer reference so a future editor can
tell which copy is authoritative.

## Audit conclusion

`docs/wiki-source/` is the authoritative editable source going forward.

The GitHub Wiki is a separate, older publication that is not generated from
this repository. It was imported from a DeepWiki snapshot in March 2026 and
last changed on 2026-03-14. Its pages cite main-repository commit `8de63591`,
while the repository now contains substantially newer architecture, playback,
PWA, controller, integration, and operational material.

No GitHub Actions workflow, repository script, or documentation reference was
found that synchronizes `docs/wiki-source/` with the GitHub Wiki. The Wiki's
remote is the separate repository:

```text
git@github.com:teacherguy2020/now-playing.wiki.git
```

The Wiki therefore was independently maintained and had diverged. The new
publishing script at `scripts/publish_github_wiki.py` makes publication
deterministic without putting credentials in the project. It copies the
canonical source to a checked-out Wiki repository and rebuilds `Home.md` from
the canonical landing page. It does not prune legacy Wiki pages unless an
operator explicitly requests that mode.

## Role of each documentation surface

| Current surface | Before reorganization | Final role | Action |
| --- | --- | --- | --- |
| `README.md` | Long product description mixed with operational procedures | Concise product front door with quick start and links | REWRITE |
| `docs/README.md` | Numbered, tab-ordered manual landing page | Concise map into canonical categories and maintenance rules | REWRITE |
| `docs/wiki-source/` | Strong but flat knowledge base with mixed entry points | One canonical editable source organized by audience and concept | REORGANIZE |
| `docs/wiki-site/` | Generated HTML companion | Generated browseable view of `docs/wiki-source/` | REGENERATE; never hand-edit |
| GitHub Wiki | Independent DeepWiki-derived snapshot | Published view of the canonical source; legacy pages remain historical until explicitly pruned | REPUBLISH |
| `docs/compatibility-guides/` and `docs/runbooks/` | Numbered feature/operations manual | Clearly secondary compatibility guides and selected standalone runbooks; not the canonical source | MOVE; RETAIN WITH EXPLICIT ROLE |
| `docs/references/` | Upstream files and patches | Supporting provenance/reference material | KEEP |

## Numbered-guide disposition

The numbered guides now live under clearly secondary directories rather than
directly under `docs/`. New documentation should be written in
`docs/wiki-source/`, not in these retained files. Their useful material is
represented by the canonical destinations below. The longer operational guides
remain deliberately retained until their full content can be moved without
losing installation-specific recovery detail. No top-level compatibility stubs
were retained because the repository search found no current internal links or
other concrete dependency requiring them; historical Wiki links are pinned to
an older commit and remain valid there.

| Final retained path | Canonical destination | Action | Reason |
| --- | --- | --- | --- |
| `docs/compatibility-guides/01-config.md` | `getting-started.md`, `config-interface.md`, `config-network-and-runtime.md` | MOVE / RETAIN COMPATIBILITY GUIDE | First-run setup is now audience-routed; the short guide remains a compatibility entry point. |
| `docs/compatibility-guides/02-diagnostics.md` | `configuration-and-administration.md`, `diagnostics-interface.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Diagnostics belongs to administration, not tab order. |
| `docs/compatibility-guides/03-alexa.md` | `using-now-playing.md`, `alexa-interface.md`, `config-alexa-setup.md` | MOVE / RETAIN COMPATIBILITY GUIDE | User voice behavior, setup, and route details have different audiences. |
| `docs/compatibility-guides/04-library-health.md` | `media-library.md`, `library-health-interface.md`, `library-health-page-anatomy.md` | MOVE / RETAIN COMPATIBILITY GUIDE | The canonical branch has deeper maintenance detail. |
| `docs/compatibility-guides/05-queue-wizard.md` | `using-now-playing.md`, `queue-wizard-internals.md`, `queue-and-playback-model.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Queue shaping is separated from ordinary queue control. |
| `docs/compatibility-guides/06-radio.md` | `radio-interface.md`, `radio-metadata-eval-interface.md` | MOVE / RETAIN COMPATIBILITY GUIDE | User radio operation is separated from metadata QA. |
| `docs/compatibility-guides/07-podcasts.md` | `podcasts-interface.md`, `config-podcasts-and-library-paths.md` | MOVE / RETAIN COMPATIBILITY GUIDE | User subscription actions and path/automation administration are distinct. |
| `docs/compatibility-guides/08-hero-shell.md` | `app-shell-anatomy.md`, `developer-reference.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Implementation concept, not a user chapter. |
| `docs/compatibility-guides/09-index-vs-app.md` | `developer-reference.md`, `app-shell-anatomy.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Shell/display distinction belongs in developer reference. |
| `docs/compatibility-guides/10-random-vs-shuffle.md` | `queue-and-playback-model.md`, `playback-authority-by-mode.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Durable queue semantics belong with playback authority. |
| `docs/runbooks/11-deploy-pm2-rollback.md` | `configuration-and-administration.md`, `deployment-and-ops.md` | MOVE / RETAIN RUNBOOK | Operational commands remain useful, but are no longer the documentation spine. |
| `docs/compatibility-guides/12-troubleshooting.md` | `troubleshooting-and-technical-notes.md` and linked runbooks | MOVE / RETAIN COMPATIBILITY GUIDE | The troubleshooting entry point now branches by symptom and authority. |
| `docs/compatibility-guides/13-theme.md` | `theme-interface.md`, `theme-page-anatomy.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Theme is a customization branch, not a numbered tab chapter. |
| `docs/runbooks/14-display-enhancement.md` | `displays.md`, `display-enhancement-peppy-player-flow.md` | MOVE / RETAIN RUNBOOK | Builder-first display setup remains valuable operational reference. |
| `docs/runbooks/15-moode-remote-display-blanking-fix.md` | `troubleshooting-and-technical-notes.md`, `display-surface-troubleshooting.md` | MOVE / RETAIN RUNBOOK | This is a targeted compatibility fix with actionable recovery steps. |
| `docs/compatibility-guides/16-mobile-builder.md` | `user-interfaces.md`, `phone-interface.md`, `tablet-interface.md` | MOVE / RETAIN COMPATIBILITY GUIDE | The current system has phone, tablet, and computer controller families. |
| `docs/compatibility-guides/17-youtube.md` | `using-now-playing.md`, `youtube-interface.md` | MOVE / RETAIN COMPATIBILITY GUIDE | YouTube is a user feature with a deeper implementation page. |
| `docs/compatibility-guides/18-kiosk.md` | `displays.md`, `kiosk-interface.md`, `kiosk-designer.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Kiosk is a presentation mode under Displays. |
| `docs/compatibility-guides/19-visualizer.md` | `displays.md`, `visualizer-in-embedded-mode.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Visualizer belongs to display/presentation behavior. |
| `docs/compatibility-guides/20-controller-recents-lastfm.md` | `tablet-interface.md`, `tablet-recents-and-lastfm.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Tablet recents are a controller child branch. |
| `docs/runbooks/21-moode-airplay-metadata-hardening.md` | `troubleshooting-and-technical-notes.md`, `airplay-metadata-hardening.md` | MOVE / RETAIN RUNBOOK | Host-side AirPlay hardening is an operational troubleshooting topic. |
| `docs/runbooks/22-moode-upgrade-runbook.md` | `configuration-and-administration.md`, `deployment-and-ops.md` | MOVE / RETAIN RUNBOOK | It contains installation-specific recovery detail that should not be shortened casually. |
| `docs/compatibility-guides/23-mabel-vip.md` | `integrations.md`, `mabel-integration.md` | MOVE / RETAIN COMPATIBILITY GUIDE | Mabel conversation/hardware remains owned by the separate repository. |
| `docs/compatibility-guides/24-jukebox-priority-integrations.md` | `integrations.md`, `jukebox-priority-model.md`, `mills-throne-integration.md` | MOVE / RETAIN COMPATIBILITY GUIDE | User-facing integration setup and shared priority semantics are different topics; Mills is deliberately different. |
| `docs/compatibility-guides/25-webstream-listener.md` | `using-now-playing.md`, `listen-on-device.md` | MOVE / RETAIN COMPATIBILITY GUIDE | The user-facing name is Listen on Device; the canonical page preserves Safari, ALSA, MPD, and Caddy constraints. |

### Other moved standalone documents

| Final path | Canonical destination | Action | Reason |
| --- | --- | --- | --- |
| `docs/runbooks/INSTALL_VALIDATION.md` | `install-and-validation.md` | MOVE / RETAIN RUNBOOK | The installer gate is a procedural validation checklist. |
| `docs/references/style-naming-map.md` | `glossary.md`, frontend reference pages | MOVE | Vocabulary and CSS-token notes support maintenance but are not a user guide. |

## GitHub Wiki comparison

### Identical pages

No byte-identical Markdown pages were found. The GitHub Wiki and
`docs/wiki-source/` use different page names, metadata, link styles, and
organization. They do contain many semantically overlapping pages.

### Diverged overlapping material

The strongest overlaps are:

| GitHub Wiki pages | Current canonical pages | Which is newer / preferred |
| --- | --- | --- |
| `Overview.md`, `System_Architecture.md` | `system-overview.md`, `architecture.md` | `docs/wiki-source/`; it includes later runtime, ownership, and local-truth guidance. |
| `Installation__Setup.md`, `Configuration_Basics.md` | `install-and-validation.md`, `config-interface.md`, `config-network-and-runtime.md` | `docs/wiki-source/`; the Wiki cites the older `8de63591` snapshot. |
| `User_Interfaces.md`, `Mobile_Controller.md`, `Responsive_Design.md` | `user-interfaces.md`, `desktop-browser-interface.md`, `tablet-interface.md`, `phone-interface.md` | `docs/wiki-source/`; it includes the current installed web-app identities and iPad behavior. |
| `Queue_Management.md`, `Queue_Wizard_Interface.md`, `Filter_Builder.md`, `Vibe_Builder.md` | `queue-and-playback-model.md`, `queue-wizard-internals.md`, API pages | `docs/wiki-source/` for current route/authority rules; Wiki pages remain useful historical detail. |
| `Display_Pages.md`, `Peppy_Bridge_Display.md`, `moOde_Display_Control.md` | `display-interface.md`, `display-enhancement-peppy-player-flow.md`, display runbooks | `docs/wiki-source/`; current operational cautions and display ownership are newer. |
| `Alexa_Voice_Control.md`, `Voice___External_Integrations.md` | `alexa-interface.md`, `config-alexa-setup.md`, `integrations.md` | `docs/wiki-source/`; current hybrid Alexa/Homebridge architecture is authoritative. |
| `API_Architecture.md`, `API_Endpoints_Reference.md`, `MPD_Integration.md` | API overview, endpoint catalog, playback/API pages | `docs/wiki-source/`; verify exact route details against current source before relying on Wiki snapshots. |

### Material represented only by the GitHub Wiki's page names

The Wiki has named pages for Filter Builder, Vibe Builder, Static Album Art,
Art Caching, Responsive Design, Playlist Management, and Podcast Backend. The
canonical source covers most of those concepts across queue, library, config,
API, and interface pages, but not always with one matching filename. Those
pages are therefore mapped into the canonical branches rather than silently
discarded.

### Material only or substantially newer in `docs/wiki-source/`

The repository source contains material absent from the audited Wiki snapshot,
including:

- current Mills Throne behavior and source-of-truth boundaries;
- Seeburg/Multiphone priority behavior and the separate Mabel repository
  boundary;
- the controller tablet/iPad Home Screen identity and `black` status-bar
  vignette fix;
- Screen Wake Lock and metadata-only MediaSession behavior;
- Listen on Device ALSA mute/restore and MPD resume/stop preferences;
- route ownership, playback authority, fragile behavior, and symptom-oriented
  troubleshooting runbooks; and
- current local deployment/environment guidance.

### Publication decision

The canonical source wins when duplicate material conflicts, subject to a
code-first verification pass. The publisher updates the Wiki's canonical
pages and Home navigation without deleting old Wiki pages by default. Legacy
pages are no longer an authoring target; they can be pruned later after a
separate content-preservation review.

## Documentation Sources Consolidated

The final documentation roles are deliberately explicit:

- **Root `README.md`** is the product front door: a concise capability,
  architecture, quick-start, and integration overview.
- **`docs/README.md`** is the repository documentation landing page. It routes
  readers to the canonical categories and explains the publication layers.
- **`docs/wiki-source/`** is the one authoritative editable Markdown source.
  New substantive documentation belongs here.
- **`docs/wiki-site/`** is generated static HTML for browse/search use. It is
  regenerated from the canonical source and is not hand-edited.
- **GitHub Wiki** is a published view of the canonical source. The deterministic
  `scripts/publish_github_wiki.py` publisher updates canonical pages and
  `Home.md`, retains legacy pages by default, and excludes the
  installation-local `local-environment.md` page. It also redacts known
  installation-specific host addresses and deployment paths in public copies.
- **`docs/compatibility-guides/` and `docs/runbooks/`** contain retained
  compatibility entry points and selected operational runbooks for bookmarks,
  recovery detail, and focused procedures. They are not a competing
  documentation hierarchy.
- **`docs/references/` and wiki support metadata** remain provenance or
  maintenance material rather than alternate user-facing authoring sources.

Future maintainers should edit `docs/wiki-source/`, run the site generator,
and publish the GitHub Wiki from that source. They should not make parallel
feature edits in `docs/wiki-site/` or the GitHub Wiki.

## Maintainer rule

Edit `docs/wiki-source/`. Do not hand-edit `docs/wiki-site/` or the published
GitHub Wiki pages. Use `scripts/publish_github_wiki.py` for the GitHub Wiki and
the documented site-generation workflow for `docs/wiki-site/`.

## October 2026 DeepWiki evidence and refinement

The accepted [before-and-after comparison](deepwiki-comparison-2026-10.md)
and [prioritized plan](deepwiki-documentation-refinement-plan-2026-10.md) are
historical snapshots, preserved unchanged. The complete 77-page ledger,
revision evidence and hashes are included in the repository's `audit-evidence/`
directory. Full retrieved bodies and raw crawler responses are preserved in the
durable local archive recorded by the refinement review; they are not generated
as user-facing documentation.

The [documentation refinement review](../reviews/deepwiki-refinement-2026-10/review.md)
records subsequent source-backed corrections, timestamp-contract verification,
the native Audio Info screen clarification, validation results and final
publication verification. Read its Audio Info qualification alongside the earlier
comparison: a removed DeepWiki leaf is not by itself proof of lost capability
or an iOS UI-driven change to the indexed Server repository.

*Last reviewed: 2026-10-28 America/Chicago*
