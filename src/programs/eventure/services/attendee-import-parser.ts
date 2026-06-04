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
  attendeePhone: ["attendee phone", "phone", "mobile", "cell"],
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
  const normalized = normalizeHeaders(headers);
  let score = 0;
  for (const aliases of Object.values(HEADER_ALIASES)) {
    const hasMatch = aliases.some((alias) => normalized.some((header) => header.includes(alias)));
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
  const normalized = normalizeHeaders(headers);
  const find = (aliases: string[]): number | undefined => {
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase();
      const index = normalized.findIndex((item) => item.includes(normalizedAlias));
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
  const rows: ParsedAttendeeImportRow[] = parsed.rows.map((row, rowIndex) => {
    const attendeeFirstName = normalizeName(getCell(row, mapping.attendeeFirstName));
    const attendeeLastName = normalizeName(getCell(row, mapping.attendeeLastName));
    const attendeeName = normalizeName(getCell(row, mapping.attendeeName))
      ?? normalizeName([attendeeFirstName, attendeeLastName].filter(Boolean).join(" "));
    const attendeeEmail = normalizeEmail(getCell(row, mapping.attendeeEmail));
    const attendeePhone = cleanPhone(getCell(row, mapping.attendeePhone));
    const ticketBuyer = normalizeName(getCell(row, mapping.ticketBuyer));
    const ticketBuyerEmail = normalizeEmail(getCell(row, mapping.ticketBuyerEmail));
    const ticketType = normalizeName(getCell(row, mapping.ticketType));
    const eventName = normalizeName(getCell(row, mapping.eventName));
    const orderDate = getCell(row, mapping.orderDate);
    const checkedIn = truthy(getCell(row, mapping.checkedIn));
    const explicitFlight = parseFlightValue(getCell(row, mapping.flight));

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
      errors.push("Attendee email or phone is required.");
      status = "error";
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

  const columnMapping = Object.entries(mapping)
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
