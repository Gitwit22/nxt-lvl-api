import { describe, it, expect, beforeEach } from "vitest";
import {
  getReviewQueue,
  getReviewQueueCounts,
  markForReview,
  resolveReview,
  assignReview,
} from "@/services/reviewQueueService";
import { addDocument, getDocumentById, resetStore } from "@/services/documentStore";
import type { ArchiveDocument } from "@/types/document";

/** Helper to create a minimal ArchiveDocument for testing */
function makeDoc(overrides: Partial<ArchiveDocument> = {}): ArchiveDocument {
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random()}`,
    title: "Test Document",
    description: "A test document",
    author: "Test Author",
    year: 2024,
    category: "Research",
    type: "Report",
    tags: ["test"],
    keywords: ["testing"],
    fileUrl: "#",
    processingStatus: "processed",
    ocrStatus: "not_needed",
    extractedText: "Test text.",
    extractedMetadata: { wordCount: 2 },
    intakeSource: "file_upload",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    importedAt: "2024-01-01T00:00:00.000Z",
    processingHistory: [],
    needsReview: false,
    aiSummary: "",
    ...overrides,
  };
}

describe("reviewQueueService", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("getReviewQueue", () => {
    it("returns empty queue when no documents need review", () => {
      const queue = getReviewQueue();
      // Legacy seed docs don't have review metadata, so queue should be empty
      expect(queue.length).toBe(0);
    });

    it("returns documents that need review", () => {
      const doc = makeDoc({
        id: "review-1",
        review: { required: true, reason: ["Low confidence"], priority: "high" },
      });
      addDocument(doc);

      const queue = getReviewQueue();
      expect(queue.length).toBe(1);
      expect(queue[0].id).toBe("review-1");
    });

    it("sorts by priority (high first)", () => {
      addDocument(makeDoc({
        id: "low-pri",
        review: { required: true, reason: ["Minor issue"], priority: "low" },
      }));
      addDocument(makeDoc({
        id: "high-pri",
        review: { required: true, reason: ["Critical issue"], priority: "high" },
      }));
      addDocument(makeDoc({
        id: "med-pri",
        review: { required: true, reason: ["Moderate issue"], priority: "medium" },
      }));

      const queue = getReviewQueue();
      expect(queue[0].id).toBe("high-pri");
      expect(queue[1].id).toBe("med-pri");
      expect(queue[2].id).toBe("low-pri");
    });

    it("excludes resolved reviews", () => {
      addDocument(makeDoc({
        id: "resolved",
        review: { required: true, reason: ["Fixed"], priority: "low", resolution: "approved" },
      }));

      const queue = getReviewQueue();
      expect(queue.find((d) => d.id === "resolved")).toBeUndefined();
    });
  });

  describe("getReviewQueueCounts", () => {
    it("returns correct counts by priority", () => {
      addDocument(makeDoc({
        id: "high-1",
        review: { required: true, reason: ["X"], priority: "high" },
      }));
      addDocument(makeDoc({
        id: "med-1",
        review: { required: true, reason: ["Y"], priority: "medium" },
      }));
      addDocument(makeDoc({
        id: "med-2",
        review: { required: true, reason: ["Z"], priority: "medium" },
      }));

      const counts = getReviewQueueCounts();
      expect(counts.total).toBe(3);
      expect(counts.high).toBe(1);
      expect(counts.medium).toBe(2);
      expect(counts.low).toBe(0);
    });
  });

  describe("markForReview", () => {
    it("marks a document for review with reasons", () => {
      addDocument(makeDoc({ id: "mark-me" }));
      markForReview("mark-me", ["Low OCR confidence"], "high");

      const doc = getDocumentById("mark-me");
      expect(doc!.review!.required).toBe(true);
      expect(doc!.review!.reason).toContain("Low OCR confidence");
      expect(doc!.review!.priority).toBe("high");
    });

    it("merges reasons without duplicates", () => {
      addDocument(makeDoc({
        id: "merge-me",
        review: { required: true, reason: ["Reason A"], priority: "low" },
      }));

      markForReview("merge-me", ["Reason A", "Reason B"], "medium");

      const doc = getDocumentById("merge-me");
      expect(doc!.review!.reason).toContain("Reason A");
      expect(doc!.review!.reason).toContain("Reason B");
      expect(doc!.review!.reason!.length).toBe(2);
    });
  });

  describe("assignReview", () => {
    it("assigns a reviewer to a document", () => {
      addDocument(makeDoc({
        id: "assign-me",
        review: { required: true, reason: ["Test"], priority: "medium" },
      }));

      assignReview("assign-me", "alice");

      const doc = getDocumentById("assign-me");
      expect(doc!.review!.assignedTo).toBe("alice");
    });
  });

  describe("resolveReview", () => {
    it("resolves a review with a decision", () => {
      addDocument(makeDoc({
        id: "resolve-me",
        review: { required: true, reason: ["Check this"], priority: "medium" },
      }));

      resolveReview("resolve-me", "approved", "Looks good");

      const doc = getDocumentById("resolve-me");
      expect(doc!.review!.required).toBe(false);
      expect(doc!.review!.resolution).toBe("approved");
      expect(doc!.review!.notes).toBe("Looks good");
      expect(doc!.needsReview).toBe(false);
    });

    it("sets failed status when rejected", () => {
      addDocument(makeDoc({
        id: "reject-me",
        review: { required: true, reason: ["Bad"], priority: "high" },
      }));

      resolveReview("reject-me", "rejected", "Not valid");

      const doc = getDocumentById("reject-me");
      expect(doc!.review!.resolution).toBe("rejected");
      expect(doc!.processingStatus).toBe("failed");
    });
  });
});
