#!/usr/bin/env bash
# Controls the disposable localhost-only Gate C archive/status acceptance
# fixture. It is deliberately separate from the SFTP fixture and mounts only
# a test-only SSH host key and client public key.
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_dir="$repo_root/tools/sonuvi-gate-c-archive-status-fixture"
readonly image_name='sonuvi-gate-c-archive-status-fixture:20261105'
readonly container_name='sonuvi-gate-c-archive-status-fixture'
readonly relay_container_name='sonuvi-gate-c-archive-status-fixture-relay'
readonly fixture_network_name='sonuvi-gate-c-archive-status-fixture-net'
readonly relay_network_name='sonuvi-gate-c-archive-status-fixture-relay-net'
readonly bind_address='127.0.0.1'
readonly host_port='2225'
readonly account='sonuvi-stage'
readonly credential_dir='/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-archive-status-fixture-20261105'
readonly host_key="$credential_dir/ssh_host_ed25519_key"
readonly host_key_public="$host_key.pub"
readonly client_key="$credential_dir/client_ed25519"
readonly client_public_key="$client_key.pub"
readonly sudo_password="$credential_dir/sudo_password"
readonly release_id="${SONUVI_GATE_C_FIXTURE_RELEASE_ID:-sonuvi-e56d85697e23f11a91612918dd2b975b61c81cb035fb8295445e481d942eab67}"
readonly release_root="${SONUVI_GATE_C_FIXTURE_RELEASE_ROOT:-/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/$release_id}"
readonly bootstrap_kit="${SONUVI_GATE_C_FIXTURE_BOOTSTRAP_KIT:-$release_root/sonuvi-bootstrap-kit-v1.tar}"

fail() {
  echo "sonuvi_gate_c_archive_status_fixture:$1" >&2
  exit "${2:-1}"
}

regular_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || fail fixture_input_invalid 64
}

ensure_credentials() {
  install -d -m 0700 "$credential_dir"
  if [ ! -e "$host_key" ]; then
    ssh-keygen -q -t ed25519 -f "$host_key" -N '' -C sonuvi-gate-c-archive-status-host
  fi
  if [ ! -e "$client_key" ]; then
    ssh-keygen -q -t ed25519 -f "$client_key" -N '' -C sonuvi-gate-c-archive-status-client
  fi
  regular_file "$host_key"
  regular_file "$host_key.pub"
  regular_file "$client_key"
  regular_file "$client_public_key"
  if [ ! -e "$sudo_password" ]; then
    umask 077
    openssl rand -hex 24 > "$sudo_password"
  fi
  regular_file "$sudo_password"
  chmod 0600 "$host_key" "$client_key"
  chmod 0600 "$sudo_password"
  chmod 0644 "$host_key.pub" "$client_public_key"
  [ "$(stat -f '%Lp' "$host_key")" = '600' ] || fail fixture_host_key_mode_invalid 64
  [ "$(stat -f '%Lp' "$client_key")" = '600' ] || fail fixture_client_key_mode_invalid 64
  [ "$(stat -f '%Lp' "$sudo_password")" = '600' ] || fail fixture_sudo_password_mode_invalid 64
}

require_release() {
  regular_file "$release_root/release-envelope.json"
  regular_file "$release_root/release-trust-anchors.json"
  regular_file "$release_root/$release_id-linux-arm64.tar"
  (cd "$repo_root" && SONUVI_FIXTURE_RELEASE_ROOT="$release_root" node --input-type=module --eval "import fs from 'node:fs/promises'; import { verifySignedGateCReleaseMetadata } from './src/lib/sonuvi-gate-c-release.mjs'; const root = process.env.SONUVI_FIXTURE_RELEASE_ROOT; const [envelope, anchors] = await Promise.all([fs.readFile(root + '/release-envelope.json', 'utf8').then(JSON.parse), fs.readFile(root + '/release-trust-anchors.json', 'utf8').then(JSON.parse)]); const verified = verifySignedGateCReleaseMetadata({ envelope, trustedAnchors: anchors }); if (verified.metadata.releaseId !== '$release_id') throw new Error('fixture release identity mismatch');") || fail fixture_release_invalid 64
}

fixture_exists() {
  docker container inspect "$container_name" >/dev/null 2>&1
}

relay_exists() {
  docker container inspect "$relay_container_name" >/dev/null 2>&1
}

