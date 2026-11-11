# Native Server configuration parity — 2026-11-11

Status labels: **existing** = present at the accepted source baseline; **implemented** = new source and automated checks, not installed/accepted on the VM; **host-managed** = intentionally not a portable settings write; **blocked** = actual live acceptance cannot proceed.

| Web configuration reference | Native baseline | Current source / boundary |
|---|---|---|
| Server access / Track Key | Separate first-admin proof/session | Preserved; browser Track Key is never promoted to native admin authority. Current Simulator's original-enrollment mismatch blocks VM admin reads and writes. |
| API host, API/UI ports | Not editable | Host-managed with explicit explanation; not imported/exported. Listener/TLS/network identity audit is separate and read-only. |
| MPD host/port; moOde SSH host/user/base URL | Nine-field PATCH supports these and four media paths | Implemented schema-driven native controls, effective/saved values, read-only environment overrides, preview/apply and shared sanitizer/merge/validation/atomic writer. Empty moOde URL retains the existing derived-address behavior. |
| Music root, moOde USB mount, Server mount | Existing path fields, no source management | Native controls preserved and expanded with host-path warnings. No fabricated multi-source registry; the Server reads one configured MPD/moOde catalog. Mount creation/credentials/permissions stay host-managed. |
| Podcasts enable/root; nightly job help | Read-only feature flag plus editable path | Native enable/root controls implemented; scheduling/root/mount creation remain host-managed. Transfer excludes subscription metadata, media and download jobs. |
| Pairing approval | Existing native pairing flow | Existing flow preserved; ordinary controller access remains separate from Server administration. |
| Qobuz account status / release renderer | No native admin configuration workflow | Account linking remains disabled/host-managed as on the reference. Renderer-session release is playback maintenance, not configuration transfer; not added. |
| Radio artwork feature | Read-only flag | Native toggle implemented. No claim of browser playback mutation parity. |
| moOde display enhancement | Missing | Native feature toggle implemented; host display dependencies remain required. |
| Idle display branding | Missing | Brand/message native fields implemented. |
| Last.fm scrobbling credentials / status | Read-only feature flag | Feature, username, recent-row toggle/mode implemented; credentials/account authorization remain host-managed and excluded from transfer. No automatic account migration. |
| Alexa enable/domain | Missing | Native enable/domain implemented, with environment override protection. Webhook secrets and separate correction/alias maintenance UI are not transferred or newly exposed. |
| Ratings enable; sticker backup/restore | Read-only flag | Native feature toggle implemented. Remote sticker DB backup/restore is separate host maintenance and not a Server JSON backup. |
| Track notifications monitor/poll/dedupe/max-age | Missing | Native controls implemented with boolean/integer/range validation and effective environment overrides. APNs/Pushover credentials remain host-managed. |
| Album personnel / About fallback | Read-only flag | Native toggles implemented. Host tooling dependencies are unchanged. |
| Animated motion preference | Browser-local | Remains browser-local; not falsely exported as Server configuration or synchronized with native appearance. |
| Advanced raw JSON | Disabled in web reference | Remains unavailable. New portable JSON uses a strict versioned allowlist, not arbitrary raw config writes. |
| Reload / Save | Limited native reload and nine-field save | New readback, preview/apply, stale-state rejection and selected-Server binding implemented. Old native editor retained for Servers lacking the new workspace API. |
| Restart services | Web supports only existing operator-provisioned service policy | No privilege escalation or listener change. Native explains paired service restart requirement; automatic restart remains unsupported by this increment. |
| Library Health scan / Sonuvi browse indexing | Status only | Native refresh-index and health-scan operations use existing Server functions, serialized jobs and status; no moOde media/tag/sticker writes. |
| Update moOde library / tag-art-rating maintenance | Not exposed | Still separate remote maintenance, not configuration transfer. No production/moOde mutation performed. |
| Sonuvi DLNA MediaServer | Status decoder could reject a running service | Corrected `running` → native `enabled` projection; native preference and actual runtime status distinguish environment-controlled state, startup failure and restart requirement. Interface/port remain host-managed. |
| Portable configuration export/import | Missing in native | Implemented configuration-only version1 JSON, strict validation, per-field change/skip preview, target binding, stale preview rejection, readback and preservation of destination identity/credentials. Actual Pi5 export succeeded read-only; actual VM import remains blocked. |
| Secure discoverable controller URL | VM-specific8443 URL, no installation discovery contract | Audit documented; native architecture explicitly avoids guessing ports or copying network/TLS identity. Discovery/443/name/certificate renewal are not implemented by this assignment. |

## Actual VM results

- Read-only HTTPS and deployment audit: completed. API3101 is loopback;8443 rejects wrong Host; admin and raw runtime-admin routes are not forwarded.
- Native administrator proof: **FAILED/BLOCKED** with `administrator_session_identity_mismatch`; current Simulator public key and device identity differ from the preserved enrollment created2026-11-08. No enrollment replacement, identity reset or administrator bypass performed. The November 8 installation history records the physical iPad installed the current VM after the Simulator tests; the Simulator retained earlier-installation credentials. No lost-key conclusion is supported. Live acceptance should use the iPad’s existing enrolled identity; see administrator-provenance.md in the task evidence.
- Production Pi5 configuration export: **PASS**,28 allowlisted settings validated, config SHA256 unchanged across the read. No writes, installs or restarts.
- VM configuration import, live read/write round trip, Server-restart persistence and iOS-restart persistence: **NOT RUN**, blocked by administrator authorization. New Server code is not deployed to the VM.
- Actual new native form interaction against VM: **NOT ACCEPTED**. A compiled SwiftUI control and passing fixtures are not evidence of a successful VM save.
- Safari preferred per Brian. Safari Apple-event access was approved; automated DOM access additionally reports JavaScript-from-Apple-Events disabled. No Chrome launched, trust settings changed, or browser success fabricated.

## Authorized physical-device continuation

On 2026-11-11 Brian approved an in-place update of the enrolled iPad and live VM tests, then explicitly requested iPhone deployment too. The physical iPad completed the normal administrator proof and configuration read against release 91e195bd using its existing device-only key. The previous Simulator mismatch remains a Simulator limitation, not a missing iPad key. Configuration-source delivery and live mutation/restart checks are the next steps; this source checkpoint does not claim those results. Production remains read-only.
