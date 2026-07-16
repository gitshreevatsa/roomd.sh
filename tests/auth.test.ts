import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { resolveKey, resetKeyMap, getKeyCount } from "../src/auth.js";
import {
  storeDynamicKey,
  getDynamicKey,
  listDynamicKeys,
  revokeDynamicKey,
  storeInviteToken,
  getInviteToken,
  listRoomInvites,
  revokeInviteToken,
  assertRoomAccess,
  checkRateLimit,
  ROOM_ACCESS_DENIED,
} from "../src/store/redis.js";
import type { KeyContext } from "../src/types.js";

const envBackup = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeyMap();
}

beforeEach(() => fakeRedis.flush());

afterEach(() => {
  process.env = { ...envBackup };
  resetKeyMap();
  fakeRedis.now = () => Date.now();
});

describe("resolveKey: static env keys", () => {
  test("resolves a key from API_KEYS to its team", async () => {
    setEnv({ API_KEYS: "team-a:secret-a,team-b:secret-b", ROOMD_SECRET: undefined });

    expect(await resolveKey("secret-a")).toEqual({
      teamId: "team-a",
      isInvite: false,
      isStatic: true,
    });
    expect(await resolveKey("secret-b")).toEqual({
      teamId: "team-b",
      isInvite: false,
      isStatic: true,
    });
  });

  test("rejects an unknown secret", async () => {
    setEnv({ API_KEYS: "team-a:secret-a", ROOMD_SECRET: undefined });
    expect(await resolveKey("wrong")).toBeNull();
  });

  test("rejects an empty secret", async () => {
    setEnv({ API_KEYS: "team-a:secret-a", ROOMD_SECRET: undefined });
    expect(await resolveKey("")).toBeNull();
  });

  test("a prefix of a valid secret is not accepted", async () => {
    setEnv({ API_KEYS: "team-a:secret-a", ROOMD_SECRET: undefined });
    expect(await resolveKey("secret-")).toBeNull();
  });

  test("falls back to ROOMD_SECRET as the default team", async () => {
    setEnv({ API_KEYS: undefined, ROOMD_SECRET: "legacy" });
    expect(await resolveKey("legacy")).toEqual({
      teamId: "default",
      isInvite: false,
      isStatic: true,
    });
  });

  test("reports zero configured keys when the env is empty", () => {
    setEnv({ API_KEYS: undefined, ROOMD_SECRET: undefined });
    expect(getKeyCount()).toBe(0);
  });
});

describe("dynamic keys", () => {
  beforeEach(() => setEnv({ API_KEYS: "team-a:secret-a", ROOMD_SECRET: undefined }));

  test("a minted key resolves to its team and is not static", async () => {
    const { secret } = await storeDynamicKey("team-x", "team-a");
    expect(await resolveKey(secret)).toEqual({
      teamId: "team-x",
      isInvite: false,
      isStatic: false,
    });
  });

  test("the raw secret is never written to Redis", async () => {
    const { secret } = await storeDynamicKey("team-x", "team-a");
    expect(fakeRedis.dump()).not.toContain(secret);
    // The lookup still works, so it is stored as a digest.
    expect(await getDynamicKey(secret)).not.toBeNull();
  });

  test("listing exposes only a hint, never the secret", async () => {
    const { secret } = await storeDynamicKey("team-x", "team-a");
    const keys = await listDynamicKeys("team-x");

    expect(keys).toHaveLength(1);
    expect(keys[0]!.hint).toBe(`****${secret.slice(-4)}`);
    expect(JSON.stringify(keys)).not.toContain(secret);
  });

  test("a revoked key stops authenticating", async () => {
    const { secret, keyId } = await storeDynamicKey("team-x", "team-a");

    expect(await revokeDynamicKey(keyId, "team-x")).toBe(true);
    expect(await resolveKey(secret)).toBeNull();
    expect(await listDynamicKeys("team-x")).toEqual([]);
  });

  test("another team cannot revoke your key", async () => {
    const { secret, keyId } = await storeDynamicKey("team-x", "team-a");

    expect(await revokeDynamicKey(keyId, "team-y")).toBe(false);
    expect(await resolveKey(secret)).not.toBeNull();
  });
});

