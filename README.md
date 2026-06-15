# nodepad-sync-server

Sync relay and MCP gateway for the Electrified, Ollama'd fork of nodepad.

Single Node.js/TypeScript process, dual-mode: a **WebSocket sync server** for real-time multi-device nodepad sync, and an **MCP server** (stdio + HTTP) for AI-agent access to nodepad data — search, CRUD, graph traversal, synthesis.

---

## Quick start

```bash
npm install
npm start
```

Starts the sync server on `ws://localhost:3001` and an MCP server on stdio.

Default auth token: `nodepad-sync-dev` (set `AUTH_TOKEN` to change it).

---

## Architecture

```
┌─────────────┐     WebSocket (sync ops)     ┌──────────────────────┐
│  nodepad    │ ◄──────────────────────────► │  nodepad-sync-server │
│  (Electron) │                              │                      │
└─────────────┘                              │  ┌────────────────┐  │
                                             │  │  Sync Server   │  │
┌─────────────┐     MCP (stdio or HTTP)      │  │  (ws://:3001)  │  │
│  Gateway /  │ ◄──────────────────────────► │  └────────────────┘  │
│  CLI agent  │                              │  ┌────────────────┐  │
└─────────────┘                              │  │  MCP Server    │  │
                                             │  │  (stdio/HTTP)  │  │
                                             │  └────────────────┘  │
                                             │  ┌────────────────┐  │
                                             │  │  Storage       │  │
                                             │  │  SQLite/Postgres│  │
                                             │  └────────────────┘  │
                                             └──────────────────────┘
```

### Sync protocol (WebSocket)

1. Client connects with `?token=<auth>` query param
2. Sends `{type: "subscribe", projectId}` → gets full `{type: "snapshot", …}`
3. Sends `{type: "op", op: SyncOp, clientTimestamp}` → server persists, broadcasts
4. Reconnect: `{type: "catchup", fromSeq}` → gets missed ops since last seq
5. Ping/keepalive every 30s

### MCP protocol

- **stdio** (default): standard JSON-RPC 2.0 over stdin/stdout
- **HTTP** (`--mcp-port`): SSE stream on `GET /mcp`, JSON-RPC on `POST /mcp`
- Auth via `Authorization: Bearer <token>` header or `?token=` query param

---

## Usage

### Full server (sync + MCP stdio)

```bash
npm start
```

### Full server + MCP HTTP

```bash
npm start -- --mcp-port 3100
# or
MCP_PORT=3100 npm start
```

### MCP only (stdio)

```bash
npm start -- --mcp
```

### MCP only (HTTP)

```bash
npm start -- --mcp --mcp-port 3100
```

### PostgreSQL backend

```bash
DB_TYPE=postgres DB_URL=postgresql://localhost:5432/nodepad npm start
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Sync server WebSocket port |
| `MCP_PORT` | `3100` | MCP HTTP server port |
| `AUTH_TOKEN` | `nodepad-sync-dev` | Auth token for sync + MCP |
| `DB_TYPE` | `sqlite` | Storage backend (`sqlite` or `postgres`) |
| `DB_URL` | — | PostgreSQL connection string |
| `DB_PATH` | `./data/nodepad.db` | SQLite database file path |

---

## MCP tools (14)

| Tool | Description |
|---|---|
| `list_projects` | List all projects |
| `get_project` | Get project by ID |
| `create_project` | Create a new project |
| `delete_project` | Delete a project and all its data |
| `get_block` | Get a single block by ID |
| `create_block` | Create a block (claim, question, idea, task, etc.) |
| `update_block` | Update block text, type, category, annotation |
| `delete_block` | Delete a block |
| `search_blocks` | Full-text search across blocks (FTS5 / tsvector) |
| `get_graph` | Get all nodes and edges for a project |
| `find_connected` | Graph traversal from a block (configurable depth) |
| `get_synthesis` | Get ghost notes (synthesis insights) |
| `create_edge` | Create an `influencedBy` connection between blocks |
| `delete_edge` | Remove a connection between blocks |

---

## Data model

```
projects ──── has many ──── blocks
                              │
                              ├── has many ──── subtasks
                              ├── has many ──── edges (influencedBy)
                              │
projects ──── has many ──── ghost_notes
```

All foreign keys cascade on delete.

---

## Tech

TypeScript · Node.js · better-sqlite3 (with FTS5) · pg · ws (WebSocket)