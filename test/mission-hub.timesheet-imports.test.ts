import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../src/core/config/env.js";

const prismaMock = vi.hoisted(() => ({
  missionHubTimesheetIntake: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  missionHubTimesheetSubmission: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  missionHubTimeEntry: {
    create: vi.fn(),
  },
  missionHubTimesheetApprovalLog: {
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

const app = express();
app.use(express.json());
app.use("/api/mission-hub", missionHubRouter);

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

function makePayload() {
  return {
    payload: {
      exportId: "exp-1",
      sourceApp: "timeflow",
      exportType: "mission_hub_timesheet",
      payPeriod: {
        id: "pp-1",
        startDate: "2026-05-01",
        endDate: "2026-05-15",
      },
      employees: [
        {
          employeeId: "emp-1",
          employeeName: "Alex Rivera",
          employeeEmail: "alex@example.com",
          regularHours: 40,
          manualHours: 0,
          ptoHours: 8,
          vacationHours: 0,
          sickHours: 0,
          holidayHours: 0,
          unpaidLeaveHours: 0,
          totalPaidHours: 48,
          approvalStatus: "approved",
          sourceTimeEntryIds: ["te-1", "te-2"],
          projects: [],
        },
        {
          employeeId: "emp-2",
          employeeName: "",
          regularHours: 0,
          sourceTimeEntryIds: [],
          approvalStatus: "pending",
        },
      ],
    },
  };
}

describe("Mission Hub timesheet import routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.missionHubTimesheetIntake.findFirst.mockResolvedValue(null);
    prismaMock.missionHubTimesheetIntake.create.mockResolvedValue({ id: "intake-1" });
    prismaMock.missionHubTimesheetIntake.update.mockResolvedValue({ id: "intake-1", status: "imported_with_errors" });

    prismaMock.missionHubTimesheetSubmission.create.mockResolvedValue({ id: "sub-1" });
    prismaMock.missionHubTimesheetSubmission.updateMany.mockResolvedValue({ count: 1 });

    prismaMock.missionHubTimeEntry.create.mockResolvedValue({ id: "entry-1" });
    prismaMock.missionHubTimesheetApprovalLog.create.mockResolvedValue({ id: "log-1" });
  });

  it("blocks timesheet import for non-approver roles", async () => {
    const response = await request(app)
      .post("/api/mission-hub/timesheet-imports")
      .set("Authorization", `Bearer ${signAuthToken("Staff")}`)
      .send(makePayload());

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/canApproveTimesheets/i);
  });

  it("creates import intake with partial quarantine", async () => {
    const response = await request(app)
      .post("/api/mission-hub/timesheet-imports")
      .set("Authorization", `Bearer ${signAuthToken("Admin")}`)
      .send(makePayload());

    expect(response.status).toBe(201);
    expect(response.body.acceptedCount).toBe(1);
    expect(response.body.quarantinedCount).toBe(1);
    expect(prismaMock.missionHubTimesheetSubmission.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.missionHubTimeEntry.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.missionHubTimesheetIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "intake-1" },
        data: expect.objectContaining({
          status: "imported_with_errors",
          acceptedEmployees: 1,
          quarantinedEmployees: 1,
        }),
      }),
    );
  });

  it("rejects duplicate package import for the same pay period", async () => {
    prismaMock.missionHubTimesheetIntake.findFirst.mockResolvedValueOnce({ id: "intake-existing" });

    const response = await request(app)
      .post("/api/mission-hub/timesheet-imports")
      .set("Authorization", `Bearer ${signAuthToken("Admin")}`)
      .send(makePayload());

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already been imported/i);
    expect(prismaMock.missionHubTimesheetIntake.create).not.toHaveBeenCalled();
  });

  it("transitions intake lifecycle and propagates status to imported submissions", async () => {
    prismaMock.missionHubTimesheetIntake.findFirst.mockResolvedValueOnce({
      id: "intake-1",
      organizationId: "org-1",
      programDomain: "mission-hub",
      status: "imported",
      sourceApp: "timeflow",
      sourceExportId: "exp-1",
      payPeriodStart: "2026-05-01",
      payPeriodEnd: "2026-05-15",
      validationIssues: [],
    });
    prismaMock.missionHubTimesheetIntake.update.mockResolvedValueOnce({ id: "intake-1", status: "mapped" });

    const response = await request(app)
      .patch("/api/mission-hub/timesheet-imports/intake-1/lifecycle")
      .set("Authorization", `Bearer ${signAuthToken("Finance")}`)
      .send({ status: "mapped", note: "Mappings confirmed" });

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubTimesheetIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "intake-1" },
        data: expect.objectContaining({ status: "mapped" }),
      }),
    );
    expect(prismaMock.missionHubTimesheetSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ importLifecycleStatus: "mapped" }),
      }),
    );
  });
});
