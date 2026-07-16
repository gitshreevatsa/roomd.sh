import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp/server.js";
import { resolveKey, getKeyCount } from "./auth.js";
import type { KeyContext } from "./types.js";
import { log } from "./log.js";
import { nanoid } from "nanoid";
import { addWebhook, listWebhooks, removeWebhook } from "./webhooks.js";
import {
  getPlan,
  getContextIndex,
  getAgents,
  getEvents,
  getEventCount,
  getRoomOwner,
  checkRateLimit,
  assertRoomAccess,
  ROOM_ACCESS_DENIED,
  storeDynamicKey,
  listDynamicKeys,
  revokeDynamicKey,
  storeInviteToken,
  listRoomInvites,
  revokeInviteToken,
  listTeamRooms,
} from "./store/redis.js";

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

type Variables = { keyCtx: KeyContext };
const app = new Hono<{ Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth config: startup validation
// ---------------------------------------------------------------------------

if (getKeyCount() === 0) {
  process.stderr.write(
    "[warn] No API keys configured. Set API_KEYS or ROOMD_SECRET or all requests will be rejected\n",
  );
}

const RATE_LIMIT = parseInt(process.env["RATE_LIMIT_PER_MINUTE"] ?? "60", 10);

// ---------------------------------------------------------------------------
// Auth + rate-limit middleware
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireAuth = async (c: any, next: () => Promise<void>) => {
  const auth: string = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyCtx = await resolveKey(auth.slice(7));
  if (!keyCtx) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { allowed, remaining } = await checkRateLimit(keyCtx.teamId, RATE_LIMIT);
  if (!allowed) {
    return c.json(
      { error: "Rate limit exceeded" },
      429,
      { "X-RateLimit-Remaining": "0", "Retry-After": "60" },
    );
  }

  c.set("keyCtx", keyCtx);
  c.header("X-RateLimit-Remaining", String(remaining));
  await next();
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Public health check. No auth required. */
app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * MCP endpoint, stateless mode: a fresh transport and server per request.
 * KeyContext is baked into every tool handler for room ownership enforcement.
 */
app.all("/mcp", requireAuth, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  const server = createMcpServer(keyCtx);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

/**
 * Room summary, for human inspection.
 *
 * Requires auth and room access. Rooms hold API contracts and event payloads,
 * so an unauthenticated version of this endpoint would let anyone who guessed
 * a roomId read a team's coordination state.
 */
app.get("/room/:roomId", requireAuth, async (c) => {
  const roomId = c.req.param("roomId");
  const keyCtx = c.get("keyCtx") as KeyContext;

  try {
    await assertRoomAccess(roomId, keyCtx);

    const [plan, contextIds, agents, recentEvents] = await Promise.all([
      getPlan(roomId),
      getContextIndex(roomId),
      getAgents(roomId),
      getEvents(roomId, 5),
    ]);

    return c.json({
      roomId,
      agents,
      taskCount: plan?.tasks.length ?? 0,
      contextCount: contextIds.length,
      recentEvents,
    });
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    log.error({ msg: "room", detail: `error fetching room ${roomId}: ${String(err)}` });
    return c.json({ error: "Failed to fetch room data" }, 500);
  }
});

/**
 * SSE long-poll stream of room events (Upstash REST cannot SUBSCRIBE).
 * Query: ?since=ISO8601 — only events after this timestamp.
 */
app.get("/rooms/:roomId/stream", requireAuth, async (c) => {
  const roomId = c.req.param("roomId");
  const keyCtx = c.get("keyCtx") as KeyContext;
  try {
    await assertRoomAccess(roomId, keyCtx);
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    return c.json({ error: "Failed to open stream" }, 500);
  }

  let since = c.req.query("since") ?? new Date(0).toISOString();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      send(`: connected ${roomId}\n\n`);
      let alive = true;
      c.req.raw.signal.addEventListener("abort", () => {
        alive = false;
      });
      while (alive) {
        try {
          const events = await getEvents(roomId, 50);
          const fresh = events
            .filter((e) => e.timestamp > since)
            .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
          for (const event of fresh) {
            send(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
            since = event.timestamp;
          }
          send(`: heartbeat ${new Date().toISOString()}\n\n`);
        } catch (err) {
          log.warn({ msg: "stream.poll", err: String(err) });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ---------------------------------------------------------------------------
// Admin routes: require auth. Invite tokens cannot use these.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireTeamKey = async (c: any, next: () => Promise<void>) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  if (keyCtx.isInvite) {
    return c.json({ error: "Invite tokens cannot access admin endpoints" }, 403);
  }
  await next();
};

/**
 * GET /admin/me
 * Returns the teamId of the authenticated key.
 * Used by roomd-web login to resolve teamId for any key type (static or dynamic).
 */
app.get("/admin/me", requireAuth, requireTeamKey, (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  return c.json({ teamId: keyCtx.teamId });
});

/**
 * POST /admin/rooms
 * Claim a room for the caller's team. Body may omit roomId to auto-generate one.
 */
app.post("/admin/rooms", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  let body: { roomId?: string } = {};
  try {
    body = (await c.req.json()) as { roomId?: string };
  } catch {
    body = {};
  }
  const roomId =
    typeof body.roomId === "string" && body.roomId.trim()
      ? body.roomId.trim()
      : nanoid(12);
  try {
    await assertRoomAccess(roomId, keyCtx);
    return c.json({ roomId, teamId: keyCtx.teamId }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    log.error({ msg: "admin/rooms", detail: String(err) });
    return c.json({ error: "Failed to create room" }, 500);
  }
});

/** List rooms owned by the authenticated team. */
app.get("/admin/rooms", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const rooms = await listTeamRooms(keyCtx.teamId);
  return c.json({ rooms });
});

/**
 * GET /admin/rooms/:roomId/stats
 * Cross-tenant usage stats for one room, for the operator's analytics view.
 * Only static operator keys may call this; it deliberately skips the room
 * ownership check so the operator can see usage across every team.
 */
app.get("/admin/rooms/:roomId/stats", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  if (!keyCtx.isStatic) {
    return c.json({ error: "Only static operator keys may read cross-room stats" }, 403);
  }
  const roomId = c.req.param("roomId");
  try {
    const [plan, contextIds, agents, recent, eventCount, owner] = await Promise.all([
      getPlan(roomId),
      getContextIndex(roomId),
      getAgents(roomId),
      getEvents(roomId, 1),
      getEventCount(roomId),
      getRoomOwner(roomId),
    ]);
    const tasks = plan?.tasks ?? [];
    return c.json({
      roomId,
      owner,
      taskCount: tasks.length,
      doneTasks: tasks.filter((t) => t.status === "done").length,
      contextCount: contextIds.length,
      agentCount: agents.length,
      eventCount,
      lastActivity: recent[0]?.timestamp ?? null,
    });
  } catch (err) {
    log.error({ msg: "admin/stats", detail: `error: ${String(err)}` });
    return c.json({ error: "Failed to read room stats" }, 500);
  }
});

/**
 * POST /admin/keys/provision
 * Mint a key for a new, caller-specified teamId.
 * Only static env keys may call this. Dynamic keys cannot bootstrap new teams.
 * Used by roomd-web to give each new OAuth user an isolated team.
 * Body: { teamId: string }
 */
app.post("/admin/keys/provision", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;

  if (!keyCtx.isStatic) {
    return c.json({ error: "Only static env keys may provision new teams" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as { teamId?: string; note?: string };
  const newTeamId = body.teamId?.trim();
  if (!newTeamId || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(newTeamId)) {
    return c.json({ error: "teamId must be 3 to 32 lowercase alphanumeric/hyphen chars" }, 400);
  }

  try {
    const result = await storeDynamicKey(newTeamId, keyCtx.teamId, body.note);
    return c.json({
      keyId: result.keyId,
      secret: result.secret,
      teamId: result.teamId,
      createdAt: result.createdAt,
      message: "Save this secret. It will not be shown again.",
    }, 201);
  } catch (err) {
    log.error({ msg: "admin/provision", detail: `error: ${String(err)}` });
    return c.json({ error: "Failed to provision team" }, 500);
  }
});

/**
 * POST /admin/keys
 * Create a new dynamic API key for your team.
 * Returns the secret once. Save it immediately.
 */
app.post("/admin/keys", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const body = await c.req.json().catch(() => ({})) as { note?: string };
  try {
    const result = await storeDynamicKey(keyCtx.teamId, keyCtx.teamId, body.note);
    return c.json({
      keyId: result.keyId,
      secret: result.secret,
      teamId: result.teamId,
      createdAt: result.createdAt,
      message: "Save this secret. It will not be shown again.",
    }, 201);
  } catch (err) {
    log.error({ msg: "admin/keys", detail: `create error: ${String(err)}` });
    return c.json({ error: "Failed to create key" }, 500);
  }
});

/**
 * GET /admin/keys
 * List all dynamic keys for your team. Secrets are masked.
 */
app.get("/admin/keys", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  try {
    const keys = await listDynamicKeys(keyCtx.teamId);
    return c.json({ keys });
  } catch (err) {
    log.error({ msg: "admin/keys", detail: `list error: ${String(err)}` });
    return c.json({ error: "Failed to list keys" }, 500);
  }
});

/**
 * GET /admin/teams/:teamId/keys
 * List dynamic keys for any team. Static operator keys only.
 */
app.get("/admin/teams/:teamId/keys", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  if (!keyCtx.isStatic) {
    return c.json({ error: "Only static operator keys may list another team's keys" }, 403);
  }
  const teamId = c.req.param("teamId");
  try {
    const keys = await listDynamicKeys(teamId);
    return c.json({ keys });
  } catch (err) {
    log.error({ msg: "admin/teams/keys", detail: `list error: ${String(err)}` });
    return c.json({ error: "Failed to list keys" }, 500);
  }
});

/**
 * DELETE /admin/keys/:keyId
 * Revoke a dynamic key. Teams may revoke their own; static operator keys may
 * revoke any org key (dashboard owner pulling access).
 */
app.delete("/admin/keys/:keyId", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const keyId = c.req.param("keyId");
  try {
    // Static operator keys may revoke any org key; teams may only revoke their own.
    const ok = await revokeDynamicKey(keyId, keyCtx.teamId, keyCtx.isStatic);
    if (!ok) return c.json({ error: "Key not found or not owned by your team" }, 404);
    return c.json({ ok: true, keyId });
  } catch (err) {
    log.error({ msg: "admin/keys", detail: `revoke error: ${String(err)}` });
    return c.json({ error: "Failed to revoke key" }, 500);
  }
});

/**
 * POST /admin/rooms/:roomId/invite
 * Create a room-scoped invite token.
 * The bearer of this token can only access this specific room.
 * Body: { expiresIn?: number }  seconds until expiry (omit for no expiry)
 */
app.post("/admin/rooms/:roomId/invite", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const roomId = c.req.param("roomId");
  try {
    // Must own the room (or claim it) before issuing invites
    await assertRoomAccess(roomId, keyCtx);

    const body = await c.req.json().catch(() => ({})) as { expiresIn?: number };
    const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : undefined;

    const result = await storeInviteToken(roomId, keyCtx.teamId, expiresIn);
    return c.json({
      tokenId: result.tokenId,
      token: result.token,
      roomId: result.roomId,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
      note: "Save this token. It will not be shown again.",
    }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    log.error({ msg: "admin/invite", detail: `create error: ${String(err)}` });
    return c.json({ error: "Failed to create invite" }, 500);
  }
});

/**
 * GET /admin/rooms/:roomId/invites
 * List active invite tokens for a room you own. Tokens are masked.
 */
app.get("/admin/rooms/:roomId/invites", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const roomId = c.req.param("roomId");
  try {
    await assertRoomAccess(roomId, keyCtx);
    const invites = await listRoomInvites(roomId);
    return c.json({ roomId, invites });
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    log.error({ msg: "admin/invite", detail: `list error: ${String(err)}` });
    return c.json({ error: "Failed to list invites" }, 500);
  }
});

/**
 * DELETE /admin/rooms/:roomId/invites/:tokenId
 * Revoke an invite by its tokenId (not the secret).
 */
app.delete("/admin/rooms/:roomId/invites/:tokenId", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const roomId = c.req.param("roomId");
  const tokenId = c.req.param("tokenId");
  try {
    await assertRoomAccess(roomId, keyCtx);
    const ok = await revokeInviteToken(tokenId, roomId);
    if (!ok) return c.json({ error: "Invite not found" }, 404);
    return c.json({ ok: true, tokenId });
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    log.error({ msg: "admin/invite", detail: `revoke error: ${String(err)}` });
    return c.json({ error: "Failed to revoke invite" }, 500);
  }
});

