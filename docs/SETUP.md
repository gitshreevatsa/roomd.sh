# roomd: setup guide

Run the server locally, then point any MCP client at it — Claude Code, Cursor,
Windsurf, Continue, or anything else that speaks streamable HTTP.

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

### Other MCP clients

roomd speaks **streamable HTTP** at `/mcp`. There is no SSE endpoint.

Wire your client with:

| Field | Value |
|---|---|
| URL | `http://localhost:3000/mcp` |
| Header | `Authorization: Bearer YOUR_SECRET_HERE` |

Works with Windsurf, Continue, custom agents, and any MCP host that can reach an
HTTP server. After saving, reload or restart that client.

---

## 3. Tell the agent which room to join

Every agent that should coordinate uses the **same `roomId`** and a
**different `agentId`**.

### Claude Code

Add to `CLAUDE.md` in the agent's project:

```markdown
## roomd
- roomId: `my-project-v1`
- your agent id: `agent-yourname`
- call get_my_summary at the start of every session
```

### Cursor

Add the same block to a Cursor project rule, or to `AGENTS.md` / a note the
agent reads at session start. Use a distinct agent id, e.g. `cursor-yourname`.

### Any client

As long as the agent knows `roomId` + `agentId` and calls `get_my_summary` on
start, it will catch up: its tasks, unread events, and who else is online.

The first team to use a `roomId` owns it. Another team using the same id gets
`Room not found or access denied`, not each other's data.

---

## That's it

The client discovers all 25 tools from the server. You do not need to document them.

At the start of a session, say:

> "Check the roomd room and see what's going on."

The agent calls `get_my_summary` and catches you up.

Claude Code and Cursor (and any other MCP client) can sit in the **same room**
at once — same `roomId`, different `agentId` per agent.

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

## Common problems

**Every request returns 401.** The `Authorization` header must read `Bearer <secret>`, and the secret must match the value half of an `API_KEYS` pair exactly.

**`Room not found or access denied`.** Another team claimed that `roomId` first. Room ids are global. Pick a more specific one.

**Requests hang for several seconds, then 401.** roomd cannot reach Upstash, so it retries before falling through. Check `UPSTASH_REDIS_REST_URL`.

**`Plan is locked by another write in progress`.** Two agents wrote to the plan at the same moment. The lock is held for at most 10 seconds. Retry.

**A room disappeared.** Rooms expire 30 days after their last tool call.

**Cursor / Claude can't see the tools.** Confirm the server is up (`/health`), the URL ends in `/mcp`, and you reloaded MCP after editing the config.
