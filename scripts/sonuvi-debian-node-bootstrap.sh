#!/bin/sh
# Fixed first-stage bootstrap for a prepared Debian ARM64 target. It accepts
# only `preflight` (read-only) and `install` (the default) and never accepts a
# repository, package name, URL, path, or command from the SSH client.
set -eu

operation="${1:-install}"
if [ "$#" -gt 1 ] || { [ "$operation" != "preflight" ] && [ "$operation" != "install" ]; }; then
  echo 'only preflight or install is supported' >&2
  exit 76
fi

if [ "$(id -u)" -ne 0 ]; then
  echo 'explicit root authorization is required' >&2
  exit 77
fi
if [ ! -r /etc/debian_version ] || [ ! -x /usr/bin/apt-get ]; then
  echo 'supported Debian APT environment is required' >&2
  exit 78
fi

machine_id="$(tr -d '\n' </etc/machine-id 2>/dev/null || true)"
case "$machine_id" in
  *[!A-Za-z0-9_-]*|'')
    echo 'stable machine identity is required' >&2
    exit 81
    ;;
esac
machine="$(uname -m)"
case "$machine" in
  aarch64|arm64) architecture="arm64" ;;
  *) architecture="unsupported" ;;
esac
systemd=false
[ -x /usr/bin/systemctl ] && systemd=true
node_state=missing
node_version=""
if [ -x /usr/bin/node ]; then
  node_version="$(/usr/bin/node --version 2>/dev/null || true)"
  if /usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1);'; then
    node_state=compatible
  else
    node_state=incompatible
  fi
fi

if [ "$operation" = "preflight" ]; then
  printf '{"contract":"sonuvi.debian-bootstrap-preflight.v1","machineIdentity":"%s","architecture":"%s","systemd":%s,"node":{"state":"%s","version":%s}}\n' \
    "$machine_id" "$architecture" "$systemd" "$node_state" \
    "$(if [ -n "$node_version" ]; then printf '"%s"' "$node_version"; else printf 'null'; fi)"
  exit 0
fi

if [ "$architecture" != "arm64" ] || [ "$systemd" != true ]; then
  echo 'supported Debian ARM64 systemd host is required' >&2
  exit 82
fi

dependencies_ready=true
[ "$node_state" = compatible ] || dependencies_ready=false
for executable in ffmpeg ffprobe metaflac curl ssh scp mpc openssl avahi-publish-service avahi-publish-address; do
  command -v "$executable" >/dev/null 2>&1 || dependencies_ready=false
done
/usr/bin/python3 -c 'import mpd, mutagen, requests' >/dev/null 2>&1 || dependencies_ready=false
if [ "$dependencies_ready" = true ]; then
  /usr/bin/node --version
  exit 0
fi

# Fail closed unless a configured official Debian repository is present. The
# script intentionally does not add repositories or accept a caller URL. Both
# canonical APT URI spellings are valid: Debian's installer commonly writes a
# trailing slash, while other tools omit it.
official_debian_repository_pattern='^(deb[[:space:]]+https?://deb\.debian\.org/debian/?[[:space:]]+[^[:space:]]+[[:space:]].*\bmain\b|[[:space:]]*URIs:[[:space:]]+https?://deb\.debian\.org/debian/?)'
if ! grep -RhsE "$official_debian_repository_pattern" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | grep -q .; then
  echo 'official configured Debian repository is required' >&2
  echo 'sonuvi_sftp_bootstrap:debian_repository_unrecognized' >&2
  exit 79
fi

/usr/bin/apt-get update
/usr/bin/apt-get install --yes --no-install-recommends \
  nodejs ffmpeg python3 python3-mpd python3-mutagen python3-requests \
  mpc flac curl openssh-client openssl avahi-daemon avahi-utils
if ! /usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1);'; then
  echo 'configured Debian repositories do not provide the required Node 20.9+ runtime' >&2
  exit 80
fi
/usr/bin/node --version
/usr/bin/python3 -c 'import mpd, mutagen, requests'
for executable in ffmpeg ffprobe metaflac curl ssh scp mpc openssl avahi-publish-service avahi-publish-address; do
  command -v "$executable" >/dev/null 2>&1 || { echo "required executable is unavailable: $executable" >&2; exit 83; }
done
