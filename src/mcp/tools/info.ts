import { z } from "zod";
import {
  getRoomMeta,
  getRoomOwner,
  getAgents,
  getContextIndex,
  getEventCount,
  getPlan,
} from "../../store/redis.js";

export const getRoomInfoInput = z.object({
  roomId: z.string().min(1),
});

export async function getRoomInfo(
  input: z.infer<typeof getRoomInfoInput>,
): Promise<{
  roomId: string;
  ownerTeamId: string | null;
  createdAt: string | null;
  memberCount: number;
  taskCount: number;
  contextCount: number;
  eventCount: number;
}> {
  const [meta, owner, agents, plan, contextIds, eventCount] = await Promise.all([
    getRoomMeta(input.roomId),
    getRoomOwner(input.roomId),
    getAgents(input.roomId),
    getPlan(input.roomId),
    getContextIndex(input.roomId),
    getEventCount(input.roomId),
  ]);

  return {
    roomId: input.roomId,
    ownerTeamId: owner ?? meta?.ownerTeamId ?? null,
    createdAt: meta?.createdAt ?? null,
    memberCount: agents.length,
    taskCount: plan?.tasks.length ?? 0,
    contextCount: contextIds.length,
    eventCount,
  };
}
