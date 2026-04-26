import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../src/core/config/env.js";

const prismaMock = vi.hoisted(() => ({
  missionHubProgram: {
    findFirst: vi.fn(),
  },
  missionHubProject: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubEvent: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubCalendarEntry: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubGrant: {
    findFirst: vi.fn(),
  },
  missionHubSponsor: {
    findFirst: vi.fn(),
  },
  missionHubCampaign: {
    findFirst: vi.fn(),
  },
  missionHubTask: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubTimeEntry: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  missionHubTimesheetSubmission: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  missionHubTimesheetApprovalLog: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  missionHubPersonnel: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  missionHubInvite: {
    create: vi.fn(),
    update: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
}));

const sendInviteEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/middleware/program-access.middleware.js", () => ({
  requireProgramSubscription: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

// Mock the email service so tests never call Core / Resend
vi.mock("../src/core/services/email.service.js", () => ({
  sendInviteEmail: sendInviteEmailMock,
}));

const { missionHubRouter } = await import("../src/programs/mission-hub/routes/index.js");

const app = express();
app.use(express.json());
app.use("/api/mission-hub", missionHubRouter);

const authToken = jwt.sign(
  {
    userId: "user-1",
    email: "user@example.com",
    role: "Admin",
    organizationId: "org-1",
    programDomain: "mission-hub",
  },
  JWT_SECRET,
);

beforeEach(() => {
  vi.resetAllMocks();

  prismaMock.missionHubProgram.findFirst.mockResolvedValue({ id: "program-1", name: "Youth Outreach", isActive: true });
  prismaMock.missionHubProject.findMany.mockResolvedValue([]);
  prismaMock.missionHubProject.create.mockResolvedValue({ id: "project-1", name: "Summer Mentorship 2026", status: "active" });
  prismaMock.missionHubProject.findFirst.mockResolvedValue({ id: "project-1", name: "Summer Mentorship 2026", status: "active" });
  prismaMock.missionHubProject.update.mockResolvedValue({ id: "project-1", name: "Summer Mentorship 2026", status: "archived" });
  prismaMock.missionHubEvent.findMany.mockResolvedValue([]);
  prismaMock.missionHubEvent.create.mockResolvedValue({
    id: "event-1",
    name: "Volunteer Night",
    status: "scheduled",
    startDateTime: "2026-05-01T18:00",
    endDateTime: "2026-05-01T20:00",
  });
  prismaMock.missionHubEvent.findFirst.mockResolvedValue({
    id: "event-1",
    name: "Volunteer Night",
    status: "scheduled",
    startDateTime: "2026-05-01T18:00",
    endDateTime: "2026-05-01T20:00",
    calendarEventId: "cal-1",
    organizationId: "org-1",
    userId: "user-1",
    programDomain: "mission-hub",
    isActive: true,
  });
  prismaMock.missionHubEvent.update.mockResolvedValue({ id: "event-1", status: "cancelled" });
  prismaMock.missionHubCalendarEntry.create.mockResolvedValue({ id: "cal-1" });
  prismaMock.missionHubCalendarEntry.findFirst.mockResolvedValue({ id: "cal-1", organizationId: "org-1", userId: "user-1" });
  prismaMock.missionHubCalendarEntry.update.mockResolvedValue({ id: "cal-1" });
  prismaMock.missionHubGrant.findFirst.mockResolvedValue({ id: "grant-1", isActive: true });
  prismaMock.missionHubSponsor.findFirst.mockResolvedValue({ id: "sponsor-1", isActive: true });
  prismaMock.missionHubCampaign.findFirst.mockResolvedValue({ id: "campaign-1", isActive: true });

  prismaMock.missionHubTask.findMany.mockResolvedValue([]);
  prismaMock.missionHubTask.create.mockResolvedValue({ id: "task-1", title: "Task" });
  prismaMock.missionHubTask.findFirst.mockResolvedValue({ id: "task-1" });
  prismaMock.missionHubTask.update.mockResolvedValue({ id: "task-1" });

  prismaMock.missionHubTimeEntry.findMany.mockResolvedValue([]);
  prismaMock.missionHubTimeEntry.create.mockResolvedValue({ id: "time-1", person: "Casey", date: "2026-04-21" });
  prismaMock.missionHubTimeEntry.findFirst.mockResolvedValue({ id: "time-1", status: "draft" });
  prismaMock.missionHubTimeEntry.update.mockResolvedValue({ id: "time-1" });
  prismaMock.missionHubTimeEntry.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.missionHubTimesheetSubmission.findMany.mockResolvedValue([]);
  prismaMock.missionHubTimesheetSubmission.findFirst.mockResolvedValue({
    id: "sub-1",
    status: "submitted",
    submittedByUserId: "user-2",
  });
  prismaMock.missionHubTimesheetSubmission.create.mockResolvedValue({ id: "sub-1", status: "submitted" });
  prismaMock.missionHubTimesheetSubmission.update.mockResolvedValue({ id: "sub-1", status: "approved" });
  prismaMock.missionHubTimesheetApprovalLog.findMany.mockResolvedValue([]);
  prismaMock.missionHubTimesheetApprovalLog.create.mockResolvedValue({ id: "log-1" });

  prismaMock.missionHubPersonnel.create.mockResolvedValue({
    id: "person-1",
    firstName: "Bob",
    lastName: "Smith",
    email: "bob@example.com",
  });
  prismaMock.missionHubPersonnel.findMany.mockResolvedValue([]);
  prismaMock.missionHubPersonnel.findFirst.mockResolvedValue(null);
  prismaMock.missionHubPersonnel.update.mockResolvedValue({ id: "person-1" });
  prismaMock.missionHubInvite.create.mockResolvedValue({ id: "invite-1" });
  prismaMock.missionHubInvite.update.mockResolvedValue({ id: "invite-1" });
  prismaMock.organization.findUnique.mockResolvedValue({ id: "org-1", name: "Test Org" });

  sendInviteEmailMock.mockResolvedValue(false);
});

describe("Mission Hub Tasks and Time Entries routes", () => {
  it("GET /projects scopes by organization, user, and programDomain", async () => {
    const response = await request(app)
      .get("/api/mission-hub/projects")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          programDomain: "mission-hub",
          isActive: true,
        }),
      }),
    );
  });

  it("POST /projects validates project status", async () => {
    const response = await request(app)
      .post("/api/mission-hub/projects")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ name: "Summer Mentorship 2026", status: "unknown" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/status must be one of/i);
    expect(prismaMock.missionHubProject.create).not.toHaveBeenCalled();
  });

  it("POST /projects validates supplied programId", async () => {
    prismaMock.missionHubProgram.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .post("/api/mission-hub/projects")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        name: "Transportation Support",
        status: "active",
        programId: "missing-program",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/programId/i);
  });

  it("POST /projects creates a scoped record", async () => {
    const response = await request(app)
      .post("/api/mission-hub/projects")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        name: "Volunteer Orientation",
        status: "active",
        programId: "program-1",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.missionHubProject.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          programDomain: "mission-hub",
          name: "Volunteer Orientation",
          status: "active",
          programId: "program-1",
        }),
      }),
    );
  });

  it("PUT /projects/:id updates a scoped record", async () => {
    const response = await request(app)
      .put("/api/mission-hub/projects/project-1")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ status: "paused", name: "Updated Name" });

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubProject.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({ status: "paused", name: "Updated Name" }),
      }),
    );
  });

  it("DELETE /projects/:id archives scoped project", async () => {
    const response = await request(app)
      .delete("/api/mission-hub/projects/project-1")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(204);
    expect(prismaMock.missionHubProject.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({ isActive: false, status: "archived" }),
      }),
    );
  });

