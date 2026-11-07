#!/usr/bin/env bash
# Independent OpenSSH acceptance of the disposable Gate C archive/status
# fixture. It streams the published immutable release through the real fixed
# helper and never installs or activates Sonuvi.
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_control="$repo_root/scripts/sonuvi-gate-c-archive-status-fixture.sh"
readonly credential_dir='/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-archive-status-fixture-20261105'
readonly host='127.0.0.1'
readonly port='2225'
readonly account='sonuvi-stage'
readonly host_key="$credential_dir/ssh_host_ed25519_key"
readonly host_key_public="$host_key.pub"
readonly client_key="$credential_dir/client_ed25519"
readonly sudo_password="$credential_dir/sudo_password"
readonly release_id="${SONUVI_GATE_C_FIXTURE_RELEASE_ID:-sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912}"
readonly release_root="${SONUVI_GATE_C_FIXTURE_RELEASE_ROOT:-/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/$release_id}"
readonly release_archive="$release_root/$release_id-linux-arm64.tar"
readonly envelope="$release_root/release-envelope.json"
readonly attempt_id='boot_fixture_archive_status_20261105'
readonly activation_attempt_id='boot_fixture_first_install_20261105'
readonly container_name='sonuvi-gate-c-archive-status-fixture'
readonly preflight_command='/usr/bin/tar --extract --file "$HOME/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar" --to-stdout -- scripts/sonuvi-target-preflight.sh | /bin/sh'
readonly status_command="/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs"
readonly stage_command="/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs"
readonly activate_command="/usr/bin/sudo -S -k -p '' -- /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs"

fail() {
  echo "verify_sonuvi_gate_c_archive_status_fixture:$1" >&2
  exit "${2:-1}"
}

scratch_dir="$(mktemp -d /tmp/sonuvi-gate-c-archive-status-fixture.XXXXXX)"
fixture_completed=false
cleanup() {
  local result=$?
  # Every ordinary test path ends with an explicit reset and status probe. Do
  # not launch another unobserved Docker lifecycle after a successful fixture:
  # that was harness work rather than acceptance evidence and obscured the
  # final completion boundary.
  if [ "$fixture_completed" != true ]; then
    "$fixture_control" reset >/dev/null 2>&1 || true
  fi
  trash "$scratch_dir" >/dev/null 2>&1 || true
  return "$result"
}
trap cleanup EXIT HUP INT TERM

"$fixture_control" start >/dev/null
[ -f "$host_key" ] && [ -f "$host_key_public" ] && [ -f "$client_key" ] && [ -f "$sudo_password" ] || fail fixture_credential_missing 64
[ -f "$release_archive" ] && [ -f "$envelope" ] || fail fixture_release_missing 64
expected_fingerprint="$(ssh-keygen -lf "$host_key_public" -E sha256 | awk '{print $2}')"
[ -n "$expected_fingerprint" ] || fail fixture_host_fingerprint_missing 64
awk -v port="$port" '{print "[127.0.0.1]:" port " " $1 " " $2}' "$host_key_public" > "$scratch_dir/known_hosts"

ssh_run() {
  ssh -T \
    -p "$port" \
    -i "$client_key" \
    -o "UserKnownHostsFile=$scratch_dir/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    "$account@$host" "$@"
}

make_stage_header() {
  local requested_target="${1:-$activation_target}"
  local requested_attempt="${2:-$activation_attempt_id}"
  SONUVI_FIXTURE_ENVELOPE="$envelope" SONUVI_FIXTURE_TARGET="$requested_target" SONUVI_FIXTURE_ATTEMPT="$requested_attempt" node --input-type=module --eval "import fs from 'node:fs/promises'; const envelope = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_ENVELOPE, 'utf8')); process.stdout.write(JSON.stringify({ operation: 'stage_release', envelope, attemptId: process.env.SONUVI_FIXTURE_ATTEMPT, targetIdentity: process.env.SONUVI_FIXTURE_TARGET }) + '\\n');" > "$scratch_dir/header.jsonl"
  [ "$(wc -c < "$scratch_dir/header.jsonl" | tr -d ' ')" -le 65536 ] || fail fixture_header_limit_invalid 64
}

