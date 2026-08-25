import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { customAlphabet } from "nanoid";
import { initSentry } from "./sentry.js";
import { createMcpServer } from "./mcp/server.js";
import { resolveKey, getKeyCount } from "./auth.js";
import type { KeyContext } from "./types.js";
import { log } from "./log.js";
import { nanoid } from "nanoid";
import {
  addWebhook,
  listWebhooks,
  removeWebhook,
  webhookSecretHint,
} from "./webhooks.js";
import { registerSession } from "./notify.js";
import { assertSafeWebhookUrl } from "./ssrf.js";
import {
  KEY_LIMIT_EXCEEDED,
  INVITE_LIMIT_EXCEEDED,
  MAX_RPC_BATCH,
  RATE_LIMIT_PER_MINUTE,
  ROOM_ID_ALPHABET,
  ROOM_LIMIT_EXCEEDED,
  WEBHOOK_LIMIT_EXCEEDED,
} from "./limits.js";
import {
  getPlan,
  getContextIndex,
  getAgents,
  getEvents,
  getEventCount,
  getRoomOwner,
  checkRateLimit,
  assertRoomAccess,
  assertValidRoomId,
  rateLimitBucket,
  ROOM_ACCESS_DENIED,
  storeDynamicKey,
  listDynamicKeys,
  revokeDynamicKey,
  storeInviteToken,
  listRoomInvites,
  revokeInviteToken,
  revokeAllRoomInvites,
  revokeAllTeamInvites,
  listTeamRooms,
  purgeTeamRooms,
} from "./store/redis.js";

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

initSentry();

type Variables = { keyCtx: KeyContext; requestId: string };
const app = new Hono<{ Variables: Variables }>();

const genRoomId = customAlphabet(ROOM_ID_ALPHABET, 12);

// ---------------------------------------------------------------------------
// Request ID + access log (skip noisy /health probes)
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  const incoming = c.req.header("x-request-id")?.trim();
  const requestId =
    incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : nanoid(16);
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  const started = Date.now();
  await next();

  const path = c.req.path;
  if (path === "/health") return;

  const keyCtx = c.get("keyCtx") as KeyContext | undefined;
  log.info({
    msg: "http",
    requestId,
    method: c.req.method,
    path,
    status: c.res.status,
    ms: Date.now() - started,
    ...(keyCtx ? { teamId: keyCtx.teamId, operator: keyCtx.isOperator === true } : {}),
  });
});

// ---------------------------------------------------------------------------
// Auth config: startup validation
// ---------------------------------------------------------------------------

if (getKeyCount() === 0) {
  process.stderr.write(
    "[warn] No API keys configured. Set API_KEYS or ROOMD_SECRET or all requests will be rejected\n",
  );
}

const SSE_MAX_MS = parseInt(process.env["SSE_MAX_DURATION_MS"] ?? String(5 * 60_000), 10);
const SSE_MAX_PER_TEAM = parseInt(process.env["SSE_MAX_PER_TEAM"] ?? "10", 10);
const activeStreams = new Map<string, number>();

function acquireStreamSlot(teamId: string): boolean {
  const n = activeStreams.get(teamId) ?? 0;
  if (n >= SSE_MAX_PER_TEAM) return false;
  activeStreams.set(teamId, n + 1);
  return true;
}

function releaseStreamSlot(teamId: string): void {
  const n = activeStreams.get(teamId) ?? 0;
  if (n <= 1) activeStreams.delete(teamId);
  else activeStreams.set(teamId, n - 1);
}

