import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import XLSX from "xlsx";
import {
  completeImportBatch,
  createEventFlightSlot,
  createEventVolunteerNeed,
  createImportBatch,
  createImportRow,
  createSponsorContact,
  createSponsorOrganization,
  failImportBatch,
  getSponsorOrganizationByNormalizedName,
  getImportBatchWithRows,
  getActiveEventForOrganization,
  getEventSponsorByComposite,
  listEventSponsorsForEvent,
  listSponsorOrganizationsForOrganization,
  getSponsorYearHistory,
  updateImportRowStatus,
  updateSponsorContact,
  updateSponsorOrganization,
  upsertSponsorshipPackage,
  upsertEventSponsor,
  upsertSponsorYearHistory,
} from "../repositories/sponsor-import.repository.js";
import { EventureServiceError } from "./eventure-error.js";
import { createEventForOrganization } from "./event.service.js";
import { canUseSharedParser, parseDocumentWithSharedService } from "../../../core/services/parse/documentParseService.js";
import { prisma } from "../../../core/db/prisma.js";

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

export type EventureImportScope = "ORG" | "EVENT";

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

export type ImportSelectedTabsInput = {
  sponsorLevels?: boolean;
  sponsorsList?: boolean;
  amFlight?: boolean;
  pmFlight?: boolean;
  volunteers?: boolean;
  history?: boolean;
  historyFromSponsorsList?: boolean;
  followUps?: boolean;
  paymentStatus?: boolean;
};

type ResolvedImportSelectedTabs = {
  sponsorLevels: boolean;
  sponsorsList: boolean;
  amFlight: boolean;
  pmFlight: boolean;
  volunteers: boolean;
  history: boolean;
  historyFromSponsorsList: boolean;
  followUps: boolean;
  paymentStatus: boolean;
  legacyMode: boolean;
};

export function resolveSelectedTabs(
  selectedTabs?: ImportSelectedTabsInput,
  context?: {
    importFormat?: "csv" | "xlsx";
    importType?: "sponsor_master_list";
    hasParsedRows?: boolean;
  },
): ResolvedImportSelectedTabs {
  const resolved = !selectedTabs
    ? {
      sponsorLevels: true,
      sponsorsList: true,
      amFlight: true,
      pmFlight: true,
      volunteers: true,
      history: true,
      historyFromSponsorsList: true,
      followUps: false,
      paymentStatus: true,
      legacyMode: true,
    }
    : {
      sponsorLevels: selectedTabs.sponsorLevels ?? true,
      sponsorsList: selectedTabs.sponsorsList ?? true,
      amFlight: selectedTabs.amFlight ?? true,
      pmFlight: selectedTabs.pmFlight ?? true,
      volunteers: selectedTabs.volunteers ?? true,
      history: selectedTabs.history ?? false,
      historyFromSponsorsList: selectedTabs.historyFromSponsorsList ?? false,
      // Legacy import-generated follow-ups are retired in favor of payment-field follow-ups.
      followUps: false,
      paymentStatus: selectedTabs.paymentStatus ?? false,
      legacyMode: false,
    };

  const shouldForceSponsorsListForCsv =
    context?.importFormat === "csv"
    && context?.importType === "sponsor_master_list"
    && context?.hasParsedRows === true;

  if (!shouldForceSponsorsListForCsv) {
    return resolved;
  }

  return {
    ...resolved,
    sponsorsList: true,
  };
}

export type SponsorImportRollbackMode = "archive" | "hard_delete";

export type SponsorImportRollbackPreviewResponse = {
  importBatchId: string;
  status: string;
  canRollback: boolean;
  warnings: string[];
  counts: {
    sponsorOrganizations: number;
    sponsorContacts: number;
    eventSponsors: number;
    sponsorYearHistory: number;
    sponsorFollowUps: number;
    sponsorshipPackages: number;
    eventFlightSlots: number;
    eventVolunteerNeeds: number;
  };
  records: {
    sponsorOrganizations: Array<{ id: string; name: string; archivedAt: string | null }>;
    sponsorContacts: Array<{ id: string; name: string; sponsorOrganizationId: string; archivedAt: string | null }>;
    eventSponsors: Array<{ id: string; eventId: string; sponsorOrganizationId: string; archivedAt: string | null }>;
    sponsorYearHistory: Array<{ id: string; sponsorOrganizationId: string; year: number; archivedAt: string | null }>;
    sponsorFollowUps: Array<{ id: string; title: string; status: string; archivedAt: string | null }>;
  };
  recommendedMode: "archive";
  hardDeleteAllowed: boolean;
};

export type SponsorImportRollbackResponse = {
  importBatchId: string;
  status: "rolled_back" | "rollback_partial";
  mode: SponsorImportRollbackMode;
  warnings: string[];
  affectedCounts: SponsorImportRollbackPreviewResponse["counts"];
};

function isRollbackHardDeletePrivileged(role?: string, platformRole?: string): boolean {
  return role === "admin" || platformRole === "suite_admin" || platformRole === "dev";
}

export function isImportRecordManuallyEdited(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > 1000;
}

export function validateRollbackConfirmationText(confirmationText: string): boolean {
  return confirmationText === "ROLLBACK IMPORT";
}

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
  additionalContacts: Array<{ name?: string; email?: string; phone?: string }>;
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

type WorkbookImportSheetKey =
  | "sponsorLevels"
  | "sponsorsList"
  | "amFlight"
  | "pmFlight"
  | "volunteers"
  | "history"
  | "embeddedSponsorHistory"
  | "followUps"
  | "paymentStatus";

type WorkbookSheetPreview = {
  key: WorkbookImportSheetKey;
  sheetName: string;
  rowsDetected: number;
  warnings: string[];
};

type ImportSectionPreview = {
  key: WorkbookImportSheetKey;
  label: string;
  source: string;
  destination: string;
  detected: boolean;
  rows: number;
  warnings: string[];
  defaultEnabled: boolean;
};

type SponsorshipPackageRow = {
  name: string;
  earlyBirdPrice?: number;
  regularPrice?: number;
  bannerBenefit?: string;
  signBenefit?: string;
  foursomeIncluded?: string;
  websiteBenefit?: string;
  programBookBenefit?: string;
  coscBenefit?: string;
  tributeBenefit?: string;
};

type FlightSlotRow = {
  flight: "AM" | "PM";
  slotNumber?: number;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  startHole?: string;
  status: "empty" | "assigned" | "needs_review";
};

type VolunteerNeedRow = {
  roleName: string;
  neededCountText?: string;
  flight?: string;
  startingAt?: string;
  rotationTime?: string;
  notes?: string;
  status: "open" | "needs_review";
};

type HistoryWorkbookRow = {
  sourceEventName?: string;
  sourceEventYear?: number;
  rawCompanyName?: string;
  rawContactName?: string;
  rawRole?: string;
  rawPackage?: string;
  rawPaymentStatus?: string;
  participationType: string;
  sponsorshipPackage?: string;
  amountCommitted?: number;
  amountPaid?: number;
  paymentStatus?: string;
  flight?: string;
  slot?: string;
  notes?: string;
  sourceSheetName: string;
  sourceRowNumber: number;
  sourceRowHash: string;
};

