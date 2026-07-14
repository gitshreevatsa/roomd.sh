import { z } from "zod";
import { acquireLock, releaseLock, listActiveLocks } from "../../store/redis.js";

/** Input schema for acquire_lock */
export const acquireLockInput = z.object({
  roomId: z.string().min(1),
  resource: z.string().min(1),
  agentId: z.string().min(1),
  ttlSeconds: z.number().int().positive().max(300).optional(),
});

/** Attempt to acquire a distributed lock on a named resource. */
export async function acquireLockTool(
  input: z.infer<typeof acquireLockInput>,
): Promise<{ acquired: boolean; resource: string; holder: string; ttlSeconds: number }> {
  const ttlSeconds = input.ttlSeconds ?? 30;
  const acquired = await acquireLock(
    input.roomId,
    input.resource,
    input.agentId,
    ttlSeconds * 1000,
  );
  return { acquired, resource: input.resource, holder: input.agentId, ttlSeconds };
}

/** Input schema for release_lock */
export const releaseLockInput = z.object({
  roomId: z.string().min(1),
  resource: z.string().min(1),
  agentId: z.string().min(1),
});

/** Release a lock. Only succeeds if the calling agent currently holds it. */
export async function releaseLockTool(
  input: z.infer<typeof releaseLockInput>,
): Promise<{ released: boolean; resource: string }> {
  const released = await releaseLock(input.roomId, input.resource, input.agentId);
  return { released, resource: input.resource };
}

/** Input schema for list_locks */
export const listLocksInput = z.object({
  roomId: z.string().min(1),
});

/** List all active locks in the room with their current holders. */
export async function listLocksTool(
  input: z.infer<typeof listLocksInput>,
): Promise<Array<{ resource: string; owner: string }>> {
  return listActiveLocks(input.roomId);
}
