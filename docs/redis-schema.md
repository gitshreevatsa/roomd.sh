# Redis Schema

roomd uses Upstash Redis as its only database. All state (rooms, tasks, events, context, agents, locks, API keys) lives here.

## What Upstash Redis actually is

Regular Redis runs as a server you connect to over TCP. Upstash Redis is identical in commands and data structures, but accessed over HTTP. The `@upstash/redis` SDK is just making HTTP calls under the hood. No persistent connection, works from serverless and edge functions.

Redis has no tables, no schemas, no collections. Just one flat namespace of keys. All isolation between users and rooms comes from key naming conventions enforced at the application layer, not by Redis itself.

Redis value types used here:
- **String**: any text or JSON blob. Most common.
- **List**: ordered sequence, duplicates allowed. Supports push-to-front (LPUSH).
- **Set**: unordered, unique members. Supports add, remove, list-all.
- **Hash**: field/value map under one key. Used for shared variables.

---

## Key naming conventions

All keys follow one of three patterns:

```
{roomId}:{thing}             data that belongs to a specific room
room:{roomId}:{thing}        room-level metadata (ownership, invites)
{global-prefix}:{thing}      team or system-wide data (rate limits, API keys)
```

The `:` separator is just a human convention. Redis treats the entire string as one key name.

---

## Room-scoped keys

Every room gets its own isolated set of keys. Swap `my-saas` for any real room ID.

**Room TTL.** Every long-lived room key expires 30 days after the room's last
tool call. `assertRoomAccess` runs on every call and refreshes them all in one
pipelined `EXPIRE` batch, so a room in active use never dies and an abandoned
one is reclaimed. Individual TTLs below are stated per key.

---

### `my-saas:plan`

**Type:** String (JSON)

**Stores:**
```json
{
  "project": "my-saas",
  "created_at": "2026-06-01T10:00:00.000Z",
  "updated_at": "2026-06-01T10:05:00.000Z",
  "tasks": [
    {
      "id": "abc123",
      "title": "Build auth service",
      "description": "JWT-based login flow",
      "status": "in_progress",
      "owner": "shreyas-claude",
      "created_at": "2026-06-01T10:00:00.000Z",
      "updated_at": "2026-06-01T10:03:00.000Z",
      "depends_on": []
    }
  ]
}
```

**TTL: 30 days**, refreshed on every tool call against the room

**Written by:** `add_task`, `update_task` (both acquire the plan lock first)

**Key detail:** writes go through a distributed lock (`my-saas:lock:plan`) so two agents updating tasks simultaneously don't overwrite each other. Read-modify-write must be atomic.

---

### `my-saas:context:{contextId}`

**Type:** String (JSON)

**Stores:**
```json
{
  "id": "ctx-abc123",
  "type": "api_contract",
  "author": "backend-claude",
  "timestamp": "2026-06-01T10:10:00.000Z",
  "summary": "Auth service REST API: login, refresh, logout",
  "consuming_agents": ["frontend-claude"],
  "payload": {
    "service": "auth-service",
    "version": "1.0",
    "endpoints": [...]
  },
  "version": "1.0"
}
```

**TTL: 30 days**

**Written by:** `write_context`, `update_context`

**Payload is validated** against a schema chosen by `type` before the write lands. `update_context` rewrites this key in place and bumps `version` (1.0 to 1.1).

**One key per entry.** A room with 10 context entries has 10 of these keys. Types can be: `api_contract`, `arch_decision`, `task`, `change_request`, `note`.

---

### `my-saas:context:index`

**Type:** Set

**Stores:** all context IDs that exist in this room
```
{ "ctx-abc123", "ctx-def456", "ctx-ghi789" }
```

**TTL: 30 days**

**Why it exists:** Redis has no fast "list all keys matching a pattern" operation. So we maintain this index manually. When `list_context` is called, it reads this set first, then fetches each `my-saas:context:{id}` individually.

---

### `my-saas:events`

**Type:** List (ordered, newest first)

