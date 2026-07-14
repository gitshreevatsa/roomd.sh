import { mock } from "bun:test";
import { fakeRedis } from "./fake-redis";

/**
 * Preloaded by bunfig.toml before any test file runs, so the store layer's
 * module-level `new Redis(...)` picks up the in-memory fake instead of opening
 * a connection to Upstash. Tests exercise the real store and tool code.
 */
mock.module("@upstash/redis", () => ({
  Redis: function Redis() {
    return fakeRedis;
  },
}));
