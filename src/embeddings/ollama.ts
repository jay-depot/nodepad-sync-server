// ── Ollama embedding client ────────────────────────────────────────────────────
// Generates vector embeddings via Ollama's /api/embeddings endpoint.

import http from "http"

const OLLAMA_DEFAULT = process.env.OLLAMA_URL || "http://127.0.0.1:11434"
const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text"
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || "768", 10)

function ollamaFetch(endpoint: string, options: {
  method?: string
  body?: string
  timeout?: number
} = {}): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, OLLAMA_DEFAULT)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        timeout: options.timeout || 30000,
      },
      (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) })
          } catch {
            resolve({ status: res.statusCode ?? 0, data: body })
          }
        })
      }
    )
    req.on("error", (err) => reject(err))
    req.on("timeout", () => { req.destroy(); reject(new Error("Ollama request timed out")) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

export interface EmbeddingResult {
  embedding: number[]
  model: string
}

/**
 * Generate an embedding for a single text string using Ollama.
 */
export async function embedText(text: string, model?: string): Promise<EmbeddingResult> {
  const res = await ollamaFetch("/api/embeddings", {
    method: "POST",
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      prompt: text,
    }),
    timeout: 60000,
  })

  if (res.status !== 200) {
    throw new Error(`Ollama embedding failed: ${res.data?.error || res.status}`)
  }

  return {
    embedding: res.data.embedding as number[],
    model: res.data.model || DEFAULT_MODEL,
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 * Falls back to individual calls if the model doesn't support batching.
 */
export async function embedBatch(texts: string[], model?: string): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return []

  const m = model || DEFAULT_MODEL

  // Try batch endpoint first
  try {
    const res = await ollamaFetch("/api/embed", {
      method: "POST",
      body: JSON.stringify({ model: m, input: texts }),
      timeout: 120000,
    })

    if (res.status === 200 && Array.isArray(res.data.embeddings)) {
      return res.data.embeddings.map((e: number[], i: number) => ({
        embedding: e,
        model: m,
      }))
    }
  } catch {
    // Fall through to individual
  }

  // Fall back: one at a time
  const results: EmbeddingResult[] = []
  for (const text of texts) {
    try {
      const r = await embedText(text, m)
      results.push(r)
    } catch (err) {
      console.error(`Embedding failed for text "${text.slice(0, 50)}...":`, err)
      // Push a zero vector so we don't lose the block
      results.push({ embedding: new Array(EMBEDDING_DIM).fill(0), model: m })
    }
  }
  return results
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}