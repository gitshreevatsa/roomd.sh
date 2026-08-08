import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess } from "../src/store/redis";
import { writeContext, updateContext, getContextHistoryTool } from "../src/mcp/tools/context";
import { getRoomInfo } from "../src/mcp/tools/info";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
});

const team: KeyContext = { teamId: "t1", isInvite: false, isStatic: true, isOperator: false };

describe("get_context_history", () => {
  test("keeps prior versions when context is updated", async () => {
    await assertRoomAccess("rm", team);
    const entry = await writeContext({
      roomId: "rm",
      type: "note",
      author: "a1",
      summary: "v1",
      consuming_agents: [],
      payload: { text: "one" },
    });
    await updateContext({
      roomId: "rm",
      id: entry.id,
      author: "a1",
      summary: "v2",
      payload: { text: "two" },
    });
    const hist = await getContextHistoryTool({ roomId: "rm", id: entry.id });
    expect(hist.current?.summary).toBe("v2");
    expect(hist.history).toHaveLength(1);
    expect(hist.history[0]?.summary).toBe("v1");
  });
});

describe("get_room_info", () => {
  test("returns meta after claim", async () => {
    await assertRoomAccess("room-x", team);
    const info = await getRoomInfo({ roomId: "room-x" });
    expect(info.ownerTeamId).toBe("t1");
    expect(info.createdAt).toBeTruthy();
    expect(info.roomId).toBe("room-x");
  });
});
