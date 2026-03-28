import { describe, it, expect } from "vitest";
import {
  extractYear,
  extractMonth,
  detectFinancialCategory,
  detectFinancialDocumentType,
  parseFilename,
  parseFolderPath,
  parseContent,
  mergeParsedMetadata,
  extractFileMetadata,
} from "@/services/filenameParser";

describe("filenameParser", () => {
  describe("extractYear", () => {
    it("extracts year from standard format", () => {
      expect(extractYear("2024_03_grant_funding")).toBe(2024);
    });

    it("extracts year from hyphenated format", () => {
      expect(extractYear("2023-11_invoice_utilities")).toBe(2023);
    });

    it("extracts year from text with month name", () => {
      expect(extractYear("March_2025_expense_report")).toBe(2025);
    });

    it("returns undefined when no year is found", () => {
      expect(extractYear("grant_funding_document")).toBeUndefined();
    });

    it("does not match numbers outside 2000-2099", () => {
      expect(extractYear("document_1999_report")).toBeUndefined();
    });

    it("extracts first year when multiple years are present", () => {
      expect(extractYear("2024_to_2025_budget")).toBe(2024);
    });
  });

  describe("extractMonth", () => {
    it("extracts full month name", () => {
      const result = extractMonth("March_2025_expense_report");
      expect(result).toBeDefined();
      expect(result!.month).toBe(3);
      expect(result!.monthName).toBe("March");
    });

    it("extracts abbreviated month name", () => {
      const result = extractMonth("2024_jan_budget");
      expect(result).toBeDefined();
      expect(result!.month).toBe(1);
      expect(result!.monthName).toBe("January");
    });

    it("extracts numeric month with separators", () => {
      const result = extractMonth("2024_03_grant_funding");
      expect(result).toBeDefined();
      expect(result!.month).toBe(3);
      expect(result!.monthName).toBe("March");
    });

    it("extracts numeric month with hyphens", () => {
      const result = extractMonth("2023-11-invoice");
      expect(result).toBeDefined();
      expect(result!.month).toBe(11);
      expect(result!.monthName).toBe("November");
    });

    it("returns undefined when no month is found", () => {
      expect(extractMonth("2024_grant_funding")).toBeUndefined();
    });

    it("handles case insensitive month names", () => {
      const result = extractMonth("DECEMBER_2024_report");
      expect(result).toBeDefined();
      expect(result!.month).toBe(12);
    });

    it("extracts September abbreviation sept", () => {
      const result = extractMonth("sept_2024_payroll");
      expect(result).toBeDefined();
      expect(result!.month).toBe(9);
    });
  });

  describe("detectFinancialCategory", () => {
    it("detects Funding from grant keyword", () => {
      expect(detectFinancialCategory("2024_grant_award")).toBe("Funding");
    });

    it("detects Funding from donation keyword", () => {
      expect(detectFinancialCategory("donation_receipt_2024")).toBe("Funding");
    });

    it("detects Spending from invoice keyword", () => {
      expect(detectFinancialCategory("2024_invoice_utilities")).toBe("Spending");
    });

    it("detects Spending from expense keyword", () => {
      expect(detectFinancialCategory("march_2025_expense_report")).toBe("Spending");
    });

    it("detects Spending from payroll keyword", () => {
      expect(detectFinancialCategory("payroll_jan_2024")).toBe("Spending");
    });

    it("returns undefined when no financial keywords found", () => {
      expect(detectFinancialCategory("meeting_notes_2024")).toBeUndefined();
    });

    it("chooses Funding when both categories match but Funding is stronger", () => {
      expect(detectFinancialCategory("grant_funding_award")).toBe("Funding");
    });

    it("chooses Spending when Spending keywords dominate", () => {
      expect(detectFinancialCategory("invoice_payment_expense")).toBe("Spending");
    });
  });

  describe("detectFinancialDocumentType", () => {
    it("detects Grant type", () => {
      expect(detectFinancialDocumentType("2024_grant_award.pdf")).toBe("Grant");
    });

    it("detects Invoice type", () => {
      expect(detectFinancialDocumentType("invoice_utilities_2024.pdf")).toBe("Invoice");
    });

    it("detects Receipt type", () => {
      expect(detectFinancialDocumentType("receipt_office_supplies.pdf")).toBe("Receipt");
    });

    it("detects Budget type", () => {
      expect(detectFinancialDocumentType("annual_budget_2024.xlsx")).toBe("Budget");
    });

    it("detects Payroll type", () => {
      expect(detectFinancialDocumentType("payroll_march_2024.pdf")).toBe("Payroll");
    });

    it("detects Tax Document type", () => {
      expect(detectFinancialDocumentType("tax_document_2024.pdf")).toBe("Tax Document");
    });

    it("detects Audit type", () => {
      expect(detectFinancialDocumentType("audit_report_2024.pdf")).toBe("Audit");
    });

    it("returns undefined when no type matches", () => {
      expect(detectFinancialDocumentType("meeting_notes_2024.pdf")).toBeUndefined();
    });
  });

  describe("parseFilename", () => {
    it("parses 2024_03_grant_funding.pdf", () => {
      const result = parseFilename("2024_03_grant_funding.pdf");
      expect(result.year).toBe(2024);
      expect(result.month).toBe(3);
      expect(result.financialCategory).toBe("Funding");
      expect(result.financialDocumentType).toBe("Grant");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.source).toBe("filename");
    });

    it("parses March_2025_expense_report.xlsx", () => {
      const result = parseFilename("March_2025_expense_report.xlsx");
      expect(result.year).toBe(2025);
      expect(result.month).toBe(3);
      expect(result.financialCategory).toBe("Spending");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("parses 2023-11_invoice_utilities.pdf", () => {
      const result = parseFilename("2023-11_invoice_utilities.pdf");
      expect(result.year).toBe(2023);
      expect(result.month).toBe(11);
      expect(result.financialCategory).toBe("Spending");
      expect(result.financialDocumentType).toBe("Invoice");
    });

    it("generates appropriate tags", () => {
      const result = parseFilename("2024_03_grant_funding.pdf");
      expect(result.tags).toContain("funding");
      expect(result.tags).toContain("grant");
      expect(result.tags).toContain("2024");
      expect(result.tags).toContain("march");
    });

    it("handles unclear filenames gracefully", () => {
      const result = parseFilename("document.pdf");
      expect(result.confidence).toBe(0);
      expect(result.tags).toEqual([]);
    });
  });

  describe("parseFolderPath", () => {
    it("parses /2024/March/Funding/", () => {
      const result = parseFolderPath("/2024/March/Funding/");
      expect(result.year).toBe(2024);
      expect(result.month).toBe(3);
      expect(result.financialCategory).toBe("Funding");
      expect(result.source).toBe("folder_path");
    });

    it("parses /2025/January/Spending/", () => {
      const result = parseFolderPath("/2025/January/Spending/");
      expect(result.year).toBe(2025);
      expect(result.month).toBe(1);
      expect(result.financialCategory).toBe("Spending");
    });

    it("handles partial folder structure", () => {
      const result = parseFolderPath("/2024/documents/");
      expect(result.year).toBe(2024);
      expect(result.financialCategory).toBeUndefined();
    });
  });

  describe("parseContent", () => {
    it("detects invoice keywords in text", () => {
      const result = parseContent("Invoice number: 12345\nAmount due: $500\nVendor: ABC Corp\nDate: March 2024");
      expect(result.financialCategory).toBe("Spending");
      expect(result.financialDocumentType).toBe("Invoice");
      expect(result.year).toBe(2024);
      expect(result.month).toBe(3);
      expect(result.source).toBe("content");
    });

    it("detects grant keywords in text", () => {
      const result = parseContent("Grant award letter\nFunding amount: $50,000\nYear: 2025");
      expect(result.financialCategory).toBe("Funding");
      expect(result.financialDocumentType).toBe("Grant");
      expect(result.year).toBe(2025);
    });

    it("has lower confidence than filename parsing", () => {
      const contentResult = parseContent("invoice payment 2024");
      const filenameResult = parseFilename("2024_invoice_payment.pdf");
      expect(contentResult.confidence).toBeLessThan(filenameResult.confidence);
    });
  });

  describe("mergeParsedMetadata", () => {
    it("prefers primary source values", () => {
      const primary = parseFilename("2024_03_grant_funding.pdf");
      const fallback = parseContent("invoice payment 2023");
      const merged = mergeParsedMetadata(primary, fallback);
      expect(merged.year).toBe(2024);
      expect(merged.financialCategory).toBe("Funding");
    });

    it("fills missing fields from fallback", () => {
      const primary = parseFilename("document_2024.pdf");
      const fallback = parseContent("This invoice was for March 2024 utilities payment");
      const merged = mergeParsedMetadata(primary, fallback);
      expect(merged.year).toBe(2024);
      expect(merged.financialCategory).toBe("Spending");
      expect(merged.month).toBe(3);
    });

    it("merges tags without duplicates", () => {
      const primary = parseFilename("2024_grant_funding.pdf");
      const fallback = parseContent("grant funding award 2024");
      const merged = mergeParsedMetadata(primary, fallback);
      const uniqueTags = [...new Set(merged.tags)];
      expect(merged.tags.length).toBe(uniqueTags.length);
    });
  });

  describe("extractFileMetadata", () => {
    it("uses filename when no folder path", () => {
      const result = extractFileMetadata("2024_03_grant_funding.pdf");
      expect(result.year).toBe(2024);
      expect(result.month).toBe(3);
      expect(result.financialCategory).toBe("Funding");
    });

    it("uses folder path as primary when available", () => {
      const result = extractFileMetadata(
        "document.pdf",
        "/2024/March/Funding/"
      );
      expect(result.year).toBe(2024);
      expect(result.month).toBe(3);
      expect(result.financialCategory).toBe("Funding");
    });

    it("falls back to content when filename is unclear", () => {
      const result = extractFileMetadata(
        "document.pdf",
        undefined,
        "Invoice number 12345, payment for utilities, March 2024"
      );
      expect(result.financialCategory).toBe("Spending");
      expect(result.financialDocumentType).toBe("Invoice");
    });

    it("does not use content fallback when filename is clear", () => {
      const result = extractFileMetadata(
        "2024_03_grant_funding.pdf",
        undefined,
        "This is an invoice for payment"
      );
      // Filename clearly says Funding/Grant, should not be overridden by content
      expect(result.financialCategory).toBe("Funding");
      expect(result.financialDocumentType).toBe("Grant");
    });
  });
});
