/**
 * Structured JSON logging to stdout/stderr.
 * One object per line for Railway / log drains.
 * Errors are also forwarded to Sentry when SENTRY_DSN is set.
 */

import { captureException } from "./sentry.js";

type Level = "info" | "warn" | "error";

function write(level: Level, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    service: "roomd",
    ...fields,
  });
  if (level === "error") {
    process.stderr.write(line + "\n");
    const err = fields["err"] ?? fields["detail"] ?? fields["msg"];
    if (err !== undefined) {
      captureException(typeof err === "string" ? new Error(err) : err, {
        msg: fields["msg"],
      });
    }
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  info: (fields: Record<string, unknown>) => write("info", fields),
  warn: (fields: Record<string, unknown>) => write("warn", fields),
  error: (fields: Record<string, unknown>) => write("error", fields),
};
