// ── PostgreSQL storage backend ──────────────────────────────────────────────────
// Activated by DB_TYPE=postgres + DB_URL=postgresql://...

import pg from "pg"
import type {
  Project, Block, Edge, SubTask, GhostNote,
  SyncSnapshot, SearchResult, GraphData,
} from "../types.js"
import type { Storage } from "./index.js"

const { Pool } = pg

export class PostgresStorage implements Storage {
  private pool!: pg.Pool

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: process.env.DB_URL || "postgresql://localhost:5432/nodepad",
      max: 10,
    })

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'general',
        category TEXT,
        annotation TEXT,
        confidence REAL,
        is_pinned BOOLEAN NOT NULL DEFAULT false,
        is_unrelated BOOLEAN NOT NULL DEFAULT false
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
        is_done BOOLEAN NOT NULL DEFAULT false,
        timestamp BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtasks_block ON subtasks(block_id);

      CREATE TABLE IF NOT EXISTS ghost_notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'thesis',
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ghost_project ON ghost_notes(project_id);
    `)

    // Full-text search via tsvector
    await this.pool.query(`
      ALTER TABLE blocks ADD COLUMN IF NOT EXISTS search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(text,'') || ' ' || coalesce(category,'') || ' ' || coalesce(annotation,''))) STORED;
    `).catch(() => {}) // ignore if column already exists

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blocks_search ON blocks USING GIN(search_vector);
    `).catch(() => {})
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async getProject(id: string): Promise<Project | null> {
    const { rows } = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id])
    return rows[0] ? this.rowToProject(rows[0]) : null
  }

  async listProjects(): Promise<Project[]> {
    const { rows } = await this.pool.query("SELECT * FROM projects ORDER BY updated_at DESC")
    return rows.map(r => this.rowToProject(r))
  }

  async createProject(p: Project): Promise<void> {
    await this.pool.query(
      "INSERT INTO projects (id, name, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5)",
      [p.id, p.name, p.createdAt, p.updatedAt, p.version]
    )
  }

  async updateProject(p: Partial<Project> & { id: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    let i = 1
    if (p.name !== undefined) { sets.push(`name = $${i++}`); vals.push(p.name) }
    if (p.updatedAt !== undefined) { sets.push(`updated_at = $${i++}`); vals.push(p.updatedAt) }
    if (p.version !== undefined) { sets.push(`version = $${i++}`); vals.push(p.version) }
    if (sets.length === 0) return
    vals.push(p.id)
    await this.pool.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${i}`, vals)
  }

  async deleteProject(id: string): Promise<void> {
    await this.pool.query("DELETE FROM projects WHERE id = $1", [id])
  }

  // ── Blocks ───────────────────────────────────────────────────────────────

  async getBlock(id: string): Promise<Block | null> {
    const { rows } = await this.pool.query("SELECT * FROM blocks WHERE id = $1", [id])
    return rows[0] ? this.rowToBlock(rows[0]) : null
  }

  async getBlocks(projectId: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM blocks WHERE project_id = $1 ORDER BY timestamp DESC", [projectId]
    )
    return rows.map(r => this.rowToBlock(r))
  }

  async createBlock(b: Block): Promise<void> {
    await this.pool.query(
      `INSERT INTO blocks (id, project_id, text, timestamp, content_type, category, annotation, confidence, is_pinned, is_unrelated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [b.id, b.projectId, b.text, b.timestamp, b.contentType, b.category ?? null, b.annotation ?? null, b.confidence ?? null, b.isPinned, b.isUnrelated]
    )
  }

  async updateBlock(b: Partial<Block> & { id: string; projectId: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    let i = 1
    if (b.text !== undefined) { sets.push(`text = $${i++}`); vals.push(b.text) }
    if (b.contentType !== undefined) { sets.push(`content_type = $${i++}`); vals.push(b.contentType) }
    if (b.category !== undefined) { sets.push(`category = $${i++}`); vals.push(b.category) }
    if (b.annotation !== undefined) { sets.push(`annotation = $${i++}`); vals.push(b.annotation) }
    if (b.confidence !== undefined) { sets.push(`confidence = $${i++}`); vals.push(b.confidence) }
    if (b.isPinned !== undefined) { sets.push(`is_pinned = $${i++}`); vals.push(b.isPinned) }
    if (b.isUnrelated !== undefined) { sets.push(`is_unrelated = $${i++}`); vals.push(b.isUnrelated) }
    if (b.timestamp !== undefined) { sets.push(`timestamp = $${i++}`); vals.push(b.timestamp) }
    if (sets.length === 0) return
    vals.push(b.id)
    await this.pool.query(`UPDATE blocks SET ${sets.join(", ")} WHERE id = $${i}`, vals)
  }

  async deleteBlock(id: string, _projectId: string): Promise<void> {
    await this.pool.query("DELETE FROM blocks WHERE id = $1", [id])
  }

  // ── Edges ────────────────────────────────────────────────────────────────

  async getEdges(projectId: string): Promise<Edge[]> {
    const { rows } = await this.pool.query(
      `SELECT e.source_block_id, e.target_block_id FROM edges e
       JOIN blocks b1 ON e.source_block_id = b1.id
       JOIN blocks b2 ON e.target_block_id = b2.id
       WHERE b1.project_id = $1 AND b2.project_id = $1`,
      [projectId]
    )
    return rows.map(r => ({ sourceBlockId: r.source_block_id, targetBlockId: r.target_block_id }))
  }

  async createEdge(e: Edge): Promise<void> {
    await this.pool.query(
      "INSERT INTO edges (source_block_id, target_block_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [e.sourceBlockId, e.targetBlockId]
    )
  }

  async deleteEdge(sourceBlockId: string, targetBlockId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM edges WHERE source_block_id = $1 AND target_block_id = $2",
      [sourceBlockId, targetBlockId]
    )
  }

  // ── Subtasks ─────────────────────────────────────────────────────────────

  async getSubTasks(blockId: string): Promise<SubTask[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM subtasks WHERE block_id = $1 ORDER BY timestamp", [blockId]
    )
    return rows.map(r => ({
      id: r.id,
      blockId: r.block_id,
      text: r.text,
      isDone: r.is_done,
      timestamp: Number(r.timestamp),
    }))
  }

  async createSubTask(st: SubTask): Promise<void> {
    await this.pool.query(
      "INSERT INTO subtasks (id, block_id, text, is_done, timestamp) VALUES ($1, $2, $3, $4, $5)",
      [st.id, st.blockId, st.text, st.isDone, st.timestamp]
    )
  }

  async updateSubTask(st: Partial<SubTask> & { id: string; blockId: string }): Promise<void> {
    const sets: string[] = []
    const vals: any[] = []
    let i = 1
    if (st.text !== undefined) { sets.push(`text = $${i++}`); vals.push(st.text) }
    if (st.isDone !== undefined) { sets.push(`is_done = $${i++}`); vals.push(st.isDone) }
    if (st.timestamp !== undefined) { sets.push(`timestamp = $${i++}`); vals.push(st.timestamp) }
    if (sets.length === 0) return
    vals.push(st.id)
    await this.pool.query(`UPDATE subtasks SET ${sets.join(", ")} WHERE id = $${i}`, vals)
  }

  async deleteSubTask(id: string, _blockId: string): Promise<void> {
    await this.pool.query("DELETE FROM subtasks WHERE id = $1", [id])
  }

  // ── Ghost notes ──────────────────────────────────────────────────────────

  async getGhostNotes(projectId: string): Promise<GhostNote[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM ghost_notes WHERE project_id = $1 ORDER BY created_at DESC", [projectId]
    )
    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      category: r.category,
      createdAt: Number(r.created_at),
    }))
  }

  async createGhostNote(gn: GhostNote): Promise<void> {
    await this.pool.query(
      "INSERT INTO ghost_notes (id, project_id, text, category, created_at) VALUES ($1, $2, $3, $4, $5)",
      [gn.id, gn.projectId, gn.text, gn.category, gn.createdAt]
    )
  }

  async deleteGhostNote(id: string, _projectId: string): Promise<void> {
    await this.pool.query("DELETE FROM ghost_notes WHERE id = $1", [id])
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  async getSnapshot(projectId: string): Promise<SyncSnapshot> {
    const [projects, blocks, edges, subtasks, ghostNotes] = await Promise.all([
      this.pool.query("SELECT * FROM projects WHERE id = $1", [projectId]).then(r => r.rows.map((r: any) => this.rowToProject(r))),
      this.getBlocks(projectId),
      this.getEdges(projectId),
      this.pool.query(
        "SELECT s.* FROM subtasks s JOIN blocks b ON s.block_id = b.id WHERE b.project_id = $1", [projectId]
      ).then(r => r.rows.map((r: any) => ({
        id: r.id,
        blockId: r.block_id,
        text: r.text,
        isDone: r.is_done,
        timestamp: Number(r.timestamp),
      }))),
      this.getGhostNotes(projectId),
    ])

    return { projects, blocks, edges, subtasks, ghostNotes, lastSeq: 0 }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async searchBlocks(query: string, projectId?: string, limit = 20): Promise<SearchResult[]> {
    const tsquery = query.split(/\s+/).filter(Boolean).map(w => w + ":*").join(" & ")
    const projectFilter = projectId ? " AND b.project_id = $2" : ""
    const params: any[] = [tsquery]
    if (projectId) params.push(projectId)

    const { rows } = await this.pool.query(`
      SELECT b.*, p.name as project_name,
             ts_rank(b.search_vector, to_tsquery('english', $1)) as score
      FROM blocks b
      JOIN projects p ON p.id = b.project_id
      WHERE b.search_vector @@ to_tsquery('english', $1)${projectFilter}
      ORDER BY score DESC
      LIMIT $${params.length + 1}
    `, [...params, limit])

    return rows.map(r => ({
      block: this.rowToBlock(r),
      projectName: r.project_name,
      score: r.score,
    }))
  }

  async vectorSearch(_embedding: Float32Array, _projectId?: string, _limit = 20): Promise<SearchResult[]> {
    // pgvector support — requires pgvector extension
    // TODO: add pgvector support when extension is available
    return []
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  async getGraph(projectId: string): Promise<GraphData> {
    const [blocks, edges] = await Promise.all([
      this.getBlocks(projectId),
      this.getEdges(projectId),
    ])
    return { nodes: blocks, edges }
  }

  async findConnected(blockId: string, depth = 2): Promise<GraphData> {
    const nodeSet = new Set<string>()
    const edgeSet = new Set<string>()
    const nodes: Block[] = []
    const edges: Edge[] = []

    let frontier = [blockId]
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const placeholders = frontier.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(`
        SELECT e.source_block_id, e.target_block_id
        FROM edges e
        WHERE e.source_block_id IN (${placeholders})
           OR e.target_block_id IN (${placeholders})
      `, [...frontier, ...frontier])

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
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      version: r.version,
    }
  }

  private rowToBlock(r: any): Block {
    return {
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      timestamp: Number(r.timestamp),
      contentType: r.content_type,
      category: r.category ?? undefined,
      annotation: r.annotation ?? undefined,
      confidence: r.confidence ?? null,
      isPinned: r.is_pinned,
      isUnrelated: r.is_unrelated,
    }
  }
}
