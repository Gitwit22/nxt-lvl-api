import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureEventSponsor: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  eventureImportBatch: {
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
  },
  eventureImportRow: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
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
    update: vi.fn(),
  },
  eventureAttendeeSlot: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/services/parse/documentParseService.js", () => ({
  canUseSharedParser: vi.fn(() => true),
  parseDocumentWithSharedService: vi.fn(),
}));

const {
  previewPaymentImportForEvent,
  confirmPaymentImportForEvent,
} = await import("../src/programs/eventure/services/payment-import.service.js");

describe("eventure payment import", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "event-sponsor-1",
        sponsorOrganization: {
          name: "Acme Corp",
        },
      },
    ]);
    prismaMock.eventureImportBatch.create.mockResolvedValue({
      id: "batch-1",
      fileType: "md",
      fileName: "payments.md",
      mappingConfig: {},
    });
    prismaMock.eventureImportRow.create
      .mockResolvedValueOnce({ id: "row-1", rowNumber: 1 })
      .mockResolvedValueOnce({ id: "row-2", rowNumber: 2 });
    prismaMock.eventureImportBatch.update.mockResolvedValue({ id: "batch-1" });
  });

  it("previews markdown payment imports with matched and unmatched rows", async () => {
    const preview = await previewPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      fileBuffer: Buffer.from([
        "| Company | Amount Paid | Payment Status | Notes |",
        "| --- | --- | --- | --- |",
        "| Acme Corp | $1,250.00 | Paid | Deposit received |",
        "| Missing Co | $500.00 | Invoiced | Follow up |",
      ].join("\n"), "utf8"),
      fileMimeType: "text/markdown",
      fileName: "payments.md",
    });

    expect(preview.importFormat).toBe("md");
    expect(preview.summary.totalRows).toBe(2);
    expect(preview.summary.matchedRows).toBe(1);
    expect(preview.summary.unmatchedRows).toBe(1);
    expect(preview.rows[0]?.decision).toBe("approve");
    expect(preview.rows[1]?.decision).toBe("skip");
  });

  it("matches a row by normalized company alias when the legal suffix differs", async () => {
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "event-sponsor-1",
        sponsorshipPackage: "Gold",
        paymentReference: null,
        sponsorOrganization: {
          name: "The Acme Corporation",
        },
      },
    ]);
    prismaMock.eventureImportRow.create.mockResolvedValue({ id: "row-1", rowNumber: 1 });

    const preview = await previewPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      csvContent: [
        "Company,Amount Paid,Payment Status",
        "Acme Corp,$750,Paid",
      ].join("\n"),
      fileName: "payments.csv",
    });

    expect(preview.summary.matchedRows).toBe(1);
    expect(preview.rows[0]?.matchedSponsor?.companyName).toBe("The Acme Corporation");
    expect(preview.rows[0]?.warnings).toContain("Matched by normalized company alias. Review before confirm if needed.");
  });

  it("matches a row by unique payment reference when company text does not match", async () => {
    prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
      {
        id: "event-sponsor-1",
        sponsorshipPackage: "Gold",
        paymentReference: "INV-42",
        sponsorOrganization: {
          name: "Different Legal Name LLC",
        },
      },
    ]);
    prismaMock.eventureImportRow.create.mockResolvedValue({ id: "row-1", rowNumber: 1 });

    const preview = await previewPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      csvContent: [
        "Company,Invoice Number,Amount Paid",
        "Acme Events,INV-42,$750",
      ].join("\n"),
      fileName: "payments.csv",
    });

    expect(preview.summary.matchedRows).toBe(1);
    expect(preview.rows[0]?.matchedSponsor?.companyName).toBe("Different Legal Name LLC");
    expect(preview.rows[0]?.warnings).toContain("Matched by unique payment reference. Review before confirm if needed.");
  });

  it("confirms approved matched payment rows", async () => {
    prismaMock.eventureImportBatch.findFirst.mockResolvedValue({
      id: "batch-1",
      organizationId: "org-1",
      eventId: "event-1",
      sourceType: "payment_import",
      status: "needs_review",
      fileType: "csv",
      fileName: "payments.csv",
      mappingConfig: {},
    });
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        normalizedData: {
          companyName: "Acme Corp",
          amountPaid: 1250,
          paymentStatus: "paid_external",
          paymentMethod: "Check",
          paymentReference: "INV-42",
          paymentNotes: "Deposit",
          matchedSponsor: {
            id: "event-sponsor-1",
            companyName: "Acme Corp",
            matchStatus: "Matched",
            confidence: 1,
          },
        },
      },
    ]);
    prismaMock.eventureEventSponsor.update.mockResolvedValue({
      id: "event-sponsor-1",
      organizationId: "org-1",
      eventId: "event-1",
      sponsorOrganizationId: "org-1",
      sponsorOrganization: { name: "Acme Corp" },
      attendeeCount: 0,
    });
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-1",
      paymentStatus: "confirmed",
      amountDue: 1250,
      amountPaid: 1250,
      balance: 0,
      paymentMethod: "Check",
      paymentReference: "INV-42",
      paymentConfirmedAt: new Date(),
      notes: "Deposit",
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "history-1" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureImportRow.update.mockResolvedValue({ id: "row-1" });

    const result = await confirmPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      importBatchId: "batch-1",
      rowDecisions: [{ importRowId: "row-1", decision: "approve" }],
    });

    expect(prismaMock.eventureEventSponsor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event-sponsor-1" },
        data: expect.objectContaining({
          amountPaid: 1250,
          paymentStatus: "paid_external",
          paymentMethod: "Check",
          paymentReference: "INV-42",
          paymentNotes: "Deposit",
        }),
      }),
    );
    expect(result.summary.importedRows).toBe(1);
    expect(result.updated).toEqual(["Acme Corp"]);
  });

  it("syncs EventurePayment and confirms participant when payment import row is approved", async () => {
    prismaMock.eventureImportBatch.findFirst.mockResolvedValue({
      id: "batch-2",
      organizationId: "org-1",
      eventId: "event-1",
      sourceType: "payment_import",
      status: "preview_ready",
      fileType: "csv",
      fileName: "payments.csv",
      mappingConfig: {},
    });
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        normalizedData: {
          companyName: "Beta Inc",
          amountPaid: 2000,
          paymentStatus: "confirmed",
          matchedSponsor: {
            id: "sponsor-beta",
            companyName: "Beta Inc",
            matchStatus: "Matched",
            confidence: 1,
          },
        },
      },
    ]);
    prismaMock.eventureEventSponsor.update.mockResolvedValue({
      id: "sponsor-beta",
      organizationId: "org-1",
      eventId: "event-1",
      sponsorOrganizationId: "company-beta",
      sponsorOrganization: { name: "Beta Inc" },
      attendeeCount: 2,
    });
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-beta",
      paymentStatus: "confirmed",
      amountDue: 2000,
      amountPaid: 2000,
      balance: 0,
      paymentMethod: null,
      paymentReference: null,
      paymentConfirmedAt: new Date(),
      notes: null,
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "hist-1" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue({
      id: "participant-beta",
      companyName: "Beta Inc",
      attendeeCount: 2,
      flightAssignment: "PM",
    });
    prismaMock.eventureParticipant.update.mockResolvedValue({ id: "participant-beta" });
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendeeSlot.createMany.mockResolvedValue({ count: 2 });
    prismaMock.eventureImportRow.update.mockResolvedValue({ id: "row-1" });

    const result = await confirmPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      importBatchId: "batch-2",
    });

    expect(prismaMock.eventurePayment.create).toHaveBeenCalled();
    expect(prismaMock.eventureParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "participant-beta" },
        data: expect.objectContaining({ paymentConfirmed: true, paymentId: "payment-beta" }),
      }),
    );
    expect(result.summary.paymentsSynced).toBe(1);
    expect(result.summary.participantsConfirmed).toBe(1);
    expect(result.summary.paymentSyncedWithoutParticipant).toBe(0);
  });

  it("counts paymentSyncedWithoutParticipant when no participant exists", async () => {
    prismaMock.eventureImportBatch.findFirst.mockResolvedValue({
      id: "batch-3",
      organizationId: "org-1",
      eventId: "event-1",
      sourceType: "payment_import",
      status: "preview_ready",
      fileType: "csv",
      fileName: "payments.csv",
      mappingConfig: {},
    });
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        normalizedData: {
          companyName: "Ghost Corp",
          amountPaid: 500,
          paymentStatus: "confirmed",
          matchedSponsor: {
            id: "sponsor-ghost",
            companyName: "Ghost Corp",
            matchStatus: "Matched",
            confidence: 1,
          },
        },
      },
    ]);
    prismaMock.eventureEventSponsor.update.mockResolvedValue({
      id: "sponsor-ghost",
      organizationId: "org-1",
      eventId: "event-1",
      sponsorOrganizationId: "company-ghost",
      sponsorOrganization: { name: "Ghost Corp" },
      attendeeCount: 0,
    });
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-ghost",
      paymentStatus: "confirmed",
      amountDue: 500,
      amountPaid: 500,
      balance: 0,
      paymentMethod: null,
      paymentReference: null,
      paymentConfirmedAt: new Date(),
      notes: null,
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "hist-2" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureImportRow.update.mockResolvedValue({ id: "row-1" });

    const result = await confirmPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      importBatchId: "batch-3",
    });

    expect(result.summary.paymentSyncedWithoutParticipant).toBe(1);
    expect(result.summary.participantsConfirmed).toBe(0);
  });

  it("uses edited normalized values to rematch sponsor and apply payment fields", async () => {
    prismaMock.eventureImportBatch.findFirst.mockResolvedValue({
      id: "batch-4",
      organizationId: "org-1",
      eventId: "event-1",
      sourceType: "payment_import",
      status: "preview_ready",
      fileType: "csv",
      fileName: "payments.csv",
      mappingConfig: {},
    });
    prismaMock.eventureImportRow.findMany.mockResolvedValue([
      {
        id: "row-1",
        rowNumber: 1,
        normalizedData: {
          companyName: "Acm Corp",
          amountPaid: 100,
          matchedSponsor: {
            id: "",
            companyName: "Acm Corp",
            matchStatus: "Unmatched",
            confidence: 0,
          },
        },
      },
    ]);
    prismaMock.eventureEventSponsor.update.mockResolvedValue({
      id: "event-sponsor-1",
      organizationId: "org-1",
      eventId: "event-1",
      sponsorOrganizationId: "company-1",
      sponsorOrganization: { name: "Acme Corp" },
      attendeeCount: 0,
    });
    prismaMock.eventurePayment.findFirst.mockResolvedValue(null);
    prismaMock.eventurePayment.create.mockResolvedValue({
      id: "payment-4",
      paymentStatus: "confirmed",
      amountDue: 900,
      amountPaid: 900,
      balance: 0,
      paymentMethod: "Wire",
      paymentReference: null,
      paymentConfirmedAt: new Date(),
      notes: "Edited in preview",
    });
    prismaMock.eventurePaymentHistory.create.mockResolvedValue({ id: "hist-4" });
    prismaMock.eventureParticipant.findFirst.mockResolvedValue(null);
    prismaMock.eventureImportRow.update.mockResolvedValue({ id: "row-1" });

    const result = await confirmPaymentImportForEvent({
      organizationId: "org-1",
      eventId: "event-1",
      createdByUserId: "user-1",
      importBatchId: "batch-4",
      rowDecisions: [
        {
          importRowId: "row-1",
          decision: "approve",
          editedNormalized: {
            companyName: "Acme Corp",
            amountPaid: 900,
            paymentStatus: "Paid",
            paymentMethod: "Wire",
            paymentNotes: "Edited in preview",
          },
        },
      ],
    });

    expect(prismaMock.eventureEventSponsor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event-sponsor-1" },
        data: expect.objectContaining({
          amountPaid: 900,
          paymentMethod: "Wire",
          paymentNotes: "Edited in preview",
        }),
      }),
    );
    expect(result.updated).toEqual(["Acme Corp"]);
    expect(result.summary.importedRows).toBe(1);
  });
});