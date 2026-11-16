# Public installer distribution

The signed first-install package is published as a GitHub prerelease, with a
fixed public URL consumed by the updated native installer. It no longer needs
the maintainer LAN download endpoint. Existing installed LAN-bound clients need
an app update. The existing-upgrade v2 package is separate and remains LAN-bound.

New public first-install packages use explicitly signed `expiresAt: null`: no
installation deadline or monthly renewal. Legacy dated packages remain immutable
and retain their original policy. Authentication/pairing lifetimes are unchanged.

Canonical instructions and validation boundaries:
[Public iOS-guided installation](../runbooks/public-ios-installer.md).

Updated: 2026-11-15
