#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
dockerfile="$repo_root/test/fixtures/systemd-upgrade/Dockerfile"
build_context="$repo_root/test/fixtures/systemd-upgrade"
historical_archive=${SONUVI_HISTORICAL_RELEASE_ARCHIVE:-/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912/sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912-linux-arm64.tar}
candidate_archive=${SONUVI_V2_RELEASE_ARCHIVE:-/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66/sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66-linux-arm64.tar}
tag="sonuvi-systemd-historical-fixture:$(date -u +%Y%m%d%H%M%S)-$$"
name="sonuvi-systemd-historical-fixture-$$"

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for the Linux systemd integration fixture.' >&2; exit 69; }
docker info >/dev/null
[ -f "$historical_archive" ] || { echo "Historical release archive is unavailable: $historical_archive" >&2; exit 71; }
[ -f "$candidate_archive" ] || { echo "Candidate release archive is unavailable: $candidate_archive" >&2; exit 72; }

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
  --volume "$historical_archive:/artifacts/historical.tar:ro" \
  --volume "$candidate_archive:/artifacts/candidate.tar:ro" \
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
[ "$ready" -eq 1 ] || { echo 'Disposable historical systemd fixture did not become ready.' >&2; exit 70; }

docker exec --workdir /sonuvi "$name" node test/fixtures/systemd-upgrade/historical-integration.mjs
