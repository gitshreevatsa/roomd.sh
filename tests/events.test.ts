import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import {
  postEvent,
  readEvents,
  getUnreadEvents,
  markEventReadTool,
  getEventReadsTool,
  replyToEvent,
} from "../src/mcp/tools/events.js";

const roomId = "test-room";

const basicEvent = {
  roomId,
  type: "change_request",
  from: "frontend",
  to: "backend",
  payload: { description: "need /me endpoint" },
};

beforeEach(() => fakeRedis.flush());

describe("postEvent and readEvents", () => {
  test("returns events newest first", async () => {
    await postEvent({ ...basicEvent, type: "first" });
    await postEvent({ ...basicEvent, type: "second" });

    const events = await readEvents({ roomId });
    expect(events.map((e) => e.type)).toEqual(["second", "first"]);
  });

  test("honours the limit", async () => {
    for (let i = 0; i < 5; i++) await postEvent({ ...basicEvent, type: `e${i}` });
    expect(await readEvents({ roomId, limit: 2 })).toHaveLength(2);
  });

  test("filters by `since`", async () => {
    await postEvent(basicEvent);
    const cutoff = new Date(Date.now() + 1000).toISOString();
    expect(await readEvents({ roomId, since: cutoff })).toEqual([]);
  });

  test("events are scoped to their room", async () => {
    await postEvent(basicEvent);
    expect(await readEvents({ roomId: "other" })).toEqual([]);
  });
});

describe("getUnreadEvents", () => {
  test("returns everything on the first call and nothing on the second", async () => {
    await postEvent(basicEvent);

    const first = await getUnreadEvents({ roomId, agentId: "backend" });
    expect(first.count).toBe(1);

    const second = await getUnreadEvents({ roomId, agentId: "backend" });
    expect(second.count).toBe(0);
  });

  test("returns an event posted after the cursor advanced", async () => {
    await postEvent(basicEvent);
    await getUnreadEvents({ roomId, agentId: "backend" });

    // The cursor is timestamp-based, so the new event must be strictly later.
    await Bun.sleep(5);
    await postEvent({ ...basicEvent, type: "later" });

    const next = await getUnreadEvents({ roomId, agentId: "backend" });
    expect(next.events.map((e) => e.type)).toEqual(["later"]);
  });

  test("each agent has an independent cursor", async () => {
    await postEvent(basicEvent);
    await getUnreadEvents({ roomId, agentId: "backend" });

    const other = await getUnreadEvents({ roomId, agentId: "frontend" });
    expect(other.count).toBe(1);
  });

  test("advances the cursor to the last returned event timestamp, not wall clock", async () => {
    const event = await postEvent(basicEvent);
    const result = await getUnreadEvents({ roomId, agentId: "backend" });
    expect(result.cursor).toBe(event.timestamp);
  });

  test("drains a backlog oldest-first across multiple limited calls", async () => {
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(3);
      await postEvent({ ...basicEvent, type: `e${i}` });
    }

    const first = await getUnreadEvents({ roomId, agentId: "backend", limit: 2 });
    expect(first.events.map((e) => e.type)).toEqual(["e0", "e1"]);

    const second = await getUnreadEvents({ roomId, agentId: "backend", limit: 2 });
    expect(second.events.map((e) => e.type)).toEqual(["e2", "e3"]);

    const third = await getUnreadEvents({ roomId, agentId: "backend", limit: 2 });
    expect(third.events.map((e) => e.type)).toEqual(["e4"]);
  });

  test("does not skip an event whose timestamp is after the batch but before wall-clock now", async () => {
    const first = await postEvent({ ...basicEvent, type: "first" });
    await Bun.sleep(3);
    // Simulate an event that landed "during" a read: newer than the batch cursor,
    // but we must still see it on the next call (cursor is batch max, not Date.now()).
    const mid = await postEvent({ ...basicEvent, type: "mid" });
    expect(new Date(mid.timestamp).getTime()).toBeGreaterThan(
      new Date(first.timestamp).getTime(),
    );

    const batch = await getUnreadEvents({ roomId, agentId: "backend", limit: 1 });
    expect(batch.events.map((e) => e.type)).toEqual(["first"]);
    expect(batch.cursor).toBe(first.timestamp);

    const rest = await getUnreadEvents({ roomId, agentId: "backend" });
    expect(rest.events.map((e) => e.type)).toEqual(["mid"]);
  });
});

describe("read receipts", () => {
  test("mark_event_read records the reader and get_event_reads reports it", async () => {
    const event = await postEvent(basicEvent);

    expect((await getEventReadsTool({ roomId, eventId: event.id })).readBy).toEqual([]);

    await markEventReadTool({ roomId, eventId: event.id, agentId: "backend" });

    const reads = await getEventReadsTool({ roomId, eventId: event.id });
    expect(reads.readBy).toEqual(["backend"]);
  });

  test("marking twice is idempotent", async () => {
    const event = await postEvent(basicEvent);
    await markEventReadTool({ roomId, eventId: event.id, agentId: "backend" });
    await markEventReadTool({ roomId, eventId: event.id, agentId: "backend" });

    expect((await getEventReadsTool({ roomId, eventId: event.id })).readBy).toEqual(["backend"]);
  });
});

describe("replyToEvent", () => {
  test("links the reply back to the original", async () => {
    const original = await postEvent(basicEvent);

    const reply = await replyToEvent({
      roomId,
      replyToId: original.id,
      type: "change_request_fulfilled",
      from: "backend",
      to: "frontend",
      payload: { contextId: "abc" },
    });

    expect(reply.reply_to_id).toBe(original.id);

    const events = await readEvents({ roomId });
    expect(events[0]!.reply_to_id).toBe(original.id);
  });
});
