import { z } from "zod";
import { nanoid } from "nanoid";
import type { Event } from "../../types.js";
import {
  pushEvent,
  getEvents,
  getEventCursor,
  setEventCursor,
  markEventRead,
  getEventReaders,
} from "../../store/redis.js";

// ---------------------------------------------------------------------------
// postEvent
// ---------------------------------------------------------------------------

export const postEventInput = z.object({
  roomId: z.string(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  payload: z.record(z.unknown()),
});

/** Creates a new Event in the given room, persists it, and returns it. */
export async function postEvent(
  input: z.infer<typeof postEventInput>,
): Promise<Event> {
  const event: Event = {
    id: nanoid(),
    type: input.type,
    from: input.from,
    to: input.to,
    payload: input.payload,
    timestamp: new Date().toISOString(),
    read_by: [],
  };
  await pushEvent(input.roomId, event);
  return event;
}

// ---------------------------------------------------------------------------
// readEvents
// ---------------------------------------------------------------------------

export const readEventsInput = z.object({
  roomId: z.string(),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/** Retrieves recent events for a room, with optional time-based filtering. */
export async function readEvents(
  input: z.infer<typeof readEventsInput>,
): Promise<Event[]> {
  const events = await getEvents(input.roomId, input.limit ?? 20);
  if (input.since !== undefined) {
    const sinceDate = new Date(input.since);
    return events.filter((e) => new Date(e.timestamp) > sinceDate);
  }
  return events;
}

// ---------------------------------------------------------------------------
// getUnreadEvents: cursor-based, per-agent delivery
// ---------------------------------------------------------------------------

/** How far back in the newest-first log we scan when draining unread events. */
export const UNREAD_SCAN_CAP = 500;

export const getUnreadEventsInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});

/**
 * Consume unread events for one agent: return the oldest unread batch first,
 * then advance that agent's cursor to the timestamp of the last event returned.
 *
 * Advancing to the last returned timestamp (not wall-clock "now") means events
 * that arrive during the read are not skipped. Delivering oldest-first means a
 * backlog larger than `limit` is drained across calls instead of dropping the
 * older slice. The scan is capped at UNREAD_SCAN_CAP newest events.
 */
export async function consumeUnreadEvents(
  roomId: string,
  agentId: string,
  limit = 50,
): Promise<{ events: Event[]; cursor: string | null; count: number }> {
  const cursor = await getEventCursor(roomId, agentId);
  const recent = await getEvents(roomId, UNREAD_SCAN_CAP);

  const unread = (
    cursor === null
      ? recent
      : recent.filter((e) => new Date(e.timestamp) > new Date(cursor))
  )
    .slice()
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

  const batch = unread.slice(0, limit);

  if (batch.length === 0) {
    return { events: batch, cursor, count: 0 };
  }

  const newCursor = batch[batch.length - 1]!.timestamp;
  await setEventCursor(roomId, agentId, newCursor);
  return { events: batch, cursor: newCursor, count: batch.length };
}

/**
 * Returns events this agent has not consumed yet, oldest first, and advances
 * the per-agent cursor past the returned batch so each event is delivered once
 * under normal operation. Call at session start and periodically.
 */
export async function getUnreadEvents(
  input: z.infer<typeof getUnreadEventsInput>,
): Promise<{ events: Event[]; cursor: string | null; count: number }> {
  return consumeUnreadEvents(
    input.roomId,
    input.agentId,
    input.limit ?? 50,
  );
}

// ---------------------------------------------------------------------------
// markEventRead
// ---------------------------------------------------------------------------

export const markEventReadInput = z.object({
  roomId: z.string().min(1),
  eventId: z.string().min(1),
  agentId: z.string().min(1),
});

/** Mark an event as read by your agent so the sender can confirm delivery. */
export async function markEventReadTool(
  input: z.infer<typeof markEventReadInput>,
): Promise<{ eventId: string; agentId: string; ok: boolean }> {
  await markEventRead(input.roomId, input.eventId, input.agentId);
  return { eventId: input.eventId, agentId: input.agentId, ok: true };
}

// ---------------------------------------------------------------------------
// getEventReads
// ---------------------------------------------------------------------------

export const getEventReadsInput = z.object({
  roomId: z.string().min(1),
  eventId: z.string().min(1),
});

/** Check which agents have read a specific event. Use to confirm your message was seen. */
export async function getEventReadsTool(
  input: z.infer<typeof getEventReadsInput>,
): Promise<{ eventId: string; readBy: string[] }> {
  const readBy = await getEventReaders(input.roomId, input.eventId);
  return { eventId: input.eventId, readBy };
}

// ---------------------------------------------------------------------------
// replyToEvent: threaded replies
// ---------------------------------------------------------------------------

export const replyToEventInput = z.object({
  roomId: z.string().min(1),
  replyToId: z.string().min(1),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.record(z.unknown()),
});

/** Post an event that is explicitly linked to a previous event by id. Enables threaded conversations. */
export async function replyToEvent(
  input: z.infer<typeof replyToEventInput>,
): Promise<Event> {
  const event: Event = {
    id: nanoid(),
    type: input.type,
    from: input.from,
    to: input.to,
    payload: input.payload,
    timestamp: new Date().toISOString(),
    read_by: [],
    reply_to_id: input.replyToId,
  };
  await pushEvent(input.roomId, event);
  return event;
}