make_invalid_signature_header() {
  SONUVI_FIXTURE_ENVELOPE="$envelope" SONUVI_FIXTURE_TARGET="$activation_target" node --input-type=module --eval "import fs from 'node:fs/promises'; const envelope = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_ENVELOPE, 'utf8')); envelope.signature = (envelope.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.slice(1); process.stdout.write(JSON.stringify({ operation: 'stage_release', envelope, attemptId: '$activation_attempt_id', targetIdentity: process.env.SONUVI_FIXTURE_TARGET }) + '\\n');" > "$scratch_dir/header.jsonl"
  [ "$(wc -c < "$scratch_dir/header.jsonl" | tr -d ' ')" -le 65536 ] || fail fixture_header_limit_invalid 64
}

make_activation_request() {
  local requested_target="$1"
  SONUVI_FIXTURE_ENVELOPE="$envelope" SONUVI_FIXTURE_TARGET="$requested_target" node --input-type=module --eval "import fs from 'node:fs/promises'; const envelope = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_ENVELOPE, 'utf8')); process.stdout.write(JSON.stringify({ operation: 'activate_first_install', envelope, attemptId: '$activation_attempt_id', targetIdentity: process.env.SONUVI_FIXTURE_TARGET, serverIdentity: 'fixture-server' }) + '\\n');" > "$scratch_dir/activation.json"
  [ "$(wc -c < "$scratch_dir/activation.json" | tr -d ' ')" -le 65536 ] || fail fixture_activation_request_limit_invalid 64
}

assert_status() {
  local file="$1"
  SONUVI_FIXTURE_RESULT="$file" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (!value.ok || value.contract !== 'sonuvi.bootstrap-status.v1' || value.attemptId !== '$attempt_id' || value.targetIdentity !== '$target_identity' || value.phase !== 'release_acquisition' || value.next !== 'observe' || value.terminal !== false || !Array.isArray(value.events) || value.events.length !== 1) throw new Error('unexpected durable status response');"
}

assert_stage() {
  local file="$1" expected="$2"
  SONUVI_FIXTURE_RESULT="$file" SONUVI_FIXTURE_STATE="$expected" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (!value.ok || value.contract !== 'sonuvi.gate-c-stage-response.v1' || value.operation !== 'stage_release' || value.state !== process.env.SONUVI_FIXTURE_STATE || value.releaseId !== '$release_id' || value.attemptId !== '$activation_attempt_id' || value.targetIdentity !== '$activation_target' || typeof value.keyId !== 'string' || 'releaseRoot' in value) throw new Error('unexpected release stage response');"
}

assert_activation() {
  local file="$1" expected="$2"
  SONUVI_FIXTURE_RESULT="$file" SONUVI_FIXTURE_STATE="$expected" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (!value.ok || value.contract !== 'sonuvi.gate-c-first-install.v1' || value.state !== process.env.SONUVI_FIXTURE_STATE || value.releaseId !== '$release_id' || value.attemptId !== '$activation_attempt_id' || value.targetIdentity !== '$activation_target') throw new Error('unexpected first-install activation response');"
}

assert_activation_status() {
  local file="$1"
  SONUVI_FIXTURE_RESULT="$file" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (!value.ok || value.contract !== 'sonuvi.bootstrap-status.v1' || value.attemptId !== '$activation_attempt_id' || value.targetIdentity !== '$activation_target' || value.releaseId !== '$release_id' || value.phase !== 'awaiting-administrator-enrollment' || value.next !== 'administrator_enrollment' || value.terminal !== false || !Array.isArray(value.events) || !value.events.some((event) => event.stage === 'activation' && event.state === 'passed')) throw new Error('unexpected durable activation status response');"
}

assert_failure() {
  local file="$1" expected="$2"
  SONUVI_FIXTURE_RESULT="$file" SONUVI_FIXTURE_CODE="$expected" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (value.ok || !String(value.code || '').includes(process.env.SONUVI_FIXTURE_CODE)) throw new Error('unexpected fixture rejection response');"
}

assert_stage_failure() {
  local file="$1" expected="$2"
  SONUVI_FIXTURE_RESULT="$file" SONUVI_FIXTURE_CODE="$expected" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_RESULT, 'utf8')); if (value.ok || value.contract !== 'sonuvi.gate-c-stage-response.v1' || value.operation !== 'stage_release' || value.code !== process.env.SONUVI_FIXTURE_CODE || Object.keys(value).sort().join(',') !== 'code,contract,ok,operation') throw new Error('unexpected typed stage rejection response');"
}

run_status() {
  { tr -d '\r\n' < "$sudo_password"; printf '\n%s' "{\"operation\":\"status\",\"attemptId\":\"$attempt_id\"}"; } | ssh_run "$status_command"
}

