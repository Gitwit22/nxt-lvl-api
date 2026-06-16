import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = {
  eventureEventSponsor: { findMany: vi.fn() },
  eventureSponsorOrganization: { findMany: vi.fn() },
  eventureParticipant: { findMany: vi.fn() },
  eventureAttendeeSlot: { findMany: vi.fn() },
  eventureSponsorFollowUp: { findMany: vi.fn() },
  eventurePayment: { findMany: vi.fn() },
  eventurePaymentTransaction: { findMany: vi.fn() },
  eventureImportRow: { findMany: vi.fn() },
};

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

describe("EventReportingService.getSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts completed external payments, excludes voided, and applies refunds", async () => {
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "sponsor-1",
        sponsorOrganizationId: "company-1",
        paymentStatus: "paid",
        committedAmount: 1000,
        amountPaid: 1000,
        statusRaw: null,
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureSponsorOrganization.findMany.mockResolvedValue([
      { id: "company-1", name: "Company A" },
    ]);
    prismaMock.eventureParticipant.findMany.mockResolvedValue([
      {
        id: "participant-1",
        contactCompanyId: "company-1",
        companyName: "Company A",
        paymentConfirmed: true,
        attendeeCount: 2,
        updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([
      { id: "slot-1", participantId: "participant-1", actualName: "A One", displayName: "A One", checkedIn: false, flightAssignment: "AM" },
      { id: "slot-2", participantId: "participant-1", actualName: null, displayName: "Placeholder", checkedIn: false, flightAssignment: "AM" },
    ]);
    prismaMock.eventureSponsorFollowUp.findMany.mockResolvedValue([
      { id: "fu-1", status: "open" },
      { id: "fu-2", status: "resolved" },
    ]);
    prismaMock.eventurePayment.findMany.mockResolvedValue([]);
    prismaMock.eventurePaymentTransaction.findMany.mockResolvedValue([
      {
        id: "tx-1",
        contactCompanyId: "company-1",
        status: "completed",
        transactionType: "payment",
        totalAmount: 1000,
        source: "external",
        transactionAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: "tx-2",
        contactCompanyId: "company-1",
        status: "voided",
        transactionType: "payment",
        totalAmount: 200,
        source: "external",
        transactionAt: new Date("2026-01-03T01:00:00.000Z"),
      },
      {
        id: "tx-3",
        contactCompanyId: "company-1",
        status: "completed",
        transactionType: "refund",
        totalAmount: 100,
        source: "external",
        transactionAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      { id: "row-1", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);

    const { EventReportingService } = await import("../src/programs/eventure/services/event-reporting.service.js");
    const report = await EventReportingService.getSummary("org-1", "event-1", {});

    expect(report.totals.expectedRevenue).toBe(1000);
    expect(report.totals.collectedRevenue).toBe(900);
    expect(report.totals.outstandingRevenue).toBe(100);
    expect(report.totals.paidSponsors).toBe(1);
    expect(report.totals.namedAttendees).toBe(1);
    expect(report.totals.missingAttendeeNames).toBe(1);
    expect(report.totals.openCriticalFollowUps).toBe(1);
    expect(report.records[0]?.companyName).toBe("Company A");
    expect(report.totals.collectionRate).toBeCloseTo(0.9, 6);
  });

  it("excludes unknown-classified sponsors from expected KPI totals and reports exceptions", async () => {
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "sponsor-unknown",
        sponsorOrganizationId: "company-x",
        paymentStatus: "unknown",
        committedAmount: null,
        amountPaid: null,
        statusRaw: null,
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        id: "sponsor-known",
        sponsorOrganizationId: "company-y",
        paymentStatus: "paid",
        committedAmount: 500,
        amountPaid: 500,
        statusRaw: null,
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureSponsorOrganization.findMany.mockResolvedValue([
      { id: "company-x", name: "Unknown Co" },
      { id: "company-y", name: "Known Co" },
    ]);
    prismaMock.eventureParticipant.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    prismaMock.eventureSponsorFollowUp.findMany.mockResolvedValue([]);
    prismaMock.eventurePayment.findMany.mockResolvedValue([]);
    prismaMock.eventurePaymentTransaction.findMany.mockResolvedValue([
      {
        id: "tx-y",
        contactCompanyId: "company-y",
        status: "completed",
        transactionType: "payment",
        totalAmount: 500,
        source: "internal",
        transactionAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureImportRow.findMany.mockResolvedValue([]);

    const { EventReportingService } = await import("../src/programs/eventure/services/event-reporting.service.js");
    const report = await EventReportingService.getSummary("org-1", "event-1", {});

    expect(report.totals.expectedRevenue).toBe(500);
    expect(report.exceptions.some((issue) => issue.recordId === "sponsor-unknown")).toBe(true);
  });

  it("clamps collected and outstanding totals when refunds exceed completed payments", async () => {
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "sponsor-1",
        sponsorOrganizationId: "company-1",
        paymentStatus: "paid",
        committedAmount: 100,
        amountPaid: 0,
        statusRaw: null,
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureSponsorOrganization.findMany.mockResolvedValue([
      { id: "company-1", name: "Company A" },
    ]);
    prismaMock.eventureParticipant.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    prismaMock.eventureSponsorFollowUp.findMany.mockResolvedValue([]);
    prismaMock.eventurePayment.findMany.mockResolvedValue([]);
    prismaMock.eventurePaymentTransaction.findMany.mockResolvedValue([
      {
        id: "tx-1",
        contactCompanyId: "company-1",
        status: "completed",
        transactionType: "payment",
        totalAmount: 50,
        source: "external",
        transactionAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        id: "tx-2",
        contactCompanyId: "company-1",
        status: "completed",
        transactionType: "refund",
        totalAmount: 75,
        source: "external",
        transactionAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    prismaMock.eventureImportRow.findMany.mockResolvedValue([]);

    const { EventReportingService } = await import("../src/programs/eventure/services/event-reporting.service.js");
    const report = await EventReportingService.getSummary("org-1", "event-1", {});

    expect(report.totals.expectedRevenue).toBe(100);
    expect(report.totals.collectedRevenue).toBe(0);
    expect(report.totals.outstandingRevenue).toBe(100);
    expect(report.totals.collectionRate).toBe(0);
  });
});
