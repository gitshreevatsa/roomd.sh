import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { assertRoomAccess } from "../store/redis.js";
import type { KeyContext } from "../types.js";
import {
  readPlanInput,
  readPlan,
  updateTaskInput,
  updateTask,
  addTaskInput,
  addTask,
  getTaskInput,
  getTask,
  getUnblockedTasksInput,
  getUnblockedTasks,
  getMyTasksInput,
  getMyTasks,
  getMySummaryInput,
  getMySummary,
  deleteTaskInput,
  deleteTask,
  setTaskPriorityInput,
  setTaskPriority,
  addDependencyInput,
  addDependency,
} from "./tools/plan.js";
import {
  writeContextInput,
  writeContext,
  readContextInput,
  readContext,
  listContextInput,
  listContext,
  updateContextInput,
  updateContext,
  deleteContextInput,
  deleteContext,
  getContextHistoryInput,
  getContextHistoryTool,
} from "./tools/context.js";
import { getRoomInfoInput, getRoomInfo } from "./tools/info.js";
import { searchInput, search } from "./tools/search.js";
import { waitForEventsInput, waitForEvents } from "./tools/wait.js";
import { diffContextInput, diffContext } from "./tools/diff.js";
import { getRoomAnalyticsInput, getRoomAnalytics } from "./tools/analytics.js";
import {
  listTemplatesInput,
  listTemplates,
  createRoomFromTemplateInput,
  createRoomFromTemplate,
} from "./tools/templates.js";
import {
  postEventInput,
  postEvent,
  readEventsInput,
  readEvents,
  getUnreadEventsInput,
  getUnreadEvents,
  markEventReadInput,
  markEventReadTool,
  getEventReadsInput,
  getEventReadsTool,
  replyToEventInput,
  replyToEvent,
  deleteEventInput,
  deleteEvent,
} from "./tools/events.js";
import {
  heartbeatInput,
  heartbeatTool,
  getPresenceInput,
  getPresenceTool,
} from "./tools/presence.js";
import {
  acquireLockInput,
  acquireLockTool,
  releaseLockInput,
  releaseLockTool,
  listLocksInput,
  listLocksTool,
} from "./tools/lock.js";
import {
  setSharedVarInput,
  setSharedVarTool,
  getSharedVarInput,
  getSharedVarTool,
  listSharedVarsInput,
  listSharedVarsTool,
} from "./tools/vars.js";
import {
  listRoomsInput,
  listRooms,
  leaveRoomInput,
  leaveRoom,
} from "./tools/rooms.js";
import {
  requestReviewInput,
  requestReview,
  approveInput,
  approve,
  rejectInput,
  reject,
  listReviewsInput,
  listReviewsTool,
} from "./tools/review.js";

/**
 * Every tool takes a roomId. Constraining the shape this way means a tool that
 * forgets it will not compile, so the access check below can never be a no-op.
 */
type RoomShape = z.ZodRawShape & { roomId: z.ZodString };

/**
 * Register one room-scoped tool.
 *
 * Access control is enforced here rather than in each handler, so a new tool
 * cannot accidentally skip the ownership check. Handlers stay pure: they take
 * validated input and return a value, and never think about auth or transport.
 */
function registerRoomTool<Shape extends RoomShape>(
  server: McpServer,
  keyCtx: KeyContext,
  name: string,
  description: string,
  schema: z.ZodObject<Shape>,
  handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
): void {
  const callback = async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = schema.parse(input);
      // The RoomShape constraint guarantees roomId, but TypeScript cannot
      // narrow it through the generic shape, so assert it here.
      const { roomId } = parsed as z.infer<z.ZodObject<Shape>> & { roomId: string };
      await assertRoomAccess(roomId, keyCtx);
      const result = await handler(parsed);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };

  // The SDK resolves its callback type from the concrete input shape, which it
  // cannot do while Shape is still generic. The cast is safe: the callback
  // accepts unknown and validates with the same schema the SDK advertises.
  server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    callback as ToolCallback<Shape>,
  );
}

