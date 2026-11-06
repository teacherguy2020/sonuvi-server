FROM node:20-bookworm-slim

# Disposable ARM64 protocol fixture only. Runtime source is supplied by the
# fixed host launcher; no Server release, production credential, or host state
# is mounted into this image.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y openssh-server sudo tar \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/local/bin/node /usr/bin/node \
 # The installer only verifies fixed executable presence before it provisions
 # the host. These disposable-fixture stubs keep that contract exercised
 # without pretending to execute the release's media or network runtime.
 && for executable in curl ffmpeg ffprobe flac metaflac mpc python3 scp ssh; do \
      if test ! -e "/usr/bin/$executable"; then ln -s /usr/bin/true "/usr/bin/$executable"; fi; \
    done

# The real target identity comes from this target-local value. It is fixed
# only within the disposable fixture image; no host identity is mounted.
RUN printf '%s\n' 'f1a4c7d09e3b4256816f0d2a4b8c9e17' > /etc/machine-id \
 && chmod 0444 /etc/machine-id

RUN groupadd --gid 12002 sonuvi-stage \
 # OpenSSH invokes the authorized_keys forced command through the account
 # shell.  Dispatcher enforcement, not a nologin shell, is the boundary.
 && useradd --uid 12002 --gid 12002 --home-dir /home/sonuvi-stage --shell /bin/sh --create-home sonuvi-stage \
 # Debian creates a newly added account with a locked (`!`) shadow entry,
 # which OpenSSH rejects before it evaluates a public key.  `x` is not a
 # usable password hash; PasswordAuthentication remains disabled in sshd.
 && usermod --password x sonuvi-stage \
 && install -d -o root -g root -m 0755 /run/sshd /run/secrets /etc/ssh/authorized_keys /usr/local/lib/sonuvi-fixture \
 && install -d -o root -g root -m 0700 /var/lib/sonuvi-bootstrap /var/lib/sonuvi-bootstrap/attempts /var/lib/sonuvi-bootstrap/uploads \
 && install -d -o root -g root -m 0755 /var/lib/sonuvi-bootstrap/releases

COPY app/ /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/
COPY release-trust-anchors.json /etc/sonuvi/release-trust-anchors.json
COPY fixture-release-envelope.json /usr/local/share/sonuvi-fixture-release-envelope.json
COPY seed-status.mjs /usr/local/lib/sonuvi-fixture/seed-status.mjs
COPY tcp-relay.mjs /usr/local/lib/sonuvi-fixture/tcp-relay.mjs
COPY systemctl-fixture.sh /usr/local/lib/sonuvi-fixture/systemctl-fixture.sh
COPY sshd_config /etc/ssh/sshd_config
COPY dispatcher.sh /usr/local/sbin/sonuvi-gate-c-archive-status-dispatch
COPY start.sh /usr/local/sbin/sonuvi-gate-c-archive-status-fixture-start

RUN chown -R root:root /var/lib/sonuvi-bootstrap/bootstrap-kit-v1 /etc/sonuvi /usr/local/lib/sonuvi-fixture /usr/local/share/sonuvi-fixture-release-envelope.json \
 && find /var/lib/sonuvi-bootstrap/bootstrap-kit-v1 -type d -exec chmod 0755 {} \; \
 && find /var/lib/sonuvi-bootstrap/bootstrap-kit-v1 -type f -exec chmod 0644 {} \; \
 && chmod 0644 /etc/sonuvi/release-trust-anchors.json /usr/local/share/sonuvi-fixture-release-envelope.json /usr/local/lib/sonuvi-fixture/tcp-relay.mjs \
 && install -o root -g root -m 0755 /usr/local/lib/sonuvi-fixture/systemctl-fixture.sh /usr/bin/systemctl \
 && chmod 0755 /usr/local/sbin/sonuvi-gate-c-archive-status-dispatch /usr/local/sbin/sonuvi-gate-c-archive-status-fixture-start \
 && printf '%s\n' \
      'sonuvi-stage ALL=(root) NOPASSWD: /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-release-stage.mjs, /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-bootstrap-status.mjs, /usr/bin/node /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/scripts/sonuvi-first-install-activate.mjs' \
      > /etc/sudoers.d/sonuvi-gate-c-archive-status \
 && chmod 0440 /etc/sudoers.d/sonuvi-gate-c-archive-status \
 && visudo -cf /etc/sudoers.d/sonuvi-gate-c-archive-status

EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/sonuvi-gate-c-archive-status-fixture-start"]
