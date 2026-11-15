#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
dockerfile="$repo_root/test/fixtures/systemd-upgrade/Dockerfile"
build_context="$repo_root/test/fixtures/systemd-upgrade"
tag="sonuvi-systemd-upgrade-fixture:$(date -u +%Y%m%d%H%M%S)-$$"
name="sonuvi-systemd-upgrade-fixture-$$"

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for the Linux systemd integration fixture.' >&2; exit 69; }
docker info >/dev/null

cleanup() {
  if [ -n "${name:-}" ]; then docker stop --time 10 "$name" >/dev/null 2>&1 || true; fi
  if [ -n "${tag:-}" ]; then docker image rm "$tag" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM

docker build --pull=false --tag "$tag" --file "$dockerfile" "$build_context"
docker run --detach --rm --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  --volume /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --volume "$repo_root:/sonuvi:ro" \
  --network none --name "$name" "$tag" >/dev/null

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$name" systemctl show --property=Version --value >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || { echo 'Disposable systemd fixture did not become ready.' >&2; exit 70; }

docker exec --workdir /sonuvi "$name" node test/fixtures/systemd-upgrade/integration.mjs
