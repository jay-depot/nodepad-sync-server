// ── Shared types for nodepad sync server ─────────────────────────────────────

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  version: number
}

export interface Block {
  id: string
  projectId: string
  text: string
  timestamp: number
  contentType: string
  category?: string
  annotation?: string
  confidence?: number | null
  isPinned: boolean
  isUnrelated: boolean
  embedding?: Float32Array | null
}

export interface Edge {
  sourceBlockId: string
  targetBlockId: string
}

export interface SubTask {
  id: string
  blockId: string
  text: string
  isDone: boolean
  timestamp: number
}

export interface GhostNote {
  id: string
  projectId: string
  text: string
  category: string
  createdAt: number
}

// ── Sync operations ──────────────────────────────────────────────────────────

export type SyncOp =
  | { type: "project:create"; payload: Project }
  | { type: "project:update"; payload: Partial<Project> & { id: string } }
  | { type: "project:delete"; payload: { id: string } }
  | { type: "block:create"; payload: Block }
  | { type: "block:update"; payload: Partial<Block> & { id: string; projectId: string } }
  | { type: "block:delete"; payload: { id: string; projectId: string } }
  | { type: "edge:create"; payload: Edge }
  | { type: "edge:delete"; payload: Edge }
  | { type: "subtask:create"; payload: SubTask }
  | { type: "subtask:update"; payload: Partial<SubTask> & { id: string; blockId: string } }
  | { type: "subtask:delete"; payload: { id: string; blockId: string } }
  | { type: "ghost:create"; payload: GhostNote }
  | { type: "ghost:delete"; payload: { id: string; projectId: string } }

export interface SyncMessage {
  seq: number
  op: SyncOp
  clientTimestamp: number
}

export interface SyncSnapshot {
  projects: Project[]
  blocks: Block[]
  edges: Edge[]
  subtasks: SubTask[]
  ghostNotes: GhostNote[]
  lastSeq: number
}

// ── MCP types ─────────────────────────────────────────────────────────────────

export interface SearchResult {
  block: Block
  projectName: string
  score: number
}

export interface GraphData {
  nodes: Block[]
  edges: Edge[]
}
