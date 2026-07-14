import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import {
  writeContext,
  readContext,
  listContext,
  updateContext,
  validatePayload,
} from "../src/mcp/tools/context.js";
import { getEvents } from "../src/store/redis.js";

const roomId = "test-room";

const contract = {
  service: "auth-service",
  version: "1.0",
  endpoints: [
    {
      method: "POST" as const,
      path: "/api/v1/auth/login",
      request: { email: "string", password: "string" },
      response: { access_token: "string" },
      auth_required: false,
      description: "Exchange credentials for tokens",
    },
  ],
};

beforeEach(() => fakeRedis.flush());

describe("validatePayload", () => {
  test("accepts a well-formed api_contract", () => {
    expect(() => validatePayload("api_contract", contract)).not.toThrow();
  });

  test("rejects an api_contract with no endpoints", () => {
    expect(() => validatePayload("api_contract", { ...contract, endpoints: [] })).toThrow(
      /endpoints/
    );
  });

  test("rejects an endpoint with an unknown method", () => {
    const bad = { ...contract, endpoints: [{ ...contract.endpoints[0], method: "TRACE" }] };
    expect(() => validatePayload("api_contract", bad)).toThrow(/method/);
  });

  test("names the offending field so the agent can self-correct", () => {
    expect(() => validatePayload("note", {})).toThrow(/text/);
  });

  test("rejects a change_request with an invalid urgency", () => {
    expect(() =>
      validatePayload("change_request", {
        requested_by: "a",
        target_agent: "b",
        description: "d",
        urgency: "extreme",
      })
    ).toThrow(/urgency/);
  });

  test("accepts an arch_decision and keeps unknown extra fields", () => {
    const parsed = validatePayload("arch_decision", {
      title: "Use Redis",
      decision: "Use Upstash Redis",
      rationale: "Already provisioned",
      alternatives: ["Postgres"],
      consequences: ["No relational queries"],
      extra: "kept",
    });
    expect(parsed.extra).toBe("kept");
  });
});

describe("writeContext", () => {
  test("stores an entry and returns it at version 1.0", async () => {
    const entry = await writeContext({
      roomId,
      type: "api_contract",
      summary: "Auth API",
      consuming_agents: [],
      payload: contract,
      author: "backend",
    });

    expect(entry.version).toBe("1.0");
    const read = await readContext({ roomId, id: entry.id });
    expect(read.summary).toBe("Auth API");
  });

  test("rejects a payload that does not match its type", async () => {
    await expect(
      writeContext({
        roomId,
        type: "api_contract",
        summary: "bad",
        consuming_agents: [],
        payload: { service: "x" },
        author: "backend",
      })
    ).rejects.toThrow(/Invalid payload for context type "api_contract"/);
  });

  test("notifies a single consuming agent directly", async () => {
    await writeContext({
      roomId,
      type: "api_contract",
      summary: "Auth API",
      consuming_agents: ["frontend"],
      payload: contract,
      author: "backend",
    });

    const events = await getEvents(roomId, 10);
    expect(events[0]!.type).toBe("context_available");
    expect(events[0]!.to).toBe("frontend");
  });

  test("broadcasts when there are several consumers", async () => {
    await writeContext({
      roomId,
      type: "api_contract",
      summary: "Auth API",
      consuming_agents: ["frontend", "mobile"],
      payload: contract,
      author: "backend",
    });
    const events = await getEvents(roomId, 10);
    expect(events[0]!.to).toBe("all");
  });

  test("posts no event when nobody is consuming", async () => {
    await writeContext({
      roomId,
      type: "note",
      summary: "n",
      consuming_agents: [],
      payload: { text: "just a note" },
      author: "backend",
    });
    expect(await getEvents(roomId, 10)).toEqual([]);
  });
});

describe("updateContext", () => {
  test("bumps the minor version and keeps the type", async () => {
    const entry = await writeContext({
      roomId,
      type: "api_contract",
      summary: "v1",
      consuming_agents: [],
      payload: contract,
      author: "backend",
    });

    const updated = await updateContext({
      roomId,
      id: entry.id,
      author: "backend",
      summary: "v1.1 adds /me",
    });

    expect(updated.version).toBe("1.1");
    expect(updated.type).toBe("api_contract");
    expect(updated.summary).toBe("v1.1 adds /me");
  });

  test("updating in place does not create a second entry", async () => {
    const entry = await writeContext({
      roomId,
      type: "note",
      summary: "one",
      consuming_agents: [],
      payload: { text: "a" },
      author: "x",
    });
    await updateContext({ roomId, id: entry.id, author: "x", payload: { text: "b" } });

    const all = await listContext({ roomId });
    expect(all).toHaveLength(1);
    expect(all[0]!.payload.text).toBe("b");
  });

  test("validates a replaced payload against the original type", async () => {
    const entry = await writeContext({
      roomId,
      type: "api_contract",
      summary: "v1",
      consuming_agents: [],
      payload: contract,
      author: "backend",
    });

    await expect(
      updateContext({ roomId, id: entry.id, author: "backend", payload: { text: "wrong shape" } })
    ).rejects.toThrow(/Invalid payload/);
  });

  test("notifies consumers that the contract they depend on changed", async () => {
    const entry = await writeContext({
      roomId,
      type: "api_contract",
      summary: "v1",
      consuming_agents: ["frontend"],
      payload: contract,
      author: "backend",
    });

    await updateContext({ roomId, id: entry.id, author: "backend", summary: "v2" });

    const events = await getEvents(roomId, 10);
    const updateEvent = events.find((e) => e.type === "context_updated");
    expect(updateEvent?.to).toBe("frontend");
    expect(updateEvent?.payload.previousVersion).toBe("1.0");
    expect(updateEvent?.payload.version).toBe("1.1");
  });

  test("throws for an unknown id", async () => {
    await expect(
      updateContext({ roomId, id: "nope", author: "a", summary: "x" })
    ).rejects.toThrow("ContextEntry not found: nope");
  });
});

describe("listContext", () => {
  beforeEach(async () => {
    await writeContext({
      roomId,
      type: "note",
      summary: "from a",
      consuming_agents: [],
      payload: { text: "a" },
      author: "agent-a",
    });
    await writeContext({
      roomId,
      type: "api_contract",
      summary: "from b",
      consuming_agents: [],
      payload: contract,
      author: "agent-b",
    });
  });

  test("returns everything when unfiltered", async () => {
    expect(await listContext({ roomId })).toHaveLength(2);
  });

  test("filters by type", async () => {
    const notes = await listContext({ roomId, type: "note" });
    expect(notes.map((e) => e.summary)).toEqual(["from a"]);
  });

  test("filters by author", async () => {
    const byB = await listContext({ roomId, author: "agent-b" });
    expect(byB.map((e) => e.summary)).toEqual(["from b"]);
  });

  test("is scoped to one room", async () => {
    expect(await listContext({ roomId: "other-room" })).toEqual([]);
  });
});
