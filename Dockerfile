FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/sync-excalidraw-assets.mjs ./scripts/sync-excalidraw-assets.mjs
RUN npm ci

FROM node:24-alpine AS build

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=2048

ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CONVEX_SITE_URL
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_CONVEX_SITE_URL=$NEXT_PUBLIC_CONVEX_SITE_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=deps /app/public/excalidraw ./public/excalidraw

RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV ORIGIN_LOCAL_DATA_DIR=/data/origin
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/runner ./runner

EXPOSE 3000
CMD ["node", "server.js"]
