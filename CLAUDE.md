# roomd: agent coordination server

roomd is an MCP server. Multiple coding agents join a room and share plan, context, events, presence, and locks. State lives in Upstash Redis. Humans watch from the dashboard.

Not a chat app.

roomd is the reference implementation of the **Room Protocol** (`../protocol/`). The protocol is the design; this file is about the server.

Version tracks the package (`package.json`). Deploy notes: `../docs/DEPLOY.md`.

---

## Connecting an agent to this server

Start the server (see `docs/SETUP.md`), then point your MCP client at it.
Claude Code, Cursor, and other HTTP MCP clients all work with the same URL and
Bearer key; only the config file differs. Snippets: `docs/SETUP.md` and the
dashboard setup guide.

### Claude Code

Add the following to `.claude/settings.json` in your project:

```json
{
  "mcpServers": {
    "roomd": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ROOMD_SECRET"
      }
    }
  }
}
```

### Cursor

Add the following to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "roomd": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ROOMD_SECRET"
      }
    }
  }
}
```

Replace `YOUR_ROOMD_SECRET` with a secret from `API_KEYS` (or `ROOMD_SECRET`) on the server.

The transport is streamable HTTP at `/mcp`. There is no SSE endpoint.

---

## Agent rules

Every agent connecting to roomd MUST follow these rules.

### Session start
1. Call `get_my_summary` with your `roomId` and `agentId`. One call returns your tasks, your unread events, how much new context exists, and who else is online.
2. Call `list_context` (optionally filtered by `type` or `author`) to load what you need before implementing anything.

### Picking up work
- Call `get_unblocked_tasks` to see what is safe to start. A task is unblocked when every id in its `depends_on` refers to a task that is `done`.
- Do not guess at ordering by reading the plan yourself.

### Context writing
- Never write prose to the context store. Always use the structured `payload` fields.
- The server validates `payload` against the schema for its `type` and rejects a write that does not match. The error names the offending field.
- When you complete an API design: `write_context` with `type: "api_contract"`.
- When you make an architecture decision: `write_context` with `type: "arch_decision"`.
- When a contract changes: `update_context`, not a second `write_context`. Writing a second entry leaves the stale one in place and consumers cannot tell which is current.
- When you need something from another agent: `write_context` with `type: "change_request"` and list that agent in `consuming_agents`. That stores a durable typed request and auto-posts `context_available`. Use `post_event` only for ephemeral signals (for example `peer_request` or `task_blocked`), not as a second schema named `change_request`.

### Task management
- Starting work: `update_task` with `status: "in_progress"` and your agent id as `owner`.
- Finishing: `update_task` with `status: "done"`.
- Blocked: `update_task` with `status: "blocked"` AND `post_event` with `type: "task_blocked"`.

### Reading events
- Call `get_unread_events` periodically. It uses a per-agent cursor (oldest-first batches) so each event is returned to you once under normal operation.
- Watch for `context_available` / `context_updated` (something you build against changed, or a `change_request` context entry targets you) and `task_blocked`.

### Staying visible
- Call `heartbeat` every ~60 seconds. You are considered offline after 120 seconds of silence.

### Shared variables
- `set_shared_var` is for small facts: a port, a staging URL, a migration name.
- Anything a consumer must reason about structurally belongs in `write_context`.

---

## Tools

| Category | Tools |
|---|---|
| Plan | `read_plan`, `add_task`, `update_task`, `get_task`, `get_unblocked_tasks`, `get_my_tasks`, `get_my_summary` |
| Context | `write_context`, `read_context`, `list_context`, `update_context` |
| Events | `post_event`, `read_events`, `get_unread_events`, `mark_event_read`, `get_event_reads`, `reply_to_event` |
| Presence | `heartbeat`, `get_presence` |
| Locks | `acquire_lock`, `release_lock`, `list_locks` |
| Shared vars | `set_shared_var`, `get_shared_var`, `list_shared_vars` |

Every tool takes `roomId` as a parameter. Access to the room is checked on every call.

---

## Payload schemas by ContextType

These are enforced at write time. Extra fields beyond those listed are allowed and preserved.

### `api_contract`

```typescript
interface ApiContractPayload {
  service: string;          // e.g. "auth-service"
  version: string;          // e.g. "1.0"
  endpoints: {              // at least one
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    path: string;           // e.g. "/api/v1/users/:id"
    request?: Record<string, unknown>;   // request body/params schema
    response: Record<string, unknown>;   // response schema
    auth_required: boolean;
    description: string;
  }[];
  base_url?: string;        // e.g. "https://api.example.com"
}
```

### `arch_decision`

```typescript
interface ArchDecisionPayload {
  title: string;            // e.g. "Use Upstash Redis for session state"
  decision: string;         // what was decided
  rationale: string;        // why
  alternatives: string[];   // what was considered and rejected
  consequences: string[];   // known trade-offs
}
```

### `task`

```typescript
interface TaskContextPayload {
  task_id: string;          // links to a Plan task id
  acceptance_criteria: string[];
  technical_notes: string;
}
```

### `change_request`

```typescript
interface ChangeRequestPayload {
  requested_by: string;     // agent id
  target_agent: string;     // agent id who should fulfill this
  description: string;      // what is needed
  urgency: "low" | "medium" | "high";
  blocking_task_id?: string; // task id that is blocked on this
}
```

### `note`

```typescript
interface NotePayload {
  text: string;             // free-form text note
  references?: string[];    // context ids or task ids this relates to
}
```

---

## Example agent workflow

**Scenario:** a backend agent designs the auth service, a frontend agent builds against it.

### Step 1: backend agent starts

```
roomId  = "my-project-v1"
agentId = "backend-claude"

