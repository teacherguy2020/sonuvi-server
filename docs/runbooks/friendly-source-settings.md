# Source-first settings and browser account controls

2026-11-12 follow-up to Brian's fresh-Server acceptance testing.

## User-facing contract

- An installed, managed SMB music source is presented by its actual share name
  and player host. `/var/lib/sonuvi/music` is an internal mount, not a drive name.
- The authenticated configuration and workspace responses optionally include
  `musicSource`. Older/unmanaged Servers omit it. It is not portable settings,
  public runtime configuration, a credential, or evidence of current mount health.
- The description is read from root-owned, non-group/world-writable regular
  `config/music-setup.json`, bounded to 64 KiB. Missing, unsafe, unfinished, or
  invalid state produces no source description. The returned fields are an
  explicit allowlist, and must match the effective selected music root.
- Native clients show the source and access mode first. Podcast paths beneath
  that mount are displayed as drive → folder. Unrelated paths are never attributed
  to the drive. Internal paths belong under Technical details. Inactive saved
  empty-library placeholders are not the primary presentation.
- Safari account/device actions live in Settings → Account and devices on both
  phone and tablet, including embedded tablet Settings. Playback pages never
  append floating account buttons. Server-side administrator, CSRF, and session
  checks are unchanged. Sign out reloads the containing shell.

## Delivery scope

Brian requested the storage-label correction and moving the browser controls
into Settings in the existing direct conversation. Delivery targets the current
fresh test Server at 10.0.0.35 and his already-authorized iPad/iPhone candidates.
No media, moOde settings, credentials, session reset, or preserved VM changes.
Use a reviewed immutable artifact and existing signed in-place upgrade; never
edit the active release. Keep the separately configured `https://sonuvi.local`
browser endpoint and unique native TLS origin intact.

The friendly browser endpoint is an operator configuration on this test Server,
not an assertion that future fresh installers now configure it automatically.
Private `.local` browser HTTPS requires explicit OS certificate trust.
