import { z } from "zod";
import {
  getPlan,
  getEvents,
  getEventCount,
  getAgentPresence,
  getContextIndex,
  getRoomMeta,
  getRoomOwner,
} from "../../store/redis.js";

export const getRoomAnalyticsInput = z.object({
  roomId: z.string().min(1),
  /** Look-back window in days for events/day (default 7). */
  days: z.number().int().positive().max(90).optional(),
});

export async function getRoomAnalytics(
  input: z.infer<typeof getRoomAnalyticsInput>,
): Promise<{
  roomId: string;
  ownerTeamId: string | null;
  createdAt: string | null;
  tasks: { total: number; done: number; pending: number; inProgress: number; blocked: number; completionRate: number };
  agents: { total: number; online: number };
  contextCount: number;
  events: { total: number; lastDays: number; perDay: number };
}> {
  const days = input.days ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [plan, presence, contextIds, eventCount, recent, meta, owner] = await Promise.all([
    getPlan(input.roomId),
    getAgentPresence(input.roomId),
    getContextIndex(input.roomId),
    getEventCount(input.roomId),
    getEvents(input.roomId, 500),
    getRoomMeta(input.roomId),
    getRoomOwner(input.roomId),
  ]);

  const tasks = plan?.tasks ?? [];
  const done = tasks.filter((t) => t.status === "done").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const inWindow = recent.filter((e) => e.timestamp >= since).length;

  return {
    roomId: input.roomId,
    ownerTeamId: owner ?? meta?.ownerTeamId ?? null,
    createdAt: meta?.createdAt ?? null,
    tasks: {
      total: tasks.length,
      done,
      pending,
      inProgress,
      blocked,
      completionRate: tasks.length ? done / tasks.length : 0,
    },
    agents: {
      total: presence.length,
      online: presence.filter((p) => p.status === "online").length,
    },
    contextCount: contextIds.length,
    events: {
      total: eventCount,
      lastDays: days,
      perDay: Math.round((inWindow / days) * 100) / 100,
    },
  };
}
