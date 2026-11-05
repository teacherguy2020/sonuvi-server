#!/bin/sh
# The host launcher mounts only a test-only host key and client public key.
# The durable state and staged release tree live in the disposable container.
set -eu

host_key=/run/secrets/ssh_host_ed25519_key
authorized_key=/run/secrets/authorized_keys
authorized_keys=/etc/ssh/authorized_keys/sonuvi-stage

[ -f "$host_key" ] && [ ! -L "$host_key" ] || { echo fixture_host_key_missing >&2; exit 64; }
[ -f "$authorized_key" ] && [ ! -L "$authorized_key" ] || { echo fixture_authorized_key_missing >&2; exit 64; }

install -o root -g root -m 0600 "$host_key" /etc/ssh/ssh_host_ed25519_key
install -d -o root -g root -m 0755 /etc/ssh/authorized_keys
{
  printf '%s' 'command="/usr/local/sbin/sonuvi-gate-c-archive-status-dispatch",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty '
  cat "$authorized_key"
} > "$authorized_keys"
chown root:root "$authorized_keys"
# sshd performs this lookup after privilege separation as the target account.
# The file contains a public key only: root owns it and 0644 keeps it
# immutable to the test account while allowing OpenSSH to read it.
chmod 0644 "$authorized_keys"

/usr/bin/node /usr/local/lib/sonuvi-fixture/seed-status.mjs
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
