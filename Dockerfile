# syntax=docker/dockerfile:1
#
# TaskManager on a VM — ONE image, ONE port. The same app as the Firebase
# deploy, with every Firebase service swapped for a local adapter
# (TM_PLATFORM=vm): SQLite for the documents, a JSON tree for the realtime
# data, the disk for files, the server's own sign-in, in-process jobs.
#
#   docker run -p 8080:8080 -v tm-data:/data -e APP_URL=https://tasks.example.com \
#     ghcr.io/panth977/ticket-tracker
#
# Everything is served on :8080 — the web app, /api, /v1, /mcp, /oauth,
# /identity, /blob, /rtdb, /c (artifacts) and the /live WebSocket. All state
# is under /data: mount a volume there. See docs (VM deploy) and .env.vm.example.

ARG NODE=22-bookworm-slim

# ─── build: everything, from source ──────────────────────────────────────────
FROM node:${NODE} AS build
ENV CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tm/shared build && pnpm --filter @tm/backend build
# The VM build of the SPA: firebase/* resolves to src/lib/platform/vm.
RUN TM_PLATFORM=vm pnpm --filter @tm/frontend build

# ─── deps: the server's production dependencies only ─────────────────────────
FROM node:${NODE} AS deps
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY qaqc/package.json qaqc/
COPY sdk/package.json sdk/
COPY driver/package.json driver/
RUN pnpm install --frozen-lockfile --prod --filter "@tm/backend..."

# ─── the image ───────────────────────────────────────────────────────────────
FROM node:${NODE}
LABEL org.opencontainers.image.source="https://github.com/Panth977/ticket-tracker" \
      org.opencontainers.image.description="TaskManager — tickets, boards and agents; the whole app on one port" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=deps /app ./
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/backend/lib backend/lib
COPY --from=build /src/backend/firestore.rules /src/backend/storage.rules /src/backend/database.rules.json /src/backend/firestore.indexes.json backend/
COPY --from=build /src/frontend/build frontend/build
COPY --from=build /src/firebase.json ./
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    TM_PLATFORM=vm \
    TM_DATA_DIR=/data \
    PORT=8080
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/config.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/lib/server.js"]
