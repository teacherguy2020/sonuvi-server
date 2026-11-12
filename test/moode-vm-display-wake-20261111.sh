#!/usr/bin/env bash
# Offline replay. The target PHP runner is test/moode-vm-display-wake-20261111.php.
set -euo pipefail
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d "$repo/.moode-vm-wake.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
stage=$tmp/stage; bin=$tmp/bin; mkdir "$stage" "$bin"
cp --preserve=mode "$repo/test/fixtures/moode-vm-display-20261111/worker.php" "$stage/worker.php"
cp --preserve=mode "$repo/test/fixtures/moode-vm-display-20261111/watchdog.sh" "$stage/watchdog.sh"
"$repo/docs/references/moode/stage-vm-display-wake-20261111.sh" "$stage" >/dev/null
bash -n "$stage/watchdog.sh"
# Execute the actual patched wake branch once, with only command stubs.
for c in sqlite3 mpc cat curl xset pgrep systemctl moodeutl sleep cec-ctl; do
  tee "$bin/$c" >/dev/null <<'STUB'
#!/usr/bin/env bash
case ${0##*/} in
sqlite3) case "$*" in *local_display_url*) echo "$STUB_URL";; *local_display*) echo 1;; *peppy_display*) echo 0;; *multiroom_tx*) echo Off;; *device*) echo 0;; *wake_display*) echo 1;; *peppy_scn_blank_active*) echo 0;; esac;;
mpc) [[ $STUB_MPD == play ]] && echo '[playing]';;
cat) [[ $1 == /proc/asound/* ]] && { echo "$STUB_ALSA"; exit; }; exec /bin/cat "$@";;
curl) echo "$*" >>"$STUB_LOG/curl"; printf '%s' "$STUB_JSON";;
xset) touch "$STUB_LOG/woke";;
pgrep) echo 1;;
esac
STUB
  chmod +x "$bin/$c"
done
sed 's/^while true; do$/for _ in 1; do/' "$stage/watchdog.sh" >"$tmp/once.sh"
run() {
  local n=$1 u=$2 m=$3 a=$4 j=$5 w=$6 c=$7 log=$tmp/$1; mkdir "$log"
  STUB_URL="$u" STUB_MPD="$m" STUB_ALSA="$a" STUB_JSON="$j" STUB_LOG="$log" PATH="$bin:$PATH" bash +e "$tmp/once.sh" 1
  [[ -f $log/woke ]] && got=1 || got=0; [[ $got == "$w" ]] || { echo "$n wake" >&2; exit 1; }
  [[ -f $log/curl ]] && grep -Fq -- '--config /etc/sonuvi-moode-vm/led-curl.conf' "$log/curl" && got=1 || got=0; [[ $got == "$c" ]] || { echo "$n config" >&2; exit 1; }
}
vm='https://10.0.0.65:8443/display.html?mode=index&kiosk=1'; other='https://display.example:8443/display.html'
run local-play-health "$vm" play closed '{"state":"health"}' 1 0
run local-alsa-health "$vm" pause S32_LE '{"state":"health"}' 1 0
run pretty-play "$vm" pause closed $'{\n "state" : "play"\n}' 1 1
run airplay "$vm" pause closed '{"state":"pause","isAirplay":true}' 1 1
run upnp "$vm" pause closed '{"state":"pause","isUpnp":true}' 1 1
run mills "$vm" pause closed '{"state":"pause","millsMode":true}' 1 1
run paused "$vm" pause closed '{"state":"pause"}' 0 1
run stopped "$vm" pause closed '{"state":"stop"}' 0 1
run malformed "$vm" pause closed '{bad' 0 1
run http401 "$vm" pause closed '401 unauthorized' 0 1
run other-host "$other" pause closed '{"state":"play"}' 1 0
echo 'PASS: patched watchdog branch with stubs; target PHP runner emitted'
