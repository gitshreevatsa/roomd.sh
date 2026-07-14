import { z } from "zod";
import { nanoid } from "nanoid";
import {
  setSharedVar,
  getSharedVar,
  listSharedVars,
  pushEvent,
} from "../../store/redis.js";

/**
 * Shared variables are the escape hatch for small facts that do not deserve a
 * typed context entry: a chosen port, a staging URL, a migration name. Anything
 * a consuming agent must reason about structurally belongs in write_context.
 */

const VALUE_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// setSharedVar
// ---------------------------------------------------------------------------

export const setSharedVarInput = z.object({
  roomId: z.string().min(1),
  key: z.string().min(1).max(128),
  value: z.string().max(VALUE_MAX_LENGTH),
  agentId: z.string().min(1),
});

/** Set a shared variable and announce the change so other agents can react. */
export async function setSharedVarTool(
  input: z.infer<typeof setSharedVarInput>,
): Promise<{ key: string; value: string }> {
  await setSharedVar(input.roomId, input.key, input.value);

  await pushEvent(input.roomId, {
    id: nanoid(),
    type: "shared_var_set",
    from: input.agentId,
    to: "all",
    payload: { key: input.key, value: input.value },
    timestamp: new Date().toISOString(),
    read_by: [],
  });

  return { key: input.key, value: input.value };
}

// ---------------------------------------------------------------------------
// getSharedVar
// ---------------------------------------------------------------------------

export const getSharedVarInput = z.object({
  roomId: z.string().min(1),
  key: z.string().min(1),
});

/** Read one shared variable. `found` distinguishes an unset key from an empty value. */
export async function getSharedVarTool(
  input: z.infer<typeof getSharedVarInput>,
): Promise<{ key: string; value: string | null; found: boolean }> {
  const value = await getSharedVar(input.roomId, input.key);
  return { key: input.key, value, found: value !== null };
}

// ---------------------------------------------------------------------------
// listSharedVars
// ---------------------------------------------------------------------------

export const listSharedVarsInput = z.object({
  roomId: z.string().min(1),
});

/** Return every shared variable in the room. */
export async function listSharedVarsTool(
  input: z.infer<typeof listSharedVarsInput>,
): Promise<{ vars: Record<string, string>; count: number }> {
  const vars = await listSharedVars(input.roomId);
  return { vars, count: Object.keys(vars).length };
}
