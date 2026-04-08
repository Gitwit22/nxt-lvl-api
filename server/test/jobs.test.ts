import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { signToken } from "../src/auth.js";

vi.mock("../src/db.js", () => {
  const job = {
    id: "job-1",
    organizationId: "default-org",
    programDomain: "community-chronicle",
    documentId: "doc-1",
    document: {
      id: "doc-1",
      title: "Test",
      mimeType: "application/pdf",
      originalFileName: "test.pdf",
      processingStatus: "queued",
    },
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    error: null,
    errorLog: null,
    scheduledAt: new Date("2024-01-01"),
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  return {
    prisma: {
      processingJob: {
        findMany: vi.fn().mockResolvedValue([job]),
        count: vi.fn().mockResolvedValue(5),
      },
      document: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        count: vi.fn().mockResolvedValue(1),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock("../src/processingQueue.js", () => ({
  enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

const adminToken = () =>
  `Bearer ${signToken({ userId: "admin-1", email: "admin@test.com", role: "admin" })}`;
const reviewerToken = () =>
  `Bearer ${signToken({ userId: "rv-1", email: "reviewer@test.com", role: "reviewer" })}`;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.processingJob.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
});

describe("GET /api/jobs", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewer role", async () => {
    const res = await request(app).get("/api/jobs").set("Authorization", reviewerToken());
    expect(res.status).toBe(403);
  });

  it("returns job list for admin", async () => {
    const job = {
      id: "job-1",
      organizationId: "default-org",
      programDomain: "community-chronicle",
      documentId: "doc-1",
      document: {
        id: "doc-1",
        title: "Test",
        mimeType: "application/pdf",
        originalFileName: "test.pdf",
        processingStatus: "queued",
      },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      error: null,
      errorLog: null,
      scheduledAt: new Date("2024-01-01"),
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    };
    (prisma.processingJob.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([job]);

    const res = await request(app).get("/api/jobs").set("Authorization", adminToken());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe("job-1");
    expect(res.body[0].status).toBe("queued");
  });

  it("supports status filter", async () => {
    (prisma.processingJob.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/api/jobs?status=failed")
      .set("Authorization", adminToken());
    expect(res.status).toBe(200);

    const call = (prisma.processingJob.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe("failed");
    expect(call.where.organizationId).toBe("default-org");
    expect(call.where.programDomain).toBe("community-chronicle");
  });
});

describe("GET /api/jobs/stats", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/jobs/stats");
    expect(res.status).toBe(401);
  });

  it("returns queue statistics for admin", async () => {
    (prisma.processingJob.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(3)  // queued
      .mockResolvedValueOnce(1)  // processing
      .mockResolvedValueOnce(50) // completed
      .mockResolvedValueOnce(2)  // failed
      .mockResolvedValueOnce(0); // dead_letter
    (prisma.processingJob.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/jobs/stats").set("Authorization", adminToken());
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(3);
    expect(res.body.processing).toBe(1);
    expect(res.body.completed).toBe(50);
    expect(res.body.failed).toBe(2);
    expect(res.body.deadLetter).toBe(0);
    expect(res.body.totalActive).toBe(4);
  });
});
