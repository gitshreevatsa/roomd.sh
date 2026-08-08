import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess } from "../src/store/redis";
import { writeContext, updateContext } from "../src/mcp/tools/context";
import { diffContext } from "../src/mcp/tools/diff";
import { getRoomAnalytics } from "../src/mcp/tools/analytics";
import { listTemplates, createRoomFromTemplate } from "../src/mcp/tools/templates";
import { addTask, updateTask } from "../src/mcp/tools/plan";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
});

const team: KeyContext = { teamId: "t1", isInvite: false, isStatic: true, isOperator: false };

describe("diff_context", () => {
  test("diffs current against previous history", async () => {
    await assertRoomAccess("rm", team);
    const entry = await writeContext({
      roomId: "rm",
      type: "note",
      author: "a1",
      summary: "old",
      consuming_agents: [],
      payload: { text: "a" },
    });
    await updateContext({
      roomId: "rm",
      id: entry.id,
      author: "a1",
      summary: "new",
      payload: { text: "b" },
    });
    const result = await diffContext({ roomId: "rm", id: entry.id });
    expect(result.diff.summaryChanged).toBe(true);
    expect(result.diff.payload.changed).toContain("text");
  });
});

describe("get_room_analytics", () => {
  test("reports completion rate", async () => {
    await assertRoomAccess("rm", team);
    const t = await addTask({ roomId: "rm", title: "A", description: "d" });
    await updateTask({ roomId: "rm", taskId: t.id, status: "done" });
    const a = await getRoomAnalytics({ roomId: "rm" });
    expect(a.tasks.total).toBe(1);
    expect(a.tasks.done).toBe(1);
    expect(a.tasks.completionRate).toBe(1);
  });
});

describe("templates", () => {
  test("lists built-in templates", async () => {
    const { templates } = await listTemplates({});
    expect(templates.some((t) => t.id === "web-app")).toBe(true);
  });

  test("create_room_from_template seeds tasks", async () => {
    const result = await createRoomFromTemplate(
      { templateId: "web-app" },
      team,
    );
    expect(result.taskCount).toBeGreaterThan(0);
    const analytics = await getRoomAnalytics({ roomId: result.roomId });
    expect(analytics.tasks.total).toBe(result.taskCount);
  });
});
