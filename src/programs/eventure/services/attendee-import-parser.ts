import XLSX from "xlsx";
import { cleanCell, normalizeCompanyName, normalizeHeaders } from "./sponsor-import.service.js";

export type AttendeeImportRowStatus = "valid" | "warning" | "error" | "duplicate";
export type AttendeeCompanyMatchStatus = "Matched" | "Possible Match" | "Unmatched" | "New Company Suggested";

export type ParsedAttendeeImportRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  ticketBuyer?: string;
  ticketBuyerEmail?: string;
  ticketType?: string;
  eventName?: string;
  orderDate?: string;
  checkedIn?: boolean;
  explicitFlight?: "AM" | "PM";
  flightAssignment: "AM" | "PM";
  status: AttendeeImportRowStatus;
  warnings: string[];
  errors: string[];
};

const HEADER_ALIASES = {
  attendeeName: ["attendee name", "full name", "attendee", "name", "registrant"],
  attendeeFirstName: ["attendee first", "first name", "registrant first"],
  attendeeLastName: ["attendee last", "last name", "registrant last"],
  attendeeEmail: ["attendee email", "email", "email address"],
  attendeePhone: ["attendee phone", "phone", "mobile"],
  ticketBuyer: ["ticket buyer", "buyer", "purchaser", "company", "company name"],
  ticketBuyerEmail: ["ticket buyer email", "buyer email", "purchaser email", "billing email"],
  ticketType: ["ticket type", "registration type", "type", "package", "registration"],
  eventName: ["event name", "event"],
  orderDate: ["order date", "purchase date", "date", "order created"],
  checkedIn: ["checked in", "check in"],
  flight: ["flight", "flight assignment", "am/pm", "wave", "tee time"],
} as const;

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const cleaned = cleanCell(value);
    return cleaned || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function normalizeEmail(value?: string): string | undefined {
  if (!value) return undefined;
  const next = value.trim().toLowerCase();
  return next || undefined;
}

export function normalizeName(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value
    .trim()
    .replace(/\s+/g, " ");
  return compact || undefined;
}

export function cleanPhone(value?: string): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D+/g, "");
  if (digits.length === 0) return undefined;
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

function truthy(value?: string): boolean {
  if (!value) return false;
  const lowered = value.trim().toLowerCase();
  return lowered === "true" || lowered === "yes" || lowered === "y" || lowered === "1" || lowered === "checked in";
}

export function detectFlight(input: {
  explicitFlight?: "AM" | "PM";
  ticketType?: string;
  eventName?: string;
  ticketBuyer?: string;
  attendeeEmail?: string;
}): "AM" | "PM" {
  if (input.explicitFlight === "AM" || input.explicitFlight === "PM") {
    return input.explicitFlight;
  }

  const ticketType = (input.ticketType ?? "").toLowerCase();
  const eventName = (input.eventName ?? "").toLowerCase();
  const ticketBuyer = normalizeCompanyName(input.ticketBuyer ?? "");
  const attendeeEmail = (input.attendeeEmail ?? "").toLowerCase();

  if (ticketType.includes("am")) return "AM";
  if (ticketType.includes("pm")) return "PM";
  if (eventName.includes("am")) return "AM";
  if (eventName.includes("pm")) return "PM";
  if (ticketBuyer.includes("dte") || attendeeEmail.includes("@dte")) return "AM";
  return "PM";
}

function parseFlightValue(value?: string): "AM" | "PM" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("am")) return "AM";
  if (normalized.includes("pm")) return "PM";
  return undefined;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
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
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const grid = lines.map((line) => parseCsvLine(line));
  return parseSheetRows(grid as unknown[][]);
}

function scoreHeaderRow(headers: string[]): number {
  const normalized = normalizeHeaders(headers).map((header) => header.toLowerCase().trim());
  let score = 0;
  for (const aliases of Object.values(HEADER_ALIASES)) {
    const hasMatch = aliases.some((alias) => {
      const escapedAlias = alias.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenPattern = new RegExp(`(^|[^a-z0-9])${escapedAlias}([^a-z0-9]|$)`, "i");
      return normalized.some((header) => tokenPattern.test(header));
    });
    if (hasMatch) {
      score += 1;
    }
  }
  return score;
}

