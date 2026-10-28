#!/usr/bin/env bash
set -euo pipefail

# Fail before invoking any network, filesystem, or service-management command.
# This is a retirement notice, not a replacement installer/deployer.
printf '%s\n' \
  'In-place file deployment retired.' \
  'Do not patch /opt/now-playing or an immutable /opt/sonuvi release in place.' \
  'Use an approved release artifact and docs/runbooks/sonuvi-server-operations.md.' \
  'A main checkout alone is not the reviewed immutable-release bundle.' >&2
if [[ "$#" -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  exit 0
fi
exit 2
