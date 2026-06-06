import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureAttendeeSlot: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

const { listAttendeesForEvent } = await import("../src/programs/eventure/services/workspace.service.js");

describe("eventure workspace service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists attendee slots scoped to organization and event", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);

    await listAttendeesForEvent("org-1", "evt-1");

    expect(prismaMock.eventureAttendeeSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          eventId: "evt-1",
        },
        orderBy: [
          { companyName: "asc" },
          { slotNumber: "asc" },
        ],
      }),
    );
  });
});