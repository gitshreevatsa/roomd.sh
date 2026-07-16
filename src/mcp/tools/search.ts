import { z } from "zod";
import {
  getPlan,
  getContextIndex,
  getContext,
  getEvents,
} from "../../store/redis.js";

export const searchInput = z.object({
  roomId: z.string().min(1),
  q: z.string().min(1).max(200),
  limit: z.number().int().positive().max(50).optional(),
  /** When true, requires Upstash Vector (optional infra). */
  semantic: z.boolean().optional(),
});

export type SearchHit = {
  kind: "task" | "context" | "event";
  id: string;
  score: number;
  snippet: string;
};

function scoreMatch(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (h === n) return 3;
  if (h.includes(n)) return 2;
  // token overlap
  const tokens = n.split(/\s+/).filter(Boolean);
  const hits = tokens.filter((t) => h.includes(t)).length;
  return hits > 0 ? hits / tokens.length : 0;
}

export async function search(
  input: z.infer<typeof searchInput>,
): Promise<{ q: string; hits: SearchHit[] }> {
  if (input.semantic) {
    const { semanticSearch } = await import("../../vector.js");
    return semanticSearch(input.roomId, input.q, input.limit ?? 20);
  }

  const q = input.q.trim();
  const limit = input.limit ?? 20;
  const hits: SearchHit[] = [];

  const [plan, contextIds, events] = await Promise.all([
    getPlan(input.roomId),
    getContextIndex(input.roomId),
    getEvents(input.roomId, 200),
  ]);

  for (const task of plan?.tasks ?? []) {
    const blob = `${task.title}\n${task.description}\n${task.id}`;
    const score = scoreMatch(blob, q);
    if (score > 0) {
      hits.push({
        kind: "task",
        id: task.id,
        score,
        snippet: task.title,
      });
    }
  }

  for (const id of contextIds) {
    const entry = await getContext(input.roomId, id);
    if (!entry) continue;
    const blob = `${entry.summary}\n${JSON.stringify(entry.payload)}\n${entry.type}`;
    const score = scoreMatch(blob, q);
    if (score > 0) {
      hits.push({
        kind: "context",
        id: entry.id,
        score,
        snippet: entry.summary,
      });
    }
  }

  for (const event of events) {
    const blob = `${event.type}\n${event.from}\n${JSON.stringify(event.payload)}`;
    const score = scoreMatch(blob, q);
    if (score > 0) {
      hits.push({
        kind: "event",
        id: event.id,
        score,
        snippet: `${event.type}: ${JSON.stringify(event.payload).slice(0, 120)}`,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { q, hits: hits.slice(0, limit) };
}
