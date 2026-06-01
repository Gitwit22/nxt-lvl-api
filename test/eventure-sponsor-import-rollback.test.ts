import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureImportBatch: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  eventureImportRow: {
    updateMany: vi.fn(),
  },
  eventureSponsorOrganization: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureSponsorContact: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureEventSponsor: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureSponsorYearHistory: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureSponsorFollowUp: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureSponsorshipPackage: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureEventFlightSlot: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureEventVolunteerNeed: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  eventureAuditLog: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

const serviceModule = await import("../src/programs/eventure/services/sponsor-import.service.js");

const {
  previewSponsorImportRollback,
  rollbackSponsorImportBatch,
  validateRollbackConfirmationText,
} = serviceModule;

function mockTxResult<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function baseRecord(id: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  prismaMock.eventureImportBatch.findFirst.mockResolvedValue({
    id: "batch-1",
    organizationId: "org-1",
    eventId: "event-1",
    status: "confirmed",
  });

  prismaMock.eventureSponsorOrganization.findMany.mockResolvedValue([
    {
      ...baseRecord("org-sponsor-1"),
      name: "Alpha Co",
    },
  ]);
  prismaMock.eventureSponsorContact.findMany.mockResolvedValue([
    {
      ...baseRecord("contact-1"),
      name: "Jane Doe",
      sponsorOrganizationId: "org-sponsor-1",
    },
  ]);
  prismaMock.eventureEventSponsor.findMany.mockResolvedValue([
    {
      ...baseRecord("event-sponsor-1"),
      eventId: "event-1",
      sponsorOrganizationId: "org-sponsor-1",
    },
  ]);
  prismaMock.eventureSponsorYearHistory.findMany.mockResolvedValue([
    {
      id: "history-1",
      sponsorOrganizationId: "org-sponsor-1",
      year: 2026,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
    },
  ]);
  prismaMock.eventureSponsorFollowUp.findMany.mockResolvedValue([
    {
      ...baseRecord("followup-1"),
      title: "Need logo",
      status: "open",
    },
  ]);
  prismaMock.eventureSponsorshipPackage.findMany.mockResolvedValue([baseRecord("pkg-1")]);
  prismaMock.eventureEventFlightSlot.findMany.mockResolvedValue([baseRecord("slot-1")]);
  prismaMock.eventureEventVolunteerNeed.findMany.mockResolvedValue([baseRecord("need-1")]);

  prismaMock.eventureSponsorContact.count.mockResolvedValue(0);
  prismaMock.eventureEventSponsor.count.mockResolvedValue(0);
  prismaMock.eventureSponsorYearHistory.count.mockResolvedValue(0);
  prismaMock.eventureSponsorFollowUp.count.mockResolvedValue(0);

  prismaMock.eventureSponsorFollowUp.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureEventSponsor.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureSponsorYearHistory.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureSponsorContact.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureSponsorshipPackage.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureEventFlightSlot.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureEventVolunteerNeed.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureSponsorOrganization.updateMany.mockResolvedValue({ count: 1 });

  prismaMock.eventureImportRow.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.eventureImportBatch.update.mockResolvedValue({ id: "batch-1", status: "rolled_back" });
  prismaMock.eventureAuditLog.create.mockResolvedValue({ id: "audit-1" });

  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) => {
    const result = cb(prismaMock);
    return mockTxResult(result);
  });
});

describe("eventure sponsor import rollback", () => {
  it("validates exact confirmation text helper", () => {
    expect(validateRollbackConfirmationText("ROLLBACK IMPORT")).toBe(true);
    expect(validateRollbackConfirmationText("rollback import")).toBe(false);
  });

  it("returns rollback preview counts and archive recommendation", async () => {
    const preview = await previewSponsorImportRollback({
      organizationId: "org-1",
      eventId: "event-1",
      importBatchId: "batch-1",
      role: "uploader",
      platformRole: "user",
    });

    expect(preview.importBatchId).toBe("batch-1");
    expect(preview.canRollback).toBe(true);
    expect(preview.recommendedMode).toBe("archive");
    expect(preview.hardDeleteAllowed).toBe(false);
    expect(preview.counts.sponsorOrganizations).toBe(1);
    expect(preview.counts.sponsorContacts).toBe(1);
    expect(preview.counts.eventSponsors).toBe(1);
    expect(preview.counts.sponsorYearHistory).toBe(1);
    expect(preview.counts.sponsorFollowUps).toBe(1);
  });

  it("rejects rollback when confirmation text is wrong", async () => {
    await expect(
      rollbackSponsorImportBatch({
        organizationId: "org-1",
        eventId: "event-1",
        importBatchId: "batch-1",
        mode: "archive",
        confirmationText: "ROLLBACK",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects hard delete for non-admin roles", async () => {
    await expect(
      rollbackSponsorImportBatch({
        organizationId: "org-1",
        eventId: "event-1",
        importBatchId: "batch-1",
        mode: "hard_delete",
        confirmationText: "ROLLBACK IMPORT",
        actorRole: "uploader",
        actorPlatformRole: "user",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("archives imported records and marks batch rolled_back", async () => {
    const result = await rollbackSponsorImportBatch({
      organizationId: "org-1",
      eventId: "event-1",
      importBatchId: "batch-1",
      mode: "archive",
      confirmationText: "ROLLBACK IMPORT",
      actorUserId: "user-1",
      actorRole: "admin",
      actorPlatformRole: "suite_admin",
    });

    expect(result.status).toBe("rolled_back");
    expect(result.mode).toBe("archive");
    expect(prismaMock.eventureSponsorFollowUp.updateMany).toHaveBeenCalled();
    expect(prismaMock.eventureEventSponsor.updateMany).toHaveBeenCalled();
    expect(prismaMock.eventureImportRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ importBatchId: "batch-1" }),
      }),
    );
    expect(prismaMock.eventureImportBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "batch-1" },
        data: expect.objectContaining({
          rollbackMode: "archive",
          status: "rolled_back",
        }),
      }),
    );
  });
});
