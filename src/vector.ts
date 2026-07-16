import type { SearchHit } from "./mcp/tools/search.js";
import { log } from "./log.js";

/**
 * Optional Upstash Vector semantic search.
 * Requires UPSTASH_VECTOR_REST_URL + UPSTASH_VECTOR_REST_TOKEN.
 */

function configured(): boolean {
  return Boolean(
    process.env["UPSTASH_VECTOR_REST_URL"] &&
      process.env["UPSTASH_VECTOR_REST_TOKEN"],
  );
}

export async function upsertContextVector(
  roomId: string,
  contextId: string,
  summary: string,
): Promise<void> {
  if (!configured()) return;
  try {
    const url = process.env["UPSTASH_VECTOR_REST_URL"]!;
    const token = process.env["UPSTASH_VECTOR_REST_TOKEN"]!;
    await fetch(`${url}/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: `${roomId}:${contextId}`,
        data: summary,
        metadata: { roomId, contextId },
      }),
    });
  } catch (err) {
    log.warn({ msg: "vector.upsert", err: String(err) });
  }
}

export async function semanticSearch(
  roomId: string,
  q: string,
  limit: number,
): Promise<{ q: string; hits: SearchHit[] }> {
  if (!configured()) {
    throw new Error(
      "Semantic search is not configured. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN.",
    );
  }
  const url = process.env["UPSTASH_VECTOR_REST_URL"]!;
  const token = process.env["UPSTASH_VECTOR_REST_TOKEN"]!;
  const res = await fetch(`${url}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: q,
      topK: limit,
      includeMetadata: true,
      filter: `roomId = '${roomId.replace(/'/g, "")}'`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Vector query failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    result?: Array<{ id: string; score: number; metadata?: { contextId?: string } }>;
  };
  const hits: SearchHit[] = (data.result ?? []).map((r) => ({
    kind: "context" as const,
    id: r.metadata?.contextId ?? String(r.id).split(":").pop() ?? String(r.id),
    score: r.score,
    snippet: `semantic match (${r.score.toFixed(3)})`,
  }));
  return { q, hits };
}
