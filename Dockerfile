# ── Multi-stage Docker build for nodepad-sync-server ────────────────────────────
# Builds TypeScript, then runs with a minimal Alpine runtime.

FROM node:22-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Runtime image ──────────────────────────────────────────────────────────────

FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

COPY --from=builder /build/dist/ ./dist/

EXPOSE 3001 3100
VOLUME /app/data

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]