import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  completeImportBatch,
  createImportBatch,
  createImportRow,
  createSponsorContact,
  createSponsorFollowUp,
  createSponsorOrganization,
  failImportBatch,
  findExistingOpenFollowUp,
  getImportBatchWithRows,
  getActiveEventForOrganization,
  getEventSponsorByComposite,
  listEventSponsorsForEvent,
  listSponsorOrganizationsForOrganization,
  getSponsorYearHistory,
  updateImportRowStatus,
  updateSponsorContact,
  updateSponsorOrganization,
  upsertEventSponsor,
  upsertSponsorYearHistory,
} from "../repositories/sponsor-import.repository.js";
import { EventureServiceError } from "./eventure-error.js";
import { createEventForOrganization } from "./event.service.js";
import { canUseSharedParser, parseDocumentWithSharedService } from "../../../core/services/parse/documentParseService.js";

type ImportWarning = {
  rowNumber: number;
  code: string;
  message: string;
};

type LegacyImportMode = "existing_event" | "master_contacts_only" | "create_event";
export type ImportMode =
  | "master_list_only"
  | "master_list_with_event_assignment"
  | "create_event_then_assign";

type ImportModeInput = ImportMode | LegacyImportMode;

export type ConfirmRowDecision =
  | "approve"
  | "skip"
  | "edit"
  | "merge"
  | "create_new"
  | "needs_review";

export type ConfirmRowDecisionInput = {
  importRowId?: string;
  rowNumber?: number;
  decision: ConfirmRowDecision;
  editableNormalized?: Partial<StoredSponsorImportRow>;
  matchedRecords?: {
    sponsorOrganizationId?: string;
    sponsorContactId?: string;
    eventSponsorId?: string;
  };
};

export type ConfirmCreateEventInput = {
  title?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
  venueName?: string;
  timezone?: string;
  status?: string;
  eventType?: string;
};

type SuggestedFollowUp = {
  type: string;
  title: string;
  description: string;
  sourceText: string;
  confidence: number;
  assignedToName?: string;
};

type ParsedYearHistory = {
  year: number;
  rawValue: string;
  amount?: number;
  participationStatus: string;
};

type ParsedSponsorRow = {
  rowNumber: number;
  raw: Record<string, string>;
  companyName: string;
  normalizedCompanyName: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  sponsorshipPackage?: string;
  flightPreference?: string;
  logoStatus?: string;
  attendeeNamesRaw?: string;
  statusRaw?: string;
  pointPersonName?: string;
  notes?: string;
  committedAmount?: number;
  paymentStatus: string;
  paymentNotes?: string;
  yearHistory: ParsedYearHistory[];
  warnings: ImportWarning[];
  suggestedFollowUps: SuggestedFollowUp[];
};

type PreviewRowTarget = "create" | "update" | "skip" | "review";

type ImportPreviewRow = {
  importRowId: string;
  rowNumber: number;
  status: "valid" | "warning" | "error" | "duplicate";
  decision: ConfirmRowDecision;
  raw: Record<string, unknown>;
  normalized: {
    companyName?: string;
    representativeName?: string;
    email?: string;
    phone?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    sponsorshipPackage?: string;
    committedAmount?: number;
    paymentStatus?: string;
    logoStatus?: string;
    flightPreference?: string;
    attendeeNamesRaw?: string;
    pointPersonName?: string;
    notes?: string;
  };
  editableNormalized: {
    companyName?: string;
    representativeName?: string;
    email?: string;
    phone?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    sponsorshipPackage?: string;
    committedAmount?: number;
    paymentStatus?: string;
    logoStatus?: string;
    flightPreference?: string;
    attendeeNamesRaw?: string;
    pointPersonName?: string;
    notes?: string;
  };
  targets: {
    sponsorOrganization: PreviewRowTarget;
    sponsorContact: PreviewRowTarget;
    eventSponsor: PreviewRowTarget;
    sponsorYearHistory: PreviewRowTarget;
    sponsorFollowUp: PreviewRowTarget;
  };
  warnings: string[];
  errors: string[];
  matchedRecords?: {
    sponsorOrganizationId?: string;
    sponsorContactId?: string;
    eventSponsorId?: string;
  };
  duplicateCandidates?: {
    sponsorOrganizations?: Array<{ id: string; name: string; reason: string }>;
    sponsorContacts?: Array<{ id: string; name: string; email?: string; phone?: string; reason: string }>;
  };
};

type ColumnMappingEntry = {
  sourceColumn: string;
  normalizedColumn: string;
  target: string;
  confidence: number;
  warning?: string;
};

type StoredSponsorImportRow = {
  companyName?: string;
  normalizedCompanyName?: string;
  representativeName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  sponsorshipPackage?: string;
  committedAmount?: number;
  paymentStatus?: string;
  logoStatus?: string;
  flightPreference?: string;
  attendeeNamesRaw?: string;
  pointPersonName?: string;
  notes?: string;
  statusRaw?: string;
  paymentNotes?: string;
  yearHistory: ParsedYearHistory[];
  suggestedFollowUps: SuggestedFollowUp[];
  warnings: string[];
  errors: string[];
  targets: {
    sponsorOrganization: PreviewRowTarget;
    sponsorContact: PreviewRowTarget;
    eventSponsor: PreviewRowTarget;
    sponsorYearHistory: PreviewRowTarget;
    sponsorFollowUp: PreviewRowTarget;
  };
  matchedRecords?: {
    sponsorOrganizationId?: string;
    sponsorContactId?: string;
    eventSponsorId?: string;
  };
  duplicateCandidates?: {
    sponsorOrganizations?: Array<{ id: string; name: string; reason: string }>;
    sponsorContacts?: Array<{ id: string; name: string; email?: string; phone?: string; reason: string }>;
  };
  rowStatus: ImportPreviewRow["status"];
};

function toCanonicalImportMode(mode?: ImportModeInput): ImportMode {
  if (!mode || mode === "master_list_only" || mode === "master_contacts_only") {
    return "master_list_only";
  }
  if (mode === "master_list_with_event_assignment" || mode === "existing_event") {
    return "master_list_with_event_assignment";
  }
  return "create_event_then_assign";
}

function usesEventAssignment(mode: ImportMode): boolean {
  return mode !== "master_list_only";
}

function requiresExistingEventIdForPreview(mode: ImportMode): boolean {
  return mode === "master_list_with_event_assignment";
}

function defaultDecisionForStoredRow(stored: StoredSponsorImportRow): ConfirmRowDecision {
  if (stored.rowStatus === "error" || stored.rowStatus === "duplicate") return "skip";
  if (
    stored.targets.sponsorOrganization === "review" ||
    stored.targets.sponsorContact === "review" ||
    stored.targets.eventSponsor === "review" ||
    stored.targets.sponsorYearHistory === "review" ||
    stored.targets.sponsorFollowUp === "review"
  ) {
    return "needs_review";
  }
  return "approve";
}

