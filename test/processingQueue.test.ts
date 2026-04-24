import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Prisma mock — use vi.hoisted so the factory reference is available at hoist time
// ---------------------------------------------------------------------------
const prismaMock = vi.hoisted(() => ({
  processingJob: {
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  document: {
    update: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  chronicleTypeFingerprint: {
    findMany: vi.fn(),
  },
  chroniclePdfPageFeature: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  chroniclePdfBoundaryDecision: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({ prisma: prismaMock }));

// ---------------------------------------------------------------------------
// Config mock (keep MAX_ATTEMPTS controllable)
// ---------------------------------------------------------------------------
vi.mock("../src/core/config/env.js", () => ({
  MAX_ATTEMPTS: 3,
  JOB_TIMEOUT_MS: 5000,
  RETRY_BACKOFF_BASE_MS: 100, // short for tests
  SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD: 20,
  OCR_CONFIDENCE_REVIEW_THRESHOLD: 0.7,
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD: 0.85,
  LLAMA_CLASSIFY_REVIEW_THRESHOLD: 0.6,
  PDF_BATCH_GROUPING_ENABLED: true,
  PDF_BATCH_GROUPING_SHADOW_ONLY: true,
  PDF_BATCH_MIN_PAGES: 12,
  PDF_BATCH_MAX_PAGES: 300,
  DOC_INTEL_API_BASE_URL: "",
  DOC_INTEL_API_TOKEN: "",
  DOC_INTEL_TIMEOUT_MS: 5000,
  ENABLE_DOC_INTEL_CLASSIFY: false,
  STORAGE_BACKEND: "local",
  R2_ACCOUNT_ID: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  R2_BUCKET_NAME: "",
  R2_PUBLIC_URL: "",
  R2_DEFAULT_PREFIX: "",
}));

import { processSingleJob, handleJobFailure, runExtraction } from "../src/processingQueue.js";
import fs from "fs/promises";

const mockJob = {
  id: "job-1",
  documentId: "doc-1",
  organizationId: "default-org",
  programDomain: "community-chronicle",
  attempts: 1,
  maxAttempts: 3,
  errorLog: null,
  status: "processing",
  scheduledAt: new Date(),
  nextRetryAt: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  error: null,
  document: {
    id: "doc-1",
    title: "Test Doc",
    description: "desc",
    author: "Author",
    year: 2024,
    month: 3,
    tags: [],
    sourceReference: null,
    filePath: null,
    mimeType: null,
    processingHistory: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.processingJob.update.mockResolvedValue(mockJob);
  prismaMock.document.update.mockResolvedValue({});
  prismaMock.document.findMany.mockResolvedValue([]);
  prismaMock.chronicleTypeFingerprint.findMany.mockResolvedValue([]);
  prismaMock.chroniclePdfPageFeature.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.chroniclePdfPageFeature.createMany.mockResolvedValue({ count: 0 });
  prismaMock.chroniclePdfBoundaryDecision.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.chroniclePdfBoundaryDecision.createMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// runExtraction unit tests
// ---------------------------------------------------------------------------
describe("runExtraction", () => {
  it("returns unsupported result when filePath is null", async () => {
    const result = await runExtraction(null, "application/pdf");
    expect(result.method).toBe("unsupported");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it("extracts plain text files with high confidence", async () => {
    // Write a temp file
    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, "Hello world this is a test document.");

    try {
      const result = await runExtraction(tmpFile, "text/plain");
      expect(result.method).toBe("text");
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.text).toContain("Hello world");
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it("returns unsupported for unknown MIME type", async () => {
    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.bin`);
    await fs.writeFile(tmpFile, "binary contents");

    try {
      const result = await runExtraction(tmpFile, "application/octet-stream");
      expect(result.method).toBe("unsupported");
      expect(result.confidence).toBeLessThan(0.5);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// processSingleJob: no job available
// ---------------------------------------------------------------------------
describe("processSingleJob — no job available", () => {
  it("returns without any DB writes when queue is empty", async () => {
    prismaMock.processingJob.findFirst.mockResolvedValueOnce(null);

    await processSingleJob();

    expect(prismaMock.processingJob.update).not.toHaveBeenCalled();
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processSingleJob: successful text extraction
// ---------------------------------------------------------------------------
describe("processSingleJob — text extraction", () => {
  it("marks document as processed and job as completed", async () => {
    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, "Hello world archive document for processing.");

    const jobWithTextFile = {
      ...mockJob,
      document: {
        ...mockJob.document,
        filePath: tmpFile,
        mimeType: "text/plain",
      },
    };

    prismaMock.processingJob.findFirst.mockResolvedValueOnce(jobWithTextFile);
    prismaMock.processingJob.findUniqueOrThrow.mockResolvedValueOnce({
      ...jobWithTextFile,
      attempts: 1,
    });

    try {
      await processSingleJob();

      // Document should be updated to processed and enriched with layered metadata.
      const docUpdateCalls = (prismaMock.document.update as ReturnType<typeof vi.fn>).mock.calls;
      const processedCall = docUpdateCalls.find(
        (call) => call[0]?.data?.processingStatus === "processed",
      );
      expect(processedCall).toBeDefined();
      const finalDocUpdate = processedCall![0].data;
      expect(finalDocUpdate.processingStatus).toBe("processed");
      expect(typeof finalDocUpdate.needsReview).toBe("boolean");
      expect(finalDocUpdate.classificationResult).toBeDefined();
      expect(finalDocUpdate.duplicateCheck).toBeDefined();
      expect(finalDocUpdate.searchIndex?.relationships?.clusterId).toBeDefined();

      // Job should be marked completed
      const jobUpdateCalls = (prismaMock.processingJob.update as ReturnType<typeof vi.fn>).mock.calls;
      const finalJobUpdate = jobUpdateCalls[jobUpdateCalls.length - 1][0].data;
      expect(finalJobUpdate.status).toBe("completed");
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// handleJobFailure: retry with backoff
// ---------------------------------------------------------------------------
describe("handleJobFailure — retry scheduling", () => {
  it("re-queues job with backoff when attempts < maxAttempts", async () => {
    const job = {
      id: "job-retry",
      documentId: "doc-retry",
      attempts: 1,
      maxAttempts: 3,
      errorLog: null,
      document: { processingHistory: [], title: "Doc", author: "A" },
    };

    await handleJobFailure(job, new Error("transient network error"));

    const jobUpdate = (prismaMock.processingJob.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jobUpdate.data.status).toBe("queued");
    expect(jobUpdate.data.nextRetryAt).toBeInstanceOf(Date);
    expect(Array.isArray(jobUpdate.data.errorLog)).toBe(true);
    expect(jobUpdate.data.errorLog[0].error).toBe("transient network error");
  });
});

// ---------------------------------------------------------------------------
// handleJobFailure: dead-letter on final attempt
// ---------------------------------------------------------------------------
describe("handleJobFailure — dead-letter", () => {
  it("marks job as dead_letter when attempts >= maxAttempts", async () => {
    const job = {
      id: "job-dead",
      documentId: "doc-dead",
      attempts: 3,   // = maxAttempts → should dead-letter
      maxAttempts: 3,
      errorLog: [{ attempt: 1, error: "e1" }, { attempt: 2, error: "e2" }],
      document: { processingHistory: [], title: "Doc", author: "A" },
    };

    await handleJobFailure(job, new Error("fatal extraction error"));

    const jobUpdate = (prismaMock.processingJob.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jobUpdate.data.status).toBe("dead_letter");
    expect(jobUpdate.data.errorLog.length).toBe(3); // 2 existing + 1 new

    const docUpdate = (prismaMock.document.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(docUpdate.data.processingStatus).toBe("failed");
    expect(docUpdate.data.needsReview).toBe(true);
  });
});
