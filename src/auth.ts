/**
 * Multi-tenant API key resolution.
 *
 * resolveKey() checks sources in order:
 *   1. Operator keys     (OPERATOR_KEYS, or legacy sole ROOMD_SECRET)
 *   2. Static team keys  (API_KEYS)
 *   3. Dynamic Redis keys
 *   4. Room invite tokens
 *
 * Returns a KeyContext describing the caller's identity and access scope,
 * or null if the secret is not recognised.
 */

import { timingSafeEqual } from "node:crypto";
import type { KeyContext } from "./types.js";
import { getDynamicKey, getInviteToken, hashSecret } from "./store/redis.js";
import { log } from "./log.js";

export type { KeyContext };

/** Maps sha256(secret) → teamId for static team keys. */
let teamKeyMap: Map<string, string> | null = null;
/** Maps sha256(secret) → teamId for operator keys. */
let operatorKeyMap: Map<string, string> | null = null;

function parseKeyPairs(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const teamId = pair.slice(0, idx).trim();
    const secret = pair.slice(idx + 1).trim();
    if (teamId && secret) map.set(hashSecret(secret), teamId);
  }
  return map;
}

function buildMaps(): void {
  teamKeyMap = parseKeyPairs(process.env["API_KEYS"] ?? "");
  operatorKeyMap = parseKeyPairs(process.env["OPERATOR_KEYS"] ?? "");

  // Legacy: sole ROOMD_SECRET is the operator for the "default" team.
  if (operatorKeyMap.size === 0) {
    const legacy = process.env["ROOMD_SECRET"] ?? "";
    if (legacy) {
      operatorKeyMap.set(hashSecret(legacy), "default");
    } else if (teamKeyMap.size === 1) {
      // Single-tenant: the only API_KEYS entry is the operator.
      for (const [digest, teamId] of teamKeyMap) {
        operatorKeyMap.set(digest, teamId);
      }
    }
  }

  // Backward compat: ROOMD_SECRET also resolves as the default team key.
  if (teamKeyMap.size === 0) {
    const legacy = process.env["ROOMD_SECRET"] ?? "";
    if (legacy) teamKeyMap.set(hashSecret(legacy), "default");
  }

  if (teamKeyMap.size > 1 && !(process.env["OPERATOR_KEYS"] ?? "").trim()) {
    log.warn({
      msg: "auth.operator",
      detail:
        "Multiple API_KEYS without OPERATOR_KEYS. Static team keys are not operators. Set OPERATOR_KEYS=operator:<master-secret> for provisioning.",
    });
  }
}

/** Rebuild the cached key maps. Only needed by tests that mutate the env. */
export function resetKeyMap(): void {
  teamKeyMap = null;
  operatorKeyMap = null;
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

function matchMap(
  map: Map<string, string>,
  digest: string,
): string | undefined {
  let found: string | undefined;
  for (const [candidate, teamId] of map) {
    if (digestsMatch(candidate, digest)) found = teamId;
  }
  return found;
}

/** Resolve a Bearer secret to a KeyContext, or null if unrecognised. */
export async function resolveKey(secret: string): Promise<KeyContext | null> {
  if (!teamKeyMap || !operatorKeyMap) buildMaps();
  if (!secret) return null;

  const digest = hashSecret(secret);

  // 1. Operator keys (constant-time scan)
  const operatorTeam = matchMap(operatorKeyMap!, digest);
  if (operatorTeam) {
    return {
      teamId: operatorTeam,
      isInvite: false,
      isStatic: true,
      isOperator: true,
    };
  }

  // 2. Static team keys — never operators
  const staticTeam = matchMap(teamKeyMap!, digest);
  if (staticTeam) {
    return {
      teamId: staticTeam,
      isInvite: false,
      isStatic: true,
      isOperator: false,
    };
  }

  // 3. Dynamic Redis team keys
  const dynKey = await getDynamicKey(secret);
  if (dynKey) {
    const bound = dynKey.boundAgentId;
    return {
      teamId: dynKey.teamId,
      isInvite: false,
      isStatic: false,
      isOperator: false,
      ...(bound ? { agentId: bound, boundAgentId: bound } : {}),
    };
  }

  // 4. Room-scoped invite tokens
  const invite = await getInviteToken(secret);
  if (invite) {
    const bound = `invite:${invite.tokenId}`;
    return {
      teamId: invite.createdBy,
      allowedRoomId: invite.roomId,
      isInvite: true,
      isStatic: false,
      isOperator: false,
      agentId: bound,
      boundAgentId: bound,
    };
  }

  return null;
}

/** Number of statically configured team + operator keys. Used for startup warnings. */
export function getKeyCount(): number {
  if (!teamKeyMap || !operatorKeyMap) buildMaps();
  const digests = new Set([...teamKeyMap!.keys(), ...operatorKeyMap!.keys()]);
  return digests.size;
}

/** Number of operator keys. */
export function getOperatorKeyCount(): number {
  if (!operatorKeyMap) buildMaps();
  return operatorKeyMap!.size;
}
