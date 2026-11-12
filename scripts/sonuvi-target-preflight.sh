#!/bin/sh
# Read-only, fixed Gate C target preflight.  It intentionally returns a
# derived machine identity rather than /etc/machine-id itself.  The privileged
# stage and activation helpers recompute it before changing any target state.
set -eu

fail() {
  echo "sonuvi_target_preflight:$1" >&2
  exit "${2:-1}"
}

[ "$#" -eq 0 ] || fail invalid_arguments 64
[ -r /etc/machine-id ] || fail target_machine_identity_unavailable 81
command -v sha256sum >/dev/null 2>&1 || fail target_identity_hash_unavailable 81

machine_id="$(tr -d '\r\n' </etc/machine-id)"
case "$machine_id" in
  *[!0123456789abcdef]*|'') fail target_machine_identity_invalid 81 ;;
esac
[ "${#machine_id}" -eq 32 ] || fail target_machine_identity_invalid 81
identity_hash="$(printf 'sonuvi.gate-c.target.v1:%s' "$machine_id" | sha256sum | awk '{print $1}')"
case "$identity_hash" in
  *[!0123456789abcdef]*|'') fail target_identity_hash_invalid 81 ;;
esac
[ "${#identity_hash}" -eq 64 ] || fail target_identity_hash_invalid 81

os=unsupported
if [ -r /etc/os-release ] && grep -Eq '^ID="?debian"?$' /etc/os-release; then os=debian; fi
machine="$(uname -m 2>/dev/null || true)"
case "$machine" in
  aarch64|arm64) architecture=arm64 ;;
  *) architecture=unsupported ;;
esac
systemd=false
[ -x /usr/bin/systemctl ] && systemd=true
supported=false
[ "$os" = debian ] && [ "$architecture" = arm64 ] && [ "$systemd" = true ] && supported=true

printf '{"contract":"sonuvi.gate-c-target-preflight.v1","operation":"target_preflight","targetIdentity":{"contract":"sonuvi.gate-c-target-identity.v1","algorithm":"sha256-machine-id","value":"sonuvi-target-v1-%s"},"compatibility":{"os":"%s","architecture":"%s","systemd":%s,"supported":%s}}\n' \
  "$identity_hash" "$os" "$architecture" "$systemd" "$supported"
