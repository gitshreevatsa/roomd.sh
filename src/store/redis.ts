import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { AgentPresence, ContextEntry, Event, KeyContext, Plan } from "../types.js";

const HEARTBEAT_TTL_SECONDS = 120;

/** Idle rooms expire after 30 days. Every authenticated tool call refreshes this. */
export const ROOM_TTL_SECONDS = 60 * 60 * 24 * 30;

// ---------------------------------------------------------------------------
// Singleton Redis client
// ---------------------------------------------------------------------------

const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});

// ---------------------------------------------------------------------------
// Secret hashing
// ---------------------------------------------------------------------------

/**
 * Secrets are never stored in Redis. Only their SHA-256 digest is, so a Redis
 * dump cannot be replayed as a set of live bearer tokens. Lookup is by digest.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Last four characters of a secret, for display in management UIs. */
function hint(secret: string): string {
  return `****${secret.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/** Typed key-builder helpers for every Redis namespace used in this module. */
export const keys = {
  plan: (roomId: string) => `${roomId}:plan`,
  context: (roomId: string, contextId: string) =>
    `${roomId}:context:${contextId}`,
  contextIndex: (roomId: string) => `${roomId}:context:index`,
  events: (roomId: string) => `${roomId}:events`,
  agents: (roomId: string) => `${roomId}:agents`,
  vars: (roomId: string) => `${roomId}:vars`,
  lock: (roomId: string, resource: string) => `${roomId}:lock:${resource}`,
  locksIndex: (roomId: string) => `${roomId}:locks`,
  heartbeat: (roomId: string, agentId: string) => `${roomId}:heartbeat:${agentId}`,
  cursor: (roomId: string, agentId: string) => `${roomId}:cursor:${agentId}`,
  eventReads: (roomId: string, eventId: string) => `${roomId}:event_reads:${eventId}`,
  roomOwner: (roomId: string) => `room:${roomId}:owner`,
  rateLimit: (teamId: string, window: number) => `ratelimit:${teamId}:${window}`,
  dynKey: (secretHash: string) => `dynkey:${secretHash}`,
  dynKeyById: (keyId: string) => `dynkeyid:${keyId}`,
  dynKeysByTeam: (teamId: string) => `dynkeys:${teamId}`,
  invite: (tokenHash: string) => `invite:${tokenHash}`,
  inviteById: (tokenId: string) => `inviteid:${tokenId}`,
  invitesByRoom: (roomId: string) => `room:${roomId}:invites`,
} as const;

// ---------------------------------------------------------------------------
// Room TTL
// ---------------------------------------------------------------------------

/**
 * Refresh the expiry on every long-lived key belonging to a room.
 * Called once per authenticated tool call, so an actively used room never
 * expires and an abandoned one is reclaimed after ROOM_TTL_SECONDS.
 */
export async function touchRoomTtl(roomId: string): Promise<void> {
  try {
    const pipeline = redis.pipeline();
    pipeline.expire(keys.plan(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.events(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.contextIndex(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.agents(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.vars(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.locksIndex(roomId), ROOM_TTL_SECONDS);
    pipeline.expire(keys.roomOwner(roomId), ROOM_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    // TTL refresh is best effort. A failure here must not fail the tool call.
    process.stderr.write(`[redis] touchRoomTtl error: ${String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** Fetches the Plan stored for a given room, or null if it does not exist. */
export async function getPlan(roomId: string): Promise<Plan | null> {
  try {
    return await redis.get<Plan>(keys.plan(roomId));
  } catch (err) {
    process.stderr.write(`[redis] getPlan error: ${String(err)}\n`);
    throw err;
  }
}

/** Persists a Plan for the given room, serialised as JSON. */
export async function setPlan(roomId: string, plan: Plan): Promise<void> {
  try {
    await redis.set(keys.plan(roomId), JSON.stringify(plan), { ex: ROOM_TTL_SECONDS });
  } catch (err) {
    process.stderr.write(`[redis] setPlan error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/** Retrieves a single ContextEntry by its id, or null if it does not exist. */
export async function getContext(
  roomId: string,
  contextId: string,
): Promise<ContextEntry | null> {
  try {
    return await redis.get<ContextEntry>(keys.context(roomId, contextId));
  } catch (err) {
    process.stderr.write(`[redis] getContext error: ${String(err)}\n`);
    throw err;
  }
}

/** Stores a ContextEntry and registers its id in the room's context index SET. */
export async function setContext(
  roomId: string,
  entry: ContextEntry,
): Promise<void> {
  try {
    await redis.set(keys.context(roomId, entry.id), JSON.stringify(entry), {
      ex: ROOM_TTL_SECONDS,
    });
    await redis.sadd(keys.contextIndex(roomId), entry.id);
  } catch (err) {
    process.stderr.write(`[redis] setContext error: ${String(err)}\n`);
    throw err;
  }
}

/** Returns the full list of context ids registered for a room. */
export async function getContextIndex(roomId: string): Promise<string[]> {
  try {
    return await redis.smembers(keys.contextIndex(roomId));
  } catch (err) {
    process.stderr.write(`[redis] getContextIndex error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/** Prepends an Event (as JSON) to the room's event list using LPUSH. */
export async function pushEvent(roomId: string, event: Event): Promise<void> {
  try {
    await redis.lpush(keys.events(roomId), JSON.stringify(event));
    await redis.expire(keys.events(roomId), ROOM_TTL_SECONDS);
  } catch (err) {
    process.stderr.write(`[redis] pushEvent error: ${String(err)}\n`);
    throw err;
  }
}

/**
 * Returns the most recent `limit` events from the room's event list.
 * Handles both pre-parsed objects and raw JSON strings returned by Upstash.
 */
export async function getEvents(
  roomId: string,
  limit: number,
): Promise<Event[]> {
  try {
    const raw = await redis.lrange(keys.events(roomId), 0, limit - 1);
    return raw.map((r) =>
      typeof r === "string" ? (JSON.parse(r) as Event) : (r as Event),
    );
  } catch (err) {
    process.stderr.write(`[redis] getEvents error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

/** Number of events in a room's log. Cheap, used by operator usage stats. */
export async function getEventCount(roomId: string): Promise<number> {
  try {
    return await redis.llen(keys.events(roomId));
  } catch (err) {
    process.stderr.write(`[redis] getEventCount error: ${String(err)}\n`);
    return 0;
  }
}

/** The team that owns a room, or null if unclaimed. */
export async function getRoomOwner(roomId: string): Promise<string | null> {
  try {
    return await redis.get<string>(keys.roomOwner(roomId));
  } catch (err) {
    process.stderr.write(`[redis] getRoomOwner error: ${String(err)}\n`);
    return null;
  }
}

/** Returns the set of agent ids currently registered in the room. */
export async function getAgents(roomId: string): Promise<string[]> {
  try {
    return await redis.smembers(keys.agents(roomId));
  } catch (err) {
    process.stderr.write(`[redis] getAgents error: ${String(err)}\n`);
    throw err;
  }
}

/** Adds an agent id to the room's agent SET (idempotent via SADD). */
export async function registerAgent(
  roomId: string,
  agentId: string,
): Promise<void> {
  try {
    await redis.sadd(keys.agents(roomId), agentId);
  } catch (err) {
    process.stderr.write(`[redis] registerAgent error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared variable helpers (small facts agents agree on, stored as a HASH)
// ---------------------------------------------------------------------------

/** Set a shared variable in the room. Overwrites any previous value. */
export async function setSharedVar(
  roomId: string,
  key: string,
  value: string,
): Promise<void> {
  try {
    await redis.hset(keys.vars(roomId), { [key]: value });
    await redis.expire(keys.vars(roomId), ROOM_TTL_SECONDS);
  } catch (err) {
    process.stderr.write(`[redis] setSharedVar error: ${String(err)}\n`);
    throw err;
  }
}

/** Read one shared variable. Returns null when the key was never set. */
export async function getSharedVar(
  roomId: string,
  key: string,
): Promise<string | null> {
  try {
    const value = await redis.hget<string>(keys.vars(roomId), key);
    return value ?? null;
  } catch (err) {
    process.stderr.write(`[redis] getSharedVar error: ${String(err)}\n`);
    throw err;
  }
}

/** Read every shared variable in the room. */
export async function listSharedVars(
  roomId: string,
): Promise<Record<string, string>> {
  try {
    const all = await redis.hgetall<Record<string, string>>(keys.vars(roomId));
    return all ?? {};
  } catch (err) {
    process.stderr.write(`[redis] listSharedVars error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Distributed lock helpers (Redis SET NX)
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_TTL_MS = 30_000;

/**
 * Attempt to acquire a distributed lock via SET NX.
 * Returns true if acquired, false if already held by another agent.
 */
export async function acquireLock(
  roomId: string,
  resource: string,
  agentId: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): Promise<boolean> {
  try {
    const result = await redis.set(
      keys.lock(roomId, resource),
      agentId,
      { nx: true, px: ttlMs },
    );
    if (result === "OK") {
      await redis.sadd(keys.locksIndex(roomId), resource);
      return true;
    }
    return false;
  } catch (err) {
    process.stderr.write(`[redis] acquireLock error: ${String(err)}\n`);
    throw err;
  }
}

/**
 * Release a lock only if held by agentId.
 * Returns true if released, false if the lock belongs to a different agent.
 */
export async function releaseLock(
  roomId: string,
  resource: string,
  agentId: string,
): Promise<boolean> {
  try {
    const current = await redis.get<string>(keys.lock(roomId, resource));
    if (current === agentId) {
      await redis.del(keys.lock(roomId, resource));
      await redis.srem(keys.locksIndex(roomId), resource);
      return true;
    }
    return false;
  } catch (err) {
    process.stderr.write(`[redis] releaseLock error: ${String(err)}\n`);
    throw err;
  }
}

/** Return all active locks in the room with their holders. Cleans up expired entries. */
export async function listActiveLocks(
  roomId: string,
): Promise<Array<{ resource: string; owner: string }>> {
  try {
    const resources = await redis.smembers(keys.locksIndex(roomId));
    const active: Array<{ resource: string; owner: string }> = [];
    for (const resource of resources) {
      const owner = await redis.get<string>(keys.lock(roomId, resource));
      if (owner !== null) {
        active.push({ resource, owner });
      } else {
        await redis.srem(keys.locksIndex(roomId), resource);
      }
    }
    return active;
  } catch (err) {
    process.stderr.write(`[redis] listActiveLocks error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Presence / heartbeat helpers
// ---------------------------------------------------------------------------

/** Record that an agent is alive. Key auto-expires after 120s of no heartbeat. */
export async function setHeartbeat(roomId: string, agentId: string): Promise<void> {
  try {
    await redis.set(keys.heartbeat(roomId, agentId), new Date().toISOString(), {
      ex: HEARTBEAT_TTL_SECONDS,
    });
    await redis.sadd(keys.agents(roomId), agentId);
  } catch (err) {
    process.stderr.write(`[redis] setHeartbeat error: ${String(err)}\n`);
    throw err;
  }
}

/** Return presence status of all known agents in the room. */
export async function getAgentPresence(roomId: string): Promise<AgentPresence[]> {
  try {
    const agentIds = await redis.smembers(keys.agents(roomId));
    const presence: AgentPresence[] = [];
    for (const agentId of agentIds) {
      const lastSeen = await redis.get<string>(keys.heartbeat(roomId, agentId));
      presence.push({
        agentId,
        status: lastSeen !== null ? "online" : "offline",
        lastSeen,
      });
    }
    return presence;
  } catch (err) {
    process.stderr.write(`[redis] getAgentPresence error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Event cursor helpers (per-agent read position)
// ---------------------------------------------------------------------------

/** Get the ISO timestamp of the last event this agent read. Null if never read. */
export async function getEventCursor(
  roomId: string,
  agentId: string,
): Promise<string | null> {
  try {
    return await redis.get<string>(keys.cursor(roomId, agentId));
  } catch (err) {
    process.stderr.write(`[redis] getEventCursor error: ${String(err)}\n`);
    throw err;
  }
}

/** Advance the agent's read cursor to the given timestamp. */
export async function setEventCursor(
  roomId: string,
  agentId: string,
  timestamp: string,
): Promise<void> {
  try {
    await redis.set(keys.cursor(roomId, agentId), timestamp, { ex: ROOM_TTL_SECONDS });
  } catch (err) {
    process.stderr.write(`[redis] setEventCursor error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Event read receipt helpers
// ---------------------------------------------------------------------------

/** Mark an event as read by an agent. */
export async function markEventRead(
  roomId: string,
  eventId: string,
  agentId: string,
): Promise<void> {
  try {
    await redis.sadd(keys.eventReads(roomId, eventId), agentId);
    await redis.expire(keys.eventReads(roomId, eventId), ROOM_TTL_SECONDS);
  } catch (err) {
    process.stderr.write(`[redis] markEventRead error: ${String(err)}\n`);
    throw err;
  }
}

/** Return the list of agents that have marked an event as read. */
export async function getEventReaders(
  roomId: string,
  eventId: string,
): Promise<string[]> {
  try {
    return await redis.smembers(keys.eventReads(roomId, eventId));
  } catch (err) {
    process.stderr.write(`[redis] getEventReaders error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Room ownership helpers
// ---------------------------------------------------------------------------

/** Thrown for both "no such room" and "wrong team", so callers cannot probe for existence. */
export const ROOM_ACCESS_DENIED = "Room not found or access denied";

/**
 * Claim or verify room access for the resolved KeyContext.
 *
 * Invite tokens: allowed if their allowedRoomId matches, no ownership transfer.
 * Team keys: SET NX to claim on first access, verify on subsequent calls.
 * Cross-team access always throws ROOM_ACCESS_DENIED.
 *
 * Also refreshes the room's TTL, so any room in active use is never reclaimed.
 */
export async function assertRoomAccess(roomId: string, keyCtx: KeyContext): Promise<void> {
  try {
    // Invite tokens: scope is baked into the token itself
    if (keyCtx.isInvite) {
      if (keyCtx.allowedRoomId !== roomId) {
        throw new Error(ROOM_ACCESS_DENIED);
      }
      await touchRoomTtl(roomId);
      return;
    }

    // Team keys with an explicit room restriction (future use)
    if (keyCtx.allowedRoomId !== undefined && keyCtx.allowedRoomId !== roomId) {
      throw new Error(ROOM_ACCESS_DENIED);
    }

    // Normal team key: claim or verify ownership
    const ownerKey = keys.roomOwner(roomId);
    const claimed = await redis.set(ownerKey, keyCtx.teamId, {
      nx: true,
      ex: ROOM_TTL_SECONDS,
    });
    if (claimed !== "OK") {
      const owner = await redis.get<string>(ownerKey);
      if (owner !== keyCtx.teamId) {
        throw new Error(ROOM_ACCESS_DENIED);
      }
    }
    await touchRoomTtl(roomId);
  } catch (err) {
    if (err instanceof Error && err.message === ROOM_ACCESS_DENIED) throw err;
    process.stderr.write(`[redis] assertRoomAccess error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting helpers
// ---------------------------------------------------------------------------

/**
 * Fixed-window rate limiter (per teamId, per minute).
 * Returns whether the request is allowed and how many remain this window.
 */
export async function checkRateLimit(
  teamId: string,
  limitPerMinute: number,
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const window = Math.floor(Date.now() / 60_000);
    const key = keys.rateLimit(teamId, window);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120); // clean up after 2 minutes
    const remaining = Math.max(0, limitPerMinute - count);
    return { allowed: count <= limitPerMinute, remaining };
  } catch (err) {
    process.stderr.write(`[redis] checkRateLimit error: ${String(err)}\n`);
    // Fail open. Do not block requests if Redis is down.
    return { allowed: true, remaining: limitPerMinute };
  }
}

// ---------------------------------------------------------------------------
// Dynamic API key helpers
// ---------------------------------------------------------------------------

export interface DynKey {
  keyId: string;
  teamId: string;
  createdBy: string;
  createdAt: string;
  /** Optional human label, e.g. "Maya's laptop" or "CI test key". */
  note?: string;
}

/** What is persisted under dynkeyid:{keyId}. Never contains the raw secret. */
interface StoredDynKey extends DynKey {
  secretHash: string;
  hint: string;
}

/** Create a new dynamic team key. Returns the raw secret, the only time it exists. */
export async function storeDynamicKey(
  teamId: string,
  createdBy: string,
  note?: string,
): Promise<DynKey & { secret: string }> {
  try {
    const keyId = nanoid(10);
    const secret = nanoid(32);
    const secretHash = hashSecret(secret);
    const createdAt = new Date().toISOString();
    const trimmedNote = note?.trim().slice(0, 120) || undefined;
    const data: DynKey = { keyId, teamId, createdBy, createdAt, ...(trimmedNote ? { note: trimmedNote } : {}) };
    const stored: StoredDynKey = { ...data, secretHash, hint: hint(secret) };

    await redis.set(keys.dynKey(secretHash), JSON.stringify(data));
    await redis.set(keys.dynKeyById(keyId), JSON.stringify(stored));
    await redis.sadd(keys.dynKeysByTeam(teamId), keyId);
    return { ...data, secret };
  } catch (err) {
    process.stderr.write(`[redis] storeDynamicKey error: ${String(err)}\n`);
    throw err;
  }
}

/** Look up a dynamic key by its raw secret. Returns null if not found. */
export async function getDynamicKey(secret: string): Promise<DynKey | null> {
  try {
    return await redis.get<DynKey>(keys.dynKey(hashSecret(secret)));
  } catch (err) {
    process.stderr.write(`[redis] getDynamicKey error: ${String(err)}\n`);
    return null; // auth lookup, fail closed for this key rather than throwing
  }
}

/** List all dynamic keys belonging to a team. Only the hint is returned. */
export async function listDynamicKeys(
  teamId: string,
): Promise<Array<DynKey & { hint: string }>> {
  try {
    const keyIds = await redis.smembers(keys.dynKeysByTeam(teamId));
    const result: Array<DynKey & { hint: string }> = [];
    for (const keyId of keyIds) {
      const raw = await redis.get<StoredDynKey>(keys.dynKeyById(keyId));
      if (raw) {
        const { secretHash: _secretHash, ...rest } = raw;
        result.push(rest);
      } else {
        await redis.srem(keys.dynKeysByTeam(teamId), keyId); // lazy cleanup
      }
    }
    return result;
  } catch (err) {
    process.stderr.write(`[redis] listDynamicKeys error: ${String(err)}\n`);
    throw err;
  }
}

/** Revoke a dynamic key. Only the owning team may revoke it. False if not found or not theirs. */
export async function revokeDynamicKey(keyId: string, requestingTeamId: string): Promise<boolean> {
  try {
    const raw = await redis.get<StoredDynKey>(keys.dynKeyById(keyId));
    if (!raw || raw.teamId !== requestingTeamId) return false;
    await redis.del(keys.dynKey(raw.secretHash));
    await redis.del(keys.dynKeyById(keyId));
    await redis.srem(keys.dynKeysByTeam(requestingTeamId), keyId);
    return true;
  } catch (err) {
    process.stderr.write(`[redis] revokeDynamicKey error: ${String(err)}\n`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Room invite token helpers
// ---------------------------------------------------------------------------

export interface InviteData {
  tokenId: string;
  roomId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
}

/** What is persisted under inviteid:{tokenId}. Never contains the raw token. */
interface StoredInvite extends InviteData {
  tokenHash: string;
  hint: string;
}

/**
 * Generate a room-scoped invite token.
 * Returns the raw token once. Afterwards only the tokenId and hint are retrievable.
 */
export async function storeInviteToken(
  roomId: string,
  createdBy: string,
  expiresInSeconds?: number,
): Promise<InviteData & { token: string }> {
  try {
    const tokenId = nanoid(10);
    const token = nanoid(32);
    const tokenHash = hashSecret(token);
    const createdAt = new Date().toISOString();
    const expiresAt = expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null;
    const data: InviteData = { tokenId, roomId, createdBy, createdAt, expiresAt };
    const stored: StoredInvite = { ...data, tokenHash, hint: hint(token) };

    const setOpts = expiresInSeconds ? { ex: expiresInSeconds } : {};
    await redis.set(keys.invite(tokenHash), JSON.stringify(data), setOpts);
    await redis.set(keys.inviteById(tokenId), JSON.stringify(stored));
    await redis.sadd(keys.invitesByRoom(roomId), tokenId);

    return { ...data, token };
  } catch (err) {
    process.stderr.write(`[redis] storeInviteToken error: ${String(err)}\n`);
    throw err;
  }
}

/** Look up an invite by its raw token. Returns null if missing or expired. */
export async function getInviteToken(token: string): Promise<InviteData | null> {
  try {
    return await redis.get<InviteData>(keys.invite(hashSecret(token)));
  } catch (err) {
    process.stderr.write(`[redis] getInviteToken error: ${String(err)}\n`);
    return null;
  }
}

/** List active invite tokens for a room. Only the hint is returned. */
export async function listRoomInvites(
  roomId: string,
): Promise<Array<InviteData & { hint: string }>> {
  try {
    const tokenIds = await redis.smembers(keys.invitesByRoom(roomId));
    const result: Array<InviteData & { hint: string }> = [];
    for (const tokenId of tokenIds) {
      const raw = await redis.get<StoredInvite>(keys.inviteById(tokenId));
      if (!raw) {
        await redis.srem(keys.invitesByRoom(roomId), tokenId);
        continue;
      }
      // The lookup key carries the TTL, so its absence means the invite expired.
      const alive = await redis.exists(keys.invite(raw.tokenHash));
      if (alive) {
        const { tokenHash: _tokenHash, ...rest } = raw;
        result.push(rest);
      } else {
        await redis.del(keys.inviteById(tokenId));
        await redis.srem(keys.invitesByRoom(roomId), tokenId); // lazy cleanup
      }
    }
    return result;
  } catch (err) {
    process.stderr.write(`[redis] listRoomInvites error: ${String(err)}\n`);
    throw err;
  }
}

/** Revoke one invite by tokenId. Caller must own the room. False if not found. */
export async function revokeInviteToken(tokenId: string, roomId: string): Promise<boolean> {
  try {
    const raw = await redis.get<StoredInvite>(keys.inviteById(tokenId));
    if (!raw || raw.roomId !== roomId) return false;
    await redis.del(keys.invite(raw.tokenHash));
    await redis.del(keys.inviteById(tokenId));
    await redis.srem(keys.invitesByRoom(roomId), tokenId);
    return true;
  } catch (err) {
    process.stderr.write(`[redis] revokeInviteToken error: ${String(err)}\n`);
    throw err;
  }
}
