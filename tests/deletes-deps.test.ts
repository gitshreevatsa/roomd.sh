import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess, getEvents, getContext } from "../src/store/redis";
import { addTask, deleteTask, setTaskPriority, addDependency, getTask, readPlan } from "../src/mcp/tools/plan";
import { writeContext, deleteContext, readContext } from "../src/mcp/tools/context";
import { postEvent, deleteEvent, readEvents } from "../src/mcp/tools/events";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
  fakeRedis.now = () => Date.now();
});

const team: KeyContext = { teamId: "t1", isInvite: false, isStatic: true, isOperator: false };

describe("delete_task / priority / dependency", () => {
  test("delete_task removes the task and emits task_deleted", async () => {
    await assertRoomAccess("rm", team);
    const task = await addTask({ roomId: "rm", title: "A", description: "d" });
    await deleteTask({ roomId: "rm", taskId: task.id, agentId: "a1" });
    const plan = await readPlan({ roomId: "rm" });
    expect(plan.tasks).toHaveLength(0);
    const events = await getEvents("rm", 20);
    expect(events.some((e) => e.type === "task_deleted")).toBe(true);
  });

  test("set_task_priority and add_dependency update the task", async () => {
    await assertRoomAccess("rm", team);
    const a = await addTask({ roomId: "rm", title: "A", description: "d" });
    const b = await addTask({ roomId: "rm", title: "B", description: "d" });
    await setTaskPriority({ roomId: "rm", taskId: b.id, priority: 1 });
    await addDependency({ roomId: "rm", taskId: b.id, dependsOn: a.id });
    const task = await getTask({ roomId: "rm", taskId: b.id });
    expect(task.priority).toBe(1);
    expect(task.depends_on).toEqual([a.id]);
  });
});

describe("delete_context / delete_event", () => {
  test("delete_context removes the entry", async () => {
    await assertRoomAccess("rm", team);
    const entry = await writeContext({
      roomId: "rm",
      type: "note",
      author: "a1",
      summary: "s",
      consuming_agents: [],
      payload: { text: "hello" },
    });
    await deleteContext({ roomId: "rm", id: entry.id });
    await expect(readContext({ roomId: "rm", id: entry.id })).rejects.toThrow(/not found/);
    expect(await getContext("rm", entry.id)).toBeNull();
  });

  test("delete_event removes the target but keeps a deletion notice", async () => {
    await assertRoomAccess("rm", team);
    const e1 = await postEvent({
      roomId: "rm",
      type: "ping",
      from: "a1",
      to: "all",
      payload: { n: 1 },
    });
    await postEvent({
      roomId: "rm",
      type: "ping",
      from: "a1",
      to: "all",
      payload: { n: 2 },
    });
    await deleteEvent({ roomId: "rm", eventId: e1.id });
    const remaining = await readEvents({ roomId: "rm", limit: 50 });
    expect(remaining.some((e) => e.id === e1.id)).toBe(false);
    expect(remaining.some((e) => e.type === "event_deleted")).toBe(true);
  });
});
