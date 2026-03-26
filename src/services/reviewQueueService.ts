/**
 * Review Queue Service
 *
 * Manages the human review queue for documents that need
 * manual attention due to low confidence, missing data,
 * duplicate flags, or processing failures.
 */

import type { ArchiveDocument, ReviewMetadata } from "@/types/document";
import { getAllDocuments, updateDocument } from "./documentStore";

/**
 * Get all documents that require review.
 * Sorted by priority (high → medium → low).
 */
export function getReviewQueue(): ArchiveDocument[] {
  const docs = getAllDocuments().filter(
    (doc) => doc.review?.required === true && !doc.review?.resolution
  );

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return docs.sort((a, b) => {
    const pa = priorityOrder[a.review?.priority ?? "low"] ?? 2;
    const pb = priorityOrder[b.review?.priority ?? "low"] ?? 2;
    return pa - pb;
  });
}

/**
 * Get review queue counts by priority.
 */
export function getReviewQueueCounts(): { total: number; high: number; medium: number; low: number } {
  const queue = getReviewQueue();
  return {
    total: queue.length,
    high: queue.filter((d) => d.review?.priority === "high").length,
    medium: queue.filter((d) => d.review?.priority === "medium").length,
    low: queue.filter((d) => d.review?.priority === "low").length,
  };
}

/**
 * Mark a document for review with specified reasons.
 */
export function markForReview(
  docId: string,
  reasons: string[],
  priority: ReviewMetadata["priority"] = "medium"
): void {
  const allDocs = getAllDocuments();
  const doc = allDocs.find((d) => d.id === docId);
  if (!doc) return;

  const existingReasons = doc.review?.reason ?? [];
  const mergedReasons = [...new Set([...existingReasons, ...reasons])];

  updateDocument(docId, {
    review: {
      ...doc.review,
      required: true,
      reason: mergedReasons,
      priority,
    },
    needsReview: true,
  });
}

/**
 * Assign a review to a specific user.
 */
export function assignReview(docId: string, user: string): void {
  const doc = getAllDocuments().find((d) => d.id === docId);
  if (!doc) return;

  updateDocument(docId, {
    review: {
      ...doc.review,
      required: doc.review?.required ?? true,
      assignedTo: user,
    },
  });
}

/**
 * Resolve a review with a decision.
 */
export function resolveReview(
  docId: string,
  resolution: ReviewMetadata["resolution"],
  notes?: string,
  reviewedBy?: string
): void {
  const doc = getAllDocuments().find((d) => d.id === docId);
  if (!doc) return;

  updateDocument(docId, {
    review: {
      ...doc.review,
      required: false,
      resolution,
      notes,
      reviewedBy: reviewedBy ?? "staff",
      reviewedAt: new Date().toISOString(),
    },
    needsReview: false,
    processingStatus: resolution === "rejected" ? "failed" : doc.processingStatus,
    status: resolution === "approved" || resolution === "corrected" ? "archived" : doc.status,
  });
}
