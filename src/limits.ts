/**
 * Env-tunable hard caps and rate-limit policy.
 * Defaults are intentionally tight for pre-billing abuse resistance.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

export const MAX_ROOMS_PER_TEAM = envInt("MAX_ROOMS_PER_TEAM", 50);
export const MAX_KEYS_PER_TEAM = envInt("MAX_KEYS_PER_TEAM", 20);
export const MAX_INVITES_PER_ROOM = envInt("MAX_INVITES_PER_ROOM", 20);
export const MAX_WEBHOOKS_PER_TEAM = envInt("MAX_WEBHOOKS_PER_TEAM", 10);
export const MAX_EVENTS_PER_ROOM = envInt("MAX_EVENTS_PER_ROOM", 10_000);
export const MAX_RPC_BATCH = envInt("MAX_RPC_BATCH", 1);
export const RATE_LIMIT_PER_MINUTE = envInt("RATE_LIMIT_PER_MINUTE", 60);
/** When false (default), Redis errors deny the request. */
export const RATE_LIMIT_FAIL_OPEN = envBool("RATE_LIMIT_FAIL_OPEN", false);

export const QUOTA_EXCEEDED = "Quota exceeded";
export const ROOM_LIMIT_EXCEEDED = `Room limit exceeded (max ${MAX_ROOMS_PER_TEAM} per team)`;
export const KEY_LIMIT_EXCEEDED = `Key limit exceeded (max ${MAX_KEYS_PER_TEAM} per team)`;
export const INVITE_LIMIT_EXCEEDED = `Invite limit exceeded (max ${MAX_INVITES_PER_ROOM} per room)`;
export const WEBHOOK_LIMIT_EXCEEDED = `Webhook limit exceeded (max ${MAX_WEBHOOKS_PER_TEAM} per team)`;

/** Lowercase room ids only (matches assertValidRoomId). */
export const ROOM_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
