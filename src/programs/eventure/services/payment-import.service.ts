import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { Prisma } from "@prisma/client";
import XLSX from "xlsx";

import { prisma } from "../../../core/db/prisma.js";
import { canUseSharedParser, parseDocumentWithSharedService } from "../../../core/services/parse/documentParseService.js";
import { EventureServiceError } from "./eventure-error.js";
import { inferPaymentStatus, normalizeCompanyName, parseMoney } from "./sponsor-import.service.js";
import { reconcileAttendeeSlots } from "./workspace.service.js";

export type PaymentImportFormat = "csv" | "xlsx" | "pdf" | "md";
export type PaymentImportParserUsed = "native" | "llama_core";
export type PaymentImportRowStatus = "valid" | "warning" | "error";
export type PaymentImportRowDecision = "approve" | "skip";

export type PaymentImportConfirmRowDecisionInput = {
  importRowId?: string;
  rowNumber?: number;
  decision: PaymentImportRowDecision;
};

export type PaymentImportPreviewRow = {
  importRowId: string;
  rowNumber: number;
  status: PaymentImportRowStatus;
  decision: PaymentImportRowDecision;
  raw: Record<string, string | null>;
  normalized: {
    companyName?: string;
    sponsorshipPackage?: string;
    amountPaid?: number;
    paymentStatus?: string;
    paymentMethod?: string;
    paymentReference?: string;
    paymentNotes?: string;
  };
  matchedSponsor?: {
    id: string;
    companyName: string;
    matchStatus: "Matched" | "Unmatched";
    confidence: number;
  };
  warnings: string[];
  errors: string[];
};

export type PaymentImportPreviewResponse = {
  importBatchId: string;
  importType: "payment_status";
  importScope: "EVENT";
  importFormat: PaymentImportFormat;
  eventId: string;
  fileName?: string;
  status: "preview_ready" | "needs_review" | "failed";
  parserUsed: PaymentImportParserUsed;
  parserWarnings: string[];
  summary: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    duplicateRows: number;
    matchedRows: number;
    unmatchedRows: number;
    approvableRows: number;
  };
  columnMapping: Array<{
    sourceColumn: string;
    normalizedColumn: string;
    target: string;
    confidence: number;
  }>;
  rows: PaymentImportPreviewRow[];
};

export type PaymentImportConfirmResponse = {
  importType: "payment_status";
  importScope: "EVENT";
  importFormat: PaymentImportFormat;
  eventId: string;
  status: "confirmed" | "confirmed_with_warnings" | "failed";
  updated: string[];
  notFound: string[];
  total: number;
  summary: {
    importedRows: number;
    skippedRows: number;
    unmatchedRows: number;
    failedRows: number;
    participantsConfirmed: number;
    paymentsSynced: number;
    paymentSyncedWithoutParticipant: number;
  };
};

type PaymentImportPreviewInput = {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  csvContent?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
  fileName?: string;
};

type PaymentImportConfirmInput = {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  importBatchId: string;
  rowDecisions?: PaymentImportConfirmRowDecisionInput[];
};

type ParsedPaymentTable = {
  importFormat: PaymentImportFormat;
  parserUsed: PaymentImportParserUsed;
  parserWarnings: string[];
  headers: string[];
  rows: string[][];
  columnMapping: PaymentImportPreviewResponse["columnMapping"];
};

type StoredPaymentRow = {
  companyName?: string;
  sponsorshipPackage?: string;
  amountPaid?: number;
  paymentStatus?: string;
  paymentMethod?: string;
  paymentReference?: string;
  paymentNotes?: string;
  matchedSponsor?: {
    id?: string;
    companyName?: string;
    matchStatus?: "Matched" | "Unmatched";
    confidence?: number;
  };
};

type EventSponsorWithOrganization = Prisma.EventureEventSponsorGetPayload<{
  include: { sponsorOrganization: { select: { name: true } } };
}>;

const COL_ALIASES: Record<string, string[]> = {
  company: ["company", "sponsor", "organization", "companyname", "sponsorcompany"],
  package: ["package", "sponsorshippackage", "level"],
  amountPaid: ["amountpaid", "paid", "payment", "amountreceived", "amountcollected"],
  paymentStatus: ["paymentstatus", "status"],
  paymentMethod: ["paymentmethod", "method"],
  invoiceNumber: ["invoice", "invoicenumber", "invoicenum", "invoiceno", "ref", "reference"],
  notes: ["notes", "note", "paymentnotes", "memo", "description"],
};

