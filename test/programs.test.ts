import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

const prismaMock = vi.hoisted(() => ({
  program: {
    findMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/processingQueue.js", () => ({
  enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));

const { partitionMiddleware } = await import("../src/core/middleware/partition.middleware.js");
const { programRouter } = await import("../src/core/routes/program.routes.js");

const app = express();
app.use(partitionMiddleware);
app.use("/api", programRouter);

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.program.findMany.mockResolvedValue([]);
  prismaMock.user.count.mockResolvedValue(1);
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.findFirst.mockResolvedValue(null);
  prismaMock.user.update.mockResolvedValue(null);
  prismaMock.user.create.mockResolvedValue(null);
});

describe("GET /api/programs", () => {
  it("returns catalog rows from Prisma when available", async () => {
    prismaMock.program.findMany.mockResolvedValueOnce([
      {
        id: "program-1",
        slug: "timeflow",
        organizationId: null,
        name: "Timeflow",
        shortDescription: "Timeflow workspace",
        longDescription: "Timeflow workspace",
        category: "Operations",
        tags: ["ops"],
        status: "live",
        type: "external",
        origin: "suite-native",
        internalRoute: null,
        externalUrl: "https://timeflow.nltops.com",
        openInNewTab: true,
        logoUrl: null,
        screenshotUrl: null,
        accentColor: null,
        isFeatured: true,
        isPublic: true,
        requiresLogin: false,
        requiresApproval: false,
        launchLabel: "Launch",
        displayOrder: 1,
        notes: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: null,
      },
    ]);

    const response = await request(app)
      .get("/api/programs")
      .set("x-app-partition", "nxt-lvl-suites");

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].slug).toBe("timeflow");
  });

  it("falls back to the static catalog when the Prisma query fails", async () => {
    prismaMock.program.findMany.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(app)
      .get("/api/programs")
      .set("x-app-partition", "nxt-lvl-suites");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.some((program: { slug: string }) => program.slug === "mejay")).toBe(true);
    expect(response.body.some((program: { slug: string }) => program.slug === "timeflow")).toBe(true);
  });
});