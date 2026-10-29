# Deployment Hardening H4A.1 — Target Compatibility and Non-Activating Staging Plan

> Historical staging design. Current source/operations: [Sonuvi Server operations](sonuvi-server-operations.md). Host-specific migration transport is intentionally not published.

**Status:** engineering and read-only Pi5 analysis only. This document does
not authorize a Pi5 write, artifact transfer, service reload/restart, account
creation, credential migration, catalog migration, or release activation.

The seven H3.6 commits remain the prior clean baseline. H4A.1 corrections are
committed as reviewed H4A.2 scope; the legacy `/opt/now-playing` checkout
remains the only live deployment and is not an H4A.1 target.

## A. Target runtime compatibility

| Check | Build/release baseline | Pi5 read-only observation | Result |
| --- | --- | --- | --- |
| OS/architecture | Linux ARM64 | Debian 13 / `arm64` | compatible |
| Node | 20.19.5 | 20.20.1 | compatible at the supported Node 20 major |
| Node module ABI / N-API | 115 / 9 | 115 / 9 | identical |
| libc | Debian bookworm glibc 2.36 | glibc 2.41 | target is newer |
| Sharp | 0.33.5 Linux ARM64 payload | Pi5-compatible ABI/platform | locally load-tested |
| npm | 10.8.2 build tool | 11.11.0 installed | not used to install dependencies |

The exact H3.6 ARM64 artifact was mounted read-only into Linux/ARM64
`node:20.19.5-bookworm-slim` and `node:20.20.1-bookworm-slim`. In both
containers, Sharp 0.33.5 loaded and produced the same in-memory PNG digest.
All 87 declared dependency Node-engine constraints accept Node 20.20.1.

This is strong compatibility evidence, not a Pi5 artifact-load claim. H4B
must run the artifact-contained `scripts/verify-release-runtime.mjs` on the
staged Pi5 copy. It verifies the manifest, actual target platform/Node major,
the required command names, and an in-memory Sharp transform without changing
runtime state or contacting a playback service.

The verifier accepts a later patch release in the same build Node major and
fails closed for a different OS, architecture, Node major, or a manifest that
declares a different ABI/N-API value. It does not run `npm install`.

## B. Candidate service topology

The H4A.1 API unit corrects the H3 local-MPD assumption:

- no `mpd.service` dependency or `/var/lib/mpd/music`/playlist permission;
- `RequiresMountsFor=@MUSIC_LIBRARY_ROOT@` and a read-only music source view;
- `MUSIC_LIBRARY_ROOT` and `PI4_MOUNT_BASE` set to `@MUSIC_LIBRARY_ROOT@`;
- remote MPD/moOde endpoint settings remain protected configuration, not unit
  literals;
- API state is writable only below `/opt/sonuvi/shared`;
- SSH defaults use `HOME=/opt/sonuvi/shared/protected/ssh-home`, never
  Brian's home directory.

`@MUSIC_LIBRARY_ROOT@` is intentionally read-only in the candidate unit. Normal
catalog reads, artwork reads, and source-audio reads fit that model. Podcast
downloads, music-tag edits, and any library-health action that writes into the
music mount require an explicit later H4C exception or a separate narrowly
scoped maintenance service; they must not silently regain broad write access.

The web unit is loopback-only on port 8101, requires the API unit, serves only
the generated public root, and has no write path. Both units remain candidate
files only.

### Access and ownership matrix for a later activation phase

