import { z } from "zod";
import { nanoid } from "nanoid";
import { assertRoomAccess, setPlan, pushEvent } from "../../store/redis.js";
import type { KeyContext } from "../../types.js";
import {
  ROOM_TEMPLATES,
  getTemplate,
  planFromTemplate,
} from "../../templates.js";

export const listTemplatesInput = z.object({});

export async function listTemplates(
  _input: z.infer<typeof listTemplatesInput>,
): Promise<{ templates: Array<{ id: string; name: string; description: string; taskCount: number }> }> {
  return {
    templates: ROOM_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      taskCount: t.tasks.length,
    })),
  };
}

export const createRoomFromTemplateInput = z.object({
  templateId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

/**
 * Claim a room (auto id if omitted) and seed its plan from a template.
 * Team-scoped: needs keyCtx for claim.
 */
export async function createRoomFromTemplate(
  input: z.infer<typeof createRoomFromTemplateInput>,
  keyCtx: KeyContext,
): Promise<{ roomId: string; templateId: string; taskCount: number }> {
  if (keyCtx.isInvite) {
    throw new Error("Invite tokens cannot create rooms from templates");
  }
  const template = getTemplate(input.templateId);
  if (!template) throw new Error(`Unknown template: ${input.templateId}`);

  const roomId = input.roomId?.trim() || nanoid(12);
  await assertRoomAccess(roomId, keyCtx);

  const plan = planFromTemplate(template, roomId);
  await setPlan(roomId, plan);

  const now = new Date().toISOString();
  await pushEvent(roomId, {
    id: nanoid(),
    type: "room_templated",
    from: input.agentId ?? "system",
    to: "all",
    payload: { templateId: template.id, taskCount: plan.tasks.length },
    timestamp: now,
    read_by: [],
  });

  return {
    roomId,
    templateId: template.id,
    taskCount: plan.tasks.length,
  };
}
