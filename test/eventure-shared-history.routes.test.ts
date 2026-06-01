import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureEvent: { findFirst: vi.fn() },
  eventureEventSponsor: { findMany: vi.fn() },
  eventureSponsorContact: { findMany: vi.fn() },
  eventParticipationHistory: { findMany: vi.fn() },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/middleware/auth.middleware.js", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../src/core/auth/auth.service.js", () => ({
  getRequestUser: () => ({ organizationId: "org-1", userId: "user-1", role: "admin", platformRole: "suite_admin" }),
}));

const { eventureHistoryRouter } = await import("../src/programs/eventure/routes/history.routes.js");
const { eventureSharedRouter } = await import("../src/programs/eventure/routes/shared.routes.js");

describe("eventure history + shared routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.eventureEvent.findFirst.mockResolvedValue({ id: "event-1" });
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([{ sponsorOrganizationId: "sponsor-1" }]);
    prismaMock.eventureSponsorContact.findMany.mockResolvedValue([{ id: "contact-1" }]);
    prismaMock.eventParticipationHistory.findMany.mockResolvedValue([
      {
        id: "hist-1",
        sourceEventYear: 2024,
        sourceEventName: "Classic 2024",
        rawCompanyName: "Acme",
        rawContactName: "Jane",
        participationType: "sponsor",
        sponsorshipPackage: "Gold",
        amountCommitted: { toString: () => "1000.00" },
        amountPaid: { toString: () => "500.00" },
        paymentStatus: "pending",
        rawPaymentStatus: null,
        sourceSheetName: "History",
        sourceImportBatchId: "batch-1",
        sourceRowNumber: 8,
        notes: "Legacy row",
        sponsorOrganization: { name: "Acme LLC" },
        sponsorContact: { name: "Jane Doe" },
      },
    ]);
  });

  it("returns event history payload from /events/:eventId/history", async () => {
    const app = express();
    app.use("/events/:eventId/history", eventureHistoryRouter);

    const res = await request(app).get("/events/event-1/history").expect(200);
    expect(res.body.related).toBeDefined();
    expect(res.body.archive).toBeDefined();
    expect(res.body.archive[0].company).toBe("Acme LLC");
  });

  it("blocks shared directory access when orgId query mismatches auth org", async () => {
    const app = express();
    app.use("/shared", eventureSharedRouter);

    const res = await request(app).get("/shared/sponsors?orgId=org-2").expect(403);
    expect(res.body.error).toMatch(/orgId/i);
  });
});