| Location / material | Service access | Proposed owner/mode | Migration posture |
| --- | --- | --- | --- |
| `/opt/sonuvi/releases/<id>` | API/web read/execute | `root:root`, `0555` tree | staged artifact; immutable |
| `/opt/sonuvi/shared/config` | API read/write allowed config | `sonuvi:sonuvi`, `0700`; files `0600` | controlled copy/create in H4C |
| shared `data`, `cache`, `logs` | API read/write | `sonuvi:sonuvi`, `0700` | controlled state migration in H4C |
| shared `protected` | API read/write secrets/tokens/queues | `sonuvi:sonuvi`, `0700`; files/keys `0600` | controlled, item-by-item migration |
| shared `checkpoints` lock/state | activation/API read/write | directory `0711`, private files `0600` | create only during activation preparation |
| `public-traffic-open.json` gate | activation write; Caddy stat/read | non-secret release ID only, `0644` | Caddy needs traversal only; no tokens here |
| `/etc/sonuvi/now-playing.env` | API read-only | `root:sonuvi`, `0640` | new protected file, no value logged |
| Apple/APNs/Last.fm key material | API read-only if enabled | `root:sonuvi`, `0640` under `/etc/sonuvi` | controlled copy or explicit in-place reference review |
| moOde SSH identity + known hosts | API/SSH read-only | root-managed `/etc/sonuvi/ssh`, directory `0750`, files `0640` | dedicated identity only; never use `/home/<operator>/.ssh` |
| saved Qobuz queues | API read/write | shared protected `0700` | format-preserving controlled copy; legacy remains intact |
| CIFS `@MUSIC_LIBRARY_ROOT@` | API read-only | existing mount permissions plus later ACL/UID proof | no migration; service account access must be tested |
| remote moOde MPD/UPnP/AirPlay/PiBuZ | outbound network/SSH only | no local filesystem grant | compatibility test required before hardening |

The proposed `sonuvi` identity does not exist today. H4B must **not** create
it. Its UID/GID, Caddy traversal rule, CIFS ACL/UID mapping, and any moOde SSH
authorization remain H4C decisions after staging validation.

## C. Credential and protected-state migration design

No credential is inside a release artifact. H4C must inventory each item by
metadata only, confirm source ownership/mode, copy rather than move it, verify
the destination by mode/size/hash without printing values, and leave the legacy
source untouched until rollback acceptance.

| Material | Future destination | Rollback-safe approach |
| --- | --- | --- |
| runtime Track Key and app config | sanitized shared `config/now-playing.config.json` plus `/etc/sonuvi/now-playing.env` | never copy raw config; leave legacy file unchanged |
| Last.fm app/session values | `/etc/sonuvi/lastfm.env` | copy only after explicit approval; no reauthorization/rotation |
| Apple Music private key/developer material | `/etc/sonuvi/<vendor-private-key>` plus root-managed env reference | controlled copy; legacy reference retained |
| APNs provider credentials and push tokens | protected credentials + `protected/mobile-push-tokens.json` | copy metadata-preserving data; do not resend/rotate |
| saved Qobuz queues | `protected/saved-qobuz-queues` | copy directory without format conversion; legacy stays available |
| moOde SSH identity | `/etc/sonuvi/ssh/moode_ed25519` | generate a dedicated key in a separately approved phase; never copy a personal key |
| local backup material | protected/shared backup location | do not copy broadly; choose each integration's rollback need |

The service must not reference private files under `/home/<operator>` once
`ProtectHome=true` is enabled. A missing optional credential disables only its
integration; a missing required credential fails the preflight rather than
starting a partially functional privileged service.

The root-managed SSH profile is preparatory only. Until a separately approved
restricted remote-command protocol and remote authorization exist, immutable
runtime code rejects raw SSH/SCP transport rather than assuming that a local
capability label makes a broad remote shell safe. This does not change legacy
checkout behavior.

## D. Runtime-state coverage and remaining external writes

With `SONUVI_STATE_ROOT` enabled, normal Sonuvi-owned writes are outside the
release: catalog/indexes, source-audio records, histories, profiles, controller
settings, push tokens, Qobuz queues, Vibe scratch/index/logs, radio caches,
animated-art cache, podcast maps/logs, and future audio-quality checkpoints.

H4A.1 additionally corrected two paths that could have escaped this boundary:

- Peppy exports now resolve through `runtimeStatePaths().peppyExportDir`.
- MPD sticker backups resolve to `shared/protected/sticker-backups` in shared
  mode and reject a relative backup override. Legacy mode keeps its historical
  private-home default.

Immutable mode also refuses a missing shared podcast subscription map instead
of reading the legacy private-home fallback. The stale legacy Vibe index
fallback is already disabled when shared state is enabled.

The remaining writes are intentionally **external**, not release writes:

1. remote moOde MPD playlists, stickers, and cover paths reached over SSH;
2. podcast downloads and optional music/tag maintenance under the configured
   music/podcast root; and
