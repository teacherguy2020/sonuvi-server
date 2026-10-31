# diagnostics interface

## Purpose

This page documents `now-playing/diagnostics.html`, the diagnostics and live-inspection console in the `now-playing` ecosystem.

This page is intentionally implementation-aware, because `diagnostics.html` is clearly not just a passive status screen. It acts as a multi-purpose operator console for:
- making direct API requests
- inspecting responses
- testing endpoints with or without `x-track-key`
- viewing live embedded UI surfaces side-by-side
- navigating operational/debug workflows through a browser UI

## Audio Info entry points and presentation

Audio Info is one capability with **different client presentations**, not one
universal drawer:

- **Sonuvi iOS:** open Audio Info from the native Audio Info entry associated
  with Home audio details. The current product presentation is a dedicated
  screen/page, replacing the earlier native modal/drawer (confirmed by Brian
  on 2026-10-28). Navigate to that screen; do not restore drawer instructions.
  Exact native navigation implementation lives in the separate iOS repository
  and was not inspected for this Server documentation refinement.
- **Server tablet web controller:** `controller-tablet.html` still has an
  **Audio info** action (`tabletAudioInfoBtn`) opening `audioInfoModal`.
  That web modal exists in both indexed Server revisions, `dee06724` and
  `4bf8889a`; it must not be mistaken for the replaced native drawer.
- **Operator diagnostics:** use the authenticated API/request console for the
  endpoint below. Diagnostics is an inspection surface, not a replacement
  native Audio Info screen. There is no dedicated Server `audio-info.html`
  page in the reviewed main revision.

The native screen provides a separate navigation destination rather than a
transient overlay; that presentation change does not create a new playback
owner or change which measurements the Server can establish.

| Caller | Data endpoint | Boundary |
| --- | --- | --- |
| Web tablet/operator | `GET /config/moode/audio-info?view=rows&diagnostics=1` | Track-Key-protected reader; legacy rows plus optional diagnostics |
| Native iOS Audio Info screen | `GET /v1/mobile/audio-info` | Bearer adapter invokes the protected reader internally and returns sanitized rows/audio/diagnostics |
| Server → moOde | `audioinfo.php` plus bounded read-only ALSA procfs probe; local source probe when available | Internal implementation, not URLs or credentials for a native client |