function parseSheetRows(grid: unknown[][]): { headers: string[]; rows: string[][]; headerScore: number } {
  if (grid.length === 0) return { headers: [], rows: [], headerScore: 0 };

  let bestHeaderIndex = -1;
  let bestHeaderScore = 0;
  const scanLimit = Math.min(grid.length, 40);

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const candidate = (grid[rowIndex] ?? []).map((cell) => toStringValue(cell) ?? "").map((cell) => cell.trim());
    if (candidate.length === 0) continue;
    const nonEmptyCount = candidate.filter((cell) => cell.length > 0).length;
    if (nonEmptyCount < 2) continue;

    const score = scoreHeaderRow(candidate);
    if (score > bestHeaderScore) {
      bestHeaderScore = score;
      bestHeaderIndex = rowIndex;
    }
  }

  const hasConfidentHeader = bestHeaderScore >= 2;
  if (!hasConfidentHeader) {
    const maxColumns = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const headers = Array.from({ length: maxColumns }, (_, index) => `column_${index + 1}`);
    const rows = grid
      .map((row) => row.map((cell) => toStringValue(cell) ?? ""))
      .filter((row) => row.some((cell) => cell.trim().length > 0));
    return { headers, rows, headerScore: 0 };
  }

  const headerIndex = bestHeaderIndex >= 0 ? bestHeaderIndex : 0;
  const headers = (grid[headerIndex] ?? []).map((cell) => toStringValue(cell) ?? "");
  const rows = grid
    .slice(headerIndex + 1)
    .map((row) => row.map((cell) => toStringValue(cell) ?? ""))
    .filter((row) => row.some((cell) => cell.trim().length > 0));

  return { headers, rows, headerScore: bestHeaderScore };
}

function parseWorkbook(buffer: Buffer): { headers: string[]; rows: string[][] } {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  if (workbook.SheetNames.length === 0) return { headers: [], rows: [] };

  let best: { headers: string[]; rows: string[][]; headerScore: number } | null = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
    const parsed = parseSheetRows(grid);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) continue;

    if (
      !best
      || parsed.headerScore > best.headerScore
      || (parsed.headerScore === best.headerScore && parsed.rows.length > best.rows.length)
    ) {
      best = parsed;
    }
  }

  if (!best) {
    const fallbackSheet = workbook.Sheets[workbook.SheetNames[0] as string];
    if (!fallbackSheet) return { headers: [], rows: [] };
    const fallbackGrid = XLSX.utils.sheet_to_json(fallbackSheet, { header: 1, raw: false }) as unknown[][];
    const fallback = parseSheetRows(fallbackGrid);
    return { headers: fallback.headers, rows: fallback.rows };
  }

  return { headers: best.headers, rows: best.rows };
}

function resolveHeaderIndex(headers: string[]): Record<string, number | undefined> {
  const normalized = normalizeHeaders(headers).map((header) => header.toLowerCase().trim());
  const find = (aliases: string[]): number | undefined => {
    for (const alias of aliases) {
      const escapedAlias = alias.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenPattern = new RegExp(`(^|[^a-z0-9])${escapedAlias}([^a-z0-9]|$)`, "i");
      const index = normalized.findIndex((item) => tokenPattern.test(item));
      if (index >= 0) return index;
    }
    return undefined;
  };

  return {
    attendeeName: find([...HEADER_ALIASES.attendeeName]),
    attendeeFirstName: find([...HEADER_ALIASES.attendeeFirstName]),
    attendeeLastName: find([...HEADER_ALIASES.attendeeLastName]),
    attendeeEmail: find([...HEADER_ALIASES.attendeeEmail]),
    attendeePhone: find([...HEADER_ALIASES.attendeePhone]),
    ticketBuyer: find([...HEADER_ALIASES.ticketBuyer]),
    ticketBuyerEmail: find([...HEADER_ALIASES.ticketBuyerEmail]),
    ticketType: find([...HEADER_ALIASES.ticketType]),
    eventName: find([...HEADER_ALIASES.eventName]),
    orderDate: find([...HEADER_ALIASES.orderDate]),
    checkedIn: find([...HEADER_ALIASES.checkedIn]),
    flight: find([...HEADER_ALIASES.flight]),
  };
}

function isLikelyEmail(value?: string): boolean {
  if (!value) return false;
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value.trim());
}