fixture_running() {
  [ "$(docker container inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" = 'true' ]
}

relay_running() {
  [ "$(docker container inspect --format '{{.State.Running}}' "$relay_container_name" 2>/dev/null || true)" = 'true' ]
}

container_running() { fixture_running && relay_running; }

# Container state alone does not guarantee the relay and forced SSH dispatcher
# have accepted their first connection. A reset is a test-fixture operation,
# but the verifier must not mistake that brief readiness window for an
# interrupted fixed archive stream. This probes only a deliberately rejected
# command: exit 126 proves that authentication, host-key pinning, relay, and
# forced-command dispatch are all live without running a fixture operation.
wait_for_ssh_dispatcher() {
  local known_hosts result attempt
  known_hosts="$(mktemp "${TMPDIR:-/tmp}/sonuvi-gate-c-fixture-known-hosts.XXXXXX")"
  awk -v port="$host_port" '{print "[127.0.0.1]:" port " " $1 " " $2}' "$host_key_public" > "$known_hosts"
  for attempt in $(seq 1 40); do
    set +e
    ssh -T -p "$host_port" -i "$client_key" \
      -o "UserKnownHostsFile=$known_hosts" \
      -o GlobalKnownHostsFile=/dev/null \
      -o StrictHostKeyChecking=yes \
      -o IdentitiesOnly=yes \
      -o BatchMode=yes \
      "$account@$bind_address" /usr/bin/true >/dev/null 2>&1
    result=$?
    set -e
    if [ "$result" -eq 126 ]; then
      rm -f "$known_hosts"
      return 0
    fi
    sleep 0.25
  done
  rm -f "$known_hosts"
  fail fixture_ssh_dispatcher_not_ready 70
}

remove_containers() {
  if relay_exists; then docker container rm --force "$relay_container_name" >/dev/null; fi
  if fixture_exists; then docker container rm --force "$container_name" >/dev/null; fi
}

assert_port_available() {
  if lsof -nP -iTCP:"$host_port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail fixture_port_in_use 69
  fi
}

ensure_network() {
  local network_name="$1" internal="$2"
  if docker network inspect "$network_name" >/dev/null 2>&1; then
    [ "$(docker network inspect --format '{{.Driver}}' "$network_name")" = 'bridge' ] || fail fixture_network_invalid 70
    if [ "$(docker network inspect --format '{{.Internal}}' "$network_name")" != "$internal" ]; then
      [ "$(docker network inspect --format '{{len .Containers}}' "$network_name")" = '0' ] || fail fixture_network_in_use 70
      docker network rm "$network_name" >/dev/null
    fi
  fi
  if ! docker network inspect "$network_name" >/dev/null 2>&1; then
    if [ "$internal" = 'true' ]; then
      docker network create --internal --driver bridge "$network_name" >/dev/null
    else
      docker network create --driver bridge "$network_name" >/dev/null
    fi
  fi
  [ "$(docker network inspect --format '{{.Driver}}' "$network_name")" = 'bridge' ] || fail fixture_network_invalid 70
  [ "$(docker network inspect --format '{{.Internal}}' "$network_name")" = "$internal" ] || fail fixture_network_invalid 70
}

