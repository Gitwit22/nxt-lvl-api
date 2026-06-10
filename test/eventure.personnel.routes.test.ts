import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventurePersonnel: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  eventureInvite: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
}));

const sendEventureInviteEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/middleware/auth.middleware.js", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../src/core/auth/auth.service.js", () => ({
  getRequestUser: () => ({
    userId: "admin-1",
    email: "admin@test.com",
    role: "admin",
    platformRole: "user",
    organizationId: "org-1",
    programDomain: "eventure",
  }),
}));

vi.mock("../src/core/services/email.service.js", () => ({
  sendEventurePersonnelInviteEmail: sendEventureInviteEmailMock,
}));

const { eventurePersonnelRouter } = await import("../src/programs/eventure/routes/personnel.routes.js");

const app = express();
app.use(express.json());
app.use("/api/eventure/personnel", eventurePersonnelRouter);

beforeEach(() => {
  vi.resetAllMocks();

  prismaMock.eventurePersonnel.findFirst.mockResolvedValue({
    id: "person-1",
    organizationId: "org-1",
    userId: null,
    name: "Jordan Drew",
    email: "jdrewhundley@miroundtable.org",
    programRole: null,
    inviteStatus: "none",
    notes: null,
    archivedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  });
  prismaMock.eventurePersonnel.findUnique.mockResolvedValue({
    id: "person-1",
    organizationId: "org-1",
    userId: null,
    name: "Jordan Drew",
    email: "jdrewhundley@miroundtable.org",
    programRole: null,
    inviteStatus: "invite_created",
    notes: null,
    archivedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  });
  prismaMock.eventureInvite.findFirst.mockResolvedValue(null);
  prismaMock.eventureInvite.create.mockResolvedValue({ id: "invite-1" });
  prismaMock.eventureInvite.update.mockResolvedValue({ id: "invite-1" });
  prismaMock.eventurePersonnel.update.mockResolvedValue({ id: "person-1", inviteStatus: "invite_created" });
  prismaMock.organization.findUnique.mockResolvedValue({ id: "org-1", name: "Test Org" });
  sendEventureInviteEmailMock.mockResolvedValue(false);
});

describe("POST /api/eventure/personnel", () => {
  it("recreates an invite when the personnel record exists but the invite row was deleted", async () => {
    const response = await request(app)
      .post("/api/eventure/personnel")
      .send({
        name: "Jordan Drew",
        email: "JDrewhundley@miroundtable.org",
      });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe("existing_invite_recreated");
    expect(response.body.invite.inviteId).toBe("invite-1");
    expect(prismaMock.eventureInvite.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1", personnelId: "person-1" },
    });
    expect(prismaMock.eventureInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          personnelId: "person-1",
          recipientEmail: "jdrewhundley@miroundtable.org",
          recipientName: "Jordan Drew",
          createdByAdminId: "admin-1",
        }),
      }),
    );
  });
});