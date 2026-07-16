import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess, setHeartbeat, getAgentPresence, getEvents } from "../src/store/redis";
import { listRooms, leaveRoom } from "../src/mcp/tools/rooms";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
  fakeRedis.now = () => Date.now();
});

const teamA: KeyContext = { teamId: "team-a", isInvite: false, isStatic: true };

describe("listRooms", () => {
  test("returns rooms claimed by the team", async () => {
    await assertRoomAccess("alpha", teamA);
    await assertRoomAccess("beta", teamA);
    const { rooms } = await listRooms({}, teamA);
    expect(rooms).toEqual(["alpha", "beta"]);
  });

  test("invite tokens only see their allowed room", async () => {
    const invite: KeyContext = {
      teamId: "team-a",
      allowedRoomId: "alpha",
      isInvite: true,
      isStatic: false,
    };
    await assertRoomAccess("alpha", teamA);
    const { rooms } = await listRooms({}, invite);
    expect(rooms).toEqual(["alpha"]);
  });
});

describe("leaveRoom", () => {
  test("removes the agent from presence and posts agent_left", async () => {
    await assertRoomAccess("r1", teamA);
    await setHeartbeat("r1", "agent-1");
    await setHeartbeat("r1", "agent-2");

    const result = await leaveRoom({ roomId: "r1", agentId: "agent-1" });
    expect(result.left).toBe(true);
    expect(result.agents).toEqual(["agent-2"]);

    const presence = await getAgentPresence("r1");
    expect(presence.map((p) => p.agentId)).toEqual(["agent-2"]);

    const events = await getEvents("r1", 10);
    expect(events.some((e) => e.type === "agent_left")).toBe(true);
  });
});
