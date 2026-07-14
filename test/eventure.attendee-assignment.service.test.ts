import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => {
  const txMock = {
    eventureAttendeeSlot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    eventureAttendee: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  return {
    ...txMock,
    $transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
  };
});

vi.mock("../src/core/db/prisma.js", () => ({ prisma: prismaMock }));

const {
  assignAttendeeToSlot,
  unassignAttendeeFromSlot,
  bulkFillSlots,
} = await import("../src/programs/eventure/services/attendee-assignment.service.js");

const ORG = "org-1";
const EVENT = "evt-1";
const PARTICIPANT = "part-1";
const USER = "user-1";

function slot(overrides = {}) {
  return {
    id: "slot-1", organizationId: ORG, eventId: EVENT, participantId: PARTICIPANT,
    slotNumber: 1, attendeeId: null, actualName: "Ford Slot 1", displayName: "Ford Slot 1",
    ...overrides,
  };
}

function attendee(overrides = {}) {
  return {
    id: "att-1", organizationId: ORG, fullName: "John Smith",
    firstName: "John", lastName: "Smith", email: "j@ford.com",
    normalizedEmail: "j@ford.com", phone: null, normalizedPhone: null,
    archivedAt: null, ...overrides,
  };
}

// ── assignAttendeeToSlot ──────────────────────────────────────────────────────

describe("assignAttendeeToSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock as any),
    );
  });

  it("assigns attendee to an open slot", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(slot());
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(attendee());
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue(slot({ attendeeId: "att-1" }));

    await assignAttendeeToSlot({ slotId: "slot-1", attendeeId: "att-1", eventId: EVENT, organizationId: ORG, userId: USER });

    expect(prismaMock.eventureAttendeeSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "slot-1" }, data: { attendeeId: "att-1" } }),
    );
  });

  it("throws 404 when slot not found", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(null);
    await expect(
      assignAttendeeToSlot({ slotId: "missing", attendeeId: "att-1", eventId: EVENT, organizationId: ORG }),
    ).rejects.toThrow("Slot not found");
  });

  it("throws 404 when attendee belongs to different org (cross-org blocked)", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(slot());
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(null); // org filter → not found
    await expect(
      assignAttendeeToSlot({ slotId: "slot-1", attendeeId: "att-other-org", eventId: EVENT, organizationId: ORG }),
    ).rejects.toThrow("Attendee not found");
  });

  it("throws 409 when attendee is already assigned to the same slot (duplicate blocked)", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(slot({ attendeeId: "att-1" }));
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(attendee());
    await expect(
      assignAttendeeToSlot({ slotId: "slot-1", attendeeId: "att-1", eventId: EVENT, organizationId: ORG }),
    ).rejects.toThrow("already assigned");
  });
});

// ── unassignAttendeeFromSlot ──────────────────────────────────────────────────

describe("unassignAttendeeFromSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock as any),
    );
  });

  it("clears attendeeId and preserves actualName (fallback name preserved)", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(slot({ attendeeId: "att-1", actualName: "John Smith" }));
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue(slot({ attendeeId: null, actualName: "John Smith" }));

    await unassignAttendeeFromSlot({ slotId: "slot-1", eventId: EVENT, organizationId: ORG });

    expect(prismaMock.eventureAttendeeSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attendeeId: null } }),
    );
    // actualName is NOT in the update payload — only attendeeId cleared
    const callData = prismaMock.eventureAttendeeSlot.update.mock.calls[0][0].data;
    expect(callData).not.toHaveProperty("actualName");
  });

  it("is a no-op when slot is already unassigned", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(slot({ attendeeId: null }));
    await unassignAttendeeFromSlot({ slotId: "slot-1", eventId: EVENT, organizationId: ORG });
    expect(prismaMock.eventureAttendeeSlot.update).not.toHaveBeenCalled();
  });

  it("throws 404 when slot does not belong to event", async () => {
    prismaMock.eventureAttendeeSlot.findFirst.mockResolvedValue(null);
    await expect(
      unassignAttendeeFromSlot({ slotId: "slot-1", eventId: "other-event", organizationId: ORG }),
    ).rejects.toThrow("Slot not found");
  });
});

// ── bulkFillSlots ─────────────────────────────────────────────────────────────

describe("bulkFillSlots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock as any),
    );
  });

  const rows = [
    { rowId: "r1", firstName: "John", lastName: "Smith", email: "j@ford.com", phone: null },
    { rowId: "r2", firstName: "Mary", lastName: "Jones", email: "m@ford.com", phone: null },
  ];

  it("assigns all rows and returns 'assigned' results", async () => {
    const openSlots = [
      slot({ id: "s1", slotNumber: 1 }),
      slot({ id: "s2", slotNumber: 2 }),
    ];
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue(openSlots);
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(null); // email lookup in identity service
    prismaMock.eventureAttendee.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendee.create.mockResolvedValueOnce(attendee({ id: "new-1" }))
      .mockResolvedValueOnce(attendee({ id: "new-2", email: "m@ford.com" }));
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue({});

    const results = await bulkFillSlots({
      participantId: PARTICIPANT, rows, eventId: EVENT, organizationId: ORG, userId: USER,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "assigned")).toBe(true);
  });

  it("rolls back atomically when a row fails and allowPartial is false", async () => {
    // Only one open slot but two rows → second row should cause failure
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([slot({ id: "s1", slotNumber: 1 })]);
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(null);
    prismaMock.eventureAttendee.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendee.create.mockResolvedValue(attendee({ id: "new-1" }));
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue({});

    // With allowPartial: false (default), second row having no slot throws
    await expect(
      bulkFillSlots({ participantId: PARTICIPANT, rows, eventId: EVENT, organizationId: ORG }),
    ).rejects.toThrow();
  });

  it("returns no_open_slot status for overflow rows when allowPartial is true", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([slot({ id: "s1", slotNumber: 1 })]);
    prismaMock.eventureAttendee.findFirst.mockResolvedValue(null);
    prismaMock.eventureAttendee.findMany.mockResolvedValue([]);
    prismaMock.eventureAttendee.create.mockResolvedValue(attendee({ id: "new-1" }));
    prismaMock.eventureAttendeeSlot.update.mockResolvedValue({});

    const results = await bulkFillSlots({
      participantId: PARTICIPANT, rows, eventId: EVENT, organizationId: ORG, allowPartial: true,
    });

    expect(results[0]?.status).toBe("assigned");
    expect(results[1]?.status).toBe("no_open_slot");
  });
});
