import type { Event } from "./types.js";
import { log } from "./log.js";

/**
 * Best-effort MCP session registry for server-initiated notifications.
 * Streamable HTTP sessions that stay open can be notified when events land.
 * If no session is registered, webhooks / SSE stream remain the push path.
 */

type Sender = (payload: unknown) => Promise<void>;

const sessions = new Map<string, Set<Sender>>();

export function registerSession(roomId: string, send: Sender): () => void {
  let set = sessions.get(roomId);
  if (!set) {
    set = new Set();
    sessions.set(roomId, set);
  }
  set.add(send);
  return () => {
    set!.delete(send);
    if (set!.size === 0) sessions.delete(roomId);
  };
}

export async function notifyRoomEvent(roomId: string, event: Event): Promise<void> {
  const set = sessions.get(roomId);
  if (!set || set.size === 0) return;
  const payload = {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      level: "info",
      data: { roomId, event },
    },
  };
  await Promise.all(
    [...set].map(async (send) => {
      try {
        await send(payload);
      } catch (err) {
        log.warn({ msg: "notify.session", err: String(err) });
      }
    }),
  );
}
