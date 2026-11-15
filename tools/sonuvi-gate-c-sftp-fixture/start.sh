#!/bin/sh
# The host launcher bind-mounts only a lab-only host key and one lab-only
# client public key. Runtime storage is the disposable container layer.
set -eu

host_key=/run/secrets/ssh_host_ed25519_key
authorized_key=/run/secrets/authorized_keys

[ -f "$host_key" ] && [ ! -L "$host_key" ] || {
  echo 'fixture_host_key_missing' >&2
  exit 64
}
[ -f "$authorized_key" ] && [ ! -L "$authorized_key" ] || {
  echo 'fixture_authorized_key_missing' >&2
  exit 64
}

install -d -o root -g root -m 0755 /etc/ssh/authorized_keys
install -o sonuvi-sftp -g sonuvi-sftp -m 0600 "$authorized_key" /etc/ssh/authorized_keys/sonuvi-sftp
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
