import { beforeEach, describe, expect, it, vi } from "vitest";

// attendee-identity.service does not import prisma directly — it receives a `tx`
// parameter. We mock prisma.js here only to satisfy transitive imports if any.
vi.mock("../src/core/db/prisma.js", () => ({
  prisma: {
    eventureAttendee: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const {
  normalizeEmail,
  normalizePhone,
  isPlaceholderName,
  findMatchingAttendee,
  createOrUpdateAttendee,
} = await import("../src/programs/eventure/services/attendee-identity.service.js");

const ORG = "org-test-1";

// Each test gets its own fresh tx mock to avoid state bleeding
function makeTx(
  findFirstImpl: (...args: unknown[]) => unknown = () => Promise.resolve(null),
  findManyImpl: (...args: unknown[]) => unknown = () => Promise.resolve([]),
  createImpl: (...args: unknown[]) => unknown = () => Promise.resolve(null),
  updateImpl: (...args: unknown[]) => unknown = () => Promise.resolve(null),
) {
  return {
    eventureAttendee: {
      findFirst: vi.fn().mockImplementation(findFirstImpl),
      findMany: vi.fn().mockImplementation(findManyImpl),
      create: vi.fn().mockImplementation(createImpl),
      update: vi.fn().mockImplementation(updateImpl),
    },
  } as any;
}

function makeAttendee(overrides: Partial<{
  id: string; organizationId: string; firstName: string | null; lastName: string | null;
  fullName: string; email: string | null; normalizedEmail: string | null;
  phone: string | null; normalizedPhone: string | null; company: string | null;
  companyId: string | null; title: string | null; dietaryRestrictions: string | null;
  accessibilityNeeds: string | null; emergencyContact: null; archivedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}> = {}) {
  return {
    id: "att-1", organizationId: ORG, firstName: "John", lastName: "Smith",
    fullName: "John Smith", email: "john@ford.com", normalizedEmail: "john@ford.com",
    phone: "5551234567", normalizedPhone: "5551234567", company: "Ford",
    companyId: null, title: null, dietaryRestrictions: null, accessibilityNeeds: null,
    emergencyContact: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

// ── normalizeEmail ────────────────────────────────────────────────────────────

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  John@FORD.COM  ")).toBe("john@ford.com");
  });

  it("returns null for empty input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("same email with different casing normalizes to same value", () => {
    const a = normalizeEmail("Jane@Company.ORG");
    const b = normalizeEmail("jane@company.org");
    expect(a).toBe(b);
  });

  it("whitespace-only returns null", () => {
    expect(normalizeEmail("   ")).toBeNull();
  });
});

// ── normalizePhone ────────────────────────────────────────────────────────────

describe("normalizePhone", () => {
  it("strips formatting characters", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  });

  it("strips country prefix +1", () => {
    expect(normalizePhone("+15551234567")).toBe("5551234567");
  });

  it("strips 11-digit number starting with 1", () => {
    expect(normalizePhone("15551234567")).toBe("5551234567");
  });

  it("formatted and unformatted versions of same phone are equal", () => {
    expect(normalizePhone("(555) 123-4567")).toBe(normalizePhone("5551234567"));
  });

  it("returns null for empty input", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

// ── isPlaceholderName ─────────────────────────────────────────────────────────

describe("isPlaceholderName", () => {
  it("detects common placeholders", () => {
    expect(isPlaceholderName("Guest 1")).toBe(true);
    expect(isPlaceholderName("TBD")).toBe(true);
    expect(isPlaceholderName("tba")).toBe(true);
    expect(isPlaceholderName("Ford Golfer")).toBe(true);
    expect(isPlaceholderName("Seat 4")).toBe(true);
    expect(isPlaceholderName("Slot #2")).toBe(true);
    expect(isPlaceholderName("Attendee")).toBe(true);
    expect(isPlaceholderName("Placeholder")).toBe(true);
    expect(isPlaceholderName("Unknown")).toBe(true);
  });

  it("does not flag real names", () => {
    expect(isPlaceholderName("John Smith")).toBe(false);
    expect(isPlaceholderName("Mary Jones")).toBe(false);
    expect(isPlaceholderName("Robert Lee")).toBe(false);
  });

  it("treats empty / null / too short as placeholder", () => {
    expect(isPlaceholderName("")).toBe(true);
    expect(isPlaceholderName(null)).toBe(true);
    expect(isPlaceholderName(undefined)).toBe(true);
    expect(isPlaceholderName("J")).toBe(true);
  });
});

// ── findMatchingAttendee ──────────────────────────────────────────────────────

describe("findMatchingAttendee", () => {
  it("matches by normalised email (high confidence)", async () => {
    const att = makeAttendee();
    const tx = makeTx(() => Promise.resolve(att));
    const result = await findMatchingAttendee(tx, ORG, { email: "John@Ford.COM" });
    expect(result).not.toBeNull();
    expect(result?.matchReason).toBe("normalized_email");
    expect(result?.confidence).toBe("high");
  });

  it("matches by normalised phone when no email provided (high confidence)", async () => {
    const att = makeAttendee();
    // No email → email step skipped → first findFirst call is for phone
    const tx = makeTx(() => Promise.resolve(att));
    const result = await findMatchingAttendee(tx, ORG, { phone: "(555) 123-4567" });
    expect(result?.matchReason).toBe("normalized_phone");
    expect(result?.confidence).toBe("high");
  });

  it("matches by name+company when email and phone both miss (medium confidence)", async () => {
    const att = makeAttendee();
    const tx = makeTx(
      () => Promise.resolve(null),  // email → no match
      () => Promise.resolve([att]), // phone (findFirst skipped, reaches findMany name+company)
    );
    // Override: email findFirst returns null, phone findFirst returns null, findMany returns [att]
    const tx2 = {
      eventureAttendee: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([att]),
      },
    } as any;
    const result = await findMatchingAttendee(tx2, ORG, {
      firstName: "John", lastName: "Smith", company: "Ford",
    });
    expect(result?.matchReason).toBe("name_and_company");
    expect(result?.confidence).toBe("medium");
  });

  it("returns null when no match found", async () => {
    const tx = { eventureAttendee: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } } as any;
    const result = await findMatchingAttendee(tx, ORG, {
      firstName: "Unknown", lastName: "Person", company: "Nowhere",
    });
    expect(result).toBeNull();
  });

  it("blank email does not merge unrelated attendees (no email lookup performed)", async () => {
    const tx = { eventureAttendee: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } } as any;
    const result = await findMatchingAttendee(tx, ORG, {
      firstName: "Bob", lastName: "Jones", email: "", phone: "",
    });
    expect(result).toBeNull();
    // email step should have been skipped since normalizeEmail("") returns null
    expect(tx.eventureAttendee.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ normalizedEmail: expect.anything() }) }),
    );
  });
});