describe("invite tokens", () => {
  beforeEach(() => setEnv({ API_KEYS: "team-a:secret-a", ROOMD_SECRET: undefined }));

  test("resolves to a room-scoped context", async () => {
    const { token } = await storeInviteToken("room-1", "team-a");
    expect(await resolveKey(token)).toEqual({
      teamId: "team-a",
      allowedRoomId: "room-1",
      isInvite: true,
      isStatic: false,
    });
  });

  test("the raw token is never written to Redis", async () => {
    const { token } = await storeInviteToken("room-1", "team-a");
    expect(fakeRedis.dump()).not.toContain(token);
    expect(await getInviteToken(token)).not.toBeNull();
  });

  test("an expired token stops resolving and drops out of the listing", async () => {
    const { token } = await storeInviteToken("room-1", "team-a", 60);
    expect(await resolveKey(token)).not.toBeNull();

    const later = Date.now() + 61_000;
    fakeRedis.now = () => later;

    expect(await resolveKey(token)).toBeNull();
    expect(await listRoomInvites("room-1")).toEqual([]);
  });

  test("listing exposes only a hint", async () => {
    const { token } = await storeInviteToken("room-1", "team-a");
    const invites = await listRoomInvites("room-1");
    expect(invites[0]!.hint).toBe(`****${token.slice(-4)}`);
    expect(JSON.stringify(invites)).not.toContain(token);
  });

  test("a revoked token stops authenticating", async () => {
    const { token, tokenId } = await storeInviteToken("room-1", "team-a");
    expect(await revokeInviteToken(tokenId, "room-1")).toBe(true);
    expect(await resolveKey(token)).toBeNull();
  });

  test("an invite cannot be revoked through a room it does not belong to", async () => {
    const { token, tokenId } = await storeInviteToken("room-1", "team-a");
    expect(await revokeInviteToken(tokenId, "room-2")).toBe(false);
    expect(await resolveKey(token)).not.toBeNull();
  });
});

describe("assertRoomAccess", () => {
  const teamA: KeyContext = { teamId: "team-a", isInvite: false, isStatic: true };
  const teamB: KeyContext = { teamId: "team-b", isInvite: false, isStatic: true };

  test("the first team to touch a room claims it", async () => {
    await assertRoomAccess("room-1", teamA);
    await assertRoomAccess("room-1", teamA); // still fine on re-entry
  });

  test("a second team is denied", async () => {
    await assertRoomAccess("room-1", teamA);
    await expect(assertRoomAccess("room-1", teamB)).rejects.toThrow(ROOM_ACCESS_DENIED);
  });

  test("the denial does not distinguish a missing room from someone else's", async () => {
    await assertRoomAccess("room-1", teamA);

    const denied = await assertRoomAccess("room-1", teamB).catch((e: Error) => e.message);
    expect(denied).toBe(ROOM_ACCESS_DENIED);
  });

  test("an invite token may enter only its own room", async () => {
    const invite: KeyContext = {
      teamId: "team-a",
      allowedRoomId: "room-1",
      isInvite: true,
      isStatic: false,
    };

    await assertRoomAccess("room-1", invite);
    await expect(assertRoomAccess("room-2", invite)).rejects.toThrow(ROOM_ACCESS_DENIED);
  });

  test("an invite does not claim ownership of an unclaimed room", async () => {
    const invite: KeyContext = {
      teamId: "team-a",
      allowedRoomId: "room-9",
      isInvite: true,
      isStatic: false,
    };
    await assertRoomAccess("room-9", invite);

    // team-b can still claim it, because the invite never took ownership.
    await assertRoomAccess("room-9", teamB);
  });

  test("an idle room's ownership eventually expires", async () => {
    await assertRoomAccess("room-1", teamA);

    // Rooms are reclaimed after 30 days without a tool call.
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    fakeRedis.now = () => later;

    await assertRoomAccess("room-1", teamB); // now claimable by anyone
  });

  test("claiming a room indexes it under the team for list_rooms", async () => {
    const { listTeamRooms } = await import("../src/store/redis");
    await assertRoomAccess("room-a", teamA);
    await assertRoomAccess("room-b", teamA);
    await assertRoomAccess("room-c", teamB);

    expect(await listTeamRooms("team-a")).toEqual(["room-a", "room-b"]);
    expect(await listTeamRooms("team-b")).toEqual(["room-c"]);
  });

  test("listTeamRooms drops rooms whose ownership expired", async () => {
    const { listTeamRooms } = await import("../src/store/redis");
    await assertRoomAccess("room-1", teamA);

    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    fakeRedis.now = () => later;

    expect(await listTeamRooms("team-a")).toEqual([]);
  });
});

describe("checkRateLimit", () => {
  test("allows up to the limit and refuses the next call", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit("team-a", 3)).allowed).toBe(true);
    }
    const over = await checkRateLimit("team-a", 3);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  test("counts each team separately", async () => {
    await checkRateLimit("team-a", 1);
    expect((await checkRateLimit("team-b", 1)).allowed).toBe(true);
  });

  test("reports how many calls remain in the window", async () => {
    expect((await checkRateLimit("team-a", 10)).remaining).toBe(9);
  });

  test("fails open when the store is unreachable", async () => {
    const original = fakeRedis.incr;
    fakeRedis.incr = () => Promise.reject(new Error("redis down"));

    try {
      // A rate limiter that fails closed would take the whole service down
      // with Redis. Requests are allowed through instead.
      const result = await checkRateLimit("team-a", 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
    } finally {
      fakeRedis.incr = original;
    }
  });
});
