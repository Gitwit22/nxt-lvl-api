import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../src/core/config/env.js";

const prismaMock = vi.hoisted(() => ({
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

  prismaMock.missionHubTask.findMany.mockResolvedValue([]);
  prismaMock.missionHubTask.create.mockResolvedValue({ id: "task-1", title: "Task" });
  prismaMock.missionHubTask.findFirst.mockResolvedValue({ id: "task-1" });
  prismaMock.missionHubTask.update.mockResolvedValue({ id: "task-1" });

  prismaMock.missionHubTimeEntry.findMany.mockResolvedValue([]);
  prismaMock.missionHubTimeEntry.create.mockResolvedValue({ id: "time-1", person: "Casey", date: "2026-04-21" });
  prismaMock.missionHubTimeEntry.findFirst.mockResolvedValue({ id: "time-1" });
  prismaMock.missionHubTimeEntry.update.mockResolvedValue({ id: "time-1" });

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