/**
 * Webhooks for the authenticated team.
 * POST body: { url, secret?, roomId? }
 */
app.get("/admin/webhooks", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const hooks = await listWebhooks(keyCtx.teamId);
  return c.json({
    webhooks: hooks.map((h) => ({
      id: h.id,
      url: h.url,
      roomId: h.roomId,
      createdAt: h.createdAt,
      secretHint: `****${h.secret.slice(-4)}`,
    })),
  });
});

app.post("/admin/webhooks", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    secret?: string;
    roomId?: string;
  };
  if (!body.url || !/^https:\/\//i.test(body.url)) {
    return c.json({ error: "url must be an https URL" }, 400);
  }
  const hook = await addWebhook(keyCtx.teamId, {
    url: body.url,
    secret: body.secret && body.secret.length >= 8 ? body.secret : nanoid(24),
    roomId: body.roomId,
  });
  return c.json(
    {
      id: hook.id,
      url: hook.url,
      roomId: hook.roomId,
      secret: hook.secret,
      createdAt: hook.createdAt,
      note: "Save the secret. It will not be shown again.",
    },
    201,
  );
});

app.delete("/admin/webhooks/:webhookId", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const ok = await removeWebhook(keyCtx.teamId, c.req.param("webhookId"));
  if (!ok) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Bun server export
// ---------------------------------------------------------------------------

const port = parseInt(process.env["PORT"] ?? "3000", 10);

export default {
  port,
  fetch: app.fetch,
};