function normalizeColName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectImportFormat(fileMimeType?: string, fileName?: string): PaymentImportFormat {
  const loweredName = (fileName ?? "").toLowerCase();
  const loweredType = (fileMimeType ?? "").toLowerCase();

  if (loweredType.includes("sheet") || loweredName.endsWith(".xlsx")) return "xlsx";
  if (loweredType.includes("pdf") || loweredName.endsWith(".pdf")) return "pdf";
  if (loweredType.includes("markdown") || loweredName.endsWith(".md")) return "md";
  return "csv";
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];

    if (inQuotes) {
      if (current === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (current === '"') {
        inQuotes = false;
      } else {
        cell += current;
      }
      continue;
    }

    if (current === '"') {
      inQuotes = true;
    } else if (current === ",") {
      row.push(cell);
      cell = "";
    } else if (current === "\n") {
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
    } else {
      cell += current;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function parseMarkdownTable(text: string): string[][] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const tableLines = lines.filter((line) => line.includes("|"));
  if (tableLines.length < 2) return [];

  const rows = tableLines.map((line) => {
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  });

  return rows.filter((row, index) => {
    if (index !== 1) return true;
    return !row.every((cell) => /^:?-{3,}:?$/.test(cell));
  });
}

function scoreHeaderRow(row: string[]): number {
  return row.reduce((score, cell) => {
    const normalized = normalizeColName(cell);
    if (!normalized) return score;
    return score + (Object.values(COL_ALIASES).some((aliases) => aliases.includes(normalized)) ? 1 : 0);
  }, 0);
}

function buildColumnMapping(headers: string[]): PaymentImportPreviewResponse["columnMapping"] {
  return headers.map((header) => {
    const normalizedColumn = normalizeColName(header);
    const matchedEntry = Object.entries(COL_ALIASES).find(([, aliases]) => aliases.includes(normalizedColumn));
    return {
      sourceColumn: header,
      normalizedColumn,
      target: matchedEntry?.[0] ?? "unmapped",
      confidence: matchedEntry ? 0.95 : 0,
    };
  });
}

function getHeaderAndRows(grid: string[][]): { headers: string[]; rows: string[][] } {
  if (grid.length < 2) {
    throw new EventureServiceError("Import must include a header row and at least one data row.", 400);
  }

  let bestHeaderIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < Math.min(grid.length, 15); index += 1) {
    const score = scoreHeaderRow(grid[index] ?? []);
    if (score > bestScore) {
      bestScore = score;
      bestHeaderIndex = index;
    }
  }

  const headers = grid[bestHeaderIndex]?.map((cell) => cell.trim()) ?? [];
  const rows = grid.slice(bestHeaderIndex + 1).filter((row) => row.some((cell) => (cell ?? "").trim().length > 0));
  if (headers.length === 0 || rows.length === 0) {
    throw new EventureServiceError("Import must include a header row and at least one data row.", 400);
  }
  return { headers, rows };
}

function parseWorkbook(buffer: Buffer): { headers: string[]; rows: string[][] } {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: false });
  let best: { headers: string[]; rows: string[][]; score: number } | null = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const grid = (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false }) as unknown[][])
      .map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
    if (grid.length < 2) continue;

    const parsed = getHeaderAndRows(grid);
    const score = scoreHeaderRow(parsed.headers);
    if (!best || score > best.score) {
      best = { ...parsed, score };
    }
  }

  if (!best) {
    throw new EventureServiceError("Workbook did not contain a recognizable payment sheet.", 400);
  }

  return { headers: best.headers, rows: best.rows };
}

async function parsePdfBuffer(buffer: Buffer, fileName: string): Promise<{ text: string; parserUsed: PaymentImportParserUsed; parserWarnings: string[] }> {
  if (!canUseSharedParser()) {
    throw new EventureServiceError("PDF payment import requires the shared document parser to be available.", 400);
  }

  const tempFilePath = path.join(os.tmpdir(), `eventure-payment-import-${Date.now()}-${fileName}`);
  try {
    await fs.writeFile(tempFilePath, buffer);
    const parsed = await parseDocumentWithSharedService(tempFilePath, { mimeType: "application/pdf" });
    const text = (parsed.markdown || parsed.text || "").trim();
    if (!text) {
      throw new EventureServiceError("The uploaded PDF did not produce readable payment rows.", 400);
    }
    return { text, parserUsed: "llama_core", parserWarnings: [] };
  } finally {
    await fs.unlink(tempFilePath).catch(() => undefined);
  }
}

