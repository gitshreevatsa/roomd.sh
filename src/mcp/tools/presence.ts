import { z } from "zod";
import type { AgentPresence } from "../../types.js";
import { setHeartbeat, getAgentPresence } from "../../store/redis.js";

/** Input schema for heartbeat */
export const heartbeatInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
});

/**
 * Signal that this agent is alive. Call every ~60s to stay "online".
 * Returns current presence of all agents in the room.
 */
export async function heartbeatTool(
  input: z.infer<typeof heartbeatInput>,
): Promise<{ agentId: string; presence: AgentPresence[] }> {
  await setHeartbeat(input.roomId, input.agentId);
  const presence = await getAgentPresence(input.roomId);
  return { agentId: input.agentId, presence };
}

/** Input schema for get_presence */
export const getPresenceInput = z.object({
  roomId: z.string().min(1),
});

/**
 * Get the online/offline status of all agents in the room.
 * An agent is "online" if it sent a heartbeat within the last 120 seconds.
 */
export async function getPresenceTool(
  input: z.infer<typeof getPresenceInput>,
): Promise<AgentPresence[]> {
  return getAgentPresence(input.roomId);
}
