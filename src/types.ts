export type ContextType =
  | "api_contract"
  | "arch_decision"
  | "task"
  | "change_request"
  | "note";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export interface ContextEntry {
  id: string;
  type: ContextType;
  author: string;
  timestamp: string;
  summary: string;
  consuming_agents: string[];
  payload: Record<string, unknown>;
  version: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  created_at: string;
  updated_at: string;
  depends_on: string[];
  /** Lower number = higher importance. Optional for back-compat. */
  priority?: number;
}

export interface Plan {
  project: string;
  created_at: string;
  updated_at: string;
  tasks: Task[];
}

export interface Event {
  id: string;
  type: string;
  from: string;
  to: string | "all";
  payload: Record<string, unknown>;
  timestamp: string;
  read_by: string[];
  reply_to_id?: string;
}

export type AgentOnlineStatus = "online" | "offline";

export interface AgentPresence {
  agentId: string;
  status: AgentOnlineStatus;
  lastSeen: string | null;
}

/**
 * Resolved identity for a single HTTP request.
 * Derived from the Bearer token by resolveKey() in auth.ts.
 */
export interface KeyContext {
  teamId: string;
  /** Set only for room-scoped invite tokens. Restricts access to one room. */
  allowedRoomId?: string;
  /** True when this is an invite token (skips ownership claim). */
  isInvite: boolean;
  /** True when resolved from a static API_KEYS / ROOMD_SECRET env var. */
  isStatic: boolean;
  /**
   * True only for operator secrets (OPERATOR_KEYS, or legacy sole ROOMD_SECRET).
   * Operator may provision teams, read cross-room stats, and revoke any key.
   * Per-team API_KEYS entries are never operators.
   */
  isOperator: boolean;
  /**
   * Bound agent identity for invite tokens. MCP injects this into agentId /
   * from / author so clients cannot spoof another agent.
   */
  agentId?: string;
  /**
   * Credential-bound agent id (invite token or dyn key metadata).
   * When set, MCP overwrites agentId/from/author; approve/reject require it.
   */
  boundAgentId?: string;
}
