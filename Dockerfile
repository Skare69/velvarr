# Velvarr container: multi-stage, reproducible, secrets only at runtime.
# Build needs no VELVARR_* secrets; .dockerignore keeps .env* out of the context entirely.

# Install stage: Bun 1.3.14 with the frozen lockfile produces node_modules for the Node build.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build stage: Next standalone output compiled by Node 24.21.0. No env secrets required.
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ./node_modules/.bin/next build

# Runtime stage: non-root, writable /data only, loopback-published port via compose.
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=6699 \
    VELVARR_DATA_DIR=/data
# The image-owned /data gives a first-use named volume velvarr ownership in compose.
RUN groupadd --system --gid 10001 velvarr \
 && useradd --system --uid 10001 --gid velvarr --home-dir /app --shell /usr/sbin/nologin velvarr \
 && mkdir -p /data \
 && chown velvarr:velvarr /data
# Code stays root-owned and world-readable so app-level code execution cannot
# rewrite it; the runtime user may write only /data.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER velvarr
EXPOSE 6699
VOLUME /data
# /api/status reads storage: with a /data the runtime user cannot open it
# answers 500, so the container goes unhealthy. /api/health is static 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6699/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
