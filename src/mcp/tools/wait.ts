import { z } from "zod";
import type { Event } from "../../types.js";
import { consumeUnreadEvents } from "./events.js";

export const waitForEventsInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/**
 * Block briefly for unread events (MCP-friendly push substitute).
 * Polls every 500ms until events arrive or timeout.
 */
export async function waitForEvents(
  input: z.infer<typeof waitForEventsInput>,
): Promise<{ events: Event[]; cursor: string | null; timedOut: boolean }> {
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  const limit = input.limit ?? 20;

  while (Date.now() < deadline) {
    const batch = await consumeUnreadEvents(input.roomId, input.agentId, limit);
    if (batch.events.length > 0) {
      return { events: batch.events, cursor: batch.cursor, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const final = await consumeUnreadEvents(input.roomId, input.agentId, limit);
  return {
    events: final.events,
    cursor: final.cursor,
    timedOut: final.events.length === 0,
  };
}