3. private `/tmp` scratch files used by image/library operations, isolated by
   `PrivateTmp=true`.

The candidate API unit deliberately blocks the music-mount write category
until a later scoped compatibility decision. No release-owned path is writable
in normal immutable operation.

### Podcast retention boundary

The first migration preserves downloaded podcast media, associated artwork,
and uncertain legacy backup material **in place**. It does not copy, move,
prune, or delete them. Subscriptions, playback progress, preferences, and
authoritative bookkeeping require a separately approved final snapshot after
their writers are quiesced; confirmed disposable logs and derived caches may be
regenerated. Preserving media in place does not establish that a future service
can access it: any mount, access, or media migration decision remains a
separate approval.

### Rehearsal containment boundary

A rehearsal process uses a startup boundary before legacy route modules load:
direct child-process launches and network fetches are denied, and filesystem
writes must remain below a pre-created, non-symlinked disposable rehearsal
root. This is application-level defense in depth only. H4C.4 must still use a
network-denied transient unit with no production credentials, personal-home,
legacy-state, or CIFS access.

## E. Paired API/web activation and Caddy gate

The old fixture transaction switched `current` without a systemd-compatible
service boundary. H4A.1 now uses this state machine:

```text
verify candidate + previous + shared state
  -> remove public-traffic-open sentinel
  -> prepare adapter while Caddy returns 503
  -> atomically switch current symlink
  -> restart API and web from current
  -> compare API /health release ID and web /release.json release ID
  -> run both health checks
  -> open non-secret traffic sentinel
  -> commit
```

On a failure it removes the sentinel, restores the previous pointer, invokes
the rollback adapter, independently verifies and health-checks both previous
services, and only then reopens traffic. If rollback or verification fails,
the sentinel stays absent and state becomes `manual-recovery-required`.
Interrupted recovery can restore a verified previous release even if the
candidate artifact is corrupt; it never deletes the candidate or shared data.

The candidate Caddyfile preserves `sonuvi.local`, current API/web ports,
WebSocket-capable reverse-proxy behavior, PWA paths, and the H2 public-root
boundary. Its API matcher mirrors the legacy public route family plus
`/health`; it does not turn into a catch-all or add stale `/_debug` and
previously unproxied `/integrations` paths. Its public `/health` result
contains only immutable `mode` and `releaseId`; it no longer exposes a
manifest filesystem path.

The first transition from the legacy checkout remains a separate H4C design:
the generic transaction requires a retained immutable previous release. H4B
does not activate anything. A later first-cutover adapter must explicitly keep
the legacy unit/checkout available and prove a restartable legacy fallback;
the H4A.1 sentinel prevents public mixed-version traffic but does not claim
that first-cutover proof yet.

## F. H4B non-activating provisioning manifest — do not run in H4A.1

H4B should stage one verified release and nothing else. It must not create
`current`, shared runtime state, `/etc/sonuvi`, a service account, a Caddy
configuration, or a systemd unit.

| Step | Proposed elevated operation | Preconditions / postcondition | Reversible behavior |
| --- | --- | --- | --- |
| 1 | `sudo install -d -o root -g root -m 0755 /opt/sonuvi` | `/opt` is ext4/rw with at least 512 MiB reserve | empty directory can remain; no legacy path touched |
| 2 | `sudo install -d -o root -g root -m 0700 /opt/sonuvi/.staging` | step 1 | contains only a named candidate |
| 3 | `sudo install -d -o root -g root -m 0755 /opt/sonuvi/releases` | step 1 | no release deleted/overwritten |
| 4 | stream exact local artifact into `/opt/sonuvi/.staging/<release-id>` | manifest source is independently verified; destination ID absent | failed transfer stays a candidate; do not delete automatically |
| 5 | target runtime/manifest verification | Node/Sharp/commands verify without state or network mutation | stop on any verifier failure |
| 6 | manifest-verified promotion to `releases/<release-id>` | exact immediate `.staging/<id>` child, same ext4 filesystem, no existing ID | leaves immutable candidate; never changes `current` |
| 7 | repeat target verification from `releases/<id>` | release tree is `root:root` read-only | candidate remains for later review |

Exact H4B command forms, with shell variables replaced only after a separate
approval and final manifest review:

