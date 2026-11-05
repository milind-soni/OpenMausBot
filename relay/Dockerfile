# syntax=docker/dockerfile:1
# Built from relay/ alone: docker build -t omb-relay relay/
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS deps
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --config.node-linker=hoisted

# No shell and no package manager at runtime. The files stay root-owned, so the relay cannot change its own code.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 65532:65532
ENV NODE_ENV=production
EXPOSE 8080
CMD ["--disable-warning=ExperimentalWarning", "src/main.ts"]