async function parseInputTable(input: PaymentImportPreviewInput): Promise<ParsedPaymentTable> {
  const importFormat = detectImportFormat(input.fileMimeType, input.fileName);

  if (importFormat === "xlsx") {
    if (!input.fileBuffer) {
      throw new EventureServiceError("XLSX import requires a file upload.", 400);
    }
    const parsed = parseWorkbook(input.fileBuffer);
    return {
      importFormat,
      parserUsed: "native",
      parserWarnings: [],
      headers: parsed.headers,
      rows: parsed.rows,
      columnMapping: buildColumnMapping(parsed.headers),
    };
  }

  let text = input.csvContent ?? input.fileBuffer?.toString("utf8") ?? "";
  let parserUsed: PaymentImportParserUsed = "native";
  let parserWarnings: string[] = [];

  if (importFormat === "pdf") {
    if (!input.fileBuffer) {
      throw new EventureServiceError("PDF import requires a file upload.", 400);
    }
    const parsed = await parsePdfBuffer(input.fileBuffer, input.fileName ?? "payment-import.pdf");
    text = parsed.text;
    parserUsed = parsed.parserUsed;
    parserWarnings = parsed.parserWarnings;
  }

  if (!text.trim()) {
    throw new EventureServiceError("Import file is empty.", 400);
  }

  const grid = importFormat === "md" || importFormat === "pdf"
    ? (() => {
        const markdownRows = parseMarkdownTable(text);
        if (markdownRows.length >= 2) return markdownRows;
        parserWarnings = [...parserWarnings, "No Markdown table detected; falling back to CSV-style parsing."];
        return parseCsvText(text);
      })()
    : parseCsvText(text);

  const parsed = getHeaderAndRows(grid);
  return {
    importFormat,
    parserUsed,
    parserWarnings,
    headers: parsed.headers,
    rows: parsed.rows,
    columnMapping: buildColumnMapping(parsed.headers),
  };
}

function resolveColIndex(headers: string[], key: keyof typeof COL_ALIASES): number {
  const aliases = COL_ALIASES[key];
  return headers.findIndex((header) => aliases.includes(normalizeColName(header)));
}

function normalizeTextCell(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMatchKey(value?: string): string | undefined {
  const normalized = value ? normalizeCompanyName(value) : "";
  if (!normalized) return undefined;

  const stripped = normalized
    .replace(/^the\s+/g, "")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|pllc|plc|lp|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped || normalized;
}

function normalizeReferenceKey(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized ? normalized : undefined;
}

function normalizePackageKey(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}

function sharesMeaningfulCompanyToken(companyName: string, sponsorName: string): boolean {
  const tokenize = (value: string) => new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4),
  );

  const left = tokenize(companyName);
  const right = tokenize(sponsorName);
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function findUniqueCandidate(candidates: EventSponsorWithOrganization[]): EventSponsorWithOrganization | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function matchSponsorForPaymentRow(input: {
  sponsors: EventSponsorWithOrganization[];
  companyName?: string;
  sponsorshipPackage?: string;
  paymentReference?: string;
}): { sponsor?: EventSponsorWithOrganization; confidence: number; warning?: string } {
  const { sponsors, companyName, sponsorshipPackage, paymentReference } = input;
  const normalizedCompany = companyName ? normalizeCompanyName(companyName) : undefined;
  if (normalizedCompany) {
    const exact = sponsors.find((sponsor) => normalizeCompanyName(sponsor.sponsorOrganization.name) === normalizedCompany);
    if (exact) {
      return { sponsor: exact, confidence: 1 };
    }
  }

  const looseCompany = normalizeMatchKey(companyName);
  if (looseCompany) {
    const looseCandidates = sponsors.filter((sponsor) => normalizeMatchKey(sponsor.sponsorOrganization.name) === looseCompany);
    const loose = findUniqueCandidate(looseCandidates);
    if (loose) {
      return {
        sponsor: loose,
        confidence: 0.92,
        warning: "Matched by normalized company alias. Review before confirm if needed.",
      };
    }
  }

  const referenceKey = normalizeReferenceKey(paymentReference);
  if (referenceKey) {
    const referenceCandidates = sponsors.filter((sponsor) => normalizeReferenceKey(sponsor.paymentReference ?? undefined) === referenceKey);
    const referenceMatch = findUniqueCandidate(referenceCandidates);
    if (referenceMatch) {
      return {
        sponsor: referenceMatch,
        confidence: 0.9,
        warning: "Matched by unique payment reference. Review before confirm if needed.",
      };
    }
  }

  const packageKey = normalizePackageKey(sponsorshipPackage);
  if (packageKey && companyName) {
    const packageCandidates = sponsors.filter((sponsor) => normalizePackageKey(sponsor.sponsorshipPackage ?? undefined) === packageKey);
    const overlappingCandidates = packageCandidates.filter((sponsor) => sharesMeaningfulCompanyToken(companyName, sponsor.sponsorOrganization.name));
    const packageMatch = findUniqueCandidate(overlappingCandidates);
    if (packageMatch) {
      return {
        sponsor: packageMatch,
        confidence: 0.82,
        warning: "Matched by package plus company-name token overlap. Review before confirm if needed.",
      };
    }
  }

  return { confidence: 0 };
}

