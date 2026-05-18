import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../src/core/config/env.js";

const prismaMock = vi.hoisted(() => ({
  missionHubExpense: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubAuditLog: {
    create: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/middleware/program-access.middleware.js", () => ({
  requireProgramSubscription: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../src/core/services/email.service.js", () => ({
  sendInviteEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

const { missionHubRouter } = await import("../src/programs/mission-hub/routes/index.js");

function signAuthToken(role: string, userId = "user-1"): string {
  return jwt.sign(
    {
      userId,
      email: "user@example.com",
      role,
      organizationId: "org-1",
      programDomain: "mission-hub",
    },
    JWT_SECRET,
  );
}

const app = express();
app.use(express.json());
app.use("/api/mission-hub", missionHubRouter);

describe("Mission Hub expense approval controls", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.missionHubExpense.findFirst.mockResolvedValue({
      id: "expense-1",
      organizationId: "org-1",
      userId: "user-1",
      approvalStatus: "Submitted",
      isActive: true,
    });
    prismaMock.missionHubExpense.update.mockResolvedValue({
      id: "expense-1",
      approvalStatus: "Approved",
      reviewedAt: new Date().toISOString(),
    });
    prismaMock.missionHubAuditLog.create.mockResolvedValue({ id: "audit-1" });
  });

  it("blocks non-approvers from changing approvalStatus via PUT /expenses/:id", async () => {
    const response = await request(app)
      .put("/api/mission-hub/expenses/expense-1")
      .set("Authorization", `Bearer ${signAuthToken("Staff")}`)
      .send({ approvalStatus: "Approved" });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/not allowed to change approval status/i);
    expect(prismaMock.missionHubExpense.update).not.toHaveBeenCalled();
  });

  it("blocks self-approval on POST /expenses/:id/approve for non-admin approver roles", async () => {
    const response = await request(app)
      .post("/api/mission-hub/expenses/expense-1/approve")
      .set("Authorization", `Bearer ${signAuthToken("Finance", "user-1")}`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/cannot approve your own expense/i);
    expect(prismaMock.missionHubExpense.update).not.toHaveBeenCalled();
  });

  it("allows admin self-approval and writes an audit log", async () => {
    const response = await request(app)
      .post("/api/mission-hub/expenses/expense-1/approve")
      .set("Authorization", `Bearer ${signAuthToken("Admin", "user-1")}`)
      .send({});

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubExpense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expense-1" },
        data: expect.objectContaining({ approvalStatus: "Approved" }),
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(prismaMock.missionHubAuditLog.create).toHaveBeenCalled();
  });
});
