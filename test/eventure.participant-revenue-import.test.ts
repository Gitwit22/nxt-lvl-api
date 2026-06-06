import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureImportRow: {
    findMany: vi.fn(),
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
        failedRows: 0,
      },
    });

    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        rawData: {
          company: "Acme Corp",
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
});