function mergeEditableNormalized(
  base: StoredSponsorImportRow,
  editable?: Partial<StoredSponsorImportRow>,
): StoredSponsorImportRow {
  if (!editable) return base;

  const merged: StoredSponsorImportRow = {
    ...base,
    ...editable,
    yearHistory: editable.yearHistory ?? base.yearHistory,
    suggestedFollowUps: editable.suggestedFollowUps ?? base.suggestedFollowUps,
    warnings: editable.warnings ?? base.warnings,
    errors: editable.errors ?? base.errors,
    targets: {
      ...base.targets,
      ...(editable.targets ?? {}),
    },
    matchedRecords: {
      ...(base.matchedRecords ?? {}),
      ...(editable.matchedRecords ?? {}),
    },
  };

  merged.companyName = merged.companyName?.trim();
  merged.normalizedCompanyName = normalizeCompanyName(merged.companyName ?? merged.normalizedCompanyName ?? "");
  merged.representativeName = merged.representativeName?.trim();
  merged.email = merged.email?.trim();
  merged.phone = merged.phone?.trim();

  return merged;
}

type PreviewItem = {
  rowNumber: number;
  company: string;
  action: "create" | "update";
  matchedBy?: string;
};

type ContactPreviewItem = {
  rowNumber: number;
  company: string;
  contactName?: string;
  contactEmail?: string;
  action: "create" | "update" | "skip";
};

export type SponsorImportParserStrategy = "native" | "llama_core";

const BLANK_MARKERS = new Set(["", "n/a", "na", "-", "--", "none", "null"]);

const HEADER_ALIASES: Record<string, string[]> = {
  company: ["company", "sponsor", "sponsor company", "organization", "business", "company name"],
  addressLine1: ["street address", "address", "address 1", "address line 1"],
  cityStateZip: ["city, state, zip code", "city state zip", "city/state/zip", "city,state,zip"],
  contactEmail: ["contact email", "email", "representative email"],
  contactPhone: ["contact phone", "phone", "representative phone", "phone number"],
  representative: ["representative", "contact", "contact name"],
  sponsorshipPackage: ["sponsorship package", "package", "level"],
  flight: ["2026 flight", "flight", "flight preference"],
  logo: ["logo", "logo status"],
  names: ["names", "golfer names", "attendee names"],
  status: ["status", "payment status"],
  pointPerson: ["point person", "owner", "assigned to"],
  notes: ["notes", "note"],
  currentAmount: ["2026 amount", "current amount", "committed amount", "amount 2026"],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();

  return headers.map((header) => {
    const base = header.trim();
    const normalized = normalizeHeader(base);
    const count = (seen.get(normalized) ?? 0) + 1;
    seen.set(normalized, count);
    return count === 1 ? base : `${base}__${count}`;
  });
}

export function cleanCell(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  return BLANK_MARKERS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

export function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(incorporated|inc|llc|l\.l\.c|corp|corporation|co|company|ltd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value?: string): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits || undefined;
}

function normalizeName(value?: string): string {
  if (!value) return "";
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseMoney(value?: string): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeLogoStatus(value?: string): string | undefined {
  const normalized = cleanCell(value);
  if (!normalized) return undefined;

  const lowered = normalized.toLowerCase();
  if (lowered.includes("received") || lowered === "yes" || lowered.includes("have logo")) return "received";
  if (lowered.includes("need logo") || lowered.includes("missing") || lowered.includes("needed")) return "needed";
  return normalized;
}

function normalizeFlightPreference(value?: string): string | undefined {
  const normalized = cleanCell(value);
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase();
  if (lowered === "am") return "AM";
  if (lowered === "pm") return "PM";
  return undefined;
}

function splitCityStateZip(value?: string): { city?: string; state?: string; zipCode?: string } {
  if (!value) return {};
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) {
    return { city: parts[0] };
  }

  const city = parts[0];
  const stateZip = parts.slice(1).join(" ").trim();
  const zipMatch = stateZip.match(/\b(\d{5}(?:-\d{4})?)\b/);
  const zipCode = zipMatch?.[1];
  const state = stateZip.replace(/\b\d{5}(?:-\d{4})?\b/, "").trim() || undefined;
  return { city, state, zipCode };
}

function classifyRowStatus(input: {
  row: ParsedSponsorRow;
  duplicateWithinFile: boolean;
  sponsorMatchType: OrganizationMatchResult["matchedBy"];
  hasWarnings: boolean;
}): ImportPreviewRow["status"] {
  if (!input.row.companyName || !input.row.normalizedCompanyName) return "error";
  if (input.duplicateWithinFile) return "duplicate";
  if (input.hasWarnings || input.sponsorMatchType === "ambiguous") return "warning";
  return "valid";
}

export function inferPaymentStatus(input: { statusRaw?: string; notes?: string; sponsorshipPackage?: string }): string {
  const haystack = `${input.statusRaw ?? ""} ${input.notes ?? ""} ${input.sponsorshipPackage ?? ""}`.toLowerCase();
  if (!haystack.trim()) return "unknown";
  if (haystack.includes("unpaid")) return "unknown";
  if (haystack.includes("paid via kindful") || /\bpaid\b/.test(haystack)) return "paid_external";
  if (haystack.includes("invoiced")) return "invoiced";
  if (haystack.includes("need invoice") || haystack.includes("invoice needed") || haystack.includes("asked if we can invoice")) {
    return "invoice_needed";
  }
  if (haystack.includes("to pay at event")) return "pending_event_payment";
  if (haystack.includes("comped")) return "comped";
  return "unknown";
}

export function parseYearValue(rawValue: string): ParsedYearHistory {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return { year: 0, rawValue, participationStatus: "no_known_participation" };
  }

  if (normalized === "x") {
    return { year: 0, rawValue, participationStatus: "participated_unknown_amount" };
  }

  if (normalized === "new") {
    return { year: 0, rawValue, participationStatus: "new_prospect" };
  }

  const amount = parseMoney(rawValue);
  if (amount !== undefined) {
    return { year: 0, rawValue, amount, participationStatus: "participated_with_amount" };
  }

  return { year: 0, rawValue, participationStatus: "participated_text" };
}

function namesAreClose(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  if (union === 0) return false;
  return intersection / union >= 0.6;
}

