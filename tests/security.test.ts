import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import {
  assertRoomAccess,
  assertValidRoomId,
  checkRateLimit,
  getContext,
  getRoomOwner,
  keys,
  listRoomInvites,
  rateLimitBucket,
  revokeAllRoomInvites,
  revokeAllTeamInvites,
  ROOM_ACCESS_DENIED,
  ROOM_TTL_SECONDS,
  setContext,
  storeDynamicKey,
  storeInviteToken,
} from "../src/store/redis";
import {
  KEY_LIMIT_EXCEEDED,
  MAX_INVITES_PER_ROOM,
  MAX_KEYS_PER_TEAM,
  MAX_ROOMS_PER_TEAM,
  ROOM_LIMIT_EXCEEDED,
} from "../src/limits";
import { createMcpServer } from "../src/mcp/server";
import type { KeyContext } from "../src/types";
import { requestReview } from "../src/mcp/tools/review";
import {
  encryptWebhookSecret,
  decryptWebhookSecret,
  signWebhookPayload,
} from "../src/webhooks";

beforeEach(() => {
  fakeRedis.flush();
  fakeRedis.now = () => Date.now();
});

afterEach(() => {
  fakeRedis.now = () => Date.now();
});

const teamA: KeyContext = {
  teamId: "team-a",
  isInvite: false,
  isStatic: true,
  isOperator: false,
};
const teamB: KeyContext = {
  teamId: "team-b",
  isInvite: false,
  isStatic: true,
  isOperator: false,
};

describe("invite does not refresh room TTL", () => {
  test("invite access leaves owner TTL unchanged", async () => {
    await assertRoomAccess("room-1", teamA);
    const ownerKey = keys.roomOwner("room-1");
    const ttlAfterClaim = fakeRedis.ttl(ownerKey);
    expect(ttlAfterClaim).toBe(ROOM_TTL_SECONDS);

    const invite: KeyContext = {
      teamId: "team-a",
      allowedRoomId: "room-1",
      isInvite: true,
      isStatic: false,
      isOperator: false,
      boundAgentId: "invite:tok",
      agentId: "invite:tok",
    };

    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = Date.now();
    fakeRedis.now = () => t0 + dayMs;
    await assertRoomAccess("room-1", invite);

    const ttlAfterInvite = fakeRedis.ttl(ownerKey);
    // Without touch: ~29 days left. With touch: full 30 days again.
    expect(ttlAfterInvite).toBeLessThan(ROOM_TTL_SECONDS - 20 * 60 * 60);
    expect(ttlAfterInvite).toBeGreaterThan(ROOM_TTL_SECONDS - 2 * dayMs);

    // Team key still refreshes TTL.
    await assertRoomAccess("room-1", teamA);
    expect(fakeRedis.ttl(ownerKey)).toBe(ROOM_TTL_SECONDS);
  });
});

describe("atomic reclaim quarantine", () => {
  test("reclaim purges leftover data and sets real owner", async () => {
    await assertRoomAccess("room-1", teamA);
    await setContext("room-1", {
      id: "c1",
      type: "note",
      author: "a",
      timestamp: new Date().toISOString(),
      summary: "secret leftover",
      consuming_agents: [],
      payload: {},
      version: "1",
    });

    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    fakeRedis.now = () => later;
    await assertRoomAccess("room-1", teamB);
    expect(await getRoomOwner("room-1")).toBe("team-b");
    expect(await getContext("room-1", "c1")).toBeNull();
  });

  test("quarantine owner denies other teams", async () => {
    await fakeRedis.set(keys.roomOwner("room-q"), `__purging__:team-a`, {
      ex: ROOM_TTL_SECONDS,
    });
    await expect(assertRoomAccess("room-q", teamA)).rejects.toThrow(ROOM_ACCESS_DENIED);
    await expect(assertRoomAccess("room-q", teamB)).rejects.toThrow(ROOM_ACCESS_DENIED);
  });

  test("failed purge deletes quarantine so claim can retry", async () => {
    await assertRoomAccess("room-1", teamA);
    await setContext("room-1", {
      id: "c1",
      type: "note",
      author: "a",
      timestamp: new Date().toISOString(),
      summary: "x",
      consuming_agents: [],
      payload: {},
      version: "1",
    });

    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    fakeRedis.now = () => later;

    const original = fakeRedis.smembers.bind(fakeRedis);
    let calls = 0;
    fakeRedis.smembers = async (key: string) => {
      calls += 1;
      // Fail during purge (first smembers batch inside purgeRoomContents).
      if (calls <= 5 && key.includes("context:index")) {
        throw new Error("purge boom");
      }
      return original(key);
    };

    try {
      await expect(assertRoomAccess("room-1", teamB)).rejects.toThrow(/purge boom/);
      expect(await getRoomOwner("room-1")).toBeNull();
    } finally {
      fakeRedis.smembers = original;
    }

    // Retry succeeds.
    await assertRoomAccess("room-1", teamB);
    expect(await getRoomOwner("room-1")).toBe("team-b");
  });
});

describe("assertValidRoomId", () => {
  test("accepts lowercase ids", () => {
    expect(() => assertValidRoomId("ab")).not.toThrow();
    expect(() => assertValidRoomId("room_1-ok")).not.toThrow();
  });

  test("rejects short, uppercase, and reserved prefixes", () => {
    expect(() => assertValidRoomId("r")).toThrow(/Invalid roomId/);
    expect(() => assertValidRoomId("Room1")).toThrow(/Invalid roomId/);
    expect(() => assertValidRoomId("__hidden")).toThrow(/Invalid roomId/);
    expect(() => assertValidRoomId("bad__id")).toThrow(/reserved/);
  });
});

