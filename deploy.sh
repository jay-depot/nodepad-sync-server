#!/usr/bin/env bash
# ── deploy.sh ───────────────────────────────────────────────────────────────────
# Build and run nodepad-sync-server with Ollama on the NAS.
# Usage:
#   ./deploy.sh                          # SQLite mode
#   AUTH_TOKEN="hunter2" ./deploy.sh     # Custom auth token
#   ./deploy.sh --pg                     # Postgres mode
#
# Prerequisites: docker

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

AUTH_TOKEN="${AUTH_TOKEN:-nodepad-sync-dev}"
MODE="${1:-sqlite}"
NETWORK="nodepad-net"

echo "==> Building nodepad-sync-server image..."
docker build -t nodepad-sync-server .

# Create shared network if it doesn't exist
docker network inspect "$NETWORK" > /dev/null 2>&1 || docker network create "$NETWORK"

# ── Ollama (always) ────────────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -q '^nodepad-ollama$'; then
  echo "==> Starting Ollama..."
  docker run -d \
    --name nodepad-ollama \
    --restart unless-stopped \
    --network "$NETWORK" \
    -p 11434:11434 \
    -v nodepad-ollama-models:/root/.ollama \
    ollama/ollama:latest

  echo "   Waiting for Ollama..."
  until curl -s http://127.0.0.1:11434/api/version > /dev/null 2>&1; do sleep 2; done
  echo "   Ollama ready."
else
  echo "==> Ollama already running."
fi

# ── Postgres (optional) ─────────────────────────────────────────────────────────
if [ "$MODE" = "--pg" ] || [ "$MODE" = "pg" ]; then
  if ! docker ps --format '{{.Names}}' | grep -q '^nodepad-pg$'; then
    echo "==> Starting Postgres..."
    docker run -d \
      --name nodepad-pg \
      --restart unless-stopped \
      --network "$NETWORK" \
      -e POSTGRES_USER=nodepad \
      -e POSTGRES_PASSWORD=nodepad \
      -e POSTGRES_DB=nodepad \
      -v nodepad-pg-data:/var/lib/postgresql/data \
      postgres:17-alpine

    echo "   Waiting for Postgres..."
    until docker exec nodepad-pg pg_isready -U nodepad 2>/dev/null; do sleep 2; done
    echo "   Postgres ready."
  else
    echo "==> Postgres already running."
  fi

  DB_URL="postgresql://nodepad:nodepad@nodepad-pg:5432/nodepad"
  DB_TYPE="postgres"
  VOLUME=""
else
  DB_URL=""
  DB_TYPE="sqlite"
  VOLUME="-v nodepad-sync-data:/app/data"
fi

# ── Sync server ─────────────────────────────────────────────────────────────────
echo "==> Starting sync server..."

# Remove old container if it exists
docker rm -f nodepad-sync 2>/dev/null || true

docker run -d \
  --name nodepad-sync \
  --restart unless-stopped \
  --network "$NETWORK" \
  -p 3001:3001 \
  -p 3100:3100 \
  -e PORT=3001 \
  -e MCP_PORT=3100 \
  -e AUTH_TOKEN="${AUTH_TOKEN}" \
  -e DB_TYPE="${DB_TYPE}" \
  ${DB_URL:+-e DB_URL="${DB_URL}"} \
  -e OLLAMA_URL="http://nodepad-ollama:11434" \
  -e EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}" \
  $VOLUME \
  nodepad-sync-server

echo ""
echo "==> Done!"
echo "    Sync WebSocket : ws://<nas-ip>:3001"
echo "    MCP HTTP       : http://<nas-ip>:3100/mcp"
echo "    Auth token     : ${AUTH_TOKEN}"
echo "    Storage        : ${DB_TYPE}${DB_URL:+ (postgres)}"
echo ""
echo "    To pull the embedding model on first run:"
echo "    docker logs -f nodepad-sync"