export function detectFollowUps(row: {
  logoStatus?: string;
  attendeeNamesRaw?: string;
  paymentStatus: string;
  contactEmail?: string;
  contactPhone?: string;
  statusRaw?: string;
  notes?: string;
  pointPersonName?: string;
}): SuggestedFollowUp[] {
  const suggestions: SuggestedFollowUp[] = [];
  const normalizedLogo = (row.logoStatus ?? "").toLowerCase();
  const normalizedNames = (row.attendeeNamesRaw ?? "").toLowerCase();
  const normalizedText = `${row.statusRaw ?? ""} ${row.notes ?? ""}`.toLowerCase();

  if (!normalizedLogo || normalizedLogo.includes("need logo") || normalizedLogo.includes("missing logo") || normalizedLogo.includes("logo needed")) {
    suggestions.push({
      type: "need_logo",
      title: "Need sponsor logo",
      description: "Logo status indicates the logo is missing or pending.",
      sourceText: row.logoStatus ?? row.notes ?? row.statusRaw ?? "",
      confidence: 0.92,
      assignedToName: row.pointPersonName,
    });
  }

  if (!normalizedNames || normalizedNames.includes("need names") || normalizedNames.includes("need golfer names") || normalizedNames.includes("need foursome") || normalizedNames.includes("golfers tbd")) {
    suggestions.push({
      type: "need_names",
      title: "Need golfer/attendee names",
      description: "Attendee names are blank or marked pending.",
      sourceText: row.attendeeNamesRaw ?? row.notes ?? row.statusRaw ?? "",
      confidence: 0.9,
      assignedToName: row.pointPersonName,
    });
  }

  if (row.paymentStatus === "invoice_needed") {
    suggestions.push({
      type: "need_invoice",
      title: "Invoice follow-up",
      description: `Payment status is ${row.paymentStatus}.`,
      sourceText: row.statusRaw ?? row.notes ?? "",
      confidence: 0.88,
      assignedToName: row.pointPersonName,
    });
  }

  if (row.paymentStatus === "pending_event_payment" || normalizedText.includes("unpaid") || normalizedText.includes("waiting on payment") || normalizedText.includes("to pay at event")) {
    suggestions.push({
      type: "need_payment",
      title: "Payment follow-up",
      description: `Payment status is ${row.paymentStatus}.`,
      sourceText: row.statusRaw ?? row.notes ?? "",
      confidence: 0.86,
      assignedToName: row.pointPersonName,
    });
  }

  if (!row.contactEmail && !row.contactPhone) {
    suggestions.push({
      type: "need_contact_info",
      title: "Need contact information",
      description: "No contact email or phone was found in the row.",
      sourceText: row.statusRaw ?? row.notes ?? "",
      confidence: 0.84,
      assignedToName: row.pointPersonName,
    });
  }

  if (normalizedText.includes("waiting") || normalizedText.includes("follow up") || normalizedText.includes("pending response") || normalizedText.includes("no response")) {
    suggestions.push({
      type: "waiting_response",
      title: "Waiting on sponsor response",
      description: "Status/notes indicate pending response.",
      sourceText: row.statusRaw ?? row.notes ?? "",
      confidence: 0.8,
      assignedToName: row.pointPersonName,
    });
  }

  const deduped = new Map<string, SuggestedFollowUp>();
  for (const suggestion of suggestions) {
    if (!deduped.has(suggestion.type)) deduped.set(suggestion.type, suggestion);
  }
  return [...deduped.values()];
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new EventureServiceError("CSV is empty.", 400);
  }

  const headers = normalizeHeaders(parseCsvLine(lines[0]).map((header) => header.trim()));
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { headers, rows };
}

async function resolveCsvForParsing(
  csvContent: string,
  parserStrategy: SponsorImportParserStrategy,
): Promise<{ content: string; parserUsed: SponsorImportParserStrategy; parserWarnings: string[] }> {
  if (parserStrategy !== "llama_core") {
    return {
      content: csvContent,
      parserUsed: "native",
      parserWarnings: [],
    };
  }

  if (!canUseSharedParser()) {
    return {
      content: csvContent,
      parserUsed: "native",
      parserWarnings: ["llama_core parser requested but shared parser is unavailable; using native CSV parser."],
    };
  }

  const tempFilePath = path.join(os.tmpdir(), `eventure-sponsor-import-${Date.now()}.csv`);
  try {
    await fs.writeFile(tempFilePath, csvContent, "utf8");
    const parsed = await parseDocumentWithSharedService(tempFilePath, { mimeType: "text/csv" });
    const parsedText = (parsed.text || parsed.markdown || "").trim();

    if (!parsedText) {
      return {
        content: csvContent,
        parserUsed: "native",
        parserWarnings: ["llama_core parser returned empty content; using native CSV parser."],
      };
    }

    return {
      content: parsedText,
      parserUsed: "llama_core",
      parserWarnings: [],
    };
  } catch {
    return {
      content: csvContent,
      parserUsed: "native",
      parserWarnings: ["llama_core parser failed; using native CSV parser."],
    };
  } finally {
    await fs.unlink(tempFilePath).catch(() => undefined);
  }
}

function extractDomain(email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || undefined;
}

function resolveMappedHeaderIndex(headers: string[], aliases: string[]): number | undefined {
  const normalizedMap = headers.map((header) => normalizeHeader(header));
  for (const alias of aliases) {
    const index = normalizedMap.findIndex((value) => value === normalizeHeader(alias));
    if (index >= 0) return index;
  }
  return undefined;
}

function mapColumns(headers: string[]) {
  const mapped: Record<string, number | undefined> = {};
  const columnMapping: ColumnMappingEntry[] = [];

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = resolveMappedHeaderIndex(headers, aliases);
    mapped[field] = index;
    if (index !== undefined) {
      columnMapping.push({
        sourceColumn: headers[index],
        normalizedColumn: normalizeHeader(headers[index]),
        target: field,
        confidence: 1,
      });
    }
  }

  const yearColumns: Array<{ index: number; year: number; header: string; occurrence: number }> = [];
  const yearOccurrence = new Map<number, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const match = normalized.match(/\b(20\d{2})\b/);
    if (!match) return;
    if (normalized.includes("yr") || normalized === match[1]) {
      const year = Number.parseInt(match[1], 10);
      if (year >= 2000 && year <= 2099) {
        const occurrence = (yearOccurrence.get(year) ?? 0) + 1;
        yearOccurrence.set(year, occurrence);
        yearColumns.push({ index, year, header, occurrence });
        columnMapping.push({
          sourceColumn: header,
          normalizedColumn: normalized,
          target: year === 2026 && occurrence > 1 ? "eventSponsor.committedAmount" : `sponsorYearHistory.${year}`,
          confidence: occurrence === 1 ? 0.95 : 0.75,
          warning: occurrence > 1 && year === 2026 ? "Duplicate 2026 YR column normalized for committed amount handling." : undefined,
        });
      }
    }

    if (mapped.currentAmount === undefined && normalized.includes(match[1]) && normalized.includes("amount")) {
      mapped.currentAmount = index;
      columnMapping.push({
        sourceColumn: header,
        normalizedColumn: normalized,
        target: "eventSponsor.committedAmount",
        confidence: 0.9,
      });
    }
  });

  if (mapped.currentAmount === undefined) {
    const fallbackAmountIndex = headers.findIndex((header) => /current.*amount|amount.*current|committed amount/i.test(header));
    if (fallbackAmountIndex >= 0) {
      mapped.currentAmount = fallbackAmountIndex;
      columnMapping.push({
        sourceColumn: headers[fallbackAmountIndex],
        normalizedColumn: normalizeHeader(headers[fallbackAmountIndex]),
        target: "eventSponsor.committedAmount",
        confidence: 0.7,
      });
    }
  }

  return {
    mapped,
    yearColumns,
    columnMapping,
  };
}

function getCell(row: string[], index?: number): string {
  if (index === undefined) return "";
  return cleanCell(row[index]);
}