run_activation_status() {
  { tr -d '\r\n' < "$sudo_password"; printf '\n%s' "{\"operation\":\"status\",\"attemptId\":\"$activation_attempt_id\"}"; } | ssh_run "$status_command"
}

run_stage() {
  { tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/header.jsonl" "$release_archive"; } | ssh_run "$stage_command"
}

run_activation() {
  { tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/activation.json"; } | ssh_run "$activate_command"
}

run_preflight() {
  ssh_run "$preflight_command"
}

"$fixture_control" reset >/dev/null
"$fixture_control" inspect > "$scratch_dir/inspect.txt"
run_preflight > "$scratch_dir/preflight.json"
activation_target="$(SONUVI_FIXTURE_PREFLIGHT="$scratch_dir/preflight.json" node --input-type=module --eval "import fs from 'node:fs/promises'; const value = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_PREFLIGHT, 'utf8')); if (value.contract !== 'sonuvi.gate-c-target-preflight.v1' || value.operation !== 'target_preflight' || value.targetIdentity?.contract !== 'sonuvi.gate-c-target-identity.v1' || value.targetIdentity?.algorithm !== 'sha256-machine-id' || !/^sonuvi-target-v1-[a-f0-9]{64}$/.test(value.targetIdentity?.value || '') || value.compatibility?.os !== 'debian' || value.compatibility?.architecture !== 'arm64' || value.compatibility?.systemd !== true || value.compatibility?.supported !== true) throw new Error('unexpected preflight response'); process.stdout.write(value.targetIdentity.value);")"
target_identity="$activation_target"
grep -q '0:0:700 /var/lib/sonuvi-bootstrap$' "$scratch_dir/inspect.txt" || fail fixture_root_permissions_invalid 65
grep -q '0:0:700 /var/lib/sonuvi-bootstrap/attempts$' "$scratch_dir/inspect.txt" || fail fixture_attempt_permissions_invalid 65
grep -q '0:0:644 /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs$' "$scratch_dir/inspect.txt" || fail fixture_stage_helper_permissions_invalid 65
grep -q '0:0:644 /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs$' "$scratch_dir/inspect.txt" || fail fixture_status_helper_permissions_invalid 65
grep -q '0:0:644 /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs$' "$scratch_dir/inspect.txt" || fail fixture_first_install_helper_permissions_invalid 65

# Ordinary sudo requires an explicit password for this exact operation. The
# disposable fixture contains no NOPASSWD rule and no cached authorization.
set +e
{ printf 'wrong-password\n%s' "{\"operation\":\"status\",\"attemptId\":\"$attempt_id\"}"; } | ssh_run "$status_command" > "$scratch_dir/status-wrong-password.json" 2> "$scratch_dir/status-wrong-password.err"
wrong_password_rc=$?
set -e
[ "$wrong_password_rc" -ne 0 ] || fail fixture_wrong_sudo_password_accepted 66
docker exec "$container_name" /bin/sh -ec "su -s /bin/sh sonuvi-stage -c '/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs' </dev/null" >/dev/null 2>&1 && fail fixture_noninteractive_sudo_accepted 66 || true
set +e
docker exec "$container_name" /bin/sh -ec "printf '{}' | su -s /bin/sh sonuvi-stage -c '/usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs'" > "$scratch_dir/stage-unprivileged.json" 2> "$scratch_dir/stage-unprivileged.err"
stage_unprivileged_rc=$?
set -e
[ "$stage_unprivileged_rc" -ne 0 ] || fail fixture_unprivileged_stage_accepted 66
# The account cannot traverse the root-only bootstrap directory at all; this
# is a stronger actual privilege boundary than reaching a helper that reports
# a typed denial. The wrapper's reachable non-root response is covered by its
# direct contract test above.
grep -q 'Cannot find module' "$scratch_dir/stage-unprivileged.err" || fail fixture_unprivileged_stage_boundary_invalid 66

# Pinning is explicit: a deliberately different host key must fail before
# user authentication, while the expected key permits the fixed status command.
ssh-keygen -q -t ed25519 -f "$scratch_dir/wrong_host_ed25519" -N '' -C fixture-wrong-host
awk -v port="$port" '{print "[127.0.0.1]:" port " " $1 " " $2}' "$scratch_dir/wrong_host_ed25519.pub" > "$scratch_dir/wrong_known_hosts"
set +e
printf '%s' "{\"operation\":\"status\",\"attemptId\":\"$attempt_id\"}" | ssh -T -p "$port" -i "$client_key" -o "UserKnownHostsFile=$scratch_dir/wrong_known_hosts" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes "$account@$host" "$status_command" > /dev/null 2>&1
wrong_host_rc=$?
set -e
[ "$wrong_host_rc" -ne 0 ] || fail fixture_host_key_mismatch_accepted 66

