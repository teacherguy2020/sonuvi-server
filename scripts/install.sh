#!/usr/bin/env bash
set -euo pipefail

# Fail before invoking any network, filesystem, or service-management command.
# This is a retirement notice, not a replacement installer/deployer.
printf '%s\n' \
  'Legacy installer retired.' \
  'The former installer recreated now-playing services and could delete runtime state.' \
  'Use an approved release artifact and docs/runbooks/sonuvi-server-operations.md.' \
  'A main checkout alone is not the reviewed immutable-release bundle.' >&2
if [[ "$#" -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  exit 0
fi
exit 2