function parseRows(content: string): {
  headers: string[];
  mapped: Record<string, number | undefined>;
  yearColumns: Array<{ index: number; year: number; header: string; occurrence: number }>;
  columnMapping: ColumnMappingEntry[];
  rows: ParsedSponsorRow[];
} {
  const { headers, rows } = parseCsv(content);
  const { mapped, yearColumns, columnMapping } = mapColumns(headers);

  if (mapped.company === undefined) {
    throw new EventureServiceError("CSV must include a Company column.", 400);
  }

  const parsedRows: ParsedSponsorRow[] = rows.map((row, rowOffset) => {
    const rowNumber = rowOffset + 2;
    const warnings: ImportWarning[] = [];

    const companyName = getCell(row, mapped.company);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const addressLine1 = getCell(row, mapped.addressLine1) || undefined;
    const cityStateZipRaw = getCell(row, mapped.cityStateZip);
    const { city, state, zipCode } = splitCityStateZip(cityStateZipRaw || undefined);

    const representativeRaw = getCell(row, mapped.representative);
    const emailRaw = getCell(row, mapped.contactEmail).toLowerCase() || undefined;
    const phoneRaw = getCell(row, mapped.contactPhone) || undefined;

    const multipleNameSignals = /\s+and\s+|;|\|/.test(representativeRaw.toLowerCase());
    const multipleEmailSignals = !!emailRaw && /;|,|\|/.test(emailRaw);
    const multiplePhoneSignals = !!phoneRaw && /;|\||\//.test(phoneRaw);

    if (multipleNameSignals || multipleEmailSignals || multiplePhoneSignals) {
      warnings.push({
        rowNumber,
        code: "MULTI_CONTACT_REVIEW",
        message: "Representative/email/phone appears to contain multiple contacts. Review recommended.",
      });
    }

    const contactName = representativeRaw.split(/\s+and\s+|;|\||\//i)[0]?.trim() || undefined;
    const contactEmail = emailRaw?.split(/[;,|]/)[0]?.trim() || undefined;
    const contactPhone = phoneRaw?.split(/[;|/]/)[0]?.trim() || undefined;

    const sponsorshipPackage = getCell(row, mapped.sponsorshipPackage) || undefined;
    const flightPreference = normalizeFlightPreference(getCell(row, mapped.flight)) || undefined;
    const logoStatus = normalizeLogoStatus(getCell(row, mapped.logo)) || undefined;
    const attendeeNamesRaw = getCell(row, mapped.names) || undefined;
    const statusRaw = getCell(row, mapped.status) || undefined;
    const pointPersonName = getCell(row, mapped.pointPerson) || undefined;
    const notes = getCell(row, mapped.notes) || undefined;
    const duplicate2026CurrentAmount = yearColumns
      .filter((yearColumn) => yearColumn.year === 2026 && yearColumn.occurrence > 1)
      .map((yearColumn) => parseMoney(getCell(row, yearColumn.index)))
      .find((value) => value !== undefined);
    const committedAmount = parseMoney(getCell(row, mapped.currentAmount)) ?? duplicate2026CurrentAmount;

    const paymentStatus = inferPaymentStatus({ statusRaw, notes, sponsorshipPackage });

    const yearHistory: ParsedYearHistory[] = yearColumns
      .map((yearColumn) => {
        const value = getCell(row, yearColumn.index);
        if (!value) return null;
        if (yearColumn.year === 2026 && yearColumn.occurrence > 1) {
          return null;
        }
        const parsed = parseYearValue(value);
        return {
          ...parsed,
          year: yearColumn.year,
        };
      })
      .filter((item): item is ParsedYearHistory => !!item);

    if (!companyName) {
      warnings.push({
        rowNumber,
        code: "MISSING_COMPANY",
        message: "Row does not include Company and will be skipped.",
      });
    }

    const paymentNotes = [statusRaw, notes].filter(Boolean).join(" | ") || undefined;

    const suggestedFollowUps = detectFollowUps({
      logoStatus,
      attendeeNamesRaw,
      paymentStatus,
      contactEmail,
      contactPhone,
      statusRaw,
      notes,
      pointPersonName,
    });

    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      raw[header] = cleanCell(row[index]);
    });

    return {
      rowNumber,
      raw,
      companyName,
      normalizedCompanyName,
      addressLine1,
      city,
      state,
      zipCode,
      contactName,
      contactEmail,
      contactPhone,
      sponsorshipPackage,
      flightPreference,
      logoStatus,
      attendeeNamesRaw,
      statusRaw,
      pointPersonName,
      notes,
      committedAmount,
      paymentStatus,
      paymentNotes,
      yearHistory,
      warnings,
      suggestedFollowUps,
    };
  });

  return {
    headers,
    mapped,
    yearColumns,
    columnMapping,
    rows: parsedRows,
  };
}

type OrganizationMatchResult = {
  action: "create" | "update" | "review";
  matchedBy: "normalized_name" | "name_phone" | "name_email_domain" | "new" | "ambiguous";
  sponsorOrganizationId?: string;
  candidates?: Array<{ id: string; name: string; reason: string }>;
};

type ContactMatchResult = {
  action: "create" | "update" | "review";
  matchedBy: "email" | "phone" | "name_company" | "new" | "ambiguous";
  sponsorContactId?: string;
  candidates?: Array<{ id: string; name: string; email?: string; phone?: string; reason: string }>;
};

function findSponsorMatch(args: {
  row: ParsedSponsorRow;
  existingSponsors: Awaited<ReturnType<typeof listSponsorOrganizationsForOrganization>>;
  warnings: ImportWarning[];
}): OrganizationMatchResult {
  const { row, existingSponsors, warnings } = args;
  if (!row.normalizedCompanyName) {
    return { action: "create", matchedBy: "new" };
  }

  const byName = existingSponsors.find((item) => item.normalizedName === row.normalizedCompanyName);
  if (byName) {
    return { action: "update", matchedBy: "normalized_name", sponsorOrganizationId: byName.id };
  }

  const closeNameCandidates = existingSponsors.filter((item) =>
    namesAreClose(item.normalizedName, row.normalizedCompanyName),
  );

  const rowPhone = normalizePhone(row.contactPhone);
  if (rowPhone) {
    const phoneCandidates = closeNameCandidates.filter((item) => {
      const existingPhone = normalizePhone(item.mainPhone ?? undefined);
      return existingPhone === rowPhone;
    });

    if (phoneCandidates.length === 1) {
      return {
        action: "update",
        matchedBy: "name_phone",
        sponsorOrganizationId: phoneCandidates[0].id,
      };
    }

    if (phoneCandidates.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "SPONSOR_MATCH_REVIEW",
        message: "Multiple sponsor organizations matched by name+phone. Row requires review.",
      });
      return { action: "review", matchedBy: "ambiguous" };
    }
  }

  const rowDomain = extractDomain(row.contactEmail);
  if (rowDomain) {
    const domainCandidates = closeNameCandidates.filter((item) => {
      const existingDomain = extractDomain(item.mainEmail ?? undefined);
      return existingDomain === rowDomain;
    });

    if (domainCandidates.length === 1) {
      return {
        action: "update",
        matchedBy: "name_email_domain",
        sponsorOrganizationId: domainCandidates[0].id,
      };
    }

    if (domainCandidates.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "SPONSOR_MATCH_REVIEW",
        message: "Multiple sponsor organizations matched by name+email domain. Row requires review.",
      });
      return {
        action: "review",
        matchedBy: "ambiguous",
        candidates: domainCandidates.map((item) => ({ id: item.id, name: item.name, reason: "name_email_domain" })),
      };
    }
  }

  if (closeNameCandidates.length > 0) {
    warnings.push({
      rowNumber: row.rowNumber,
      code: "SPONSOR_MATCH_REVIEW",
      message: "Similar sponsor organization names found, but no unique phone/email-domain match. Row requires review.",
    });
    return {
      action: "review",
      matchedBy: "ambiguous",
      candidates: closeNameCandidates.map((item) => ({ id: item.id, name: item.name, reason: "similar_name" })),
    };
  }

  return { action: "create", matchedBy: "new" };
}