type WorkbookParseResult = {
  sponsorLevels: SponsorshipPackageRow[];
  sponsorsListCsv: string;
  flightSlots: FlightSlotRow[];
  volunteerNeeds: VolunteerNeedRow[];
  historyRows: HistoryWorkbookRow[];
  embeddedHistoryRows: HistoryWorkbookRow[];
  embeddedHistoryYears: number[];
  sheetPreview: WorkbookSheetPreview[];
  warnings: string[];
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

function resolveImportScope(eventId?: string | null): EventureImportScope {
  return eventId ? "EVENT" : "ORG";
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

function normalizeHeaderForYearDetection(value: string): string {
  return normalizeHeader(value)
    .replace(/__\d+$/, "")
    .replace(/\./g, "")
    .trim();
}

function parseEmbeddedHistoryYearFromHeader(value: string): number | undefined {
  const normalized = normalizeHeaderForYearDetection(value);
  const match = normalized.match(/^(20\d{2})(?:\s*(?:y|yr|yrs|year|years))?$/i);
  if (!match) return undefined;
  const year = Number.parseInt(match[1], 10);
  if (!Number.isFinite(year) || year < 2000 || year > 2099) return undefined;
  return year;
}

export function detectEmbeddedSponsorHistoryYears(headers: string[]): number[] {
  const years = new Set<number>();
  for (const header of headers) {
    const parsed = parseEmbeddedHistoryYearFromHeader(header);
    if (parsed !== undefined) years.add(parsed);
  }
  return [...years].sort((a, b) => a - b);
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

export function parseMoney(value?: string): number | undefined {
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

export function splitCityStateZip(value?: string): { city?: string; state?: string; zipCode?: string } {
  if (!value) return {};
  const trimmed = value.trim();
  if (!trimmed) return {};

  // Extract ZIP code from anywhere in the string
  const zipMatch = trimmed.match(/\b(\d{5}(?:-\d{4})?)\b/);
  const zipCode = zipMatch?.[1];

  // Try comma-delimited "City, ST ZIP" format
  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[0];
    const stateZip = parts.slice(1).join(" ").trim();
    const state = stateZip.replace(/\b\d{5}(?:-\d{4})?\b/, "").trim() || undefined;
    return { city, state, zipCode };
  }

  // Single part — try "City ST ZIP" space-delimited form
  if (parts.length === 1) {
    const remaining = trimmed.replace(/\b\d{5}(?:-\d{4})?\b/, "").trim();
    // Check if last token looks like a 2-letter state code
    const stateMatch = remaining.match(/\s+([A-Z]{2})$/i);
    if (stateMatch) {
      const state = stateMatch[1].toUpperCase();
      const city = remaining.slice(0, remaining.length - stateMatch[0].length).trim() || undefined;
      return { city, state, zipCode };
    }
    // Fallback: treat whole value as city
    return { city: trimmed };
  }

  return {};
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

  if (normalized === "x" || normalized === "yes" || normalized === "y" || normalized === "true") {
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

export function parseEmbeddedSponsorHistoryRowsFromSponsorsListGrid(input: {
  sheetName: string;
  grid: string[][];
}): {
  rows: HistoryWorkbookRow[];
  yearsDetected: number[];
  warnings: string[];
} {
  if (input.grid.length === 0) {
    return { rows: [], yearsDetected: [], warnings: [] };
  }

  const [header, ...body] = input.grid;
  const mappedCompany = resolveMappedHeaderIndex(header, HEADER_ALIASES.company);
  if (mappedCompany === undefined) {
    return {
      rows: [],
      yearsDetected: [],
      warnings: ["Sponsors List is missing a Company column for embedded history parsing."],
    };
  }

  const mappedRepresentative = resolveMappedHeaderIndex(header, HEADER_ALIASES.representative);
  const mappedPackage = resolveMappedHeaderIndex(header, HEADER_ALIASES.sponsorshipPackage);
  const mappedStatus = resolveMappedHeaderIndex(header, HEADER_ALIASES.status);
  const mappedNotes = resolveMappedHeaderIndex(header, HEADER_ALIASES.notes);

  const yearColumns = header
    .map((headerValue, index) => ({ index, year: parseEmbeddedHistoryYearFromHeader(headerValue) }))
    .filter((item): item is { index: number; year: number } => item.year !== undefined);

  const rows: HistoryWorkbookRow[] = [];

  for (const [offset, row] of body.entries()) {
    if (isBlankRow(row)) continue;

    const sourceRowNumber = offset + 2;
    const rawCompanyName = getCell(row, mappedCompany) || undefined;
    if (!rawCompanyName || isSeparatorCompanyValue(rawCompanyName)) continue;

    for (const yearColumn of yearColumns) {
      const rawValue = getCell(row, yearColumn.index);
      if (!rawValue) continue;

      const parsedValue = parseYearValue(rawValue);
      rows.push({
        sourceEventName: undefined,
        sourceEventYear: yearColumn.year,
        rawCompanyName,
        rawContactName: getCell(row, mappedRepresentative) || undefined,
        rawRole: "sponsor",
        rawPackage: getCell(row, mappedPackage) || undefined,
        rawPaymentStatus: getCell(row, mappedStatus) || undefined,
        participationType: "sponsor",
        sponsorshipPackage: getCell(row, mappedPackage) || undefined,
        amountCommitted: parsedValue.amount,
        amountPaid: undefined,
        paymentStatus: inferPaymentStatus({
          statusRaw: getCell(row, mappedStatus) || undefined,
          notes: getCell(row, mappedNotes) || undefined,
          sponsorshipPackage: getCell(row, mappedPackage) || undefined,
        }),
        flight: undefined,
        slot: undefined,
        notes: [
          getCell(row, mappedNotes),
          `Embedded participation value: ${rawValue}`,
        ].filter(Boolean).join(" | ") || undefined,
        sourceSheetName: input.sheetName,
        sourceRowNumber,
        sourceRowHash: createHash("sha1")
          .update(`${input.sheetName}|${sourceRowNumber}|${rawCompanyName}|${yearColumn.year}|${rawValue}`)
          .digest("hex"),
      });
    }
  }

  return {
    rows,
    yearsDetected: [...new Set(yearColumns.map((item) => item.year))].sort((a, b) => a - b),
    warnings: [],
  };
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

function inferFileTypeFromName(fileName?: string, fileMimeType?: string): "csv" | "xlsx" | "unknown" {
  if (fileName) {
    const normalized = fileName.toLowerCase();
    if (normalized.endsWith(".csv")) return "csv";
    if (normalized.endsWith(".xlsx")) return "xlsx";
  }
  if (fileMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (fileMimeType === "text/csv") return "csv";
  return "unknown";
}

async function resolveImportSource(input: {
  csvContent?: string;
  fileBuffer?: Buffer;
  fileName?: string;
  fileMimeType?: string;
  parserStrategy: SponsorImportParserStrategy;
}): Promise<{
  sponsorsCsv: string;
  parserUsed: SponsorImportParserStrategy;
  parserWarnings: string[];
  importFormat: "csv" | "xlsx";
  workbook?: WorkbookParseResult;
}> {
  if (input.csvContent && input.csvContent.trim()) {
    const parseResolution = await resolveCsvForParsing(input.csvContent, input.parserStrategy);
    return {
      sponsorsCsv: parseResolution.content,
      parserUsed: parseResolution.parserUsed,
      parserWarnings: parseResolution.parserWarnings,
      importFormat: "csv",
    };
  }

  if (!input.fileBuffer) {
    throw new EventureServiceError("Provide CSV text or upload a CSV/XLSX file.", 400);
  }

  const inferredType = inferFileTypeFromName(input.fileName, input.fileMimeType);
  if (inferredType === "xlsx") {
    const workbook = parseWorkbook(input.fileBuffer);
    const parseResolution = await resolveCsvForParsing(workbook.sponsorsListCsv, input.parserStrategy);
    return {
      sponsorsCsv: parseResolution.content,
      parserUsed: parseResolution.parserUsed,
      parserWarnings: [...parseResolution.parserWarnings, ...workbook.warnings],
      importFormat: "xlsx",
      workbook,
    };
  }

  const csvContent = input.fileBuffer.toString("utf8");
  const parseResolution = await resolveCsvForParsing(csvContent, input.parserStrategy);
  return {
    sponsorsCsv: parseResolution.content,
    parserUsed: parseResolution.parserUsed,
    parserWarnings: parseResolution.parserWarnings,
    importFormat: "csv",
  };
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
    const parsedYear = parseEmbeddedHistoryYearFromHeader(header);

    if (parsedYear !== undefined) {
      const occurrence = (yearOccurrence.get(parsedYear) ?? 0) + 1;
      yearOccurrence.set(parsedYear, occurrence);
      yearColumns.push({ index, year: parsedYear, header, occurrence });
      columnMapping.push({
        sourceColumn: header,
        normalizedColumn: normalized,
        target: parsedYear === 2026 && occurrence > 1 ? "eventSponsor.committedAmount" : `sponsorYearHistory.${parsedYear}`,
        confidence: occurrence === 1 ? 0.95 : 0.75,
        warning: occurrence > 1 && parsedYear === 2026 ? "Duplicate 2026 YR column normalized for committed amount handling." : undefined,
      });
    }

    const anyYearMatch = normalized.match(/\b(20\d{2})\b/);
    if (mapped.currentAmount === undefined && anyYearMatch && normalized.includes(anyYearMatch[1]) && normalized.includes("amount")) {
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

function isBlankRow(cells: string[]): boolean {
  return cells.every((cell) => cleanCell(cell) === "");
}

function isSeparatorCompanyValue(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return normalized === "new contacts below";
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

  const parsedRows: ParsedSponsorRow[] = rows.flatMap((row, rowOffset) => {
    const rowNumber = rowOffset + 2;
    if (isBlankRow(row)) return [];

    const companyCell = getCell(row, mapped.company);
    if (isSeparatorCompanyValue(companyCell)) {
      return [];
    }

    const warnings: ImportWarning[] = [];

    const companyName = companyCell;
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

    const splitNames = representativeRaw.split(/\s+and\s+|;|\||\//i).map((s) => s.trim()).filter(Boolean);
    const splitEmails = emailRaw ? emailRaw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean) : [];
    const splitPhones = phoneRaw ? phoneRaw.split(/[;|/]/).map((s) => s.trim()).filter(Boolean) : [];

    const contactName = splitNames[0] || undefined;
    const contactEmail = splitEmails[0] || undefined;
    const contactPhone = splitPhones[0] || undefined;

    // Build additional contacts from remaining tokens (zip by position, longest array length)
    const additionalCount = Math.max(splitNames.length, splitEmails.length, splitPhones.length) - 1;
    const additionalContacts: Array<{ name?: string; email?: string; phone?: string }> = [];
    for (let i = 1; i <= additionalCount; i++) {
      const name = splitNames[i] || undefined;
      const email = splitEmails[i] || undefined;
      const phone = splitPhones[i] || undefined;
      if (name || email || phone) {
        additionalContacts.push({ name, email, phone });
      }
    }

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

    return [{
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
      additionalContacts,
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
    }];
  });

  return {
    headers,
    mapped,
    yearColumns,
    columnMapping,
    rows: parsedRows,
  };
}

function normalizeSheetName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function gridToCsv(grid: string[][]): string {
  return grid.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\n");
}

function sheetToGrid(worksheet: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
  });

  return rows.map((row) => row.map((value) => cleanCell(value === null || value === undefined ? "" : String(value))));
}

function findWorkbookSheet(workbook: XLSX.WorkBook, aliases: string[]): string | undefined {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeSheetName(alias)));
  return workbook.SheetNames.find((name) => normalizedAliases.has(normalizeSheetName(name)));
}

function parseSponsorLevelsSheet(grid: string[][]): { rows: SponsorshipPackageRow[]; warnings: string[] } {
  if (grid.length === 0) return { rows: [], warnings: [] };
  const [header, ...body] = grid;
  const mappedName = resolveMappedHeaderIndex(header, ["Level", "Name", "Sponsor Level"]);
  const mappedEarlyBird = resolveMappedHeaderIndex(header, ["Early Bird", "EarlyBird", "Early Bird Price"]);
  const mappedRegular = resolveMappedHeaderIndex(header, ["Regular", "Regular Price"]);
  const mappedBanner = resolveMappedHeaderIndex(header, ["Banner"]);
  const mappedSign = resolveMappedHeaderIndex(header, ["Sign"]);
  const mappedFoursome = resolveMappedHeaderIndex(header, ["Foursome"]);
  const mappedWebsite = resolveMappedHeaderIndex(header, ["Website"]);
  const mappedProgramBook = resolveMappedHeaderIndex(header, ["Program Book", "ProgramBook"]);
  const mappedCosc = resolveMappedHeaderIndex(header, ["COSC"]);
  const mappedTribute = resolveMappedHeaderIndex(header, ["2026 Tribute", "Tribute"]);

  const rows: SponsorshipPackageRow[] = [];
  for (const row of body) {
    if (isBlankRow(row)) continue;
    const name = getCell(row, mappedName);
    if (!name) continue;
    rows.push({
      name,
      earlyBirdPrice: parseMoney(getCell(row, mappedEarlyBird)),
      regularPrice: parseMoney(getCell(row, mappedRegular)),
      bannerBenefit: getCell(row, mappedBanner) || undefined,
      signBenefit: getCell(row, mappedSign) || undefined,
      foursomeIncluded: getCell(row, mappedFoursome) || undefined,
      websiteBenefit: getCell(row, mappedWebsite) || undefined,
      programBookBenefit: getCell(row, mappedProgramBook) || undefined,
      coscBenefit: getCell(row, mappedCosc) || undefined,
      tributeBenefit: getCell(row, mappedTribute) || undefined,
    });
  }

  return {
    rows,
    warnings: mappedName === undefined ? ["Sponsor Levels sheet is missing a Level/Name column."] : [],
  };
}

function parseFlightSheet(grid: string[][], flight: "AM" | "PM"): { rows: FlightSlotRow[]; warnings: string[] } {
  if (grid.length === 0) return { rows: [], warnings: [] };
  const [header, ...body] = grid;
  const mappedNo = resolveMappedHeaderIndex(header, ["No.", "No", "Slot", "Slot #"]);
  const mappedCompany = resolveMappedHeaderIndex(header, ["Company"]);
  const mappedFirstName = resolveMappedHeaderIndex(header, ["First Name", "First"]);
  const mappedLastName = resolveMappedHeaderIndex(header, ["Last Name", "Last"]);
  const mappedEmail = resolveMappedHeaderIndex(header, ["Email"]);
  const mappedPhone = resolveMappedHeaderIndex(header, ["Phone"]);
  const mappedStartHole = resolveMappedHeaderIndex(header, ["Start Hole", "Hole"]);

  const rows: FlightSlotRow[] = [];
  for (const row of body) {
    if (isBlankRow(row)) continue;

    const slotText = getCell(row, mappedNo);
    const slotNumber = slotText ? Number.parseInt(slotText, 10) : undefined;
    const companyName = getCell(row, mappedCompany) || undefined;
    const firstName = getCell(row, mappedFirstName) || undefined;
    const lastName = getCell(row, mappedLastName) || undefined;
    const email = getCell(row, mappedEmail) || undefined;
    const phone = getCell(row, mappedPhone) || undefined;
    const startHole = getCell(row, mappedStartHole) || undefined;

    const hasNameOrCompany = !!(companyName || firstName || lastName);
    const hasContact = !!(email || phone);

    let status: FlightSlotRow["status"] = "empty";
    if (hasNameOrCompany || hasContact) {
      status = "assigned";
    }
    if (phone && !hasNameOrCompany && !email) {
      status = "needs_review";
    }

    rows.push({
      flight,
      slotNumber: Number.isFinite(slotNumber) ? slotNumber : undefined,
      companyName,
      firstName,
      lastName,
      email,
      phone,
      startHole,
      status,
    });
  }

  return {
    rows,
    warnings: mappedNo === undefined ? ["Flight sheet does not include a slot number column."] : [],
  };
}

function parseVolunteersSheet(grid: string[][]): { rows: VolunteerNeedRow[]; warnings: string[] } {
  if (grid.length === 0) return { rows: [], warnings: [] };
  const [header, ...body] = grid;
  const mappedRole = resolveMappedHeaderIndex(header, ["Role", "Task", "Volunteer Task", "Need"]);
  const mappedNeed = resolveMappedHeaderIndex(header, ["Need", "Needed", "Count", "Needed Count"]);
  const mappedFlight = resolveMappedHeaderIndex(header, ["Flight"]);
  const mappedStart = resolveMappedHeaderIndex(header, ["Starting At", "Start", "Time"]);
  const mappedRotation = resolveMappedHeaderIndex(header, ["Rotation", "Rotation Time"]);
  const mappedNotes = resolveMappedHeaderIndex(header, ["Notes", "Note"]);

  const rows: VolunteerNeedRow[] = [];
  for (const row of body) {
    if (isBlankRow(row)) continue;

    const roleName = getCell(row, mappedRole) || row.find((cell) => cleanCell(cell)) || "";
    if (!roleName) continue;

    rows.push({
      roleName,
      neededCountText: getCell(row, mappedNeed) || undefined,
      flight: getCell(row, mappedFlight) || undefined,
      startingAt: getCell(row, mappedStart) || undefined,
      rotationTime: getCell(row, mappedRotation) || undefined,
      notes: getCell(row, mappedNotes) || undefined,
      status: /need|tbd|pending|review/i.test(roleName) ? "open" : "needs_review",
    });
  }

  return {
    rows,
    warnings: mappedRole === undefined ? ["Volunteers sheet has no explicit Role column; first populated cell per row is used."] : [],
  };
}

function parseHistorySheet(sheetName: string, grid: string[][]): { rows: HistoryWorkbookRow[]; warnings: string[] } {
  if (grid.length === 0) return { rows: [], warnings: [] };
  const [header, ...body] = grid;
  const mappedYear = resolveMappedHeaderIndex(header, ["Year", "Event Year"]);
  const mappedSourceEvent = resolveMappedHeaderIndex(header, ["Source Event", "Event", "Event Name"]);
  const mappedCompany = resolveMappedHeaderIndex(header, ["Company", "Sponsor", "Organization"]);
  const mappedContact = resolveMappedHeaderIndex(header, ["Contact", "Representative", "Name"]);
  const mappedType = resolveMappedHeaderIndex(header, ["Type", "Participation Type", "Role Type"]);
  const mappedRole = resolveMappedHeaderIndex(header, ["Role", "Position"]);
  const mappedPackage = resolveMappedHeaderIndex(header, ["Package", "Sponsorship Package", "Level"]);
  const mappedCommitted = resolveMappedHeaderIndex(header, ["Amount", "Committed", "Amount Committed"]);
  const mappedPaid = resolveMappedHeaderIndex(header, ["Amount Paid", "Paid"]);
  const mappedPaymentStatus = resolveMappedHeaderIndex(header, ["Payment Status", "Status"]);
  const mappedFlight = resolveMappedHeaderIndex(header, ["Flight"]);
  const mappedSlot = resolveMappedHeaderIndex(header, ["Slot", "Table", "Table/Slot"]);
  const mappedNotes = resolveMappedHeaderIndex(header, ["Notes", "History Notes"]);

  const rows: HistoryWorkbookRow[] = [];

  for (const [offset, row] of body.entries()) {
    if (isBlankRow(row)) continue;

    const sourceRowNumber = offset + 2;
    const sourceEventName = getCell(row, mappedSourceEvent) || undefined;
    const yearRaw = getCell(row, mappedYear);
    const sourceEventYear = yearRaw ? Number.parseInt(yearRaw, 10) : undefined;
    const rawCompanyName = getCell(row, mappedCompany) || undefined;
    const rawContactName = getCell(row, mappedContact) || undefined;
    const rawRole = getCell(row, mappedRole) || undefined;
    const rawPackage = getCell(row, mappedPackage) || undefined;
    const rawPaymentStatus = getCell(row, mappedPaymentStatus) || undefined;
    const participationType = normalizeHeader(getCell(row, mappedType) || "unknown") || "unknown";
    const sponsorshipPackage = getCell(row, mappedPackage) || undefined;
    const amountCommitted = parseMoney(getCell(row, mappedCommitted));
    const amountPaid = parseMoney(getCell(row, mappedPaid));
    const paymentStatus = inferPaymentStatus({
      statusRaw: rawPaymentStatus,
      notes: getCell(row, mappedNotes),
      sponsorshipPackage,
    });
    const flight = normalizeFlightPreference(getCell(row, mappedFlight)) || undefined;
    const slot = getCell(row, mappedSlot) || undefined;
    const notes = getCell(row, mappedNotes) || undefined;
    const sourceRowHash = createHash("sha1")
      .update([sourceEventName, yearRaw, rawCompanyName, rawContactName, rawRole, rawPackage, rawPaymentStatus, notes].join("|"))
      .digest("hex");

    rows.push({
      sourceEventName,
      sourceEventYear: Number.isFinite(sourceEventYear) ? sourceEventYear : undefined,
      rawCompanyName,
      rawContactName,
      rawRole,
      rawPackage,
      rawPaymentStatus,
      participationType,
      sponsorshipPackage,
      amountCommitted,
      amountPaid,
      paymentStatus,
      flight,
      slot,
      notes,
      sourceSheetName: sheetName,
      sourceRowNumber,
      sourceRowHash,
    });
  }

  return {
    rows,
    warnings: mappedCompany === undefined ? ["History sheet is missing a Company column."] : [],
  };
}

function parseWorkbook(buffer: Buffer): WorkbookParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });

  const sponsorLevelsName = findWorkbookSheet(workbook, ["Sponsor Levels"]);
  const sponsorsListName = findWorkbookSheet(workbook, ["Sponsors List", "Sponsor List"]);
  const amFlightName = findWorkbookSheet(workbook, ["AM Flight"]);
  const pmFlightName = findWorkbookSheet(workbook, ["PM Flight"]);
  const volunteersName = findWorkbookSheet(workbook, ["Volunteers", "Volunteer"]);
  const historyName = findWorkbookSheet(workbook, ["History", "Historical Records", "Historical"]);
  const followUpsName = findWorkbookSheet(workbook, ["Follow-Ups", "Follow Ups", "Followups"]);
  const paymentStatusName = findWorkbookSheet(workbook, ["Payment Status", "Payments", "Payment Status Items"]);

  const warnings: string[] = [];
  const sheetPreview: WorkbookSheetPreview[] = [];

  if (!sponsorsListName) {
    throw new EventureServiceError("Workbook is missing the Sponsors List sheet.", 400);
  }

  const sponsorLevelsGrid = sponsorLevelsName ? sheetToGrid(workbook.Sheets[sponsorLevelsName]) : [];
  const sponsorsListGrid = sheetToGrid(workbook.Sheets[sponsorsListName]);
  const amFlightGrid = amFlightName ? sheetToGrid(workbook.Sheets[amFlightName]) : [];
  const pmFlightGrid = pmFlightName ? sheetToGrid(workbook.Sheets[pmFlightName]) : [];
  const volunteersGrid = volunteersName ? sheetToGrid(workbook.Sheets[volunteersName]) : [];
  const historyGrid = historyName ? sheetToGrid(workbook.Sheets[historyName]) : [];
  const followUpsGrid = followUpsName ? sheetToGrid(workbook.Sheets[followUpsName]) : [];
  const paymentStatusGrid = paymentStatusName ? sheetToGrid(workbook.Sheets[paymentStatusName]) : [];

  const sponsorLevels = parseSponsorLevelsSheet(sponsorLevelsGrid);
  const amFlight = parseFlightSheet(amFlightGrid, "AM");
  const pmFlight = parseFlightSheet(pmFlightGrid, "PM");
  const volunteers = parseVolunteersSheet(volunteersGrid);
  const history = parseHistorySheet(historyName ?? "History", historyGrid);
  const embeddedHistory = parseEmbeddedSponsorHistoryRowsFromSponsorsListGrid({
    sheetName: sponsorsListName,
    grid: sponsorsListGrid,
  });

  warnings.push(
    ...sponsorLevels.warnings,
    ...amFlight.warnings,
    ...pmFlight.warnings,
    ...volunteers.warnings,
    ...history.warnings,
    ...embeddedHistory.warnings,
  );

  sheetPreview.push(
    {
      key: "sponsorLevels",
      sheetName: sponsorLevelsName ?? "not found",
      rowsDetected: sponsorLevels.rows.length,
      warnings: sponsorLevelsName ? sponsorLevels.warnings : ["Sheet not found."],
    },
    {
      key: "sponsorsList",
      sheetName: sponsorsListName,
      rowsDetected: Math.max(0, sponsorsListGrid.length - 1),
      warnings: [],
    },
    {
      key: "amFlight",
      sheetName: amFlightName ?? "not found",
      rowsDetected: amFlight.rows.length,
      warnings: amFlightName ? amFlight.warnings : ["Sheet not found."],
    },
    {
      key: "pmFlight",
      sheetName: pmFlightName ?? "not found",
      rowsDetected: pmFlight.rows.length,
      warnings: pmFlightName ? pmFlight.warnings : ["Sheet not found."],
    },
    {
      key: "volunteers",
      sheetName: volunteersName ?? "not found",
      rowsDetected: volunteers.rows.length,
      warnings: volunteersName ? volunteers.warnings : ["Sheet not found."],
    },
    {
      key: "history",
      sheetName: historyName ?? "not found",
      rowsDetected: history.rows.length,
      warnings: historyName
        ? history.warnings
        : embeddedHistory.rows.length > 0
          ? ["Sheet not found. Embedded sponsor history detected in Sponsors List year columns."]
          : ["Sheet not found."],
    },
    {
      key: "embeddedSponsorHistory",
      sheetName: sponsorsListName,
      rowsDetected: embeddedHistory.rows.length,
      warnings: embeddedHistory.yearsDetected.length > 0
        ? [`Historical year columns detected: ${embeddedHistory.yearsDetected.join(", ")}`]
        : ["No embedded sponsor history columns detected."],
    },
    {
      key: "followUps",
      sheetName: followUpsName ?? "not found",
      rowsDetected: Math.max(0, followUpsGrid.length - 1),
      warnings: followUpsName ? [] : ["Sheet not found."],
    },
    {
      key: "paymentStatus",
      sheetName: paymentStatusName ?? "not found",
      rowsDetected: Math.max(0, paymentStatusGrid.length - 1),
      warnings: paymentStatusName ? [] : ["Sheet not found."],
    },
  );

  return {
    sponsorLevels: sponsorLevels.rows,
    sponsorsListCsv: gridToCsv(sponsorsListGrid),
    flightSlots: [...amFlight.rows, ...pmFlight.rows],
    volunteerNeeds: volunteers.rows,
    historyRows: history.rows,
    embeddedHistoryRows: embeddedHistory.rows,
    embeddedHistoryYears: embeddedHistory.yearsDetected,
    sheetPreview,
    warnings,
  };
}

function buildImportSections(args: {
  sheetPreview: WorkbookSheetPreview[];
  importFormat: "csv" | "xlsx";
  sponsorsListRows: number;
  embeddedHistoryRows: number;
  followUpRows: number;
  paymentStatusRows: number;
}): ImportSectionPreview[] {
  const {
    sheetPreview,
    importFormat,
    sponsorsListRows,
    embeddedHistoryRows,
    followUpRows,
    paymentStatusRows,
  } = args;

  if (importFormat === "csv") {
    return [
      {
        key: "sponsorLevels",
        label: "Sponsor Levels",
        source: "Workbook sheet",
        destination: "Event Packages",
        detected: false,
        rows: 0,
        warnings: ["Not available for CSV import."],
        defaultEnabled: false,
      },
      {
        key: "sponsorsList",
        label: "Sponsors List",
        source: "CSV Sponsors List rows",
        destination: "Companies + Contacts + Event Sponsors",
        detected: sponsorsListRows > 0,
        rows: sponsorsListRows,
        warnings: sponsorsListRows > 0 ? [] : ["No sponsor rows detected."],
        defaultEnabled: sponsorsListRows > 0,
      },
      {
        key: "amFlight",
        label: "AM Flight",
        source: "Workbook sheet",
        destination: "Event Assignments",
        detected: false,
        rows: 0,
        warnings: ["Not available for CSV import."],
        defaultEnabled: false,
      },
      {
        key: "pmFlight",
        label: "PM Flight",
        source: "Workbook sheet",
        destination: "Event Assignments",
        detected: false,
        rows: 0,
        warnings: ["Not available for CSV import."],
        defaultEnabled: false,
      },
      {
        key: "volunteers",
        label: "Volunteers",
        source: "Workbook sheet",
        destination: "Volunteer Assignments",
        detected: false,
        rows: 0,
        warnings: ["Not available for CSV import."],
        defaultEnabled: false,
      },
      {
        key: "history",
        label: "History",
        source: "Workbook sheet",
        destination: "Event Participation History",
        detected: false,
        rows: 0,
        warnings: ["Standalone history sheet not detected in CSV import."],
        defaultEnabled: false,
      },
      {
        key: "embeddedSponsorHistory",
        label: "Embedded Sponsor History",
        source: "Sponsors List year columns",
        destination: "Event History",
        detected: embeddedHistoryRows > 0,
        rows: embeddedHistoryRows,
        warnings: embeddedHistoryRows > 0 ? [] : ["No embedded year history columns detected."],
        defaultEnabled: embeddedHistoryRows > 0,
      },
      {
        key: "followUps",
        label: "Follow-Ups",
        source: "Sponsors List derived columns",
        destination: "Event Follow-Ups",
        detected: followUpRows > 0,
        rows: followUpRows,
        warnings: followUpRows > 0 ? [] : ["No follow-up signals detected from Sponsors List columns."],
        defaultEnabled: followUpRows > 0,
      },
      {
        key: "paymentStatus",
        label: "Payment Status",
        source: "Sponsors List derived columns",
        destination: "Event Payments / Status Items",
        detected: paymentStatusRows > 0,
        rows: paymentStatusRows,
        warnings: paymentStatusRows > 0 ? [] : ["No payment status values detected from Sponsors List columns."],
        defaultEnabled: paymentStatusRows > 0,
      },
    ];
  }

  const previewByKey = new Map(sheetPreview.map((sheet) => [sheet.key, sheet]));
  const getSection = (key: WorkbookImportSheetKey) => previewByKey.get(key);
  const hasDetectedRows = (key: WorkbookImportSheetKey) => (getSection(key)?.rowsDetected ?? 0) > 0;
  const hasSourceSheet = (key: WorkbookImportSheetKey) => {
    const sheetName = getSection(key)?.sheetName?.trim().toLowerCase();
    return Boolean(sheetName) && sheetName !== "not found";
  };

  return [
    {
      key: "sponsorLevels",
      label: "Sponsor Levels",
      source: hasSourceSheet("sponsorLevels") ? (getSection("sponsorLevels")?.sheetName ?? "Sponsor Levels") : "Sponsor Levels sheet",
      destination: "Event Packages",
      detected: hasSourceSheet("sponsorLevels"),
      rows: getSection("sponsorLevels")?.rowsDetected ?? 0,
      warnings: getSection("sponsorLevels")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("sponsorLevels"),
    },
    {
      key: "sponsorsList",
      label: "Sponsors List",
      source: getSection("sponsorsList")?.sheetName ?? "Sponsors List sheet",
      destination: "Companies + Contacts + Event Sponsors",
      detected: hasSourceSheet("sponsorsList"),
      rows: getSection("sponsorsList")?.rowsDetected ?? 0,
      warnings: getSection("sponsorsList")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("sponsorsList"),
    },
    {
      key: "amFlight",
      label: "AM Flight",
      source: hasSourceSheet("amFlight") ? (getSection("amFlight")?.sheetName ?? "AM Flight") : "AM Flight sheet",
      destination: "Event Assignments",
      detected: hasSourceSheet("amFlight"),
      rows: getSection("amFlight")?.rowsDetected ?? 0,
      warnings: getSection("amFlight")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("amFlight"),
    },
    {
      key: "pmFlight",
      label: "PM Flight",
      source: hasSourceSheet("pmFlight") ? (getSection("pmFlight")?.sheetName ?? "PM Flight") : "PM Flight sheet",
      destination: "Event Assignments",
      detected: hasSourceSheet("pmFlight"),
      rows: getSection("pmFlight")?.rowsDetected ?? 0,
      warnings: getSection("pmFlight")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("pmFlight"),
    },
    {
      key: "volunteers",
      label: "Volunteers",
      source: hasSourceSheet("volunteers") ? (getSection("volunteers")?.sheetName ?? "Volunteers") : "Volunteers sheet",
      destination: "Volunteer Assignments",
      detected: hasSourceSheet("volunteers"),
      rows: getSection("volunteers")?.rowsDetected ?? 0,
      warnings: getSection("volunteers")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("volunteers"),
    },
    {
      key: "history",
      label: "History",
      source: "History sheet",
      destination: "Event Participation History",
      detected: hasSourceSheet("history"),
      rows: getSection("history")?.rowsDetected ?? 0,
      warnings: getSection("history")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("history"),
    },
    {
      key: "embeddedSponsorHistory",
      label: "Embedded Sponsor History",
      source: "Sponsors List year columns",
      destination: "Event History",
      detected: hasDetectedRows("embeddedSponsorHistory"),
      rows: getSection("embeddedSponsorHistory")?.rowsDetected ?? 0,
      warnings: getSection("embeddedSponsorHistory")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("embeddedSponsorHistory"),
    },
    {
      key: "followUps",
      label: "Follow-Ups",
      source: "Follow-Ups sheet",
      destination: "Event Follow-Ups",
      detected: hasSourceSheet("followUps"),
      rows: getSection("followUps")?.rowsDetected ?? 0,
      warnings: getSection("followUps")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("followUps"),
    },
    {
      key: "paymentStatus",
      label: "Payment Status",
      source: "Payment Status sheet",
      destination: "Event Payments / Status Items",
      detected: hasSourceSheet("paymentStatus"),
      rows: getSection("paymentStatus")?.rowsDetected ?? 0,
      warnings: getSection("paymentStatus")?.warnings ?? [],
      defaultEnabled: hasDetectedRows("paymentStatus"),
    },
  ];
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
  csvContent?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
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

  const importSource = await resolveImportSource({
    csvContent: input.csvContent,
    fileBuffer: input.fileBuffer,
    fileName: input.fileName,
    fileMimeType: input.fileMimeType,
    parserStrategy: input.parserStrategy ?? "native",
  });
  const parsed = parseRows(importSource.sponsorsCsv);
  const existingSponsors = await listSponsorOrganizationsForOrganization(input.organizationId);

  const mode = toCanonicalImportMode(input.mode);

  const importBatch = await createImportBatch({
    organizationId: input.organizationId,
    eventId: input.eventId,
    fileName: input.fileName ?? `eventure-sponsor-import-${Date.now()}.csv`,
    fileType: importSource.importFormat === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv",
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
      parserUsed: importSource.parserUsed,
      parserWarnings: importSource.parserWarnings,
      importFormat: importSource.importFormat,
      workbook: importSource.workbook
        ? {
          sheets: importSource.workbook.sheetPreview,
          sponsorLevels: importSource.workbook.sponsorLevels,
          flightSlots: importSource.workbook.flightSlots,
          volunteerNeeds: importSource.workbook.volunteerNeeds,
          historyRows: importSource.workbook.historyRows,
          embeddedHistoryRows: importSource.workbook.embeddedHistoryRows,
          embeddedHistoryYears: importSource.workbook.embeddedHistoryYears,
        }
        : undefined,
    },
  });

  const existingEventSponsorRows = input.eventId
    ? await listEventSponsorsForEvent(input.organizationId, input.eventId)
    : [];
  const existingEventSponsorSet = new Set(existingEventSponsorRows.map((item) => item.sponsorOrganizationId));
  const allowedWorkbookPackages = new Set(
    (importSource.workbook?.sponsorLevels ?? []).map((pkg) => normalizeHeader(pkg.name)).filter(Boolean),
  );
  const seenCompanies = new Set<string>();

  const rows: ImportPreviewRow[] = [];
  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  let duplicateRows = 0;
  let companiesDetected = 0;
  let contactsDetected = 0;
  let primaryContactsDetected = 0;
  let additionalContactsDetected = 0;
  let representativeNamesDetected = 0;
  let attendeeNamesDetected = 0;
  let attendeeCandidatesDetected = 0;
  let eventSponsorsDetected = 0;
  let embeddedHistoryRecordsDetected = 0;
  let followUpsDetected = 0;
  let paymentStatusRowsDetected = 0;

  try {
    for (const row of parsed.rows) {
      const rowWarnings = [...row.warnings];
      const rowErrors: string[] = [];

      if (row.sponsorshipPackage && allowedWorkbookPackages.size > 0) {
        const normalizedPackage = normalizeHeader(row.sponsorshipPackage);
        if (!allowedWorkbookPackages.has(normalizedPackage)) {
          rowWarnings.push({
            rowNumber: row.rowNumber,
            code: "UNKNOWN_PACKAGE",
            message: `Sponsorship package '${row.sponsorshipPackage}' was not found in Sponsor Levels.`,
          });
        }
      }

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
        sponsorMatch.action === "review";
      const contactNeedsReview = matchedContact.action === "review";
      const sponsorOrganizationTarget: PreviewRowTarget = rowErrors.length > 0
        ? "skip"
        : targetReview
          ? "review"
          : sponsorMatch.action;
      const sponsorContactTarget: PreviewRowTarget = !row.contactName && !row.contactEmail && !row.contactPhone
        ? "skip"
        : contactNeedsReview
          ? "review"
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
      if (sponsorContactTarget !== "skip" && (row.contactName || row.contactEmail || row.contactPhone)) {
        primaryContactsDetected += 1;
      }
      additionalContactsDetected += row.additionalContacts.length;
      if (row.contactName) representativeNamesDetected += 1;
      if (row.attendeeNamesRaw && cleanCell(row.attendeeNamesRaw)) attendeeNamesDetected += 1;
      attendeeCandidatesDetected += Number(Boolean(row.contactName || row.contactEmail)) + row.additionalContacts.length;
      if (eventSponsorTarget !== "skip") eventSponsorsDetected += 1;
      embeddedHistoryRecordsDetected += row.yearHistory.length;
      followUpsDetected += usesEventAssignment(mode) ? row.suggestedFollowUps.length : 0;
      if (row.paymentStatus && row.paymentStatus !== "unknown") {
        paymentStatusRowsDetected += 1;
      }

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

    const workbookSheetPreview = importSource.workbook?.sheetPreview ?? [];
    return {
      importBatchId: importBatch.id,
      importType: "sponsor_master_list",
      importScope: resolveImportScope(input.eventId),
      importFormat: importSource.importFormat,
      mode,
      eventId: input.eventId,
      fileName: input.fileName ?? (importSource.importFormat === "xlsx" ? "uploaded.xlsx" : "uploaded.csv"),
      status,
      attendeePolicyMessage: attendeeNamesDetected > 0
        ? undefined
        : `No values found in the Names column. Attendees were not created. ${representativeNamesDetected} representative names were found and will be imported as sponsor contacts. To create attendees, upload a filled Names column or enable a future 'Create representatives as attendees' option.`,
      summary: {
        totalRows: parsed.rows.length,
        validRows,
        warningRows,
        errorRows,
        duplicateRows,
        companiesDetected,
        contactsDetected,
        primaryContactsDetected,
        additionalContactsDetected,
        representativeNamesDetected,
        attendeeNamesDetected,
        attendeeCandidatesDetected,
        eventSponsorsDetected,
        embeddedHistoryRecordsDetected,
        historySheetRecordsDetected: importSource.workbook?.historyRows.length ?? 0,
        historicalYearColumnsDetected: importSource.workbook?.embeddedHistoryYears ?? [],
        historyRecordsDetected: embeddedHistoryRecordsDetected + (importSource.workbook?.historyRows.length ?? 0),
        followUpsDetected,
        paymentStatusRowsDetected,
        sponsorshipPackagesDetected: importSource.workbook?.sponsorLevels.length ?? 0,
        amFlightSlotsDetected: importSource.workbook?.flightSlots.filter((slot) => slot.flight === "AM").length ?? 0,
        pmFlightSlotsDetected: importSource.workbook?.flightSlots.filter((slot) => slot.flight === "PM").length ?? 0,
        volunteerNeedsDetected: importSource.workbook?.volunteerNeeds.length ?? 0,
        attendeesDetected: 0,
      },
      columnMapping: parsed.columnMapping,
      rows,
      workbookSheetPreview,
      importSections: buildImportSections({
        sheetPreview: workbookSheetPreview,
        importFormat: importSource.importFormat,
        sponsorsListRows: parsed.rows.length,
        embeddedHistoryRows: embeddedHistoryRecordsDetected,
        followUpRows: followUpsDetected,
        paymentStatusRows: paymentStatusRowsDetected,
      }),
      workbookWarnings: importSource.workbook?.warnings ?? [],
      parserUsed: importSource.parserUsed,
      warnings: importSource.parserWarnings.map((message) => ({
        rowNumber: 0,
        code: "PARSER_WARNING",
        message,
      })),
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
  selectedTabs?: ImportSelectedTabsInput;
  representativesAsAttendees?: boolean;
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

  const mappingConfig = importBatch.mappingConfig as {
    mode?: ImportModeInput;
    importType?: "sponsor_master_list";
    importFormat?: "csv" | "xlsx";
    workbook?: {
      sponsorLevels?: SponsorshipPackageRow[];
      flightSlots?: FlightSlotRow[];
      volunteerNeeds?: VolunteerNeedRow[];
      historyRows?: HistoryWorkbookRow[];
      embeddedHistoryRows?: HistoryWorkbookRow[];
      embeddedHistoryYears?: number[];
    };
  };
  const workbookConfig = mappingConfig.workbook ?? {};
  const workbookPackages = Array.isArray(workbookConfig.sponsorLevels) ? workbookConfig.sponsorLevels : [];
  const workbookFlightSlots = Array.isArray(workbookConfig.flightSlots) ? workbookConfig.flightSlots : [];
  const workbookVolunteerNeeds = Array.isArray(workbookConfig.volunteerNeeds) ? workbookConfig.volunteerNeeds : [];
  const workbookHistoryRows = Array.isArray(workbookConfig.historyRows) ? workbookConfig.historyRows : [];
  const mode = toCanonicalImportMode(mappingConfig.mode);
  const importType = mappingConfig.importType ?? "sponsor_master_list";
  const importFormat = mappingConfig.importFormat ?? "csv";
  const selectedTabs = resolveSelectedTabs(input.selectedTabs, {
    importType,
    importFormat,
    hasParsedRows: importBatch.rows.length > 0,
  });
  const shouldImportStandaloneHistory = selectedTabs.history;
  const shouldImportEmbeddedHistoryFromSponsorsList = selectedTabs.legacyMode
    ? selectedTabs.history
    : selectedTabs.historyFromSponsorsList;
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
  let sponsorshipPackagesCreatedOrUpdated = 0;
  let flightSlotsCreated = 0;
  let volunteerNeedsCreated = 0;
  let attendeesCreated = 0;
  let importedRows = 0;
  let importedRowsWithWarnings = 0;
  let skippedRows = 0;
  let failedRows = 0;
  let rowsConsidered = 0;
  let rowsApproved = 0;
  let rowsSkippedByDecision = 0;
  let rowsSkippedBySelectedTabGate = 0;
  let rowsSkippedByMissingCompany = 0;
  let rowsPersisted = 0;

  const isPersistDecision = (decision: ConfirmRowDecision) => {
    return decision === "approve" || decision === "edit" || decision === "merge" || decision === "create_new";
  };

  try {
    for (const row of importBatch.rows) {
      rowsConsidered += 1;

      if (!selectedTabs.sponsorsList) {
        skippedRows += 1;
        rowsSkippedBySelectedTabGate += 1;
        await updateImportRowStatus({
          id: row.id,
          status: "skipped",
          errorMessage: "Sponsors List import is disabled for this confirmation.",
        });
        continue;
      }

      const rowDecision = decisionByImportRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
      const baseStored = row.normalizedData as unknown as StoredSponsorImportRow;
      const resolvedDecision = rowDecision?.decision ?? defaultDecisionForStoredRow(baseStored);
      const stored = mergeEditableNormalized(baseStored, rowDecision?.editableNormalized);
      const shouldPersistRow = isPersistDecision(resolvedDecision);

      if (shouldPersistRow) {
        rowsApproved += 1;
      }

      if (resolvedDecision === "skip" || resolvedDecision === "needs_review") {
        skippedRows += 1;
        rowsSkippedByDecision += 1;
        await updateImportRowStatus({
          id: row.id,
          status: "skipped",
          errorMessage: resolvedDecision === "skip" ? "Row skipped by decision." : "Row marked for review.",
        });
        continue;
      }

      if (stored.rowStatus === "error" || stored.errors.length > 0 || !stored.companyName || !stored.normalizedCompanyName) {
        failedRows += 1;
        if (!stored.companyName || !stored.normalizedCompanyName) {
          rowsSkippedByMissingCompany += 1;
        }
        await updateImportRowStatus({
          id: row.id,
          status: "failed",
          errorMessage: stored.errors.join(" | ") || "Missing company name",
        });
        continue;
      }

      if (stored.rowStatus === "duplicate" && !shouldPersistRow) {
        skippedRows += 1;
        rowsSkippedByDecision += 1;
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
        additionalContacts: Array.isArray((stored as { additionalContacts?: unknown }).additionalContacts)
          ? ((stored as { additionalContacts?: Array<{ name?: string; email?: string; phone?: string }> }).additionalContacts ?? [])
          : [],
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
        try {
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
            sourceImportRowId: row.id,
            importSource: "sponsor_import",
          });
        } catch (error) {
          // Recover from normalized-name unique races by reusing/updating existing org.
          const message = error instanceof Error ? error.message : "";
          const isUniqueNormalizedNameConflict =
            message.includes("Unique constraint failed") &&
            message.includes("organizationId") &&
            message.includes("normalizedName");

          if (!isUniqueNormalizedNameConflict) {
            throw error;
          }

          const existingByNormalizedName = await getSponsorOrganizationByNormalizedName({
            organizationId: input.organizationId,
            normalizedName: rowForMatch.normalizedCompanyName,
          });

          if (!existingByNormalizedName) {
            throw error;
          }

          sponsorOrganization = await updateSponsorOrganization({
            id: existingByNormalizedName.id,
            name: preferExisting(existingByNormalizedName.name, rowForMatch.companyName),
            addressLine1: preferExisting(existingByNormalizedName.addressLine1, rowForMatch.addressLine1),
            city: preferExisting(existingByNormalizedName.city, rowForMatch.city),
            state: preferExisting(existingByNormalizedName.state, rowForMatch.state),
            zipCode: preferExisting(existingByNormalizedName.zipCode, rowForMatch.zipCode),
            mainEmail: preferExisting(existingByNormalizedName.mainEmail, rowForMatch.contactEmail),
            mainPhone: preferExisting(existingByNormalizedName.mainPhone, rowForMatch.contactPhone),
            notes: mergeNotes(existingByNormalizedName.notes, rowForMatch.notes),
            sourceImportBatchId: importBatch.id,
            sourceImportRowId: row.id,
            importSource: "sponsor_import",
          });
          sponsorOrganizationsUpdated += 1;
        }
        existingSponsors.push(sponsorOrganization);
        if (sponsorOrganization && sponsorOrganization.sourceImportBatchId === importBatch.id) {
          sponsorOrganizationsCreated += 1;
        }
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
          sourceImportRowId: row.id,
          importSource: "sponsor_import",
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

        const shouldPersistContact = contactMatch.action !== "review";

        const matchedContact = contactMatch.sponsorContactId
          ? sponsorOrganization.contacts.find((contact) => contact.id === contactMatch.sponsorContactId)
          : undefined;

        if (shouldPersistContact) {
          if (contactMatch.action === "update" && matchedContact) {
            await updateSponsorContact({
              id: matchedContact.id,
              name: preferExisting(matchedContact.name, rowForMatch.contactName),
              email: preferExisting(matchedContact.email, rowForMatch.contactEmail),
              phone: preferExisting(matchedContact.phone, rowForMatch.contactPhone),
              sourceImportBatchId: importBatch.id,
              sourceImportRowId: row.id,
              importSource: "sponsor_import",
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
              sourceImportRowId: row.id,
              importSource: "sponsor_import",
            });
            sponsorContactsCreated += 1;
          }
        }

        if (shouldPersistContact) {
          // Persist additional contacts parsed from multi-contact fields
          for (const additionalContact of rowForMatch.additionalContacts) {
            if (!additionalContact.name && !additionalContact.email && !additionalContact.phone) continue;
            const existingAdditional = sponsorOrganization.contacts.find((c) => {
              if (additionalContact.email && c.email?.toLowerCase() === additionalContact.email.toLowerCase()) return true;
              if (additionalContact.name && c.name?.toLowerCase() === additionalContact.name.toLowerCase()) return true;
              return false;
            });
            if (!existingAdditional) {
              await createSponsorContact({
                organizationId: input.organizationId,
                sponsorOrganizationId: sponsorOrganization.id,
                name: additionalContact.name,
                email: additionalContact.email,
                phone: additionalContact.phone,
                isPrimary: false,
                sourceImportBatchId: importBatch.id,
                sourceImportRowId: row.id,
                importSource: "sponsor_import",
              });
              sponsorContactsCreated += 1;
            }
          }
        }
      }

      let eventSponsor: Awaited<ReturnType<typeof getEventSponsorByComposite>> | undefined;
      if (usesEventAssignment(mode)) {
        eventSponsor = await getEventSponsorByComposite({
          organizationId: input.organizationId,
          eventId: effectiveEventId!,
          sponsorOrganizationId: sponsorOrganization.id,
        });

        const resolvedPaymentStatus = (!selectedTabs.paymentStatus && !selectedTabs.legacyMode)
          ? (eventSponsor?.paymentStatus || "unknown")
          : (rowForMatch.paymentStatus || eventSponsor?.paymentStatus || "unknown");
        const resolvedPaymentNotes = (!selectedTabs.paymentStatus && !selectedTabs.legacyMode)
          ? eventSponsor?.paymentNotes
          : mergeNotes(eventSponsor?.paymentNotes, rowForMatch.paymentNotes);

        eventSponsor = await upsertEventSponsor({
          organizationId: input.organizationId,
          eventId: effectiveEventId!,
          sponsorOrganizationId: sponsorOrganization.id,
          sponsorshipPackage: preferExisting(eventSponsor?.sponsorshipPackage, rowForMatch.sponsorshipPackage),
          committedAmount: eventSponsor?.committedAmount ?? rowForMatch.committedAmount,
          amountPaid: eventSponsor?.amountPaid,
          paymentStatus: resolvedPaymentStatus,
          paymentNotes: resolvedPaymentNotes,
          flightPreference: preferExisting(eventSponsor?.flightPreference, rowForMatch.flightPreference),
          logoStatus: preferExisting(eventSponsor?.logoStatus, rowForMatch.logoStatus),
          attendeeNamesRaw: preferExisting(eventSponsor?.attendeeNamesRaw, rowForMatch.attendeeNamesRaw),
          statusRaw: preferExisting(eventSponsor?.statusRaw, rowForMatch.statusRaw),
          notes: mergeNotes(eventSponsor?.notes, rowForMatch.notes),
          pointPersonName: preferExisting(eventSponsor?.pointPersonName, rowForMatch.pointPersonName),
          sourceImportBatchId: importBatch.id,
          sourceImportRowId: row.id,
          importSource: "sponsor_import",
        });

        if (eventSponsor && eventSponsor.createdAt.getTime() === eventSponsor.updatedAt.getTime()) {
          eventSponsorsCreated += 1;
        } else {
          eventSponsorsUpdated += 1;
        }
      }

      if (shouldImportEmbeddedHistoryFromSponsorsList) {
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
            sourceImportRowId: row.id,
            importSource: "sponsor_import",
          });
          if (existingHistory) yearHistoryUpdated += 1;
          else yearHistoryCreated += 1;

          await prisma.eventParticipationHistory.create({
            data: {
              organizationId: input.organizationId,
              eventId: effectiveEventId,
              sponsorOrganizationId: sponsorOrganization.id,
              sourceEventYear: history.year,
              rawCompanyName: rowForMatch.companyName,
              rawContactName: rowForMatch.contactName,
              rawRole: "sponsor",
              rawPackage: rowForMatch.sponsorshipPackage,
              rawPaymentStatus: rowForMatch.paymentStatus,
              participationType: "sponsor",
              sponsorshipPackage: rowForMatch.sponsorshipPackage,
              amountCommitted: history.amount,
              paymentStatus: rowForMatch.paymentStatus,
              sourceImportBatchId: importBatch.id,
              sourceSheetName: "Sponsors List",
              sourceRowNumber: row.rowNumber,
              sourceRowHash: createHash("sha1").update(`${row.id}|${history.year}|${history.rawValue}`).digest("hex"),
              notes: rowForMatch.notes,
            },
          });
        }
      }

      // Optional: create attendees from representatives when toggle is enabled
      if (input.representativesAsAttendees && usesEventAssignment(mode) && effectiveEventId) {
        const repContacts = [
          { name: rowForMatch.contactName, email: rowForMatch.contactEmail, phone: rowForMatch.contactPhone },
          ...rowForMatch.additionalContacts,
        ].filter((c) => c.name || c.email);

        for (const rep of repContacts) {
          if (!rep.name && !rep.email) continue;
          const fullName = rep.name || rep.email || rowForMatch.companyName;
          const nameParts = (rep.name ?? "").trim().split(/\s+/);
          const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : nameParts[0] ?? undefined;
          const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : undefined;

          let attendee = rep.email
            ? await prisma.eventureAttendee.findFirst({
                where: { organizationId: input.organizationId, email: rep.email },
              })
            : await prisma.eventureAttendee.findFirst({
                where: { organizationId: input.organizationId, fullName },
              });

          if (!attendee) {
            attendee = await prisma.eventureAttendee.create({
              data: {
                organizationId: input.organizationId,
                fullName,
                firstName,
                lastName,
                email: rep.email,
                phone: rep.phone,
                company: rowForMatch.companyName,
                source: "sponsor_import",
                createdByUserId: input.createdByUserId,
              },
            });
          }

          const existingReg = await prisma.eventureRegistration.findFirst({
            where: {
              eventId: effectiveEventId,
              attendeeId: attendee.id,
              registrationType: "sponsor_representative",
            },
          });
          if (!existingReg) {
            await prisma.eventureRegistration.create({
              data: {
                organizationId: input.organizationId,
                eventId: effectiveEventId,
                attendeeId: attendee.id,
                registrationType: "sponsor_representative",
                registrationStatus: "registered",
                paymentStatus: "not_applicable",
                source: "sponsor_import",
                importBatchId: importBatch.id,
                createdByUserId: input.createdByUserId,
              },
            });
          }
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
      rowsPersisted += 1;
    }

    if (selectedTabs.sponsorLevels) {
      for (const pkg of workbookPackages) {
        if (!pkg.name?.trim()) continue;
        await upsertSponsorshipPackage({
          organizationId: input.organizationId,
          eventId: effectiveEventId,
          name: pkg.name.trim(),
          earlyBirdPrice: pkg.earlyBirdPrice,
          regularPrice: pkg.regularPrice,
          bannerBenefit: pkg.bannerBenefit,
          signBenefit: pkg.signBenefit,
          foursomeIncluded: pkg.foursomeIncluded,
          websiteBenefit: pkg.websiteBenefit,
          programBookBenefit: pkg.programBookBenefit,
          coscBenefit: pkg.coscBenefit,
          tributeBenefit: pkg.tributeBenefit,
          sourceImportBatchId: importBatch.id,
          importSource: "sponsor_import",
        });
        sponsorshipPackagesCreatedOrUpdated += 1;
      }
    }

    if (effectiveEventId) {
      for (const slot of workbookFlightSlots) {
        if (slot.flight === "AM" && !selectedTabs.amFlight) continue;
        if (slot.flight === "PM" && !selectedTabs.pmFlight) continue;
        await createEventFlightSlot({
          organizationId: input.organizationId,
          eventId: effectiveEventId,
          flight: slot.flight,
          slotNumber: slot.slotNumber,
          companyName: slot.companyName,
          firstName: slot.firstName,
          lastName: slot.lastName,
          email: slot.email,
          phone: slot.phone,
          startHole: slot.startHole,
          status: slot.status,
          sourceImportBatchId: importBatch.id,
          importSource: "sponsor_import",
        });
        flightSlotsCreated += 1;
      }

      if (selectedTabs.volunteers) {
        for (const need of workbookVolunteerNeeds) {
          if (!need.roleName?.trim()) continue;
          await createEventVolunteerNeed({
            organizationId: input.organizationId,
            eventId: effectiveEventId,
            roleName: need.roleName,
            neededCountText: need.neededCountText,
            flight: need.flight,
            startingAt: need.startingAt,
            rotationTime: need.rotationTime,
            notes: need.notes,
            status: need.status,
            sourceImportBatchId: importBatch.id,
            importSource: "sponsor_import",
          });
          volunteerNeedsCreated += 1;
        }
      }
    }

    if (shouldImportStandaloneHistory) {
      for (const historyRow of workbookHistoryRows) {
        const normalizedCompany = normalizeCompanyName(historyRow.rawCompanyName ?? "");
        const matchedSponsorOrganization = normalizedCompany
          ? existingSponsors.find((item) => item.normalizedName === normalizedCompany)
          : undefined;

        let matchedSponsorContactId: string | undefined;
        if (matchedSponsorOrganization && historyRow.rawContactName) {
          const normalizedContact = normalizeName(historyRow.rawContactName);
          const contact = matchedSponsorOrganization.contacts.find((item) => normalizeName(item.name) === normalizedContact);
          matchedSponsorContactId = contact?.id;
        }

        await prisma.eventParticipationHistory.create({
          data: {
            organizationId: input.organizationId,
            eventId: effectiveEventId,
            sponsorOrganizationId: matchedSponsorOrganization?.id,
            sponsorContactId: matchedSponsorContactId,
            sourceEventName: historyRow.sourceEventName,
            sourceEventYear: historyRow.sourceEventYear,
            rawCompanyName: historyRow.rawCompanyName,
            rawContactName: historyRow.rawContactName,
            rawRole: historyRow.rawRole,
            rawPackage: historyRow.rawPackage,
            rawPaymentStatus: historyRow.rawPaymentStatus,
            participationType: historyRow.participationType,
            sponsorshipPackage: historyRow.sponsorshipPackage,
            amountCommitted: historyRow.amountCommitted,
            amountPaid: historyRow.amountPaid,
            paymentStatus: historyRow.paymentStatus,
            flight: historyRow.flight,
            slot: historyRow.slot,
            notes: historyRow.notes,
            sourceImportBatchId: importBatch.id,
            sourceSheetName: historyRow.sourceSheetName,
            sourceRowNumber: historyRow.sourceRowNumber,
            sourceRowHash: historyRow.sourceRowHash,
          },
        });
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
      importScope: resolveImportScope(effectiveEventId),
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
        sponsorshipPackagesCreatedOrUpdated,
        flightSlotsCreated,
        volunteerNeedsCreated,
        attendeesCreated,
        skippedRows,
        failedRows,
      },
      debug: {
        selectedTabs,
        importFormat,
        importType,
        rowsConsidered,
        rowsApproved,
        rowsSkippedByDecision,
        rowsSkippedBySelectedTabGate,
        rowsSkippedByMissingCompany,
        rowsPersisted,
      },
      nextActions: [
        { label: "View Directory", href: "/directory" },
        ...(effectiveEventId ? [{ label: "View Event Sponsors", href: `/events/${effectiveEventId}/sponsors` }] : []),
        { label: "View Follow-Ups", href: "/follow-ups" },
      ],
    };
  } catch (error) {
    await failImportBatch(importBatch.id);
    throw error;
  }
}

type RollbackAnalysis = {
  importBatch: {
    id: string;
    organizationId: string;
    eventId: string | null;
    status: string;
  };
  warnings: string[];
  canRollback: boolean;
  hardDeleteAllowed: boolean;
  sponsorOrganizations: Array<{ id: string; name: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  sponsorContacts: Array<{ id: string; name: string; sponsorOrganizationId: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  eventSponsors: Array<{ id: string; eventId: string; sponsorOrganizationId: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  sponsorYearHistory: Array<{ id: string; sponsorOrganizationId: string; year: number; createdAt: Date; archivedAt: Date | null }>;
  sponsorFollowUps: Array<{ id: string; title: string; status: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  sponsorshipPackages: Array<{ id: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  eventFlightSlots: Array<{ id: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  eventVolunteerNeeds: Array<{ id: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }>;
  safeSponsorOrganizationIds: string[];
  retainedSponsorOrganizationWarnings: string[];
  safeHardDeleteIds: {
    sponsorOrganizations: string[];
    sponsorContacts: string[];
    eventSponsors: string[];
    sponsorYearHistory: string[];
    sponsorFollowUps: string[];
    sponsorshipPackages: string[];
    eventFlightSlots: string[];
    eventVolunteerNeeds: string[];
  };
};

async function buildRollbackAnalysis(input: {
  organizationId: string;
  importBatchId: string;
  eventId?: string;
  canHardDelete: boolean;
}): Promise<RollbackAnalysis> {
  const importBatch = await prisma.eventureImportBatch.findFirst({
    where: {
      id: input.importBatchId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      organizationId: true,
      eventId: true,
      status: true,
    },
  });

  if (!importBatch || (input.eventId && importBatch.eventId !== input.eventId)) {
    throw new EventureServiceError("Import batch not found.", 404);
  }

  const [
    sponsorOrganizations,
    sponsorContacts,
    eventSponsors,
    sponsorYearHistory,
    sponsorFollowUps,
    sponsorshipPackages,
    eventFlightSlots,
    eventVolunteerNeeds,
  ] = await Promise.all([
    prisma.eventureSponsorOrganization.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.eventureSponsorContact.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        name: true,
        sponsorOrganizationId: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.eventureEventSponsor.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        eventId: true,
        sponsorOrganizationId: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.eventureSponsorYearHistory.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        sponsorOrganizationId: true,
        year: true,
        createdAt: true,
        archivedAt: true,
      },
      orderBy: [{ year: "desc" }, { createdAt: "desc" }],
    }),
    prisma.eventureSponsorFollowUp.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.eventureSponsorshipPackage.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.eventureEventFlightSlot.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.eventureEventVolunteerNeed.findMany({
      where: {
        organizationId: input.organizationId,
        sourceImportBatchId: importBatch.id,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const warnings: string[] = [];
  const manualEditDetected =
    sponsorOrganizations.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    sponsorContacts.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    eventSponsors.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    sponsorFollowUps.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    sponsorshipPackages.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    eventFlightSlots.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt)) ||
    eventVolunteerNeeds.some((item) => isImportRecordManuallyEdited(item.createdAt, item.updatedAt));

  if (manualEditDetected) {
    warnings.push("Some records have been manually edited after import.");
  }

  const importedSponsorOrgIds = sponsorOrganizations.map((item) => item.id);
  const retainedSponsorOrganizationWarnings: string[] = [];
  const safeSponsorOrganizationIds: string[] = [];

  for (const sponsorOrganization of sponsorOrganizations) {
    const [externalContacts, externalEventSponsors, externalHistory, externalFollowUps] = await Promise.all([
      prisma.eventureSponsorContact.count({
        where: {
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          archivedAt: null,
          OR: [
            { sourceImportBatchId: null },
            { sourceImportBatchId: { not: importBatch.id } },
          ],
        },
      }),
      prisma.eventureEventSponsor.count({
        where: {
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          archivedAt: null,
          OR: [
            { sourceImportBatchId: null },
            { sourceImportBatchId: { not: importBatch.id } },
          ],
        },
      }),
      prisma.eventureSponsorYearHistory.count({
        where: {
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          archivedAt: null,
          OR: [
            { sourceImportBatchId: null },
            { sourceImportBatchId: { not: importBatch.id } },
          ],
        },
      }),
      prisma.eventureSponsorFollowUp.count({
        where: {
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          archivedAt: null,
          OR: [
            { sourceImportBatchId: null },
            { sourceImportBatchId: { not: importBatch.id } },
          ],
        },
      }),
    ]);

    const hasManualEdits = isImportRecordManuallyEdited(sponsorOrganization.createdAt, sponsorOrganization.updatedAt);
    const hasExternalLinks = externalContacts + externalEventSponsors + externalHistory + externalFollowUps > 0;

    if (!hasManualEdits && !hasExternalLinks) {
      safeSponsorOrganizationIds.push(sponsorOrganization.id);
      continue;
    }

    retainedSponsorOrganizationWarnings.push(
      `${sponsorOrganization.name}: Company retained because it has records outside this import.`,
    );
  }

  if (retainedSponsorOrganizationWarnings.length > 0) {
    warnings.push("Some records are linked to event data.");
    warnings.push("Some records have dependent contacts/history.");
  }

  if (!["confirmed", "confirmed_with_warnings", "completed", "failed", "needs_review"].includes(importBatch.status)) {
    warnings.push("This import batch is not in a rollback-ready state.");
  }

  if (["rolled_back", "rollback_partial"].includes(importBatch.status)) {
    warnings.push("This import batch has already been rolled back.");
  }

  const safeHardDeleteIds = {
    sponsorOrganizations: sponsorOrganizations
      .filter((item) => safeSponsorOrganizationIds.includes(item.id) && !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    sponsorContacts: sponsorContacts
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    eventSponsors: eventSponsors
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    sponsorYearHistory: sponsorYearHistory.map((item) => item.id),
    sponsorFollowUps: sponsorFollowUps
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    sponsorshipPackages: sponsorshipPackages
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    eventFlightSlots: eventFlightSlots
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
    eventVolunteerNeeds: eventVolunteerNeeds
      .filter((item) => !isImportRecordManuallyEdited(item.createdAt, item.updatedAt))
      .map((item) => item.id),
  };

  const hardDeleteSafetyPass =
    safeHardDeleteIds.sponsorOrganizations.length === sponsorOrganizations.length &&
    safeHardDeleteIds.sponsorContacts.length === sponsorContacts.length &&
    safeHardDeleteIds.eventSponsors.length === eventSponsors.length &&
    safeHardDeleteIds.sponsorFollowUps.length === sponsorFollowUps.length &&
    safeHardDeleteIds.sponsorshipPackages.length === sponsorshipPackages.length &&
    safeHardDeleteIds.eventFlightSlots.length === eventFlightSlots.length &&
    safeHardDeleteIds.eventVolunteerNeeds.length === eventVolunteerNeeds.length;

  if (!hardDeleteSafetyPass) {
    warnings.push("Hard delete is not safe; archive recommended.");
  }

  return {
    importBatch,
    warnings: [...new Set(warnings)],
    canRollback: !["rolled_back", "rollback_partial"].includes(importBatch.status),
    hardDeleteAllowed: input.canHardDelete && hardDeleteSafetyPass,
    sponsorOrganizations,
    sponsorContacts,
    eventSponsors,
    sponsorYearHistory,
    sponsorFollowUps,
    sponsorshipPackages,
    eventFlightSlots,
    eventVolunteerNeeds,
    safeSponsorOrganizationIds,
    retainedSponsorOrganizationWarnings,
    safeHardDeleteIds,
  };
}

export async function previewSponsorImportRollback(input: {
  organizationId: string;
  importBatchId: string;
  eventId?: string;
  role?: string;
  platformRole?: string;
}): Promise<SponsorImportRollbackPreviewResponse> {
  const analysis = await buildRollbackAnalysis({
    organizationId: input.organizationId,
    importBatchId: input.importBatchId,
    eventId: input.eventId,
    canHardDelete: isRollbackHardDeletePrivileged(input.role, input.platformRole),
  });

  return {
    importBatchId: analysis.importBatch.id,
    status: analysis.importBatch.status,
    canRollback: analysis.canRollback,
    warnings: [...analysis.warnings, ...analysis.retainedSponsorOrganizationWarnings],
    counts: {
      sponsorOrganizations: analysis.sponsorOrganizations.length,
      sponsorContacts: analysis.sponsorContacts.length,
      eventSponsors: analysis.eventSponsors.length,
      sponsorYearHistory: analysis.sponsorYearHistory.length,
      sponsorFollowUps: analysis.sponsorFollowUps.length,
      sponsorshipPackages: analysis.sponsorshipPackages.length,
      eventFlightSlots: analysis.eventFlightSlots.length,
      eventVolunteerNeeds: analysis.eventVolunteerNeeds.length,
    },
    records: {
      sponsorOrganizations: analysis.sponsorOrganizations.slice(0, 200).map((item) => ({
        id: item.id,
        name: item.name,
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      })),
      sponsorContacts: analysis.sponsorContacts.slice(0, 200).map((item) => ({
        id: item.id,
        name: item.name,
        sponsorOrganizationId: item.sponsorOrganizationId,
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      })),
      eventSponsors: analysis.eventSponsors.slice(0, 200).map((item) => ({
        id: item.id,
        eventId: item.eventId,
        sponsorOrganizationId: item.sponsorOrganizationId,
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      })),
      sponsorYearHistory: analysis.sponsorYearHistory.slice(0, 200).map((item) => ({
        id: item.id,
        sponsorOrganizationId: item.sponsorOrganizationId,
        year: item.year,
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      })),
      sponsorFollowUps: analysis.sponsorFollowUps.slice(0, 200).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      })),
    },
    recommendedMode: "archive",
    hardDeleteAllowed: analysis.hardDeleteAllowed,
  };
}

export async function rollbackSponsorImportBatch(input: {
  organizationId: string;
  importBatchId: string;
  eventId?: string;
  mode: SponsorImportRollbackMode;
  confirmationText: string;
  actorUserId?: string;
  actorRole?: string;
  actorPlatformRole?: string;
}): Promise<SponsorImportRollbackResponse> {
  if (!validateRollbackConfirmationText(input.confirmationText)) {
    throw new EventureServiceError("confirmationText must equal 'ROLLBACK IMPORT'.", 400);
  }

  const canHardDelete = isRollbackHardDeletePrivileged(input.actorRole, input.actorPlatformRole);
  if (input.mode === "hard_delete" && !canHardDelete) {
    throw new EventureServiceError("Hard delete requires admin/dev permissions.", 403);
  }

  const analysis = await buildRollbackAnalysis({
    organizationId: input.organizationId,
    importBatchId: input.importBatchId,
    eventId: input.eventId,
    canHardDelete,
  });

  if (!analysis.canRollback) {
    throw new EventureServiceError("This import batch cannot be rolled back.", 409);
  }

  if (input.mode === "hard_delete" && !analysis.hardDeleteAllowed) {
    throw new EventureServiceError("Hard delete is not safe for this import batch. Use archive mode.", 409);
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (input.mode === "archive") {
      await tx.eventureSponsorFollowUp.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureEventSponsor.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureSponsorYearHistory.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureSponsorContact.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureSponsorshipPackage.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureEventFlightSlot.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      await tx.eventureEventVolunteerNeed.updateMany({
        where: { organizationId: input.organizationId, sourceImportBatchId: input.importBatchId, archivedAt: null },
        data: { archivedAt: now },
      });

      if (analysis.safeSponsorOrganizationIds.length > 0) {
        await tx.eventureSponsorOrganization.updateMany({
          where: {
            organizationId: input.organizationId,
            id: { in: analysis.safeSponsorOrganizationIds },
            sourceImportBatchId: input.importBatchId,
            archivedAt: null,
          },
          data: { archivedAt: now },
        });
      }
    } else {
      if (analysis.safeHardDeleteIds.sponsorFollowUps.length > 0) {
        await tx.eventureSponsorFollowUp.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.sponsorFollowUps } } });
      }
      if (analysis.safeHardDeleteIds.eventSponsors.length > 0) {
        await tx.eventureEventSponsor.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.eventSponsors } } });
      }
      if (analysis.safeHardDeleteIds.sponsorYearHistory.length > 0) {
        await tx.eventureSponsorYearHistory.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.sponsorYearHistory } } });
      }
      if (analysis.safeHardDeleteIds.sponsorContacts.length > 0) {
        await tx.eventureSponsorContact.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.sponsorContacts } } });
      }
      if (analysis.safeHardDeleteIds.sponsorshipPackages.length > 0) {
        await tx.eventureSponsorshipPackage.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.sponsorshipPackages } } });
      }
      if (analysis.safeHardDeleteIds.eventFlightSlots.length > 0) {
        await tx.eventureEventFlightSlot.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.eventFlightSlots } } });
      }
      if (analysis.safeHardDeleteIds.eventVolunteerNeeds.length > 0) {
        await tx.eventureEventVolunteerNeed.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.eventVolunteerNeeds } } });
      }
      if (analysis.safeHardDeleteIds.sponsorOrganizations.length > 0) {
        await tx.eventureSponsorOrganization.deleteMany({ where: { id: { in: analysis.safeHardDeleteIds.sponsorOrganizations } } });
      }
    }

    await tx.eventureImportRow.updateMany({
      where: {
        organizationId: input.organizationId,
        importBatchId: input.importBatchId,
        status: { in: ["imported", "imported_with_warnings"] },
      },
      data: {
        status: "rolled_back",
        rolledBackAt: now,
      },
    });

    const rollbackStatus = analysis.retainedSponsorOrganizationWarnings.length > 0 ? "rollback_partial" : "rolled_back";
    await tx.eventureImportBatch.update({
      where: { id: input.importBatchId },
      data: {
        status: rollbackStatus,
        rolledBackAt: now,
        rollbackMode: input.mode,
        rollbackSummary: {
          warnings: [...analysis.warnings, ...analysis.retainedSponsorOrganizationWarnings],
          retainedSponsorOrganizations: analysis.retainedSponsorOrganizationWarnings,
          mode: input.mode,
        },
      },
    });

    await tx.eventureAuditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole ?? "",
        action: "import.rollback",
        resourceType: "eventure_import_batch",
        resourceId: input.importBatchId,
        metadata: {
          mode: input.mode,
          warnings: [...analysis.warnings, ...analysis.retainedSponsorOrganizationWarnings],
        },
      },
    });
  });

  return {
    importBatchId: input.importBatchId,
    status: analysis.retainedSponsorOrganizationWarnings.length > 0 ? "rollback_partial" : "rolled_back",
    mode: input.mode,
    warnings: [...analysis.warnings, ...analysis.retainedSponsorOrganizationWarnings],
    affectedCounts: {
      sponsorOrganizations: analysis.sponsorOrganizations.length,
      sponsorContacts: analysis.sponsorContacts.length,
      eventSponsors: analysis.eventSponsors.length,
      sponsorYearHistory: analysis.sponsorYearHistory.length,
      sponsorFollowUps: analysis.sponsorFollowUps.length,
      sponsorshipPackages: analysis.sponsorshipPackages.length,
      eventFlightSlots: analysis.eventFlightSlots.length,
      eventVolunteerNeeds: analysis.eventVolunteerNeeds.length,
    },
  };
}