run_status > "$scratch_dir/status-before.json"
assert_status "$scratch_dir/status-before.json"
before_status_digest="$(docker exec "$container_name" sha256sum /var/lib/sonuvi-bootstrap/attempts/$attempt_id/state.json /var/lib/sonuvi-bootstrap/attempts/$attempt_id/journal.jsonl | sort)"
run_status > "$scratch_dir/status-reconnect.json"
assert_status "$scratch_dir/status-reconnect.json"
after_status_digest="$(docker exec "$container_name" sha256sum /var/lib/sonuvi-bootstrap/attempts/$attempt_id/state.json /var/lib/sonuvi-bootstrap/attempts/$attempt_id/journal.jsonl | sort)"
[ "$before_status_digest" = "$after_status_digest" ] || fail fixture_status_mutated_state 67

set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n%s' '{"operation":"status","attemptId":"boot_unrelated_1234567890"}'; } | ssh_run "$status_command" > "$scratch_dir/status-unrelated.json"
unrelated_rc=$?
set -e
[ "$unrelated_rc" -ne 0 ] || fail fixture_unrelated_status_accepted 67
assert_failure "$scratch_dir/status-unrelated.json" 'bootstrap_attempt_not_found'

make_stage_header "sonuvi-target-v1-$(printf 'b%.0s' {1..64})"
set +e
run_stage > "$scratch_dir/stage-wrong-target.json"
stage_wrong_target_rc=$?
set -e
[ "$stage_wrong_target_rc" -ne 0 ] || fail fixture_wrong_target_stage_accepted 67
assert_stage_failure "$scratch_dir/stage-wrong-target.json" stage_target_mismatch

make_invalid_signature_header
set +e
run_stage > "$scratch_dir/stage-bad-signature.json"
stage_bad_signature_rc=$?
set -e
[ "$stage_bad_signature_rc" -ne 0 ] || fail fixture_bad_signature_stage_accepted 67
assert_stage_failure "$scratch_dir/stage-bad-signature.json" stage_release_identity_mismatch

make_stage_header "$activation_target" "$attempt_id"
set +e
run_stage > "$scratch_dir/stage-attempt-mismatch.json"
stage_attempt_mismatch_rc=$?
set -e
[ "$stage_attempt_mismatch_rc" -ne 0 ] || fail fixture_attempt_mismatch_stage_accepted 67
assert_stage_failure "$scratch_dir/stage-attempt-mismatch.json" stage_attempt_mismatch

make_stage_header
run_stage > "$scratch_dir/staged.json"
assert_stage "$scratch_dir/staged.json" staged
docker exec "$container_name" /bin/sh -ec "test -d /var/lib/sonuvi-bootstrap/releases/$release_id && test \"\$(stat -c %a /var/lib/sonuvi-bootstrap/releases/$release_id)\" = 555"
run_stage > "$scratch_dir/already-staged.json"
assert_stage "$scratch_dir/already-staged.json" already_staged

# First installation is deliberately activated from the verified staged tree;
# /opt/sonuvi/current must not exist before the root-owned bootstrap bridge.
docker exec "$container_name" /bin/sh -ec 'test ! -e /opt/sonuvi/current'
[[ "$activation_target" =~ ^sonuvi-target-v1-[a-f0-9]{64}$ ]] || fail fixture_target_identity_invalid 67
make_activation_request "sonuvi-target-v1-$(printf 'b%.0s' {1..64})"
set +e
run_activation > "$scratch_dir/activation-wrong-machine.json"
wrong_machine_rc=$?
set -e
[ "$wrong_machine_rc" -ne 0 ] || fail fixture_wrong_machine_activation_accepted 67
assert_failure "$scratch_dir/activation-wrong-machine.json" 'first_install_target_identity_mismatch'

