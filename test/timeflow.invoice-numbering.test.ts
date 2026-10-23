import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const prismaMock = vi.hoisted(() => {
  const scopeModel = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
  return {
    timeflowClient: scopeModel(),
    timeflowProject: scopeModel(),
    timeflowTimeEntry: scopeModel(),
    timeflowInvoice: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    timeflowProjectBill: scopeModel(),
    membership: { findFirst: vi.fn() },
  };
});

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { partitionMiddleware } = await import("../src/core/middleware/partition.middleware.js");
const { timeflowRouter } = await import("../src/programs/timeflow/routes/index.js");

const app = express();
app.use(express.json());
app.use(partitionMiddleware);
app.use("/api/timeflow", timeflowRouter);

const USER_ID = "user-123";
const TOKEN_ORG = "org-nxt-lvl";
const PREMIERE_ORG = "org-premiere";

function makeToken() {
  return jwt.sign(
    { userId: USER_ID, email: "owner@example.com", role: "owner", organizationId: TOKEN_ORG, programDomain: "timeflow" },
    process.env.JWT_SECRET || "test-secret",
  );
}

function postInvoice(body: Record<string, unknown>) {
  return request(app)
    .post("/api/timeflow/invoices")
    .set("x-app-partition", "nxt-lvl-suites")
    .set("Authorization", `Bearer ${makeToken()}`)
    .set("x-active-workspace-id", PREMIERE_ORG)
    .send({ clientId: "client-1", totalAmount: 100, ...body });
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`id`)"), { code: "P2002" });
}

// Ids that already exist in the shared table (owned by another business).
let takenIds: Set<string>;

beforeEach(() => {
  vi.resetAllMocks();
  for (const model of [
    prismaMock.timeflowClient,
    prismaMock.timeflowProject,
    prismaMock.timeflowTimeEntry,
    prismaMock.timeflowInvoice,
    prismaMock.timeflowProjectBill,
  ]) {
    model.findFirst.mockResolvedValue({ id: "own-row" });
  }
  prismaMock.membership.findFirst.mockResolvedValue({ userId: USER_ID, organizationId: PREMIERE_ORG, role: "owner" });

  takenIds = new Set(["INV-2026-001", "INV-2026-002", "INV-2026-020", "INVOICE-9"]);
  prismaMock.timeflowInvoice.findMany.mockImplementation(async (args: { where: { id: { startsWith: string } } }) =>
    [...takenIds].filter((id) => id.startsWith(args.where.id.startsWith)).map((id) => ({ id })),
  );
  prismaMock.timeflowInvoice.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const id = args.data.id as string;
    if (takenIds.has(id)) throw uniqueViolation();
    takenIds.add(id);
    return { ...args.data };
  });
});

describe("POST /api/timeflow/invoices numbering", () => {
  it("keeps the requested number when it is free", async () => {
    const response = await postInvoice({ id: "PPM-2026-001" });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("PPM-2026-001");
  });

  it("uses the next free number instead of failing when the number is taken by another business", async () => {
    const response = await postInvoice({ id: "INV-2026-001" });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("INV-2026-021");
    // Saved under the selected business, never touching the existing invoice.
    expect(response.body.organizationId).toBe(PREMIERE_ORG);
    expect(prismaMock.timeflowInvoice.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: "INV-2026-001", organizationId: TOKEN_ORG }) }),
    );
  });

  it("retries when another request grabs the next number first", async () => {
    let raced = false;
    const realCreate = prismaMock.timeflowInvoice.create.getMockImplementation()!;
    prismaMock.timeflowInvoice.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (args.data.id === "INV-2026-021" && !raced) {
        raced = true;
        takenIds.add("INV-2026-021");
        throw uniqueViolation();
      }
      return realCreate(args);
    });

    const response = await postInvoice({ id: "INV-2026-001" });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("INV-2026-022");
  });

  it("does not hide other database errors", async () => {
    prismaMock.timeflowInvoice.create.mockRejectedValue(new Error("connection lost"));

    const response = await postInvoice({ id: "PPM-2026-001" });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(prismaMock.timeflowInvoice.create).toHaveBeenCalledTimes(1);
  });

  it("lets the database pick the id when none is sent", async () => {
    await postInvoice({});

    expect(prismaMock.timeflowInvoice.create.mock.calls[0][0].data.id).toBeUndefined();
  });
});
