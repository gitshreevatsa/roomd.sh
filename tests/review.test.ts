import { describe, expect, test, beforeEach } from "bun:test";
import { fakeRedis } from "./fake-redis";
import { assertRoomAccess, getEvents } from "../src/store/redis";
import { requestReview, approve, reject, listReviewsTool } from "../src/mcp/tools/review";
import type { KeyContext } from "../src/types";

beforeEach(() => {
  fakeRedis.flush();
});

const team: KeyContext = { teamId: "t1", isInvite: false, isStatic: true };

describe("review flow", () => {
  test("request then approve", async () => {
    await assertRoomAccess("r", team);
    const review = await requestReview({
      roomId: "r",
      targetType: "task",
      targetId: "task-1",
      requestedBy: "alice",
      reviewer: "bob",
      note: "please check",
    });
    expect(review.status).toBe("pending");

    const approved = await approve({
      roomId: "r",
      reviewId: review.id,
      agentId: "bob",
    });
    expect(approved.status).toBe("approved");

    const events = await getEvents("r", 20);
    expect(events.some((e) => e.type === "review_requested")).toBe(true);
    expect(events.some((e) => e.type === "review_approved")).toBe(true);
  });

  test("wrong reviewer cannot approve", async () => {
    await assertRoomAccess("r", team);
    const review = await requestReview({
      roomId: "r",
      targetType: "context",
      targetId: "c1",
      requestedBy: "alice",
      reviewer: "bob",
    });
    await expect(
      approve({ roomId: "r", reviewId: review.id, agentId: "carol" }),
    ).rejects.toThrow(/Only reviewer/);
  });

  test("reject ends the review", async () => {
    await assertRoomAccess("r", team);
    const review = await requestReview({
      roomId: "r",
      targetType: "task",
      targetId: "t1",
      requestedBy: "alice",
      reviewer: "bob",
    });
    const rejected = await reject({
      roomId: "r",
      reviewId: review.id,
      agentId: "bob",
      note: "needs work",
    });
    expect(rejected.status).toBe("rejected");
    const listed = await listReviewsTool({ roomId: "r", status: "rejected" });
    expect(listed).toHaveLength(1);
  });
});
