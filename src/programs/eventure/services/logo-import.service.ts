import path from "node:path";
import { prisma } from "../../../core/db/prisma.js";
import { deleteFromR2, isR2Configured, uploadToR2 } from "../../../core/storage/r2.js";
import { EventureServiceError } from "./eventure-error.js";
import { normalizeCompanyName } from "./sponsor-import.service.js";
import { extractLogosFromPdf } from "./pdf-logo-extractor.js";

const ALLOWED_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);

const STRIP_TOKENS = new Set([
  // Logo/brand markers
  "logo", "logos", "brand", "branding", "mark", "icon", "official", "final", "new",
  "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9",
  // Layout/orientation descriptors
  "horizontal", "vertical", "horz", "vert", "stacked", "inline", "square",
  "landscape", "portrait", "transparent", "transparency", "lockup",
  // Technical print/color specs
  "cmyk", "rgb", "rgba", "pms", "pantone", "lettermark", "wordmark",
  "fullcolor", "fullcolour",
  // Quality/resolution
  "high", "res", "resolution", "highres", "hires", "retina",
  // Generic file-naming modifiers
  "primary", "secondary", "full", "color", "colour",
  // Common noise suffixes
  "signature", "registered", "trademark", "approved", "txt", "tag",
  // English stopwords common in logo filenames
  "only", "an", "the", "of", "a",
]);

export type LogoImportPreviewRowStatus =
  | "matched"
  | "unmatched"
  | "conflict_duplicate_match"
  | "invalid_file";

export type LogoImportPreviewRow = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  derivedCompanyName: string;
  normalizedFileName: string;
  status: LogoImportPreviewRowStatus;
  matchedCompanyId?: string;
  matchedCompanyName?: string;
  matchedBy?: "normalized_filename";
  hasExistingLogo?: boolean;
  existingLogoUrl?: string | null;
  warnings: string[];
  errors: string[];
};

export type LogoImportPreviewResponse = {
  eventId: string;
  summary: {
    totalFiles: number;
    matchedRows: number;
    unmatchedRows: number;
    conflictRows: number;
    invalidRows: number;
    existingLogoRows: number;
  };
  rows: LogoImportPreviewRow[];
  availableCompanies: Array<{
    id: string;
    name: string;
    mainEmail: string | null;
    mainPhone: string | null;
    contacts: Array<{ id: string; name: string; email: string | null; isPrimary: boolean }>;
  }>;
};

export type LogoImportDecisionInput = {
  fileName: string;
  decision: "approve" | "skip";
  companyId?: string;
  overwriteExistingLogo?: boolean;
};

export type LogoImportConfirmResponse = {
  eventId: string;
  summary: {
    totalRows: number;
    approvedRows: number;
    skippedRows: number;
    uploadedRows: number;
    overwrittenRows: number;
    failedRows: number;
  };
  rows: Array<{
    fileName: string;
    decision: "approve" | "skip";
    companyId?: string;
    companyName?: string;
    status: "uploaded" | "skipped" | "failed";
    reason?: string;
    logoUrl?: string;
  }>;
};

type CompanyCandidate = {
  id: string;
  name: string;
  normalizedName: string;
  logoUrl: string | null;
  logoKey: string | null;
  mainEmail: string | null;
  mainPhone: string | null;
  contacts: Array<{ id: string; name: string; email: string | null; isPrimary: boolean }>;
};

type PreviewContext = {
  rows: LogoImportPreviewRow[];
  companiesById: Map<string, CompanyCandidate>;
  availableCompanies: Array<{
    id: string;
    name: string;
    mainEmail: string | null;
    mainPhone: string | null;
    contacts: Array<{ id: string; name: string; email: string | null; isPrimary: boolean }>;
  }>;
};

