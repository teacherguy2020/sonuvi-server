#!/bin/sh
# Fixed v1 companion for the native SFTP bootstrap operation. It is sent only
# by the reviewed native client over a pinned SSH session after that client
# verifies the signed release envelope and the kit digest. It accepts no path,
# command, package, repository, URL, or service input.
set -eu

fail() {
  echo "sonuvi_sftp_bootstrap:$1" >&2
  exit "${2:-1}"
}

[ "$#" -eq 2 ] || fail invalid_arguments 64
expected_sha256="$1"
expected_bytes="$2"
case "$expected_sha256" in
  *[!0123456789abcdef]*) fail invalid_digest 64 ;;
esac
[ "${#expected_sha256}" -eq 64 ] || fail invalid_digest 64
case "$expected_bytes" in
  ''|*[!0123456789]*) fail invalid_size 64 ;;
esac
[ "${#expected_bytes}" -le 8 ] || fail invalid_size 64
[ "$expected_bytes" -gt 0 ] && [ "$expected_bytes" -le 16777216 ] || fail invalid_size 64
[ "$(id -u)" -eq 0 ] || fail root_authorization_required 77
[ -n "${SUDO_USER:-}" ] || fail sudo_user_required 77
case "$SUDO_USER" in
  *[!A-Za-z0-9_-]*|'') fail sudo_user_invalid 77 ;;
esac

user_uid="$(id -u "$SUDO_USER")" || fail sudo_user_unknown 77
home_from_passwd="$(getent passwd "$SUDO_USER" | cut -d: -f6 | head -n 1)"
case "$home_from_passwd" in
  /*) ;;
  *) fail sudo_user_home_invalid 77 ;;
esac
home_directory="$(cd -P -- "$home_from_passwd" 2>/dev/null && pwd -P)" || fail sudo_user_home_invalid 77

assert_user_directory() {
  candidate="$1"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || fail staging_directory_invalid 65
  [ "$(stat -c %u -- "$candidate")" = "$user_uid" ] || fail staging_owner_invalid 65
  [ "$(stat -c %a -- "$candidate")" = 700 ] || fail staging_mode_invalid 65
}

staging_root="$home_directory/.local"
assert_user_directory "$staging_root"
assert_user_directory "$staging_root/share"
assert_user_directory "$staging_root/share/sonuvi-bootstrap-v1"
source_archive="$staging_root/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar"
[ -f "$source_archive" ] && [ ! -L "$source_archive" ] || fail staged_kit_missing 66
[ "$(stat -c %u -- "$source_archive")" = "$user_uid" ] || fail staged_kit_owner_invalid 66
[ "$(stat -c %a -- "$source_archive")" = 600 ] || fail staged_kit_mode_invalid 66
[ "$(stat -c %s -- "$source_archive")" = "$expected_bytes" ] || fail staged_kit_size_invalid 66

base_root=/var/lib/sonuvi-bootstrap
if [ -e "$base_root" ]; then
  [ -d "$base_root" ] && [ ! -L "$base_root" ] || fail root_staging_invalid 67
else
  install -d -o root -g root -m 700 "$base_root"
fi
available_kib="$(df -Pk "$base_root" | awk 'NR == 2 { print $4; exit }')"
case "$available_kib" in
  ''|*[!0123456789]*) fail root_staging_capacity_unavailable 67 ;;
esac
required_kib=$(( (expected_bytes * 2 + 16777216 + 1023) / 1024 ))
[ "$available_kib" -ge "$required_kib" ] || fail root_staging_capacity_insufficient 67

kit_root="$base_root/bootstrap-kit-v1"
marker="$kit_root/.sonuvi-bootstrap-kit-v1.sha256"
if [ -e "$kit_root" ]; then
  [ -d "$kit_root" ] && [ ! -L "$kit_root" ] && [ -f "$marker" ] && [ ! -L "$marker" ] || fail bootstrap_kit_recovery_required 68
  [ "$(cat "$marker")" = "$expected_sha256" ] || fail bootstrap_kit_conflict 68
  [ -f "$kit_root/scripts/sonuvi-debian-node-bootstrap.sh" ] && [ ! -L "$kit_root/scripts/sonuvi-debian-node-bootstrap.sh" ] || fail bootstrap_kit_recovery_required 68
  exec /bin/sh "$kit_root/scripts/sonuvi-debian-node-bootstrap.sh" install
fi

umask 077
incoming_archive="$(mktemp "$base_root/.bootstrap-kit-v1.XXXXXXXX")" || fail root_staging_create_failed 67
temporary_root="$(mktemp -d "$base_root/.bootstrap-kit-v1.XXXXXXXX")" || { rm -f "$incoming_archive"; fail root_staging_create_failed 67; }
cleanup() {
  rm -f "$incoming_archive"
  [ -z "$temporary_root" ] || rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

# GNU coreutils dd with nofollow prevents a staged symlink from being opened by
# root. The bytes are then hashed only after they reside in a root-owned file.
dd if="$source_archive" of="$incoming_archive" bs=65536 iflag=fullblock,nofollow status=none || fail staged_kit_copy_failed 66
[ "$(stat -c %s -- "$incoming_archive")" = "$expected_bytes" ] || fail staged_kit_size_invalid 66
observed_sha256="$(sha256sum "$incoming_archive" | awk '{print $1}')"
[ "$observed_sha256" = "$expected_sha256" ] || fail staged_kit_digest_invalid 66

tar --extract --file "$incoming_archive" --directory "$temporary_root" --no-same-owner --no-same-permissions --delay-directory-restore || fail bootstrap_kit_extract_failed 69
if find "$temporary_root" ! -type d ! -type f -print -quit | grep -q .; then
  fail bootstrap_kit_entry_type_invalid 69
fi
expected_tree='.
./bootstrap-kit-manifest.json
./etc
./etc/sonuvi
./etc/sonuvi/release-trust-anchors.json
./scripts
./scripts/sonuvi-debian-node-bootstrap.sh
./scripts/sonuvi-release-stage.mjs
./src
./src/lib
./src/lib/public-web-root.mjs
./src/lib/release-artifact.mjs
./src/lib/sonuvi-gate-c-release.mjs
./src/lib/sonuvi-gate-c-staging.mjs'
observed_tree="$(cd "$temporary_root" && find . -print | LC_ALL=C sort)"
[ "$observed_tree" = "$expected_tree" ] || fail bootstrap_kit_entries_invalid 69
chown -R root:root "$temporary_root"
find "$temporary_root" -type d -exec chmod 700 {} \;
find "$temporary_root" -type f -exec chmod 600 {} \;
printf '%s\n' "$expected_sha256" > "$temporary_root/.sonuvi-bootstrap-kit-v1.sha256"
chmod 600 "$temporary_root/.sonuvi-bootstrap-kit-v1.sha256"
mv "$temporary_root" "$kit_root"
temporary_root=''

exec /bin/sh "$kit_root/scripts/sonuvi-debian-node-bootstrap.sh" install
