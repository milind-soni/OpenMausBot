# OpenMausBot harness server — hosted/self-hosted tenant image.
#
# Two stages: build the renderer + the self-contained server bundle, then ship
# only those artifacts on a slim Node runtime. The server keeps binding
# 127.0.0.1 inside the container (the loopback-trust invariant is the auth
# model); deploy/docker-compose.yml puts Caddy in the same network namespace
# to terminate TLS and authentication at the edge.
#
#   docker build -t openmausbot .
#   docker build --build-arg ENGINES="@anthropic-ai/claude-code@2.1.263 @openai/codex@0.153.4" -t openmausbot .
#
# HOME is the /data volume, so engine CLI logins (~/.claude, ~/.codex, ...) and
# OpenMausBot's own state (~/.openmausbot) persist across container restarts.

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
WORKDIR /src
# pinned to package.json#packageManager; corepack is being removed from Node
RUN npm install -g pnpm@10.33.0
# The image never runs Electron, so skip its ~100MB postinstall download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# every workspace member's manifest must exist before install resolves the lockfile
COPY apps/docs/package.json ./apps/docs/package.json
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:server && pnpm exec vite build

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
# Install Chrome's Bookworm libraries directly: agent-browser --with-deps
# invokes sudo even as root, and this image deliberately does not ship sudo.
# git + curl: agent CLIs shell out to git; curl backs the healthcheck
ARG DEBIAN_SNAPSHOT=20260907T000000Z
RUN printf '%s\n' \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
    > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /data --shell /bin/bash maus
WORKDIR /app
COPY --from=build --chown=maus:maus /src/dist-server ./dist-server
COPY --from=build --chown=maus:maus /src/dist ./dist
# Optional engine CLIs baked into the image (space-separated npm packages).
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
# The bots' browser (docs/plans/browser-engine.md): the pinned agent-browser
# and a Chrome for Testing with its libraries, so a server bot can browse.
# Pin here and in server/browser-engine-release.ts together.
ARG AGENT_BROWSER_VERSION=0.37.0
ARG CHROME_FOR_TESTING_VERSION=152.0.7977.82
ARG CHROME_FOR_TESTING_SHA256=0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
  && curl -fsSL --retry 3 "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip" -o /tmp/chrome.zip \
  && echo "${CHROME_FOR_TESTING_SHA256}  /tmp/chrome.zip" | sha256sum -c - \
  && mkdir -p "/opt/openmausbot-browser/.agent-browser/browsers/chrome-${CHROME_FOR_TESTING_VERSION}" \
  && unzip -q /tmp/chrome.zip -d /tmp \
  && cp -a /tmp/chrome-linux64/. "/opt/openmausbot-browser/.agent-browser/browsers/chrome-${CHROME_FOR_TESTING_VERSION}/" \
  && rm -rf /tmp/chrome.zip /tmp/chrome-linux64 \
  && ln -s "/opt/openmausbot-browser/.agent-browser/browsers/chrome-${CHROME_FOR_TESTING_VERSION}/chrome" /opt/openmausbot-browser/chrome \
  && agent-browser --version
# Keep the baked-in browser outside both root's private home and /data,
# which may be an existing mounted volume. Session state still lives in HOME.
ENV HOME=/data \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/openmausbot-browser/chrome \
    OMB_DATA_DIR=/data/.openmausbot \
    OMB_STATIC_DIR=/app/dist \
    OMB_PORT=8799 \
    OMB_WEBHOOK_PORT=8800 \
    NODE_ENV=production
VOLUME ["/data"]
USER maus
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8799/api/health | grep -q openmausbot || exit 1
CMD ["node", "dist-server/index.js"]
