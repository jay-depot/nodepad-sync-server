// ── WebSocket sync server ──────────────────────────────────────────────────────
// Handles real-time sync between nodepad clients and the server.

import { WebSocketServer, WebSocket } from "ws"
import { createServer, IncomingMessage } from "http"
import type { Storage } from "../storage/index.js"
import type { SyncMessage, SyncSnapshot } from "../types.js"

interface ClientState {
  ws: WebSocket
  lastSeq: number
  projectId: string | null
}

export class SyncServer {
  private wss!: WebSocketServer
  private clients = new Map<WebSocket, ClientState>()
  private seq = 0
  private opLog: SyncMessage[] = []

  constructor(
    private storage: Storage,
    private port: number,
    private authToken: string,
  ) {}

  async start(): Promise<void> {
    const server = createServer((req: IncomingMessage, res: any) => {
      // Health check
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    this.wss = new WebSocketServer({ server })

    this.wss.on("connection", (ws, req) => {
      // Auth via query param or header
      const url = new URL(req.url || "/", `http://${req.headers.host}`)
      const token = url.searchParams.get("token") || req.headers["x-auth-token"] as string

      if (token !== this.authToken) {
        ws.close(4001, "Unauthorized")
        return
      }

      const state: ClientState = { ws, lastSeq: 0, projectId: null }
      this.clients.set(ws, state)

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString())

          if (msg.type === "subscribe") {
            state.projectId = msg.projectId
            const snapshot = await this.storage.getSnapshot(msg.projectId)
            ws.send(JSON.stringify({ type: "snapshot", ...snapshot }))
            return
          }

          if (msg.type === "op") {
            const syncMsg: SyncMessage = {
              seq: ++this.seq,
              op: msg.op,
              clientTimestamp: msg.clientTimestamp || Date.now(),
            }

            // Persist
            await this.applyOp(syncMsg.op)

            // Log for replay
            this.opLog.push(syncMsg)
            if (this.opLog.length > 10000) this.opLog.shift()

            // Broadcast to other clients on the same project
            for (const [otherWs, otherState] of this.clients) {
              if (otherWs !== ws && otherState.projectId === state.projectId && otherWs.readyState === WebSocket.OPEN) {
                otherWs.send(JSON.stringify({ type: "op", ...syncMsg }))
              }
            }

            // Ack
            ws.send(JSON.stringify({ type: "ack", seq: syncMsg.seq }))
            return
          }

          if (msg.type === "catchup") {
            const fromSeq = msg.fromSeq || 0
            const ops = this.opLog.filter(o => o.seq > fromSeq)
            ws.send(JSON.stringify({ type: "ops", ops }))
            return
          }
        } catch (err) {
          console.error("WS message error:", err)
          ws.send(JSON.stringify({ type: "error", message: "Invalid message" }))
        }
      })

      ws.on("close", () => {
        this.clients.delete(ws)
      })
    })

    server.listen(this.port, "0.0.0.0", () => {
      console.log(`Sync server listening on port ${this.port}`)
    })
  }

  private async applyOp(op: SyncMessage["op"]): Promise<void> {
    switch (op.type) {
      case "project:create":
        await this.storage.createProject(op.payload as any)
        break
      case "project:update":
        await this.storage.updateProject(op.payload as any)
        break
      case "project:delete":
        await this.storage.deleteProject(op.payload.id)
        break
      case "block:create":
        await this.storage.createBlock(op.payload as any)
        break
      case "block:update":
        await this.storage.updateBlock(op.payload as any)
        break
      case "block:delete":
        await this.storage.deleteBlock(op.payload.id, op.payload.projectId)
        break
      case "edge:create":
        await this.storage.createEdge(op.payload as any)
        break
      case "edge:delete":
        await this.storage.deleteEdge(op.payload.sourceBlockId, op.payload.targetBlockId)
        break
      case "subtask:create":
        await this.storage.createSubTask(op.payload as any)
        break
      case "subtask:update":
        await this.storage.updateSubTask(op.payload as any)
        break
      case "subtask:delete":
        await this.storage.deleteSubTask(op.payload.id, op.payload.blockId)
        break
      case "ghost:create":
        await this.storage.createGhostNote(op.payload as any)
        break
      case "ghost:delete":
        await this.storage.deleteGhostNote(op.payload.id, op.payload.projectId)
        break
    }
  }
}