The mobile adapter strips/reduces source-path rows, forwards safe evidence
roles and timestamps, and sanitizes the versioned diagnostics object. See
[the native DTO](mobile-now-playing.md#native-home-summary-shelf).
Native UI navigation is not an API route migration.

### What Audio Info can establish

| Evidence role | Interpretation |
| --- | --- |
| Source format / `sourceFile` | Encoded media identity/codec/rate/bitrate; locally probed or provider-reported provenance matters |
| Decoded PCM / `decodedAudio` | Decoder-reported sample representation; calculated PCM throughput is not encoded bitrate |
| Configured output | Intended moOde/MPD chain, not a measured Qobuz path |
| Measured hardware output | Current ALSA endpoint parameters when exposed; not proof of every upstream conversion |
| Processing / volume | Configured/reported behavior with explicit provenance, not assumed hardware measurement |
| Freshness / conversion | Capture and hardware timestamps bound observation age; intermediate conversion remains unknown |

These distinctions remain essential on the dedicated screen. ALSA format
agreement alone does **not** establish end-to-end bit-perfect playback. The
full [Audio Info diagnostics contract](#audio-info-diagnostics-contract) below
is the source of truth; preserve unavailable/unknown states rather than
filling them with configured values.

## Why this page matters

`diagnostics.html` appears to be one of the strongest operator-facing truth surfaces in the project.

It matters because it combines:
- direct endpoint execution
- live embedded views of multiple UI surfaces
- clipboard/curl-oriented debugging helpers
- quick comparison between API behavior and rendered UI behavior

That makes it extremely valuable when the question is:
- what is the system doing right now?
- what does the API say?
- what does the rendered UI show?
- do those things agree?

## Important files

Primary page:
- `now-playing/diagnostics.html`

Important supporting script:
- `now-playing/scripts/diagnostics.js`

Related pages:
- `configuration-and-diagnostics-interfaces.md`
- `config-interface.md`
- `display-surface-troubleshooting.md`
- `deployment-and-ops.md`

## High-level role

A good current interpretation is:
- `diagnostics.html` is a browser-based operator/debug console
- it helps bridge raw API behavior and visible UI behavior
- it is one of the most practical pages for side-by-side inspection and debugging

This means it is not only about diagnostics in the abstract. It is also about comparative observation.

## Shell / entry behavior

Like `config.html`, `diagnostics.html` contains shell-redirect behavior.

Observed logic:
- if `standalone=1`, remain standalone
- if top-level without standalone, redirect into:
  - `app.html?page=diagnostics.html`
- if embedded in another shell already, do not redirect

So `diagnostics.html` is designed for both:
- standalone operator use
- embedded/shell-hosted use inside the broader app

## Major UI areas visible in the page

Repo-visible structure shows several major diagnostics areas.

## 1. Request runner / endpoint console
This top card includes:
- endpoint filter input
- endpoint selector
- method selector (`GET` / `POST`)
- path field
- JSON body field for POST
- run button
- favorite toggle
- copy-as-curl button
- copy-response button
- optional `send x-track-key` checkbox
- status area

This is one of the clearest operator/debugging surfaces in the system.

## 2. Live embedded view cards
The page includes multiple live embedded-view cards for direct UI inspection, including:
- live now-playing view (`index.html`)
- live player view (`player.html`)
- live peppy skin view (`peppy.html`)
- live controller view (`controller.html`)
- live kiosk view (`kiosk.html`)

Each has controls such as:
- collapse/expand
- reload
- zoom
- open in new tab

This is a very important design choice.

It means diagnostics is not only about raw responses - it is also about quickly inspecting multiple rendered surfaces from one operator page.

## Important DOM/action centers

Observed important elements include:
- `#endpointFilter`
- `#endpoint`
- `#method`
- `#path`
- `#body`
- `#runBtn`
- `#favBtn`
- `#copyCurlBtn`
- `#useTrackKey`
- `#copyBtn`
- `#status`

And for live views:
- `#liveFrame`
- `#playerFrame`
- `#peppyFrame`
- `#mobileFrame`
- `#kioskFrame`
- their corresponding reload/toggle/zoom controls

This is enough to treat the page as an active workbench rather than a static inspector.

## Diagnostics script as the logic center

The main page includes:
- `scripts/diagnostics.js`

That strongly suggests most of the request-running, favorites, frame-management, and interaction logic lives in that script rather than inline.

So a deeper future pass should likely inspect:
- `now-playing/scripts/diagnostics.js`

in detail.

## Request-runner behavior

Based on visible structure, the request runner supports:
- selecting or filtering known endpoints
- choosing method
- editing path manually
- submitting JSON for POST requests
- optionally attaching `x-track-key`
- copying equivalent curl
- favoriting endpoints

This is architecturally important because it turns diagnostics into a lightweight in-browser API console.

That can be extremely useful when debugging runtime/admin behavior without leaving the browser UI.

## Track-key-aware diagnostics

The diagnostics page includes:
- `#useTrackKey`

This is a meaningful operator affordance.

It implies the diagnostics console is designed to test both:
- open/unprotected behavior
- protected/track-key-backed behavior

That is exactly the sort of thing a real maintenance/debug console should support.

## Live embedded-surface inspection

One of the strongest and most distinctive aspects of `diagnostics.html` is the set of embedded live views.

Observed cards include:
- `index.html` at desktop-style viewport size
- `player.html` at 1280×400
- `peppy.html` at 1280×400
- `controller.html` at mobile-ish viewport size
- `kiosk.html`

This means the page supports a workflow like:
1. run or inspect an endpoint
2. observe the live rendered result in one or more surfaces
3. compare whether the API and the UI agree
4. reload/reopen affected views quickly

That is a very powerful debugging pattern.

## Relationship to display and controller debugging

Because diagnostics embeds multiple live UI surfaces, it sits at the junction of several wiki branches:
- config/diagnostics/admin
- display surfaces
- controller surfaces
- kiosk behavior
- peppy/player render behavior

That means `diagnostics.html` may often be a better starting point than a purely conceptual doc when someone is actively debugging a live symptom.

## Current observed API/config contact

Even from the current light inspection, we can already see:
- `diagnostics.html` fetches runtime config from `/config/runtime`
- it conditionally hides/shows some navigation based on runtime config (for example podcasts visibility)
- it is designed to execute arbitrary configured diagnostic requests through the request-runner UI
- `scripts/diagnostics.js` fetches `/config/diagnostics/endpoints` to populate a server-backed endpoint list for the request runner
- `scripts/diagnostics.js` also keeps an `ENDPOINTS_FALLBACK` catalog, which means Diagnostics acts partly as an in-browser endpoint search/catalog surface

That makes `diagnostics.html` useful not only for live request execution, but also as an operator-facing API discovery aid.

## Architectural interpretation

A good current interpretation is:
- `diagnostics.html` is the browser operator's live debugging dashboard
- it combines API-console behavior with live surface monitoring
- it is one of the most direct pages for checking whether data flow and rendered UI are aligned

That makes it one of the highest-value pages in the diagnostics/admin branch.

## Related branch pages

- `radio-metadata-eval-interface.md`

This is the most direct current wiki page for the dedicated radio metadata QA/evaluation console.

## Anatomy companion page

- `diagnostics-page-anatomy.md`

This is the anatomy-style companion page for `diagnostics.html`.
Use it when the task is not just about Diagnostics as a surface, but about a specific region such as the request runner, favorites/endpoint selector, track-key toggle, curl/response helper layer, or embedded live-surface cards.

## Relationship to other pages

This page should stay linked with:
- `configuration-and-diagnostics-interfaces.md`
- `config-interface.md`
- `display-surface-troubleshooting.md`
- `deployment-and-ops.md`
- `diagnostics-page-anatomy.md`
- future pages for specific live-surface diagnostics or request-runner details

## Things still to verify

Future deeper verification should clarify:
- the exact endpoint catalog and grouping inside `scripts/diagnostics.js`
- how favorites are stored and restored
- how curl-copy generation is implemented
- whether the request runner can safely target all important protected endpoints
- how the live embedded cards are initialized and refreshed
- whether diagnostics includes hidden/advanced features not visible from markup alone

`diagnostics-page-anatomy.md` matters when the real question is not only “what is `diagnostics.html`?” but “which region inside `diagnostics.html` actually owns the thing I need to change?”

## Current status

At the moment, this page already has enough evidence to be treated as one of the project's core operator/debugging surfaces.

It is not just a diagnostics readout. It is a live API console plus multi-surface inspection dashboard, which makes it especially valuable for real troubleshooting work.

## Qobuz Audio Info interpretation

The `GET /config/moode/audio-info?view=rows` surface is source-aware when
Qobuz Connect owns the renderer. The Qobuz source format and decoded PCM are
reported by the existing Pibuz/moOde `get_qbzmeta` cache. The hardware output
is separate: Sonuvi receives bounded ALSA playback `hw_params`/`status` facts
only through the fixed `audio-info-snapshot` operation of the existing
restricted moOde dispatcher. It reports `Not measured` when no open stream
exposes parameters. It does not treat MPD being stopped as proof that the DAC
is idle.

The endpoint labels the moOde `audioinfo.php` ALSA mode and audio chain as
configured moOde/MPD path information, not verified Qobuz signal-path facts.
MPD-only volume diagnostics are represented as unavailable for Qobuz, so raw
`Unknown MPD volume type` or ALSA mixer-control errors do not leak into the
Qobuz panel. The authenticated mobile audio-info contract forwards the safe
`audio` object and optional diagnostics/provenance without exposing moOde URLs,
file paths, PHP session identifiers, or renderer credentials.

## Audio Info diagnostics contract

`GET /config/moode/audio-info?view=rows&diagnostics=1` collects one bounded
snapshot through the pinned, fixed-command
`sonuvi-readonly-v1 audio-info-snapshot` operation. The root-owned dispatcher
establishes the stored moOde session locally, reads MPD state and bounded
`/proc/asound` playback facts, and returns a structured non-secret response.
The Server never turns client input into a remote command, path, URL, session
identifier, or redirect target. Collection-stage unavailability remains
explicit rather than being rewritten as a stopped player or a measured output.
The collector does not open an ALSA device, seize playback, or restart a
service. The legacy rows remain available and unchanged when `diagnostics=1`
is omitted.

The optional `diagnostics` object is versioned as `audio-info.v1`. The bearer
`GET /v1/mobile/audio-info` route requests this view when Audio Info is opened
and forwards the safe object alongside the existing rows. It is the shared
Server/iOS diagnostic contract; native clients do not call the Track-Key
`/config` route directly. Its main fields are:

- `sourceFormat`: source-file or renderer-reported codec, bit depth, rate, and
  channels;
- `decodedPcm`: MPD/renderer-reported decoded format, not a DAC measurement;
- `configuredOutput`: moOde's configured ALSA mode and chain, marked
  `valueType: "configured"` and `measured: false`;
- `hardwareOutput`: the current ALSA playback format, rate, channels, state,
  and device label when procfs exposes them, marked
  `valueType: "hardware-measured"`;
- `processing` and `volume`: configured moOde/MPD state, never represented as
  current hardware measurements;
- `conversion`: deliberately `status: "unknown"`, because ALSA endpoint
  parameters cannot prove every conversion before the endpoint;
- `freshness`: request-time capture and hardware-measurement timestamps.

The diagnostics object also has additive normalized fields for metadata
accuracy:

- `sourceFile`: container, codec, source bit depth, source sample rate,
  channels, and encoded bitrate. `codecStatus: "verified"` means the
  bounded local-file `ffprobe` supplied the codec; `reported` means the value
  came from provider metadata, and `unavailable` means no codec evidence was
  available. Lossy codecs report
  `bitDepthStatus: "not-applicable"`; decoder precision is never copied into
  this object. Local files use the existing bounded `ffprobe` source probe
  when available, with stat-keyed cache invalidation.
- `decodedAudio`: decoder-reported PCM precision, rate, and channels. Its
  `pcmBitrateBps` is a nominal value calculated from those PCM parameters and
  is labeled `pcmBitrateStatus: "calculated"`; an encoded bitrate is not shown
  as decoded throughput.
- `output`: the same actual ALSA observation as `hardwareOutput`, with device,
  interface, format, rate, and channels grouped under the output role.
- `collection`: non-secret availability/provenance for the dispatcher session,
  renderer report, MPD status, and ALSA observation. This is diagnostic
  transport evidence, not audio-format evidence.

### Active radio-stream source evidence

When diagnostics are requested for an active, ordinary MPD radio stream, the
Server may augment `sourceFile` with a short, upstream observation. The stream
URL is read only from current Server-owned MPD `status`/`currentsong` state;
the request cannot provide a URL, host, path, redirect destination, or command.
Qobuz Connect, UPnP, local files, paused/stopped playback, and non-radio paths
do not start this probe.

The initial URL and every manual redirect must be public HTTP(S) destinations;
loopback, local/private/link-local, multicast, documentation, and unresolved
addresses are rejected. The Server requests at most a 64 KiB byte range with a
short timeout, consumes at most 64 KiB, and sends those bytes to `ffprobe` on
stdin. `ffprobe` never receives a network URL. Results are briefly cached per
normalized active stream URL, deduplicated while a probe is in flight, and
discarded immediately when MPD's current stream identity changes.

A successful bounded probe carries `valueType: "live-stream"` and
`provenance: "live-upstream-probe"`; for example it can establish
`AAC-LC · 44.1 kHz · Stereo`. `icy-br` is represented separately as encoded
bitrate with `encodedBitrateProvenance: "icy.header"`. Header-only evidence is
partial and uses `codecStatus: "reported"`; it does not invent sample rate,
channels, bit depth, decoded PCM, ALSA/DAC output, resampling, or Bit Perfect
delivery. For AAC, source bit depth remains `not-applicable`.

This distinction is required because moOde's `audioinfo.php` builds its
`Decoded to` string from MPD's decoder fields but appends MPD's `bitrate`
field to that same string. For AAC, moOde also maps MPD's floating-point
precision marker (`f`) to a displayed 24-bit decoder value. Therefore a row
such as `PCM 24 bit 44.1 kHz, Stereo, 270 kbps` means decoder-reported PCM
parameters plus an encoded-source bitrate; it does not establish a 24-bit AAC
source. The normalized fields keep those meanings separate. When diagnostics
are requested and the verified source codec is lossy, the returned legacy
`Decoded to` row omits the trailing encoded bitrate; the compatibility view
without diagnostics remains unchanged.

The mobile response redacts local source paths and network URLs from legacy
rows and never forwards the internal moOde URL, Track Key, or PHP session ID.

The main controller shells disable MPD transport/shuffle/repeat/seek controls
while Qobuz owns playback; the server route also rejects those MPD commands
with a source-aware unavailable response. No Qobuz remote-control API is
implied by the metadata integration.

*Last reviewed: 2026-10-30 America/Chicago*
