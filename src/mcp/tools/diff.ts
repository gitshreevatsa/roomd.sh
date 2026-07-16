import { z } from "zod";
import type { ContextEntry } from "../../types.js";
import { getContext, getContextHistory } from "../../store/redis.js";

export const diffContextInput = z.object({
  roomId: z.string().min(1),
  id: z.string().min(1),
  /** Compare against this version string (e.g. "1.0"). Defaults to previous history entry. */
  againstVersion: z.string().optional(),
});

function summarizeDiff(a: ContextEntry, b: ContextEntry) {
  const summaryChanged = a.summary !== b.summary;
  const aKeys = new Set(Object.keys(a.payload));
  const bKeys = new Set(Object.keys(b.payload));
  const added = [...bKeys].filter((k) => !aKeys.has(k));
  const removed = [...aKeys].filter((k) => !bKeys.has(k));
  const changed = [...aKeys].filter(
    (k) => bKeys.has(k) && JSON.stringify(a.payload[k]) !== JSON.stringify(b.payload[k]),
  );
  return {
    summaryChanged,
    fromSummary: a.summary,
    toSummary: b.summary,
    payload: { added, removed, changed },
    fromVersion: a.version,
    toVersion: b.version,
  };
}

/**
 * Diff the current context entry against a prior version from history.
 */
export async function diffContext(
  input: z.infer<typeof diffContextInput>,
): Promise<{
  id: string;
  current: ContextEntry;
  previous: ContextEntry;
  diff: ReturnType<typeof summarizeDiff>;
}> {
  const current = await getContext(input.roomId, input.id);
  if (!current) throw new Error(`ContextEntry not found: ${input.id}`);

  const history = await getContextHistory(input.roomId, input.id);
  if (!history.length) {
    throw new Error("No prior versions to diff against");
  }

  let previous: ContextEntry | undefined;
  if (input.againstVersion) {
    previous = history.find((h) => h.version === input.againstVersion);
    if (!previous) {
      throw new Error(`Version not found in history: ${input.againstVersion}`);
    }
  } else {
    previous = history[0];
  }

  return {
    id: input.id,
    current,
    previous: previous!,
    diff: summarizeDiff(previous!, current),
  };
}
