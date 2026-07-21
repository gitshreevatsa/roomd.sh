/**
 * Optional Sentry for roomd. No-ops when SENTRY_DSN is unset.
 */

import * as Sentry from "@sentry/bun";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env["SENTRY_DSN"];
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment: process.env["SENTRY_ENVIRONMENT"] ?? process.env["NODE_ENV"] ?? "production",
    tracesSampleRate: Number(process.env["SENTRY_TRACES_SAMPLE_RATE"] ?? "0.1"),
    sendDefaultPii: false,
  });
  initialized = true;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!process.env["SENTRY_DSN"]) return;
  if (context) {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) {
        scope.setExtra(k, v);
      }
      Sentry.captureException(err);
    });
    return;
  }
  Sentry.captureException(err);
}
