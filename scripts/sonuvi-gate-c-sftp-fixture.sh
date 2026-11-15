#!/usr/bin/env bash
# Controls the disposable, localhost-only Gate C SFTP protocol fixture.
# It has no access to production files, Sonuvi services, or release artifacts.
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly context_dir="$repo_root/tools/sonuvi-gate-c-sftp-fixture"
readonly image_name='sonuvi-gate-c-sftp-fixture:20261105'
readonly container_name='sonuvi-gate-c-sftp-fixture'
readonly network_name='sonuvi-gate-c-sftp-fixture-net'
readonly bind_address='127.0.0.1'
readonly host_port='2224'
readonly credential_dir='/Users/brianwis/.openclaw/credentials/sonuvi-gate-c-sftp-fixture-20261105'
readonly host_key="$credential_dir/ssh_host_ed25519_key"
readonly client_public_key="$credential_dir/client_ed25519.pub"

fail() {
  echo "sonuvi_gate_c_sftp_fixture:$1" >&2
  exit "${2:-1}"
}

require_inputs() {
  [ -d "$context_dir" ] || fail fixture_context_missing 64
  [ -f "$host_key" ] && [ ! -L "$host_key" ] || fail fixture_host_key_missing 64
  [ -f "$client_public_key" ] && [ ! -L "$client_public_key" ] || fail fixture_client_key_missing 64
  [ "$(stat -f '%Lp' "$host_key")" = '600' ] || fail fixture_host_key_mode_invalid 64
}

container_exists() {
  docker container inspect "$container_name" >/dev/null 2>&1
}

container_running() {
  [ "$(docker container inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" = 'true' ]
}

assert_port_available() {
  if lsof -nP -iTCP:"$host_port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail fixture_port_in_use 69
  fi
}

ensure_network() {
  if ! docker network inspect "$network_name" >/dev/null 2>&1; then
    # Docker Desktop does not publish a host port from an --internal network.
    # The listener itself remains bound only to 127.0.0.1; sshd permits no
    # shell, forwarding, tunnel, or command execution that could create an
    # application-level outbound channel.
    docker network create --driver bridge "$network_name" >/dev/null
  fi
  [ "$(docker network inspect --format '{{.Driver}}' "$network_name")" = 'bridge' ] || fail fixture_network_invalid 70
}

start() {
  require_inputs
  if container_running; then
    status
    return
  fi
  if container_exists; then
    docker container rm "$container_name" >/dev/null
  fi
  assert_port_available
  ensure_network
  docker build --tag "$image_name" "$context_dir" >/dev/null
  docker run --detach \
    --name "$container_name" \
    --network "$network_name" \
    --publish "$bind_address:$host_port:22" \
    --mount "type=bind,src=$host_key,dst=/run/secrets/ssh_host_ed25519_key,readonly" \
    --mount "type=bind,src=$client_public_key,dst=/run/secrets/authorized_keys,readonly" \
    "$image_name" >/dev/null
  sleep 1
  container_running || fail fixture_failed_to_start 70
  status
}

reset() {
  if container_exists; then
    docker container rm --force "$container_name" >/dev/null
  fi
  start
}

stop() {
  if container_exists; then
    docker container rm --force "$container_name" >/dev/null
  fi
}

status() {
  container_running || fail fixture_not_running 69
  lsof -nP -iTCP:"$host_port" -sTCP:LISTEN
  docker network inspect --format '{{.Name}} driver={{.Driver}} internal={{.Internal}}' "$network_name"
  docker container inspect --format '{{.Name}} {{range .NetworkSettings.Ports}}{{.}}{{end}}' "$container_name"
}

case "${1:-status}" in
  start) start ;;
  reset) reset ;;
  stop) stop ;;
  status) status ;;
  *) fail invalid_action 64 ;;
esac
