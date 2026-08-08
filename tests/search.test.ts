import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess } from "../src/store/redis";
import { addTask } from "../src/mcp/tools/plan";
import { writeContext } from "../src/mcp/tools/context";
import { search } from "../src/mcp/tools/search";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
});

const team: KeyContext = { teamId: "t1", isInvite: false, isStatic: true, isOperator: false };

describe("search", () => {
  test("finds tasks and context by substring", async () => {
    await assertRoomAccess("rm", team);
    await addTask({
      roomId: "rm",
      title: "Wire auth middleware",
      description: "JWT validation",
    });
    await writeContext({
      roomId: "rm",
      type: "note",
      author: "a1",
      summary: "Auth notes for middleware",
      consuming_agents: [],
      payload: { text: "use HS256" },
    });

    const { hits } = await search({ roomId: "rm", q: "auth" });
    expect(hits.some((h) => h.kind === "task")).toBe(true);
    expect(hits.some((h) => h.kind === "context")).toBe(true);
  });

  test("semantic mode errors when vector is not configured", async () => {
    await assertRoomAccess("rm", team);
    delete process.env["UPSTASH_VECTOR_REST_URL"];
    delete process.env["UPSTASH_VECTOR_REST_TOKEN"];
    await expect(
      search({ roomId: "rm", q: "auth", semantic: true }),
    ).rejects.toThrow(/not configured/);
  });
});
