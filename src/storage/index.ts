// ── Storage abstraction ────────────────────────────────────────────────────────
// Supports SQLite (default) and PostgreSQL. The interface is the same; swap
// the backend by setting DB_TYPE=postgres and DB_URL.

import type {
  Project, Block, Edge, SubTask, GhostNote,
  SyncSnapshot, SearchResult, GraphData,
} from "../types.js"

export interface Storage {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>

  // Projects
  getProject(id: string): Promise<Project | null>
  listProjects(): Promise<Project[]>
  createProject(p: Project): Promise<void>
  updateProject(p: Partial<Project> & { id: string }): Promise<void>
  deleteProject(id: string): Promise<void>

  // Blocks
  getBlock(id: string): Promise<Block | null>
  getBlocks(projectId: string): Promise<Block[]>
  createBlock(b: Block): Promise<void>
  updateBlock(b: Partial<Block> & { id: string; projectId: string }): Promise<void>
  deleteBlock(id: string, projectId: string): Promise<void>

  // Edges
  getEdges(projectId: string): Promise<Edge[]>
  createEdge(e: Edge): Promise<void>
  deleteEdge(sourceBlockId: string, targetBlockId: string): Promise<void>

  // Subtasks
  getSubTasks(blockId: string): Promise<SubTask[]>
  createSubTask(st: SubTask): Promise<void>
  updateSubTask(st: Partial<SubTask> & { id: string; blockId: string }): Promise<void>
  deleteSubTask(id: string, blockId: string): Promise<void>

  // Ghost notes
  getGhostNotes(projectId: string): Promise<GhostNote[]>
  createGhostNote(gn: GhostNote): Promise<void>
  deleteGhostNote(id: string, projectId: string): Promise<void>

  // Snapshot
  getSnapshot(projectId: string): Promise<SyncSnapshot>

  // Search
  searchBlocks(query: string, projectId?: string, limit?: number): Promise<SearchResult[]>
  vectorSearch(embedding: Float32Array, projectId?: string, limit?: number): Promise<SearchResult[]>

  // Graph
  getGraph(projectId: string): Promise<GraphData>
  findConnected(blockId: string, depth?: number): Promise<GraphData>
}

export async function createStorage(): Promise<Storage> {
  const dbType = process.env.DB_TYPE || "sqlite"
  if (dbType === "postgres") {
    const mod = await import("./postgres.js")
    return new mod.PostgresStorage()
  }
  const mod = await import("./sqlite.js")
  return new mod.SqliteStorage()
}