/** Team-scoped tool (no room ownership check; handler receives keyCtx). */
function registerTeamTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  keyCtx: KeyContext,
  name: string,
  description: string,
  schema: z.ZodObject<Shape>,
  handler: (
    input: z.infer<z.ZodObject<Shape>>,
    keyCtx: KeyContext,
  ) => Promise<unknown>,
): void {
  const callback = async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = schema.parse(input);
      const result = await handler(parsed, keyCtx);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
  server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    callback as ToolCallback<Shape>,
  );
}

/** Creates and returns a configured McpServer with all roomd tools registered. */
export function createMcpServer(keyCtx: KeyContext): McpServer {
  const server = new McpServer({
    name: "roomd",
    version: "1.1.0",
  });

  const tool = <Shape extends RoomShape>(
    name: string,
    description: string,
    schema: z.ZodObject<Shape>,
    handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) => registerRoomTool(server, keyCtx, name, description, schema, handler);

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  tool(
    "read_plan",
    "Read the current plan (tasks, status, owners) for a room",
    readPlanInput,
    readPlan,
  );

  tool(
    "update_task",
    "Update a task status and optional owner in the room plan",
    updateTaskInput,
    updateTask,
  );

  tool(
    "add_task",
    "Add a new pending task to the room plan",
    addTaskInput,
    addTask,
  );

  tool(
    "get_task",
    "Fetch a single task by id without reading the entire plan",
    getTaskInput,
    getTask,
  );

  tool(
    "get_unblocked_tasks",
    "List pending tasks whose dependencies are all done. Call this to decide what to start next.",
    getUnblockedTasksInput,
    getUnblockedTasks,
  );

  tool(
    "get_my_tasks",
    "Return only the tasks owned by your agent. No need to scan the entire plan.",
    getMyTasksInput,
    getMyTasks,
  );

  tool(
    "get_my_summary",
    "One-shot session start: returns your tasks, unread events, new context count, and agent presence in a single call.",
    getMySummaryInput,
    getMySummary,
  );

  tool(
    "delete_task",
    "Remove a cancelled or duplicate task from the room plan.",
    deleteTaskInput,
    deleteTask,
  );

  tool(
    "set_task_priority",
    "Set a task's priority (lower number = higher importance).",
    setTaskPriorityInput,
    setTaskPriority,
  );

  tool(
    "add_dependency",
    "Declare that one task depends on another after both exist.",
    addDependencyInput,
    addDependency,
  );

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------

  tool(
    "write_context",
    "Store a structured context entry (api_contract, arch_decision, task, change_request, note). The payload must match the schema for its type.",
    writeContextInput,
    writeContext,
  );

  tool(
    "read_context",
    "Read a single context entry by id",
    readContextInput,
    readContext,
  );

  tool(
    "list_context",
    "List context entries in a room, optionally filtered by type and author",
    listContextInput,
    listContext,
  );

  tool(
    "update_context",
    "Update an existing context entry in place and bump its version. Use this when an API contract evolves instead of writing a second entry.",
    updateContextInput,
    updateContext,
  );

  tool(
    "delete_context",
    "Remove a stale or wrong context entry from the room.",
    deleteContextInput,
    deleteContext,
  );

  tool(
    "get_context_history",
    "Return prior versions of a context entry (newest history first), plus the current version.",
    getContextHistoryInput,
    getContextHistoryTool,
  );

  tool(
    "get_room_info",
    "Room metadata: owner team, created time, member/task/context/event counts.",
    getRoomInfoInput,
    getRoomInfo,
  );

  tool(
    "search",
    "Full-text search across tasks, context, and recent events in the room. Set semantic:true only when Upstash Vector is configured.",
    searchInput,
    search,
  );

  tool(
    "wait_for_events",
    "Block briefly (up to timeoutMs) until unread events arrive for your agent. MCP-friendly alternative to SSE.",
    waitForEventsInput,
    waitForEvents,
  );

  tool(
    "diff_context",
    "Diff the current context entry against a prior version from history.",
    diffContextInput,
    diffContext,
  );

  tool(
    "get_room_analytics",
    "Room analytics: task completion rate, online agents, events per day.",
    getRoomAnalyticsInput,
    getRoomAnalytics,
  );

  registerTeamTool(
    server,
    keyCtx,
    "list_templates",
    "List built-in room templates (blank, web-app, incident, …).",
    listTemplatesInput,
    async (input) => listTemplates(input),
  );

  registerTeamTool(
    server,
    keyCtx,
    "create_room_from_template",
    "Create (or claim) a room and seed its plan from a template. Omits roomId to auto-generate.",
    createRoomFromTemplateInput,
    createRoomFromTemplate,
  );

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  tool(
    "post_event",
    "Post an event to the room event bus",
    postEventInput,
    postEvent,
  );

  tool(
    "read_events",
    "Read recent events from the room",
    readEventsInput,
    readEvents,
  );

  tool(
    "get_unread_events",
    "Returns events you have not seen yet (oldest first), based on a per-agent cursor. Advances the cursor to the last returned event so each event is delivered once; call again to drain a large backlog.",
    getUnreadEventsInput,
    getUnreadEvents,
  );

  tool(
    "mark_event_read",
    "Mark an event as read by your agent so the sender can confirm delivery.",
    markEventReadInput,
    markEventReadTool,
  );

  tool(
    "get_event_reads",
    "Check which agents have read a specific event by its id.",
    getEventReadsInput,
    getEventReadsTool,
  );

  tool(
    "reply_to_event",
    "Post an event that is explicitly linked to a previous event. Enables threaded conversations between agents.",
    replyToEventInput,
    replyToEvent,
  );

  tool(
    "delete_event",
    "Remove one event from the room log (cleanup of processed noise).",
    deleteEventInput,
    deleteEvent,
  );

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  tool(
    "heartbeat",
    "Signal you are alive. Call every ~60s to stay online. Returns presence of all agents in the room.",
    heartbeatInput,
    heartbeatTool,
  );

  tool(
    "get_presence",
    "Check which agents are online (heartbeat within 120s) and which are offline.",
    getPresenceInput,
    getPresenceTool,
  );

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  tool(
    "acquire_lock",
    "Acquire a distributed lock on a named resource (e.g. 'plan'). Returns acquired: false if already held, so retry or wait.",
    acquireLockInput,
    acquireLockTool,
  );

  tool(
    "release_lock",
    "Release a lock you hold. Only works if your agentId currently holds it.",
    releaseLockInput,
    releaseLockTool,
  );

  tool(
    "list_locks",
    "List all active locks in the room and which agent holds each one.",
    listLocksInput,
    listLocksTool,
  );

  // -------------------------------------------------------------------------
  // Shared variables
  // -------------------------------------------------------------------------

  tool(
    "set_shared_var",
    "Set a small shared fact for the room (a port, a staging URL). Anything a consumer must reason about structurally belongs in write_context instead.",
    setSharedVarInput,
    setSharedVarTool,
  );

  tool(
    "get_shared_var",
    "Read one shared variable by key.",
    getSharedVarInput,
    getSharedVarTool,
  );

  tool(
    "list_shared_vars",
    "Read every shared variable in the room.",
    listSharedVarsInput,
    listSharedVarsTool,
  );

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  registerTeamTool(
    server,
    keyCtx,
    "list_rooms",
    "List room ids owned by your team (or the single room an invite token may access).",
    listRoomsInput,
    listRooms,
  );

  tool(
    "leave_room",
    "Leave a room immediately: drop your presence and notify other agents.",
    leaveRoomInput,
    leaveRoom,
  );

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  tool(
    "request_review",
    "Ask another agent to approve or reject a task or context entry.",
    requestReviewInput,
    requestReview,
  );

  tool(
    "approve",
    "Approve a pending review (must be the assigned reviewer).",
    approveInput,
    approve,
  );

  tool(
    "reject",
    "Reject a pending review (must be the assigned reviewer).",
    rejectInput,
    reject,
  );

  tool(
    "list_reviews",
    "List reviews in the room, optionally filtered by status.",
    listReviewsInput,
    listReviewsTool,
  );

  return server;
}
