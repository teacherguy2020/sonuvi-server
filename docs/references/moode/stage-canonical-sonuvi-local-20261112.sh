#!/usr/bin/env bash
# Stage-only verifier for the canonical sonuvi.local moOde consumers.
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

file_mode() {
	stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

verify_file worker.php \
	585db6691761ea92c212af366602bf95026ffd35aa8ff1ce15d8b2dcbe7af8a6 \
	"function chkAttachedDisplayPlaybackActive(\$mpdState)"
verify_file watchdog.sh \
	f9a805f6a2015207a2cc1f8280ad44df49f1065f1cdc92fd8fa245e33389782d \
	'if [[ $WEBUI_DISPLAY_URL == https://10.0.0.65:8443/* ]]; then'
verify_file rgb_moode_service.py \
	e46fc10dd79cccf2094feb2d640e5f27057cf3c7385ac21efd95285ee9d218fb \
	'NOW_PLAYING_URL = "https://10.0.0.65:8443/now-playing"'

worker_mode=$(file_mode "$stage_dir/worker.php")
watchdog_mode=$(file_mode "$stage_dir/watchdog.sh")
rgb_mode=$(file_mode "$stage_dir/rgb_moode_service.py")

for patch_name in \
	worker-canonical-sonuvi-local.patch \
	watchdog-canonical-sonuvi-local.patch \
	rgb-canonical-sonuvi-local.patch; do
	patch --dry-run -d "$stage_dir" -p0 -i "$script_dir/$patch_name" >/dev/null
done
for patch_name in \
	worker-canonical-sonuvi-local.patch \
	watchdog-canonical-sonuvi-local.patch \
	rgb-canonical-sonuvi-local.patch; do
	patch -d "$stage_dir" -p0 -i "$script_dir/$patch_name" >/dev/null
done

[[ $(file_mode "$stage_dir/worker.php") == "$worker_mode" ]] || { echo "worker.php mode changed" >&2; exit 1; }
[[ $(file_mode "$stage_dir/watchdog.sh") == "$watchdog_mode" ]] || { echo "watchdog.sh mode changed" >&2; exit 1; }
[[ $(file_mode "$stage_dir/rgb_moode_service.py") == "$rgb_mode" ]] || { echo "rgb_moode_service.py mode changed" >&2; exit 1; }

[[ $(sha256sum "$stage_dir/worker.php" | awk '{print $1}') == 1e561186d2efe999e154154d01e638537ad890378e5276686d7e62a9086e48f9 ]]
[[ $(sha256sum "$stage_dir/watchdog.sh" | awk '{print $1}') == d000edebc9b747cbd85f582659a91575e21a96db37c262470a71fd182cad8346 ]]
[[ $(sha256sum "$stage_dir/rgb_moode_service.py" | awk '{print $1}') == 090c34ef35d4e1fccc94ffee7ddd9aee9819208e7d53ed45d649056b2c447ee5 ]]

bash -n "$stage_dir/watchdog.sh"
if command -v php >/dev/null 2>&1; then
	php -l "$stage_dir/worker.php" >/dev/null
else
	echo 'NOTE: php not installed; run php -l on the moOde target before activation' >&2
fi
python3 -B - "$stage_dir/rgb_moode_service.py" <<'PY'
import ast
import pathlib
import sys
ast.parse(pathlib.Path(sys.argv[1]).read_text())
PY

grep -Fq 'https://sonuvi.local/now-playing' "$stage_dir/worker.php"
grep -Fq "https://sonuvi.local/now-playing" "$stage_dir/watchdog.sh"
grep -Fq 'NOW_PLAYING_URL = "https://sonuvi.local/now-playing"' "$stage_dir/rgb_moode_service.py"
echo 'staged canonical sonuvi.local moOde consumers verified'
