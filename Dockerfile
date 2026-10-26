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
#
# THE ICEBASE IMAGE (--target icebase): the same app inside the IceBase server
# (`icebase serve`, backend/icebase.config.ts, TM_PLATFORM=icebase) — its database,
# auth, storage, realtime database and task queues; state under /data/icebase.
#
#   docker build --target icebase -t ticket-tracker:icebase .
#   docker run -p 8080:8080 -v tm-data:/data -e APP_URL=https://tasks.example.com ticket-tracker:icebase
#
# Branding: -e TM_APP_NAME="Acme Tasks" -v ./logo.png:/branding/logo.png:ro
# names the app and makes every icon (favicon, PWA, Apple touch) from the logo
# when the server starts (backend/src/runtime/brand.ts).

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

# The IceBase build of the SPA: Firestore / RTDB from IceBase's compat, Auth and Storage at the origin.
FROM build AS build-icebase
RUN TM_PLATFORM=icebase pnpm --filter @tm/frontend build

# ─── deps: the server's production dependencies only ─────────────────────────
FROM node:${NODE} AS deps
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY qaqc/package.json qaqc/
COPY sdk/package.json sdk/
COPY driver/package.json driver/
RUN pnpm install --frozen-lockfile --prod --filter "@tm/backend..."

# ─── the IceBase image (--target icebase) ────────────────────────────────────
FROM node:${NODE} AS icebase
LABEL org.opencontainers.image.source="https://github.com/Panth977/ticket-tracker" \
      org.opencontainers.image.description="TaskManager on the IceBase server — the whole app on one port" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=deps /app ./
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/backend/lib backend/lib
COPY --from=build /src/backend/icebase.config.ts /src/backend/firestore.rules /src/backend/storage.rules /src/backend/database.rules.json /src/backend/firestore.indexes.json backend/
COPY --from=build-icebase /src/frontend/build frontend/build
COPY --from=build /src/firebase.json ./
COPY --from=build /src/scripts/icebase.mjs /src/scripts/icebase-start.mjs scripts/
RUN mkdir -p /data && chown node:node /data
# ICEBASE_PUBLIC_URL defaults to APP_URL (signed file URLs); set ICEBASE_ADMIN_TOKEN to choose
# the admin token, else one is made once and kept in /data/icebase/admin-token.
ENV NODE_ENV=production \
    TM_PLATFORM=icebase \
    TM_DATA_DIR=/data \
    PORT=8080
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/config.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Branding and the SPA's runtime settings are applied to a copy of the web app first (as the VM server does).
CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/icebase-start.mjs"]

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
