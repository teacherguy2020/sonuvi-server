FROM debian:bookworm-slim

# This image is solely a disposable, local protocol fixture. It contains no
# Sonuvi runtime, release kit, sudo policy, or production credentials.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y openssh-server \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 12001 sonuvi-sftp \
 && useradd --uid 12001 --gid 12001 --home-dir /staging --shell /usr/sbin/nologin --no-create-home sonuvi-sftp \
 && usermod --password '*' sonuvi-sftp \
 && install -d -o root -g root -m 0755 /run/sshd /run/secrets /etc/ssh/authorized_keys \
 && install -d -o root -g root -m 0755 /srv/sonuvi-sftp-fixture/chroot \
 && install -d -o sonuvi-sftp -g sonuvi-sftp -m 0700 /srv/sonuvi-sftp-fixture/chroot/staging

COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /usr/local/sbin/sonuvi-gate-c-sftp-fixture-start
RUN chmod 0755 /usr/local/sbin/sonuvi-gate-c-sftp-fixture-start

EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/sonuvi-gate-c-sftp-fixture-start"]
