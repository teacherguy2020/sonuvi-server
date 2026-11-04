#!/bin/sh
# Fixed first-stage bootstrap for a prepared Debian ARM64 target. This file
# accepts no arguments, edits no APT source, and installs only Debian nodejs.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'explicit root authorization is required' >&2
  exit 77
fi
if [ ! -r /etc/debian_version ] || ! -x /usr/bin/apt-get ]; then
  echo 'supported Debian APT environment is required' >&2
  exit 78
fi
if [ -x /usr/bin/node ] && /usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1);'; then
  /usr/bin/node --version
  exit 0
fi
# Fail closed unless a configured official Debian repository is present. The
# script intentionally does not add repositories or accept a caller URL.
if ! grep -RhsE '^(deb[[:space:]]+https?://deb\.debian\.org/debian[[:space:]]+[^[:space:]]+[[:space:]].*\bmain\b|[[:space:]]*URIs:[[:space:]]+https?://deb\.debian\.org/debian)' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | grep -q .; then
  echo 'official configured Debian repository is required' >&2
  exit 79
fi

/usr/bin/apt-get update
/usr/bin/apt-get install --yes --no-install-recommends nodejs
/usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 9)) process.exit(80); process.stdout.write(`Node ${process.versions.node} verified\n`);'
