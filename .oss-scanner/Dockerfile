# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# The scanner builds this with the repository as the build context (the root
# .dockerignore applies, so node_modules, build output and .env files stay out),
# then runs the image with NO network. Everything the server, the web UI and
# the unit tests need is fetched here. Electron, the bots' Chrome and the
# mobile apps are left out: neither the harness server nor its unit tests use
# them. See .oss-scanner/threat_model.md for what to look at and how to run it.
#
# Try it like the scanner does:
#   docker build -f .oss-scanner/Dockerfile -t omb-scan .
#   docker run --rm --network none omb-scan pnpm exec vitest run server/request-auth.test.ts

# Same Node line as the root Dockerfile and CI (package.json engines: node >=24).
FROM node:24-bookworm-slim

# git: tests create throwaway repositories and the engine drivers shell out to
# it. procps: process-tree tests read `ps`. curl: for reproducers against a
# running server.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# Never download Electron's runtime or a Playwright browser during install.
# pnpm comes from corepack, cached at a fixed path so it runs offline later.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Scanner contract: the checkout lives at /src.
COPY . /src
WORKDIR /src

# pnpm at exactly package.json#packageManager.
RUN corepack enable && corepack install

# Every workspace member from the committed lockfile. `prepare` (git hooks)
# is a no-op here because the build context has no .git.
RUN pnpm install --frozen-lockfile

# The shipped artifacts: the bundled harness server (dist-server/) and the web
# UI (dist/), as the root Dockerfile builds them.
RUN pnpm build:server && pnpm exec vite build

# From here on corepack must never reach for the network.
ENV COREPACK_ENABLE_NETWORK=0

# Cheap smoke run of core security suites, so a broken image shows in the
# build log. A failing test does not fail the build.
RUN timeout 600 pnpm exec vitest run \
      server/request-auth.test.ts \
      server/browser/egress/gate.test.ts \
      server/browser/egress/policy.test.ts \
  || echo "WARNING: smoke tests reported failures"

CMD ["bash"]
