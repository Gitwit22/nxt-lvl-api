type EmployeeRecordIntakeInput = {
  originalFilename: string;
  relativePath?: string | null;
};

export type EmployeeRecordIntakeResult = {
  personName: string | null;
  year: number | null;
  date: string | null;
  needsReview: boolean;
  tags: string[];
};

const GENERIC_NAME_PATTERNS = [
  /^scan\d*$/i,
  /^document\d*$/i,
  /^paperwork\d*$/i,
  /^form\d*$/i,
  /^file\d*$/i,
  /^record\d*$/i,
  /^employee\s*record\d*$/i,
  /^background\s*check\d*$/i,
];

const TRAILING_DOC_WORDS = [
  "employee record",
  "record",
  "background check",
  "application",
  "paperwork",
  "form",
  "scan",
  "document",
  "copy",
];

const YEAR_TOKEN = /(19\d{2}|20\d{2})/g;
const DATE_TOKEN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-](?:19\d{2}|20\d{2}))\b/g;

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSeparatorsForPath(value: string): string[] {
  return value
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseYear(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1900 || parsed > 2099) return null;
  return parsed;
}

function extractYearFromText(text: string): number | null {
  const matches = text.match(YEAR_TOKEN);
  if (!matches || matches.length === 0) return null;
  for (const raw of matches) {
    const year = parseYear(raw);
    if (year) return year;
  }
  return null;
}

function extractDateFromText(text: string): string | null {
  const match = text.match(DATE_TOKEN);
  if (!match || match.length === 0) return null;
  return match[0] ?? null;
}

function removeDateTokens(value: string): string {
  return value.replace(DATE_TOKEN, " ").replace(YEAR_TOKEN, " ");
}

function trimTrailingDocWords(value: string): string {
  let result = value.trim();
  let changed = true;

  while (changed && result.length > 0) {
    changed = false;
    const lowered = result.toLowerCase();
    for (const token of TRAILING_DOC_WORDS) {
      if (lowered.endsWith(token)) {
        result = result.slice(0, result.length - token.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isGenericName(value: string | null): boolean {
  if (!value) return true;
  const collapsed = value.toLowerCase().replace(/\s+/g, "").trim();
  if (!collapsed) return true;
  return GENERIC_NAME_PATTERNS.some((pattern) => pattern.test(collapsed));
}

function cleanCandidateName(raw: string): string | null {
  const normalized = normalizeWhitespace(raw);
  const withoutDates = normalizeWhitespace(removeDateTokens(normalized));
  const trimmed = normalizeWhitespace(trimTrailingDocWords(withoutDates));
  if (!trimmed) return null;
  return toTitleCase(trimmed);
}

function pickPersonNameFromPath(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  const segments = normalizeSeparatorsForPath(relativePath);
  if (segments.length <= 1) return null;

  const parentSegments = segments.slice(0, -1);
  for (let i = parentSegments.length - 1; i >= 0; i -= 1) {
    const segment = parentSegments[i];
    if (parseYear(segment) !== null) continue;
    const cleaned = cleanCandidateName(segment);
    if (!isGenericName(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

function detectPathYear(relativePath: string | null | undefined): number | null {
  if (!relativePath) return null;
  const segments = normalizeSeparatorsForPath(relativePath);
  if (segments.length === 0) return null;

  // Prefer nearest parent folder year.
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const year = parseYear(segments[i]);
    if (year !== null) return year;
    const extracted = extractYearFromText(segments[i]);
    if (extracted !== null) return extracted;
  }

  for (const segment of segments) {
    const extracted = extractYearFromText(segment);
    if (extracted !== null) return extracted;
  }

  return null;
}

export function deriveEmployeeRecordIntake(input: EmployeeRecordIntakeInput): EmployeeRecordIntakeResult {
  const baseName = stripExtension(input.originalFilename);
  const filenameYear = extractYearFromText(baseName);
  const pathYear = detectPathYear(input.relativePath);
  const year = filenameYear ?? pathYear;

  const filenameDate = extractDateFromText(baseName);
  const pathDate = input.relativePath ? extractDateFromText(input.relativePath) : null;
  const date = filenameDate ?? pathDate;

  const filenameName = cleanCandidateName(baseName);
  const fallbackName = pickPersonNameFromPath(input.relativePath);
  const personName = !isGenericName(filenameName)
    ? filenameName
    : !isGenericName(fallbackName)
      ? fallbackName
      : null;

  const needsReview = personName === null;
  const tags = [
    "employee_record",
    "auto_labeled",
    "ocr_skipped",
    ...(year !== null ? [String(year), "year_detected"] : []),
  ];

  return {
    personName,
    year,
    date,
    needsReview,
    tags: [...new Set(tags)],
  };
}