// ── createOrUpdateAttendee ────────────────────────────────────────────────────

describe("createOrUpdateAttendee", () => {
  it("creates a new attendee when no match exists", async () => {
    const created = makeAttendee({ id: "new-att" });
    const tx = {
      eventureAttendee: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn(),
      },
    } as any;

    const result = await createOrUpdateAttendee(tx, ORG, {
      firstName: "New", lastName: "Person", email: "new@co.com",
    }, "user-1");

    expect(result.action).toBe("created");
    expect(tx.eventureAttendee.create).toHaveBeenCalledOnce();
  });

  it("returns 'matched' action when existing attendee data is already complete", async () => {
    const att = makeAttendee();
    const tx = {
      eventureAttendee: {
        findFirst: vi.fn().mockResolvedValue(att),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(att), // same data → no change detected
      },
    } as any;

    const result = await createOrUpdateAttendee(tx, ORG, {
      email: "john@ford.com", firstName: "John", lastName: "Smith",
    }, "user-1");

    expect(result.action).toBe("matched");
  });

  it("returns 'updated' when new data enriches the existing record", async () => {
    const att = makeAttendee({ phone: null, normalizedPhone: null });
    const enriched = makeAttendee({ phone: "5559876543", normalizedPhone: "5559876543" });
    const tx = {
      eventureAttendee: {
        findFirst: vi.fn().mockResolvedValue(att),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(enriched),
      },
    } as any;

    const result = await createOrUpdateAttendee(tx, ORG, {
      email: "john@ford.com", phone: "555-987-6543",
    }, "user-1");

    expect(result.action).toBe("updated");
  });
});
