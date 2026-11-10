FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git nodejs python3 util-linux gcc libc6-dev systemd systemd-sysv \
    && rm -rf /var/lib/apt/lists/*

# The same image also runs the complete unprivileged source regression suite.
RUN apt-get update && apt-get install -y --no-install-recommends patch \
    && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