# Caller-controlled paths are rejected by the fixed typed schema before any
# installer invocation. The release ID remains metadata-derived only.
SONUVI_FIXTURE_ENVELOPE="$envelope" SONUVI_FIXTURE_TARGET="$activation_target" node --input-type=module --eval "import fs from 'node:fs/promises'; const envelope = JSON.parse(await fs.readFile(process.env.SONUVI_FIXTURE_ENVELOPE, 'utf8')); process.stdout.write(JSON.stringify({ operation: 'activate_first_install', envelope, attemptId: '$activation_attempt_id', targetIdentity: process.env.SONUVI_FIXTURE_TARGET, serverIdentity: 'fixture-server', path: '/opt/sonuvi/current' }) + '\\n');" > "$scratch_dir/activation-with-path.json"
set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/activation-with-path.json"; } | ssh_run "$activate_command" > "$scratch_dir/activation-with-path-response.json"
path_request_rc=$?
set -e
[ "$path_request_rc" -ne 0 ] || fail fixture_path_activation_accepted 67
assert_failure "$scratch_dir/activation-with-path-response.json" 'unsupported_fields'

# A stale lock is a durable interrupted-request boundary: it must not run a
# second installer process, and a later explicit retry can proceed after the
# lock is cleared by recovery.
make_activation_request "$activation_target"
docker exec "$container_name" /bin/sh -ec "printf interrupted > /var/lib/sonuvi-bootstrap/first-install.lock && chmod 600 /var/lib/sonuvi-bootstrap/first-install.lock"
set +e
run_activation > "$scratch_dir/activation-locked.json"
locked_rc=$?
set -e
[ "$locked_rc" -ne 0 ] || fail fixture_locked_activation_accepted 67
assert_failure "$scratch_dir/activation-locked.json" 'first_install_activation_in_progress'
docker exec "$container_name" /bin/sh -ec 'rm -f /var/lib/sonuvi-bootstrap/first-install.lock'

run_activation > "$scratch_dir/activation.json.result"
assert_activation "$scratch_dir/activation.json.result" awaiting-administrator-enrollment
docker exec "$container_name" /bin/sh -ec "test -L /opt/sonuvi/current && test \"\$(readlink -f /opt/sonuvi/current)\" = /opt/sonuvi/releases/$release_id"
run_activation_status > "$scratch_dir/activation-status.json"
assert_activation_status "$scratch_dir/activation-status.json"
run_activation > "$scratch_dir/activation-repeat.json"
assert_activation "$scratch_dir/activation-repeat.json" already_activated

# Direct unprivileged execution does not gain a root operation merely because
# the bootstrap script is readable.
set +e
docker exec "$container_name" /bin/sh -ec "printf '{}' | su -s /bin/sh sonuvi-stage -c '/usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs'" > "$scratch_dir/activation-unprivileged.out" 2> "$scratch_dir/activation-unprivileged.err"
unprivileged_rc=$?
set -e
[ "$unprivileged_rc" -ne 0 ] || fail fixture_unprivileged_activation_accepted 67

# A fully completed first stream with its output intentionally discarded is
# indistinguishable to a reconnecting caller from a lost final response. The
# canonical retry is safely `already_staged`, not a second extraction.
"$fixture_control" reset >/dev/null
run_stage > /dev/null
run_stage > "$scratch_dir/lost-response-retry.json"
assert_stage "$scratch_dir/lost-response-retry.json" already_staged