function sanitizeDerivedName(fileName: string): string {
  const withoutExt = path.basename(fileName, path.extname(fileName));
  const processed = withoutExt
    // Strip parenthesized noise: (1), (2), (copy), (High Resolution) …
    .replace(/\([^)]*\)/g, " ")
    // Strip @token suffixes: @2x, @3x
    .replace(/@\S*/g, " ")
    // Strip possessives: Kristina's → Kristina
    .replace(/'\s*s\b/gi, "")
    // Split camelCase: FeldmanLogo → Feldman Logo, MetroWireOnly → Metro Wire Only
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2")
    // Replace common separators with spaces
    .replace(/[_\-.]+/g, " ");

  const tokens = processed
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STRIP_TOKENS.has(t.toLowerCase()))
    // Drop pure numbers (1, 2, 01 …) and resolution suffixes (2x, 3x)
    .filter((t) => !/^\d+$/.test(t) && !/^\d+x$/i.test(t));

  // Drop isolated single-char tokens (R, C, V …) when other tokens remain
  const withoutSingleChars = tokens.length > 1 ? tokens.filter((t) => t.length > 1) : tokens;
  const result = withoutSingleChars.length > 0 ? withoutSingleChars : tokens;

  if (result.length === 0) return withoutExt;
  return result.join(" ");
}

/**
 * A logo-filename-oriented normalization that also treats "and" as equivalent
 * to "&" (both are stripped by normalizeCompanyName which removes non-alpha).
 * This lets "Duke and Duke" match a company stored as "Duke & Duke".
 */
function normalizeLogoKey(value: string): string {
  return normalizeCompanyName(value.replace(/\band\b/gi, "&"));
}

function ensureImageFile(file: Express.Multer.File): string[] {
  const errors: string[] = [];
  if (file.mimetype === "application/pdf") {
    errors.push("No extractable JPEG images found in this PDF. Ensure it contains embedded raster logos.");
  } else if (!ALLOWED_LOGO_TYPES.has(file.mimetype)) {
    errors.push("Unsupported file type. Use JPEG, PNG, GIF, WebP, SVG, or a PDF containing embedded images.");
  }
  if (file.size <= 0) {
    errors.push("File is empty.");
  }
  return errors;
}

/**
 * Build a lookup map keyed by normalizedName (as stored in the DB).
 * Companies created via UI use a simpler normalization (lowercase + trim) while
 * CSV-imported companies use the more aggressive normalizeCompanyName. We handle
 * both by also adding an entry keyed on normalizeCompanyName(company.name) so
 * logo filenames always find a match regardless of creation path.
 */
function mapCompaniesByNormalizedName(companies: CompanyCandidate[]): Map<string, CompanyCandidate> {
  const map = new Map<string, CompanyCandidate>();
  for (const company of companies) {
    // Primary key: whatever is stored in the DB
    if (company.normalizedName && !map.has(company.normalizedName)) {
      map.set(company.normalizedName, company);
    }
    // Fallback: aggressive normalization on the display name
    const aggressive = normalizeCompanyName(company.name);
    if (aggressive && !map.has(aggressive)) {
      map.set(aggressive, company);
    }
    // Fallback: logo-key variant (treats 'and' same as '&')
    const logoKey = normalizeLogoKey(company.name);
    if (logoKey && !map.has(logoKey)) {
      map.set(logoKey, company);
    }
  }
  return map;
}

/**
 * Try to find a company that is a prefix/suffix of the normalized logo filename.
 * e.g. "barton malow transparent" → matches company "barton malow"
 *      "cass lock" → matches company "cass lock contracting services"
 */
function findByPrefixMatch(
  normalizedFileName: string,
  companiesByNormalized: Map<string, CompanyCandidate>,
): CompanyCandidate | undefined {
  // Forward prefix: file key starts with a company key (file is shorter than company name)
  // e.g. "cass lock" starts with company key "cass lock" → not needed (exact), but
  // covers "cass lock" matching "cass lock contracting" if file key = shorter one.
  for (const [key, candidate] of companiesByNormalized) {
    if (key.length >= 5 && normalizedFileName.startsWith(key + " ")) {
      return candidate;
    }
  }

  // Reverse prefix: file key starts with a company key (company shorter than file)
  // e.g. normalizedFileName = "huntington primary stacked…", key = "huntington"
  for (const [key, candidate] of companiesByNormalized) {
    if (key.length >= 5 && normalizedFileName.startsWith(key)) {
      return candidate;
    }
  }

  return undefined;
}

