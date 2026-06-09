import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock as never)),
  eventureImportRow: {
    findMany: vi.fn(),
  },
  eventureSponsorOrganization: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  eventureUnmatchedRevenue: {
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  eventurePayment: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  eventurePaymentHistory: {
    create: vi.fn(),
  },
  eventureParticipant: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  eventureAttendeeSlot: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventurePaymentTransaction: {
    create: vi.fn(),
  },
  eventurePaymentLineItem: {
    createMany: vi.fn(),
  },
}));

const confirmAttendeeImportForEventMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/programs/eventure/services/attendee-import.service.js", () => ({
  confirmAttendeeImportForEvent: confirmAttendeeImportForEventMock,
  previewAttendeeImportForEvent: vi.fn(),
}));

const { confirmParticipantRevenueImportForEvent } = await import("../src/programs/eventure/services/participant-revenue-import.service.js");

describe("eventure participant revenue import", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    confirmAttendeeImportForEventMock.mockResolvedValue({
      importType: "attendee_list",
      importScope: "EVENT",
      importFormat: "csv",
      summary: {
        attendeesCreated: 0,
        registrationsCreated: 0,
        attendeeSlotsCreated: 0,
        companiesCreated: 0,
        skippedRows: 0,
        ignoredRows: 0,
        duplicatesPrevented: 0,
        pendingParticipantRows: 0,
        unpaidAttendeesSkipped: 0,
        failedRows: 0,
      },
    });

    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        rawData: {
          "company (revenue file)": "Acme Corp",
          amount: "$1,250.00",
          description: "Deposit",
        },
        normalizedData: {
          suggestedCompany: {
            id: "company-1",
            name: "Acme Corp",
          },
        },
      },
    ]);

    prismaMock.eventureSponsorOrganization.findFirst.mockResolvedValue({ id: "company-1", name: "Acme Corp" });
    prismaMock.eventureSponsorOrganization.findUnique.mockResolvedValue({ id: "company-1", name: "Acme Corp" });
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-1",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-1",
      amountDue: 1250,
      amountPaid: 1250,
      balance: 0,
      paymentStatus: "confirmed",
      paymentMethod: null,
      paymentConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
      notes: "Deposit",
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "history-1" });
    prismaMock.eventurePaymentTransaction.create.mockResolvedValue({ id: "txn-1" });
    prismaMock.eventurePaymentLineItem.createMany.mockResolvedValue({ count: 1 });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureParticipant.findUnique.mockResolvedValue({
      id: "participant-1",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-1",
      companyName: "Acme Corp",
      attendeeCount: 0,
      flightAssignment: "PM",
    });
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(null);
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue({ id: "slot-1" });
    prismaMock.eventureAttendeeSlot.create.mockResolvedValue({ id: "slot-1" });
    prismaMock.eventureParticipant.create.mockResolvedValue({
      id: "participant-1",
      companyName: "Acme Corp",
      attendeeCount: 0,
      flightAssignment: "PM",
    });
    prismaMock.eventureParticipant.update.mockResolvedValue({ id: "participant-1" });
  });

  it("creates a confirmed payment for matched participant revenue rows", async () => {
    const result = await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
    });

    expect(prismaMock.eventurePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          eventId: "evt-1",
          contactCompanyId: "company-1",
          amountDue: 1250,
          amountPaid: 1250,
          balance: 0,
          paymentStatus: "confirmed",
          notes: "Deposit",
        }),
      }),
    );
    expect(prismaMock.eventurePaymentHistory.create).toHaveBeenCalled();
    expect(result.summary.paymentsUpserted).toBe(1);
  });

  it("sets paymentConfirmed=true on matched participant and reconciles attendee slots", async () => {
    prismaMock.eventureParticipant.findFirst.mockResolvedValue({
      id: "participant-1",
      companyName: "Acme Corp",
      attendeeCount: 3,
      flightAssignment: "PM",
    });
    prismaMock.eventureParticipant.update.mockResolvedValue({ id: "participant-1" });
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendeeSlot.createMany.mockResolvedValue({ count: 3 });

    const result = await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
    });

    expect(prismaMock.eventureParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "participant-1" },
        data: expect.objectContaining({ paymentConfirmed: true, paymentId: "payment-1" }),
      }),
    );
    expect(prismaMock.eventureAttendeeSlot.createMany).toHaveBeenCalled();
    expect(result.summary.participantsConfirmed).toBe(1);
  });

  it("uses row decision finalCompanyId override for payment company resolution", async () => {
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-2",
        rowNumber: 2,
        rawData: {
          "company (revenue file)": "Wrong Co",
          amount: "$300.00",
          description: "Override test",
        },
        normalizedData: {
          attendeeName: "Alex Example",
          attendeeEmail: "alex@example.com",
          suggestedCompany: {
            id: "company-old",
            name: "Wrong Co",
          },
        },
      },
    ]);
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-override",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-override",
      amountDue: 300,
      amountPaid: 300,
      balance: 0,
      paymentStatus: "confirmed",
      paymentMethod: null,
      paymentConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
      notes: "Override test",
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "history-override" });
    prismaMock.eventureSponsorOrganization.findFirst
      .mockResolvedValueOnce({ id: "company-override", name: "Override Co" })
      .mockResolvedValueOnce({ id: "company-old", name: "Wrong Co" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureParticipant.findUnique.mockResolvedValue({
      id: "participant-1",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-override",
      companyName: "Override Co",
      attendeeCount: 0,
      flightAssignment: "PM",
    });

    await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
      rowDecisions: [
        {
          importRowId: "row-2",
          decision: "assign_existing_company",
          finalCompanyId: "company-override",
        },
      ],
    });

    expect(prismaMock.eventurePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactCompanyId: "company-override",
          amountDue: 300,
          amountPaid: 300,
        }),
      }),
    );
  });

  it("does not process ignored rows for payment or unmatched revenue", async () => {
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-ignore",
        rowNumber: 8,
        rawData: {
          "company (revenue file)": "Ignored Co",
          amount: "$450.00",
          description: "Ignored revenue",
        },
        normalizedData: {
          suggestedCompany: {
            id: "company-ignore",
            name: "Ignored Co",
          },
        },
      },
    ]);

    const result = await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
      rowDecisions: [
        {
          importRowId: "row-ignore",
          decision: "ignore",
        },
      ],
    });

    expect(prismaMock.eventurePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.eventureUnmatchedRevenue.create).not.toHaveBeenCalled();
    expect(result.summary.revenueRowsConfirmed).toBe(0);
    expect(result.summary.paymentsUpserted).toBe(0);
    expect(result.summary.unmatchedRevenueRowsCreated).toBe(0);
  });

  it("sums split revenue amounts for a single revenue company", async () => {
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-split",
        rowNumber: 4,
        rawData: {
          "company (revenue file)": "CCI Group USA",
          amount: "4000 / 128",
          description: "Split revenue",
        },
        normalizedData: {
          attendeeName: "Chris Contact",
          attendeeEmail: "chris@example.com",
        },
        createdRegistrationId: "registration-1",
      },
    ]);
    prismaMock.eventureSponsorOrganization.findFirst.mockResolvedValue({ id: "company-cci", name: "CCI Group USA" });
    prismaMock.eventureSponsorOrganization.findUnique.mockResolvedValue({ id: "company-cci", name: "CCI Group USA" });
    prismaMock.eventureParticipant.findUnique.mockResolvedValue({
      id: "participant-1",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-cci",
      companyName: "CCI Group USA",
      attendeeCount: 0,
      flightAssignment: "PM",
    });

    await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
    });

    expect(prismaMock.eventurePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactCompanyId: "company-cci",
          amountDue: 4128,
          amountPaid: 4128,
        }),
      }),
    );
    expect(prismaMock.eventurePaymentLineItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ amount: 4000 }),
          expect.objectContaining({ amount: 128 }),
        ]),
      }),
    );
  });

  it("creates a revenue-only participant company from the revenue file instead of attendee matching", async () => {
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-revenue-only",
        rowNumber: 6,
        rawData: {
          "company (revenue file)": "Henry Ford Health",
          amount: "$10,000",
          description: "Sponsor revenue",
        },
        normalizedData: {
          attendeeName: "Old Suggested Name",
          suggestedCompany: {
            id: "company-wrong",
            name: "Wrong Suggested Company",
          },
        },
        createdRegistrationId: null,
      },
    ]);
    prismaMock.eventureSponsorOrganization.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.eventureSponsorOrganization.create.mockResolvedValue({ id: "company-henry", name: "Henry Ford Health" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureParticipant.findUnique.mockResolvedValue({
      id: "participant-1",
      organizationId: "org-1",
      eventId: "evt-1",
      contactCompanyId: "company-henry",
      companyName: "Henry Ford Health",
      attendeeCount: 0,
      flightAssignment: "PM",
    });

    await confirmParticipantRevenueImportForEvent({
      organizationId: "org-1",
      eventId: "evt-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
    });

    expect(prismaMock.eventureSponsorOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Henry Ford Health",
        }),
      }),
    );
    expect(prismaMock.eventureParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyName: "Henry Ford Health",
        }),
      }),
    );
  });
});