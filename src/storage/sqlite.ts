// ── SQLite storage backend with sqlite-vec for vector search ────────────────────

import Database from "better-sqlite3"
import path from "path"
import fs from "fs"
import type {
  Project, Block, Edge, SubTask, GhostNote,
  SyncSnapshot, SearchResult, GraphData,
} from "../types.js"
import type { Storage } from "./index.js"

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "nodepad.db")

export class SqliteStorage implements Storage {
  private db!: Database.Database

  async init(): Promise<void> {
    const dir = path.dirname(DB_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    this.db = new Database(DB_PATH)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'general',
        category TEXT,
        annotation TEXT,
        confidence REAL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_unrelated INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_project ON blocks(project_id);

      CREATE TABLE IF NOT EXISTS edges (
        source_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        target_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        PRIMARY KEY (source_block_id, target_block_id)
      );

      CREATE TABLE IF NOT EXISTS subtasks (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        is_done INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtasks_block ON subtasks(block_id);

      CREATE TABLE IF NOT EXISTS ghost_notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'thesis',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ghost_project ON ghost_notes(project_id);

      -- FTS5 for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
        text, category, annotation,
        content='blocks', content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
        INSERT INTO blocks_fts(rowid, text, category, annotation)
        VALUES (new.rowid, new.text, new.category, new.annotation);
      END;

      CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
        INSERT INTO blocks_fts(blocks_fts, rowid, text, category, annotation)
        VALUES ('delete', old.rowid, old.text, old.category, old.annotation);
      END;

      CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE ON blocks BEGIN
        INSERT INTO blocks_fts(blocks_fts, rowid, text, category, annotation)
        VALUES ('delete', old.rowid, old.text, old.category, old.annotation);
        INSERT INTO blocks_fts(rowid, text, category, annotation)
        VALUES (new.rowid, new.text, new.category, new.annotation);
      END;
    `)

    // Try to load sqlite-vec for vector search
    try {
      this.db.loadExtension("vec0")
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS blocks_vec USING vec0(
          embedding float[768] distance_metric=cosine
        );
      `)
    } catch {
      // sqlite-vec not available — vector search will fall back to FTS
      console.warn("sqlite-vec not available; vector search disabled")
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async getProject(id: string): Promise<Project | null> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any
    if (!row) return null
    return this.rowToProject(row)
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as any[]
    return rows.map(r => this.rowToProject(r))
  }

  async createProject(p: Project): Promise<void> {
    this.db.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)"
    ).run(p.id, p.name, p.createdAt, p.updatedAt, p.version)
  }

  async updateProject(p: Partial<Project> & { id: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    if (p.name !== undefined) { sets.push("name = ?"); vals.push(p.name) }
    if (p.updatedAt !== undefined) { sets.push("updated_at = ?"); vals.push(p.updatedAt) }
    if (p.version !== undefined) { sets.push("version = ?"); vals.push(p.version) }
    if (sets.length === 0) return
    vals.push(p.id)
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  async deleteProject(id: string): Promise<void> {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id)
  }

  // ── Blocks ───────────────────────────────────────────────────────────────

  async getBlock(id: string): Promise<Block | null> {
    const row = this.db.prepare("SELECT * FROM blocks WHERE id = ?").get(id) as any
    if (!row) return null
    return this.rowToBlock(row)
  }

  async getBlocks(projectId: string): Promise<Block[]> {
    const rows = this.db.prepare("SELECT * FROM blocks WHERE project_id = ? ORDER BY timestamp DESC").all(projectId) as any[]
    return rows.map(r => this.rowToBlock(r))
  }

  async createBlock(b: Block): Promise<void> {
    this.db.prepare(
      `INSERT INTO blocks (id, project_id, text, timestamp, content_type, category, annotation, confidence, is_pinned, is_unrelated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(b.id, b.projectId, b.text, b.timestamp, b.contentType, b.category ?? null, b.annotation ?? null, b.confidence ?? null, b.isPinned ? 1 : 0, b.isUnrelated ? 1 : 0)
  }

  async updateBlock(b: Partial<Block> & { id: string; projectId: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    if (b.text !== undefined) { sets.push("text = ?"); vals.push(b.text) }
    if (b.contentType !== undefined) { sets.push("content_type = ?"); vals.push(b.contentType) }
    if (b.category !== undefined) { sets.push("category = ?"); vals.push(b.category) }
    if (b.annotation !== undefined) { sets.push("annotation = ?"); vals.push(b.annotation) }
    if (b.confidence !== undefined) { sets.push("confidence = ?"); vals.push(b.confidence) }
    if (b.isPinned !== undefined) { sets.push("is_pinned = ?"); vals.push(b.isPinned ? 1 : 0) }
    if (b.isUnrelated !== undefined) { sets.push("is_unrelated = ?"); vals.push(b.isUnrelated ? 1 : 0) }
    if (b.timestamp !== undefined) { sets.push("timestamp = ?"); vals.push(b.timestamp) }
    if (sets.length === 0) return
    vals.push(b.id)
    this.db.prepare(`UPDATE blocks SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  async deleteBlock(id: string, _projectId: string): Promise<void> {
    this.db.prepare("DELETE FROM blocks WHERE id = ?").run(id)
  }

  // ── Edges ────────────────────────────────────────────────────────────────

  async getEdges(projectId: string): Promise<Edge[]> {
    const rows = this.db.prepare(
      `SELECT e.source_block_id, e.target_block_id FROM edges e
       JOIN blocks b1 ON e.source_block_id = b1.id
       JOIN blocks b2 ON e.target_block_id = b2.id
       WHERE b1.project_id = ? AND b2.project_id = ?`
    ).all(projectId, projectId) as any[]
    return rows.map(r => ({ sourceBlockId: r.source_block_id, targetBlockId: r.target_block_id }))
  }

  async createEdge(e: Edge): Promise<void> {
    this.db.prepare(
      "INSERT OR IGNORE INTO edges (source_block_id, target_block_id) VALUES (?, ?)"
    ).run(e.sourceBlockId, e.targetBlockId)
  }

  async deleteEdge(sourceBlockId: string, targetBlockId: string): Promise<void> {
    this.db.prepare(
      "DELETE FROM edges WHERE source_block_id = ? AND target_block_id = ?"
    ).run(sourceBlockId, targetBlockId)
  }

  // ── Subtasks ─────────────────────────────────────────────────────────────

  async getSubTasks(blockId: string): Promise<SubTask[]> {
    const rows = this.db.prepare("SELECT * FROM subtasks WHERE block_id = ? ORDER BY timestamp").all(blockId) as any[]
    return rows.map(r => ({
      id: r.id,
      blockId: r.block_id,
      text: r.text,
      isDone: r.is_done === 1,
      timestamp: r.timestamp,
    }))
  }

  async createSubTask(st: SubTask): Promise<void> {
    this.db.prepare(
      "INSERT INTO subtasks (id, block_id, text, is_done, timestamp) VALUES (?, ?, ?, ?, ?)"
    ).run(st.id, st.blockId, st.text, st.isDone ? 1 : 0, st.timestamp)
  }

  async updateSubTask(st: Partial<SubTask> & { id: string; blockId: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    if (st.text !== undefined) { sets.push("text = ?"); vals.push(st.text) }
    if (st.isDone !== undefined) { sets.push("is_done = ?"); vals.push(st.isDone ? 1 : 0) }
    if (st.timestamp !== undefined) { sets.push("timestamp = ?"); vals.push(st.timestamp) }
    if (sets.length === 0) return
    vals.push(st.id)
    this.db.prepare(`UPDATE subtasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  async deleteSubTask(id: string, _blockId: string): Promise<void> {
    this.db.prepare("DELETE FROM subtasks WHERE id = ?").run(id)
  }

  // ── Ghost notes ──────────────────────────────────────────────────────────

  async getGhostNotes(projectId: string): Promise<GhostNote[]> {
    const rows = this.db.prepare("SELECT * FROM ghost_notes WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as any[]
    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      category: r.category,
      createdAt: r.created_at,
    }))
  }

  async createGhostNote(gn: GhostNote): Promise<void> {
    this.db.prepare(
      "INSERT INTO ghost_notes (id, project_id, text, category, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(gn.id, gn.projectId, gn.text, gn.category, gn.createdAt)
  }

  async deleteGhostNote(id: string, _projectId: string): Promise<void> {
    this.db.prepare("DELETE FROM ghost_notes WHERE id = ?").run(id)
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  async getSnapshot(projectId: string): Promise<SyncSnapshot> {
    const [projects, blocks, edges, subtasks, ghostNotes] = await Promise.all([
      this.db.prepare("SELECT * FROM projects WHERE id = ?").all(projectId) as any[],
      this.getBlocks(projectId),
      this.getEdges(projectId),
      this.db.prepare(
        "SELECT s.* FROM subtasks s JOIN blocks b ON s.block_id = b.id WHERE b.project_id = ?"
      ).all(projectId) as any[],
      this.getGhostNotes(projectId),
    ])

    return {
      projects: projects.map(r => this.rowToProject(r)),
      blocks,
      edges,
      subtasks: subtasks.map(r => ({
        id: r.id,
        blockId: r.block_id,
        text: r.text,
        isDone: r.is_done === 1,
        timestamp: r.timestamp,
      })),
      ghostNotes,
      lastSeq: 0,
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async searchBlocks(query: string, projectId?: string, limit = 20): Promise<SearchResult[]> {
    const projectFilter = projectId ? " AND b.project_id = ?" : ""
    const params: any[] = [query, limit]
    if (projectId) params.push(projectId)

    const rows = this.db.prepare(`
      SELECT b.*, p.name as project_name,
             rank as score
      FROM blocks_fts f
      JOIN blocks b ON b.rowid = f.rowid
      JOIN projects p ON p.id = b.project_id
      WHERE blocks_fts MATCH ?${projectFilter}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as any[]

    return rows.map(r => ({
      block: this.rowToBlock(r),
      projectName: r.project_name,
      score: 1 - (r.score as number),
    }))
  }

  async vectorSearch(_embedding: Float32Array, _projectId?: string, _limit = 20): Promise<SearchResult[]> {
    // sqlite-vec not loaded — fall back to empty results
    return []
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  async getGraph(projectId: string): Promise<GraphData> {
    const blocks = await this.getBlocks(projectId)
    const edges = await this.getEdges(projectId)
    return { nodes: blocks, edges }
  }

  async findConnected(blockId: string, depth = 2): Promise<GraphData> {
    const nodeSet = new Set<string>()
    const edgeSet = new Set<string>()
    const nodes: Block[] = []
    const edges: Edge[] = []

    let frontier = [blockId]
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const placeholders = frontier.map(() => "?").join(",")
      const rows = this.db.prepare(`
        SELECT e.source_block_id, e.target_block_id
        FROM edges e
        WHERE e.source_block_id IN (${placeholders})
           OR e.target_block_id IN (${placeholders})
      `).all(...frontier, ...frontier) as any[]

      const nextFrontier = new Set<string>()
      for (const r of rows) {
        const key = `${r.source_block_id}:${r.target_block_id}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ sourceBlockId: r.source_block_id, targetBlockId: r.target_block_id })
        }
        if (!nodeSet.has(r.source_block_id)) nextFrontier.add(r.source_block_id)
        if (!nodeSet.has(r.target_block_id)) nextFrontier.add(r.target_block_id)
      }

      for (const nid of nextFrontier) {
        if (!nodeSet.has(nid)) {
          nodeSet.add(nid)
          const block = await this.getBlock(nid)
          if (block) nodes.push(block)
        }
      }

      frontier = [...nextFrontier].filter(id => !nodeSet.has(id))
    }

    return { nodes, edges }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private rowToProject(r: any): Project {
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    }
  }

  private rowToBlock(r: any): Block {
    return {
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      timestamp: r.timestamp,
      contentType: r.content_type,
      category: r.category ?? undefined,
      annotation: r.annotation ?? undefined,
      confidence: r.confidence ?? null,
      isPinned: r.is_pinned === 1,
      isUnrelated: r.is_unrelated === 1,
    }
  }
}
