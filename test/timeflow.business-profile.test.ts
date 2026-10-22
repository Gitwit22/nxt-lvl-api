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
    membership: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    organization: { findMany: vi.fn() },
    timeflowWorkspaceMeta: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  };
});

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { partitionMiddleware } = await import("../src/core/middleware/partition.middleware.js");
const { timeflowRouter, sanitizeBusinessProfile } = await import("../src/programs/timeflow/routes/index.js");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(partitionMiddleware);
app.use("/api/timeflow", timeflowRouter);

const USER_ID = "user-123";
const ORG_A = "org-a";
const ORG_B = "org-b";
const LOGO_A = "data:image/png;base64,QUxQSEE=";

function makeToken() {
  return jwt.sign(
    { userId: USER_ID, email: "owner@example.com", role: "owner", organizationId: ORG_A, programDomain: "timeflow" },
    process.env.JWT_SECRET || "test-secret",
  );
}

function putProfile(orgId: string, body: unknown) {
  return request(app)
    .put(`/api/timeflow/organizations/${orgId}/profile`)
    .set("x-app-partition", "nxt-lvl-suites")
    .set("Authorization", `Bearer ${makeToken()}`)
    .send(body as object);
}

beforeEach(() => {
  vi.resetAllMocks();
  // Scope middleware: the caller owns data in the org, so no legacy fallback.
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
  prismaMock.membership.findFirst.mockResolvedValue({ userId: USER_ID, organizationId: ORG_A, role: "owner" });
  prismaMock.membership.count.mockResolvedValue(1);
  prismaMock.timeflowWorkspaceMeta.findUnique.mockResolvedValue(null);
  prismaMock.timeflowWorkspaceMeta.upsert.mockImplementation(async (args: { create: Record<string, unknown> }) => args.create);
});

describe("PUT /api/timeflow/organizations/:id/profile", () => {
  it("rejects members who are not owners or admins", async () => {
    prismaMock.membership.findFirst.mockResolvedValue({ userId: USER_ID, organizationId: ORG_A, role: "member" });

    const response = await putProfile(ORG_A, { legalName: "Alpha LLC" });

    expect(response.status).toBe(403);
    expect(prismaMock.timeflowWorkspaceMeta.upsert).not.toHaveBeenCalled();
  });

  it("rejects users with no membership in the target workspace", async () => {
    prismaMock.membership.findFirst.mockResolvedValue(null);

    const response = await putProfile(ORG_B, { legalName: "Not mine" });

    expect(response.status).toBe(403);
    expect(prismaMock.timeflowWorkspaceMeta.upsert).not.toHaveBeenCalled();
  });

  it("rejects invalid branding values", async () => {
    const badLogo = await putProfile(ORG_A, { branding: { logoDataUrl: "javascript:alert(1)" } });
    const badColor = await putProfile(ORG_A, { branding: { primaryColor: "red; background:url(x)" } });

    expect(badLogo.status).toBe(400);
    expect(badColor.status).toBe(400);
    expect(prismaMock.timeflowWorkspaceMeta.upsert).not.toHaveBeenCalled();
  });

  it("stores the profile only on the target workspace's meta row", async () => {
    const response = await putProfile(ORG_A, {
      legalName: "Alpha Logistics LLC",
      branding: { logoDataUrl: LOGO_A, primaryColor: "#112233" },
      businessSettings: { currency: "USD", taxRate: 0.06, estimatePrefix: "AEL" },
      unknownField: "dropped",
    });

    expect(response.status).toBe(200);
    expect(response.body.branding).toEqual({ logoDataUrl: LOGO_A, primaryColor: "#112233" });
    expect(response.body.unknownField).toBeUndefined();
    const upsertArgs = prismaMock.timeflowWorkspaceMeta.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ organizationId: ORG_A });
    expect(upsertArgs.create.businessProfile.legalName).toBe("Alpha Logistics LLC");
  });

  it("keeps the derived workspace type when creating the meta row", async () => {
    prismaMock.membership.count.mockResolvedValue(3);

    await putProfile(ORG_A, { legalName: "Team Biz" });

    const upsertArgs = prismaMock.timeflowWorkspaceMeta.upsert.mock.calls[0][0];
    expect(upsertArgs.create.workspaceType).toBe("team");
    expect(upsertArgs.create.teamEnabled).toBe(true);
  });

  it("merges with the existing profile and clears fields sent as null", async () => {
    prismaMock.timeflowWorkspaceMeta.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      businessProfile: { legalName: "Old LLC", phone: "555-0100", branding: { logoDataUrl: LOGO_A } },
    });

    const response = await putProfile(ORG_A, { legalName: "New LLC", phone: null });

    expect(response.status).toBe(200);
    const upsertArgs = prismaMock.timeflowWorkspaceMeta.upsert.mock.calls[0][0];
    expect(upsertArgs.update.businessProfile).toEqual({ legalName: "New LLC", branding: { logoDataUrl: LOGO_A } });
  });
});

describe("GET /api/timeflow/organizations", () => {
  it("returns each workspace's own branding", async () => {
    prismaMock.membership.findMany.mockResolvedValue([
      { organizationId: ORG_A, role: "owner" },
      { organizationId: ORG_B, role: "owner" },
    ]);
    prismaMock.organization.findMany.mockResolvedValue([
      { id: ORG_A, name: "Alpha", ownerEmail: "owner@example.com", createdAt: new Date(), status: "active" },
      { id: ORG_B, name: "Bravo", ownerEmail: "owner@example.com", createdAt: new Date(), status: "active" },
    ]);
    prismaMock.timeflowWorkspaceMeta.findMany.mockResolvedValue([
      { organizationId: ORG_A, workspaceType: "team", businessProfile: { branding: { logoDataUrl: LOGO_A } } },
    ]);
    prismaMock.membership.groupBy.mockResolvedValue([]);

    const response = await request(app)
      .get("/api/timeflow/organizations")
      .set("x-app-partition", "nxt-lvl-suites")
      .set("Authorization", `Bearer ${makeToken()}`);

    expect(response.status).toBe(200);
    const [alpha, bravo] = response.body.organizations;
    expect(alpha.id).toBe(ORG_A);
    expect(alpha.branding).toEqual({ logoDataUrl: LOGO_A });
    expect(bravo.id).toBe(ORG_B);
    expect(bravo.branding).toBeUndefined();
  });
});

describe("sanitizeBusinessProfile", () => {
  it("only returns keys present in the update", () => {
    expect(sanitizeBusinessProfile({ phone: "555-0100" })).toEqual({ phone: "555-0100" });
  });

  it("clears a section sent as null", () => {
    expect(sanitizeBusinessProfile({ branding: null })).toEqual({ branding: null });
  });

  it("rejects out-of-range document defaults", () => {
    expect(() => sanitizeBusinessProfile({ businessSettings: { taxRate: 6 } })).toThrow();
    expect(() => sanitizeBusinessProfile({ businessSettings: { nextInvoiceNumber: 1.5 } })).toThrow();
  });
});
