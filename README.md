# roomd

Where your engineers' agents form a team.

Each engineer keeps their own coding agent. Agents join a **room** and read and
write shared state: a plan, a typed context store, an event log, presence, and
locks (plus small shared variables). An agent that starts cold asks "what is the
plan, what is mine, what changed, who else is here" and gets a structured answer
rather than a transcript to replay. roomd is the coordination layer — not another
coding agent.

**Status:** v0.3.0. Runs locally today. Deploys to Railway (server) and Vercel
(dashboard); see [docs/DEPLOY.md](docs/DEPLOY.md).

---

## roomd vs the Room Protocol

The protocol is the design; roomd is the server. Same split as HTTP versus nginx.

| Name | What it is | Rule of thumb |
|---|---|---|
| **the Room Protocol** | The design: the room abstraction, five core state primitives (plan, context, events, presence, locks) plus minor shared variables, exposed over MCP. A spec, not a program. | If it could have a second implementation, it's the Protocol. |
| **roomd** | The reference implementation: the stateless server you run and point agents at. The `-d` is the daemon convention (`httpd`, `sshd`). | If it's the thing you deploy, it's roomd. |
| **roomd-web** | The dashboard humans log into to watch and manage rooms. Tooling around roomd, not part of the protocol. | |
| **room** | The core primitive: one workspace, named by a `roomId`, that all coordination state lives under. | |
| **roomd.sh** | The brand, domain, and docs site. | |

You run **roomd**. The **Room Protocol** is the design underneath it, the same way nginx sits under the HTTP RFC. The protocol shows up by name in the whitepaper and in the formal docs; everywhere else, talk about roomd.

---

## What is in here

| Directory | What it is |
|---|---|
| [`roomd/`](roomd/) | The server. A stateless MCP server (Bun + Hono + Upstash Redis) exposing 25 coordination tools. This is the product. |
| [`roomd-web/`](roomd-web/) | The dashboard. Next.js 14 + Auth.js. Create rooms, get setup snippets, watch agents work, manage keys and invites. |
| [`protocol/`](protocol/) | A whitepaper writing the design up as "The Room Protocol". |
| [`docs/plans/`](docs/plans/) | Historical build plans. Superseded; read the banners. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed and why. Start here if you are picking this up. |

`roomd-web-spec.md` is the historical spec roomd-web was built from. It is
kept for its reasoning, and several of its decisions have since changed.

---

## Running it

You need [Bun](https://bun.sh), Node 20+, and an [Upstash Redis](https://upstash.com)
database. Both services share the one database, with roomd-web namespaced under `app:`.

### 1. The server

```bash
cd roomd
cp .env.example .env      # fill in UPSTASH_* and API_KEYS
bun install
bun run dev               # http://localhost:3000
bun test                  # 91 tests, no Redis needed
```

`API_KEYS` is a comma-separated list of `teamId:secret` pairs. A team can only
see the rooms it owns.

### 2. The dashboard

```bash
cd roomd-web
cp .env.local.example .env.local   # fill in NEXTAUTH_SECRET, UPSTASH_*, ROOMD_*
npm install
npm run dev                       # http://localhost:3001
npm test                          # 48 tests
```

`ROOMD_MASTER_KEY` must be a **static** key from the server's `API_KEYS`.
Only static keys can provision a new team, which is how each new user gets an
isolated workspace.

### 3. Connect an agent

Follow [`roomd/docs/SETUP.md`](roomd/docs/SETUP.md), or create the room
in the dashboard and copy the snippet it gives you.

Every agent coordinating on a project uses the **same `roomId`** and a
**different `agentId`**.

---

## How it fits together

```
Claude Code  ──MCP over HTTP──>  roomd  ──>  Upstash Redis
Claude Code  ──MCP over HTTP──>     ^                  ^
                                    │                  │
                          admin HTTP API         app: namespace
                                    │                  │
  browser  ──>  roomd-web (Next.js server) ───────────┘
```

roomd-web never calls roomd from the browser. Every call goes through a
Next.js API route, because the API key must never reach client-side code.

The server is stateless: a fresh MCP server and transport are built per request,
and the only durable effect of a tool call is on Redis. That is what makes it
restartable, and what makes it horizontally scalable behind a load balancer.

---

## Reading the code

Start with [`roomd/src/mcp/server.ts`](roomd/src/mcp/server.ts). Every
tool is registered through one helper that enforces room access before the
handler runs, so the tools themselves are pure functions from validated input to
a value.

Then [`roomd/src/store/redis.ts`](roomd/src/store/redis.ts), which is
the only file that talks to Redis, and
[`roomd/docs/redis-schema.md`](roomd/docs/redis-schema.md), which
explains every key and why it exists.

[`roomd/CLAUDE.md`](roomd/CLAUDE.md) is what an agent reads. It has the
tool list, the payload schemas, and a worked two-agent handoff.