function readStoredRow(row: { normalizedData: unknown }): StoredPaymentRow {
  const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
  const matchedSponsor = (normalized.matchedSponsor ?? {}) as Record<string, unknown>;
  return {
    companyName: typeof normalized.companyName === "string" ? normalized.companyName : undefined,
    sponsorshipPackage: typeof normalized.sponsorshipPackage === "string" ? normalized.sponsorshipPackage : undefined,
    amountPaid: typeof normalized.amountPaid === "number" ? normalized.amountPaid : undefined,
    paymentStatus: typeof normalized.paymentStatus === "string" ? normalized.paymentStatus : undefined,
    paymentMethod: typeof normalized.paymentMethod === "string" ? normalized.paymentMethod : undefined,
    paymentReference: typeof normalized.paymentReference === "string" ? normalized.paymentReference : undefined,
    paymentNotes: typeof normalized.paymentNotes === "string" ? normalized.paymentNotes : undefined,
    matchedSponsor: {
      id: typeof matchedSponsor.id === "string" ? matchedSponsor.id : undefined,
      companyName: typeof matchedSponsor.companyName === "string" ? matchedSponsor.companyName : undefined,
      matchStatus: matchedSponsor.matchStatus === "Matched" ? "Matched" : "Unmatched",
      confidence: typeof matchedSponsor.confidence === "number" ? matchedSponsor.confidence : undefined,
    },
  };
}

