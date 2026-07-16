/**
 * Structured JSON logging to stdout/stderr.
 * One object per line for Railway / log drains.
 */

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
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  info: (fields: Record<string, unknown>) => write("info", fields),
  warn: (fields: Record<string, unknown>) => write("warn", fields),
  error: (fields: Record<string, unknown>) => write("error", fields),
};
