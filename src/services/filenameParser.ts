/**
 * Filename Parser Service
 *
 * Extracts metadata from filenames and folder paths using rule-based parsing.
 * Priority order: folder path → filename → content fallback
 *
 * Detects:
 * - Year (e.g., 2024, 2023)
 * - Month (names, abbreviations, numeric patterns)
 * - Financial category (Funding vs Spending)
 * - Financial document type (Grant, Invoice, Receipt, etc.)
 * - Tags from keywords
 */

import type { FinancialCategory, FinancialDocumentType, FilenameParsedMetadata } from "@/types/document";
import { MONTH_NAMES } from "@/types/document";

// --- Month Detection ---

const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_NAMES_INDEXED = ["", ...MONTH_NAMES];

// --- Financial Category Keywords ---

const FUNDING_KEYWORDS = [
  "funding", "grant", "award", "donation", "donor", "contribution",
  "revenue", "income", "fundraising", "endowment", "subsidy",
  "sponsorship", "stipend",
];

const SPENDING_KEYWORDS = [
  "spending", "expense", "expenses", "invoice", "receipt", "payment",
  "purchase", "cost", "disbursement", "expenditure", "paid",
  "payroll", "reimbursement", "procurement", "vendor",
];

// --- Financial Document Type Keywords ---

const FINANCIAL_TYPE_KEYWORDS: Array<{
  type: FinancialDocumentType;
  keywords: string[];
}> = [
  { type: "Grant", keywords: ["grant", "award", "grant_award", "grant-award"] },
  { type: "Donation", keywords: ["donation", "donor", "contribution", "gift"] },
  { type: "Invoice", keywords: ["invoice", "inv", "bill"] },
  { type: "Receipt", keywords: ["receipt", "rcpt"] },
  { type: "Budget", keywords: ["budget", "budgetary"] },
  { type: "Expense Report", keywords: ["expense_report", "expense-report", "expensereport", "expense report"] },
  { type: "Bank Statement", keywords: ["bank_statement", "bank-statement", "bankstatement", "bank statement"] },
  { type: "Payroll", keywords: ["payroll", "salary", "wages"] },
  { type: "Tax Document", keywords: ["tax", "tax_document", "tax-document", "1099", "w2", "w-2"] },
  { type: "Reimbursement", keywords: ["reimbursement", "reimburse"] },
  { type: "Purchase Order", keywords: ["purchase_order", "purchase-order", "purchaseorder", "purchase order"] },
  { type: "Financial Summary", keywords: ["financial_summary", "financial-summary", "financialsummary", "financial summary", "summary"] },
  { type: "Audit", keywords: ["audit", "auditing"] },
];

/**
 * Extract year from a string using regex.
 * Looks for 4-digit years in the 2000-2099 range.
 */
export function extractYear(text: string): number | undefined {
  // Match 20xx patterns, handling word boundaries and common separators
  const matches = text.match(/(?:^|[\s_\-/\\.,;:()])?(20\d{2})(?:[\s_\-/\\.,;:()]|$)/g);
  if (matches && matches.length > 0) {
    const yearMatch = matches[0].match(/20\d{2}/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0], 10);
      if (year >= 2000 && year <= 2099) return year;
    }
  }
  return undefined;
}

/**
 * Extract month from a string.
 * Supports: full names, abbreviations, numeric month patterns (01-12).
 */
export function extractMonth(text: string): { month: number; monthName: string } | undefined {
  const lower = text.toLowerCase();

  // Try month names and abbreviations first (longest match first)
  const sortedNames = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    if (lower.includes(name)) {
      const month = MONTH_MAP[name];
      return { month, monthName: MONTH_NAMES_INDEXED[month] };
    }
  }

  // Try numeric month patterns: _MM_, -MM-, /MM/
  const numericMatch = text.match(/[_\-/](0[1-9]|1[0-2])[_\-/]/);
  if (numericMatch) {
    const month = parseInt(numericMatch[1], 10);
    return { month, monthName: MONTH_NAMES_INDEXED[month] };
  }

  // Try standalone two-digit month at start of string: MM_... or MM-...
  const startMatch = text.match(/^(0[1-9]|1[0-2])[_\-/]/);
  if (startMatch) {
    const month = parseInt(startMatch[1], 10);
    return { month, monthName: MONTH_NAMES_INDEXED[month] };
  }

  return undefined;
}

/**
 * Detect financial category from text keywords.
 */
export function detectFinancialCategory(text: string): FinancialCategory | undefined {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[\s_\-./\\]+/);

  let fundingScore = 0;
  let spendingScore = 0;

  for (const token of tokens) {
    if (FUNDING_KEYWORDS.includes(token)) fundingScore++;
    if (SPENDING_KEYWORDS.includes(token)) spendingScore++;
  }

  if (fundingScore > 0 && fundingScore >= spendingScore) return "Funding";
  if (spendingScore > 0) return "Spending";
  return undefined;
}

/**
 * Detect financial document type from text keywords.
 */
export function detectFinancialDocumentType(text: string): FinancialDocumentType | undefined {
  const lower = text.toLowerCase();

  for (const rule of FINANCIAL_TYPE_KEYWORDS) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword)) {
        return rule.type;
      }
    }
  }
  return undefined;
}

