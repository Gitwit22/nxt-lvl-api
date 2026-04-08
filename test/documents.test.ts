import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// --- Prisma mock (before app import) ---
vi.mock("../src/db.js", () => {
  const doc = {
    id: "doc-1",
    organizationId: "default-org",
    programDomain: "community-chronicle",
    title: "Test Doc",
    description: "",
    author: "Test",
    year: 2024,
    month: null,
    category: "General",
    type: "Report",
    financialCategory: null,
    financialDocumentType: null,
    tags: [],
    keywords: [],
    originalFileName: null,
    mimeType: null,
    fileSize: null,
    fileUrl: "#",
    filePath: null,
    processingStatus: "processed",
    ocrStatus: "not_needed",
    extractedText: "",
    extractedMetadata: {},
    classificationResult: null,
    intakeSource: "manual_entry",
    sourceReference: null,
    department: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    importedAt: new Date("2024-01-01"),
    processingHistory: [],
    status: "archived",
    statusUpdatedAt: null,
    auditTrail: [],
    extraction: null,
    duplicateCheck: null,
    review: { required: false },
    searchIndex: null,
    needsReview: false,
    aiSummary: "",
    createdByUserId: null,
    uploadedById: null,
    reviewedById: null,
  };

  return {
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([]),
      document: {
        findMany: vi.fn().mockResolvedValue([doc]),
        findFirst: vi.fn().mockResolvedValue(doc),
        findUnique: vi.fn().mockResolvedValue(doc),
        findUniqueOrThrow: vi.fn().mockResolvedValue(doc),
        create: vi.fn().mockResolvedValue(doc),
        update: vi.fn().mockResolvedValue(doc),
        delete: vi.fn().mockResolvedValue(doc),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      processingJob: {
        create: vi.fn().mockResolvedValue({ id: "job-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      user: {
        findUnique: vi.fn(),
        count: vi.fn().mockResolvedValue(1),
        create: vi.fn(),
      },
    },
  };
});

vi.mock("../src/processingQueue.js", () => ({
  enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signToken } from "../src/auth.js";

// Token helpers
const uploaderToken = () =>
  `Bearer ${signToken({ userId: "user-uploader", email: "uploader@test.com", role: "uploader" })}`;
const reviewerToken = () =>
  `Bearer ${signToken({ userId: "user-reviewer", email: "reviewer@test.com", role: "reviewer" })}`;
const adminToken = () =>
  `Bearer ${signToken({ userId: "user-admin", email: "admin@test.com", role: "admin" })}`;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default mock return values after clearAllMocks
  const doc = {
    id: "doc-1",
    organizationId: "default-org",
    programDomain: "community-chronicle",
    title: "Test Doc",
    description: "",
    author: "Test",
    year: 2024,
    month: null,
    category: "General",
    type: "Report",
    financialCategory: null,
    financialDocumentType: null,
    tags: [],
    keywords: [],
    originalFileName: null,
    mimeType: null,
    fileSize: null,
    fileUrl: "#",
    filePath: null,
    processingStatus: "processed",
    ocrStatus: "not_needed",
    extractedText: "",
    extractedMetadata: {},
    classificationResult: null,
    intakeSource: "manual_entry",
    sourceReference: null,
    department: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    importedAt: new Date("2024-01-01"),
    processingHistory: [],
    status: "archived",
    statusUpdatedAt: null,
    auditTrail: [],
    extraction: null,
    duplicateCheck: null,
    review: { required: false },
    searchIndex: null,
    needsReview: false,
    aiSummary: "",
    createdByUserId: null,
    uploadedById: null,
    reviewedById: null,
  };
  (prisma.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([doc]);
  (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
  (prisma.document.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
  (prisma.document.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
  (prisma.document.create as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
  (prisma.document.update as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
describe("GET /api/health", () => {
  it("returns ok: true", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/documents
// ---------------------------------------------------------------------------
describe("GET /api/documents", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/documents");
    expect(res.status).toBe(401);
  });

  it("supports search filter for authenticated users", async () => {
    const res = await request(app)
      .get("/api/documents?search=test")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id
// ---------------------------------------------------------------------------
describe("GET /api/documents/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/documents/doc-1");
    expect(res.status).toBe(401);
  });

  it("returns document by id for authenticated users", async () => {
    const res = await request(app)
      .get("/api/documents/doc-1")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("doc-1");
  });

  it("returns 404 for unknown id", async () => {
    (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/documents/nonexistent")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/documents/manual  (requires uploader+)
// ---------------------------------------------------------------------------
describe("POST /api/documents/manual", () => {
  it("returns 401 without token", async () => {
    const res = await request(app)
      .post("/api/documents/manual")
      .send({ title: "Test" });
    expect(res.status).toBe(401);
  });

  it("accepts valid body with uploader token", async () => {
    const res = await request(app)
      .post("/api/documents/manual")
      .set("Authorization", uploaderToken())
      .send({
        title: "Annual Report 2024",
        author: "Finance Dept",
        year: 2024,
        category: "Financial",
        type: "Report",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/documents/upload  (requires uploader+)
// ---------------------------------------------------------------------------
describe("POST /api/documents/upload", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).post("/api/documents/upload");
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file provided", async () => {
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", uploaderToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id  (requires reviewer+)
// ---------------------------------------------------------------------------
describe("PATCH /api/documents/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).patch("/api/documents/doc-1").send({ title: "New" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for uploader role", async () => {
    const res = await request(app)
      .patch("/api/documents/doc-1")
      .set("Authorization", uploaderToken())
      .send({ title: "New" });
    expect(res.status).toBe(403);
  });

  it("allows reviewer to patch", async () => {
    const res = await request(app)
      .patch("/api/documents/doc-1")
      .set("Authorization", reviewerToken())
      .send({ title: "Updated" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown doc", async () => {
    (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await request(app)
      .patch("/api/documents/unknown")
      .set("Authorization", reviewerToken())
      .send({ title: "x" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id  (requires admin)
// ---------------------------------------------------------------------------
describe("DELETE /api/documents/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).delete("/api/documents/doc-1");
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewer role", async () => {
    const res = await request(app)
      .delete("/api/documents/doc-1")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(403);
  });

  it("allows admin to delete", async () => {
    const res = await request(app)
      .delete("/api/documents/doc-1")
      .set("Authorization", adminToken());
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /api/documents/:id/retry  (requires admin)
// ---------------------------------------------------------------------------
describe("POST /api/documents/:id/retry", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/documents/doc-1/retry");
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewer", async () => {
    const res = await request(app)
      .post("/api/documents/doc-1/retry")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(403);
  });

  it("allows admin to retry", async () => {
    const res = await request(app)
      .post("/api/documents/doc-1/retry")
      .set("Authorization", adminToken());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/review-queue  (requires reviewer+)
// ---------------------------------------------------------------------------
describe("GET /api/review-queue", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/review-queue");
    expect(res.status).toBe(401);
  });

  it("allows reviewer to access", async () => {
    const res = await request(app)
      .get("/api/review-queue")
      .set("Authorization", reviewerToken());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/review-queue/:id/resolve  (requires reviewer+)
// ---------------------------------------------------------------------------
describe("POST /api/review-queue/:id/resolve", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/review-queue/doc-1/resolve");
    expect(res.status).toBe(401);
  });

  it("allows reviewer to resolve", async () => {
    const res = await request(app)
      .post("/api/review-queue/doc-1/resolve")
      .set("Authorization", reviewerToken())
      .send({ resolution: "approved", notes: "Looks good" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown doc", async () => {
    (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/review-queue/unknown/resolve")
      .set("Authorization", reviewerToken())
      .send({ resolution: "approved" });
    expect(res.status).toBe(404);
  });
});