// ---------------------------------------------------------------------------
// Auth + rate-limit middleware
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireAuth = async (c: any, next: () => Promise<void>) => {
  const requestId = c.get("requestId") as string | undefined;
  const auth: string = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    log.warn({
      msg: "auth.fail",
      reason: "missing_bearer",
      path: c.req.path,
      requestId,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyCtx = await resolveKey(auth.slice(7));
  if (!keyCtx) {
    log.warn({
      msg: "auth.fail",
      reason: "unknown_key",
      path: c.req.path,
      requestId,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  // MCP tools charge rate limit per tool call; skip HTTP charge for /mcp.
  const isMcp = c.req.path === "/mcp";
  if (!isMcp) {
    const { allowed, remaining } = await checkRateLimit(
      rateLimitBucket(keyCtx),
      RATE_LIMIT_PER_MINUTE,
    );
    if (!allowed) {
      log.warn({
        msg: "auth.rate_limit",
        teamId: keyCtx.teamId,
        path: c.req.path,
        requestId,
      });
      return c.json(
        { error: "Rate limit exceeded" },
        429,
        { "X-RateLimit-Remaining": "0", "Retry-After": "60" },
      );
    }
    c.header("X-RateLimit-Remaining", String(remaining));
  }

  c.set("keyCtx", keyCtx);
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
 * JSON-RPC batches larger than MAX_RPC_BATCH are rejected (default 1).
 */
app.all("/mcp", requireAuth, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;

  if (c.req.method === "POST") {
    try {
      const cloned = c.req.raw.clone();
      const bodyText = await cloned.text();
      if (bodyText.trim()) {
        const parsed: unknown = JSON.parse(bodyText);
        if (Array.isArray(parsed) && parsed.length > MAX_RPC_BATCH) {
          return c.json(
            {
              error: `JSON-RPC batch size ${parsed.length} exceeds MAX_RPC_BATCH (${MAX_RPC_BATCH})`,
            },
            400,
          );
        }
      }
    } catch {
      // Let the MCP transport surface malformed JSON.
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  const server = createMcpServer(keyCtx, c.get("requestId"));
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
    if (err instanceof Error && err.message.startsWith("Invalid roomId")) {
      return c.json({ error: err.message }, 400);
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
    if (err instanceof Error && err.message.startsWith("Invalid roomId")) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Failed to open stream" }, 500);
  }

  if (!acquireStreamSlot(keyCtx.teamId)) {
    return c.json({ error: "Too many concurrent streams for this team" }, 429);
  }

  let since = c.req.query("since") ?? new Date(0).toISOString();
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let slotReleased = false;
  const releaseOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseStreamSlot(keyCtx.teamId);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* closed */
        }
      };
      send(`: connected ${roomId}\n\n`);
      let alive = true;
      const unregister = registerSession(roomId, async (payload) => {
        const data = payload as { params?: { data?: { event?: unknown } } };
        const event = data.params?.data?.event;
        if (event && typeof event === "object" && event !== null && "timestamp" in event) {
          const ts = String((event as { timestamp: string }).timestamp);
          if (ts > since) {
            send(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
            since = ts;
          }
        }
      });
      const cleanup = () => {
        alive = false;
        unregister();
        releaseOnce();
      };
      c.req.raw.signal.addEventListener("abort", cleanup);
      try {
        while (alive) {
          if (Date.now() - startedAt > SSE_MAX_MS) {
            send(`: timeout\n\n`);
            break;
          }
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
      } finally {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      releaseOnce();
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
      : genRoomId();
  try {
    assertValidRoomId(roomId);
    await assertRoomAccess(roomId, keyCtx);
    return c.json({ roomId, teamId: keyCtx.teamId }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    if (err instanceof Error && err.message === ROOM_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    if (err instanceof Error && err.message.startsWith("Invalid roomId")) {
      return c.json({ error: err.message }, 400);
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
 * Only operator keys may call this; it deliberately skips the room
 * ownership check so the operator can see usage across every team.
 */
app.get("/admin/rooms/:roomId/stats", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  if (!keyCtx.isOperator) {
    return c.json({ error: "Only operator keys may read cross-room stats" }, 403);
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
 * Only operator keys may call this. Dynamic / team keys cannot bootstrap new teams.
 * Used by roomd-web to give each new OAuth user an isolated team.
 * Body: { teamId: string }
 */
app.post("/admin/keys/provision", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;

  if (!keyCtx.isOperator) {
    return c.json({ error: "Only operator keys may provision new teams" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as {
    teamId?: string;
    note?: string;
    boundAgentId?: string;
  };
  const newTeamId = body.teamId?.trim();
  if (!newTeamId || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(newTeamId)) {
    return c.json({ error: "teamId must be 3 to 32 lowercase alphanumeric/hyphen chars" }, 400);
  }

  try {
    const result = await storeDynamicKey(newTeamId, keyCtx.teamId, {
      note: body.note,
      boundAgentId: body.boundAgentId,
    });
    log.info({
      msg: "admin.provision",
      requestId: c.get("requestId"),
      teamId: newTeamId,
      keyId: result.keyId,
      by: keyCtx.teamId,
    });
    return c.json({
      keyId: result.keyId,
      secret: result.secret,
      teamId: result.teamId,
      createdAt: result.createdAt,
      boundAgentId: result.boundAgentId,
      message: "Save this secret. It will not be shown again.",
    }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === KEY_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    log.error({ msg: "admin/provision", detail: `error: ${String(err)}` });
    return c.json({ error: "Failed to provision team" }, 500);
  }
});

/**
 * POST /admin/keys
 * Create a new dynamic API key for your team.
 * Returns the secret once. Save it immediately.
 * Body: { note?, boundAgentId? }
 */
app.post("/admin/keys", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const body = await c.req.json().catch(() => ({})) as {
    note?: string;
    boundAgentId?: string;
  };
  try {
    const result = await storeDynamicKey(keyCtx.teamId, keyCtx.teamId, {
      note: body.note,
      boundAgentId: body.boundAgentId,
    });
    log.info({
      msg: "admin.keys.create",
      requestId: c.get("requestId"),
      teamId: keyCtx.teamId,
      keyId: result.keyId,
    });
    return c.json({
      keyId: result.keyId,
      secret: result.secret,
      teamId: result.teamId,
      createdAt: result.createdAt,
      boundAgentId: result.boundAgentId,
      message: "Save this secret. It will not be shown again.",
    }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === KEY_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    if (err instanceof Error && err.message.startsWith("boundAgentId")) {
      return c.json({ error: err.message }, 400);
    }
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
  if (!keyCtx.isOperator) {
    return c.json({ error: "Only operator keys may list another team's keys" }, 403);
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
    const ok = await revokeDynamicKey(keyId, keyCtx.teamId, keyCtx.isOperator);
    if (!ok) return c.json({ error: "Key not found or not owned by your team" }, 404);
    log.info({
      msg: "admin.keys.revoke",
      requestId: c.get("requestId"),
      teamId: keyCtx.teamId,
      keyId,
      operator: keyCtx.isOperator === true,
    });
    return c.json({ ok: true, keyId });
  } catch (err) {
    log.error({ msg: "admin/keys", detail: `revoke error: ${String(err)}` });
    return c.json({ error: "Failed to revoke key" }, 500);
  }
});

/**
 * DELETE /admin/teams/:teamId/invites
 * Revoke all room invites for every room owned by the team.
 * Operator or the owning team may call this (offboarding).
 */
app.delete("/admin/teams/:teamId/invites", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const teamId = c.req.param("teamId");
  if (!keyCtx.isOperator && keyCtx.teamId !== teamId) {
    return c.json({ error: "Only the owning team or an operator may revoke team invites" }, 403);
  }
  try {
    const result = await revokeAllTeamInvites(teamId);
    return c.json({ ok: true, teamId, ...result });
  } catch (err) {
    log.error({ msg: "admin/teams/invites", detail: String(err) });
    return c.json({ error: "Failed to revoke team invites" }, 500);
  }
});

/**
 * GET /admin/teams/:teamId/rooms
 * List room ids owned by a team. Operator or owning team.
 */
app.get("/admin/teams/:teamId/rooms", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const teamId = c.req.param("teamId");
  if (!keyCtx.isOperator && keyCtx.teamId !== teamId) {
    return c.json({ error: "Only the owning team or an operator may list team rooms" }, 403);
  }
  try {
    const rooms = await listTeamRooms(teamId);
    return c.json({ rooms });
  } catch (err) {
    log.error({ msg: "admin/teams/rooms", detail: String(err) });
    return c.json({ error: "Failed to list team rooms" }, 500);
  }
});

/**
 * DELETE /admin/teams/:teamId/rooms
 * Purge all rooms owned by a team (offboarding / tenant delete).
 * Operator or owning team.
 */
app.delete("/admin/teams/:teamId/rooms", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const teamId = c.req.param("teamId");
  if (!keyCtx.isOperator && keyCtx.teamId !== teamId) {
    return c.json({ error: "Only the owning team or an operator may purge team rooms" }, 403);
  }
  try {
    const purged = await purgeTeamRooms(teamId);
    return c.json({ ok: true, teamId, purged });
  } catch (err) {
    log.error({ msg: "admin/teams/rooms/purge", detail: String(err) });
    return c.json({ error: "Failed to purge team rooms" }, 500);
  }
});

/**
 * DELETE /admin/rooms/:roomId/invites
 * Revoke all invites for one room (operator or owning team).
 */
app.delete("/admin/rooms/:roomId/invites", requireAuth, requireTeamKey, async (c) => {
  const keyCtx = c.get("keyCtx") as KeyContext;
  const roomId = c.req.param("roomId");
  try {
    if (keyCtx.isOperator) {
      // Operator may revoke without claiming ownership.
      const revoked = await revokeAllRoomInvites(roomId);
      return c.json({ ok: true, roomId, revoked });
    }
    await assertRoomAccess(roomId, keyCtx);
    const revoked = await revokeAllRoomInvites(roomId);
    return c.json({ ok: true, roomId, revoked });
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
      return c.json({ error: ROOM_ACCESS_DENIED }, 403);
    }
    if (err instanceof Error && err.message.startsWith("Invalid roomId")) {
      return c.json({ error: err.message }, 400);
    }
    log.error({ msg: "admin/room/invites", detail: String(err) });
    return c.json({ error: "Failed to revoke room invites" }, 500);
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
    log.info({
      msg: "admin.invite.create",
      requestId: c.get("requestId"),
      teamId: keyCtx.teamId,
      roomId,
      tokenId: result.tokenId,
    });
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
    if (err instanceof Error && err.message === INVITE_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    if (err instanceof Error && err.message === ROOM_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    if (err instanceof Error && err.message.startsWith("Invalid roomId")) {
      return c.json({ error: err.message }, 400);
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
 *
 * Signature headers (receivers should enforce ≤5 min timestamp skew):
 *   X-Roomd-Signature, X-Roomd-Timestamp, X-Roomd-Nonce
 * HMAC-SHA256 over `${timestamp}.${nonce}.${body}`.
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
      secretHint: webhookSecretHint(h.secret),
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
  if (!body.url) {
    return c.json({ error: "url required" }, 400);
  }
  try {
    await assertSafeWebhookUrl(body.url);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid webhook URL" },
      400,
    );
  }
  if (body.roomId) {
    try {
      await assertRoomAccess(body.roomId, keyCtx);
    } catch (err) {
      if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) {
        return c.json({ error: ROOM_ACCESS_DENIED }, 403);
      }
      return c.json({ error: "Failed to verify room" }, 500);
    }
  }
  try {
    const hook = await addWebhook(keyCtx.teamId, {
      url: body.url,
      secret: body.secret && body.secret.length >= 8 ? body.secret : nanoid(24),
      roomId: body.roomId,
    });
    log.info({ msg: "webhook.create", teamId: keyCtx.teamId, webhookId: hook.id });
    return c.json(
      {
        id: hook.id,
        url: hook.url,
        roomId: hook.roomId,
        secret: hook.plaintextSecret,
        createdAt: hook.createdAt,
        note: "Save the secret. It will not be shown again. Verify X-Roomd-Timestamp within 5 minutes.",
      },
      201,
    );
  } catch (err) {
    if (err instanceof Error && err.message === WEBHOOK_LIMIT_EXCEEDED) {
      return c.json({ error: err.message }, 403);
    }
    log.error({ msg: "admin/webhooks", detail: String(err) });
    return c.json({ error: "Failed to create webhook" }, 500);
  }
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

// Helpers used by roomd-web / tests (re-export)
export {
  revokeAllRoomInvites,
  revokeAllTeamInvites,
  assertValidRoomId,
  rateLimitBucket,
};
