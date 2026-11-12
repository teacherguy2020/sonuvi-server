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
for executable in ffmpeg ffprobe metaflac curl ssh scp mpc openssl avahi-publish-service avahi-publish-address smbclient mount.cifs; do
  command -v "$executable" >/dev/null 2>&1 || dependencies_ready=false
done
/usr/bin/python3 -c 'import mpd, mutagen, requests' >/dev/null 2>&1 || dependencies_ready=false
if [ "$dependencies_ready" = true ]; then
  /usr/bin/node --version
  exit 0
fi

# Read configured APT sources without changing them or accepting caller input.
# Official Debian cloud images use a local mirror list instead of a direct URI.
# Only the fixed Debian mirror-list path is supported, and every mirror in it
# must be the canonical Debian archive. A lookalike host/path is not sufficient.
if ! /usr/bin/python3 - <<'SONUVI_APT_CHECK'
from pathlib import Path
import re
import shlex
import sys
from urllib.parse import urlsplit

apt_root = Path("/etc/apt")

def official_uri(uri):
    try:
        parsed = urlsplit(uri)
        return (parsed.scheme in ("http", "https")
                and parsed.netloc == "deb.debian.org"
                and parsed.path in ("/debian", "/debian/")
                and not parsed.query and not parsed.fragment)
    except ValueError:
        return False

def supported_uri(uri):
    if official_uri(uri):
        return True
    if uri != "mirror+file:///etc/apt/mirrors/debian.list":
        return False
    try:
        mirrors = [line.split("#", 1)[0].strip() for line in
                   (apt_root / "mirrors/debian.list").read_text().splitlines()]
        mirrors = [line for line in mirrors if line]
        return bool(mirrors) and all(official_uri(line) for line in mirrors)
    except (OSError, UnicodeError):
        return False

def enabled_binary_sources(file):
    text = file.read_text()
    if file.suffix == ".list":
        for line in text.splitlines():
            # APT options precede the URI; never interpret their text as a URI.
            line = re.sub(r"^(\s*deb\s+)\[[^\]]*\]\s*", r"\1", line)
            fields = shlex.split(line, comments=True)
            if len(fields) >= 4 and fields[0] == "deb" and "main" in fields[3:]:
                yield fields[1]
    else:
        fields = {}
        key = None
        for line in text.splitlines() + [""]:
            if line.lstrip().startswith("#"):
                continue
            if not line.strip():
                if (fields.get("enabled", "yes").lower() != "no"
                        and "deb" in fields.get("types", "").split()
                        and "main" in fields.get("components", "").split()
                        and fields.get("suites", "").strip()):
                    yield from fields.get("uris", "").split()
                fields, key = {}, None
            elif line[:1].isspace() and key:
                fields[key] += " " + line.strip()
            elif ":" in line:
                key, value = line.split(":", 1)
                key = key.lower()
                fields[key] = value.strip()
            else:
                raise ValueError("malformed APT stanza")

try:
    files = [apt_root / "sources.list"]
    files += sorted((apt_root / "sources.list.d").glob("*.list"))
    files += sorted((apt_root / "sources.list.d").glob("*.sources"))
    recognized = any(supported_uri(uri) for file in files if file.is_file()
                     for uri in enabled_binary_sources(file))
except (OSError, UnicodeError, ValueError):
    recognized = False
sys.exit(0 if recognized else 1)
SONUVI_APT_CHECK
then
  echo 'official configured Debian repository is required' >&2
  echo 'sonuvi_sftp_bootstrap:debian_repository_unrecognized' >&2
  exit 79
fi

/usr/bin/apt-get update
/usr/bin/apt-get install --yes --no-install-recommends \
  nodejs ffmpeg python3 python3-mpd python3-mutagen python3-requests \
  mpc flac curl openssh-client openssl avahi-daemon avahi-utils cifs-utils smbclient
if ! /usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1);'; then
  echo 'configured Debian repositories do not provide the required Node 20.9+ runtime' >&2
  exit 80
fi
/usr/bin/node --version
/usr/bin/python3 -c 'import mpd, mutagen, requests'
for executable in ffmpeg ffprobe metaflac curl ssh scp mpc openssl avahi-publish-service avahi-publish-address smbclient mount.cifs; do
  command -v "$executable" >/dev/null 2>&1 || { echo "required executable is unavailable: $executable" >&2; exit 83; }
done
