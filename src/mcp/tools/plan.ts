import { z } from "zod";
import { nanoid } from "nanoid";
import type { AgentPresence, Event, Plan, Task } from "../../types.js";
import {
  getPlan,
  setPlan,
  acquireLock,
  releaseLock,
  pushEvent,
  getEventCursor,
  getAgentPresence,
  getContextIndex,
  getContext,
} from "../../store/redis.js";
import { consumeUnreadEvents } from "./events.js";

// ---------------------------------------------------------------------------
// Internal: plan write lock
// ---------------------------------------------------------------------------

/**
 * Acquire the plan lock with exponential backoff, run fn, then release.
 * Prevents simultaneous plan writes from different agents corrupting each other.
 */
async function withPlanLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const lockId = `server:${nanoid()}`;
  let acquired = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    acquired = await acquireLock(roomId, "plan", lockId, 10_000);
    if (acquired) break;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }

  if (!acquired) {
    throw new Error("Plan is locked by another write in progress. Retry in a moment.");
  }

  try {
    return await fn();
  } finally {
    await releaseLock(roomId, "plan", lockId);
  }
}

// ---------------------------------------------------------------------------
// readPlan
// ---------------------------------------------------------------------------

export const readPlanInput = z.object({
  roomId: z.string(),
});

/** Reads the current Plan for a room, returning an empty Plan if none exists. */
export async function readPlan(
  input: z.infer<typeof readPlanInput>,
): Promise<Plan> {
  const existing = await getPlan(input.roomId);
  if (existing !== null) {
    return existing;
  }
  const now = new Date().toISOString();
  return {
    project: input.roomId,
    created_at: now,
    updated_at: now,
    tasks: [],
  };
}

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

export const updateTaskInput = z.object({
  roomId: z.string(),
  taskId: z.string(),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
  owner: z.string().optional(),
  note: z.string().optional(),
});

/** Updates a task's status and owner, then auto-posts a task_updated event so other agents are notified. */
export async function updateTask(
  input: z.infer<typeof updateTaskInput>,
): Promise<Task> {
  return withPlanLock(input.roomId, async () => {
    const plan = await readPlan({ roomId: input.roomId });
    const taskIndex = plan.tasks.findIndex((t) => t.id === input.taskId);
    if (taskIndex === -1) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    const existing = plan.tasks[taskIndex];
    if (existing === undefined) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    const updated: Task = {
      ...existing,
      status: input.status,
      owner: input.owner !== undefined ? input.owner : existing.owner,
      updated_at: new Date().toISOString(),
    };
    if (input.note !== undefined) {
      updated.description = input.note;
    }
    plan.tasks[taskIndex] = updated;
    plan.updated_at = updated.updated_at;
    await setPlan(input.roomId, plan);

    // Notify all agents that a task changed so they don't need to poll
    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "task_updated",
      from: input.owner ?? updated.owner ?? "system",
      to: "all",
      payload: { task: updated, previousStatus: existing.status },
      timestamp: updated.updated_at,
      read_by: [],
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// addTask
// ---------------------------------------------------------------------------

export const addTaskInput = z.object({
  roomId: z.string(),
  title: z.string(),
  description: z.string(),
  depends_on: z.array(z.string()).optional(),
});

/** Creates a new Task, appends it to the plan, and notifies all agents via an event. */
export async function addTask(
  input: z.infer<typeof addTaskInput>,
): Promise<Task> {
  return withPlanLock(input.roomId, async () => {
    const plan = await readPlan({ roomId: input.roomId });
    const now = new Date().toISOString();
    const task: Task = {
      id: nanoid(),
      title: input.title,
      description: input.description,
      status: "pending",
      owner: null,
      created_at: now,
      updated_at: now,
      depends_on: input.depends_on ?? [],
    };
    plan.tasks.push(task);
    plan.updated_at = now;
    await setPlan(input.roomId, plan);

    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "task_added",
      from: "system",
      to: "all",
      payload: { task },
      timestamp: now,
      read_by: [],
    });

    return task;
  });
}

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

export const getTaskInput = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
});

/** Fetch a single task by id without pulling down the whole plan. */
export async function getTask(
  input: z.infer<typeof getTaskInput>,
): Promise<Task> {
  const plan = await readPlan({ roomId: input.roomId });
  const task = plan.tasks.find((t) => t.id === input.taskId);
  if (task === undefined) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  return task;
}

// ---------------------------------------------------------------------------
// getUnblockedTasks
// ---------------------------------------------------------------------------

export const getUnblockedTasksInput = z.object({
  roomId: z.string().min(1),
  /** When set, only return unblocked tasks that are unowned or owned by this agent. */
  agentId: z.string().min(1).optional(),
});

/**
 * Return pending tasks whose dependencies are all done, so an agent can pick
 * up work without guessing at ordering. A dependency id that does not exist in
 * the plan is treated as unmet: a task cannot be safe to start if the thing it
 * names cannot be found.
 */
export async function getUnblockedTasks(
  input: z.infer<typeof getUnblockedTasksInput>,
): Promise<Task[]> {
  const plan = await readPlan({ roomId: input.roomId });
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  return plan.tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (input.agentId !== undefined && task.owner !== null && task.owner !== input.agentId) {
      return false;
    }
    return task.depends_on.every((depId) => byId.get(depId)?.status === "done");
  });
}

// ---------------------------------------------------------------------------
// deleteTask
// ---------------------------------------------------------------------------

export const deleteTaskInput = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

