import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import {
  readPlan,
  addTask,
  updateTask,
  getTask,
  getUnblockedTasks,
  getMyTasks,
  getMySummary,
} from "../src/mcp/tools/plan.js";
import { getEvents } from "../src/store/redis.js";

const roomId = "test-room";

beforeEach(() => fakeRedis.flush());

describe("readPlan", () => {
  test("returns an empty plan for a room that does not exist", async () => {
    const plan = await readPlan({ roomId });
    expect(plan.project).toBe(roomId);
    expect(plan.tasks).toEqual([]);
  });

  test("round-trips a plan through the store", async () => {
    await addTask({ roomId, title: "Build auth", description: "JWT login" });
    const plan = await readPlan({ roomId });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.title).toBe("Build auth");
    expect(plan.tasks[0]!.status).toBe("pending");
    expect(plan.tasks[0]!.owner).toBeNull();
  });
});

describe("addTask", () => {
  test("emits a task_added event so agents do not have to poll the plan", async () => {
    await addTask({ roomId, title: "T", description: "D" });
    const events = await getEvents(roomId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task_added");
    expect(events[0]!.to).toBe("all");
  });

  test("appends rather than replacing", async () => {
    await addTask({ roomId, title: "one", description: "" });
    await addTask({ roomId, title: "two", description: "" });
    const plan = await readPlan({ roomId });
    expect(plan.tasks.map((t) => t.title)).toEqual(["one", "two"]);
  });
});

describe("updateTask", () => {
  test("changes status and owner, and emits task_updated with the previous status", async () => {
    const task = await addTask({ roomId, title: "T", description: "D" });

    const updated = await updateTask({
      roomId,
      taskId: task.id,
      status: "in_progress",
      owner: "backend-claude",
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.owner).toBe("backend-claude");

    const events = await getEvents(roomId, 10);
    const updateEvent = events.find((e) => e.type === "task_updated");
    expect(updateEvent?.payload.previousStatus).toBe("pending");
    expect(updateEvent?.from).toBe("backend-claude");
  });

  test("keeps the existing owner when none is supplied", async () => {
    const task = await addTask({ roomId, title: "T", description: "D" });
    await updateTask({ roomId, taskId: task.id, status: "in_progress", owner: "a" });
    const done = await updateTask({ roomId, taskId: task.id, status: "done" });
    expect(done.owner).toBe("a");
  });

  test("rejects an unknown task id", async () => {
    await expect(
      updateTask({ roomId, taskId: "nope", status: "done" })
    ).rejects.toThrow("Task not found: nope");
  });

  test("releases the plan lock after a failed write", async () => {
    await expect(
      updateTask({ roomId, taskId: "nope", status: "done" })
    ).rejects.toThrow();

    // If the lock leaked, this second write would fail to acquire it.
    const task = await addTask({ roomId, title: "after", description: "" });
    expect(task.title).toBe("after");
  });
});

describe("getTask", () => {
  test("returns one task without reading the whole plan", async () => {
    const created = await addTask({ roomId, title: "find me", description: "" });
    const found = await getTask({ roomId, taskId: created.id });
    expect(found.title).toBe("find me");
  });

  test("throws for an unknown id", async () => {
    await expect(getTask({ roomId, taskId: "missing" })).rejects.toThrow(
      "Task not found: missing"
    );
  });
});

describe("getUnblockedTasks", () => {
  test("returns pending tasks with no dependencies", async () => {
    await addTask({ roomId, title: "free", description: "" });
    const unblocked = await getUnblockedTasks({ roomId });
    expect(unblocked.map((t) => t.title)).toEqual(["free"]);
  });

  test("hides a task whose dependency is not done, and reveals it once it is", async () => {
    const dep = await addTask({ roomId, title: "dep", description: "" });
    await addTask({ roomId, title: "blocked", description: "", depends_on: [dep.id] });

    let unblocked = await getUnblockedTasks({ roomId });
    expect(unblocked.map((t) => t.title)).toEqual(["dep"]);

    await updateTask({ roomId, taskId: dep.id, status: "done" });

    unblocked = await getUnblockedTasks({ roomId });
    expect(unblocked.map((t) => t.title)).toEqual(["blocked"]);
  });

  test("treats a dependency id that is not in the plan as unmet", async () => {
    await addTask({ roomId, title: "orphan", description: "", depends_on: ["ghost"] });
    expect(await getUnblockedTasks({ roomId })).toEqual([]);
  });

  test("excludes tasks that are not pending", async () => {
    const task = await addTask({ roomId, title: "started", description: "" });
    await updateTask({ roomId, taskId: task.id, status: "in_progress", owner: "a" });
    expect(await getUnblockedTasks({ roomId })).toEqual([]);
  });

  test("filtering by agent hides work owned by someone else but keeps unowned work", async () => {
    const mine = await addTask({ roomId, title: "mine", description: "" });
    const theirs = await addTask({ roomId, title: "theirs", description: "" });
    await addTask({ roomId, title: "unowned", description: "" });

    // updateTask is the only way to set an owner, so park them as pending.
    await updateTask({ roomId, taskId: mine.id, status: "pending", owner: "me" });
    await updateTask({ roomId, taskId: theirs.id, status: "pending", owner: "you" });

    const unblocked = await getUnblockedTasks({ roomId, agentId: "me" });
    expect(unblocked.map((t) => t.title).sort()).toEqual(["mine", "unowned"]);
  });
});

describe("getMyTasks", () => {
  test("returns only the caller's tasks", async () => {
    const a = await addTask({ roomId, title: "a", description: "" });
    await addTask({ roomId, title: "b", description: "" });
    await updateTask({ roomId, taskId: a.id, status: "in_progress", owner: "me" });

    const mine = await getMyTasks({ roomId, agentId: "me" });
    expect(mine.map((t) => t.title)).toEqual(["a"]);
  });
});

describe("getMySummary", () => {
  test("first call returns all events, second call returns only what is new", async () => {
    await addTask({ roomId, title: "one", description: "" });

    const first = await getMySummary({ roomId, agentId: "agent-1" });
    expect(first.unreadEvents.length).toBe(1);

    const second = await getMySummary({ roomId, agentId: "agent-1" });
    expect(second.unreadEvents).toEqual([]);
  });

  test("cursors are per agent", async () => {
    await addTask({ roomId, title: "one", description: "" });
    await getMySummary({ roomId, agentId: "agent-1" });

    const other = await getMySummary({ roomId, agentId: "agent-2" });
    expect(other.unreadEvents.length).toBe(1);
  });

  test("reports the caller's own tasks and the room's presence", async () => {
    const task = await addTask({ roomId, title: "mine", description: "" });
    await updateTask({ roomId, taskId: task.id, status: "in_progress", owner: "agent-1" });

    const summary = await getMySummary({ roomId, agentId: "agent-1" });
    expect(summary.myTasks.map((t) => t.title)).toEqual(["mine"]);
    expect(summary.agentId).toBe("agent-1");
  });
});
