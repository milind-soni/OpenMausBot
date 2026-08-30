FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
COPY companion/package.json ./companion/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:server

FROM node:24-bookworm-slim AS runtime

ARG CODEX_VERSION=0.146.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io git util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@openai/codex@${CODEX_VERSION}"

RUN groupadd --gid 10001 openmausbot-agent \
  && useradd --uid 10001 --gid 10001 --home-dir /home/openmausbot-agent --create-home --shell /usr/sbin/nologin openmausbot-agent \
  && install -d -m 0700 -o openmausbot-agent -g openmausbot-agent /home/openmausbot-agent/.codex \
  && install -d -m 0755 /opt/openmausbot

COPY --from=build /src/dist-server/collaboration-headless.js /opt/openmausbot/collaboration-headless.js
COPY --from=build /src/dist-server/collaboration/operations/docker-apply-patch.js /opt/openmausbot/docker-apply-patch.js

WORKDIR /opt/openmausbot
ENV NODE_ENV=production
ENTRYPOINT ["node", "/opt/openmausbot/collaboration-headless.js"]
