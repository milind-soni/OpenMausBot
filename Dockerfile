FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/sync-excalidraw-assets.mjs ./scripts/sync-excalidraw-assets.mjs
RUN npm ci

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ORIGIN_LOCAL_DATA_DIR=/data/origin

ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CONVEX_SITE_URL
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_CONVEX_SITE_URL=$NEXT_PUBLIC_CONVEX_SITE_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=deps /app/public/excalidraw ./public/excalidraw

RUN npm run build && npm prune --omit=dev

EXPOSE 3000
CMD ["npm", "run", "start"]
