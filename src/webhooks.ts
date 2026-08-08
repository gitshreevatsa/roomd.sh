import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Event } from "./types.js";
import { log } from "./log.js";
import { assertSafeWebhookUrl } from "./ssrf.js";
import { MAX_WEBHOOKS_PER_TEAM, WEBHOOK_LIMIT_EXCEEDED } from "./limits.js";

const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});

export interface Webhook {
  id: string;
  url: string;
  /** AES-GCM ciphertext (`enc:…`) or legacy plaintext. Never return in list APIs. */
  secret: string;
  roomId?: string;
  createdAt: string;
}

function key(teamId: string) {
  return `team:${teamId}:webhooks`;
}

/** Derive a 32-byte AES key from WEBHOOK_SECRET_KEY or ROOMD_SECRET. */
function webhookCryptoKey(): Buffer {
  const material =
    process.env["WEBHOOK_SECRET_KEY"] ??
    process.env["ROOMD_SECRET"] ??
    process.env["OPERATOR_KEYS"] ??
    "roomd-webhook-dev-key";
  return createHash("sha256").update(material).digest();
}

/** Encrypt a webhook signing secret at rest. */
export function encryptWebhookSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", webhookCryptoKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt a stored secret. Legacy plaintext values pass through. */
export function decryptWebhookSecret(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) throw new Error("Invalid encrypted webhook secret");
  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    webhookCryptoKey(),
    Buffer.from(ivHex!, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex!, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function webhookSecretHint(stored: string): string {
  try {
    const plain = decryptWebhookSecret(stored);
    return `****${plain.slice(-4)}`;
  } catch {
    return "****????";
  }
}

export async function listWebhooks(teamId: string): Promise<Webhook[]> {
  const raw = await redis.get<string | Webhook[]>(key(teamId));
  if (!raw) return [];
  return typeof raw === "string" ? (JSON.parse(raw) as Webhook[]) : raw;
}

export async function saveWebhooks(teamId: string, hooks: Webhook[]): Promise<void> {
  await redis.set(key(teamId), JSON.stringify(hooks));
}

export async function addWebhook(
  teamId: string,
  hook: Omit<Webhook, "id" | "createdAt" | "secret"> & {
    id?: string;
    /** Plaintext signing secret; encrypted before persistence. */
    secret: string;
  },
): Promise<Webhook & { plaintextSecret: string }> {
  const hooks = await listWebhooks(teamId);
  if (hooks.length >= MAX_WEBHOOKS_PER_TEAM) {
    throw new Error(WEBHOOK_LIMIT_EXCEEDED);
  }
  const plaintextSecret = hook.secret;
  const full: Webhook = {
    id: hook.id ?? cryptoRandomId(),
    url: hook.url,
    secret: encryptWebhookSecret(plaintextSecret),
    roomId: hook.roomId,
    createdAt: new Date().toISOString(),
  };
  hooks.push(full);
  await saveWebhooks(teamId, hooks);
  return { ...full, plaintextSecret };
}

export async function removeWebhook(teamId: string, webhookId: string): Promise<boolean> {
  const hooks = await listWebhooks(teamId);
  const next = hooks.filter((h) => h.id !== webhookId);
  if (next.length === hooks.length) return false;
  await saveWebhooks(teamId, next);
  return true;
}

function cryptoRandomId(): string {
  return randomBytes(8).toString("hex");
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Sign webhook body as `${timestamp}.${nonce}.${body}` (HMAC-SHA256).
 * Receivers should reject timestamps older than ~5 minutes to limit replay.
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
}

/** Fire-and-forget HTTPS POSTs; never throws to callers. */
export async function dispatchWebhooks(
  teamId: string,
  roomId: string,
  event: Event,
): Promise<void> {
  try {
    const hooks = await listWebhooks(teamId);
    const targets = hooks.filter((h) => !h.roomId || h.roomId === roomId);
    await Promise.all(
      targets.map(async (h) => {
        try {
          await assertSafeWebhookUrl(h.url);
        } catch (err) {
          log.warn({
            msg: "webhook.ssrf_block",
            webhookId: h.id,
            err: String(err),
          });
          return;
        }
        let signingSecret: string;
        try {
          signingSecret = decryptWebhookSecret(h.secret);
        } catch (err) {
          log.warn({ msg: "webhook.decrypt", webhookId: h.id, err: String(err) });
          return;
        }
        const body = JSON.stringify({ roomId, event });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(16).toString("hex");
        const sig = signWebhookPayload(signingSecret, timestamp, nonce, body);
        try {
          const res = await fetch(h.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Roomd-Signature": sig,
              "X-Roomd-Timestamp": timestamp,
              "X-Roomd-Nonce": nonce,
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          if (!res.ok) {
            log.warn({ msg: "webhook.http", status: res.status, webhookId: h.id });
          }
        } catch (err) {
          log.warn({ msg: "webhook.fail", webhookId: h.id, err: String(err) });
        }
      }),
    );
  } catch (err) {
    log.warn({ msg: "webhook.dispatch", err: String(err) });
  }
}
