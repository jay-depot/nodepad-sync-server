// ── MCP Server ─────────────────────────────────────────────────────────────────
// Exposes nodepad data via the Model Context Protocol.
// Supports two transports:
//   stdio  — default, for gateway/CLI integration
//   HTTP   — SSE + POST, for network access (--mcp-port)

import { createInterface } from "readline"
import { createServer, IncomingMessage, ServerResponse } from "http"
import type { Storage } from "../storage/index.js"
import type { Project, Block, SearchResult } from "../types.js"
import { embedText, embedBatch, cosineSimilarity } from "../embeddings/ollama.js"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface McpRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: { [key: string]: JsonValue }
}

interface McpResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: { [key: string]: JsonValue }
  error?: { code: number; message: string; data?: JsonValue }
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: { [key: string]: any }
    required?: string[]
  }
}

export class McpServer {
  private tools: ToolDefinition[] = [
    {
      name: "list_projects",
      description: "List all projects",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_project",
      description: "Get a project by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Project ID" } },
        required: ["id"],
      },
    },
    {
      name: "create_project",
      description: "Create a new project",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Project ID (optional, auto-generated if omitted)" },
          name: { type: "string", description: "Project name" },
        },
        required: ["name"],
      },
    },
    {
      name: "delete_project",
      description: "Delete a project and all its data",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Project ID" } },
        required: ["id"],
      },
    },
    {
      name: "get_block",
      description: "Get a single block by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Block ID" } },
        required: ["id"],
      },
    },
    {
      name: "create_block",
      description: "Create a new block in a project",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Block ID (optional)" },
          projectId: { type: "string", description: "Project ID" },
          text: { type: "string", description: "Block text content" },
          contentType: { type: "string", description: "Content type (claim, question, idea, etc.)", enum: ["entity", "claim", "question", "task", "idea", "reference", "quote", "definition", "opinion", "reflection", "narrative", "comparison", "thesis", "general"] },
          category: { type: "string", description: "Category label" },
        },
        required: ["projectId", "text"],
      },
    },
    {
      name: "update_block",
      description: "Update a block's text, type, or category",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Block ID" },
          projectId: { type: "string", description: "Project ID" },
          text: { type: "string", description: "New text" },
          contentType: { type: "string", description: "New content type" },
          category: { type: "string", description: "New category" },
          annotation: { type: "string", description: "New annotation" },
        },
        required: ["id", "projectId"],
      },
    },
    {
      name: "delete_block",
      description: "Delete a block",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Block ID" },
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["id", "projectId"],
      },
    },
    {
      name: "search_blocks",
      description: "Search across blocks. Supports full-text (FTS5/tsvector) and vector similarity search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (required for text mode; optional for vector mode)" },
          projectId: { type: "string", description: "Optional: filter by project" },
          limit: { type: "number", description: "Max results (default: 20)" },
          mode: { type: "string", description: "Search mode: 'text' (full-text) or 'vector' (semantic similarity)", enum: ["text", "vector"] },
        },
        required: [],
      },
    },
    {
      name: "get_graph",
      description: "Get the full graph (nodes + edges) for a project",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "find_connected",
      description: "Traverse the graph from a block to find connected blocks",
      inputSchema: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Starting block ID" },
          depth: { type: "number", description: "Traversal depth (default: 2, max: 5)" },
        },
        required: ["blockId"],
      },
    },
    {
      name: "get_synthesis",
      description: "Get ghost notes (synthesis insights) for a project",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "reindex_embeddings",
      description: "Re-generate embeddings for all blocks in a project (or all projects). Use after changing the embedding model.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional: only reindex this project" },
        },
      },
    },
    {
      name: "create_edge",
      description: "Create a connection (influencedBy edge) between two blocks",
      inputSchema: {
        type: "object",
        properties: {
          sourceBlockId: { type: "string", description: "Source block ID" },
          targetBlockId: { type: "string", description: "Target block ID" },
        },
        required: ["sourceBlockId", "targetBlockId"],
      },
    },
    {
      name: "delete_edge",
      description: "Remove a connection between two blocks",
      inputSchema: {
        type: "object",
        properties: {
          sourceBlockId: { type: "string", description: "Source block ID" },
          targetBlockId: { type: "string", description: "Target block ID" },
        },
        required: ["sourceBlockId", "targetBlockId"],
      },
    },
  ]

  private authToken: string
  private sseClients = new Set<(msg: string) => void>()
  /** Optional callback to broadcast ops to WebSocket sync clients. */
  private broadcastOp: ((type: string, payload: any, projectId?: string) => void) | null = null

  constructor(
    private storage: Storage,
    authToken?: string,
  ) {
    this.authToken = authToken || process.env.AUTH_TOKEN || "nodepad-sync-dev"
  }

  /** Set a callback for broadcasting ops to connected WebSocket sync clients. */
  setBroadcast(fn: (type: string, payload: any, projectId?: string) => void): void {
    this.broadcastOp = fn
  }

  // ── stdio transport ────────────────────────────────────────────────────────

  async startStdio(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })

    rl.on("line", async (line) => {
      try {
        const req: McpRequest = JSON.parse(line)
        const response = await this.handleRequest(req)
        process.stdout.write(JSON.stringify(response) + "\n")
      } catch {
        // Ignore malformed JSON
      }
    })

    this.sendNotification("initialized", { tools: this.tools })
  }

  // ── HTTP transport (SSE + POST) ────────────────────────────────────────────

  async startHttp(port: number): Promise<void> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleHttp(req, res)
    })

    return new Promise((resolve) => {
      server.listen(port, "0.0.0.0", () => {
        console.error(`MCP HTTP server listening on port ${port}`)
        resolve()
      })
    })
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`)

    // Health check — no auth required
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Auth check on all other routes
    const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")
      || url.searchParams.get("token") || ""
    if (token !== this.authToken) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    if (req.method === "GET" && url.pathname === "/mcp") {
      // SSE stream — responses and notifications
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      })

      const send = (msg: string) => {
        res.write(`data: ${msg}\n\n`)
      }

      this.sseClients.add(send)

      // Send initialized notification
      send(JSON.stringify({
        jsonrpc: "2.0",
        method: "initialized",
        params: { tools: this.tools },
      }))

      req.on("close", () => {
        this.sseClients.delete(send)
      })

      return
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      // JSON-RPC request
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", async () => {
        try {
          const mcpReq: McpRequest = JSON.parse(body)
          const response = await this.handleRequest(mcpReq)

          // Send response via SSE
          for (const send of this.sseClients) {
            send(JSON.stringify(response))
          }

          // Also respond directly for clients that don't use SSE
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify(response))
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end()
  }

  // ── Core request handler ───────────────────────────────────────────────────

  private sendNotification(method: string, params: any): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params })
    process.stdout.write(msg + "\n")
  }

  private async handleRequest(req: McpRequest): Promise<McpResponse> {
    const { id, method, params = {} } = req

    try {
      switch (method) {
        case "initialize":
          return this.ok(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "nodepad-sync", version: "0.1.0" },
          })

        case "tools/list":
          return this.ok(id, { tools: this.tools })

        case "tools/call":
          return await this.handleToolCall(id, params.name as string, (params.arguments || {}) as Record<string, JsonValue>)

        case "ping":
          return this.ok(id, {})

        default:
          return this.err(id, -32601, `Method not found: ${method}`)
      }
    } catch (err: any) {
      return this.err(id, -32603, err.message || "Internal error")
    }
  }

  private async handleToolCall(id: number | string, name: string, args: Record<string, JsonValue>): Promise<McpResponse> {
    switch (name) {
      case "list_projects": {
        const projects = await this.storage.listProjects()
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] })
      }

      case "get_project": {
        const project = await this.storage.getProject(args.id as string)
        if (!project) return this.err(id, -32602, "Project not found")
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] })
      }

      case "create_project": {
        const project: Project = {
          id: (args.id as string) || crypto.randomUUID(),
          name: args.name as string,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
        }
        await this.storage.createProject(project)
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] })
      }

      case "delete_project": {
        await this.storage.deleteProject(args.id as string)
        return this.ok(id, { content: [{ type: "text", text: "Deleted" }] })
      }

      case "get_block": {
        const block = await this.storage.getBlock(args.id as string)
        if (!block) return this.err(id, -32602, "Block not found")
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(block, null, 2) }] })
      }

      case "create_block": {
        const block: Block = {
          id: (args.id as string) || crypto.randomUUID(),
          projectId: args.projectId as string,
          text: args.text as string,
          timestamp: Date.now(),
          contentType: (args.contentType as string) || "general",
          category: args.category as string | undefined,
          isPinned: false,
          isUnrelated: false,
        }
        await this.storage.createBlock(block)
        this.broadcastOp?.("block:create", block, block.projectId)
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(block, null, 2) }] })
      }

      case "update_block": {
        await this.storage.updateBlock(args as any)
        this.broadcastOp?.("block:update", args, (args as any).projectId)
        return this.ok(id, { content: [{ type: "text", text: "Updated" }] })
      }

      case "delete_block": {
        await this.storage.deleteBlock(args.id as string, args.projectId as string)
        this.broadcastOp?.("block:delete", args, args.projectId as string)
        return this.ok(id, { content: [{ type: "text", text: "Deleted" }] })
      }

      case "search_blocks": {
        const mode = (args.mode as string) || "text"
        const projectId = args.projectId as string | undefined
        const limit = (args.limit as number) || 20

        if (mode === "vector") {
          const query = (args.query as string) || ""
          if (!query.trim()) {
            return this.err(id, -32602, "query is required for vector search")
          }
          const { embedding } = await embedText(query)
          const results = await this.storage.vectorSearch(embedding, projectId, limit)
          return this.ok(id, { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] })
        }

        const results = await this.storage.searchBlocks(
          args.query as string,
          projectId,
          limit,
        )
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] })
      }

      case "reindex_embeddings": {
        const projectId = args.projectId as string | undefined
        // Kick off async reindex — don't wait
        this.reindexAllEmbeddings(projectId)
        return this.ok(id, { content: [{ type: "text", text: "Reindex started in background" }] })
      }

      case "get_graph": {
        const graph = await this.storage.getGraph(args.projectId as string)
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] })
      }

      case "find_connected": {
        const depth = Math.min((args.depth as number) || 2, 5)
        const graph = await this.storage.findConnected(args.blockId as string, depth)
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] })
      }

      case "get_synthesis": {
        const notes = await this.storage.getGhostNotes(args.projectId as string)
        return this.ok(id, { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] })
      }

      case "create_edge": {
        await this.storage.createEdge(args as any)
        this.broadcastOp?.("edge:create", args, undefined)
        return this.ok(id, { content: [{ type: "text", text: "Created" }] })
      }

      case "delete_edge": {
        await this.storage.deleteEdge(args.sourceBlockId as string, args.targetBlockId as string)
        this.broadcastOp?.("edge:delete", args, undefined)
        return this.ok(id, { content: [{ type: "text", text: "Deleted" }] })
      }

      default:
        return this.err(id, -32602, `Unknown tool: ${name}`)
    }
  }

  private ok(id: number | string | null, result: any): McpResponse {
    return { jsonrpc: "2.0", id, result }
  }

  private err(id: number | string | null, code: number, message: string, data?: JsonValue): McpResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } }
  }

  /** Re-generate embeddings for all blocks that lack them (or all blocks if forced). */
  private async reindexAllEmbeddings(projectId?: string): Promise<void> {
    try {
      const projects = projectId
        ? [await this.storage.getProject(projectId)].filter(Boolean) as Project[]
        : await this.storage.listProjects()

      for (const project of projects) {
        const blocks = await this.storage.getBlocks(project.id)
        const batch: { block: Block; text: string }[] = []

        for (const block of blocks) {
          if (!block.text.trim()) continue
          const existing = await this.storage.getEmbedding(block.id)
          if (existing) continue // skip if already embedded
          batch.push({ block, text: block.text })
        }

        if (batch.length === 0) {
          console.log(`[reindex] ${project.name}: all ${blocks.length} blocks already embedded`)
          continue
        }

        console.log(`[reindex] ${project.name}: generating ${batch.length}/${blocks.length} embeddings…`)

        const texts = batch.map(b => b.text)
        const results = await embedBatch(texts)

        for (let i = 0; i < results.length; i++) {
          await this.storage.setEmbedding(batch[i].block.id, results[i].model, results[i].embedding)
        }

        console.log(`[reindex] ${project.name}: done (${results.length} embeddings stored)`)
      }

      console.log("[reindex] complete")
    } catch (err) {
      console.error("[reindex] error:", err)
    }
  }
}
