import { describe, it, expect } from "vitest";
import XLSX from "xlsx";
import {
  ATTENDEE_POLICY_MESSAGE,
  inferPaymentStatus,
  parseYearValue,
  parseRowsForTests,
  parseWorkbookForTests,
  normalizeHeaders,
  cleanCell,
  normalizeCompanyName,
  detectFollowUps,
  isImportRecordManuallyEdited,
  validateRollbackConfirmationText,
} from "../src/programs/eventure/services/sponsor-import.service.js";

function buildWorkbookFixtureBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();

  const sponsorLevelRows = [
    ["Level", "Early Bird", "Regular", "Banner", "Sign", "Foursome", "Website", "Program Book", "COSC", "2026 Tribute"],
    ["Double Platinum/MVP", "$10000", "$11000", "Yes", "Yes", "2", "Yes", "Full", "Yes", "Yes"],
    ["Platinum", "$7500", "$8000", "Yes", "Yes", "2", "Yes", "Full", "Yes", "No"],
    ["Gold", "$5000", "$5500", "Yes", "Yes", "1", "Yes", "Half", "Yes", "No"],
    ["Silver", "$3500", "$4000", "No", "Yes", "1", "Yes", "Quarter", "No", "No"],
    ["Bronze", "$2500", "$3000", "No", "Yes", "1", "No", "Quarter", "No", "No"],
    ["Valet", "$1800", "$2000", "No", "No", "0", "No", "No", "No", "No"],
    ["Beverage Station", "$1600", "$1800", "No", "No", "0", "No", "No", "No", "No"],
    ["Meal Sponsor", "$3000", "$3500", "No", "No", "0", "Yes", "Half", "No", "No"],
    ["Bag Drop", "$1200", "$1400", "No", "No", "0", "No", "No", "No", "No"],
    ["Driving Range/Putting Green", "$1500", "$1700", "No", "No", "0", "No", "No", "No", "No"],
    ["Lucky Hole 13", "$1000", "$1200", "No", "No", "0", "No", "No", "No", "No"],
    ["Hole Sponsor", "$700", "$800", "No", "No", "0", "No", "No", "No", "No"],
    ["Youth Golfer", "$150", "$200", "No", "No", "0", "No", "No", "No", "No"],
  ];

  const sponsorsHeader = [
    "Company",
    "Street Address",
    "City, State, Zip Code",
    "Contact Email",
    "Contact Phone",
    "Representative",
    "Sponsorship Package",
    "2026 Flight",
    "Logo",
    "Names",
    "Status",
    "Point Person",
    "Notes",
    "2026 Amount",
    "2020 YR",
    "2021 YR",
    "2022 YR",
    "2023 YR",
    "2024 YR",
    "2025 YR",
    "2026 YR",
  ];

  const sponsorsRows: string[][] = [];
  for (let index = 1; index <= 175; index += 1) {
    sponsorsRows.push([
      `Company ${index}`,
      `${index} Main St`,
      "Charlotte, NC, 28202",
      `contact${index}@example.com`,
      `704555${String(index).padStart(4, "0")}`,
      `Rep ${index}`,
      "Gold",
      index % 2 === 0 ? "AM" : "PM",
      "received",
      "",
      "invoiced",
      "Team Ops",
      "",
      "$5000",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "$5000",
    ]);
  }
  sponsorsRows.push(["NEW CONTACTS BELOW.", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
  sponsorsRows.push(["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);

  const amFlightRows = [
    ["No.", "Company", "First Name", "Last Name", "Email", "Phone", "Start Hole"],
    ["1", "", "", "", "", "", "1"],
    ["2", "", "", "", "", "704-555-1000", "2"],
  ];

  const pmFlightRows = [
    ["No.", "Company", "First Name", "Last Name", "Email", "Phone", "Start Hole"],
    ["1", "", "", "", "", "", "10"],
  ];

  const volunteerRows = [
    ["Role", "Need", "Flight", "Starting At", "Rotation Time", "Notes"],
    ["Registration", "6 ppl", "AM", "7:00", "", "Front table"],
    ["Mobile Ticket Sales", "2 ppl as pair", "PM", "11:00", "", "Roaming"],
    ["Hole-in-one Contest Watchers", "2 ppl", "AM", "8:00", "", "Coverage"],
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sponsorLevelRows), "Sponsor Levels");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sponsorsHeader, ...sponsorsRows]), "Sponsors List");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(amFlightRows), "AM Flight");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(pmFlightRows), "PM Flight");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(volunteerRows), "Volunteers");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------------------
// cleanCell / null marker normalization
// ---------------------------------------------------------------------------
describe("cleanCell", () => {
  it.each(["", "n/a", "N/A", "na", "NA", "-", "--", "none", "None", "NONE", "null", "NULL"])(
    "returns empty string for blank marker %s",
    (marker) => {
      expect(cleanCell(marker)).toBe("");
    },
  );

  it("returns the value when it is meaningful", () => {
    expect(cleanCell("Acme Corp")).toBe("Acme Corp");
    expect(cleanCell("  trimmed  ")).toBe("trimmed");
  });

  it("returns empty string for undefined", () => {
    expect(cleanCell(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeCompanyName
// ---------------------------------------------------------------------------
describe("normalizeCompanyName", () => {
  it("strips legal suffixes", () => {
    expect(normalizeCompanyName("Acme Inc.")).toBe("acme");
    expect(normalizeCompanyName("Acme LLC")).toBe("acme");
    expect(normalizeCompanyName("Acme Corp")).toBe("acme");
    expect(normalizeCompanyName("Acme Corporation")).toBe("acme");
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeCompanyName("  Blue  Sky   Labs  ")).toBe("blue sky labs");
  });

  it("strips punctuation", () => {
    expect(normalizeCompanyName("O'Brien & Sons, Ltd.")).toBe("o brien sons");
  });
});

// ---------------------------------------------------------------------------
// normalizeHeaders (duplicate detection)
// ---------------------------------------------------------------------------
describe("normalizeHeaders", () => {
  it("returns headers unchanged when all are unique", () => {
    const result = normalizeHeaders(["Company", "Email", "Phone"]);
    expect(result).toEqual(["Company", "Email", "Phone"]);
  });

  it("appends __2 suffix to second occurrence of a duplicate header", () => {
    const result = normalizeHeaders(["2026 YR", "Email", "2026 YR"]);
    expect(result[0]).toBe("2026 YR");
    expect(result[2]).toBe("2026 YR__2");
  });

  it("handles three duplicates sequentially", () => {
    const result = normalizeHeaders(["A", "A", "A"]);
    expect(result).toEqual(["A", "A__2", "A__3"]);
  });

  it("is case-sensitive on the returned value but case-insensitive for dedup counting", () => {
    // normalizeHeader() lowercases before comparing
    const result = normalizeHeaders(["Notes", "NOTES"]);
    expect(result[0]).toBe("Notes");
    expect(result[1]).toBe("NOTES__2");
  });
});

// ---------------------------------------------------------------------------
// inferPaymentStatus
// ---------------------------------------------------------------------------
describe("inferPaymentStatus", () => {
  it('returns "paid_external" for "paid"', () => {
    expect(inferPaymentStatus({ statusRaw: "Paid" })).toBe("paid_external");
  });

  it('returns "paid_external" for "paid via kindful"', () => {
    expect(inferPaymentStatus({ statusRaw: "Paid via Kindful" })).toBe("paid_external");
  });

  it('returns "unknown" for "unpaid" — not a false positive', () => {
    expect(inferPaymentStatus({ statusRaw: "unpaid" })).toBe("unknown");
    expect(inferPaymentStatus({ notes: "still unpaid" })).toBe("unknown");
  });

  it('returns "invoiced" for "invoiced"', () => {
    expect(inferPaymentStatus({ statusRaw: "Invoiced" })).toBe("invoiced");
  });

  it('returns "invoice_needed" when notes say "need invoice"', () => {
    expect(inferPaymentStatus({ notes: "need invoice" })).toBe("invoice_needed");
    expect(inferPaymentStatus({ notes: "invoice needed" })).toBe("invoice_needed");
    expect(inferPaymentStatus({ notes: "asked if we can invoice" })).toBe("invoice_needed");
  });

  it('returns "pending_event_payment" for "to pay at event"', () => {
    expect(inferPaymentStatus({ statusRaw: "to pay at event" })).toBe("pending_event_payment");
  });

  it('returns "comped" for "comped"', () => {
    expect(inferPaymentStatus({ statusRaw: "comped" })).toBe("comped");
  });

  it('returns "unknown" for empty input', () => {
    expect(inferPaymentStatus({})).toBe("unknown");
    expect(inferPaymentStatus({ statusRaw: "", notes: "" })).toBe("unknown");
  });

  it('does not treat "invoiced" as "paid" (order check)', () => {
    // "invoiced" does NOT contain "paid", should resolve to "invoiced"
    expect(inferPaymentStatus({ statusRaw: "invoiced" })).toBe("invoiced");
  });
});

// ---------------------------------------------------------------------------
// parseYearValue
// ---------------------------------------------------------------------------
describe("parseYearValue", () => {
  it('x → participated_unknown_amount', () => {
    expect(parseYearValue("x").participationStatus).toBe("participated_unknown_amount");
    expect(parseYearValue("X").participationStatus).toBe("participated_unknown_amount");
  });

  it('New → new_prospect', () => {
    expect(parseYearValue("New").participationStatus).toBe("new_prospect");
    expect(parseYearValue("new").participationStatus).toBe("new_prospect");
    expect(parseYearValue("NEW").participationStatus).toBe("new_prospect");
  });

  it('dollar amount → participated_with_amount', () => {
    const result = parseYearValue("$500");
    expect(result.participationStatus).toBe("participated_with_amount");
    expect(result.amount).toBe(500);
  });

  it('number without dollar sign → participated_with_amount', () => {
    const result = parseYearValue("1000");
    expect(result.participationStatus).toBe("participated_with_amount");
    expect(result.amount).toBe(1000);
  });

  it('comma-formatted amount → participated_with_amount', () => {
    const result = parseYearValue("$1,500.00");
    expect(result.participationStatus).toBe("participated_with_amount");
    expect(result.amount).toBe(1500);
  });

  it('blank → no_known_participation', () => {
    expect(parseYearValue("").participationStatus).toBe("no_known_participation");
    expect(parseYearValue("   ").participationStatus).toBe("no_known_participation");
  });

  it('unrecognized text → participated_text', () => {
    expect(parseYearValue("TBD").participationStatus).toBe("participated_text");
  });
});

// ---------------------------------------------------------------------------
// detectFollowUps
// ---------------------------------------------------------------------------
describe("detectFollowUps", () => {
  const baseRow = {
    logoStatus: "logo received",
    attendeeNamesRaw: "John Doe, Jane Doe",
    paymentStatus: "paid_external",
    contactEmail: "sponsor@example.com",
    contactPhone: "5555550100",
    statusRaw: "",
    notes: "",
    pointPersonName: "Alice",
  };

  it("returns no follow-ups for a clean row", () => {
    expect(detectFollowUps(baseRow)).toHaveLength(0);
  });

  it("detects need_logo when logo status is missing", () => {
    const result = detectFollowUps({ ...baseRow, logoStatus: "" });
    expect(result.some((f) => f.type === "need_logo")).toBe(true);
  });

  it("detects need_logo when logo status text says 'need logo'", () => {
    const result = detectFollowUps({ ...baseRow, logoStatus: "need logo" });
    expect(result.some((f) => f.type === "need_logo")).toBe(true);
  });

  it("detects need_names when attendee names are blank", () => {
    const result = detectFollowUps({ ...baseRow, attendeeNamesRaw: "" });
    expect(result.some((f) => f.type === "need_names")).toBe(true);
  });

  it("detects need_invoice when paymentStatus is invoice_needed", () => {
    const result = detectFollowUps({ ...baseRow, paymentStatus: "invoice_needed" });
    expect(result.some((f) => f.type === "need_invoice")).toBe(true);
  });

  it("detects need_payment when notes mention 'unpaid'", () => {
    const result = detectFollowUps({ ...baseRow, notes: "still unpaid" });
    expect(result.some((f) => f.type === "need_payment")).toBe(true);
  });

  it("detects need_contact_info when both email and phone are missing", () => {
    const result = detectFollowUps({ ...baseRow, contactEmail: undefined, contactPhone: undefined });
    expect(result.some((f) => f.type === "need_contact_info")).toBe(true);
  });

  it("detects waiting_response when notes say 'waiting'", () => {
    const result = detectFollowUps({ ...baseRow, notes: "waiting on response" });
    expect(result.some((f) => f.type === "waiting_response")).toBe(true);
  });

  it("deduplicates follow-up types", () => {
    // Both empty logo + 'need logo' text would naively produce two need_logo entries
    const result = detectFollowUps({ ...baseRow, logoStatus: "need logo" });
    const logoFollowUps = result.filter((f) => f.type === "need_logo");
    expect(logoFollowUps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rollback safety helpers
// ---------------------------------------------------------------------------
describe("rollback safety helpers", () => {
  it("requires exact rollback confirmation text", () => {
    expect(validateRollbackConfirmationText("ROLLBACK IMPORT")).toBe(true);
    expect(validateRollbackConfirmationText("rollback import")).toBe(false);
    expect(validateRollbackConfirmationText("ROLLBACK IMPORT NOW")).toBe(false);
  });

  it("detects manual edits only when updated timestamp is meaningfully later", () => {
    const createdAt = new Date("2026-01-01T10:00:00.000Z");
    const sameTime = new Date("2026-01-01T10:00:00.000Z");
    const oneSecondLater = new Date("2026-01-01T10:00:01.000Z");
    const twoSecondsLater = new Date("2026-01-01T10:00:02.000Z");

    expect(isImportRecordManuallyEdited(createdAt, sameTime)).toBe(false);
    expect(isImportRecordManuallyEdited(createdAt, oneSecondLater)).toBe(false);
    expect(isImportRecordManuallyEdited(createdAt, twoSecondsLater)).toBe(true);
  });
});

describe("workbook import parsing", () => {
  const workbookBuffer = buildWorkbookFixtureBuffer();

  it("detects all expected workbook sheets in preview metadata", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    const keys = parsed.sheetPreview.map((sheet) => sheet.key).sort();
    expect(keys).toEqual(["amFlight", "pmFlight", "sponsorLevels", "sponsorsList", "volunteers"].sort());
  });

  it("parses sponsor levels with required package names and numeric prices", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    const packageNames = new Set(parsed.sponsorLevels.map((level) => level.name));
    const required = [
      "Double Platinum/MVP",
      "Platinum",
      "Gold",
      "Silver",
      "Bronze",
      "Valet",
      "Beverage Station",
      "Meal Sponsor",
      "Bag Drop",
      "Driving Range/Putting Green",
      "Lucky Hole 13",
      "Hole Sponsor",
      "Youth Golfer",
    ];

    for (const name of required) {
      expect(packageNames.has(name)).toBe(true);
    }

    expect(parsed.sponsorLevels.every((level) => typeof level.earlyBirdPrice === "number")).toBe(true);
    expect(parsed.sponsorLevels.every((level) => typeof level.regularPrice === "number")).toBe(true);
  });

  it("skips Sponsors List separator and blank rows and keeps 175 company rows", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    const sponsorRows = parseRowsForTests(parsed.sponsorsListCsv).rows;

    expect(sponsorRows).toHaveLength(175);
    expect(sponsorRows.some((row) => row.companyName.includes("NEW CONTACTS BELOW"))).toBe(false);
  });

  it("suppresses attendee creation signals when names are blank", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    const sponsorRows = parseRowsForTests(parsed.sponsorsListCsv).rows;

    expect(sponsorRows.every((row) => !row.attendeeNamesRaw)).toBe(true);
    expect(ATTENDEE_POLICY_MESSAGE.toLowerCase()).toContain("no attendee names found");
  });

  it("parses AM/PM flight slots as templates and flags phone-only rows for review", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    const amSlots = parsed.flightSlots.filter((slot) => slot.flight === "AM");
    const pmSlots = parsed.flightSlots.filter((slot) => slot.flight === "PM");

    expect(amSlots.length).toBeGreaterThan(0);
    expect(pmSlots.length).toBeGreaterThan(0);
    expect(parsed.flightSlots.some((slot) => slot.status === "needs_review" && !!slot.phone && !slot.firstName && !slot.lastName && !slot.companyName)).toBe(true);
    expect(parsed.flightSlots.some((slot) => slot.status === "empty")).toBe(true);
  });

  it("parses volunteers into staffing need rows rather than person records", () => {
    const parsed = parseWorkbookForTests(workbookBuffer);
    expect(parsed.volunteerNeeds.length).toBeGreaterThan(0);
    expect(parsed.volunteerNeeds.some((need) => need.roleName.toLowerCase().includes("registration"))).toBe(true);
    expect(parsed.volunteerNeeds.every((need) => typeof need.roleName === "string" && need.roleName.length > 0)).toBe(true);
  });
});
