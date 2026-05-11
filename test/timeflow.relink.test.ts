import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const prismaMock = vi.hoisted(() => {
  const tx = {
    timeflowClient: { updateMany: vi.fn() },
    timeflowProject: { updateMany: vi.fn() },
    timeflowTimeEntry: { updateMany: vi.fn() },
    timeflowInvoice: { updateMany: vi.fn() },
    timeflowProjectBill: { updateMany: vi.fn() },
    document: { updateMany: vi.fn() },
    timeflowSettings: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  };

  return {
    $transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx)),
    timeflowClient: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: tx.timeflowClient.updateMany,
    },
    timeflowProject: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: tx.timeflowProject.updateMany,
    },
    timeflowTimeEntry: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: tx.timeflowTimeEntry.updateMany,
    },
    timeflowInvoice: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: tx.timeflowInvoice.updateMany,
    },
    timeflowProjectBill: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: tx.timeflowProjectBill.updateMany,
    },
    timeflowSettings: {
      findUnique: tx.timeflowSettings.findUnique,
      update: tx.timeflowSettings.update,
      delete: tx.timeflowSettings.delete,
    },
    document: {
      updateMany: tx.document.updateMany,
    },
  };
});

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { partitionMiddleware } = await import("../src/core/middleware/partition.middleware.js");
const { timeflowRouter } = await import("../src/programs/timeflow/routes/index.js");

const app = express();
app.use(express.json());
app.use(partitionMiddleware);
app.use("/api/timeflow", timeflowRouter);

const CURRENT_ORG = "org-current";
const LEGACY_ORG = "org-legacy";
const USER_ID = "user-123";

function makeToken() {
  return jwt.sign(
    {
      userId: USER_ID,
      email: "test@example.com",
      role: "contractor",
      organizationId: CURRENT_ORG,
      programDomain: "timeflow",
    },
    process.env.JWT_SECRET || "test-secret",
  );
}

beforeEach(() => {
  vi.resetAllMocks();

  prismaMock.timeflowClient.count.mockResolvedValue(0);
  prismaMock.timeflowProject.count.mockResolvedValue(0);
  prismaMock.timeflowTimeEntry.count.mockResolvedValue(0);
  prismaMock.timeflowInvoice.count.mockResolvedValue(0);
  prismaMock.timeflowProjectBill.count.mockResolvedValue(0);

  prismaMock.timeflowClient.findFirst.mockResolvedValue(null);
  prismaMock.timeflowProject.findFirst.mockResolvedValue(null);
  prismaMock.timeflowTimeEntry.findFirst.mockResolvedValue(null);
  prismaMock.timeflowInvoice.findFirst.mockResolvedValue(null);
  prismaMock.timeflowProjectBill.findFirst.mockResolvedValue(null);

  const findManyByModel = (legacyRows: Array<{ organizationId: string }>) =>
    vi.fn().mockImplementation(async (args: { select?: { organizationId?: boolean; userId?: boolean } }) => {
      if (args?.select?.organizationId) {
        return legacyRows;
      }

      return [];
    });

  prismaMock.timeflowClient.findMany = findManyByModel([{ organizationId: LEGACY_ORG }, { organizationId: LEGACY_ORG }]);
  prismaMock.timeflowProject.findMany = findManyByModel([{ organizationId: LEGACY_ORG }]);
  prismaMock.timeflowTimeEntry.findMany = findManyByModel([{ organizationId: LEGACY_ORG }]);
  prismaMock.timeflowInvoice.findMany = findManyByModel([]);
  prismaMock.timeflowProjectBill.findMany = findManyByModel([]);

  prismaMock.timeflowClient.updateMany.mockResolvedValue({ count: 2 });
  prismaMock.timeflowProject.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.timeflowTimeEntry.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.timeflowInvoice.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.timeflowProjectBill.updateMany.mockResolvedValue({ count: 0 });

  prismaMock.timeflowSettings.findUnique
    .mockResolvedValueOnce({
      id: "legacy-settings",
      userId: USER_ID,
      organizationId: LEGACY_ORG,
      businessName: "Legacy Biz",
      invoiceNotes: "Legacy notes",
      paymentInstructions: "Pay me",
      companyViewerAccess: false,
    })
    .mockResolvedValueOnce(null);
  prismaMock.document.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.timeflowSettings.update.mockResolvedValue({ id: "updated-settings" });
  prismaMock.timeflowSettings.delete.mockResolvedValue({ id: "deleted-settings" });
});

describe("POST /api/timeflow/debug/relink-current-org", () => {
  it("moves legacy rows into the current org when current org is empty", async () => {
    const response = await request(app)
      .post("/api/timeflow/debug/relink-current-org")
      .set("x-app-partition", "nxt-lvl-suites")
      .set("Authorization", `Bearer ${makeToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.sourceOrgId).toBe(LEGACY_ORG);
    expect(response.body.targetOrgId).toBe(CURRENT_ORG);
    expect(response.body.clientsMoved).toBe(2);
    expect(response.body.projectsMoved).toBe(1);
    expect(response.body.timeEntriesMoved).toBe(1);
    expect(response.body.invoicesMoved).toBe(0);
    expect(response.body.projectBillsMoved).toBe(0);
    expect(response.body.documentsMoved).toBe(0);
    expect(response.body.settingsAction).toBe("moved");

    expect(prismaMock.timeflowClient.updateMany).toHaveBeenCalled();
    expect(prismaMock.timeflowProject.updateMany).toHaveBeenCalled();
    expect(prismaMock.timeflowTimeEntry.updateMany).toHaveBeenCalled();
  });
});
