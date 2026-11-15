# Unified configuration candidate runtime correction

The isolated immutable ARM64 package startup check exposed an optional PiBuZ
receiver constructor failure with clean defaults. The adapter now reports
unavailable without a fabricated endpoint or network activity, and guarded
controls remain unavailable. A related TLS maintenance check now accepts only
the root-owned, service-group, sticky 1770 master configuration directory while
rejecting non-sticky or world-writable alternatives. Private key directories
retain their strict checks.

The package starts and restarts as the service user with locally provisioned
fixture TLS. Server regression: 847 passed, 7 skipped; systemd adapter: four
passed in Linux. External services and physical acceptance remain untested.

This documentation-only successor gives the fixed-inventory v2 upgrade kit a
separate immutable release identity from the v1 fresh-install kit. No runtime
source differs between the two candidates. Neither is published or deployed.
