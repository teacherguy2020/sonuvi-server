#!/usr/bin/env bash
# Stage-only verifier for the 2026-11-11 moOde VM display wake repair.
set -euo pipefail

if [[ $# -ne 1 || ! -d $1 ]]; then
	echo "usage: $0 STAGED_DIRECTORY" >&2
	exit 64
fi

stage_dir=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

verify_file() {
	local file=$1 expected_hash=$2 required=$3
	[[ -f "$stage_dir/$file" && ! -L "$stage_dir/$file" ]] || {
		echo "missing regular staged file: $file" >&2
		exit 1
	}
	[[ $(sha256sum "$stage_dir/$file" | awk '{print $1}') == "$expected_hash" ]] || {
		echo "unexpected baseline hash: $file" >&2
		exit 1
	}
	grep -Fq -- "$required" "$stage_dir/$file" || {
		echo "unexpected baseline block: $file" >&2
		exit 1
	}
}

verify_file worker.php \
	e81a2ab17607d17913cc6ba2f5b2e9694238392ee9d63e9f982c8d66bcc6d5a1 \
	"function chkAttachedDisplayPlaybackActive(\$mpdState)"
verify_file watchdog.sh \
	d0ac04a6894745bd1467ed61736e4d402089390a6998e07d65430400866e46f2 \
	"NP_JSON=\$(curl -s --max-time 1 \"http://\$REMOTE_HOST:3101/now-playing\")"

worker_mode=$(stat -c %a "$stage_dir/worker.php")
watchdog_mode=$(stat -c %a "$stage_dir/watchdog.sh")
for patch_name in worker-vm-display-wake-20261111.patch watchdog-vm-display-wake-20261111.patch; do
	patch --dry-run -d "$stage_dir" -p0 -i "$script_dir/$patch_name"
done
for patch_name in worker-vm-display-wake-20261111.patch watchdog-vm-display-wake-20261111.patch; do
	patch -d "$stage_dir" -p0 -i "$script_dir/$patch_name"
done
[[ $(stat -c %a "$stage_dir/worker.php") == "$worker_mode" ]] || { echo "worker.php mode changed" >&2; exit 1; }
[[ $(stat -c %a "$stage_dir/watchdog.sh") == "$watchdog_mode" ]] || { echo "watchdog.sh mode changed" >&2; exit 1; }
[[ $(sha256sum "$stage_dir/worker.php" | awk '{print $1}') == 585db6691761ea92c212af366602bf95026ffd35aa8ff1ce15d8b2dcbe7af8a6 ]]
[[ $(sha256sum "$stage_dir/watchdog.sh" | awk '{print $1}') == f9a805f6a2015207a2cc1f8280ad44df49f1065f1cdc92fd8fa245e33389782d ]]
echo "staged VM display wake repair verified"