function tokenizeNormalizedName(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 1);
}

function calculateTokenScore(fileTokens: string[], companyTokens: string[]): number {
  if (fileTokens.length === 0 || companyTokens.length === 0) return 0;

  const companyTokenSet = new Set(companyTokens);
  const sharedCount = fileTokens.filter((token) => companyTokenSet.has(token)).length;
  if (sharedCount === 0) return 0;

  const companyCoverage = sharedCount / companyTokens.length;
  const fileCoverage = sharedCount / fileTokens.length;

  // Require a stronger overlap to avoid accidental false positives.
  if (sharedCount < 2 && companyCoverage < 0.9 && fileCoverage < 0.9) return 0;

  return (sharedCount * 20) + (companyCoverage * 100) + (fileCoverage * 50);
}

function findByTokenSimilarityMatch(
  normalizedFileName: string,
  companies: CompanyCandidate[],
): CompanyCandidate | undefined {
  const fileTokens = tokenizeNormalizedName(normalizedFileName);
  if (fileTokens.length === 0) return undefined;

  const scored = companies
    .map((company) => {
      const normalizedCompanyName = normalizeCompanyName(company.name);
      const companyTokens = tokenizeNormalizedName(normalizedCompanyName);
      const score = calculateTokenScore(fileTokens, companyTokens);
      const hasPhraseMatch =
        normalizedFileName.includes(normalizedCompanyName)
        || normalizedCompanyName.includes(normalizedFileName);
      return {
        company,
        score: hasPhraseMatch ? score + 30 : score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return undefined;
  if (scored.length === 1) return scored[0]?.company;

  const top = scored[0];
  const runnerUp = scored[1];
  if (!top) return undefined;
  if (!runnerUp) return top.company;

  // If two candidates are very close, keep it unmatched for user safety.
  if (top.score - runnerUp.score < 8) return undefined;

  return top.company;
}

function summarize(rows: LogoImportPreviewRow[]) {
  const summary = {
    totalFiles: rows.length,
    matchedRows: 0,
    unmatchedRows: 0,
    conflictRows: 0,
    invalidRows: 0,
    existingLogoRows: 0,
  };

  for (const row of rows) {
    if (row.hasExistingLogo) summary.existingLogoRows += 1;
    if (row.status === "matched") summary.matchedRows += 1;
    if (row.status === "unmatched") summary.unmatchedRows += 1;
    if (row.status === "conflict_duplicate_match") summary.conflictRows += 1;
    if (row.status === "invalid_file") summary.invalidRows += 1;
  }

  return summary;
}

async function buildPreviewContext(input: {
  organizationId: string;
  eventId: string;
  files: Express.Multer.File[];
}): Promise<PreviewContext> {
  const event = await prisma.eventureEvent.findFirst({
    where: {
      id: input.eventId,
      organizationId: input.organizationId,
      archivedAt: null,
    },
    select: { id: true },
  });

  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const companies = await prisma.eventureSponsorOrganization.findMany({
    where: {
      organizationId: input.organizationId,
      archivedAt: null,
    },
    select: {
      id: true,
      name: true,
      normalizedName: true,
      logoUrl: true,
      logoKey: true,
      mainEmail: true,
      mainPhone: true,
      contacts: {
        select: {
          id: true,
          name: true,
          email: true,
          isPrimary: true,
        },
      },
    },
  });

  const companiesByNormalized = mapCompaniesByNormalizedName(companies);
  const companiesById = new Map<string, CompanyCandidate>(companies.map((company) => [company.id, company]));

  const availableCompanies = companies.map((company) => ({
    id: company.id,
    name: company.name,
    mainEmail: company.mainEmail,
    mainPhone: company.mainPhone,
    contacts: company.contacts,
  }));

  const rows: LogoImportPreviewRow[] = input.files.map((file) => {
    const fileErrors = ensureImageFile(file);
    const derivedCompanyName = sanitizeDerivedName(file.originalname);
    const normalizedFileName = normalizeCompanyName(derivedCompanyName);

    if (fileErrors.length > 0) {
      return {
        fileName: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
        derivedCompanyName,
        normalizedFileName,
        status: "invalid_file",
        warnings: [],
        errors: fileErrors,
      };
    }

    const company = normalizedFileName
      ? (companiesByNormalized.get(normalizedFileName) ??
         companiesByNormalized.get(normalizeLogoKey(derivedCompanyName)) ??
        findByPrefixMatch(normalizedFileName, companiesByNormalized) ??
        findByTokenSimilarityMatch(normalizedFileName, companies))
      : undefined;

    if (!company) {
      return {
        fileName: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
        derivedCompanyName,
        normalizedFileName,
        status: "unmatched",
        warnings: ["No company matched this filename."],
        errors: [],
      };
    }

    return {
      fileName: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      derivedCompanyName,
      normalizedFileName,
      status: "matched",
      matchedCompanyId: company.id,
      matchedCompanyName: company.name,
      matchedBy: "normalized_filename",
      hasExistingLogo: Boolean(company.logoUrl),
      existingLogoUrl: company.logoUrl,
      warnings: [],
      errors: [],
    };
  });

  const companyFileCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.matchedCompanyId || row.status !== "matched") continue;
    companyFileCounts.set(row.matchedCompanyId, (companyFileCounts.get(row.matchedCompanyId) ?? 0) + 1);
  }

  for (const row of rows) {
    if (!row.matchedCompanyId || row.status !== "matched") continue;
    if ((companyFileCounts.get(row.matchedCompanyId) ?? 0) > 1) {
      row.status = "conflict_duplicate_match";
      row.warnings.push("Multiple files matched the same company. Pick exactly one file for this company.");
    }
  }

  return { rows, companiesById, availableCompanies };
}

async function preProcessFilesForLogoImport(
  files: Express.Multer.File[],
): Promise<Express.Multer.File[]> {
  const result: Express.Multer.File[] = [];

  for (const file of files) {
    if (file.mimetype !== "application/pdf") {
      result.push(file);
      continue;
    }

    const extraction = await extractLogosFromPdf(file.buffer, file.originalname);

    if (extraction.images.length === 0) {
      // Keep the original PDF so ensureImageFile produces a clear invalid_file row.
      result.push(file);
      continue;
    }

    // Replace the PDF with its extracted images.
    for (const img of extraction.images) {
      result.push({
        fieldname: file.fieldname,
        originalname: img.fileName,
        encoding: "7bit",
        mimetype: img.mimeType,
        buffer: img.buffer,
        size: img.buffer.length,
      } as Express.Multer.File);
    }
  }

  return result;
}

export async function previewLogoImportForEvent(input: {
  organizationId: string;
  eventId: string;
  files: Express.Multer.File[];
}): Promise<LogoImportPreviewResponse> {
  if (!input.files || input.files.length === 0) {
    throw new EventureServiceError("Provide one or more image files.", 400);
  }

  const processedFiles = await preProcessFilesForLogoImport(input.files);
  const context = await buildPreviewContext({ ...input, files: processedFiles });

  return {
    eventId: input.eventId,
    summary: summarize(context.rows),
    rows: context.rows,
    availableCompanies: context.availableCompanies,
  };
}

export async function confirmLogoImportForEvent(input: {
  organizationId: string;
  eventId: string;
  actorUserId: string;
  files: Express.Multer.File[];
  decisions?: LogoImportDecisionInput[];
}): Promise<LogoImportConfirmResponse> {
  if (!input.files || input.files.length === 0) {
    throw new EventureServiceError("Provide one or more image files.", 400);
  }

  const processedFiles = await preProcessFilesForLogoImport(input.files);
  const context = await buildPreviewContext({ ...input, files: processedFiles });
  const filesByName = new Map<string, Express.Multer.File>();

  for (const file of processedFiles) {
    if (!filesByName.has(file.originalname)) {
      filesByName.set(file.originalname, file);
    }
  }

  const decisionsByFile = new Map<string, LogoImportDecisionInput>();
  for (const decision of input.decisions ?? []) {
    decisionsByFile.set(decision.fileName, decision);
  }

  const summary = {
    totalRows: context.rows.length,
    approvedRows: 0,
    skippedRows: 0,
    uploadedRows: 0,
    overwrittenRows: 0,
    failedRows: 0,
  };

  const results: LogoImportConfirmResponse["rows"] = [];

  for (const row of context.rows) {
    const decision = decisionsByFile.get(row.fileName);
    const rowDecision = decision?.decision ?? (row.status === "matched" ? "approve" : "skip");

    if (rowDecision === "skip") {
      summary.skippedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "skip",
        companyId: decision?.companyId ?? row.matchedCompanyId,
        companyName: row.matchedCompanyName,
        status: "skipped",
      });
      continue;
    }

    summary.approvedRows += 1;

    const file = filesByName.get(row.fileName);
    if (!file) {
      summary.failedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "approve",
        status: "failed",
        reason: "File data was not provided for this row.",
      });
      continue;
    }

    const companyId = decision?.companyId ?? row.matchedCompanyId;
    if (!companyId) {
      summary.failedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "approve",
        status: "failed",
        reason: "A company selection is required before approval.",
      });
      continue;
    }

    const company = context.companiesById.get(companyId);
    if (!company) {
      summary.failedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "approve",
        companyId,
        status: "failed",
        reason: "Company not found in this organization.",
      });
      continue;
    }

    const overwriteExistingLogo = Boolean(decision?.overwriteExistingLogo);
    if (company.logoUrl && !overwriteExistingLogo) {
      summary.failedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "approve",
        companyId: company.id,
        companyName: company.name,
        status: "failed",
        reason: "Company already has a logo. Enable overwrite to replace it.",
      });
      continue;
    }

    try {
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      const key = `eventure/${input.organizationId}/sponsors/${company.id}/logo-${Date.now()}${ext}`;

      let logoUrl: string;
      let logoKey: string;

      if (isR2Configured()) {
        if (company.logoKey) {
          await deleteFromR2(company.logoKey).catch(() => void 0);
        }
        const uploadResult = await uploadToR2(key, file.buffer, file.mimetype);
        // Store the raw key as logoUrl so resolveLogoUrl can always generate a signed URL.
        logoUrl = uploadResult.key;
        logoKey = uploadResult.key;
      } else {
        logoUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
        logoKey = key;
      }

      await prisma.eventureSponsorOrganization.update({
        where: { id: company.id },
        data: {
          logoUrl,
          logoKey,
          updatedAt: new Date(),
          sourceImportBatchId: null,
        },
      });

      company.logoUrl = logoUrl;
      company.logoKey = logoKey;

      summary.uploadedRows += 1;
      if (overwriteExistingLogo) {
        summary.overwrittenRows += 1;
      }

      results.push({
        fileName: row.fileName,
        decision: "approve",
        companyId: company.id,
        companyName: company.name,
        status: "uploaded",
        logoUrl,
      });
    } catch (error) {
      summary.failedRows += 1;
      results.push({
        fileName: row.fileName,
        decision: "approve",
        companyId: company.id,
        companyName: company.name,
        status: "failed",
        reason: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  }

  return {
    eventId: input.eventId,
    summary,
    rows: results,
  };
}
