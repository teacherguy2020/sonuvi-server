# Devices inventory — 2026-11-15

Current: authenticated controllers can GET `/v1/mobile/devices` for active approved app and browser grants. Response is `{ok,currentDeviceId,devices:[{deviceId,label,isCurrent}]}`. No credentials, session generation, administrator identity, revoked history, or management authority is exposed. Missing/revoked bearer is rejected. Approval is not online presence.

A device may POST `{label}` to `/v1/mobile/devices/self` to name only its own verified active grant. The registry rechecks the grant under its write lock and preserves approval generation and role. Device deletion and the full administrative inventory remain administrator-only.

New pairing grants retain the proof-bound device name. Browser names are human-readable user-agent descriptions, not authentication evidence. Existing unnamed grants remain visible with stable abbreviated IDs until the device names itself; no identity is guessed.

Browser-hosted pairing challenges add optional `nativeInvitation`/`nativeQRDataUrl` with public local HTTPS trust, when installed. Legacy `qrPayload`/`qrDataUrl` remain unchanged. The browser displays the native invitation; no bearer, refresh token, or display token appears in it. Native approval is still explicit and pending devices cannot read the inventory.

Delivery: source/tests are implemented; live deployment and native UI verification are tracked in the direct task evidence, not implied by this document.
