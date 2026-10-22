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
    timeflowInvoice: scopeModel(),
    timeflowProjectBill: scopeModel(),
    timeflowSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    membership: { findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    organization: { findMany: vi.fn() },
    timeflowWorkspaceMeta: { findMany: vi.fn() },
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
// The token's (default) workspace, and a second business the user also owns.
const TOKEN_ORG = "org-nxt-lvl";
const OTHER_ORG = "org-all-encompass";
const STRANGER_ORG = "org-not-a-member";

function makeToken() {
  return jwt.sign(
    { userId: USER_ID, email: "owner@example.com", role: "owner", organizationId: TOKEN_ORG, programDomain: "timeflow" },
    process.env.JWT_SECRET || "test-secret",
  );
}

function get(path: string, workspaceId?: string) {
  const req = request(app)
    .get(`/api/timeflow${path}`)
    .set("x-app-partition", "nxt-lvl-suites")
    .set("Authorization", `Bearer ${makeToken()}`);
  return workspaceId ? req.set("x-active-workspace-id", workspaceId) : req;
}

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
    model.findMany.mockResolvedValue([]);
  }
  prismaMock.membership.findFirst.mockImplementation(async (args: { where: { organizationId: string } }) =>
    [TOKEN_ORG, OTHER_ORG].includes(args.where.organizationId)
      ? { userId: USER_ID, organizationId: args.where.organizationId, role: "owner" }
      : null,
  );
  prismaMock.timeflowSettings.findUnique.mockImplementation(
    async (args: { where: { organizationId_userId: { organizationId: string } } }) => ({
      organizationId: args.where.organizationId_userId.organizationId,
      businessName: `settings-for-${args.where.organizationId_userId.organizationId}`,
    }),
  );
  prismaMock.timeflowClient.findMany.mockImplementation(async (args: { where: { organizationId: string } }) => [
    { id: `client-in-${args.where.organizationId}`, organizationId: args.where.organizationId, name: "Client" },
  ]);
});

describe("TimeFlow active workspace scoping", () => {
  it("scopes settings to the selected workspace when the user is a member", async () => {
    const response = await get("/settings", OTHER_ORG);

    expect(response.status).toBe(200);
    expect(response.body.organizationId).toBe(OTHER_ORG);
    expect(response.headers["x-timeflow-org-id"]).toBe(OTHER_ORG);
  });

  it("scopes client lists to the selected workspace", async () => {
    const response = await get("/clients", OTHER_ORG);

    expect(response.status).toBe(200);
    expect(prismaMock.timeflowClient.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: OTHER_ORG }) }),
    );
  });

  it("ignores a workspace header for a workspace the user is not a member of", async () => {
    const response = await get("/settings", STRANGER_ORG);

    expect(response.status).toBe(200);
    expect(response.body.organizationId).toBe(TOKEN_ORG);
  });

  it("uses the token's workspace when no header is sent", async () => {
    const response = await get("/settings");

    expect(response.status).toBe(200);
    expect(response.body.organizationId).toBe(TOKEN_ORG);
  });

  it("keeps the token user as the data owner on routes with their own auth check", async () => {
    await get("/settings", OTHER_ORG);

    expect(prismaMock.timeflowSettings.findUnique).toHaveBeenLastCalledWith({
      where: { organizationId_userId: { organizationId: OTHER_ORG, userId: USER_ID } },
    });
  });

  it("still marks the token's workspace as default while another is selected", async () => {
    prismaMock.membership.findMany.mockResolvedValue([
      { organizationId: TOKEN_ORG, role: "owner" },
      { organizationId: OTHER_ORG, role: "owner" },
    ]);
    prismaMock.organization.findMany.mockResolvedValue([
      { id: TOKEN_ORG, name: "Nxt Lvl", ownerEmail: "owner@example.com", createdAt: new Date(), status: "active" },
      { id: OTHER_ORG, name: "All Encompass", ownerEmail: "owner@example.com", createdAt: new Date(), status: "active" },
    ]);
    prismaMock.timeflowWorkspaceMeta.findMany.mockResolvedValue([]);
    prismaMock.membership.groupBy.mockResolvedValue([]);

    const response = await get("/organizations", OTHER_ORG);

    expect(response.status).toBe(200);
    const byId = Object.fromEntries(
      (response.body.organizations as Array<{ id: string; isDefault: boolean }>).map((org) => [org.id, org.isDefault]),
    );
    expect(byId).toEqual({ [TOKEN_ORG]: true, [OTHER_ORG]: false });
  });
});
