import { z } from "zod";
import { nanoid } from "nanoid";
import type { ContextEntry, ContextType } from "../../types.js";
import {
  getContext,
  setContext,
  getContextIndex,
  deleteContextEntry,
  pushContextHistory,
  getContextHistory,
  pushEvent,
} from "../../store/redis.js";
import { upsertContextVector } from "../../vector.js";

// ---------------------------------------------------------------------------
// Shared enum
// ---------------------------------------------------------------------------

const contextTypeEnum = z.enum([
  "api_contract",
  "arch_decision",
  "task",
  "change_request",
  "note",
]);

// ---------------------------------------------------------------------------
// Payload schemas, one per ContextType
//
// A consuming agent should be able to rely on the shape of a payload rather
// than parse prose. These schemas enforce the required fields at write time.
// Extra fields are allowed so a producer can add detail without a server change.
// ---------------------------------------------------------------------------

const endpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  path: z.string().min(1),
  request: z.record(z.unknown()).optional(),
  response: z.record(z.unknown()),
  auth_required: z.boolean(),
  description: z.string(),
});

const apiContractPayload = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  endpoints: z.array(endpointSchema).min(1),
  base_url: z.string().optional(),
}).passthrough();

const archDecisionPayload = z.object({
  title: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()),
  consequences: z.array(z.string()),
}).passthrough();

const taskPayload = z.object({
  task_id: z.string().min(1),
  acceptance_criteria: z.array(z.string()),
  technical_notes: z.string(),
}).passthrough();

const changeRequestPayload = z.object({
  requested_by: z.string().min(1),
  target_agent: z.string().min(1),
  description: z.string().min(1),
  urgency: z.enum(["low", "medium", "high"]),
  blocking_task_id: z.string().optional(),
}).passthrough();

const notePayload = z.object({
  text: z.string().min(1),
  references: z.array(z.string()).optional(),
}).passthrough();

const payloadSchemas: Record<ContextType, z.ZodTypeAny> = {
  api_contract: apiContractPayload,
  arch_decision: archDecisionPayload,
  task: taskPayload,
  change_request: changeRequestPayload,
  note: notePayload,
};

/**
 * Validate a payload against the schema for its context type.
 * Throws with the offending field paths so the calling agent can self-correct.
 */
