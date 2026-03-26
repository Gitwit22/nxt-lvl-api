import { describe, it, expect, beforeEach } from "vitest";
import {
  getArchiveStats,
  getSourceBreakdown,
  getProcessingHealth,
  getRecentActivity,
} from "@/services/dashboardService";
import { getAllDocuments, resetStore, addDocument } from "@/services/documentStore";
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

describe("dashboardService", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("getArchiveStats", () => {
    it("returns correct total count", () => {
      const docs = getAllDocuments();
      const stats = getArchiveStats(docs);
      expect(stats.total).toBe(10); // Seeded legacy data
    });

    it("counts documents by status", () => {
      const docs = getAllDocuments();
      const stats = getArchiveStats(docs);
      // All seeded docs are "processed" status
      expect(stats.archived).toBe(10);
      expect(stats.failed).toBe(0);
      expect(stats.reviewRequired).toBe(0);
    });

    it("counts failed documents", () => {
      addDocument(makeDoc({ id: "failed-1", processingStatus: "failed", status: "failed" }));
      const docs = getAllDocuments();
      const stats = getArchiveStats(docs);
      expect(stats.failed).toBe(1);
    });

    it("counts review required documents", () => {
      addDocument(makeDoc({
        id: "review-1",
        needsReview: true,
        status: "review_required",
      }));
      const docs = getAllDocuments();
      const stats = getArchiveStats(docs);
      expect(stats.reviewRequired).toBe(1);
    });
  });

  describe("getSourceBreakdown", () => {
    it("breaks down by intake source", () => {
      const docs = getAllDocuments();
      const breakdown = getSourceBreakdown(docs);
      expect(breakdown["legacy_import"]).toBe(10);
    });

    it("includes custom documents", () => {
      addDocument(makeDoc({ id: "upload-1", intakeSource: "file_upload" }));
      addDocument(makeDoc({ id: "upload-2", intakeSource: "file_upload" }));
      const docs = getAllDocuments();
      const breakdown = getSourceBreakdown(docs);
      expect(breakdown["file_upload"]).toBe(2);
    });
  });

  describe("getProcessingHealth", () => {
    it("returns zero avg confidence when no extraction data", () => {
      const docs = getAllDocuments();
      const health = getProcessingHealth(docs);
      expect(health.avgExtractionConfidence).toBe(0);
    });

    it("calculates average confidence", () => {
      addDocument(makeDoc({
        id: "conf-1",
        extraction: { status: "complete", confidence: 0.8 },
      }));
      addDocument(makeDoc({
        id: "conf-2",
        extraction: { status: "complete", confidence: 0.6 },
      }));
      const docs = getAllDocuments();
      const health = getProcessingHealth(docs);
      expect(health.avgExtractionConfidence).toBeCloseTo(0.7, 1);
    });

    it("counts failed jobs", () => {
      addDocument(makeDoc({ id: "fail-1", processingStatus: "failed" }));
      const docs = getAllDocuments();
      const health = getProcessingHealth(docs);
      expect(health.failedJobs).toBe(1);
    });

    it("counts uncategorized documents", () => {
      addDocument(makeDoc({ id: "uncat-1", category: "Uncategorized" }));
      const docs = getAllDocuments();
      const health = getProcessingHealth(docs);
      expect(health.uncategorizedCount).toBe(1);
    });

    it("counts duplicate-flagged documents", () => {
      addDocument(makeDoc({
        id: "dup-1",
        duplicateCheck: { duplicateStatus: "possible_duplicate", possibleDuplicateIds: ["x"] },
      }));
      const docs = getAllDocuments();
      const health = getProcessingHealth(docs);
      expect(health.duplicatesFlagged).toBe(1);
    });
  });

  describe("getRecentActivity", () => {
    it("returns events from processing history", () => {
      const docs = getAllDocuments();
      const events = getRecentActivity(docs);
      expect(events.length).toBeGreaterThan(0);
    });

    it("respects the limit parameter", () => {
      const docs = getAllDocuments();
      const events = getRecentActivity(docs, 3);
      expect(events.length).toBeLessThanOrEqual(3);
    });

    it("includes audit trail events", () => {
      addDocument(makeDoc({
        id: "audit-1",
        auditTrail: [
          { type: "status_transition", timestamp: "2024-01-15T00:00:00.000Z", actor: "system", details: "Queued" },
        ],
      }));
      const docs = getAllDocuments();
      const events = getRecentActivity(docs);
      const auditEvent = events.find((e) => e.documentId === "audit-1" && e.type === "status_transition");
      expect(auditEvent).toBeDefined();
    });

    it("sorts by timestamp descending", () => {
      const docs = getAllDocuments();
      const events = getRecentActivity(docs);
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1].timestamp >= events[i].timestamp).toBe(true);
      }
    });
  });
});