function findContactMatch(args: {
  row: ParsedSponsorRow;
  matchedSponsor?: Awaited<ReturnType<typeof listSponsorOrganizationsForOrganization>>[number];
  warnings: ImportWarning[];
  allowNameCompanyMatch?: boolean;
}): ContactMatchResult {
  const { row, matchedSponsor, warnings, allowNameCompanyMatch = false } = args;
  if (!matchedSponsor) return { action: "create", matchedBy: "new" };

  if (row.contactEmail) {
    const byEmail = matchedSponsor.contacts.filter((contact) =>
      !!contact.email && contact.email.toLowerCase() === row.contactEmail?.toLowerCase(),
    );
    if (byEmail.length === 1) {
      return { action: "update", matchedBy: "email", sponsorContactId: byEmail[0].id };
    }
    if (byEmail.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "CONTACT_MATCH_REVIEW",
        message: "Multiple sponsor contacts matched by email. Row requires review.",
      });
      return {
        action: "review",
        matchedBy: "ambiguous",
        candidates: byEmail.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email ?? undefined,
          phone: item.phone ?? undefined,
          reason: "email",
        })),
      };
    }
  }

  const rowPhone = normalizePhone(row.contactPhone);
  if (rowPhone) {
    const byPhone = matchedSponsor.contacts.filter((contact) =>
      normalizePhone(contact.phone ?? undefined) === rowPhone,
    );
    if (byPhone.length === 1) {
      return { action: "update", matchedBy: "phone", sponsorContactId: byPhone[0].id };
    }
    if (byPhone.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "CONTACT_MATCH_REVIEW",
        message: "Multiple sponsor contacts matched by phone. Row requires review.",
      });
      return {
        action: "review",
        matchedBy: "ambiguous",
        candidates: byPhone.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email ?? undefined,
          phone: item.phone ?? undefined,
          reason: "phone",
        })),
      };
    }
  }

  if (allowNameCompanyMatch && row.contactName) {
    const byName = matchedSponsor.contacts.filter((contact) =>
      normalizeName(contact.name) === normalizeName(row.contactName),
    );
    if (byName.length === 1) {
      return { action: "update", matchedBy: "name_company", sponsorContactId: byName[0].id };
    }
    if (byName.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "CONTACT_MATCH_REVIEW",
        message: "Multiple sponsor contacts matched by name within company. Row requires review.",
      });
      return {
        action: "review",
        matchedBy: "ambiguous",
        candidates: byName.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email ?? undefined,
          phone: item.phone ?? undefined,
          reason: "name_company",
        })),
      };
    }
  }

  if (row.contactName && !row.contactEmail && !row.contactPhone) {
    const possibleNameMatches = matchedSponsor.contacts.filter((contact) =>
      normalizeName(contact.name).includes(normalizeName(row.contactName)),
    );
    if (possibleNameMatches.length > 0) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "CONTACT_MATCH_REVIEW",
        message: "Name-only contact data cannot be auto-merged. Row requires review.",
      });
      return {
        action: "review",
        matchedBy: "ambiguous",
        candidates: possibleNameMatches.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email ?? undefined,
          phone: item.phone ?? undefined,
          reason: "name_only_requires_review",
        })),
      };
    }
  }

  return { action: "create", matchedBy: "new" };
}

function preferExisting(existing?: string | null, incoming?: string): string | undefined {
  if (existing && existing.trim()) return existing;
  if (!incoming) return undefined;
  return incoming;
}

function mergeNotes(existing?: string | null, incoming?: string): string | undefined {
  const current = existing?.trim();
  const next = incoming?.trim();
  if (!current) return next || undefined;
  if (!next || current.includes(next)) return current;
  return `${current}\n${next}`;
}