function isLikelyPhone(value?: string): boolean {
  if (!value) return false;
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function isLikelyPersonName(value?: string): boolean {
  if (!value) return false;
  const compact = value.trim();
  if (compact.length < 4 || compact.length > 60) return false;
  if (/\d/.test(compact)) return false;
  if (/[@]/.test(compact)) return false;
  if (/flight|foursome|sponsor|event|classic|presented/i.test(compact)) return false;
  const parts = compact.split(/\s+/).filter(Boolean);
  return parts.length >= 2;
}

function isLikelyCompany(value?: string): boolean {
  if (!value) return false;
  const compact = value.trim();
  if (compact.length < 2) return false;
  if (/[@]/.test(compact)) return false;
  return /\b(inc|llc|ltd|corp|corporation|company|co\.|group|energy|bank|systems|partners|foundation|services)\b/i.test(compact)
    || /[A-Z]{2,}/.test(compact);
}

function isLikelyTicketType(value?: string): boolean {
  if (!value) return false;
  return /flight|foursome|ticket|registration|sponsor|package|am|pm/i.test(value);
}

function isLikelyEventName(value?: string): boolean {
  if (!value) return false;
  return /annual|classic|tournament|event|golf|open/i.test(value);
}

function isLikelyDate(value?: string): boolean {
  if (!value) return false;
  return /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(value) || /\b\d{4}-\d{2}-\d{2}\b/.test(value);
}

function inferHeaderIndexFromRows(rows: string[][]): Partial<Record<string, number>> {
  if (rows.length === 0) return {};
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const scoreByColumn = Array.from({ length: maxColumns }, () => ({
    attendeeName: 0,
    attendeeEmail: 0,
    attendeePhone: 0,
    ticketBuyer: 0,
    ticketType: 0,
    eventName: 0,
    orderDate: 0,
  }));

  for (const row of rows.slice(0, 60)) {
    for (let column = 0; column < maxColumns; column += 1) {
      const value = cleanCell(row[column]);
      if (!value) continue;
      if (isLikelyEmail(value)) scoreByColumn[column].attendeeEmail += 3;
      if (isLikelyPhone(value)) scoreByColumn[column].attendeePhone += 3;
      if (isLikelyPersonName(value)) scoreByColumn[column].attendeeName += 2;
      if (isLikelyCompany(value)) scoreByColumn[column].ticketBuyer += 2;
      if (isLikelyTicketType(value)) scoreByColumn[column].ticketType += 2;
      if (isLikelyEventName(value)) scoreByColumn[column].eventName += 2;
      if (isLikelyDate(value)) scoreByColumn[column].orderDate += 1;
    }
  }

  const pickBest = (field: keyof (typeof scoreByColumn)[number], minimum: number): number | undefined => {
    let bestIndex = -1;
    let bestScore = minimum;
    for (let i = 0; i < scoreByColumn.length; i += 1) {
      const candidateScore = scoreByColumn[i][field];
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestIndex = i;
      }
    }
    return bestIndex >= 0 ? bestIndex : undefined;
  };

  return {
    attendeeName: pickBest("attendeeName", 1),
    attendeeEmail: pickBest("attendeeEmail", 1),
    attendeePhone: pickBest("attendeePhone", 1),
    ticketBuyer: pickBest("ticketBuyer", 1),
    ticketType: pickBest("ticketType", 1),
    eventName: pickBest("eventName", 1),
    orderDate: pickBest("orderDate", 0),
  };
}

function getCell(row: string[], index: number | undefined): string | undefined {
  if (index === undefined || index < 0 || index >= row.length) return undefined;
  const value = cleanCell(row[index]);
  return value || undefined;
}

