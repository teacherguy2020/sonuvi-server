# Public iOS-guided server installation

## Current — 2026-11-17

The signed first-install package is available from the public [GitHub prerelease](https://github.com/teacherguy2020/sonuvi-server/releases/tag/server-installer-2026.11.17-no-deadline-8f9324e7). The updated iOS production installer retrieves it over normal public HTTPS, without GitHub credentials or access to the maintainer's LAN. Older LAN-bound app binaries must be updated; this is not an App Store or TestFlight release.

### Installation

1. Prepare a clean supported Debian 13 ARM64 machine with SSH, administrator/sudo access, and internet connectivity. The phone/tablet must be able to reach that machine. The package does not create the operating system.
2. Use a Sonuvi iOS build containing the public GitHub installer transport. Open guided server setup, enter the host and SSH login, and verify its SSH host key.
3. Start installation. The app downloads the fixed signed package, verifies its signer, signed non-expiring policy, exact hashes and lengths, and transfers the verified artifacts over pinned SSH. It then guides server ownership, controller pairing and music setup.
4. Configure the external player and library. Optional Remote Access can be set up later. New installations create their own identities and credentials; maintainer state is not included.

This preview is not an AMD64, Docker, standalone terminal, or existing-server upgrade installer. Do not extract its archive over an existing server. Do not use GitHub's automatic **Source code** archives as installation packages.

### Trust and lifecycle

Release ID: `sonuvi-8f9324e7adb529e6c7c31bef03e687e7f35754cdc7608be29414dbb60f79229b`, source `925d7f4855045d87432f74361553c2e7621ba8d7`. The eight assets reuse the exact verified signed Server release already deployed to the Pi5, with a refreshed public guide/checksum inventory. The prior publications are not overwritten. The package includes music-only album listings, configured idle-display branding, Safari configuration layout and theme-token corrections. Historical `lab` names and handoff markers are retained provenance, not a requirement to reach a laboratory download server.

The app accepts only the fixed GitHub release path and HTTPS release-CDN redirects. GitHub transport uses system certificate trust; the independently compiled Ed25519 signer and release/manifest/archive/bootstrap/envelope pins still authenticate the installer. The target's SSH host-key and server pairing protections are unchanged. Existing-upgrade v2 distribution remains separate and LAN-bound; it is not represented as public-ready.

**The current public installer has no expiration deadline.** Its signed metadata uses `expiresAt: null`; monthly renewal is not required. The original `server-installer-2026.11.15-d43214c4` publication is historical, immutable, and retains its December 15 expiry. Older app binaries must be updated to use the new package.

### Verification

From this repository with Node 20 or newer:

```sh
node scripts/verify-public-installer.mjs
```

This downloads all eight files anonymously, checks the independently pinned signer, signature, explicit no-deadline policy (including future-date checks), checksums, and compiled package identities, then removes only its temporary downloads. It never connects to a Sonuvi installation target. The **Public installer downloads** GitHub Actions workflow runs the same proof on an external Ubuntu runner.

The Apple repository has an opt-in production-path network test (`SONUVI_PUBLIC_INSTALLER_NETWORK_TEST=1`) and deterministic URL/redirect/factory regressions. Download verification is not a complete clean-machine installation. Exact-package clean-target installation, reboot and optional companion acceptance remain tracked in [server #9](https://github.com/teacherguy2020/sonuvi-server/issues/9) and [iOS #9](https://github.com/teacherguy2020/sonuvi-ios/issues/9).

## Non-expiring release policy — 2026-11-15

Brian explicitly requested “no deadline.” New public first-install envelopes use
`expiresAt: null`, signed as part of the descriptor. This is no deadline, not a
far-future timestamp or a verifier bypass. Legacy dated envelopes retain their
original expiry. Missing or malformed policy fields and unsigned edits fail
closed. Signature, signer pin, package/manifest/bootstrap hashes, byte counts,
SSH host verification and ownership checks remain mandatory. Pairing/login
expiry is unrelated and unchanged. Old installed apps require an app update.
The separate existing-install v2 LAN distribution is not republished here.

## Current Server snapshot — 2026-11-17

The immutable November 15 no-deadline release remains valid but is superseded
for new installs by the November 17 package above. The new app must update its
release URL, artifact/manifest/bootstrap/envelope pins and independent ownership
compatibility binding together. Old app binaries continue to retrieve only
their own reviewed historical release; no verifier bypass or silent substitution.

The package contains Server code, not the maintainer’s installed settings. Fresh
installations configure their own player, library, DLNA interface and optional
remote access. The running Pi5 is not reinstalled or restarted by publication.