describe("hard caps", () => {
  test("enforces MAX_KEYS_PER_TEAM", async () => {
    for (let i = 0; i < MAX_KEYS_PER_TEAM; i++) {
      await storeDynamicKey("team-cap", "team-cap", { note: `k${i}` });
    }
    await expect(storeDynamicKey("team-cap", "team-cap")).rejects.toThrow(
      KEY_LIMIT_EXCEEDED,
    );
  });

  test("enforces MAX_INVITES_PER_ROOM", async () => {
    await assertRoomAccess("room-inv", teamA);
    for (let i = 0; i < MAX_INVITES_PER_ROOM; i++) {
      await storeInviteToken("room-inv", "team-a");
    }
    await expect(storeInviteToken("room-inv", "team-a")).rejects.toThrow(
      /Invite limit exceeded/,
    );
  });

  test("enforces MAX_ROOMS_PER_TEAM", async () => {
    const prev = process.env["MAX_ROOMS_PER_TEAM"];
    // Cap is module-loaded; use the exported constant by claiming that many rooms.
    for (let i = 0; i < MAX_ROOMS_PER_TEAM; i++) {
      const id = `rm${i.toString().padStart(2, "0")}`;
      await assertRoomAccess(id, teamA);
    }
    await expect(assertRoomAccess("rmzz", teamA)).rejects.toThrow(ROOM_LIMIT_EXCEEDED);
    if (prev !== undefined) process.env["MAX_ROOMS_PER_TEAM"] = prev;
  });
});

describe("revoke all invites", () => {
  test("revokeAllRoomInvites clears the room", async () => {
    await assertRoomAccess("room-1", teamA);
    await storeInviteToken("room-1", "team-a");
    await storeInviteToken("room-1", "team-a");
    expect(await listRoomInvites("room-1")).toHaveLength(2);
    expect(await revokeAllRoomInvites("room-1")).toBe(2);
    expect(await listRoomInvites("room-1")).toHaveLength(0);
  });

  test("revokeAllTeamInvites covers every owned room", async () => {
    await assertRoomAccess("room-a", teamA);
    await assertRoomAccess("room-b", teamA);
    await storeInviteToken("room-a", "team-a");
    await storeInviteToken("room-b", "team-a");
    const result = await revokeAllTeamInvites("team-a");
    expect(result.rooms).toBe(2);
    expect(result.revoked).toBe(2);
  });
});

describe("rate limit bucket for invites", () => {
  test("invite bucket is distinct from team bucket", async () => {
    const invite: KeyContext = {
      teamId: "team-a",
      allowedRoomId: "room-1",
      isInvite: true,
      isStatic: false,
      isOperator: false,
      boundAgentId: "invite:abc",
      agentId: "invite:abc",
    };
    expect(rateLimitBucket(invite)).toBe("invite:abc");
    expect(rateLimitBucket(teamA)).toBe("team-a");

    await checkRateLimit(rateLimitBucket(teamA), 1);
    expect((await checkRateLimit(rateLimitBucket(invite), 1)).allowed).toBe(true);
  });
});

describe("MCP approve requires boundAgentId", () => {
  type ToolEntry = {
    handler: (
      args: unknown,
      extra?: unknown,
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };

  function toolMap(server: ReturnType<typeof createMcpServer>) {
    return (server as unknown as { _registeredTools: Record<string, ToolEntry> })
      ._registeredTools;
  }

  test("static unbound key cannot approve via MCP wrapper", async () => {
    await assertRoomAccess("room-1", teamA);
    const review = await requestReview({
      roomId: "room-1",
      targetType: "task",
      targetId: "t1",
      requestedBy: "alice",
      reviewer: "bob",
    });

    const unboundTools = toolMap(createMcpServer(teamA));
    const denied = await unboundTools["approve"]!.handler({
      roomId: "room-1",
      reviewId: review.id,
      agentId: "bob",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/boundAgentId/);

    const { secret } = await storeDynamicKey("team-a", "team-a", {
      boundAgentId: "bob",
    });
    const { resolveKey } = await import("../src/auth");
    const boundCtx = await resolveKey(secret);
    expect(boundCtx?.boundAgentId).toBe("bob");

    const boundTools = toolMap(createMcpServer(boundCtx!));
    const result = await boundTools["approve"]!.handler({
      roomId: "room-1",
      reviewId: review.id,
      agentId: "carol", // overwritten to bob by bindBoundAgent
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("approved");
  });
});

describe("JSON-RPC batch cap", () => {
  test("MAX_RPC_BATCH defaults to 1", async () => {
    const { MAX_RPC_BATCH } = await import("../src/limits");
    expect(MAX_RPC_BATCH).toBe(1);
  });
});

describe("webhook crypto + signature", () => {
  test("encrypt round-trips and signs timestamp.nonce.body", () => {
    process.env["WEBHOOK_SECRET_KEY"] = "test-webhook-key";
    const enc = encryptWebhookSecret("super-secret-value");
    expect(enc.startsWith("enc:")).toBe(true);
    expect(enc).not.toContain("super-secret-value");
    expect(decryptWebhookSecret(enc)).toBe("super-secret-value");

    const body = '{"ok":true}';
    const ts = "1710000000";
    const nonce = "abc123";
    const sig = signWebhookPayload("super-secret-value", ts, nonce, body);
    expect(sig).toHaveLength(64);
    expect(signWebhookPayload("super-secret-value", ts, nonce, body)).toBe(sig);
    expect(signWebhookPayload("super-secret-value", ts, "other", body)).not.toBe(sig);
  });
});