**Stores:** Event JSON strings. New events are pushed to the front with `LPUSH`.
```
[
  '{"id":"evt-3","type":"task_updated","from":"shreyas-claude","to":"all",...}',  ← newest
  '{"id":"evt-2","type":"contract_ready","from":"backend-claude","to":"frontend-claude",...}',
  '{"id":"evt-1","type":"task_added","from":"system","to":"all",...}'             ← oldest
]
```

**TTL: 30 days**, refreshed on every write and on every tool call against the room

**Written by:** `post_event`, and automatically by `add_task` and `update_task` (they emit events so agents don't need to poll the plan constantly)

---

### `my-saas:agents`

**Type:** Set

**Stores:** agent IDs that have ever joined this room
```
{ "shreyas-claude", "friend-claude" }
```

**TTL: 30 days**. Within the life of a room this set only grows: an agent stays here after going offline.

**Note:** this set grows monotonically. Whether an agent is currently *online* is determined by whether their heartbeat key exists (see below), not by membership in this set.

---

### `my-saas:heartbeat:{agentId}`

**Type:** String

**Stores:** ISO timestamp of last heartbeat
```
"2026-06-01T10:23:45.000Z"
```

**TTL: 120 seconds.** This is the mechanism for presence. If an agent stops calling `heartbeat`, this key disappears automatically after 120s. `get_presence` checks whether this key exists to determine online/offline status.

**Written by:** `heartbeat` tool. Agents should call this every ~60s.

One key per agent: `my-saas:heartbeat:shreyas-claude`, `my-saas:heartbeat:friend-claude`

---

### `my-saas:cursor:{agentId}`

**Type:** String

**Stores:** ISO timestamp marking the agent's last-read position in the event stream
```
"2026-06-01T10:20:00.000Z"
```

**TTL: 30 days**

**How it works:** `get_unread_events` reads this cursor, filters events newer than it, updates the cursor to now, and returns only the new events. This is how each agent gets their own personal "you haven't seen these yet" view without affecting other agents.

---

### `my-saas:event_reads:{eventId}`

**Type:** Set

**Stores:** agent IDs who have explicitly called `mark_event_read` for this event
```
{ "shreyas-claude", "friend-claude" }
```

**TTL: 30 days**

**Used for:** `get_event_reads`, which lets a sender confirm the other agent actually saw the message.

---

### `my-saas:vars`

**Type:** Hash

**Stores:** small shared facts the agents in a room agree on
```
{ "staging_url": "https://staging.example.com", "api_port": "8080" }
```

**TTL: 30 days**

**Written by:** `set_shared_var`, which also posts a `shared_var_set` event.

Anything a consuming agent must reason about structurally belongs in a context entry instead, where it gets a validated schema and a version.

---

### `my-saas:lock:{resource}`

**Type:** String

**Stores:** agent ID currently holding the lock
```
"shreyas-claude"
```

**TTL: 30 seconds** by default, auto-releasing if the agent crashes before calling `release_lock`. Prevents permanent deadlocks. The server's internal plan lock uses 10 seconds.

**How it works:** uses Redis `SET NX PX`, which is atomic and only sets the key if it does not already exist. Only one agent wins. The loser retries with backoff.

In practice `resource` is almost always `"plan"`, making the real key `my-saas:lock:plan`.

---

### `my-saas:locks`

**Type:** Set

**Stores:** names of resources that currently have a lock entry
```
{ "plan" }
```

**TTL: 30 days**

**Why it exists:** index for `list_locks`. Without it there is no way to find all active locks. Also used for lazy cleanup: if a lock's TTL expired but the resource name is still in this set, `list_locks` removes the stale entry.

---

## Room ownership and invite keys

These use a different prefix (`room:`) to distinguish them from room-scoped data.

---

### `room:my-saas:owner`

**Type:** String

**Stores:** teamId of the team that owns this room
```
"team-shreyas"
```

**TTL: 30 days**, refreshed on every tool call. An abandoned room can be reclaimed by another team once it lapses.

**How it is set:** the very first tool call on any roomId triggers `assertRoomAccess`, which runs `SET room:my-saas:owner team-shreyas NX`. The `NX` flag means "only set if this key does not already exist." First team to call any tool wins ownership. Subsequent calls by the same team pass through. Any other team gets `"Room not found or access denied"`, which is deliberately the same error whether the room is missing or owned by someone else, so it cannot be used to probe for room names.

---

### `room:my-saas:invites`

**Type:** Set

**Stores:** tokenIds of invite tokens created for this room
```
{ "tok1234567", "tok8901234" }
```

**TTL:** none. tokenIds stay here even after individual invites expire, and are cleaned up lazily during listing.

**Used for:** listing and revoking invites for a room

---

## Global and team-scoped keys

---

### `ratelimit:{teamId}:{windowMinute}`

**Type:** String (integer counter)

**Stores:** request count for this team in this 1-minute window
```
"14"
```

**TTL: 120 seconds.** Old minute buckets auto-delete.

**How it works:**
```
windowMinute = Math.floor(Date.now() / 60000)  // e.g. 28461

INCR ratelimit:team-shreyas:28461    → 1
EXPIRE ratelimit:team-shreyas:28461 120  (only set on first increment)

INCR ratelimit:team-shreyas:28461    → 2
...
INCR ratelimit:team-shreyas:28461    → 61  → request rejected (429)
```

When the minute ticks over, a new window key starts at 0. The old one expires after 120s. Default limit: 60 req/min (configurable via `RATE_LIMIT_PER_MINUTE` env var).

**Fails open:** if Redis is unreachable, requests are allowed through rather than blocking all traffic.

---

### `dynkey:{sha256(secret)}`

**Type:** String (JSON)

**Stores:**
```json
{
  "keyId": "abc1234567",
  "teamId": "team-shreyas",
  "createdBy": "team-shreyas",
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**TTL:** none

**The key name is the digest of the secret, not the secret.** Auth lookup is a single `GET dynkey:{sha256(whatever-they-sent)}`. If the record exists, the bearer is valid. This keeps the lookup to one round trip while ensuring a Redis dump contains no usable bearer tokens.

**Created by:** `POST /admin/keys` and `POST /admin/keys/provision`

---

### `dynkeyid:{keyId}`

**Type:** String (JSON)

**Stores:** the same metadata, plus the digest and a display hint. **Never the raw secret.**
```json
{
  "keyId": "abc1234567",
  "teamId": "team-shreyas",
  "createdBy": "team-shreyas",
  "createdAt": "2026-06-01T10:00:00.000Z",
  "secretHash": "9f86d081884c7d659a2feaa0c55ad015...",
  "hint": "****a3x1"
}
```

**TTL:** none

**Why a second key?** Management operations (list, revoke) use the `keyId`, not the secret. To revoke: look up `dynkeyid:{keyId}` to find the digest, then delete `dynkey:{digest}`. The raw secret is shown once at creation and is unrecoverable afterwards, by design.

---

### `dynkeys:{teamId}`

**Type:** Set

**Stores:** keyIds belonging to this team
```
{ "abc1234567", "def7890123" }
```

**TTL:** none

**Used for:** `GET /admin/keys`, which lists all keys for a team. Each keyId in this set is resolved via `dynkeyid:{keyId}`. Responses carry only the `hint`.

---

### `invite:{sha256(token)}`

**Type:** String (JSON)

**Stores:**
```json
{
  "tokenId": "tok1234567",
  "roomId": "my-saas",
  "createdBy": "team-shreyas",
  "createdAt": "2026-06-01T10:00:00.000Z",
  "expiresAt": "2026-06-08T10:00:00.000Z"
}
```

**TTL:** optional. If created with `expiresIn` seconds, Redis deletes the key when it expires, and an auth lookup of an expired invite returns null immediately.

**The key name is the digest of the token.** Auth lookup: `GET invite:{sha256(whatever-they-sent)}`. Same pattern as dynkeys.

**Invite tokens are room-scoped.** The bearer can only access the `roomId` stored here, and never claims ownership of it.

---

### `inviteid:{tokenId}`

**Type:** String (JSON)

**Stores:** the same metadata plus the token digest and a display hint. **Never the raw token.**

**TTL:** none. It stays after the invite expires and is cleaned up lazily: during `listRoomInvites`, if `invite:{digest}` no longer exists, the record and its entry in `room:{roomId}:invites` are removed.

**Used for:** the revoke-by-tokenId flow. Look up `inviteid:{tokenId}`, read the digest, delete `invite:{digest}` and `inviteid:{tokenId}`.

---

## roomd-web keys

The web UI uses the same Upstash Redis database with an `app:` prefix, keeping its data separate from roomd's. roomd-web never reads or writes roomd's keys directly; it goes through the MCP tools and the admin HTTP API.

```
app:user:{userId}             String (JSON)   Full user record: email, name, passwordHash
                                              (scrypt), teamId, apiKey, authMethods[], createdAt
app:user:email:{email}        String          → userId  (lookup index for email login)
app:user:google:{googleId}    String          → userId  (lookup index for Google OAuth)
app:user:github:{githubId}    String          → userId  (lookup index for GitHub OAuth)
app:user:apikey:{teamId}      String          → userId  (links a roomd teamId to a web user)
app:rooms:{userId}            Set             roomIds this user has created via the UI
app:room:{roomId}             String (JSON)   { roomId, name, createdBy, createdAt }
app:waitlist                  Set             email addresses from the waitlist form
```

---

## Full key inventory

Room-scoped keys all carry a 30-day TTL, refreshed on every tool call against
the room. Presence and locks expire much faster, by design.

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `{roomId}:plan` | String | 30d | Task list for the room |
| `{roomId}:context:{id}` | String | 30d | One context entry |
| `{roomId}:context:index` | Set | 30d | Index of all context IDs |
| `{roomId}:events` | List | 30d | Event log, newest first |
| `{roomId}:agents` | Set | 30d | All agent IDs seen in this room |
| `{roomId}:vars` | Hash | 30d | Shared variables |
| `{roomId}:heartbeat:{agentId}` | String | **120s** | Presence signal |
| `{roomId}:cursor:{agentId}` | String | 30d | Per-agent event read position |
| `{roomId}:event_reads:{eventId}` | Set | 30d | Who has read an event |
| `{roomId}:lock:{resource}` | String | **30s** | Distributed write lock |
| `{roomId}:locks` | Set | 30d | Index of active lock names |
| `room:{roomId}:owner` | String | 30d | teamId that owns the room |
| `room:{roomId}:invites` | Set | none | Index of invite tokenIds |
| `ratelimit:{teamId}:{window}` | String | **120s** | Per-minute request counter |
| `dynkey:{sha256(secret)}` | String | none | Dynamic API key, looked up by digest |
| `dynkeyid:{keyId}` | String | none | Key metadata: digest and hint, no secret |
| `dynkeys:{teamId}` | Set | none | Index of a team's key IDs |
| `invite:{sha256(token)}` | String | optional | Room invite, looked up by digest |
| `inviteid:{tokenId}` | String | none | Invite metadata: digest and hint, no token |
| `app:user:{userId}` | String | none | Web app user record |
| `app:user:email:{email}` | String | none | Email to userId index, claimed with SET NX |
| `app:user:google:{id}` | String | none | Google ID to userId index |
| `app:user:github:{id}` | String | none | GitHub ID to userId index |
| `app:user:apikey:{teamId}` | String | none | teamId to userId link |
| `app:rooms:{userId}` | Set | none | Rooms created by this user |
| `app:room:{roomId}` | String | none | Room display metadata |
| `app:waitlist` | Set | none | Waitlist email addresses |

## What is never stored

- **Raw API key secrets.** Only `sha256(secret)` and a four-character hint.
- **Raw invite tokens.** Only `sha256(token)` and a four-character hint.
- **Plaintext passwords.** roomd-web stores a salted scrypt hash.
- **Request bodies.** Nothing logs them; context payloads can be sensitive.