describe("Mission Hub Events routes", () => {
  it("POST /events validates required name", async () => {
    const response = await request(app)
      .post("/api/mission-hub/events")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ startDateTime: "2026-05-01T18:00", endDateTime: "2026-05-01T20:00" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/name is required/i);
  });

  it("POST /events validates date range", async () => {
    const response = await request(app)
      .post("/api/mission-hub/events")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ name: "Bad Event", startDateTime: "2026-05-01T20:00", endDateTime: "2026-05-01T18:00" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/endDateTime must be after startDateTime/i);
  });

  it("POST /events validates status", async () => {
    const response = await request(app)
      .post("/api/mission-hub/events")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        name: "Bad Status",
        status: "unknown",
        startDateTime: "2026-05-01T18:00",
        endDateTime: "2026-05-01T20:00",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/status must be one of/i);
  });

  it("POST /events creates linked calendar entry", async () => {
    const response = await request(app)
      .post("/api/mission-hub/events")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        name: "Volunteer Night",
        status: "scheduled",
        startDateTime: "2026-05-01T18:00",
        endDateTime: "2026-05-01T20:00",
        programId: "program-1",
        projectId: "project-1",
        grantId: "grant-1",
        sponsorId: "sponsor-1",
        fundraisingCampaignId: "campaign-1",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.missionHubEvent.create).toHaveBeenCalled();
    expect(prismaMock.missionHubCalendarEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Volunteer Night",
          linkedEventId: "event-1",
          linkedEntity: "Event",
          linkedEntityId: "event-1",
        }),
      }),
    );
  });

  it("PUT /events/:id updates linked calendar entry", async () => {
    const response = await request(app)
      .put("/api/mission-hub/events/event-1")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ name: "Volunteer Night Updated", status: "active" });

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubEvent.update).toHaveBeenCalled();
    expect(prismaMock.missionHubCalendarEntry.update).toHaveBeenCalled();
  });

  it("DELETE /events/:id archives event and calendar entry", async () => {
    const response = await request(app)
      .delete("/api/mission-hub/events/event-1")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(204);
    expect(prismaMock.missionHubEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event-1" },
        data: expect.objectContaining({ isActive: false, status: "archived" }),
      }),
    );
    expect(prismaMock.missionHubCalendarEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cal-1" },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it("GET /events scopes by organization and user", async () => {
    const response = await request(app)
      .get("/api/mission-hub/events")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          programDomain: "mission-hub",
          isActive: true,
        }),
      }),
    );
  });
});

  it("GET /tasks scopes by organization, user, and programDomain", async () => {
    const response = await request(app)
      .get("/api/mission-hub/tasks")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          programDomain: "mission-hub",
          isActive: true,
        }),
      }),
    );
  });

  it("POST /time-entries creates a scoped record", async () => {
    const response = await request(app)
      .post("/api/mission-hub/time-entries")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ person: "Casey", date: "2026-04-21", hours: 2.5, status: "Draft" });

    expect(response.status).toBe(201);
    expect(prismaMock.missionHubTimeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          programDomain: "mission-hub",
          person: "Casey",
        }),
      }),
    );
  });

  it("POST /timesheet-submissions prevents empty submission", async () => {
    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ entryIds: [], periodStart: "2026-04-01", periodEnd: "2026-04-15" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least one/i);
  });

  it("POST /timesheet-submissions submits selected draft entries and writes approval log", async () => {
    prismaMock.missionHubTimeEntry.findMany.mockResolvedValueOnce([
      { id: "time-1", hours: 2, status: "draft", payable: true, billable: false, volunteer: false, hourlyRate: 50 },
      { id: "time-2", hours: 3, status: "changes_requested", payable: false, billable: true, volunteer: true, hourlyRate: 60 },
    ]);

    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ entryIds: ["time-1", "time-2"], periodStart: "2026-04-01", periodEnd: "2026-04-15" });

    expect(response.status).toBe(201);
    expect(prismaMock.missionHubTimesheetSubmission.create).toHaveBeenCalledOnce();
    expect(prismaMock.missionHubTimeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "submitted",
          timesheetSubmissionId: "sub-1",
        }),
      }),
    );
    expect(prismaMock.missionHubTimesheetApprovalLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "submitted",
          timesheetSubmissionId: "sub-1",
        }),
      }),
    );
  });

  it("POST /timesheet-submissions/:id/approve denies non-finance role", async () => {
    const staffToken = jwt.sign(
      {
        userId: "user-9",
        email: "staff@example.com",
        role: "Staff",
        organizationId: "org-1",
        programDomain: "mission-hub",
      },
      JWT_SECRET,
    );

    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions/sub-1/approve")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ note: "ok" });

    expect(response.status).toBe(403);
  });

  it("POST /timesheet-submissions/:id/reject requires reason", async () => {
    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions/sub-1/reject")
      .set("Authorization", `Bearer ${authToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/reason is required/i);
  });

  it("POST /timesheet-submissions/:id/request-changes requires reason", async () => {
    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions/sub-1/request-changes")
      .set("Authorization", `Bearer ${authToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/reason is required/i);
  });

  it("POST /timesheet-submissions/:id/mark-processed requires approved status", async () => {
    prismaMock.missionHubTimesheetSubmission.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      status: "submitted",
      submittedByUserId: "user-2",
    });

    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions/sub-1/mark-processed")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ note: "paid" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/approved submissions/i);
  });

  it("POST /timesheet-submissions/:id/mark-processed succeeds for approved submission", async () => {
    prismaMock.missionHubTimesheetSubmission.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      status: "approved",
      submittedByUserId: "user-2",
    });

    const response = await request(app)
      .post("/api/mission-hub/timesheet-submissions/sub-1/mark-processed")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ note: "processed" });

    expect(response.status).toBe(200);
    expect(prismaMock.missionHubTimeEntry.updateMany).toHaveBeenCalled();
    expect(prismaMock.missionHubTimesheetApprovalLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "processed" }),
      }),
    );
  });

  it("PUT /time-entries/:id prevents editing locked approved entries", async () => {
    prismaMock.missionHubTimeEntry.findFirst.mockResolvedValueOnce({ id: "time-1", status: "approved" });

    const response = await request(app)
      .put("/api/mission-hub/time-entries/time-1")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ notes: "should fail" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/locked/i);
  });

  it("PUT /tasks/:id returns 404 when the scoped record is missing", async () => {
    prismaMock.missionHubTask.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .put("/api/mission-hub/tasks/missing")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ status: "Done" });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Task not found");
  });
});

