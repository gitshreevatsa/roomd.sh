/**
 * Multi-tenant API key resolution.
 *
 * resolveKey() checks three sources in order:
 *   1. Static env-var keys  (API_KEYS or ROOMD_SECRET)
 *   2. Dynamic Redis keys    (created via POST /admin/keys)
 *   3. Room invite tokens    (created via POST /admin/rooms/:roomId/invite)
 *
 * Returns a KeyContext describing the caller's identity and access scope,
 * or null if the secret is not recognised.
 */

import { timingSafeEqual } from "node:crypto";
import type { KeyContext } from "./types.js";
import { getDynamicKey, getInviteToken, hashSecret } from "./store/redis.js";

export type { KeyContext };

/** Maps sha256(secret) to teamId. Hashing equalises length before comparison. */
let keyMap: Map<string, string> | null = null;

function buildKeyMap(): Map<string, string> {
  const map = new Map<string, string>();

  const raw = process.env["API_KEYS"] ?? "";
  if (raw) {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      const teamId = pair.slice(0, idx).trim();
      const secret = pair.slice(idx + 1).trim();
      if (teamId && secret) map.set(hashSecret(secret), teamId);
    }
  }

  // Backward compat: single ROOMD_SECRET becomes the "default" team
  if (map.size === 0) {
    const legacy = process.env["ROOMD_SECRET"] ?? "";
    if (legacy) map.set(hashSecret(legacy), "default");
  }

  return map;
}

/** Rebuild the cached key map. Only needed by tests that mutate the env. */
export function resetKeyMap(): void {
  keyMap = null;
}

/**
 * Compare two hex digests without leaking how many leading bytes matched.
 * Both inputs are sha256 digests, so lengths always agree.
 */
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Resolve a Bearer secret to a KeyContext, or null if unrecognised. */
export async function resolveKey(secret: string): Promise<KeyContext | null> {
  if (!keyMap) keyMap = buildKeyMap();
  if (!secret) return null;

  const digest = hashSecret(secret);

  // 1. Static env keys, no I/O. Every candidate is compared so a failed match
  //    costs the same regardless of which key was tried.
  let staticTeam: string | undefined;
  for (const [candidate, teamId] of keyMap) {
    if (digestsMatch(candidate, digest)) staticTeam = teamId;
  }
  if (staticTeam) return { teamId: staticTeam, isInvite: false, isStatic: true };

  // 2. Dynamic Redis team keys
  const dynKey = await getDynamicKey(secret);
  if (dynKey) return { teamId: dynKey.teamId, isInvite: false, isStatic: false };

  // 3. Room-scoped invite tokens
  const invite = await getInviteToken(secret);
  if (invite) {
    return {
      teamId: invite.createdBy,
      allowedRoomId: invite.roomId,
      isInvite: true,
      isStatic: false,
    };
  }

  return null;
}

/** Number of statically configured keys. Used for startup warnings. */
export function getKeyCount(): number {
  if (!keyMap) keyMap = buildKeyMap();
  return keyMap.size;
}
