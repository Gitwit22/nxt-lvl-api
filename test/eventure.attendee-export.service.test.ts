import { describe, expect, it, vi } from "vitest";

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  eventureAttendeeSlot: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({ prisma: prismaMock }));

const { buildAttendeeExportRows, rowsToCSV } = await import(
  "../src/programs/eventure/services/attendee-export.service.js"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: "slot-1",
    organizationId: "org-1",
    eventId: "evt-1",
    participantId: "part-1",
    slotNumber: 1,
    companyName: "Ford",
    displayName: "Ford Slot 1",
    actualName: null,
    flightAssignment: "AM",
    checkedIn: false,
    mealPreference: "Chicken",
    dietaryOverride: null,
    tshirtSize: null,
    badgePrinted: false,
    representedCompanyId: null,
    companyNameSnapshot: null,
    attendeeId: "att-1",
    attendee: {
      id: "att-1",
      firstName: "John",
      lastName: "Smith",
      fullName: "John Smith",
      email: "john@ford.com",
      phone: "5551234567",
      company: "Ford Motor Company",
      title: "VP",
      dietaryRestrictions: "Vegetarian",
      accessibilityNeeds: null,
    },
    representedCompany: null,
    participant: {
      id: "part-1",
      companyName: "Ford",
      contactCompany: { name: "Ford Motor Co" },
    },
    ...overrides,
  };
}

// ── buildAttendeeExportRows ───────────────────────────────────────────────────

describe("buildAttendeeExportRows", () => {
  it("returns empty rows with correct columns when no slots exist", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([]);
    const { columns, rows } = await buildAttendeeExportRows("evt-1", "org-1", "attendee-contact-list");
    expect(rows).toHaveLength(0);
    expect(columns).toContain("First Name");
    expect(columns).toContain("Email");
  });

  it("flattens linked attendee contact fields into export row", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([slot()]);
    const { rows } = await buildAttendeeExportRows("evt-1", "org-1", "attendee-contact-list");
    expect(rows[0]?.["First Name"]).toBe("John");
    expect(rows[0]?.["Last Name"]).toBe("Smith");
    expect(rows[0]?.["Email"]).toBe("john@ford.com");
    expect(rows[0]?.["Phone"]).toBe("5551234567");
    expect(rows[0]?.["Participant/Sponsor"]).toBe("Ford Motor Co");
  });

  it("exports one row per attendee assignment (not per global attendee)", async () => {
    const slots = [
      slot({ id: "s1", slotNumber: 1, flightAssignment: "AM" }),
      slot({ id: "s2", slotNumber: 2, flightAssignment: "PM", attendeeId: "att-2",
        attendee: { id: "att-2", firstName: "Mary", lastName: "Jones", fullName: "Mary Jones",
          email: "m@ford.com", phone: null, company: "Ford", title: null,
          dietaryRestrictions: null, accessibilityNeeds: null } }),
    ];
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue(slots);
    const { rows } = await buildAttendeeExportRows("evt-1", "org-1", "flight-manifest");
    expect(rows).toHaveLength(2);
  });

  it("uses empty string for missing values — not null literal", async () => {
    const emptySlot = slot({
      attendee: { ...slot().attendee, email: null, phone: null, company: null },
    });
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([emptySlot]);
    const { rows } = await buildAttendeeExportRows("evt-1", "org-1", "attendee-contact-list");
    expect(rows[0]?.["Email"]).toBe("");
    expect(rows[0]?.["Phone"]).toBe("");
    expect(rows[0]?.["Current Company"]).toBe("");
  });

  it("check-in report includes check-in status column", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([slot({ checkedIn: true })]);
    const { columns, rows } = await buildAttendeeExportRows("evt-1", "org-1", "check-in-report");
    expect(columns).toContain("Check-In Status");
    expect(rows[0]?.["Check-In Status"]).toBe("Checked In");
  });

  it("meal-dietary report includes dietary restriction fields", async () => {
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([
      slot({ mealPreference: "Fish", dietaryOverride: "No nuts" }),
    ]);
    const { columns, rows } = await buildAttendeeExportRows("evt-1", "org-1", "meal-dietary");
    expect(columns).toContain("Dietary Restrictions");
    expect(columns).toContain("Dietary Override");
    expect(rows[0]?.["Meal Preference"]).toBe("Fish");
    expect(rows[0]?.["Dietary Override"]).toBe("No nuts");
    // Global dietary on attendee
    expect(rows[0]?.["Dietary Restrictions"]).toBe("Vegetarian");
  });

  it("slot meal override does NOT appear in the attendee's global dietary field", async () => {
    // This verifies the two fields are independent in the export
    prismaMock.eventureAttendeeSlot.findMany.mockResolvedValue([
      slot({ dietaryOverride: "Only chicken" }),
    ]);
    const { rows } = await buildAttendeeExportRows("evt-1", "org-1", "meal-dietary");
    // Global dietary restrictions come from attendee, not slot override
    expect(rows[0]?.["Dietary Restrictions"]).toBe("Vegetarian");
    expect(rows[0]?.["Dietary Override"]).toBe("Only chicken");
    expect(rows[0]?.["Dietary Restrictions"]).not.toBe("Only chicken");
  });
});

// ── rowsToCSV ─────────────────────────────────────────────────────────────────

describe("rowsToCSV", () => {
  it("generates a header row followed by data rows", () => {
    const columns = ["First Name", "Last Name", "Email"];
    const rows = [{ "First Name": "John", "Last Name": "Smith", "Email": "j@f.com" }];
    const csv = rowsToCSV(rows, columns);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("First Name,Last Name,Email");
    expect(lines[1]).toBe("John,Smith,j@f.com");
  });

  it("escapes commas inside cell values with double-quotes", () => {
    const columns = ["Name"];
    const rows = [{ Name: "Smith, John" }];
    const csv = rowsToCSV(rows, columns);
    expect(csv).toContain('"Smith, John"');
  });

  it("escapes double-quote characters inside cells", () => {
    const columns = ["Note"];
    const rows = [{ Note: 'Said "hello"' }];
    const csv = rowsToCSV(rows, columns);
    expect(csv).toContain('"Said ""hello"""');
  });

  it("outputs empty string for missing column values", () => {
    const columns = ["A", "B", "C"];
    const rows = [{ A: "x" }]; // B and C missing
    const csv = rowsToCSV(rows, columns);
    expect(csv.split("\n")[1]).toBe("x,,");
  });
});
