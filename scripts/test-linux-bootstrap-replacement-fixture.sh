#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
fixture_root="$repo_root/test/fixtures/systemd-upgrade"
dockerfile="$fixture_root/Dockerfile"
historical_root=/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66
corrected_root=/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-3cbe87d6744b9f7a1423afa09ca91eb81e9662138d59d1e29054c72045700fdf
installed_root=/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/distribution/gate-c-lab/sonuvi-baa3323da488662fd8b39a0ac805fab5ea18525020dc41dddf734087c890e912
tag="sonuvi-bootstrap-replacement-fixture:$(date -u +%Y%m%d%H%M%S)-$$"
name="sonuvi-bootstrap-replacement-fixture-$$"
built=0
started=0

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for the Linux bootstrap replacement fixture.' >&2; exit 69; }
docker info >/dev/null
architecture=$(docker info --format '{{.Architecture}}')
case "$architecture" in
  aarch64|arm64) ;;
  *) echo "The Linux fixture requires an ARM64 Docker engine; found $architecture." >&2; exit 69 ;;
esac

verify_file() {
  file="$1"
  expected_bytes="$2"
  expected_sha="$3"
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "Required immutable fixture is missing or unsafe: $file" >&2; exit 66; }
  actual_bytes=$(wc -c < "$file" | tr -d '[:space:]')
  actual_sha=$(shasum -a 256 "$file" | awk '{print $1}')
  [ "$actual_bytes" = "$expected_bytes" ] && [ "$actual_sha" = "$expected_sha" ] || {
    echo "Immutable fixture identity mismatch: $file" >&2
    exit 65
  }
}

verify_file "$historical_root/sonuvi-bootstrap-kit-v2.tar" 236032 91b2d8cc171e5106ca87102a50e3e29392680f52b748c02ac9c5926a71d1b63d
verify_file "$corrected_root/sonuvi-bootstrap-kit-v2.tar" 238592 aec02a0ad716f6c979b2b2099099d913bee773e651f7159c402b022dfe113243
[ -d "$installed_root" ] && [ ! -L "$installed_root" ] || { echo 'Installed release fixture directory is missing or unsafe.' >&2; exit 66; }

if docker image inspect "$tag" >/dev/null 2>&1; then
  echo "Refusing to reuse pre-existing fixture image tag: $tag" >&2
  exit 73
fi
if docker container inspect "$name" >/dev/null 2>&1; then
  echo "Refusing to reuse pre-existing fixture container name: $name" >&2
  exit 73
fi

cleanup() {
  if [ "$started" -eq 1 ]; then docker stop --time 10 "$name" >/dev/null 2>&1 || true; fi
  if [ "$built" -eq 1 ]; then docker image rm "$tag" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM

docker build --pull=false --tag "$tag" --file "$dockerfile" "$fixture_root"
built=1
docker run --detach --rm --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  --volume /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --volume "$repo_root:/sonuvi:ro" \
  --volume "$historical_root:/artifacts/historical:ro" \
  --volume "$installed_root:/artifacts/installed:ro" \
  --volume "$corrected_root:/artifacts/corrected:ro" \
  --network none --name "$name" "$tag" >/dev/null
started=1

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
[ "$ready" -eq 1 ] || { echo 'Disposable Debian systemd fixture did not become ready.' >&2; exit 70; }

docker exec --workdir /sonuvi "$name" node test/fixtures/systemd-upgrade/bootstrap-replacement-integration.mjs
