import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { heartbeatTool, getPresenceTool } from "../src/mcp/tools/presence.js";
import { acquireLockTool, releaseLockTool, listLocksTool } from "../src/mcp/tools/lock.js";
import {
  setSharedVarTool,
  getSharedVarTool,
  listSharedVarsTool,
} from "../src/mcp/tools/vars.js";
import { getEvents } from "../src/store/redis.js";

const roomId = "test-room";

beforeEach(() => fakeRedis.flush());
afterEach(() => {
  fakeRedis.now = () => Date.now();
});

describe("presence", () => {
  test("a heartbeat registers the agent and marks it online", async () => {
    const result = await heartbeatTool({ roomId, agentId: "backend" });
    expect(result.presence).toEqual([
      expect.objectContaining({ agentId: "backend", status: "online" }),
    ]);
  });

  test("an agent goes offline once its heartbeat expires, but stays known", async () => {
    await heartbeatTool({ roomId, agentId: "backend" });

    // Heartbeats live for 120s. Move the clock past that.
    const later = Date.now() + 121_000;
    fakeRedis.now = () => later;

    const presence = await getPresenceTool({ roomId });
    expect(presence).toEqual([
      expect.objectContaining({ agentId: "backend", status: "offline", lastSeen: null }),
    ]);
  });

  test("presence covers every agent in the room", async () => {
    await heartbeatTool({ roomId, agentId: "a" });
    await heartbeatTool({ roomId, agentId: "b" });
    const presence = await getPresenceTool({ roomId });
    expect(presence.map((p) => p.agentId).sort()).toEqual(["a", "b"]);
  });
});

describe("locks", () => {
  test("the first agent acquires and the second is refused", async () => {
    const first = await acquireLockTool({ roomId, resource: "plan", agentId: "a" });
    expect(first.acquired).toBe(true);

    const second = await acquireLockTool({ roomId, resource: "plan", agentId: "b" });
    expect(second.acquired).toBe(false);
  });

  test("only the holder can release", async () => {
    await acquireLockTool({ roomId, resource: "plan", agentId: "a" });

    expect((await releaseLockTool({ roomId, resource: "plan", agentId: "b" })).released).toBe(false);
    expect((await releaseLockTool({ roomId, resource: "plan", agentId: "a" })).released).toBe(true);
  });

  test("a released lock can be taken by someone else", async () => {
    await acquireLockTool({ roomId, resource: "plan", agentId: "a" });
    await releaseLockTool({ roomId, resource: "plan", agentId: "a" });

    expect((await acquireLockTool({ roomId, resource: "plan", agentId: "b" })).acquired).toBe(true);
  });

  test("an expired lock is acquirable again and drops out of list_locks", async () => {
    await acquireLockTool({ roomId, resource: "plan", agentId: "a", ttlSeconds: 30 });

    const later = Date.now() + 31_000;
    fakeRedis.now = () => later;

    expect(await listLocksTool({ roomId })).toEqual([]);
    expect((await acquireLockTool({ roomId, resource: "plan", agentId: "b" })).acquired).toBe(true);
  });

  test("list_locks reports the holder", async () => {
    await acquireLockTool({ roomId, resource: "schema", agentId: "a" });
    expect(await listLocksTool({ roomId })).toEqual([{ resource: "schema", owner: "a" }]);
  });

  test("locks on different resources do not collide", async () => {
    await acquireLockTool({ roomId, resource: "plan", agentId: "a" });
    expect((await acquireLockTool({ roomId, resource: "schema", agentId: "b" })).acquired).toBe(true);
  });
});

describe("shared vars", () => {
  test("set then get round-trips", async () => {
    await setSharedVarTool({ roomId, key: "staging_url", value: "https://x.test", agentId: "a" });
    const result = await getSharedVarTool({ roomId, key: "staging_url" });
    expect(result).toEqual({ key: "staging_url", value: "https://x.test", found: true });
  });

  test("a missing key reports found: false rather than an empty string", async () => {
    expect(await getSharedVarTool({ roomId, key: "nope" })).toEqual({
      key: "nope",
      value: null,
      found: false,
    });
  });

  test("an empty value is distinguishable from an unset key", async () => {
    await setSharedVarTool({ roomId, key: "empty", value: "", agentId: "a" });
    expect((await getSharedVarTool({ roomId, key: "empty" })).found).toBe(true);
  });

  test("setting overwrites and announces the change", async () => {
    await setSharedVarTool({ roomId, key: "port", value: "3000", agentId: "a" });
    await setSharedVarTool({ roomId, key: "port", value: "4000", agentId: "b" });

    expect((await getSharedVarTool({ roomId, key: "port" })).value).toBe("4000");

    const events = await getEvents(roomId, 10);
    expect(events[0]!.type).toBe("shared_var_set");
    expect(events[0]!.from).toBe("b");
  });

  test("list returns every var with a count", async () => {
    await setSharedVarTool({ roomId, key: "a", value: "1", agentId: "x" });
    await setSharedVarTool({ roomId, key: "b", value: "2", agentId: "x" });

    expect(await listSharedVarsTool({ roomId })).toEqual({
      vars: { a: "1", b: "2" },
      count: 2,
    });
  });

  test("vars are scoped to one room", async () => {
    await setSharedVarTool({ roomId, key: "a", value: "1", agentId: "x" });
    expect(await listSharedVarsTool({ roomId: "other" })).toEqual({ vars: {}, count: 0 });
  });
});