export async function previewPaymentImportForEvent(input: PaymentImportPreviewInput): Promise<PaymentImportPreviewResponse> {
  const parsed = await parseInputTable(input);
  const existingSponsors = await prisma.eventureEventSponsor.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    include: {
      sponsorOrganization: {
        select: {
          name: true,
        },
      },
    },
  });

  const colCompany = resolveColIndex(parsed.headers, "company");
  if (colCompany === -1) {
    throw new EventureServiceError('Import must have a "Company" column. Accepted names: Company, Sponsor, Organization.', 400);
  }

  const colPackage = resolveColIndex(parsed.headers, "package");
  const colAmountPaid = resolveColIndex(parsed.headers, "amountPaid");
  const colPaymentStatus = resolveColIndex(parsed.headers, "paymentStatus");
  const colPaymentMethod = resolveColIndex(parsed.headers, "paymentMethod");
  const colInvoiceNumber = resolveColIndex(parsed.headers, "invoiceNumber");
  const colNotes = resolveColIndex(parsed.headers, "notes");

  const previewRows = parsed.rows.map<PaymentImportPreviewRow>((row, index) => {
    const rowNumber = index + 1;
    const raw = Object.fromEntries(parsed.headers.map((header, headerIndex) => [header, row[headerIndex] ?? null]));
    const warnings: string[] = [];
    const errors: string[] = [];

    const companyName = normalizeTextCell(row[colCompany]);
    const sponsorshipPackage = colPackage >= 0 ? normalizeTextCell(row[colPackage]) : undefined;
    const amountPaid = colAmountPaid >= 0 ? parseMoney(row[colAmountPaid]) : undefined;
    const rawStatus = colPaymentStatus >= 0 ? normalizeTextCell(row[colPaymentStatus]) : undefined;
    const paymentStatus = rawStatus ? inferPaymentStatus({ statusRaw: rawStatus, notes: colNotes >= 0 ? row[colNotes] : undefined, sponsorshipPackage }) : undefined;
    const paymentMethod = colPaymentMethod >= 0 ? normalizeTextCell(row[colPaymentMethod]) : undefined;
    const paymentReference = colInvoiceNumber >= 0 ? normalizeTextCell(row[colInvoiceNumber]) : undefined;
    const paymentNotes = colNotes >= 0 ? normalizeTextCell(row[colNotes]) : undefined;

    if (!companyName) {
      errors.push("Missing company name.");
    }

    const hasPaymentData = [amountPaid, paymentStatus, paymentMethod, paymentReference, paymentNotes, sponsorshipPackage]
      .some((value) => value !== undefined);
    if (!hasPaymentData) {
      warnings.push("No payment fields were detected for this row.");
    }

    const sponsorMatch = matchSponsorForPaymentRow({
      sponsors: existingSponsors,
      companyName,
      sponsorshipPackage,
      paymentReference,
    });
    const matchedSponsor = sponsorMatch.sponsor;

    if (sponsorMatch.warning) {
      warnings.push(sponsorMatch.warning);
    }

    if (!matchedSponsor && companyName) {
      warnings.push("No existing sponsor matched this company name.");
    }

    const status: PaymentImportRowStatus = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";

    return {
      importRowId: "",
      rowNumber,
      status,
      decision: matchedSponsor && hasPaymentData && errors.length === 0 ? "approve" : "skip",
      raw,
      normalized: {
        companyName,
        sponsorshipPackage,
        amountPaid,
        paymentStatus,
        paymentMethod,
        paymentReference,
        paymentNotes,
      },
      matchedSponsor: matchedSponsor
        ? {
            id: matchedSponsor.id,
            companyName: matchedSponsor.sponsorOrganization.name,
            matchStatus: "Matched",
            confidence: sponsorMatch.confidence,
          }
        : companyName
          ? {
              id: "",
              companyName,
              matchStatus: "Unmatched",
              confidence: 0,
            }
          : undefined,
      warnings,
      errors,
    };
  });

  const importBatch = await prisma.eventureImportBatch.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      fileName: input.fileName ?? `payment-import.${parsed.importFormat}`,
      fileType: parsed.importFormat,
      fileUrl: "inline-upload",
      sourceType: "payment_import",
      status: "previewing",
      totalRows: previewRows.length,
      parsedRows: previewRows.length,
      mappingConfig: {
        parserUsed: parsed.parserUsed,
        parserWarnings: parsed.parserWarnings,
        importType: "payment_status",
        columnMapping: parsed.columnMapping,
      },
      createdByUserId: input.createdByUserId,
    },
  });

  const createdRows = await Promise.all(previewRows.map((row) => prisma.eventureImportRow.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: importBatch.id,
      rowNumber: row.rowNumber,
      rawData: row.raw as Prisma.InputJsonValue,
      normalizedData: {
        ...row.normalized,
        matchedSponsor: row.matchedSponsor,
      } as Prisma.InputJsonValue,
      status: row.status,
      errorMessage: row.errors[0],
      detectedPaymentStatus: row.normalized.paymentStatus,
    },
    select: { id: true, rowNumber: true },
  })));

  const rowIdByNumber = new Map(createdRows.map((row) => [row.rowNumber, row.id]));
  const rows = previewRows.map((row) => ({
    ...row,
    importRowId: rowIdByNumber.get(row.rowNumber) ?? "",
  }));

  const summary = {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.status === "valid").length,
    warningRows: rows.filter((row) => row.status === "warning").length,
    errorRows: rows.filter((row) => row.status === "error").length,
    duplicateRows: 0,
    matchedRows: rows.filter((row) => row.matchedSponsor?.matchStatus === "Matched").length,
    unmatchedRows: rows.filter((row) => row.matchedSponsor?.matchStatus === "Unmatched").length,
    approvableRows: rows.filter((row) => row.decision === "approve").length,
  };

  const status = summary.errorRows > 0 || summary.warningRows > 0 ? "needs_review" : "preview_ready";

  await prisma.eventureImportBatch.update({
    where: { id: importBatch.id },
    data: {
      validRows: summary.validRows,
      errorRows: summary.errorRows,
      duplicateRows: 0,
      status,
    },
  });

  return {
    importBatchId: importBatch.id,
    importType: "payment_status",
    importScope: "EVENT",
    importFormat: parsed.importFormat,
    eventId: input.eventId,
    fileName: input.fileName,
    status,
    parserUsed: parsed.parserUsed,
    parserWarnings: parsed.parserWarnings,
    summary,
    columnMapping: parsed.columnMapping,
    rows,
  };
}

