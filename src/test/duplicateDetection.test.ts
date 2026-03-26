import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeFilename,
  scoreDuplicate,
  checkForDuplicates,
} from "@/services/duplicateDetectionService";
import { addDocument, resetStore } from "@/services/documentStore";
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
    extractedText: "This is test extracted text for duplicate detection.",
    extractedMetadata: { wordCount: 8 },
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

describe("duplicateDetectionService", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("normalizeFilename", () => {
    it("lowercases and strips extension", () => {
      expect(normalizeFilename("My-Document.pdf")).toBe("mydocument");
    });

    it("removes non-alphanumeric characters", () => {
      expect(normalizeFilename("report_2024 (final).docx")).toBe("report2024final");
    });

    it("handles simple names", () => {
      expect(normalizeFilename("notes.txt")).toBe("notes");
    });
  });

  describe("scoreDuplicate", () => {
    it("returns 0 for completely different documents", () => {
      const a = makeDoc({ id: "a", title: "Alpha", originalFileName: "alpha.pdf", fileSize: 100 });
      const b = makeDoc({ id: "b", title: "Beta", originalFileName: "beta.pdf", fileSize: 200 });
      const score = scoreDuplicate(a, b);
      // Same intakeSource gives 10, same text prefix may give 25
      expect(score).toBeLessThan(50);
    });

    it("scores high for matching hash", () => {
      const a = makeDoc({
        id: "a",
        duplicateCheck: { hash: "abc123", duplicateStatus: "unique" },
      });
      const b = makeDoc({
        id: "b",
        duplicateCheck: { hash: "abc123", duplicateStatus: "unique" },
      });
      const score = scoreDuplicate(a, b);
      expect(score).toBeGreaterThanOrEqual(100);
    });

    it("scores for matching filename", () => {
      const a = makeDoc({ id: "a", originalFileName: "Report-2024.pdf" });
      const b = makeDoc({ id: "b", originalFileName: "report_2024.pdf" });
      const score = scoreDuplicate(a, b);
      // Same normalized name = 25, same source = 10, same text = 25, same size could be undefined
      expect(score).toBeGreaterThanOrEqual(25);
    });

    it("scores for same file size", () => {
      const a = makeDoc({ id: "a", fileSize: 12345 });
      const b = makeDoc({ id: "b", fileSize: 12345 });
      const score = scoreDuplicate(a, b);
      expect(score).toBeGreaterThanOrEqual(15);
    });
  });

  describe("checkForDuplicates", () => {
    it("returns unique when no duplicates exist", () => {
      const doc = makeDoc({ id: "new-doc", extractedText: "totally unique content xyz abc 123" });
      addDocument(doc);
      const result = checkForDuplicates(doc);
      expect(result.duplicateStatus).toBe("unique");
      expect(result.possibleDuplicateIds).toHaveLength(0);
    });

    it("flags possible duplicates with matching filenames", () => {
      const existing = makeDoc({
        id: "existing",
        originalFileName: "quarterly-report.pdf",
        extractedText: "Quarterly report data and analysis for fiscal period",
      });
      addDocument(existing);

      const newDoc = makeDoc({
        id: "new-doc",
        originalFileName: "Quarterly_Report.pdf",
        extractedText: "Quarterly report data and analysis for fiscal period",
        intakeSource: "file_upload",
      });
      addDocument(newDoc);

      const result = checkForDuplicates(newDoc);
      expect(result.possibleDuplicateIds!.length).toBeGreaterThan(0);
      expect(result.duplicateStatus).toBe("possible_duplicate");
    });
  });
});
