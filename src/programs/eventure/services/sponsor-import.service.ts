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
  findMatchingContact,
  getActiveEventForOrganization,
  getEventSponsorByComposite,
  listEventSponsorsForEvent,
  listSponsorOrganizationsForOrganization,
  updateSponsorContact,
  updateSponsorOrganization,
  upsertEventSponsor,
  upsertSponsorYearHistory,
} from "../repositories/sponsor-import.repository.js";
import { EventureServiceError } from "./eventure-error.js";
import { canUseSharedParser, parseDocumentWithSharedService } from "../../../core/services/parse/documentParseService.js";

type ImportWarning = {
  rowNumber: number;
  code: string;
  message: string;
};

type SuggestedFollowUp = {
  type: string;
  title: string;
  description: string;
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

function cleanCell(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  return BLANK_MARKERS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

function normalizeCompanyName(value: string): string {
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

function inferPaymentStatus(input: { statusRaw?: string; notes?: string; sponsorshipPackage?: string }): string {
  const haystack = `${input.statusRaw ?? ""} ${input.notes ?? ""} ${input.sponsorshipPackage ?? ""}`.toLowerCase();
  if (!haystack.trim()) return "unknown";
  if (haystack.includes("cancel")) return "cancelled";
  if (haystack.includes("comp")) return "comped";
  if (haystack.includes("kindful") || haystack.includes("paid")) return "paid_external";
  if (haystack.includes("to pay at event") || haystack.includes("pay at event")) return "pending_event_payment";
  if (haystack.includes("need invoice") || haystack.includes("invoice needed") || haystack.includes("send invoice")) {
    return "invoice_needed";
  }
  if (haystack.includes("invoiced") || haystack.includes("invoice sent")) return "invoiced";
  if (haystack.includes("unpaid") || haystack.includes("outstanding") || haystack.includes("owes")) return "unpaid";
  if (haystack.includes("not required") || haystack.includes("n/a")) return "not_required";
  return "unknown";
}

function parseYearValue(rawValue: string): ParsedYearHistory {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return { year: 0, rawValue, participationStatus: "none" };
  }

  if (normalized === "x") {
    return { year: 0, rawValue, participationStatus: "participated_unknown_amount" };
  }

  if (normalized === "new") {
    return { year: 0, rawValue, participationStatus: "new_prospect" };
  }

  const amount = parseMoney(rawValue);
  if (amount !== undefined) {
    return { year: 0, rawValue, amount, participationStatus: "amount_recorded" };
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

function detectFollowUps(row: {
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

  if (!normalizedLogo || normalizedLogo.includes("need") || normalizedLogo.includes("pending")) {
    suggestions.push({
      type: "need_logo",
      title: "Need sponsor logo",
      description: "Logo status indicates the logo is missing or pending.",
      assignedToName: row.pointPersonName,
    });
  }

  if (!normalizedNames || normalizedNames.includes("pending") || normalizedNames.includes("tbd")) {
    suggestions.push({
      type: "need_names",
      title: "Need golfer/attendee names",
      description: "Attendee names are blank or marked pending.",
      assignedToName: row.pointPersonName,
    });
  }

  if (row.paymentStatus === "invoice_needed" || row.paymentStatus === "invoiced") {
    suggestions.push({
      type: "need_invoice",
      title: "Invoice follow-up",
      description: `Payment status is ${row.paymentStatus}.`,
      assignedToName: row.pointPersonName,
    });
  }

  if (row.paymentStatus === "unpaid" || row.paymentStatus === "pending_event_payment") {
    suggestions.push({
      type: "need_payment",
      title: "Payment follow-up",
      description: `Payment status is ${row.paymentStatus}.`,
      assignedToName: row.pointPersonName,
    });
  }

  if (!row.contactEmail && !row.contactPhone) {
    suggestions.push({
      type: "need_contact_info",
      title: "Need contact information",
      description: "No contact email or phone was found in the row.",
      assignedToName: row.pointPersonName,
    });
  }

  if (normalizedText.includes("waiting") || normalizedText.includes("follow up") || normalizedText.includes("no response")) {
    suggestions.push({
      type: "waiting_response",
      title: "Waiting on sponsor response",
      description: "Status/notes indicate pending response.",
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

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
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

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    mapped[field] = resolveMappedHeaderIndex(headers, aliases);
  }

  const yearColumns: Array<{ index: number; year: number; header: string }> = [];
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const match = normalized.match(/\b(20\d{2})\b/);
    if (!match) return;
    if (normalized.includes("yr") || normalized === match[1]) {
      const year = Number.parseInt(match[1], 10);
      if (year >= 2000 && year <= 2099) {
        yearColumns.push({ index, year, header });
      }
    }

    if (mapped.currentAmount === undefined && normalized.includes(match[1]) && normalized.includes("amount")) {
      mapped.currentAmount = index;
    }
  });

  if (mapped.currentAmount === undefined) {
    const fallbackAmountIndex = headers.findIndex((header) => /current.*amount|amount.*current|committed amount/i.test(header));
    if (fallbackAmountIndex >= 0) mapped.currentAmount = fallbackAmountIndex;
  }

  return {
    mapped,
    yearColumns,
  };
}

function getCell(row: string[], index?: number): string {
  if (index === undefined) return "";
  return cleanCell(row[index]);
}

function parseRows(content: string): {
  headers: string[];
  mapped: Record<string, number | undefined>;
  yearColumns: Array<{ index: number; year: number; header: string }>;
  rows: ParsedSponsorRow[];
} {
  const { headers, rows } = parseCsv(content);
  const { mapped, yearColumns } = mapColumns(headers);

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
    const flightPreference = getCell(row, mapped.flight) || undefined;
    const logoStatus = getCell(row, mapped.logo) || undefined;
    const attendeeNamesRaw = getCell(row, mapped.names) || undefined;
    const statusRaw = getCell(row, mapped.status) || undefined;
    const pointPersonName = getCell(row, mapped.pointPerson) || undefined;
    const notes = getCell(row, mapped.notes) || undefined;
    const committedAmount = parseMoney(getCell(row, mapped.currentAmount));

    const paymentStatus = inferPaymentStatus({ statusRaw, notes, sponsorshipPackage });

    const yearHistory: ParsedYearHistory[] = yearColumns
      .map((yearColumn) => {
        const value = getCell(row, yearColumn.index);
        if (!value) return null;
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
    rows: parsedRows,
  };
}

type OrganizationMatchResult = {
  action: "create" | "update";
  matchedBy: "normalized_name" | "email_domain_close" | "phone_close" | "new";
  sponsorOrganizationId?: string;
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

  const rowDomain = extractDomain(row.contactEmail);
  if (rowDomain) {
    const domainCandidates = existingSponsors.filter((item) => {
      const existingDomain = extractDomain(item.mainEmail ?? undefined);
      return existingDomain === rowDomain && namesAreClose(item.normalizedName, row.normalizedCompanyName);
    });

    if (domainCandidates.length === 1) {
      return {
        action: "update",
        matchedBy: "email_domain_close",
        sponsorOrganizationId: domainCandidates[0].id,
      };
    }

    if (domainCandidates.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "SPONSOR_MATCH_REVIEW",
        message: "Multiple sponsor organizations matched by email domain. Created as a new sponsor for manual review.",
      });
    }
  }

  const rowPhone = normalizePhone(row.contactPhone);
  if (rowPhone) {
    const phoneCandidates = existingSponsors.filter((item) => {
      const existingPhone = normalizePhone(item.mainPhone ?? undefined);
      return existingPhone === rowPhone && namesAreClose(item.normalizedName, row.normalizedCompanyName);
    });

    if (phoneCandidates.length === 1) {
      return {
        action: "update",
        matchedBy: "phone_close",
        sponsorOrganizationId: phoneCandidates[0].id,
      };
    }

    if (phoneCandidates.length > 1) {
      warnings.push({
        rowNumber: row.rowNumber,
        code: "SPONSOR_MATCH_REVIEW",
        message: "Multiple sponsor organizations matched by phone. Created as a new sponsor for manual review.",
      });
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
  eventId: string;
  csvContent: string;
  fileName?: string;
  parserStrategy?: SponsorImportParserStrategy;
}) {
  const event = await getActiveEventForOrganization(input.organizationId, input.eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const parseResolution = await resolveCsvForParsing(input.csvContent, input.parserStrategy ?? "native");
  const parsed = parseRows(parseResolution.content);
  const existingSponsors = await listSponsorOrganizationsForOrganization(input.organizationId);
  const existingEventSponsors = await listEventSponsorsForEvent(input.organizationId, input.eventId);
  const existingEventSponsorSet = new Set(existingEventSponsors.map((item) => item.sponsorOrganizationId));

  const warnings: ImportWarning[] = [];
  const companyItems: PreviewItem[] = [];
  const contactItems: ContactPreviewItem[] = [];
  const eventSponsorItems: PreviewItem[] = [];
  const followUps: Array<{ rowNumber: number; company: string; type: string; title: string }> = [];

  let historyRecords = 0;
  let skippedRows = 0;

  for (const row of parsed.rows) {
    warnings.push(...row.warnings);

    if (!row.companyName) {
      skippedRows += 1;
      continue;
    }

    const rowWarnings: ImportWarning[] = [];
    const sponsorMatch = findSponsorMatch({ row, existingSponsors, warnings: rowWarnings });
    warnings.push(...rowWarnings);

    companyItems.push({
      rowNumber: row.rowNumber,
      company: row.companyName,
      action: sponsorMatch.action,
      matchedBy: sponsorMatch.matchedBy,
    });

    const matchedSponsor = sponsorMatch.sponsorOrganizationId
      ? existingSponsors.find((item) => item.id === sponsorMatch.sponsorOrganizationId)
      : undefined;

    let contactAction: ContactPreviewItem["action"] = "skip";
    if (row.contactName || row.contactEmail || row.contactPhone) {
      if (matchedSponsor) {
        const contactNameNorm = normalizeName(row.contactName);
        const hasContact = matchedSponsor.contacts.some((contact) => {
          if (row.contactEmail && contact.email && row.contactEmail.toLowerCase() === contact.email.toLowerCase()) return true;
          if (row.contactPhone && normalizePhone(row.contactPhone) && normalizePhone(contact.phone ?? undefined) === normalizePhone(row.contactPhone)) {
            return true;
          }
          if (contactNameNorm && normalizeName(contact.name) === contactNameNorm) return true;
          return false;
        });
        contactAction = hasContact ? "update" : "create";
      } else {
        contactAction = "create";
      }
    }

    contactItems.push({
      rowNumber: row.rowNumber,
      company: row.companyName,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      action: contactAction,
    });

    const willUpdateEventSponsor = sponsorMatch.sponsorOrganizationId
      ? existingEventSponsorSet.has(sponsorMatch.sponsorOrganizationId)
      : false;

    eventSponsorItems.push({
      rowNumber: row.rowNumber,
      company: row.companyName,
      action: willUpdateEventSponsor ? "update" : "create",
      matchedBy: sponsorMatch.matchedBy,
    });

    historyRecords += row.yearHistory.length;

    for (const suggestion of row.suggestedFollowUps) {
      followUps.push({
        rowNumber: row.rowNumber,
        company: row.companyName,
        type: suggestion.type,
        title: suggestion.title,
      });
    }
  }

  return {
    importTypeDetected: "sponsor_master_list",
    parserUsed: parseResolution.parserUsed,
    eventId: input.eventId,
    fileName: input.fileName ?? "uploaded.csv",
    totalRows: parsed.rows.length,
    skippedRows,
    mapping: {
      mappedColumns: parsed.mapped,
      yearColumns: parsed.yearColumns,
    },
    preview: {
      companies: {
        toCreate: companyItems.filter((item) => item.action === "create").length,
        toUpdate: companyItems.filter((item) => item.action === "update").length,
        items: companyItems,
      },
      contacts: {
        toCreate: contactItems.filter((item) => item.action === "create").length,
        toUpdate: contactItems.filter((item) => item.action === "update").length,
        items: contactItems,
      },
      eventSponsors: {
        toCreate: eventSponsorItems.filter((item) => item.action === "create").length,
        toUpdate: eventSponsorItems.filter((item) => item.action === "update").length,
        items: eventSponsorItems,
      },
      historyRecordsToCreateOrUpdate: historyRecords,
      potentialFollowUps: followUps,
      warnings: [
        ...parseResolution.parserWarnings.map((message) => ({ rowNumber: 0, code: "PARSER_FALLBACK", message })),
        ...warnings,
      ],
    },
  };
}

export async function confirmSponsorImportForEvent(input: {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  csvContent: string;
  fileName?: string;
  parserStrategy?: SponsorImportParserStrategy;
}) {
  const event = await getActiveEventForOrganization(input.organizationId, input.eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const parseResolution = await resolveCsvForParsing(input.csvContent, input.parserStrategy ?? "native");
  const parsed = parseRows(parseResolution.content);
  const existingSponsors = await listSponsorOrganizationsForOrganization(input.organizationId);

  const importBatch = await createImportBatch({
    organizationId: input.organizationId,
    eventId: input.eventId,
    fileName: input.fileName ?? `eventure-sponsor-import-${Date.now()}.csv`,
    fileType: "text/csv",
    fileUrl: `inline://eventure/${input.eventId}/${Date.now()}`,
    createdByUserId: input.createdByUserId,
    totalRows: parsed.rows.length,
    mappingConfig: {
      mappedColumns: parsed.mapped,
      yearColumns: parsed.yearColumns,
      importType: "sponsor_master_list",
      parserStrategyRequested: input.parserStrategy ?? "native",
      parserUsed: parseResolution.parserUsed,
      parserWarnings: parseResolution.parserWarnings,
    },
  });

  let validRows = 0;
  let errorRows = 0;
  let duplicateRows = 0;

  let companiesCreated = 0;
  let companiesUpdated = 0;
  let contactsCreated = 0;
  let contactsUpdated = 0;
  let eventSponsorsCreated = 0;
  let eventSponsorsUpdated = 0;
  let historyUpserts = 0;
  let followUpsCreated = 0;

  try {
    for (const row of parsed.rows) {
      const rowWarnings: ImportWarning[] = [...row.warnings];

      if (!row.companyName || !row.normalizedCompanyName) {
        errorRows += 1;
        await createImportRow({
          organizationId: input.organizationId,
          eventId: input.eventId,
          importBatchId: importBatch.id,
          rowNumber: row.rowNumber,
          rawData: row.raw,
          normalizedData: {
            companyName: row.companyName,
          },
          status: "error",
          errorMessage: "Missing company name",
        });
        continue;
      }

      const sponsorMatch = findSponsorMatch({ row, existingSponsors, warnings: rowWarnings });
      let sponsorOrganization = sponsorMatch.sponsorOrganizationId
        ? existingSponsors.find((item) => item.id === sponsorMatch.sponsorOrganizationId)
        : undefined;

      if (!sponsorOrganization) {
        sponsorOrganization = await createSponsorOrganization({
          organizationId: input.organizationId,
          name: row.companyName,
          normalizedName: row.normalizedCompanyName,
          addressLine1: row.addressLine1,
          city: row.city,
          state: row.state,
          zipCode: row.zipCode,
          mainEmail: row.contactEmail,
          mainPhone: row.contactPhone,
          notes: row.notes,
          sourceImportBatchId: importBatch.id,
        });
        existingSponsors.push(sponsorOrganization);
        companiesCreated += 1;
      } else {
        sponsorOrganization = await updateSponsorOrganization({
          id: sponsorOrganization.id,
          name: preferExisting(sponsorOrganization.name, row.companyName),
          addressLine1: preferExisting(sponsorOrganization.addressLine1, row.addressLine1),
          city: preferExisting(sponsorOrganization.city, row.city),
          state: preferExisting(sponsorOrganization.state, row.state),
          zipCode: preferExisting(sponsorOrganization.zipCode, row.zipCode),
          mainEmail: preferExisting(sponsorOrganization.mainEmail, row.contactEmail),
          mainPhone: preferExisting(sponsorOrganization.mainPhone, row.contactPhone),
          notes: mergeNotes(sponsorOrganization.notes, row.notes),
          sourceImportBatchId: importBatch.id,
        });

        const listIndex = existingSponsors.findIndex((item) => item.id === sponsorOrganization.id);
        if (listIndex >= 0) existingSponsors[listIndex] = sponsorOrganization;
        companiesUpdated += 1;
      }

      if (row.contactName || row.contactEmail || row.contactPhone) {
        const matchedContact = await findMatchingContact({
          organizationId: input.organizationId,
          sponsorOrganizationId: sponsorOrganization.id,
          email: row.contactEmail,
          phone: row.contactPhone,
          name: row.contactName,
        });

        if (matchedContact) {
          await updateSponsorContact({
            id: matchedContact.id,
            name: preferExisting(matchedContact.name, row.contactName),
            email: preferExisting(matchedContact.email, row.contactEmail),
            phone: preferExisting(matchedContact.phone, row.contactPhone),
            sourceImportBatchId: importBatch.id,
          });
          contactsUpdated += 1;
        } else {
          await createSponsorContact({
            organizationId: input.organizationId,
            sponsorOrganizationId: sponsorOrganization.id,
            name: row.contactName || row.companyName,
            email: row.contactEmail,
            phone: row.contactPhone,
            isPrimary: true,
            sourceImportBatchId: importBatch.id,
          });
          contactsCreated += 1;
        }
      }

      const existingEventSponsor = await getEventSponsorByComposite({
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: sponsorOrganization.id,
      });

      const eventSponsor = await upsertEventSponsor({
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: sponsorOrganization.id,
        sponsorshipPackage: preferExisting(existingEventSponsor?.sponsorshipPackage, row.sponsorshipPackage),
        committedAmount: existingEventSponsor?.committedAmount ?? row.committedAmount,
        amountPaid: existingEventSponsor?.amountPaid,
        paymentStatus: row.paymentStatus || existingEventSponsor?.paymentStatus || "unknown",
        paymentNotes: mergeNotes(existingEventSponsor?.paymentNotes, row.paymentNotes),
        flightPreference: preferExisting(existingEventSponsor?.flightPreference, row.flightPreference),
        logoStatus: preferExisting(existingEventSponsor?.logoStatus, row.logoStatus),
        attendeeNamesRaw: preferExisting(existingEventSponsor?.attendeeNamesRaw, row.attendeeNamesRaw),
        statusRaw: preferExisting(existingEventSponsor?.statusRaw, row.statusRaw),
        notes: mergeNotes(existingEventSponsor?.notes, row.notes),
        pointPersonName: preferExisting(existingEventSponsor?.pointPersonName, row.pointPersonName),
        sourceImportBatchId: importBatch.id,
      });

      if (existingEventSponsor) eventSponsorsUpdated += 1;
      else eventSponsorsCreated += 1;

      for (const history of row.yearHistory) {
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
        historyUpserts += 1;
      }

      for (const suggestion of row.suggestedFollowUps) {
        const existingFollowUp = await findExistingOpenFollowUp({
          organizationId: input.organizationId,
          eventId: input.eventId,
          eventSponsorId: eventSponsor.id,
          sponsorOrganizationId: sponsorOrganization.id,
          type: suggestion.type,
        });

        if (existingFollowUp) {
          duplicateRows += 1;
          continue;
        }

        await createSponsorFollowUp({
          organizationId: input.organizationId,
          eventId: input.eventId,
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

      await createImportRow({
        organizationId: input.organizationId,
        eventId: input.eventId,
        importBatchId: importBatch.id,
        rowNumber: row.rowNumber,
        rawData: row.raw,
        normalizedData: {
          companyName: row.companyName,
          normalizedCompanyName: row.normalizedCompanyName,
          contactName: row.contactName,
          contactEmail: row.contactEmail,
          contactPhone: row.contactPhone,
          sponsorshipPackage: row.sponsorshipPackage,
          committedAmount: row.committedAmount,
          paymentStatus: row.paymentStatus,
          yearHistory: row.yearHistory,
          warnings: rowWarnings,
        },
        status: "imported",
        errorMessage: rowWarnings.length > 0 ? rowWarnings.map((warning) => warning.message).join(" | ") : undefined,
      });

      validRows += 1;
    }

    await completeImportBatch({
      importBatchId: importBatch.id,
      parsedRows: parsed.rows.length,
      validRows,
      errorRows,
      duplicateRows,
    });

    return {
      importBatchId: importBatch.id,
      status: "completed",
      summary: {
        totalRows: parsed.rows.length,
        validRows,
        errorRows,
        duplicateRows,
        parserUsed: parseResolution.parserUsed,
        parserWarnings: parseResolution.parserWarnings,
        companiesCreated,
        companiesUpdated,
        contactsCreated,
        contactsUpdated,
        eventSponsorsCreated,
        eventSponsorsUpdated,
        historyUpserts,
        followUpsCreated,
      },
    };
  } catch (error) {
    await failImportBatch(importBatch.id);
    throw error;
  }
}