export async function confirmPaymentImportForEvent(input: PaymentImportConfirmInput): Promise<PaymentImportConfirmResponse> {
  const importBatch = await prisma.eventureImportBatch.findFirst({
    where: {
      id: input.importBatchId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
  });

  if (!importBatch) {
    throw new EventureServiceError("Payment import batch not found.", 404);
  }

  if (importBatch.sourceType !== "payment_import") {
    throw new EventureServiceError("Import batch is not a payment import batch.", 400);
  }

  if (!["preview_ready", "needs_review", "previewing"].includes(importBatch.status)) {
    throw new EventureServiceError("Payment import batch is no longer awaiting confirmation.", 400);
  }

  const rows = await prisma.eventureImportRow.findMany({
    where: {
      organizationId: input.organizationId,
      importBatchId: input.importBatchId,
    },
    orderBy: { rowNumber: "asc" },
  });

  const decisionByRowId = new Map((input.rowDecisions ?? []).flatMap((decision) => {
    if (decision.importRowId) return [[decision.importRowId, decision.decision] as const];
    return [];
  }));
  const decisionByRowNumber = new Map((input.rowDecisions ?? []).flatMap((decision) => {
    if (typeof decision.rowNumber === "number") return [[decision.rowNumber, decision.decision] as const];
    return [];
  }));

  const updated: string[] = [];
  const notFound: string[] = [];
  let importedRows = 0;
  let skippedRows = 0;
  let unmatchedRows = 0;
  let failedRows = 0;
  let participantsConfirmed = 0;
  let paymentsSynced = 0;
  let paymentSyncedWithoutParticipant = 0;

  for (const row of rows) {
    const normalized = readStoredRow(row);
    const matchedSponsorId = normalized.matchedSponsor?.id?.trim();
    const defaultDecision: PaymentImportRowDecision = matchedSponsorId ? "approve" : "skip";
    const decision = decisionByRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber) ?? defaultDecision;
    const companyName = normalized.companyName ?? `Row ${row.rowNumber}`;

    if (decision === "skip") {
      skippedRows += 1;
      if (!matchedSponsorId) {
        unmatchedRows += 1;
        notFound.push(companyName);
      }
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: matchedSponsorId ? "skipped" : "unmatched",
          errorMessage: matchedSponsorId ? null : "No sponsor match selected for this row.",
        },
      });
      continue;
    }

    if (!matchedSponsorId) {
      failedRows += 1;
      unmatchedRows += 1;
      notFound.push(companyName);
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: "failed",
          errorMessage: "Cannot approve a payment row without a matched sponsor.",
        },
      });
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (typeof normalized.amountPaid === "number") patch.amountPaid = normalized.amountPaid;
    if (normalized.paymentStatus) patch.paymentStatus = normalized.paymentStatus;
    if (normalized.paymentMethod) patch.paymentMethod = normalized.paymentMethod;
    if (normalized.paymentReference) patch.paymentReference = normalized.paymentReference;
    if (normalized.paymentNotes) patch.paymentNotes = normalized.paymentNotes;
    if (normalized.sponsorshipPackage) patch.sponsorshipPackage = normalized.sponsorshipPackage;

    if (Object.keys(patch).length === 0) {
      skippedRows += 1;
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: "skipped",
          errorMessage: "No payment fields were available to import.",
        },
      });
      continue;
    }

    try {
      const updatedSponsor = await prisma.eventureEventSponsor.update({
        where: { id: matchedSponsorId },
        data: patch,
        select: {
          id: true,
          organizationId: true,
          eventId: true,
          sponsorOrganizationId: true,
          sponsorOrganization: { select: { name: true } },
        },
      });

      // Sync the workspace payment model whenever a payment-status row is approved
      const sponsorOrgId = updatedSponsor.sponsorOrganizationId;
      const amountPaid = typeof normalized.amountPaid === "number" ? normalized.amountPaid : undefined;

      const existingPayment = await prisma.eventurePayment.findFirst({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: sponsorOrgId,
        },
        orderBy: [{ updatedAt: "desc" }],
      });

      const amountDueResolved = amountPaid ?? existingPayment?.amountDue ?? 0;
      const amountPaidResolved = amountPaid ?? existingPayment?.amountPaid ?? 0;
      const balanceResolved = amountDueResolved - amountPaidResolved;

      const payment = existingPayment
        ? await prisma.eventurePayment.update({
            where: { id: existingPayment.id },
            data: {
              amountDue: amountDueResolved,
              amountPaid: amountPaidResolved,
              balance: balanceResolved,
              paymentStatus: "confirmed",
              paymentMethod: normalized.paymentMethod ?? existingPayment.paymentMethod,
              notes: normalized.paymentNotes ?? existingPayment.notes,
              paymentConfirmedAt: new Date(),
            },
          })
        : await prisma.eventurePayment.create({
            data: {
              organizationId: input.organizationId,
              eventId: input.eventId,
              contactCompanyId: sponsorOrgId,
              amountDue: amountDueResolved,
              amountPaid: amountPaidResolved,
              balance: balanceResolved,
              paymentStatus: "confirmed",
              paymentMethod: normalized.paymentMethod ?? null,
              notes: normalized.paymentNotes ?? null,
              paymentConfirmedAt: new Date(),
            },
          });

      await prisma.eventurePaymentHistory.create({
        data: {
          organizationId: input.organizationId,
          paymentId: payment.id,
          paymentStatus: payment.paymentStatus,
          amountDue: payment.amountDue,
          amountPaid: payment.amountPaid,
          balance: payment.balance,
          paymentMethod: payment.paymentMethod,
          paymentConfirmedAt: payment.paymentConfirmedAt,
          notes: payment.notes,
          changedByUserId: input.createdByUserId,
        },
      });

      paymentsSynced += 1;

      // Confirm the matching Participant and reconcile their attendee slots
      const participant = await prisma.eventureParticipant.findFirst({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: sponsorOrgId,
        },
        select: {
          id: true,
          companyName: true,
          attendeeCount: true,
          flightAssignment: true,
        },
      });

      if (participant) {
        await prisma.eventureParticipant.update({
          where: { id: participant.id },
          data: {
            paymentConfirmed: true,
            paymentId: payment.id,
          },
        });
        participantsConfirmed += 1;

        if (participant.attendeeCount > 0) {
          await reconcileAttendeeSlots({
            organizationId: input.organizationId,
            eventId: input.eventId,
            participantId: participant.id,
            companyName: participant.companyName,
            attendeeCount: participant.attendeeCount,
            flightAssignment: participant.flightAssignment ?? "PM",
          });
        }
      } else {
        paymentSyncedWithoutParticipant += 1;
      }

      importedRows += 1;
      updated.push(companyName);
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: "imported",
          errorMessage: null,
        },
      });
    } catch (error) {
      failedRows += 1;
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Failed to apply payment row.",
        },
      });
    }
  }

  const resultStatus: PaymentImportConfirmResponse["status"] = failedRows > 0
    ? (importedRows > 0 ? "confirmed_with_warnings" : "failed")
    : (skippedRows > 0 || unmatchedRows > 0 ? "confirmed_with_warnings" : "confirmed");

  await prisma.eventureImportBatch.update({
    where: { id: importBatch.id },
    data: {
      status: resultStatus,
      completedAt: new Date(),
      errorRows: failedRows,
      updatedAt: new Date(),
      mappingConfig: {
        ...(typeof importBatch.mappingConfig === "object" && importBatch.mappingConfig ? importBatch.mappingConfig as Record<string, unknown> : {}),
        confirmedByUserId: input.createdByUserId,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    importType: "payment_status",
    importScope: "EVENT",
    importFormat: detectImportFormat(importBatch.fileType, importBatch.fileName),
    eventId: input.eventId,
    status: resultStatus,
    updated,
    notFound,
    total: rows.length,
    summary: {
      importedRows,
      skippedRows,
      unmatchedRows,
      failedRows,
      participantsConfirmed,
      paymentsSynced,
      paymentSyncedWithoutParticipant,
    },
  };
}