export function validatePayload(
  type: ContextType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = payloadSchemas[type].safeParse(payload);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid payload for context type "${type}": ${problems}`);
  }
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// writeContext
// ---------------------------------------------------------------------------

export const writeContextInput = z.object({
  roomId: z.string(),
  type: contextTypeEnum,
  summary: z.string(),
  consuming_agents: z.array(z.string()),
  payload: z.record(z.unknown()),
  author: z.string(),
});

/**
 * Creates a new ContextEntry and persists it.
 * If consuming_agents is non-empty, automatically posts a context_available event
 * so those agents know to call read_context without polling.
 */
export async function writeContext(
  input: z.infer<typeof writeContextInput>,
): Promise<ContextEntry> {
  const payload = validatePayload(input.type, input.payload);

  const entry: ContextEntry = {
    id: nanoid(),
    type: input.type,
    author: input.author,
    timestamp: new Date().toISOString(),
    summary: input.summary,
    consuming_agents: input.consuming_agents,
    payload,
    version: "1.0",
  };
  await setContext(input.roomId, entry);
  void upsertContextVector(input.roomId, entry.id, entry.summary);

  if (input.consuming_agents.length > 0) {
    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "context_available",
      from: input.author,
      to: input.consuming_agents.length === 1
        ? (input.consuming_agents[0] ?? "all")
        : "all",
      payload: {
        contextId: entry.id,
        contextType: entry.type,
        summary: entry.summary,
        consuming_agents: entry.consuming_agents,
      },
      timestamp: entry.timestamp,
      read_by: [],
    });
  }

  return entry;
}

// ---------------------------------------------------------------------------
// updateContext
// ---------------------------------------------------------------------------

export const updateContextInput = z.object({
  roomId: z.string(),
  id: z.string().min(1),
  author: z.string().min(1),
  summary: z.string().optional(),
  consuming_agents: z.array(z.string()).optional(),
  payload: z.record(z.unknown()).optional(),
});

/**
 * Update an existing context entry in place. The type is immutable: an
 * api_contract stays an api_contract, otherwise consumers cannot rely on shape.
 *
 * A replaced payload is validated against the entry's type and the minor version
 * is bumped (1.0 to 1.1). Consuming agents are notified with a context_updated
 * event so nobody keeps building against a stale contract.
 */
export async function updateContext(
  input: z.infer<typeof updateContextInput>,
): Promise<ContextEntry> {
  const existing = await getContext(input.roomId, input.id);
  if (existing === null) {
    throw new Error(`ContextEntry not found: ${input.id}`);
  }

  const payload = input.payload !== undefined
    ? validatePayload(existing.type, input.payload)
    : existing.payload;

  const updated: ContextEntry = {
    ...existing,
    summary: input.summary ?? existing.summary,
    consuming_agents: input.consuming_agents ?? existing.consuming_agents,
    payload,
    author: input.author,
    timestamp: new Date().toISOString(),
    version: bumpVersion(existing.version),
  };

  // Keep prior snapshot for get_context_history before overwrite.
  await pushContextHistory(input.roomId, existing);
  await setContext(input.roomId, updated);
  void upsertContextVector(input.roomId, updated.id, updated.summary);

  if (updated.consuming_agents.length > 0) {
    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "context_updated",
      from: input.author,
      to: updated.consuming_agents.length === 1
        ? (updated.consuming_agents[0] ?? "all")
        : "all",
      payload: {
        contextId: updated.id,
        contextType: updated.type,
        summary: updated.summary,
        previousVersion: existing.version,
        version: updated.version,
      },
      timestamp: updated.timestamp,
      read_by: [],
    });
  }

  return updated;
}

/** "1.0" to "1.1", "1.9" to "1.10". Unparseable versions restart at 1.0. */
function bumpVersion(version: string): string {
  const [major, minor] = version.split(".");
  const majorNum = Number(major);
  const minorNum = Number(minor);
  if (!Number.isInteger(majorNum) || !Number.isInteger(minorNum)) return "1.0";
  return `${majorNum}.${minorNum + 1}`;
}

// ---------------------------------------------------------------------------
// readContext
// ---------------------------------------------------------------------------

export const readContextInput = z.object({
  roomId: z.string(),
  id: z.string(),
});

/** Retrieves a single ContextEntry by id from the given room, throwing if not found. */
export async function readContext(
  input: z.infer<typeof readContextInput>,
): Promise<ContextEntry> {
  const entry = await getContext(input.roomId, input.id);
  if (entry === null) {
    throw new Error(`ContextEntry not found: ${input.id}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// listContext
// ---------------------------------------------------------------------------

export const listContextInput = z.object({
  roomId: z.string(),
  type: contextTypeEnum.optional(),
  /** Return only entries written by this agent. */
  author: z.string().min(1).optional(),
});

/** Lists all ContextEntries for a room, with optional filters by type and author. */
export async function listContext(
  input: z.infer<typeof listContextInput>,
): Promise<ContextEntry[]> {
  const ids = await getContextIndex(input.roomId);
  const entries = await Promise.all(
    ids.map((id) => getContext(input.roomId, id)),
  );
  let filtered = entries.filter((e): e is ContextEntry => e !== null);

  if (input.type !== undefined) {
    filtered = filtered.filter((e) => e.type === input.type);
  }
  if (input.author !== undefined) {
    filtered = filtered.filter((e) => e.author === input.author);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// deleteContext
// ---------------------------------------------------------------------------

export const deleteContextInput = z.object({
  roomId: z.string().min(1),
  id: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

export const getContextHistoryInput = z.object({
  roomId: z.string().min(1),
  id: z.string().min(1),
});

/** Prior versions of a context entry, newest history first (excludes current). */
export async function getContextHistoryTool(
  input: z.infer<typeof getContextHistoryInput>,
): Promise<{ id: string; current: ContextEntry | null; history: ContextEntry[] }> {
  const current = await getContext(input.roomId, input.id);
  const history = await getContextHistory(input.roomId, input.id);
  return { id: input.id, current, history };
}

/** Remove a stale or wrong context entry. */
export async function deleteContext(
  input: z.infer<typeof deleteContextInput>,
): Promise<{ deleted: boolean; id: string }> {
  const existing = await getContext(input.roomId, input.id);
  if (!existing) {
    throw new Error(`ContextEntry not found: ${input.id}`);
  }
  await deleteContextEntry(input.roomId, input.id);
  const now = new Date().toISOString();
  await pushEvent(input.roomId, {
    id: nanoid(),
    type: "context_deleted",
    from: input.agentId ?? existing.author,
    to: "all",
    payload: { contextId: input.id, contextType: existing.type, summary: existing.summary },
    timestamp: now,
    read_by: [],
  });
  return { deleted: true, id: input.id };
}
