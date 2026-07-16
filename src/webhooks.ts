import { createHmac, randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Event } from "./types.js";
import { log } from "./log.js";

const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  roomId?: string;
  createdAt: string;
}

function key(teamId: string) {
  return `team:${teamId}:webhooks`;
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
  hook: Omit<Webhook, "id" | "createdAt"> & { id?: string },
): Promise<Webhook> {
  const hooks = await listWebhooks(teamId);
  const full: Webhook = {
    id: hook.id ?? cryptoRandomId(),
    url: hook.url,
    secret: hook.secret,
    roomId: hook.roomId,
    createdAt: new Date().toISOString(),
  };
  hooks.push(full);
  await saveWebhooks(teamId, hooks);
  return full;
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
        const body = JSON.stringify({ roomId, event });
        const sig = createHmac("sha256", h.secret).update(body).digest("hex");
        try {
          const res = await fetch(h.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Roomd-Signature": sig,
            },
            body,
          });
          if (!res.ok) {
            log.warn({ msg: "webhook.http", status: res.status, url: h.url });
          }
        } catch (err) {
          log.warn({ msg: "webhook.fail", url: h.url, err: String(err) });
        }
      }),
    );
  } catch (err) {
    log.warn({ msg: "webhook.dispatch", err: String(err) });
  }
}
