#!/bin/sh
# Disposable fixture substitute for systemd. It accepts only the operations
# exercised by the fixed target installer; the production executable path and
# service names remain validated by the real installer code.
set -eu

case "$*" in
  'daemon-reload') exit 0 ;;
  'enable --now sonuvi-api.service'|'enable --now sonuvi-web.service') exit 0 ;;
  'disable --now sonuvi-api.service'|'disable --now sonuvi-web.service') exit 0 ;;
  'is-active --quiet sonuvi-api.service'|'is-active --quiet sonuvi-web.service') exit 0 ;;
  *) printf '%s\n' 'sonuvi_gate_c_fixture:unsupported_systemctl_operation' >&2; exit 64 ;;
esac
