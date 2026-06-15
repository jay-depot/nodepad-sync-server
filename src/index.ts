// ── nodepad sync server entry point ────────────────────────────────────────────
// Usage:
//   npm start                          # Full server: sync + MCP stdio
//   npm start -- --mcp                 # MCP stdio only
//   npm start -- --mcp-port 3100       # Full server + MCP HTTP on port 3100
//   npm start -- --mcp --mcp-port 3100 # MCP HTTP only (no sync)
//
// Env:
//   PORT=3001          Sync server port
//   MCP_PORT=3100      MCP HTTP port
//   AUTH_TOKEN=secret  Auth token for both sync and MCP
//   DB_TYPE=postgres   Storage backend
//   DB_URL=...         PostgreSQL connection string

import { createStorage } from "./storage/index.js"
import { SyncServer } from "./sync/server.js"
import { McpServer } from "./mcp/server.js"

const PORT = parseInt(process.env.PORT || "3001", 10)
const MCP_PORT = parseInt(process.env.MCP_PORT || process.argv[process.argv.indexOf("--mcp-port") + 1] || "3100", 10)
const AUTH_TOKEN = process.env.AUTH_TOKEN || "nodepad-sync-dev"

async function main() {
  const storage = await createStorage()
  await storage.init()

  const isMcpOnly = process.argv.includes("--mcp")
  const hasMcpHttp = process.argv.includes("--mcp-port") || process.env.MCP_PORT

  const mcp = new McpServer(storage, AUTH_TOKEN)

  if (isMcpOnly) {
    // MCP-only mode
    if (hasMcpHttp) {
      await mcp.startHttp(MCP_PORT)
      console.error(`MCP HTTP server on port ${MCP_PORT} (auth: ${AUTH_TOKEN})`)
    } else {
      await mcp.startStdio()
      console.error("MCP stdio server started")
    }
  } else {
    // Full server: sync + MCP
    const sync = new SyncServer(storage, PORT, AUTH_TOKEN)
    await sync.start()

    // MCP on stdio (for gateway integration)
    await mcp.startStdio()

    // MCP on HTTP (for network access)
    if (hasMcpHttp) {
      await mcp.startHttp(MCP_PORT)
      console.error(`MCP HTTP server on port ${MCP_PORT} (auth: ${AUTH_TOKEN})`)
    }

    console.error(`Sync server on port ${PORT} (auth: ${AUTH_TOKEN})`)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