"$fixture_control" reset >/dev/null
set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n{"operation":"stage_release"\n'; } | ssh_run "$stage_command" > "$scratch_dir/malformed.json"
malformed_rc=$?
set -e
[ "$malformed_rc" -ne 0 ] || fail fixture_malformed_header_accepted 68
assert_stage_failure "$scratch_dir/malformed.json" stage_input_invalid

"$fixture_control" reset >/dev/null
set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/header.jsonl"; head -c 1048576 "$release_archive"; } | ssh_run "$stage_command" > "$scratch_dir/truncated.json"
truncated_rc=$?
set -e
[ "$truncated_rc" -ne 0 ] || fail fixture_truncated_archive_accepted 68
assert_stage_failure "$scratch_dir/truncated.json" stage_release_digest_mismatch
docker exec "$container_name" /bin/sh -ec "test ! -e /var/lib/sonuvi-bootstrap/releases/$release_id"

"$fixture_control" reset >/dev/null
cp "$release_archive" "$scratch_dir/corrupt.tar"
chmod u+w "$scratch_dir/corrupt.tar"
printf '\001' | dd of="$scratch_dir/corrupt.tar" bs=1 seek=4096 conv=notrunc status=none
set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/header.jsonl" "$scratch_dir/corrupt.tar"; } | ssh_run "$stage_command" > "$scratch_dir/digest-mismatch.json"
digest_rc=$?
set -e
[ "$digest_rc" -ne 0 ] || fail fixture_digest_mismatch_accepted 68
assert_stage_failure "$scratch_dir/digest-mismatch.json" stage_release_digest_mismatch

"$fixture_control" reset >/dev/null
set +e
{ tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/header.jsonl" "$release_archive"; printf x; } | ssh_run "$stage_command" > "$scratch_dir/trailing.json"
trailing_rc=$?
set -e
[ "$trailing_rc" -ne 0 ] || fail fixture_trailing_archive_accepted 68
assert_stage_failure "$scratch_dir/trailing.json" stage_release_digest_mismatch

# The fixed wrapper must not surface filesystem/parser detail when its helper
# dependencies are unavailable or when a pre-existing release conflicts.
"$fixture_control" reset >/dev/null
docker exec "$container_name" /bin/sh -ec 'mv /etc/sonuvi/release-trust-anchors.json /etc/sonuvi/release-trust-anchors.json.fixture-hidden'
set +e
run_stage > "$scratch_dir/helper-unavailable.json"
helper_unavailable_rc=$?
set -e
[ "$helper_unavailable_rc" -ne 0 ] || fail fixture_helper_unavailable_accepted 68
assert_stage_failure "$scratch_dir/helper-unavailable.json" stage_helper_unavailable

"$fixture_control" reset >/dev/null
docker exec "$container_name" /bin/sh -ec "mkdir -p /var/lib/sonuvi-bootstrap/releases/$release_id"
set +e
run_stage > "$scratch_dir/stage-conflict.json"
stage_conflict_rc=$?
set -e
[ "$stage_conflict_rc" -ne 0 ] || fail fixture_stage_conflict_accepted 68
assert_stage_failure "$scratch_dir/stage-conflict.json" stage_conflict

# This is an actual SSH disconnect mid-stream: the producer keeps the channel
# open after one MiB, then the SSH process is terminated before it can finish.
"$fixture_control" reset >/dev/null
mkfifo "$scratch_dir/interrupted.fifo"
ssh -T -p "$port" -i "$client_key" -o "UserKnownHostsFile=$scratch_dir/known_hosts" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes "$account@$host" "$stage_command" < "$scratch_dir/interrupted.fifo" > "$scratch_dir/interrupted.json" 2> "$scratch_dir/interrupted.err" &
ssh_pid=$!
{ tr -d '\r\n' < "$sudo_password"; printf '\n'; cat "$scratch_dir/header.jsonl"; dd if="$release_archive" bs=65536 count=16 status=none; sleep 10; } > "$scratch_dir/interrupted.fifo" &
producer_pid=$!
sleep 1
kill "$ssh_pid" >/dev/null 2>&1 || true
wait "$ssh_pid" || true
kill "$producer_pid" >/dev/null 2>&1 || true
wait "$producer_pid" || true
sleep 1
docker exec "$container_name" /bin/sh -ec "test ! -e /var/lib/sonuvi-bootstrap/releases/$release_id"

# The forced dispatcher is an authorization boundary, not a shell. A command
# outside the two fixed helpers must never reach a user shell or root process.
set +e
ssh_run /usr/bin/id > "$scratch_dir/unauthorized.out" 2> "$scratch_dir/unauthorized.err"
unauthorized_rc=$?
set -e
[ "$unauthorized_rc" -eq 126 ] || fail fixture_unauthorized_operation_accepted 69
grep -q 'operation_rejected' "$scratch_dir/unauthorized.err"

"$fixture_control" reset >/dev/null
run_status > "$scratch_dir/status-final.json"
assert_status "$scratch_dir/status-final.json"
"$fixture_control" status > "$scratch_dir/lifecycle-final.txt"
grep -q "release=$release_id" "$scratch_dir/lifecycle-final.txt" || fail fixture_final_lifecycle_status_invalid 69
# The password is injected only into sudo's stdin. It must not appear in the
# durable bootstrap state or event journal; the secret mount itself is outside
# that state and is never copied by the fixture.
if docker exec "$container_name" /bin/sh -ec 'grep -R -F -f /run/secrets/sudo_password /var/lib/sonuvi-bootstrap/attempts /var/lib/sonuvi-bootstrap/releases 2>/dev/null'; then
  fail fixture_sudo_password_persisted 69
fi
printf '{"fixture":"%s:%s","account":"%s","hostKey":"%s","releaseId":"%s","stage":"actual-archive-verified","status":"reconnect-safe","reset":"container-recreate"}\n' \
  "$host" "$port" "$account" "$expected_fingerprint" "$release_id"
fixture_completed=true
