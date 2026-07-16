# roomd roadmap

Current version: **v1.0.0**. Deployed: Railway (`api.roomd.sh`) + Vercel
(`roomd.sh` / `app.roomd.sh`). Shared Upstash Redis.

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

### v0.4: go-live product
| Item | Where |
|---|---|
| Railway + Vercel deploy, `roomd.sh` host split | `Dockerfile`, `docs/DEPLOY.md`, roomd-web middleware |
| Owner portal (invite / waitlist / users / usage) | roomd-web `/owner` |
| Email invites, named keys, multi-client setup | roomd-web + roomd `DynKey.note` |
| Operator revoke any org key + list team keys | `DELETE /admin/keys/:id`, `GET /admin/teams/:teamId/keys` |
| Marketing landing, protocol page, theme | roomd-web |

### v0.5: agent quality of life
| Item | Where |
|---|---|
| Team room index + `list_rooms` / `leave_room` | `assertRoomAccess`, `tools/rooms.ts` |
| `delete_task` / `delete_context` / `delete_event` | plan/context/events tools |
| `set_task_priority` / `add_dependency` | `tools/plan.ts` |
| `request_review` / `approve` / `reject` / `list_reviews` | `tools/review.ts` |

---

## Shipped (continued)

### v0.6: ops + history
| Item | Where |
|---|---|
| Structured JSON logging | `src/log.ts` |
| Context history + `get_context_history` | `pushContextHistory`, context tools |
| `get_room_info` + room meta | `tools/info.ts` |
| Auto `POST /admin/rooms` | `src/index.ts` |
| GDPR self-delete + DATA.md | roomd-web `/api/account`, `docs/DATA.md` |

---

## Not built (continued)

### v1.0: scale
| Item | Where |
|---|---|
| Lexical + optional Vector `search` | `tools/search.ts`, `vector.ts` |
| SSE `/rooms/:id/stream` + `wait_for_events` | `index.ts`, `tools/wait.ts` |
| Webhooks + Admin UI | `webhooks.ts`, roomd-web `/admin` |

---

## Not built

### v1.1: polish
| Item | Why |
|---|---|
| CLI: `roomd create-room` | Generates a shareable config snippet |
| MCP server-initiated notifications | Server pushes to the agent unprompted |
| Room templates | Start a room with a pre-filled plan |
| `diff_context` | Show what changed between two versions |
| Room analytics | Events per day, task completion rate |

---

## Deployment

Production is live: **Railway** (roomd) + **Vercel** (roomd-web), Upstash Redis.
Staging may use `roomd.dev`. Full matrices: [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md).

---

## Where to start next

```
v0.6:
structured logging  ->  JSON stdout
get_context_history / get_room_info / auto roomId
GDPR self-delete + DATA.md
```

---

## Compliance notes

### GDPR
- **Triggered.** roomd-web stores user accounts, emails, and a waitlist.
- Personal data lives under `app:user:*` and `app:waitlist` / `app:org-invites`.
- Operator can disable/delete users; **self-service erasure** still TODO (v0.6).

### SOC 2
- Not needed until an enterprise customer asks.

### Done
- [x] Request bodies are not logged. Only error messages are.
- [x] Redis TTL on all room keys (30 days, refreshed on use).
- [x] Secrets are stored hashed, never in plaintext.
- [x] Operator disable/delete for dashboard users.

### Still to do
- [ ] Self-service account deletion in roomd-web (GDPR erasure)
- [ ] Document what data is stored and where, for users
