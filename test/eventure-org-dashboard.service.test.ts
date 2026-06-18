import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  programStorageSettings: { findUnique: vi.fn() },
  eventureEvent: { findMany: vi.fn() },
  eventureEventSponsor: { findMany: vi.fn() },
  eventureParticipant: { findMany: vi.fn() },
  eventureRegistration: { findMany: vi.fn() },
  eventureAttendeeSlot: { findMany: vi.fn() },
  eventurePayment: { findMany: vi.fn() },
  eventurePaymentTransaction: { findMany: vi.fn() },
  eventureEventVolunteerNeed: { findMany: vi.fn() },
  eventureEventVolunteerContact: { findMany: vi.fn() },
  eventureEventPersonnel: { findMany: vi.fn() },
  eventureImportBatch: { findMany: vi.fn() },
  eventureUnmatchedRevenue: { findMany: vi.fn() },
  eventPriceOption: { findMany: vi.fn() },
  eventParticipantPackage: { findMany: vi.fn() },
  eventureAuditLog: { findMany: vi.fn() },
};

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

const now = new Date("2026-06-17T12:00:00.000Z");

function resetMocks() {
  prismaMock.programStorageSettings.findUnique.mockResolvedValue({ settings: {} });
  prismaMock.eventureEvent.findMany.mockResolvedValue([]);
  prismaMock.eventureEventSponsor.findMany.mockResolvedValue([]);
  prismaMock.eventureParticipant.findMany.mockResolvedValue([]);
  prismaMock.eventureRegistration.findMany.mockResolvedValue([]);
  prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
  prismaMock.eventurePayment.findMany.mockResolvedValue([]);
  prismaMock.eventurePaymentTransaction.findMany.mockResolvedValue([]);
  prismaMock.eventureEventVolunteerNeed.findMany.mockResolvedValue([]);
  prismaMock.eventureEventVolunteerContact.findMany.mockResolvedValue([]);
  prismaMock.eventureEventPersonnel.findMany.mockResolvedValue([]);
  prismaMock.eventureImportBatch.findMany.mockResolvedValue([]);
  prismaMock.eventureUnmatchedRevenue.findMany.mockResolvedValue([]);
  prismaMock.eventPriceOption.findMany.mockResolvedValue([]);
  prismaMock.eventParticipantPackage.findMany.mockResolvedValue([]);
  prismaMock.eventureAuditLog.findMany.mockResolvedValue([]);
}

describe("OrgDashboardService.getSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    resetMocks();
  });

  it("excludes inactive events from active-event totals", async () => {
    prismaMock.eventureEvent.findMany.mockResolvedValue([
      {
        id: "event-active",
        title: "Active Event",
        status: "active",
        startDateTime: new Date("2026-06-28T00:00:00.000Z"),
        endDateTime: new Date("2026-06-28T23:59:59.000Z"),
        extendedInfo: {},
      },
      {
        id: "event-completed",
        title: "Completed Event",
        status: "completed",
        startDateTime: new Date("2026-05-01T00:00:00.000Z"),
        endDateTime: new Date("2026-05-01T23:59:59.000Z"),
        extendedInfo: {},
      },
    ]);

    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "s1",
        eventId: "event-active",
        sponsorOrganizationId: "company-a",
        committedAmount: 1000,
        amountPaid: 0,
        paymentStatus: "pending",
        logoStatus: "received",
        sponsorOrganization: {
          id: "company-a",
          name: "Company A",
          normalizedName: "company a",
          mainEmail: "a@example.com",
          mainPhone: "",
          logoUrl: "",
          contacts: [],
        },
      },
      {
        id: "s2",
        eventId: "event-completed",
        sponsorOrganizationId: "company-b",
        committedAmount: 9999,
        amountPaid: 0,
        paymentStatus: "pending",
        logoStatus: "received",
        sponsorOrganization: {
          id: "company-b",
          name: "Company B",
          normalizedName: "company b",
          mainEmail: "b@example.com",
          mainPhone: "",
          logoUrl: "",
          contacts: [],
        },
      },
    ]);

    prismaMock.eventurePaymentTransaction.findMany.mockResolvedValue([
      {
        id: "tx-1",
        eventId: "event-active",
        contactCompanyId: "company-a",
        referenceKey: "pmt-1",
        transactionType: "payment",
        status: "completed",
        totalAmount: 400,
        transactionAt: new Date("2026-06-18T00:00:00.000Z"),
        updatedAt: new Date("2026-06-18T00:00:00.000Z"),
      },
      {
        id: "tx-2",
        eventId: "event-completed",
        contactCompanyId: "company-b",
        referenceKey: "pmt-2",
        transactionType: "payment",
        status: "completed",
        totalAmount: 9999,
        transactionAt: new Date("2026-05-02T00:00:00.000Z"),
        updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      },
    ]);

    const { OrgDashboardService } = await import("../src/programs/eventure/services/org-dashboard.service.js");
    const summary = await OrgDashboardService.getSummary("org-1");

    expect(summary.activeEvents.count).toBe(1);
    expect(summary.financials.expectedRevenue).toBe(1000);
    expect(summary.financials.netCollected).toBe(400);
  });

  it("does not count contacts as participants", async () => {
    prismaMock.eventureEvent.findMany.mockResolvedValue([
      {
        id: "event-active",
        title: "Active Event",
        status: "active",
        startDateTime: new Date("2026-06-28T00:00:00.000Z"),
        endDateTime: new Date("2026-06-28T23:59:59.000Z"),
        extendedInfo: {},
      },
    ]);

    prismaMock.eventureParticipant.findMany.mockResolvedValue([
      {
        id: "participant-1",
        eventId: "event-active",
        contactCompanyId: "company-a",
        companyName: "Company A",
        paymentConfirmed: true,
        status: "active",
        attendeeCount: 2,
        flightAssignment: "AM",
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
      },
    ]);

    prismaMock.eventureRegistration.findMany.mockResolvedValue([
      {
        id: "reg-contact",
        eventId: "event-active",
        paymentStatus: "paid",
        contactCompanyId: "company-a",
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
      },
      {
        id: "reg-unpaid",
        eventId: "event-active",
        paymentStatus: "unpaid",
        contactCompanyId: null,
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
      },
    ]);

    const { OrgDashboardService } = await import("../src/programs/eventure/services/org-dashboard.service.js");
    const summary = await OrgDashboardService.getSummary("org-1");

    expect(summary.participation.companyParticipants).toBe(1);
    expect(summary.participation.individualParticipants).toBe(0);
    expect(summary.participation.totalParticipants).toBe(1);
  });

  it("calculates named and unnamed attendee slots correctly", async () => {
    prismaMock.eventureEvent.findMany.mockResolvedValue([
      {
        id: "event-active",
        title: "Active Event",
        status: "active",
        startDateTime: new Date("2026-06-28T00:00:00.000Z"),
        endDateTime: new Date("2026-06-28T23:59:59.000Z"),
        extendedInfo: {},
      },
    ]);

    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([
      {
        id: "slot-1",
        eventId: "event-active",
        participantId: "participant-1",
        actualName: "Alex Name",
        flightAssignment: "AM",
      },
      {
        id: "slot-2",
        eventId: "event-active",
        participantId: "participant-1",
        actualName: null,
        flightAssignment: "",
      },
    ]);

    const { OrgDashboardService } = await import("../src/programs/eventure/services/org-dashboard.service.js");
    const summary = await OrgDashboardService.getSummary("org-1");

    expect(summary.participation.totalSlots).toBe(2);
    expect(summary.participation.namedAttendees).toBe(1);
    expect(summary.participation.unnamedSlots).toBe(1);
  });
});