/**
 * Generate tags from parsed metadata.
 */
function generateTags(
  financialCategory?: FinancialCategory,
  financialDocumentType?: FinancialDocumentType,
  year?: number,
  month?: number,
  monthName?: string
): string[] {
  const tags: string[] = [];

  if (financialCategory) tags.push(financialCategory.toLowerCase());
  if (financialDocumentType) tags.push(financialDocumentType.toLowerCase());
  if (year) tags.push(String(year));
  if (monthName) tags.push(monthName.toLowerCase());

  return tags;
}

/**
 * Parse a folder path to extract metadata.
 * Handles patterns like /2024/March/Funding/ or /2025/January/Spending/
 */
export function parseFolderPath(folderPath: string): FilenameParsedMetadata {
  const year = extractYear(folderPath);
  const monthResult = extractMonth(folderPath);
  const financialCategory = detectFinancialCategory(folderPath);
  const financialDocumentType = detectFinancialDocumentType(folderPath);

  const tags = generateTags(
    financialCategory,
    financialDocumentType,
    year,
    monthResult?.month,
    monthResult?.monthName
  );

  const fieldsFound = [year, monthResult, financialCategory, financialDocumentType].filter(Boolean).length;
  const confidence = fieldsFound > 0 ? Math.min(fieldsFound * 0.25, 1.0) : 0;

  return {
    year,
    month: monthResult?.month,
    monthName: monthResult?.monthName,
    financialCategory,
    financialDocumentType,
    tags,
    confidence,
    source: "folder_path",
  };
}

/**
 * Parse a filename to extract metadata.
 * Handles patterns like:
 * - 2024_03_grant_funding.pdf
 * - March_2025_expense_report.xlsx
 * - 2023-11_invoice_utilities.pdf
 */
export function parseFilename(filename: string): FilenameParsedMetadata {
  // Remove the file extension for parsing
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "");

  const year = extractYear(nameWithoutExt);
  const monthResult = extractMonth(nameWithoutExt);
  const financialCategory = detectFinancialCategory(nameWithoutExt);
  const financialDocumentType = detectFinancialDocumentType(nameWithoutExt);

  const tags = generateTags(
    financialCategory,
    financialDocumentType,
    year,
    monthResult?.month,
    monthResult?.monthName
  );

  const fieldsFound = [year, monthResult, financialCategory, financialDocumentType].filter(Boolean).length;
  const confidence = fieldsFound > 0 ? Math.min(fieldsFound * 0.25, 1.0) : 0;

  return {
    year,
    month: monthResult?.month,
    monthName: monthResult?.monthName,
    financialCategory,
    financialDocumentType,
    tags,
    confidence,
    source: "filename",
  };
}

/**
 * Parse document content as a fallback for metadata extraction.
 * Uses keyword frequency to classify financial content.
 */
export function parseContent(text: string): FilenameParsedMetadata {
  const year = extractYear(text);
  const monthResult = extractMonth(text);
  const financialCategory = detectFinancialCategory(text);
  const financialDocumentType = detectFinancialDocumentType(text);

  const tags = generateTags(
    financialCategory,
    financialDocumentType,
    year,
    monthResult?.month,
    monthResult?.monthName
  );

  const fieldsFound = [year, monthResult, financialCategory, financialDocumentType].filter(Boolean).length;
  // Content-based parsing has lower base confidence
  const confidence = fieldsFound > 0 ? Math.min(fieldsFound * 0.15, 0.8) : 0;

  return {
    year,
    month: monthResult?.month,
    monthName: monthResult?.monthName,
    financialCategory,
    financialDocumentType,
    tags,
    confidence,
    source: "content",
  };
}

/**
 * Merge two parsed metadata results, preferring the higher-priority source.
 * Fields from the higher-priority source take precedence.
 * Missing fields are filled in from the lower-priority source.
 */
export function mergeParsedMetadata(
  primary: FilenameParsedMetadata,
  fallback: FilenameParsedMetadata
): FilenameParsedMetadata {
  return {
    year: primary.year ?? fallback.year,
    month: primary.month ?? fallback.month,
    monthName: primary.monthName ?? fallback.monthName,
    financialCategory: primary.financialCategory ?? fallback.financialCategory,
    financialDocumentType: primary.financialDocumentType ?? fallback.financialDocumentType,
    tags: [...new Set([...primary.tags, ...fallback.tags])],
    confidence: Math.max(primary.confidence, fallback.confidence),
    source: primary.confidence >= fallback.confidence ? primary.source : fallback.source,
  };
}

/**
 * Full metadata extraction pipeline.
 * Priority: folder path → filename → content
 */
export function extractFileMetadata(
  filename: string,
  folderPath?: string,
  content?: string
): FilenameParsedMetadata {
  // Priority 2: Filename (always parsed)
  const filenameResult = parseFilename(filename);

  // Priority 1: Folder path (overrides filename when available)
  let result = filenameResult;
  if (folderPath) {
    const pathResult = parseFolderPath(folderPath);
    result = mergeParsedMetadata(pathResult, filenameResult);
  }

  // Priority 3: Content fallback (only if filename/path was unclear)
  if (result.confidence < 0.5 && content) {
    const contentResult = parseContent(content);
    result = mergeParsedMetadata(result, contentResult);
  }

  return result;
}