// ---------------------------------------------------------------------------
// Personnel invite — route contract preservation
// ---------------------------------------------------------------------------

describe("Mission Hub Personnel invite route", () => {
  it("POST /personnel creates the personnel record even when sendInviteEmail returns false", async () => {
    sendInviteEmailMock.mockResolvedValueOnce(false);

    const response = await request(app)
      .post("/api/mission-hub/personnel")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        firstName: "Bob",
        lastName: "Smith",
        email: "bob@example.com",
        role: "Staff",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.missionHubPersonnel.create).toHaveBeenCalledOnce();
    expect(prismaMock.missionHubInvite.create).toHaveBeenCalledOnce();
    // emailSent: false is reflected in the response under the invite object
    expect(response.body.invite.emailSent).toBe(false);
  });

  it("POST /personnel sets emailSent=true in response when sendInviteEmail returns true", async () => {
    sendInviteEmailMock.mockResolvedValueOnce(true);

    const response = await request(app)
      .post("/api/mission-hub/personnel")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        firstName: "Alice",
        lastName: "Jones",
        email: "alice@example.com",
        role: "Staff",
      });

    expect(response.status).toBe(201);
    expect(response.body.invite.emailSent).toBe(true);
  });

  it("POST /personnel still calls sendInviteEmail (delegates to Core, not Resend directly)", async () => {
    await request(app)
      .post("/api/mission-hub/personnel")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        firstName: "Carol",
        lastName: "Lee",
        email: "carol@example.com",
        role: "Admin",
      });

    expect(sendInviteEmailMock).toHaveBeenCalledOnce();
    expect(sendInviteEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "carol@example.com",
        recipientName: "Carol Lee",
        organizationName: "Test Org",
      }),
    );
  });
});
