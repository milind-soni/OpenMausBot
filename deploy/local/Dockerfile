ARG BASE_IMAGE=ghcr.io/milind-soni/openmausbot:latest
FROM ${BASE_IMAGE}
USER root
ARG ENGINES="@anthropic-ai/claude-code @openai/codex"
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
# Grok Build from xAI's own installer, pinned and installed the same way as
# the Cloud image (the Dockerfile's cloud-home target); it signs in from the
# app with a device code into ~/.grok on the data volume. GROK_VERSION= leaves
# it out.
ARG GROK_VERSION=1.0.41
RUN if [ -n "$GROK_VERSION" ]; then \
      mkdir -p /tmp/grok-install \
      && curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install/install.sh \
      && HOME=/tmp/grok-install PATH="/tmp/grok-install/.grok/bin:$PATH" bash /tmp/grok-install/install.sh "$GROK_VERSION" \
      && install -m 0755 "$(readlink -f /tmp/grok-install/.grok/bin/grok)" /usr/local/bin/grok \
      && HOME=/tmp/grok-install grok --version | grep -qF "grok $GROK_VERSION " \
      && rm -rf /tmp/grok-install; \
    fi
# Docker-in-Docker, opt in: DIND=1 adds the Docker engine and /usr/local/bin/omb-dind-start,
# an entrypoint that starts dockerd and then the server as `maus`. Run it with
# `privileged: true`, `user: "0:0"` and a volume on /var/lib/docker.
ARG DIND=""
ARG DOCKER_VERSION=27.5.1
ARG TARGETARCH
COPY dind-start.sh /usr/local/bin/omb-dind-start
RUN if [ -n "$DIND" ]; then \
      docker_arch=x86_64 && if [ "$TARGETARCH" = arm64 ]; then docker_arch=aarch64; fi \
      && apt-get update \
      && apt-get install -y --no-install-recommends iptables \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_VERSION}.tgz" \
        | tar -xz -C /usr/local/bin --strip-components=1 \
      && chmod 0755 /usr/local/bin/omb-dind-start \
      && docker --version | grep -qF "$DOCKER_VERSION" \
      && dockerd --version | grep -qF "$DOCKER_VERSION"; \
    else rm /usr/local/bin/omb-dind-start; fi
USER maus