get_my_summary({ roomId, agentId: "backend-claude" })
// tasks, unread events, presence, in one call

get_unblocked_tasks({ roomId, agentId: "backend-claude" })
// sees "design auth service API" is safe to start

update_task({ roomId, taskId: "task-abc123", status: "in_progress", owner: "backend-claude" })
```

### Step 2: backend agent posts the API contract

```
write_context({
  roomId,
  type: "api_contract",
  author: "backend-claude",
  summary: "Auth service REST API: login, token refresh, logout",
  consuming_agents: ["frontend-claude"],
  payload: {
    service: "auth-service",
    version: "1.0",
    endpoints: [
      {
        method: "POST",
        path: "/api/v1/auth/login",
        request: { email: "string", password: "string" },
        response: { access_token: "string", refresh_token: "string", expires_in: "number" },
        auth_required: false,
        description: "Exchange credentials for tokens"
      }
    ]
  }
})
```

`write_context` automatically posts a `context_available` event to `frontend-claude`. There is no need to announce it separately.

### Step 3: backend agent marks the task done

```
update_task({ roomId, taskId: "task-abc123", status: "done" })
```

`update_task` automatically posts a `task_updated` event to everyone.

### Step 4: frontend agent starts its session

```
get_my_summary({ roomId, agentId: "frontend-claude" })
// unreadEvents includes context_available from backend-claude

list_context({ roomId, type: "api_contract" })
// reads the contract, implements against it

update_task({ roomId, taskId: "task-def456", status: "in_progress", owner: "frontend-claude" })
```

### Step 5: frontend agent discovers a missing endpoint

```
write_context({
  roomId,
  type: "change_request",
  author: "frontend-claude",
  summary: "Need GET /api/v1/auth/me after login",
  consuming_agents: ["backend-claude"],
  payload: {
    requested_by: "frontend-claude",
    target_agent: "backend-claude",
    description: "Need GET /api/v1/auth/me to fetch the current user after login",
    urgency: "high",
    blocking_task_id: "task-def456"
  }
})
// auto-posts context_available to backend-claude

update_task({ roomId, taskId: "task-def456", status: "blocked", owner: "frontend-claude" })
```

### Step 6: backend agent responds and revises the contract

```
get_unread_events({ roomId, agentId: "backend-claude" })
// sees context_available for the change_request; then read_context / list_context

// Implements the endpoint, then updates the existing API contract in place.
update_context({
  roomId,
  id: "<api_contract context id from step 2>",
  author: "backend-claude",
  summary: "Auth service REST API v1.1: adds /me",
  payload: { ...contract with the new endpoint... }
})
// version goes 1.0 -> 1.1, and consuming agents get a context_updated event

reply_to_event({
  roomId,
  replyToId: "<the context_available event id>",
  type: "change_request_fulfilled",
  from: "backend-claude",
  to: "frontend-claude",
  payload: { contextId: "<api_contract context id>" }
})
```

---

## Redis key schema (reference)

Keys namespaced by `roomId` expire 30 days after the room's last tool call.

```
{roomId}:plan                 Plan JSON
{roomId}:context:{id}         ContextEntry JSON
{roomId}:context:index        SET of context ids
{roomId}:events               LIST of Event JSON (newest first, LPUSH)
{roomId}:agents               SET of agent ids
{roomId}:vars                 HASH of shared variables
{roomId}:lock:{resource}      lock holder, expires on its own TTL
{roomId}:locks                SET of locked resource names
{roomId}:heartbeat:{agentId}  last-seen timestamp, 120s TTL
{roomId}:cursor:{agentId}     per-agent event read position
{roomId}:event_reads:{id}     SET of agents that read an event
room:{roomId}:owner           teamId that owns the room
```

Auth and tenancy keys, not room-scoped:

```
dynkey:{sha256(secret)}       dynamic key record, looked up by digest
dynkeyid:{keyId}              key metadata, holds a hint and a digest, never the secret
dynkeys:{teamId}              SET of a team's key ids
invite:{sha256(token)}        invite record, carries the expiry TTL
inviteid:{tokenId}            invite metadata, never the raw token
room:{roomId}:invites         SET of a room's invite ids
ratelimit:{teamId}:{window}   fixed-window request counter
```

Secrets are never stored in plaintext. Only their SHA-256 digest is, so a Redis dump cannot be replayed as a set of live bearer tokens.

---

## Room inspection

```bash
curl -H "Authorization: Bearer YOUR_ROOMD_SECRET" http://localhost:3000/room/my-project-v1
```

Returns:
```json
{
  "roomId": "my-project-v1",
  "agents": ["backend-claude", "frontend-claude"],
  "taskCount": 5,
  "contextCount": 3,
  "recentEvents": [...]
}
```

Auth is required, and the key must own the room. Rooms hold API contracts and event payloads, so this endpoint is not public.
