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

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { headers, rows };
}

function parseSheetRows(grid: unknown[][]): { headers: string[]; rows: string[][] } {
  if (grid.length === 0) return { headers: [], rows: [] };
  const headers = (grid[0] ?? []).map((cell) => toStringValue(cell) ?? "");
  const rows = grid.slice(1).map((row) => row.map((cell) => toStringValue(cell) ?? ""));
  return { headers, rows };
}

function parseWorkbook(buffer: Buffer): { headers: string[]; rows: string[][] } {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[firstSheetName];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
  return parseSheetRows(grid);
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
    attendeeName: find(["attendee name", "name", "full name", "attendee"]),
    attendeeEmail: find(["attendee email", "email"]),
    attendeePhone: find(["attendee phone", "phone"]),
    ticketBuyer: find(["ticket buyer", "buyer", "company"]),
    ticketBuyerEmail: find(["ticket buyer email", "buyer email", "purchaser email"]),
    ticketType: find(["ticket type", "registration type", "type"]),
    eventName: find(["event name", "event"]),
    orderDate: find(["order date", "purchase date", "date"]),
    checkedIn: find(["checked in", "check in"]),
    flight: find(["flight", "flight assignment", "am/pm", "wave", "tee time"]),
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
    const attendeeName = normalizeName(getCell(row, mapping.attendeeName));
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
