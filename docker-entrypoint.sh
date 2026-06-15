#!/bin/sh
# ── docker-entrypoint.sh ────────────────────────────────────────────────────────
# Waits for Ollama, pulls the embedding model, then starts the sync server.

set -e

EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"

# Wait for Ollama to be ready
echo "[entrypoint] Waiting for Ollama at ${OLLAMA_URL}..."
until wget -q -O /dev/null "${OLLAMA_URL}/api/version" 2>/dev/null; do
  sleep 2
done
echo "[entrypoint] Ollama is ready."

# Pull the embedding model via HTTP API
echo "[entrypoint] Pulling embedding model: ${EMBEDDING_MODEL}..."
node -e "
const http = require('http');
const data = JSON.stringify({ name: '${EMBEDDING_MODEL}' });
const req = http.request('${OLLAMA_URL}/api/pull', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('[entrypoint] Model pulled successfully');
    } else {
      console.error('[entrypoint] Pull returned', res.statusCode, body.slice(0, 200));
    }
  });
});
req.on('error', (e) => console.error('[entrypoint] Pull error:', e.message));
req.write(data);
req.end();
" 2>&1
echo "[entrypoint] Embedding model ready."

# Start the sync server
exec node dist/index.js "$@"