/** Remove one task from the plan and notify peers. */
export async function deleteTask(
  input: z.infer<typeof deleteTaskInput>,
): Promise<{ deleted: boolean; taskId: string }> {
  return withPlanLock(input.roomId, async () => {
    const plan = await readPlan({ roomId: input.roomId });
    const idx = plan.tasks.findIndex((t) => t.id === input.taskId);
    if (idx === -1) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    const [removed] = plan.tasks.splice(idx, 1);
    const now = new Date().toISOString();
    plan.updated_at = now;
    await setPlan(input.roomId, plan);

    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "task_deleted",
      from: input.agentId ?? "system",
      to: "all",
      payload: { taskId: input.taskId, task: removed },
      timestamp: now,
      read_by: [],
    });

    return { deleted: true, taskId: input.taskId };
  });
}

// ---------------------------------------------------------------------------
// setTaskPriority
// ---------------------------------------------------------------------------

export const setTaskPriorityInput = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
  priority: z.number().int(),
  agentId: z.string().min(1).optional(),
});

/** Set a task's priority (lower = more important). */
export async function setTaskPriority(
  input: z.infer<typeof setTaskPriorityInput>,
): Promise<Task> {
  return withPlanLock(input.roomId, async () => {
    const plan = await readPlan({ roomId: input.roomId });
    const idx = plan.tasks.findIndex((t) => t.id === input.taskId);
    if (idx === -1) throw new Error(`Task not found: ${input.taskId}`);
    const existing = plan.tasks[idx]!;
    const updated: Task = {
      ...existing,
      priority: input.priority,
      updated_at: new Date().toISOString(),
    };
    plan.tasks[idx] = updated;
    plan.updated_at = updated.updated_at;
    await setPlan(input.roomId, plan);

    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "task_updated",
      from: input.agentId ?? updated.owner ?? "system",
      to: "all",
      payload: { task: updated, previousStatus: existing.status },
      timestamp: updated.updated_at,
      read_by: [],
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// addDependency
// ---------------------------------------------------------------------------

export const addDependencyInput = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
  dependsOn: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

/** Declare that taskId depends on dependsOn (idempotent). */
export async function addDependency(
  input: z.infer<typeof addDependencyInput>,
): Promise<Task> {
  return withPlanLock(input.roomId, async () => {
    const plan = await readPlan({ roomId: input.roomId });
    if (!plan.tasks.some((t) => t.id === input.dependsOn)) {
      throw new Error(`Dependency task not found: ${input.dependsOn}`);
    }
    const idx = plan.tasks.findIndex((t) => t.id === input.taskId);
    if (idx === -1) throw new Error(`Task not found: ${input.taskId}`);
    if (input.taskId === input.dependsOn) {
      throw new Error("A task cannot depend on itself");
    }
    const existing = plan.tasks[idx]!;
    const depends_on = existing.depends_on.includes(input.dependsOn)
      ? existing.depends_on
      : [...existing.depends_on, input.dependsOn];
    const updated: Task = {
      ...existing,
      depends_on,
      updated_at: new Date().toISOString(),
    };
    plan.tasks[idx] = updated;
    plan.updated_at = updated.updated_at;
    await setPlan(input.roomId, plan);

    await pushEvent(input.roomId, {
      id: nanoid(),
      type: "task_updated",
      from: input.agentId ?? updated.owner ?? "system",
      to: "all",
      payload: { task: updated, previousStatus: existing.status },
      timestamp: updated.updated_at,
      read_by: [],
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// getMyTasks
// ---------------------------------------------------------------------------

export const getMyTasksInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
});

/** Returns only the tasks owned by this agent, so no need to scan the whole plan. */
export async function getMyTasks(
  input: z.infer<typeof getMyTasksInput>,
): Promise<Task[]> {
  const plan = await readPlan({ roomId: input.roomId });
  return plan.tasks.filter((t) => t.owner === input.agentId);
}

// ---------------------------------------------------------------------------
// getMySummary: cold-start recovery in one call
// ---------------------------------------------------------------------------

export const getMySummaryInput = z.object({
  roomId: z.string().min(1),
  agentId: z.string().min(1),
});

export interface MySummary {
  agentId: string;
  roomId: string;
  myTasks: Task[];
  unreadEvents: Event[];
  newContextCount: number;
  presence: AgentPresence[];
  cursor: string | null;
}

/**
 * One-shot session start tool. Returns:
 * - Tasks owned by this agent
 * - Unread events (oldest first; advances cursor past the returned batch)
 * - How many context entries are new since the prior cursor
 * - Presence of all agents
 */
export async function getMySummary(
  input: z.infer<typeof getMySummaryInput>,
): Promise<MySummary> {
  const priorCursor = await getEventCursor(input.roomId, input.agentId);

  const [plan, unread, contextIds, presence] = await Promise.all([
    readPlan({ roomId: input.roomId }),
    consumeUnreadEvents(input.roomId, input.agentId, 50),
    getContextIndex(input.roomId),
    getAgentPresence(input.roomId),
  ]);

  const myTasks = plan.tasks.filter((t) => t.owner === input.agentId);

  // Count context entries created after the prior cursor (before this consume).
  let newContextCount = contextIds.length;
  if (priorCursor !== null) {
    const entries = await Promise.all(
      contextIds.map((id) => getContext(input.roomId, id)),
    );
    newContextCount = entries.filter(
      (e) => e !== null && new Date(e.timestamp) > new Date(priorCursor),
    ).length;
  }

  return {
    agentId: input.agentId,
    roomId: input.roomId,
    myTasks,
    unreadEvents: unread.events,
    newContextCount,
    presence,
    cursor: unread.cursor,
  };
}
