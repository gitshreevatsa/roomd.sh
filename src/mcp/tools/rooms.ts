import { z } from "zod";
import { nanoid } from "nanoid";
import type { KeyContext } from "../../types.js";
import {
  listTeamRooms,
  getAgents,
  unregisterAgent,
  clearHeartbeat,
  pushEvent,
} from "../../store/redis.js";

// ---------------------------------------------------------------------------
// list_rooms (team-scoped — no roomId)
// ---------------------------------------------------------------------------

export const listRoomsInput = z.object({});

/**
 * Rooms owned by the caller's team. Invite tokens only see their allowed room.
 */
export async function listRooms(
  _input: z.infer<typeof listRoomsInput>,
  keyCtx: KeyContext,
): Promise<{ rooms: string[] }> {
  if (keyCtx.isInvite) {
    return { rooms: keyCtx.allowedRoomId ? [keyCtx.allowedRoomId] : [] };
  }
  return { rooms: await listTeamRooms(keyCtx.teamId) };
}

// ---------------------------------------------------------------------------
// leave_room
// ---------------------------------------------------------------------------

export const leaveRoomInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
});

/**
 * Clean exit: drop presence immediately and announce departure.
 */
export async function leaveRoom(
  input: z.infer<typeof leaveRoomInput>,
): Promise<{ left: boolean; agentId: string; agents: string[] }> {
  await unregisterAgent(input.roomId, input.agentId);
  await clearHeartbeat(input.roomId, input.agentId);

  const now = new Date().toISOString();
  await pushEvent(input.roomId, {
    id: nanoid(),
    type: "agent_left",
    from: input.agentId,
    to: "all",
    payload: { agentId: input.agentId },
    timestamp: now,
    read_by: [],
  });

  const agents = await getAgents(input.roomId);
  return { left: true, agentId: input.agentId, agents };
}
