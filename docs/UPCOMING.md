# roomd roadmap

Current version: **v1.1.0**. Deployed: Railway (`api.roomd.sh`) + Vercel
(`roomd.sh` / `app.roomd.sh`). Shared Upstash Redis.

This file tracks what is left. Everything listed as built has a test covering it
in `tests/`. Run `bun test` before trusting this document.

---

## Shipped

### v0.2–v0.3
Multi-tenancy, core plan/context/events/presence/locks/vars tools, hashed secrets,
room TTL. See git history / CHANGELOG for the full list.

### v0.4: go-live product
| Item | Where |
|---|---|
| Railway + Vercel deploy, `roomd.sh` host split | `Dockerfile`, `docs/DEPLOY.md`, roomd-web middleware |
| Owner portal (invite / waitlist / users / usage) | roomd-web `/owner` |
| Email invites, named keys, multi-client setup | roomd-web + roomd `DynKey.note` |
| Operator revoke any org key + list team keys | `DELETE /admin/keys/:id`, `GET /admin/teams/:teamId/keys` |

### v0.5: agent quality of life
| Item | Where |
|---|---|
| Team room index + `list_rooms` / `leave_room` | `assertRoomAccess`, `tools/rooms.ts` |
| `delete_task` / `delete_context` / `delete_event` | plan/context/events tools |
| `set_task_priority` / `add_dependency` | `tools/plan.ts` |
| `request_review` / `approve` / `reject` / `list_reviews` | `tools/review.ts` |

### v0.6: ops + history
| Item | Where |
|---|---|
| Structured JSON logging | `src/log.ts` |
| Context history + `get_context_history` | `pushContextHistory`, context tools |
| `get_room_info` + room meta | `tools/info.ts` |
| Auto `POST /admin/rooms` | `src/index.ts` |
| GDPR self-delete + DATA.md | roomd-web `/api/account`, `docs/DATA.md` |

### v1.0: scale
| Item | Where |
|---|---|
| Lexical + optional Vector `search` | `tools/search.ts`, `vector.ts` |
| SSE `/rooms/:id/stream` + `wait_for_events` | `index.ts`, `tools/wait.ts` |
| Webhooks + Admin UI | `webhooks.ts`, roomd-web `/admin` |

### v1.1: polish
| Item | Where |
|---|---|
| CLI `create-room` | `cli/create-room.ts`, `bun run create-room` |
| SSE session notify | `notify.ts` + stream register |
| Room templates | `templates.ts`, `tools/templates.ts` |
| `diff_context` | `tools/diff.ts` |
| `get_room_analytics` | `tools/analytics.ts` |

---

## Not built

(None on the original roadmap. Future work goes here.)

---

## Deployment

Production is live: **Railway** (roomd) + **Vercel** (roomd-web), Upstash Redis.
Full matrices: [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md).

---

## Compliance notes

### GDPR
- roomd-web stores user accounts, emails, waitlist, org invites.
- Self-service: `DELETE /api/account` / Delete account in the app header.
- Operator: Owner → Users → Delete.
- See [`DATA.md`](./DATA.md).

### Done
- [x] Request bodies are not logged. Only error messages are.
- [x] Redis TTL on all room keys (30 days, refreshed on use).
- [x] Secrets are stored hashed, never in plaintext.
- [x] Operator disable/delete for dashboard users.
- [x] Self-service account deletion + data inventory doc.