export async function previewSponsorImportForEvent(input: {
  organizationId: string;
  eventId?: string;
  createdByUserId: string;
  csvContent: string;
  fileName?: string;
  parserStrategy?: SponsorImportParserStrategy;
  mode?: ImportModeInput;
}) {
  const canonicalMode = toCanonicalImportMode(input.mode);
  if (input.eventId) {
    const event = await getActiveEventForOrganization(input.organizationId, input.eventId);
    if (!event) {
      throw new EventureServiceError("Event not found.", 404);
    }
  } else if (requiresExistingEventIdForPreview(canonicalMode)) {
    throw new EventureServiceError("eventId is required for this import mode during preview.", 400);
  }

  const parseResolution = await resolveCsvForParsing(input.csvContent, input.parserStrategy ?? "native");
  const parsed = parseRows(parseResolution.content);
  const existingSponsors = await listSponsorOrganizationsForOrganization(input.organizationId);

  const mode = toCanonicalImportMode(input.mode);

  const importBatch = await createImportBatch({
    organizationId: input.organizationId,
    eventId: input.eventId,
    fileName: input.fileName ?? `eventure-sponsor-import-${Date.now()}.csv`,
    fileType: "text/csv",
    fileUrl: `inline://eventure/${input.eventId ?? input.organizationId}/${Date.now()}`,
    createdByUserId: input.createdByUserId,
    totalRows: parsed.rows.length,
    status: "previewing",
    mappingConfig: {
      mappedColumns: parsed.mapped,
      yearColumns: parsed.yearColumns,
      columnMapping: parsed.columnMapping,
      importType: "sponsor_master_list",
      mode,
      parserStrategyRequested: input.parserStrategy ?? "native",
      parserUsed: parseResolution.parserUsed,
      parserWarnings: parseResolution.parserWarnings,
    },
  });

  const existingEventSponsorRows = input.eventId
    ? await listEventSponsorsForEvent(input.organizationId, input.eventId)
    : [];
  const existingEventSponsorSet = new Set(existingEventSponsorRows.map((item) => item.sponsorOrganizationId));
  const seenCompanies = new Set<string>();

  const rows: ImportPreviewRow[] = [];
  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  let duplicateRows = 0;
  let companiesDetected = 0;
  let contactsDetected = 0;
  let eventSponsorsDetected = 0;
  let historyRecordsDetected = 0;
  let followUpsDetected = 0;

  try {
    for (const row of parsed.rows) {
      const rowWarnings = [...row.warnings];
      const rowErrors: string[] = [];
      const duplicateWithinFile = row.normalizedCompanyName ? seenCompanies.has(row.normalizedCompanyName) : false;
      if (row.normalizedCompanyName) {
        seenCompanies.add(row.normalizedCompanyName);
      }

      if (duplicateWithinFile) {
        rowWarnings.push({
          rowNumber: row.rowNumber,
          code: "DUPLICATE_COMPANY_IN_FILE",
          message: "This company appears more than once in the uploaded CSV.",
        });
      }

      if (!row.companyName || !row.normalizedCompanyName) {
        rowErrors.push("Missing company name");
      }

      const sponsorMatch = row.normalizedCompanyName
        ? findSponsorMatch({ row, existingSponsors, warnings: rowWarnings })
        : { action: "review" as const, matchedBy: "ambiguous" as const };

      const matchedSponsor = sponsorMatch.sponsorOrganizationId
        ? existingSponsors.find((item) => item.id === sponsorMatch.sponsorOrganizationId)
        : undefined;

      const matchedContact = matchedSponsor
        ? findContactMatch({
          row,
          matchedSponsor,
          warnings: rowWarnings,
          allowNameCompanyMatch: sponsorMatch.matchedBy === "normalized_name",
        })
        : { action: "create" as const, matchedBy: "new" as const };

      const existingEventSponsor = usesEventAssignment(mode) && input.eventId && sponsorMatch.sponsorOrganizationId
        ? await getEventSponsorByComposite({
          organizationId: input.organizationId,
          eventId: input.eventId,
          sponsorOrganizationId: sponsorMatch.sponsorOrganizationId,
        })
        : undefined;

      const targetReview =
        rowErrors.length > 0 ||
        duplicateWithinFile ||
        sponsorMatch.action === "review" ||
        matchedContact.action === "review";
      const sponsorOrganizationTarget: PreviewRowTarget = rowErrors.length > 0
        ? "skip"
        : targetReview
          ? "review"
          : sponsorMatch.action;
      const sponsorContactTarget: PreviewRowTarget = !row.contactName && !row.contactEmail && !row.contactPhone
        ? "skip"
        : targetReview
          ? "review"
          : matchedContact.action === "update"
            ? "update"
            : "create";
      const eventSponsorTarget: PreviewRowTarget = !usesEventAssignment(mode)
        ? "skip"
        : rowErrors.length > 0
          ? "skip"
          : targetReview
            ? "review"
            : existingEventSponsor || existingEventSponsorSet.has(sponsorMatch.sponsorOrganizationId ?? "")
              ? "update"
              : "create";
      const sponsorYearHistoryTarget: PreviewRowTarget = row.yearHistory.length === 0
        ? "skip"
        : targetReview
          ? "review"
          : sponsorMatch.action === "update"
            ? "update"
            : "create";
      const sponsorFollowUpTarget: PreviewRowTarget = !usesEventAssignment(mode)
        ? "skip"
        : row.suggestedFollowUps.length === 0
          ? "skip"
          : targetReview
            ? "review"
            : "create";

      const rowStatus = classifyRowStatus({
        row,
        duplicateWithinFile,
        sponsorMatchType: sponsorMatch.matchedBy,
        hasWarnings: rowWarnings.length > 0,
      });

      if (rowStatus === "error") errorRows += 1;
      else if (rowStatus === "duplicate") duplicateRows += 1;
      else if (rowStatus === "warning") warningRows += 1;
      else validRows += 1;

      if (sponsorOrganizationTarget !== "skip") companiesDetected += 1;
      if (sponsorContactTarget !== "skip") contactsDetected += 1;
      if (eventSponsorTarget !== "skip") eventSponsorsDetected += 1;
      historyRecordsDetected += row.yearHistory.length;
      followUpsDetected += usesEventAssignment(mode) ? row.suggestedFollowUps.length : 0;

      const previewRow: ImportPreviewRow = {
        importRowId: "",
        rowNumber: row.rowNumber,
        status: rowStatus,
        decision: targetReview ? "needs_review" : "approve",
        raw: row.raw,
        normalized: {
          companyName: row.companyName || undefined,
          representativeName: row.contactName || undefined,
          email: row.contactEmail || undefined,
          phone: row.contactPhone || undefined,
          addressLine1: row.addressLine1,
          city: row.city,
          state: row.state,
          zipCode: row.zipCode,
          sponsorshipPackage: row.sponsorshipPackage,
          committedAmount: row.committedAmount,
          paymentStatus: row.paymentStatus,
          logoStatus: row.logoStatus,
          flightPreference: row.flightPreference,
          attendeeNamesRaw: row.attendeeNamesRaw,
          pointPersonName: row.pointPersonName,
          notes: row.notes,
        },
        editableNormalized: {
          companyName: row.companyName || undefined,
          representativeName: row.contactName || undefined,
          email: row.contactEmail || undefined,
          phone: row.contactPhone || undefined,
          addressLine1: row.addressLine1,
          city: row.city,
          state: row.state,
          zipCode: row.zipCode,
          sponsorshipPackage: row.sponsorshipPackage,
          committedAmount: row.committedAmount,
          paymentStatus: row.paymentStatus,
          logoStatus: row.logoStatus,
          flightPreference: row.flightPreference,
          attendeeNamesRaw: row.attendeeNamesRaw,
          pointPersonName: row.pointPersonName,
          notes: row.notes,
        },
        targets: {
          sponsorOrganization: sponsorOrganizationTarget,
          sponsorContact: sponsorContactTarget,
          eventSponsor: eventSponsorTarget,
          sponsorYearHistory: sponsorYearHistoryTarget,
          sponsorFollowUp: sponsorFollowUpTarget,
        },
        warnings: rowWarnings.map((warning) => warning.message),
        errors: rowErrors,
        matchedRecords: {
          sponsorOrganizationId: sponsorMatch.sponsorOrganizationId,
          sponsorContactId: matchedContact.sponsorContactId,
          eventSponsorId: existingEventSponsor?.id,
        },
        duplicateCandidates: {
          sponsorOrganizations: sponsorMatch.candidates,
          sponsorContacts: matchedContact.candidates,
        },
      };

      const savedRow = await createImportRow({
        organizationId: input.organizationId,
        eventId: input.eventId,
        importBatchId: importBatch.id,
        rowNumber: row.rowNumber,
        rawData: row.raw,
        normalizedData: {
          ...previewRow.normalized,
          rowStatus: previewRow.status,
          warnings: previewRow.warnings,
          errors: previewRow.errors,
          targets: previewRow.targets,
          matchedRecords: previewRow.matchedRecords,
          duplicateCandidates: previewRow.duplicateCandidates,
          yearHistory: row.yearHistory,
          suggestedFollowUps: row.suggestedFollowUps,
          paymentNotes: row.paymentNotes,
          statusRaw: row.statusRaw,
        },
        status: previewRow.status,
        errorMessage: previewRow.errors.length > 0 ? previewRow.errors.join(" | ") : previewRow.warnings.join(" | ") || undefined,
      });

      previewRow.importRowId = savedRow.id;
      rows.push(previewRow);
    }

    const status = errorRows > 0 || warningRows > 0 || duplicateRows > 0 ? "needs_review" : "preview_ready";

    await completeImportBatch({
      importBatchId: importBatch.id,
      parsedRows: parsed.rows.length,
      validRows,
      errorRows,
      duplicateRows,
      status,
    });

    return {
      importBatchId: importBatch.id,
      importType: "sponsor_master_list",
      mode,
      eventId: input.eventId,
      fileName: input.fileName ?? "uploaded.csv",
      status,
      summary: {
        totalRows: parsed.rows.length,
        validRows,
        warningRows,
        errorRows,
        duplicateRows,
        companiesDetected,
        contactsDetected,
        eventSponsorsDetected,
        historyRecordsDetected,
        followUpsDetected,
      },
      columnMapping: parsed.columnMapping,
      rows,
    };
  } catch (error) {
    await failImportBatch(importBatch.id);
    throw error;
  }
}