prepare_build_context() {
  local build_context
  local packaged_bootstrap_kit="$bootstrap_kit"
  build_context="$(mktemp -d /tmp/sonuvi-gate-c-archive-status-build.XXXXXX)"
  install -d -m 0700 "$build_context/app/scripts" "$build_context/app/src/lib"
  cp "$fixture_dir/Dockerfile" "$fixture_dir/sshd_config" "$fixture_dir/dispatcher.sh" "$fixture_dir/seed-status.mjs" "$fixture_dir/start.sh" "$fixture_dir/tcp-relay.mjs" "$fixture_dir/systemctl-fixture.sh" "$build_context/"
  if [ -n "$packaged_bootstrap_kit" ]; then
    regular_file "$packaged_bootstrap_kit"
    tar --extract --file "$packaged_bootstrap_kit" --directory "$build_context/app"
    (cd "$repo_root" && SONUVI_FIXTURE_BOOTSTRAP_ROOT="$build_context/app" node --input-type=module --eval "import { verifyGateCBootstrapKit } from './src/lib/sonuvi-gate-c-bootstrap-kit.mjs'; await verifyGateCBootstrapKit({ kitRoot: process.env.SONUVI_FIXTURE_BOOTSTRAP_ROOT });") || fail fixture_bootstrap_kit_invalid 64
  else
    cp "$repo_root/scripts/sonuvi-release-stage.mjs" "$repo_root/scripts/sonuvi-bootstrap-status.mjs" "$repo_root/scripts/sonuvi-first-install-activate.mjs" "$repo_root/scripts/sonuvi-target-preflight.sh" "$build_context/app/scripts/"
    local file
    for file in \
      atomic-file.mjs public-web-root.mjs release-artifact.mjs runtime-capabilities.mjs runtime-config-security.mjs \
      sonuvi-bootstrap-contract.mjs sonuvi-bootstrap-progress.mjs sonuvi-bootstrap-status.mjs sonuvi-fresh-install.mjs \
      sonuvi-gate-c-first-install.mjs sonuvi-gate-c-release.mjs sonuvi-gate-c-staging.mjs sonuvi-gate-c-target-preflight.mjs; do
      cp "$repo_root/src/lib/$file" "$build_context/app/src/lib/$file"
    done
  fi
  cp "$release_root/release-trust-anchors.json" "$build_context/release-trust-anchors.json"
  cp "$release_root/release-envelope.json" "$build_context/fixture-release-envelope.json"
  if ! docker build --platform linux/arm64 --tag "$image_name" "$build_context" >/dev/null; then
    trash "$build_context" >/dev/null 2>&1 || true
    fail fixture_image_build_failed 70
  fi
  trash "$build_context" >/dev/null 2>&1 || true
}

start() {
  ensure_credentials
  require_release
  if container_running; then
    status
    return
  fi
  remove_containers
  assert_port_available
  ensure_network "$fixture_network_name" true
  ensure_network "$relay_network_name" false
  prepare_build_context
  docker run --detach --init \
    --name "$container_name" \
    --network "$fixture_network_name" \
    --memory 1g --pids-limit 128 \
    --mount "type=bind,src=$host_key,dst=/run/secrets/ssh_host_ed25519_key,readonly" \
    --mount "type=bind,src=$client_public_key,dst=/run/secrets/authorized_keys,readonly" \
    --mount "type=bind,src=$sudo_password,dst=/run/secrets/sudo_password,readonly" \
    "$image_name" >/dev/null
  docker run --detach --init \
    --name "$relay_container_name" \
    --network "$relay_network_name" \
    --publish "$bind_address:$host_port:2225" \
    --memory 64m --pids-limit 32 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1m \
    --entrypoint /usr/local/bin/node \
    "$image_name" /usr/local/lib/sonuvi-fixture/tcp-relay.mjs >/dev/null
  docker network connect "$fixture_network_name" "$relay_container_name"
  sleep 1
  container_running || fail fixture_failed_to_start 70
  wait_for_ssh_dispatcher
  status
}

reset() {
  remove_containers
  start
}

stop() {
  remove_containers
}

status() {
  container_running || fail fixture_not_running 69
  local fingerprint
  fingerprint="$(ssh-keygen -lf "$host_key.pub" -E sha256 | awk '{print $2}')"
  lsof -nP -iTCP:"$host_port" -sTCP:LISTEN
  docker network inspect --format '{{.Name}} driver={{.Driver}} internal={{.Internal}}' "$fixture_network_name"
  docker network inspect --format '{{.Name}} driver={{.Driver}} internal={{.Internal}}' "$relay_network_name"
  docker container inspect --format '{{.Name}} {{range .NetworkSettings.Ports}}{{.}}{{end}}' "$relay_container_name"
  printf 'fixture=%s:%s account=%s hostKey=%s release=%s\n' "$bind_address" "$host_port" "$account" "$fingerprint" "$release_id"
}

inspect() {
  container_running || fail fixture_not_running 69
  docker exec "$container_name" /bin/sh -ec '
    stat -c "%u:%g:%a %n" \
      /var/lib/sonuvi-bootstrap \
      /var/lib/sonuvi-bootstrap/attempts \
      /var/lib/sonuvi-bootstrap/uploads \
      /var/lib/sonuvi-bootstrap/releases \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
    sha256sum \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs \
      /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs
  '
}

case "${1:-status}" in
  start) start ;;
  reset) reset ;;
  stop) stop ;;
  status) status ;;
  inspect) inspect ;;
  *) fail invalid_action 64 ;;
esac