```sh
PI5_HOST=server.example.invalid
PI5_USER=service-operator
PI5_KNOWN_HOSTS=$(mktemp)
ssh-keyscan -T 5 -t ed25519 "$PI5_HOST" > "$PI5_KNOWN_HOSTS"
ssh-keygen -lf "$PI5_KNOWN_HOSTS" -E sha256
# Stop unless the preceding fingerprint is exactly:
# SHA256:LwD4pGw66x6y4vqInIGiW8rN+1uebXkhG9PsinsVnQ4

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo install -d -o root -g root -m 0755 /opt/sonuvi"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo install -d -o root -g root -m 0700 /opt/sonuvi/.staging"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo install -d -o root -g root -m 0755 /opt/sonuvi/releases"

# LOCAL_ARTIFACT is the verified clean release directory; RELEASE_ID comes from
# its verified manifest. No rsync, --delete, current symlink, or service call.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" \
  "$PI5_USER@$PI5_HOST" "sudo install -d -o root -g root -m 0700 /opt/sonuvi/.staging/$RELEASE_ID"
tar -C "$LOCAL_ARTIFACT" -cf - . | \
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" \
    "$PI5_USER@$PI5_HOST" "sudo tar --no-same-owner --no-same-permissions -C /opt/sonuvi/.staging/$RELEASE_ID -xpf -"

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo /usr/bin/node /opt/sonuvi/.staging/$RELEASE_ID/scripts/verify-release-runtime.mjs --release-root /opt/sonuvi/.staging/$RELEASE_ID"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo /usr/bin/node /opt/sonuvi/.staging/$RELEASE_ID/scripts/promote-staged-release.mjs --layout-root /opt/sonuvi --staging-root /opt/sonuvi/.staging/$RELEASE_ID"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PI5_KNOWN_HOSTS" "$PI5_USER@$PI5_HOST" \
  "sudo /usr/bin/node /opt/sonuvi/releases/$RELEASE_ID/scripts/verify-release-runtime.mjs --release-root /opt/sonuvi/releases/$RELEASE_ID"
```

`promote-staged-release.mjs` refuses any layout other than `/opt/sonuvi`,
requires an immediate staging child whose basename matches its manifest release
ID, verifies before and after its atomic rename, makes only that verified
artifact read-only, refuses an existing release ID, and never touches
`current`, `shared`, `/etc`, services, Caddy, or `/opt/now-playing`.

Stop H4B immediately if free space drops below the approved reserve, `/opt`
is not the expected writable filesystem, a target verifier fails, the manifest
is corrupt, the candidate ID already exists, target Node/Sharp compatibility
fails, or any command would need to create shared state or touch a live unit.
Keep a failed candidate for inspection; do not run `rm`, `rsync --delete`,
recursive ownership changes, or a Git operation as recovery.

## G. Verification status

Focused fixtures cover:

- Linux/ARM64 target, later Node 20 patch acceptance, executable presence, and
  non-loopback remote MPD/moOde topology declaration;
- missing config/state, unavailable music path, protected SSH identity mode,
  and no credential-value reads;
- H2 public-root/static boundary and the corrected systemd/Caddy templates;
- staged host promotion, tamper detection, immutable release permissions, and
  no `current` pointer mutation;
- gated paired activation, API/web startup and health failure rollback,
  activation locking, interrupted recovery, corrupt candidate recovery, and
  rollback-failure traffic closure.

Caddy 2.11.2 parsed the candidate file read-only on Pi5. `systemd-analyze
verify` cannot validate a unit via stdin, and H4A.1 cannot write a temporary
unit on Pi5; systemd parser validation is deferred to H4B/H4C after a
candidate-only file exists, before any enable/reload.

## H. Readiness decision

**READY FOR H4B STAGING APPROVAL** — narrowly for the non-activating staging
operation above. The remaining target-side checks are intentionally part of
H4B and are stop conditions, not a basis for activation. H4C still requires a
dedicated service identity, controlled credential/state copies, systemd unit
validation, mount/ACL proof, external-integration testing, live traffic-gate
installation, and a first-cutover legacy rollback adapter.

*Last updated: 2026-10-25 America/Chicago*
