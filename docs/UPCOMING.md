# roomd roadmap

Current version: **v0.3.0**. 25 tools. Not deployed anywhere; local only.

This file tracks what is left. Everything listed as built has a test covering it
in `tests/`. Run `bun test` before trusting this document.

---

## Shipped

### v0.2: multi-tenancy
| Item | Where |
|---|---|
| Multi-tenant API keys (static, dynamic, invite) | `src/auth.ts` |
| Room ownership by first-touch claim | `assertRoomAccess` in `src/store/redis.ts` |
| Per-team rate limiting, fails open | `checkRateLimit` |
| Per-agent event cursors (`get_unread_events`) | `src/mcp/tools/events.ts` |
| Read receipts (`mark_event_read`, `get_event_reads`) | `src/mcp/tools/events.ts` |
| Presence (`heartbeat`, `get_presence`) | `src/mcp/tools/presence.ts` |
| Locks (`acquire_lock`, `release_lock`, `list_locks`) | `src/mcp/tools/lock.ts` |
| Room invite tokens, optionally expiring | `storeInviteToken` |

### v0.3: core experience
| Item | Where |
|---|---|
| `get_task` | `src/mcp/tools/plan.ts` |
| `get_unblocked_tasks` | `src/mcp/tools/plan.ts` |
| `update_context` with version bump | `src/mcp/tools/context.ts` |
| `set_shared_var` / `get_shared_var` / `list_shared_vars` | `src/mcp/tools/vars.ts` |
| `list_context` filter by author | `src/mcp/tools/context.ts` |
| Payload schema validation per ContextType | `validatePayload` |
| Room TTL, 30 days, refreshed on every tool call | `touchRoomTtl` |
| Secrets stored as SHA-256 digests, never plaintext | `hashSecret` |
| Constant-time comparison of static keys | `digestsMatch` in `src/auth.ts` |
| `GET /room/:roomId` requires auth and room access | `src/index.ts` |

---

## Not built

### v0.4: quality of life
| Tool | Why |
|---|---|
| `delete_task` | Remove cancelled or duplicate tasks |
| `set_task_priority` | Order tasks by importance |
| `add_dependency` | Declare task ordering after creation |
| `delete_context` | Remove stale or wrong entries |
| `delete_event` | Clean up processed events |
| `request_review` / `approve` / `reject` | Structured approval flow between agents |
| `leave_room` | Clean agent exit, drops presence immediately |
| `list_rooms` | See the rooms your key owns. Needs a per-team room index. |

| Infrastructure | Why |
|---|---|
| Structured logging (JSON to stdout) | Searchable logs |
| Context versioning | Append-only history rather than in-place update |
| Auto-generated roomId | roomd-web does this today; the server does not |

### v1.0: scale
| Item | Why |
|---|---|
| `search` | Full-text across context summaries, event payloads, task titles |
| `get_context_history` | See all versions of a context entry |
| `get_room_info` | Room metadata: created, owner, member count |
| Redis pub/sub or SSE push | Real push instead of polling |
| Upstash Vector | Semantic search over context |
| Webhook support | Notify an external URL when events are posted |
| Deployment | No host chosen. See the note below. |

### v1.x: polish
| Item | Why |
|---|---|
| CLI: `roomd create-room` | Generates a shareable config snippet |
| MCP server-initiated notifications | Server pushes to the agent unprompted |
| Room templates | Start a room with a pre-filled plan |
| `diff_context` | Show what changed between two versions |
| Room analytics | Events per day, task completion rate |

---

## Deployment

The server deploys to **Railway** as a container (`Dockerfile` + `railway.json`),
and the dashboard (`roomd-web`) deploys to **Vercel**. Both share one Upstash
Redis. Full steps in [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md).

What the server needs is small: one long-lived process, the env vars in
`.env.example`, and outbound HTTPS to Upstash. It is stateless, so any number of
instances can run behind a load balancer. No live instance is running yet; the
config and docs are in place to bring one up.

---

## Where to start next

```
v0.4 tools, highest value first:
list_rooms  ->  needs team:{teamId}:rooms index written in assertRoomAccess
leave_room  ->  cheap, drops the agent from the room's agents SET
delete_task / delete_context  ->  scoped single-item deletes only

Then:
structured logging  ->  makes everything after this debuggable
```

---

## Compliance notes

### GDPR
- **Triggered.** roomd-web stores user accounts, emails, and a waitlist.
- Personal data lives under `app:user:*` and `app:waitlist` in Redis.
- Right to erasure is not implemented. There is no account deletion flow.

### SOC 2
- Not needed until an enterprise customer asks.

### Done
- [x] Request bodies are not logged. Only error messages are.
- [x] Redis TTL on all room keys (30 days, refreshed on use).
- [x] Secrets are stored hashed, never in plaintext.

### Still to do
- [ ] Account deletion in roomd-web (GDPR erasure)
- [ ] Document what data is stored and where, for users
