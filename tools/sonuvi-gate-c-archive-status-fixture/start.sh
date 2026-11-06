#!/bin/sh
# The host launcher mounts only a test-only host key and client public key.
# The durable state and staged release tree live in the disposable container.
set -eu

host_key=/run/secrets/ssh_host_ed25519_key
authorized_key=/run/secrets/authorized_keys
sudo_password_file=/run/secrets/sudo_password
authorized_keys=/etc/ssh/authorized_keys/sonuvi-stage

[ -f "$host_key" ] && [ ! -L "$host_key" ] || { echo fixture_host_key_missing >&2; exit 64; }
[ -f "$authorized_key" ] && [ ! -L "$authorized_key" ] || { echo fixture_authorized_key_missing >&2; exit 64; }
[ -f "$sudo_password_file" ] && [ ! -L "$sudo_password_file" ] || { echo fixture_sudo_password_missing >&2; exit 64; }

# This disposable fixture receives a test-only password through a read-only
# secret mount. It is supplied to chpasswd over stdin, never as an argument,
# and is not copied into bootstrap state, logs, or the build image.
sudo_password="$(cat "$sudo_password_file")"
[ -n "$sudo_password" ] || { echo fixture_sudo_password_empty >&2; exit 64; }
printf 'sonuvi-stage:%s\n' "$sudo_password" | chpasswd
unset sudo_password

# Model the fixed user-owned SFTP staging namespace used before the first
# root operation. The archive is generated from this disposable fixture's
# root-owned kit and is never a production or host artifact.
staging_root=/home/sonuvi-stage/.local/share/sonuvi-bootstrap-v1
install -d -o sonuvi-stage -g sonuvi-stage -m 0700 /home/sonuvi-stage/.local /home/sonuvi-stage/.local/share "$staging_root"
tar --create --file "$staging_root/sonuvi-bootstrap-kit-v1.tar" --directory /var/lib/sonuvi-bootstrap/bootstrap-kit-v1 scripts/sonuvi-target-preflight.sh
chown sonuvi-stage:sonuvi-stage "$staging_root/sonuvi-bootstrap-kit-v1.tar"
chmod 0600 "$staging_root/sonuvi-bootstrap-kit-v1.tar"

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
