#!/usr/bin/env bash
# Independent OpenSSH-client acceptance of the disposable Gate C SFTP fixture.
# Every file created here is private scratch data and removed on exit.
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_control="$repo_root/scripts/sonuvi-gate-c-sftp-fixture.sh"
readonly fixture_dir='/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-sftp-fixture-20261105'
readonly host='127.0.0.1'
readonly port='2224'
readonly account='sonuvi-sftp'
readonly expected_host_fingerprint='SHA256:e7tqr4fD34QF8ExnSLuNtuAMnpslx52KeikKaL4nwSg'
readonly host_key="$fixture_dir/ssh_host_ed25519_key"
readonly host_key_public="$host_key.pub"
readonly client_key="$fixture_dir/client_ed25519"

fail() {
  echo "verify_sonuvi_gate_c_sftp_fixture:$1" >&2
  exit "${2:-1}"
}

scratch_dir="$(mktemp -d /tmp/sonuvi-gate-c-sftp-fixture.XXXXXX)"
cleanup() {
  "$fixture_control" reset >/dev/null 2>&1 || true
  rm -rf "$scratch_dir"
}
trap cleanup EXIT HUP INT TERM

[ -f "$host_key" ] && [ -f "$host_key_public" ] && [ -f "$client_key" ] || fail fixture_credential_missing 64
observed_fingerprint="$(ssh-keygen -lf "$host_key_public" -E sha256 | awk '{print $2}')"
[ "$observed_fingerprint" = "$expected_host_fingerprint" ] || fail fixture_host_fingerprint_changed 65

awk '{print "[127.0.0.1]:2224 " $1 " " $2}' "$host_key_public" > "$scratch_dir/known_hosts"
dd if=/dev/zero of="$scratch_dir/bootstrap-kit.bin" bs=1024 count=256 status=none
dd if=/dev/zero of="$scratch_dir/partial.bin" bs=1024 count=64 status=none

sftp_run() {
  sftp -q -b - \
    -P "$port" \
    -i "$client_key" \
    -o "UserKnownHostsFile=$scratch_dir/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    "$account@$host"
}

mkdir_tree() {
  sftp_run <<'SFTP'
mkdir .local
chmod 0700 .local
mkdir .local/share
chmod 0700 .local/share
mkdir .local/share/sonuvi-bootstrap-v1
chmod 0700 .local/share/sonuvi-bootstrap-v1
SFTP
}

"$fixture_control" reset >/dev/null
mkdir_tree
staging_listing="$(sftp_run <<'SFTP'
ls -lna .
ls -lna .local
ls -lna .local/share
SFTP
)"
staging_directory_count="$(printf '%s\n' "$staging_listing" | grep -Ec '^drwx------[[:space:]]+\?[[:space:]]+12001[[:space:]]+12001')"
[ "$staging_directory_count" -ge 3 ] || fail fixture_staging_ownership_invalid 66

# A public-key-only SSH request reaches the forced SFTP command. It exits 1
# because a shell is intentionally forbidden, but proves authentication.
set +e
ssh -o "UserKnownHostsFile=$scratch_dir/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null \
  -o StrictHostKeyChecking=yes \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -i "$client_key" -p "$port" "$account@$host" true >"$scratch_dir/ssh.out" 2>"$scratch_dir/ssh.err"
shell_rc=$?
set -e
[ "$shell_rc" -eq 1 ] || fail fixture_shell_not_refused 66
grep -q 'This service allows sftp connections only' "$scratch_dir/ssh.out" "$scratch_dir/ssh.err" || fail fixture_authentication_not_confirmed 66

# A known-hosts entry made from a different public key must fail before SFTP
# authentication, proving the test uses an explicit pin rather than TOFU.
ssh-keygen -q -t ed25519 -f "$scratch_dir/wrong_host_ed25519" -N '' -C fixture-wrong-host
awk '{print "[127.0.0.1]:2224 " $1 " " $2}' "$scratch_dir/wrong_host_ed25519.pub" > "$scratch_dir/wrong_known_hosts"
set +e
sftp -q -b - \
  -P "$port" \
  -i "$client_key" \
  -o "UserKnownHostsFile=$scratch_dir/wrong_known_hosts" \
  -o GlobalKnownHostsFile=/dev/null \
  -o StrictHostKeyChecking=yes \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  "$account@$host" <<'SFTP' >/dev/null 2>&1
pwd
SFTP
wrong_host_rc=$?
set -e
[ "$wrong_host_rc" -ne 0 ] || fail fixture_host_key_mismatch_accepted 66

sftp_run <<SFTP
df .
put $scratch_dir/bootstrap-kit.bin .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
chmod 0600 .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
rename .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar
ls -ln .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar
SFTP

# The interrupted transfer is a closed partial file, then a fresh SFTP
# session removes it and restarts from offset zero before the atomic rename.
"$fixture_control" reset >/dev/null
mkdir_tree
sftp_run <<SFTP
put $scratch_dir/partial.bin .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
chmod 0600 .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
SFTP
sftp_run <<SFTP
rm .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
put $scratch_dir/bootstrap-kit.bin .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
chmod 0600 .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
rename .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar
ls -ln .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar
SFTP

# Stock OpenSSH exposes the object states which the typed iOS client must
# reject. The fixture does not pretend to be the application policy engine.
"$fixture_control" reset >/dev/null
mkdir_tree
symlink_listing="$(sftp_run <<'SFTP'
symlink /staging/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
ls -l .local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar.partial
SFTP
)"
printf '%s\n' "$symlink_listing" | grep -Eq '^l' || fail fixture_symlink_not_visible 67

"$fixture_control" reset >/dev/null
sftp_run <<SFTP
put $scratch_dir/partial.bin .local
SFTP
set +e
conflict_output="$(sftp_run <<'SFTP' 2>&1
mkdir .local/share
SFTP
)"
conflict_rc=$?
set -e
[ "$conflict_rc" -ne 0 ] || fail fixture_permission_conflict_accepted 67
printf '%s\n' "$conflict_output" | grep -Eqi 'Failure|No such file|not a directory' || fail fixture_permission_conflict_unclear 67

set +e
outside_output="$(sftp_run <<'SFTP' 2>&1
get /etc/passwd passwd.out
SFTP
)"
outside_rc=$?
set -e
[ "$outside_rc" -ne 0 ] || fail fixture_outside_read_accepted 68

ssh-keygen -q -t ed25519 -f "$scratch_dir/unauthorized_ed25519" -N '' -C fixture-unauthorized-client
set +e
unauthorized_output="$(sftp -q -b - \
  -P "$port" \
  -i "$scratch_dir/unauthorized_ed25519" \
  -o "UserKnownHostsFile=$scratch_dir/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null \
  -o StrictHostKeyChecking=yes \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  "$account@$host" <<'SFTP' 2>&1
pwd
SFTP
)"
unauthorized_rc=$?
set -e
[ "$unauthorized_rc" -ne 0 ] || fail fixture_unauthorized_client_accepted 68

printf '{"fixture":"%s:%s","account":"%s","hostKey":"%s","sftpAuthentication":true,"hostKeyMismatchRejected":true,"atomicRename":true,"restartFromZero":true,"symlinkVisibleForClientRejection":true,"permissionConflictRejected":true,"outsideReadRejected":true,"unauthorizedClientRejected":true}\n' \
  "$host" "$port" "$account" "$expected_host_fingerprint"
