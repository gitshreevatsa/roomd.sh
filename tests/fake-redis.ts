/**
 * In-memory stand-in for @upstash/redis.
 *
 * Only the commands the store layer actually calls are implemented, with the
 * same return conventions Upstash uses: SET NX returns "OK" or null, GET on a
 * missing key returns null, EXISTS returns a count.
 *
 * TTLs are tracked as absolute expiry timestamps and honoured lazily on read,
 * so a test can expire a key by moving the clock rather than by sleeping.
 */

type Value = string | number | string[] | Set<string> | Map<string, string>;

interface Entry {
  value: Value;
  expiresAt: number | null;
}

export interface SetOptions {
  nx?: boolean;
  ex?: number;
  px?: number;
}

export class FakeRedis {
  private store = new Map<string, Entry>();

  /** Overridable clock so tests can expire keys without waiting. */
  now: () => number = () => Date.now();

  // -- helpers -------------------------------------------------------------

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private setEntry(key: string, value: Value, opts?: SetOptions): void {
    let expiresAt: number | null = null;
    if (opts?.ex !== undefined) expiresAt = this.now() + opts.ex * 1000;
    if (opts?.px !== undefined) expiresAt = this.now() + opts.px;
    this.store.set(key, { value, expiresAt });
  }

  /** Test helper: how many keys are currently live. */
  size(): number {
    let count = 0;
    for (const key of [...this.store.keys()]) if (this.live(key)) count += 1;
    return count;
  }

  /** Test helper: remaining ttl in seconds, or null when the key never expires. */
  ttl(key: string): number | null {
    const entry = this.live(key);
    if (!entry || entry.expiresAt === null) return null;
    return Math.round((entry.expiresAt - this.now()) / 1000);
  }

  /** Test helper: every live key, for asserting nothing sensitive was stored. */
  keys(): string[] {
    return [...this.store.keys()].filter((k) => this.live(k));
  }

  /** Test helper: raw serialised values, for asserting no plaintext secrets. */
  dump(): string {
    return JSON.stringify([...this.store.entries()], (_k, v) => {
      if (v instanceof Set) return [...v];
      if (v instanceof Map) return Object.fromEntries(v);
      return v as unknown;
    });
  }

  // -- string commands -----------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get<T = any>(key: string): Promise<T | null> {
    const entry = this.live(key);
    if (!entry) return null;
    const raw = entry.value;
    if (typeof raw !== "string") return raw as unknown as T;
    // Upstash parses JSON payloads back into objects on read.
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set(key: string, value: string, opts?: SetOptions): Promise<"OK" | null> {
    if (opts?.nx && this.live(key)) return null;
    this.setEntry(key, value, opts);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.live(k) !== undefined).length;
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = (typeof entry?.value === "number" ? entry.value : 0) + 1;
    this.store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }

  // -- set commands --------------------------------------------------------

  async sadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.live(key);
    const set = entry?.value instanceof Set ? entry.value : new Set<string>();
    if (!entry) this.store.set(key, { value: set, expiresAt: null });
    let added = 0;
    for (const m of members) if (!set.has(m)) { set.add(m); added += 1; }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.live(key);
    if (!(entry?.value instanceof Set)) return 0;
    let removed = 0;
    for (const m of members) if (entry.value.delete(m)) removed += 1;
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.live(key);
    return entry?.value instanceof Set ? [...entry.value] : [];
  }

  // -- list commands -------------------------------------------------------

  async lpush(key: string, ...values: string[]): Promise<number> {
    const entry = this.live(key);
    const list = Array.isArray(entry?.value) ? (entry.value as unknown as string[]) : [];
    if (!entry) this.store.set(key, { value: list as unknown as Value, expiresAt: null });
    list.unshift(...values);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.live(key);
    const list = Array.isArray(entry?.value) ? (entry.value as unknown as string[]) : [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    const entry = this.live(key);
    const list = Array.isArray(entry?.value) ? (entry.value as unknown as string[]) : [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    const trimmed = list.slice(start, end);
    this.store.set(key, { value: trimmed as unknown as Value, expiresAt: entry?.expiresAt ?? null });
    return "OK";
  }

  async llen(key: string): Promise<number> {
    const entry = this.live(key);
    return Array.isArray(entry?.value) ? entry.value.length : 0;
  }

  async rename(oldKey: string, newKey: string): Promise<"OK"> {
    const entry = this.live(oldKey);
    if (!entry) throw new Error("ERR no such key");
    this.store.delete(oldKey);
    this.store.set(newKey, { value: entry.value, expiresAt: entry.expiresAt });
    return "OK";
  }

  // -- hash commands -------------------------------------------------------

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    const entry = this.live(key);
    const map = entry?.value instanceof Map ? entry.value : new Map<string, string>();
    if (!entry) this.store.set(key, { value: map, expiresAt: null });
    for (const [k, v] of Object.entries(fields)) map.set(k, v);
    return Object.keys(fields).length;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async hget<T = any>(key: string, field: string): Promise<T | null> {
    const entry = this.live(key);
    if (!(entry?.value instanceof Map)) return null;
    return (entry.value.get(field) ?? null) as T | null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async hgetall<T = any>(key: string): Promise<T | null> {
    const entry = this.live(key);
    if (!(entry?.value instanceof Map)) return null;
    return Object.fromEntries(entry.value) as T;
  }

  // -- pipeline ------------------------------------------------------------

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const self = this;
    return {
      expire(key: string, seconds: number) {
        ops.push(() => self.expire(key, seconds));
        return this;
      },
      async exec() {
        const results = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
  }

  /** Reset between tests. */
  flush(): void {
    this.store.clear();
  }
}

export const fakeRedis = new FakeRedis();
