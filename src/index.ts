// ── nodepad sync server entry point ────────────────────────────────────────────
// Usage:
//   npm start                    # SQLite, port 3001, MCP on stdio
//   DB_TYPE=postgres npm start   # PostgreSQL
//   PORT=8080 npm start          # Custom port
//   AUTH_TOKEN=secret npm start  # Custom auth token
//
// MCP mode (stdio):
//   npm start -- --mcp           # Run as MCP server only (stdio)

import { createStorage } from "./storage/index.js"
import { SyncServer } from "./sync/server.js"
import { McpServer } from "./mcp/server.js"

const PORT = parseInt(process.env.PORT || "3001", 10)
const AUTH_TOKEN = process.env.AUTH_TOKEN || "nodepad-sync-dev"

async function main() {
  const storage = await createStorage()
  await storage.init()

  const isMcpOnly = process.argv.includes("--mcp")

  if (isMcpOnly) {
    // MCP stdio mode — used by MCP clients (OpenClaw gateway, etc.)
    const mcp = new McpServer(storage)
    await mcp.start()
    console.error("MCP server started on stdio")
  } else {
    // Full server: sync + MCP on separate port
    const sync = new SyncServer(storage, PORT, AUTH_TOKEN)
    await sync.start()

    // MCP server on stdio (for gateway integration)
    const mcp = new McpServer(storage)
    await mcp.start()

    console.error(`Sync server running on port ${PORT}`)
    console.error(`MCP server running on stdio`)
    console.error(`Auth token: ${AUTH_TOKEN}`)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