export async function confirmSponsorImportForEvent(input: {
  organizationId: string;
  eventId?: string;
  createdByUserId: string;
  importBatchId: string;
  rowDecisions?: ConfirmRowDecisionInput[];
  createEvent?: ConfirmCreateEventInput;
}) {
  if (input.eventId) {
    const event = await getActiveEventForOrganization(input.organizationId, input.eventId);
    if (!event) {
      throw new EventureServiceError("Event not found.", 404);
    }
  }

  const importBatch = await getImportBatchWithRows(input.importBatchId, input.organizationId);
  if (!importBatch || (input.eventId && importBatch.eventId !== input.eventId)) {
    throw new EventureServiceError("Import batch not found.", 404);
  }

  if (!["preview_ready", "needs_review", "previewing"].includes(importBatch.status)) {
    throw new EventureServiceError("Import batch is not ready to confirm.", 400);
  }

  const mappingConfig = importBatch.mappingConfig as { mode?: ImportModeInput };
  const mode = toCanonicalImportMode(mappingConfig.mode);
  let effectiveEventId = input.eventId ?? importBatch.eventId ?? undefined;

  if (mode === "create_event_then_assign" && input.createEvent) {
    const fallbackStart = new Date(Date.now() + 60 * 60 * 1000);
    const fallbackEnd = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const parsedStart = input.createEvent.startDateTime ? new Date(input.createEvent.startDateTime) : fallbackStart;
    const parsedEnd = input.createEvent.endDateTime ? new Date(input.createEvent.endDateTime) : fallbackEnd;

    const createdEvent = await createEventForOrganization({
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      title: (input.createEvent.title ?? "Sponsor Import Event").trim(),
      description: input.createEvent.description?.trim() || "Auto-created at sponsor import confirmation.",
      status: input.createEvent.status,
      eventType: input.createEvent.eventType,
      timezone: input.createEvent.timezone,
      venueName: (input.createEvent.venueName ?? "TBD").trim(),
      startDateTime: Number.isNaN(parsedStart.getTime()) ? fallbackStart : parsedStart,
      endDateTime: Number.isNaN(parsedEnd.getTime()) ? fallbackEnd : parsedEnd,
    });
    effectiveEventId = createdEvent.id;
  }

  if (usesEventAssignment(mode) && !effectiveEventId) {
    throw new EventureServiceError("eventId is required for this import mode.", 400);
  }
  const existingSponsors = await listSponsorOrganizationsForOrganization(input.organizationId);

  const decisionByImportRowId = new Map<string, ConfirmRowDecisionInput>();
  const decisionByRowNumber = new Map<number, ConfirmRowDecisionInput>();

  for (const decision of input.rowDecisions ?? []) {
    if (decision.importRowId) {
      decisionByImportRowId.set(decision.importRowId, decision);
    }
    if (typeof decision.rowNumber === "number" && Number.isFinite(decision.rowNumber)) {
      decisionByRowNumber.set(decision.rowNumber, decision);
    }
  }

  let sponsorOrganizationsCreated = 0;
  let sponsorOrganizationsUpdated = 0;
  let sponsorContactsCreated = 0;
  let sponsorContactsUpdated = 0;
  let eventSponsorsCreated = 0;
  let eventSponsorsUpdated = 0;
  let yearHistoryCreated = 0;
  let yearHistoryUpdated = 0;
  let followUpsCreated = 0;
  let importedRows = 0;
  let importedRowsWithWarnings = 0;
  let skippedRows = 0;
  let failedRows = 0;

  try {
    for (const row of importBatch.rows) {
      const rowDecision = decisionByImportRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
      const baseStored = row.normalizedData as unknown as StoredSponsorImportRow;
      const resolvedDecision = rowDecision?.decision ?? defaultDecisionForStoredRow(baseStored);
      const stored = mergeEditableNormalized(baseStored, rowDecision?.editableNormalized);

      if (resolvedDecision === "skip" || resolvedDecision === "needs_review") {
        skippedRows += 1;
        await updateImportRowStatus({
          id: row.id,
          status: "skipped",
          errorMessage: resolvedDecision === "skip" ? "Row skipped by decision." : "Row marked for review.",
        });
        continue;
      }

      if (stored.rowStatus === "error" || stored.errors.length > 0 || !stored.companyName || !stored.normalizedCompanyName) {
        failedRows += 1;
        await updateImportRowStatus({
          id: row.id,
          status: "failed",
          errorMessage: stored.errors.join(" | ") || "Missing company name",
        });
        continue;
      }

      if (stored.rowStatus === "duplicate") {
        skippedRows += 1;
        await updateImportRowStatus({
          id: row.id,
          status: "skipped",
          errorMessage: "Duplicate row in uploaded CSV.",
        });
        continue;
      }

      const rowForMatch: ParsedSponsorRow = {
        rowNumber: row.rowNumber,
        raw: row.rawData as Record<string, string>,
        companyName: stored.companyName,
        normalizedCompanyName: stored.normalizedCompanyName,
        addressLine1: stored.addressLine1,
        city: stored.city,
        state: stored.state,
        zipCode: stored.zipCode,
        contactName: stored.representativeName,
        contactEmail: stored.email,
        contactPhone: stored.phone,
        sponsorshipPackage: stored.sponsorshipPackage,
        flightPreference: stored.flightPreference,
        logoStatus: stored.logoStatus,
        attendeeNamesRaw: stored.attendeeNamesRaw,
        statusRaw: stored.statusRaw,
        pointPersonName: stored.pointPersonName,
        notes: stored.notes,
        committedAmount: stored.committedAmount,
        paymentStatus: stored.paymentStatus ?? "unknown",
        paymentNotes: stored.paymentNotes,
        yearHistory: stored.yearHistory ?? [],
        warnings: [],
        suggestedFollowUps: stored.suggestedFollowUps ?? [],
      };

      const sponsorWarnings: ImportWarning[] = [];
      const sponsorMatch = resolvedDecision === "create_new"
        ? { action: "create" as const, matchedBy: "new" as const }
        : findSponsorMatch({ row: rowForMatch, existingSponsors, warnings: sponsorWarnings });
      let sponsorOrganization = sponsorMatch.sponsorOrganizationId
        ? existingSponsors.find((item) => item.id === sponsorMatch.sponsorOrganizationId)
        : undefined;

      if (!sponsorOrganization) {
        sponsorOrganization = await createSponsorOrganization({
          organizationId: input.organizationId,
          name: rowForMatch.companyName,
          normalizedName: rowForMatch.normalizedCompanyName,
          addressLine1: rowForMatch.addressLine1,
          city: rowForMatch.city,
          state: rowForMatch.state,
          zipCode: rowForMatch.zipCode,
          mainEmail: rowForMatch.contactEmail,
          mainPhone: rowForMatch.contactPhone,
          notes: rowForMatch.notes,
          sourceImportBatchId: importBatch.id,
        });
        existingSponsors.push(sponsorOrganization);
        sponsorOrganizationsCreated += 1;
      } else {
        sponsorOrganization = await updateSponsorOrganization({
          id: sponsorOrganization.id,
          name: preferExisting(sponsorOrganization.name, rowForMatch.companyName),
          addressLine1: preferExisting(sponsorOrganization.addressLine1, rowForMatch.addressLine1),
          city: preferExisting(sponsorOrganization.city, rowForMatch.city),
          state: preferExisting(sponsorOrganization.state, rowForMatch.state),
          zipCode: preferExisting(sponsorOrganization.zipCode, rowForMatch.zipCode),
          mainEmail: preferExisting(sponsorOrganization.mainEmail, rowForMatch.contactEmail),
          mainPhone: preferExisting(sponsorOrganization.mainPhone, rowForMatch.contactPhone),
          notes: mergeNotes(sponsorOrganization.notes, rowForMatch.notes),
          sourceImportBatchId: importBatch.id,
        });
        const listIndex = existingSponsors.findIndex((item) => item.id === sponsorOrganization?.id);
        if (listIndex >= 0 && sponsorOrganization) existingSponsors[listIndex] = sponsorOrganization;
        sponsorOrganizationsUpdated += 1;
      }

      if (rowForMatch.contactName || rowForMatch.contactEmail || rowForMatch.contactPhone) {
        const contactMatch = findContactMatch({
          row: rowForMatch,
          matchedSponsor: sponsorOrganization,
          warnings: sponsorWarnings,
          allowNameCompanyMatch: sponsorMatch.matchedBy === "normalized_name",
        });

        if (contactMatch.action === "review") {
          skippedRows += 1;
          await updateImportRowStatus({
            id: row.id,
            status: "skipped",
            errorMessage: "Contact match requires manual review.",
          });
          continue;
        }

        const matchedContact = contactMatch.sponsorContactId
          ? sponsorOrganization.contacts.find((contact) => contact.id === contactMatch.sponsorContactId)
          : undefined;

        if (contactMatch.action === "update" && matchedContact) {
          await updateSponsorContact({
            id: matchedContact.id,
            name: preferExisting(matchedContact.name, rowForMatch.contactName),
            email: preferExisting(matchedContact.email, rowForMatch.contactEmail),
            phone: preferExisting(matchedContact.phone, rowForMatch.contactPhone),
            sourceImportBatchId: importBatch.id,
          });
          sponsorContactsUpdated += 1;
        } else {
          await createSponsorContact({
            organizationId: input.organizationId,
            sponsorOrganizationId: sponsorOrganization.id,
            name: rowForMatch.contactName || rowForMatch.companyName,
            email: rowForMatch.contactEmail,
            phone: rowForMatch.contactPhone,
            isPrimary: true,
            sourceImportBatchId: importBatch.id,
          });
          sponsorContactsCreated += 1;
        }
      }

      let eventSponsor: Awaited<ReturnType<typeof getEventSponsorByComposite>> | undefined;
      if (usesEventAssignment(mode)) {
        eventSponsor = await getEventSponsorByComposite({
          organizationId: input.organizationId,
          eventId: effectiveEventId!,
          sponsorOrganizationId: sponsorOrganization.id,
        });

        eventSponsor = await upsertEventSponsor({
          organizationId: input.organizationId,
          eventId: effectiveEventId!,
          sponsorOrganizationId: sponsorOrganization.id,
          sponsorshipPackage: preferExisting(eventSponsor?.sponsorshipPackage, rowForMatch.sponsorshipPackage),
          committedAmount: eventSponsor?.committedAmount ?? rowForMatch.committedAmount,
          amountPaid: eventSponsor?.amountPaid,
          paymentStatus: rowForMatch.paymentStatus || eventSponsor?.paymentStatus || "unknown",
          paymentNotes: mergeNotes(eventSponsor?.paymentNotes, rowForMatch.paymentNotes),
          flightPreference: preferExisting(eventSponsor?.flightPreference, rowForMatch.flightPreference),
          logoStatus: preferExisting(eventSponsor?.logoStatus, rowForMatch.logoStatus),
          attendeeNamesRaw: preferExisting(eventSponsor?.attendeeNamesRaw, rowForMatch.attendeeNamesRaw),
          statusRaw: preferExisting(eventSponsor?.statusRaw, rowForMatch.statusRaw),
          notes: mergeNotes(eventSponsor?.notes, rowForMatch.notes),
          pointPersonName: preferExisting(eventSponsor?.pointPersonName, rowForMatch.pointPersonName),
          sourceImportBatchId: importBatch.id,
        });

        if (eventSponsor && eventSponsor.createdAt.getTime() === eventSponsor.updatedAt.getTime()) {
          eventSponsorsCreated += 1;
        } else {
          eventSponsorsUpdated += 1;
        }
      }

      for (const history of rowForMatch.yearHistory) {
        const existingHistory = await getSponsorYearHistory({
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          year: history.year,
          sourceType: "sponsor_master_list",
        });
        await upsertSponsorYearHistory({
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          year: history.year,
          rawValue: history.rawValue,
          amount: history.amount,
          participationStatus: history.participationStatus,
          sourceType: "sponsor_master_list",
          sourceImportBatchId: importBatch.id,
        });
        if (existingHistory) yearHistoryUpdated += 1;
        else yearHistoryCreated += 1;
      }

      if (usesEventAssignment(mode) && eventSponsor) {
        for (const suggestion of rowForMatch.suggestedFollowUps) {
          const existingFollowUp = await findExistingOpenFollowUp({
            organizationId: input.organizationId,
            eventId: effectiveEventId!,
            eventSponsorId: eventSponsor.id,
            sponsorOrganizationId: sponsorOrganization.id,
            type: suggestion.type,
          });

          if (existingFollowUp) continue;

          await createSponsorFollowUp({
            organizationId: input.organizationId,
            eventId: effectiveEventId!,
            eventSponsorId: eventSponsor.id,
            sponsorOrganizationId: sponsorOrganization.id,
            type: suggestion.type,
            title: suggestion.title,
            description: suggestion.description,
            assignedToName: suggestion.assignedToName,
            sourceImportBatchId: importBatch.id,
          });
          followUpsCreated += 1;
        }
      }

      await updateImportRowStatus({
        id: row.id,
        status: stored.rowStatus === "warning" || resolvedDecision === "edit" ? "imported_with_warnings" : "imported",
        errorMessage: stored.warnings.length > 0 ? stored.warnings.join(" | ") : undefined,
      });

      if (stored.rowStatus === "warning" || resolvedDecision === "edit") {
        importedRowsWithWarnings += 1;
      } else {
        importedRows += 1;
      }
    }

    const status = failedRows > 0 ? "failed" : (importedRowsWithWarnings > 0 || skippedRows > 0 ? "confirmed_with_warnings" : "confirmed");

    await completeImportBatch({
      importBatchId: importBatch.id,
      parsedRows: importBatch.totalRows,
      validRows: importedRows + importedRowsWithWarnings,
      errorRows: failedRows,
      duplicateRows: skippedRows,
      status,
    });

    return {
      importBatchId: importBatch.id,
      eventId: effectiveEventId,
      status,
      summary: {
        sponsorOrganizationsCreated,
        sponsorOrganizationsUpdated,
        sponsorContactsCreated,
        sponsorContactsUpdated,
        eventSponsorsCreated,
        eventSponsorsUpdated,
        yearHistoryCreated,
        yearHistoryUpdated,
        followUpsCreated,
        skippedRows,
        failedRows,
      },
      nextActions: [
        { label: "View Contacts & Sponsors", href: "/contacts" },
        ...(effectiveEventId ? [{ label: "View Event Sponsors", href: `/events/${effectiveEventId}/sponsors` }] : []),
        { label: "View Follow-Ups", href: "/follow-ups" },
      ],
    };
  } catch (error) {
    await failImportBatch(importBatch.id);
    throw error;
  }
}
