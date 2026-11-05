#!/bin/sh
# OpenSSH invokes this through an authorized_keys forced command. It admits
# exactly the two reviewed iOS command strings and delegates to the real
# root-owned Gate C helpers; it never evaluates the original command.
set -eu

readonly_root=/var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts
status_command='/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs'
stage_command='/usr/bin/sudo -n /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs'

case "${SSH_ORIGINAL_COMMAND:-}" in
  "$status_command") exec /usr/bin/sudo -n /usr/bin/node "$readonly_root/sonuvi-bootstrap-status.mjs" ;;
  "$stage_command") exec /usr/bin/sudo -n /usr/bin/node "$readonly_root/sonuvi-release-stage.mjs" ;;
  *) printf '%s\n' 'sonuvi_gate_c_archive_status_fixture:operation_rejected' >&2; exit 126 ;;
esac
