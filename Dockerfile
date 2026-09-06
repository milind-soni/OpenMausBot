# OpenMausBot harness server — hosted/self-hosted tenant image.
#
# Two stages: build the renderer + the self-contained server bundle, then ship
# only those artifacts on a slim Node runtime. The server keeps binding
# 127.0.0.1 inside the container (the loopback-trust invariant is the auth
# model); deploy/docker-compose.yml puts Caddy in the same network namespace
# to terminate TLS and authentication at the edge.
#
#   docker build -t openmausbot .
#   docker build --build-arg ENGINES="@anthropic-ai/claude-code @openai/codex" -t openmausbot .
#
# HOME is the /data volume, so engine CLI logins (~/.claude, ~/.codex, ...) and
# OpenMausBot's own state (~/.openmausbot) persist across container restarts.

FROM node:24-bookworm-slim AS build
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

FROM node:24-bookworm-slim
# Install Chrome's Bookworm libraries directly: agent-browser --with-deps
# invokes sudo even as root, and this image deliberately does not ship sudo.
# git + curl: agent CLIs shell out to git; curl backs the healthcheck
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
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
ARG AGENT_BROWSER_VERSION=0.36.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
  && HOME=/opt/openmausbot-browser agent-browser install \
  && ln -s /opt/openmausbot-browser/.agent-browser/browsers/chrome-*/chrome /opt/openmausbot-browser/chrome \
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
