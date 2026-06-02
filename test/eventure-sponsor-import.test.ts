import { describe, it, expect } from "vitest";
import {
  inferPaymentStatus,
  parseYearValue,
  normalizeHeaders,
  cleanCell,
  normalizeCompanyName,
  detectFollowUps,
  detectEmbeddedSponsorHistoryYears,
  parseEmbeddedSponsorHistoryRowsFromSponsorsListGrid,
  isImportRecordManuallyEdited,
  resolveSelectedTabs,
  validateRollbackConfirmationText,
  splitCityStateZip,
} from "../src/programs/eventure/services/sponsor-import.service.js";

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

// ---------------------------------------------------------------------------
// parseYearValue
// ---------------------------------------------------------------------------
describe("parseYearValue", () => {
  it('x → participated_unknown_amount', () => {
    expect(parseYearValue("x").participationStatus).toBe("participated_unknown_amount");
    expect(parseYearValue("X").participationStatus).toBe("participated_unknown_amount");
  });

  it('yes-like markers → participated_unknown_amount', () => {
    expect(parseYearValue("yes").participationStatus).toBe("participated_unknown_amount");
    expect(parseYearValue("Y").participationStatus).toBe("participated_unknown_amount");
    expect(parseYearValue("true").participationStatus).toBe("participated_unknown_amount");
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

describe("embedded sponsor history detection/parsing", () => {
  it("detects historical year headers with supported variants", () => {
    const years = detectEmbeddedSponsorHistoryYears([
      "Company",
      "2020 YR",
      "2021",
      "2022 Year",
      "2023 Yr.",
      "Notes",
    ]);

    expect(years).toEqual([2020, 2021, 2022, 2023]);
  });

  it("parses embedded sponsors-list history rows and keeps source metadata", () => {
    const parsed = parseEmbeddedSponsorHistoryRowsFromSponsorsListGrid({
      sheetName: "Sponsors List",
      grid: [
        ["Company", "Representative", "2020 YR", "2021", "2022 Year", "Names"],
        ["Acme Corp", "Eric", "x", "$4,000", "", ""],
      ],
    });

    expect(parsed.yearsDetected).toEqual([2020, 2021, 2022]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.rawCompanyName).toBe("Acme Corp");
    expect(parsed.rows[0]?.sourceSheetName).toBe("Sponsors List");
    expect(parsed.rows[0]?.sourceRowNumber).toBe(2);
    expect(parsed.rows[0]?.sourceEventYear).toBe(2020);
    expect(parsed.rows[0]?.participationType).toBe("sponsor");
    expect(parsed.rows[0]?.amountCommitted).toBeUndefined();
    expect(parsed.rows[1]?.sourceEventYear).toBe(2021);
    expect(parsed.rows[1]?.amountCommitted).toBe(4000);
    expect(parsed.rows[1]?.sourceRowHash).toBeTruthy();
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

describe("resolveSelectedTabs", () => {
  it("preserves legacy behavior when selectedTabs is missing", () => {
    const selected = resolveSelectedTabs();
    expect(selected.legacyMode).toBe(true);
    expect(selected.sponsorLevels).toBe(true);
    expect(selected.sponsorsList).toBe(true);
    expect(selected.amFlight).toBe(true);
    expect(selected.pmFlight).toBe(true);
    expect(selected.volunteers).toBe(true);
    expect(selected.history).toBe(true);
    expect(selected.historyFromSponsorsList).toBe(true);
    expect(selected.followUps).toBe(true);
    expect(selected.paymentStatus).toBe(true);
  });

  it("applies safe defaults for newly introduced tabs when payload is provided", () => {
    const selected = resolveSelectedTabs({ sponsorsList: true });
    expect(selected.legacyMode).toBe(false);
    expect(selected.sponsorLevels).toBe(true);
    expect(selected.sponsorsList).toBe(true);
    expect(selected.amFlight).toBe(true);
    expect(selected.pmFlight).toBe(true);
    expect(selected.volunteers).toBe(true);
    expect(selected.history).toBe(false);
    expect(selected.historyFromSponsorsList).toBe(false);
    expect(selected.followUps).toBe(false);
    expect(selected.paymentStatus).toBe(false);
  });

  it("forces sponsorsList for CSV sponsor imports when parsed rows exist", () => {
    const selected = resolveSelectedTabs(
      { sponsorsList: false, historyFromSponsorsList: true },
      { importFormat: "csv", importType: "sponsor_master_list", hasParsedRows: true },
    );

    expect(selected.legacyMode).toBe(false);
    expect(selected.sponsorsList).toBe(true);
    expect(selected.historyFromSponsorsList).toBe(true);
  });

  it("does not force sponsorsList for CSV imports when no rows were parsed", () => {
    const selected = resolveSelectedTabs(
      { sponsorsList: false },
      { importFormat: "csv", importType: "sponsor_master_list", hasParsedRows: false },
    );

    expect(selected.sponsorsList).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Year header regex variants including "2020 Y" format
// ---------------------------------------------------------------------------
describe("detectEmbeddedSponsorHistoryYears — extended variants", () => {
    it.each([
      ["2020 Y", 2020],
      ["2021 Y", 2021],
      ["2022 Yrs", 2022],
      ["2023 Years", 2023],
      ["2024 yr", 2024],
      ["2025 year", 2025],
      ["2020", 2020],
      ["2020 YR", 2020],
      ["2020 Year", 2020],
    ])("detects year from header '%s' → %i", (header, expected) => {
      const [year] = detectEmbeddedSponsorHistoryYears([header]);
      expect(year).toBe(expected);
    });

    it.each([
      "History 2020",
      "2020 Amount",
      "20201",
      "20 Y",
      "Representative",
      "Company",
    ])("does NOT detect year from header '%s'", (header) => {
      const years = detectEmbeddedSponsorHistoryYears([header]);
      expect(years).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // splitCityStateZip
  // ---------------------------------------------------------------------------
  describe("splitCityStateZip", () => {
    it("handles standard 'City, ST 12345' format", () => {
      const result = splitCityStateZip("Austin, TX 78701");
      expect(result.city).toBe("Austin");
      expect(result.state).toBe("TX");
      expect(result.zipCode).toBe("78701");
    });

    it("handles 'City, ST' without ZIP", () => {
      const result = splitCityStateZip("Austin, TX");
      expect(result.city).toBe("Austin");
      expect(result.state).toBe("TX");
      expect(result.zipCode).toBeUndefined();
    });

    it("handles city-only input", () => {
      const result = splitCityStateZip("Austin");
      expect(result.city).toBe("Austin");
      expect(result.state).toBeUndefined();
      expect(result.zipCode).toBeUndefined();
    });

    it("handles space-delimited 'City ST ZIP' without comma", () => {
      const result = splitCityStateZip("Austin TX 78701");
      expect(result.city).toBe("Austin");
      expect(result.state).toBe("TX");
      expect(result.zipCode).toBe("78701");
    });

    it("returns empty object for undefined/empty", () => {
      expect(splitCityStateZip(undefined)).toEqual({});
      expect(splitCityStateZip("")).toEqual({});
      expect(splitCityStateZip("  ")).toEqual({});
    });

    it("handles ZIP+4 format", () => {
      const result = splitCityStateZip("Austin, TX 78701-1234");
      expect(result.zipCode).toBe("78701-1234");
    });
  });
});