export function parseCsvOrXlsx(input: {
  csvContent?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
}): { rows: ParsedAttendeeImportRow[]; columnMapping: Array<{ sourceColumn: string; normalizedColumn: string; target: string; confidence: number }> } {
  const parsed = input.csvContent
    ? parseCsv(input.csvContent)
    : input.fileBuffer
      ? parseWorkbook(input.fileBuffer)
      : { headers: [], rows: [] };

  if (parsed.headers.length === 0) {
    return { rows: [], columnMapping: [] };
  }

  const mapping = resolveHeaderIndex(parsed.headers);
  const mappedCount = Object.values(mapping).filter((value) => value !== undefined).length;
  const inferred: Partial<ReturnType<typeof resolveHeaderIndex>> = mappedCount >= 2
    ? {}
    : inferHeaderIndexFromRows(parsed.rows);
  const resolvedMapping: ReturnType<typeof resolveHeaderIndex> = {
    ...mapping,
    ...inferred,
  };

  resolvedMapping.attendeeName = mapping.attendeeName ?? inferred.attendeeName;
  resolvedMapping.attendeeEmail = mapping.attendeeEmail ?? inferred.attendeeEmail;
  resolvedMapping.attendeePhone = mapping.attendeePhone ?? inferred.attendeePhone;
  resolvedMapping.ticketBuyer = mapping.ticketBuyer ?? inferred.ticketBuyer;
  resolvedMapping.ticketType = mapping.ticketType ?? inferred.ticketType;
  resolvedMapping.eventName = mapping.eventName ?? inferred.eventName;
  resolvedMapping.orderDate = mapping.orderDate ?? inferred.orderDate;

  const rows: ParsedAttendeeImportRow[] = parsed.rows.map((row, rowIndex) => {
    const attendeeFirstName = normalizeName(getCell(row, resolvedMapping.attendeeFirstName));
    const attendeeLastName = normalizeName(getCell(row, resolvedMapping.attendeeLastName));
    const attendeeName = normalizeName(getCell(row, resolvedMapping.attendeeName))
      ?? normalizeName([attendeeFirstName, attendeeLastName].filter(Boolean).join(" "));
    const attendeeEmail = normalizeEmail(getCell(row, resolvedMapping.attendeeEmail));
    const attendeePhone = cleanPhone(getCell(row, resolvedMapping.attendeePhone));
    const ticketBuyer = normalizeName(getCell(row, resolvedMapping.ticketBuyer));
    const ticketBuyerEmail = normalizeEmail(getCell(row, resolvedMapping.ticketBuyerEmail));
    const ticketType = normalizeName(getCell(row, resolvedMapping.ticketType));
    const eventName = normalizeName(getCell(row, resolvedMapping.eventName));
    const orderDate = getCell(row, resolvedMapping.orderDate);
    const checkedIn = truthy(getCell(row, resolvedMapping.checkedIn));
    const explicitFlight = parseFlightValue(getCell(row, resolvedMapping.flight));

    const warnings: string[] = [];
    const errors: string[] = [];
    let status: AttendeeImportRowStatus = "valid";

    if (!attendeeName) {
      warnings.push("Missing attendee name.");
      status = "warning";
    }

    if (!attendeeEmail) {
      warnings.push("Missing attendee email.");
      status = "warning";
    }

    if (!attendeeEmail && !attendeePhone) {
      warnings.push("Attendee email or phone is missing.");
      if (!attendeeName && !ticketBuyer) {
        errors.push("Attendee identity fields are missing.");
        status = "error";
      }
    }

    const flightAssignment = detectFlight({
      explicitFlight,
      ticketType,
      eventName,
      ticketBuyer,
      attendeeEmail,
    });

    return {
      rowNumber: rowIndex + 1,
      raw: Object.fromEntries(parsed.headers.map((header, index) => [header, row[index] ?? null])),
      attendeeName,
      attendeeEmail,
      attendeePhone,
      ticketBuyer,
      ticketBuyerEmail,
      ticketType,
      eventName,
      orderDate,
      checkedIn,
      explicitFlight,
      flightAssignment,
      warnings,
      errors,
      status,
    };
  });

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.attendeeEmail ?? ""}::${row.ticketType ?? ""}`;
    if (!row.attendeeEmail || !row.ticketType) continue;
    if (seen.has(key)) {
      row.status = "duplicate";
      row.warnings.push("Duplicate attendee email and ticket type in file.");
      continue;
    }
    seen.add(key);
  }

  const columnMapping = Object.entries(resolvedMapping)
    .filter(([, value]) => value !== undefined)
    .map(([target, index]) => {
      const sourceColumn = parsed.headers[index as number] ?? target;
      return {
        sourceColumn,
        normalizedColumn: sourceColumn.trim().toLowerCase(),
        target,
        confidence: 0.92,
      };
    });

  return { rows, columnMapping };
}
