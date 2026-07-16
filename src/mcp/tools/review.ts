import { z } from "zod";
import { nanoid } from "nanoid";
import type { Event } from "../../types.js";
import {
  getReview,
  setReview,
  listReviews,
  pushEvent,
  type StoredReview,
} from "../../store/redis.js";

export type ReviewRecord = StoredReview;

export const requestReviewInput = z.object({
  roomId: z.string().min(1),
  targetType: z.enum(["task", "context"]),
  targetId: z.string().min(1),
  requestedBy: z.string().min(1),
  reviewer: z.string().min(1),
  note: z.string().optional(),
});

export async function requestReview(
  input: z.infer<typeof requestReviewInput>,
): Promise<ReviewRecord> {
  const now = new Date().toISOString();
  const review: ReviewRecord = {
    id: nanoid(),
    roomId: input.roomId,
    targetType: input.targetType,
    targetId: input.targetId,
    requestedBy: input.requestedBy,
    reviewer: input.reviewer,
    status: "pending",
    note: input.note,
    createdAt: now,
  };
  await setReview(input.roomId, review);

  await pushEvent(input.roomId, {
    id: nanoid(),
    type: "review_requested",
    from: input.requestedBy,
    to: input.reviewer,
    payload: { review },
    timestamp: now,
    read_by: [],
  } satisfies Event);

  return review;
}

export const approveInput = z.object({
  roomId: z.string().min(1),
  reviewId: z.string().min(1),
  agentId: z.string().min(1),
  note: z.string().optional(),
});

export async function approve(
  input: z.infer<typeof approveInput>,
): Promise<ReviewRecord> {
  return resolveReview(input.roomId, input.reviewId, input.agentId, "approved", input.note);
}

export const rejectInput = z.object({
  roomId: z.string().min(1),
  reviewId: z.string().min(1),
  agentId: z.string().min(1),
  note: z.string().optional(),
});

export async function reject(
  input: z.infer<typeof rejectInput>,
): Promise<ReviewRecord> {
  return resolveReview(input.roomId, input.reviewId, input.agentId, "rejected", input.note);
}

async function resolveReview(
  roomId: string,
  reviewId: string,
  agentId: string,
  status: "approved" | "rejected",
  note?: string,
): Promise<ReviewRecord> {
  const existing = await getReview(roomId, reviewId);
  if (!existing) throw new Error(`Review not found: ${reviewId}`);
  if (existing.status !== "pending") {
    throw new Error(`Review already ${existing.status}`);
  }
  if (existing.reviewer !== agentId) {
    throw new Error(`Only reviewer ${existing.reviewer} may resolve this review`);
  }

  const now = new Date().toISOString();
  const updated: ReviewRecord = {
    ...existing,
    status,
    resolvedAt: now,
    resolvedBy: agentId,
    note: note ?? existing.note,
  };
  await setReview(roomId, updated);

  await pushEvent(roomId, {
    id: nanoid(),
    type: status === "approved" ? "review_approved" : "review_rejected",
    from: agentId,
    to: existing.requestedBy,
    payload: { review: updated },
    timestamp: now,
    read_by: [],
  } satisfies Event);

  return updated;
}

export const listReviewsInput = z.object({
  roomId: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

export async function listReviewsTool(
  input: z.infer<typeof listReviewsInput>,
): Promise<ReviewRecord[]> {
  const all = await listReviews(input.roomId);
  if (!input.status) return all;
  return all.filter((r) => r.status === input.status);
}
