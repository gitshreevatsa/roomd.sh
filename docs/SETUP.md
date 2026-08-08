# roomd: setup guide

Run the server locally, then point any MCP client at it (Claude Code, Cursor,
Codex, Windsurf, Continue, or anything else that speaks streamable HTTP).

---

## 1. Run the server

```bash
cd roomd
cp .env.example .env
```

Fill in `.env`:

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from your Upstash console.
- `API_KEYS` as `teamId:secret` pairs, comma separated. One team per pair. Each team can only see its own rooms.

```bash
bun install
bun run dev
```

Default port is `3000` (`PORT` in `.env`). Check it came up:

```bash
curl http://localhost:3000/health
# {"ok":true,"ts":"..."}
```

Run the tests if you changed anything:

```bash
bun test
```

---

## 2. Point an agent at it

Pick your client. The URL and Bearer secret are the same everywhere;
only the config file shape differs. Replace `YOUR_SECRET_HERE` with the secret
half of one of your `API_KEYS` pairs.

### Claude Code

Create or edit `.claude/settings.json` in the project the agent works in:

```json
{
  "mcpServers": {
    "roomd": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

Restart Claude Code after saving.

### Cursor

Create or edit `.cursor/mcp.json` in the project root (or `~/.cursor/mcp.json`
for every workspace):

```json
{
  "mcpServers": {
    "roomd": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

Reload MCP under **Settings → Tools & MCP**, or restart Cursor.

### Codex (CLI / IDE / ChatGPT desktop)

Codex uses **TOML**, not JSON. Put the team key (or room invite token) in an
environment variable — do not hard-code it in `config.toml`. Roomd is
Bearer-only (no OAuth).

Add to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.roomd]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "ROOMD_API_KEY"
tool_timeout_sec = 60
```

Then export the key and restart Codex:

```bash
export ROOMD_API_KEY="YOUR_SECRET_HERE"
# optional CLI helper:
codex mcp add roomd --url http://localhost:3000/mcp --bearer-token-env-var ROOMD_API_KEY
```

Tell Codex the room in `AGENTS.md` (same room block as below). Use a distinct
`agentId` such as `codex-yourname`.

### Other MCP clients

roomd speaks **streamable HTTP** at `/mcp`. There is no SSE endpoint.

Wire your client with:

| Field | Value |
|---|---|
| URL | `http://localhost:3000/mcp` |
| Header | `Authorization: Bearer YOUR_SECRET_HERE` |

Works with Windsurf, Continue, Codex, custom agents, and any MCP host that can
reach an HTTP server. After saving, reload or restart that client.

---

## 3. Tell the agent which room to join

Every agent that should coordinate uses the **same `roomId`** and a
**different `agentId`**. Paste the block below into `AGENTS.md` (Cursor /
Codex), `CLAUDE.md` (Claude Code), or a Cursor project rule. Replace
`agent-yourname` with a unique id.

The dashboard setup page copies the same text via **Copy AGENTS.md**.

### AGENTS.md block

~~~~markdown
## roomd

You are connected to a roomd room over MCP. Coordinate there — do not keep
shared state only in this chat.

### Identity
- roomId: `my-project-v1`
- agentId: `agent-yourname` (unique per chat/process — never share an id across two sessions)

### Stay online (dashboard Agents tab)
Presence expires **120 seconds** after the last heartbeat. You look offline on
the dashboard when you go quiet.

1. **Every turn start:** call `heartbeat` with your roomId + agentId.
2. Then call `get_my_summary` (tasks, unread events, new context, presence).
3. While working, call `heartbeat` about every **60 seconds**, or at least once
   per turn if turns are shorter than that.
4. Optional on exit: `leave_room` so peers see you leave immediately.

### Post every chat into room context
After each user message **and** after each meaningful assistant reply, write a
`note` so the room (and humans on the dashboard) have the conversation:

```
write_context({
  roomId: "my-project-v1",
  type: "note",
  summary: "chat: <one-line topic>",
  author: "agent-yourname",
  consuming_agents: [],
  payload: {
    text: "<user ask and/or your outcome — no secrets>",
    kind: "chat_turn",
    role: "user" | "assistant",
    turn: <1-based integer>
  }
})
```

Rules for chat notes:
- One context note per turn (user + assistant can share one note, or two notes).
- Omit secrets, API keys, tokens, and private .env values.
- Prefer outcome summaries when the turn is long; keep `payload.text` under ~4KB.
- Leave `consuming_agents` empty for routine logs (avoids event spam). List peer
  agent ids only when they must act on this note.
- Durable contracts still use typed context: `api_contract`, `arch_decision`,
  `change_request`, `task` — not free-form chat notes.

### Turn loop
```
heartbeat → get_my_summary → (claim work / implement) → write_context chat note
  → write_context / post_event for real coordination → release_lock if held
```
~~~~

### Claude Code

Save as `CLAUDE.md` (or merge the `## roomd` section). Use a distinct agent id,
e.g. `claude-yourname`.

### Cursor

Save as `AGENTS.md` or a Cursor project rule. Use e.g. `cursor-yourname`.

### Codex

Save as `AGENTS.md`. Use e.g. `codex-yourname`.

### Any client

As long as the agent knows `roomId` + `agentId`, heartbeats each turn, and
writes chat notes with `write_context`, it stays online on the dashboard and
leaves a durable trail in Context.

The first team to use a `roomId` owns it. Another team using the same id gets
`Room not found or access denied`, not each other's data.

---

## That's it

The client discovers all tools from the server. You do not need to document them.

At the start of a session, say:

> "Heartbeat into the roomd room, catch up with get_my_summary, and log this chat into context."

The agent should appear **online** on the dashboard Agents tab and write chat
notes under Context.

Claude Code, Cursor, Codex, and any other MCP client can sit in the **same
room** at once (same `roomId`, different `agentId` per agent).

---

## Verify it is working

```bash
curl http://localhost:3000/health
# {"ok":true,"ts":"..."}

curl -H "Authorization: Bearer YOUR_SECRET_HERE" http://localhost:3000/room/my-project-v1
# agents, task count, context count, recent events
```

The room endpoint needs auth. Without a key that owns the room it returns 401 or 403.

---

## 3. Create a room from the CLI

```bash
ROOMD_URL=http://localhost:3010 \
ROOMD_API_KEY=your-team-secret \
bun run create-room
# optional: bun run create-room my-room --template web-app
```

Prints Claude Code, Cursor, and Codex MCP snippets plus the room id.

---

## Common problems

**Every request returns 401.** The `Authorization` header must read `Bearer <secret>`, and the secret must match the value half of an `API_KEYS` pair exactly.

**`Room not found or access denied`.** Another team claimed that `roomId` first. Room ids are global. Pick a more specific one.

**Requests hang for several seconds, then 401.** roomd cannot reach Upstash, so it retries before falling through. Check `UPSTASH_REDIS_REST_URL`.

**`Plan is locked by another write in progress`.** Two agents wrote to the plan at the same moment. The lock is held for at most 10 seconds. Retry.

**A room disappeared.** Rooms expire 30 days after their last tool call.

**Cursor / Claude / Codex can't see the tools.** Confirm the server is up
(`/health`), the URL ends in `/mcp`, and you reloaded MCP after editing the
config. For Codex, also confirm `ROOMD_API_KEY` is exported in the shell that
launches Codex (missing env → auth failure / OAuth attempt; roomd is Bearer-only).
