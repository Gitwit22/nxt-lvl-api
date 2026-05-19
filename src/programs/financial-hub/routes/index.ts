import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import multer from "multer";
import jwt from "jsonwebtoken";
import path from "path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../core/db/prisma.js";
import {
  DEFAULT_ORGANIZATION_ID,
  FINANCE_HUB_DOCUMENT_MAX_UPLOAD_BYTES,
  FINANCE_HUB_DOCUMENT_MAX_UPLOAD_MB,
  JWT_EXPIRES_IN,
  JWT_SECRET,
} from "../../../core/config/env.js";
import { hashPassword, signToken } from "../../../core/auth/auth.service.js";
import { resolveStorageAdapter } from "../../../core/storage/storageResolver.js";
import { logger } from "../../../logger.js";
import { taxIdentityRouter } from "./taxIdentity.routes.js";

const router = express.Router();

const FINANCIAL_HUB_PROGRAM_DOMAIN = "financial-hub";
const FINANCE_STATUS_VALUES = new Set([
  "received",
  "validation_pending",
  "needs_correction",
  "finance_ready",
  "exported",
  "posted",
  "archived",
]);
const SOURCE_APP_VALUES = new Set(["time-flow", "mission-hub", "manual"]);
const SOURCE_RECORD_TYPE_VALUES = new Set([
  "timesheet",
  "expense",
  "income",
  "cash_disbursement",
  "invoice",
  "event",
]);
const FINANCE_HUB_DOCUMENT_FOLDERS = new Set(["general", "test"]);
const FINANCE_HUB_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);
const FINANCE_HUB_ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
]);
const FINANCE_HUB_SIGNED_URL_TTL_SECONDS = 15 * 60;
const FINANCE_HUB_RESTRICTED_SIGNED_URL_TTL_SECONDS = 5 * 60;
const RECEIPT_ANALYZE_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const RECEIPT_ANALYZE_ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);
const DATA_CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);
const FINANCE_STATE_PROGRAM_DOMAIN = `${FINANCIAL_HUB_PROGRAM_DOMAIN}:state`;
const FINANCE_STATE_MAX_BYTES = 1024 * 1024; // 1MB safety cap per org snapshot
const FINANCE_STATE_ALLOWED_KEYS = new Set([
  "fcc_guided_task_runs",
  "fcc_generated_forms",
  "fcc_export_records",
  "fcc_export_templates",
  "fcc_transactions",
  "fcc_deposits",
  "fcc_grants",
  "fcc_review_queue",
  "fcc_month_close",
  "fcc_payroll_intake",
  "fcc_payees",
  "fcc_bank_accounts",
  "fcc_opening_balance_corrections",
  "fcc_account_adjustments",
  "fcc_account_reconciliations",
  "fcc_mock_data_purged",
]);

type DataClassification = "public" | "internal" | "confidential" | "restricted";
type FinanceHubNormalizedRole =
  | "owner_admin"
  | "finance_manager"
  | "bookkeeper_data_entry"
  | "reviewer_auditor"
  | "staff_uploader"
  | "external_accountant";

const financeHubUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FINANCE_HUB_DOCUMENT_MAX_UPLOAD_BYTES },
});

const DEFAULT_CAPABILITIES = {
  canManageFinanceSettings: true,
  canReviewFinanceIntake: true,
  canApproveFinanceReady: true,
  canExportFinanceData: true,
  canManageUsers: true,
  canViewReports: true,
  canManageOrganization: true,
};

type FinancialHubTokenPayload = {
  userId: string;
  email: string;
  role: string;
  platformRole?: string;
  mfaVerified?: boolean;
  organizationId: string;
  programDomain: string;
};

type PrismaWithFinancialHub = typeof prisma & {
  financialHubUserProfile: {
    count: (args?: Record<string, unknown>) => Promise<number>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  financeIntakeRecord: {
    findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    groupBy: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    aggregate: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  financeHubDocument: {
    findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

const prismaFinancial = prisma as PrismaWithFinancialHub;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseFinanceFolder(value: unknown, options?: { defaultToGeneral?: boolean }): "general" | "test" | null {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) {
    return options?.defaultToGeneral ? "general" : null;
  }
  if (raw === "all") {
    return null;
  }
  if (raw === "general" || raw === "test") {
    return raw;
  }
  return null;
}

function normalizeClassification(value: unknown, defaultValue: DataClassification): DataClassification {
  const normalized = normalizeString(value).toLowerCase();
  if (DATA_CLASSIFICATIONS.has(normalized)) {
    return normalized as DataClassification;
  }
  return defaultValue;
}

function parseClassificationFromR2Key(r2Key: unknown): DataClassification {
  if (typeof r2Key !== "string") return "confidential";
  const parts = r2Key.split("/").filter(Boolean);
  const maybeClassification = parts[3]?.toLowerCase();
  if (maybeClassification && DATA_CLASSIFICATIONS.has(maybeClassification)) {
    return maybeClassification as DataClassification;
  }
  return "confidential";
}

function normalizeFinanceHubRole(rawRole: string): FinanceHubNormalizedRole {
  const normalized = rawRole.trim().toLowerCase();

  if (["admin", "owner", "finance admin", "owner/admin"].includes(normalized)) {
    return "owner_admin";
  }
  if (["finance manager", "finance coordinator"].includes(normalized)) {
    return "finance_manager";
  }
  if (["bookkeeper", "data entry", "bookkeeper/data entry"].includes(normalized)) {
    return "bookkeeper_data_entry";
  }
  if (["external accountant"].includes(normalized)) {
    return "external_accountant";
  }
  if (["staff", "staff/uploader", "uploader"].includes(normalized)) {
    return "staff_uploader";
  }
  if (
    ["reviewer", "auditor", "reviewer/auditor", "executive reviewer", "cpa reviewer", "read only leadership"].includes(normalized)
  ) {
    return "reviewer_auditor";
  }

  return "staff_uploader";
}

function roleCanAccessRestricted(role: FinanceHubNormalizedRole): boolean {
  return ["owner_admin", "finance_manager", "reviewer_auditor", "external_accountant"].includes(role);
}

function hasFinancePermission(
  role: FinanceHubNormalizedRole,
  permission:
    | "manage_security"
    | "manage_settings"
    | "upload_documents"
    | "view_documents"
    | "delete_documents"
    | "create_intake"
    | "review_intake"
    | "approve_intake"
    | "view_reports"
    | "view_exports",
): boolean {
  switch (permission) {
    case "manage_security":
    case "manage_settings":
      return role === "owner_admin";
    case "upload_documents":
      return ["owner_admin", "finance_manager", "bookkeeper_data_entry", "staff_uploader"].includes(role);
    case "view_documents":
      return ["owner_admin", "finance_manager", "bookkeeper_data_entry", "reviewer_auditor", "external_accountant"].includes(role);
    case "delete_documents":
      return ["owner_admin", "finance_manager"].includes(role);
    case "create_intake":
      return ["owner_admin", "finance_manager", "bookkeeper_data_entry"].includes(role);
    case "review_intake":
      return ["owner_admin", "finance_manager", "reviewer_auditor", "external_accountant"].includes(role);
    case "approve_intake":
      return ["owner_admin", "finance_manager"].includes(role);
    case "view_reports":
      return ["owner_admin", "finance_manager", "reviewer_auditor", "external_accountant"].includes(role);
    case "view_exports":
      return ["owner_admin", "external_accountant"].includes(role);
    default:
      return false;
  }
}

function requiresMfaForRestricted(): boolean {
  return process.env.FINANCE_HUB_REQUIRE_MFA_FOR_RESTRICTED !== "false";
}

function isMfaVerified(req: Request, user: FinancialHubTokenPayload): boolean {
  if (user.mfaVerified === true) return true;
  const header = normalizeString(req.headers["x-mfa-verified"]);
  return ["1", "true", "yes"].includes(header.toLowerCase());
}

function ensureAuthorized(
  req: Request,
  res: Response,
  user: FinancialHubTokenPayload,
  permission:
    | "manage_security"
    | "manage_settings"
    | "upload_documents"
    | "view_documents"
    | "delete_documents"
    | "create_intake"
    | "review_intake"
    | "approve_intake"
    | "view_reports"
    | "view_exports",
  options?: { classification?: DataClassification; action?: string },
): boolean {
  const normalizedRole = normalizeFinanceHubRole(user.role);
  if (!hasFinancePermission(normalizedRole, permission)) {
    res.status(403).json({ error: "You are not authorized for this action" });
    return false;
  }

  if (options?.classification === "restricted") {
    if (!roleCanAccessRestricted(normalizedRole)) {
      res.status(403).json({ error: "Restricted data access is limited to approved roles" });
      return false;
    }
    if (requiresMfaForRestricted() && !isMfaVerified(req, user)) {
      res.status(403).json({ error: "MFA is required for Restricted data access" });
      return false;
    }
  }

  return true;
}

function auditFinanceHubEvent(
  action: string,
  user: FinancialHubTokenPayload,
  meta?: Record<string, unknown>,
): void {
  logger.info("[finance-hub-audit] action", {
    action,
    userId: user.userId,
    role: user.role,
    normalizedRole: normalizeFinanceHubRole(user.role),
    organizationId: user.organizationId,
    programDomain: user.programDomain,
    ...meta,
  });
}

function inferIntakeClassification(record: Record<string, unknown>): DataClassification {
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const explicit = normalizeClassification(metadata.classification, "internal");
  if (explicit !== "internal") return explicit;

  const hasRestrictedIds = Boolean(record.employeeId || record.payPeriodId);
  const markerString = JSON.stringify(metadata).toLowerCase();
  const hasRestrictedMarkers = /(ssn|w-9|w9|ein|payroll|bank[_\s-]*account)/.test(markerString);
  if (hasRestrictedIds || hasRestrictedMarkers) {
    return "restricted";
  }

  return "internal";
}

function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJson(item));
  }

  if (isRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      const shouldRedact = /(?:ssn|ein|w-?9|tax|bank|routing|account|payroll|employee|donor)/.test(normalizedKey);

      if (shouldRedact) {
        redacted[key] = "[REDACTED]";
        continue;
      }

      redacted[key] = redactSensitiveJson(child);
    }
    return redacted;
  }

  if (typeof value === "string") {
    if (/(?:\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|\b\d{9}\b|\b\d{12,19}\b)/.test(value)) {
      return "[REDACTED]";
    }
    return value;
  }

  return value;
}

function sanitizeFilename(originalName: string): string {
  const base = path.basename(originalName || "document");
  const noControls = base.replace(/[\u0000-\u001f\u007f]/g, "");
  const noTraversal = noControls.replace(/\.\.+/g, ".").replace(/[\\/]/g, "_");
  const cleaned = noTraversal
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
  return cleaned || "document";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(2));
}

function inferCategoryFromName(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (/(office|depot|staples|suppl)/.test(lower)) return "Office Supplies";
  if (/(uber|lyft|airline|delta|flight|hotel|travel)/.test(lower)) return "Travel";
  if (/(meal|restaurant|cafe|coffee)/.test(lower)) return "Meals";
  if (/(fuel|gas|shell|exxon)/.test(lower)) return "Transportation";
  if (/(utility|electric|water|internet)/.test(lower)) return "Utilities";
  return null;
}

function inferMerchantFromName(filename: string): string | null {
  const base = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^transaction_receipt-\d+-/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!base) return null;
  const cleaned = base.replace(/\b(receipt|invoice|photo|scan|img)\b/gi, "").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .slice(0, 4)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferReceiptExtraction(fileName: string, transactionType: string | null) {
  const lower = fileName.toLowerCase();
  const amountMatch = lower.match(/(?:total|amt|amount|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/i)
    || lower.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  const dateMatch = lower.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
  const cardMatch = lower.match(/(?:visa|mastercard|amex|discover)[^\d]*(\d{4})/i);
  const taxMatch = lower.match(/(?:tax|vat)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);

  const merchant = inferMerchantFromName(fileName);
  const category = inferCategoryFromName(fileName)
    || (transactionType?.toLowerCase() === "income" ? "Income" : null);

  const extracted: Record<string, unknown> = {};
  if (merchant) {
    extracted.merchantName = { value: merchant, confidence: clampConfidence(0.68) };
  }
  if (amountMatch) {
    extracted.amount = { value: Number(amountMatch[1]), confidence: clampConfidence(0.81) };
  }
  if (dateMatch) {
    extracted.transactionDate = {
      value: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
      confidence: clampConfidence(0.78),
    };
  }
  if (taxMatch) {
    extracted.taxAmount = { value: Number(taxMatch[1]), confidence: clampConfidence(0.62) };
  }
  if (cardMatch) {
    extracted.paymentMethod = {
      value: `Card ending ${cardMatch[1]}`,
      confidence: clampConfidence(0.61),
    };
  }
  if (category) {
    extracted.suggestedCategory = {
      value: category,
      confidence: clampConfidence(0.66),
    };
  }

  return extracted;
}

function mapFinanceHubDocument(record: Record<string, unknown>) {
  const createdAt = record.createdAt instanceof Date ? record.createdAt.toISOString() : null;
  const updatedAt = record.updatedAt instanceof Date ? record.updatedAt.toISOString() : null;
  const deletedAt = record.deletedAt instanceof Date ? record.deletedAt.toISOString() : null;
  const folder = typeof record.folder === "string" && record.folder ? record.folder : "general";
  const classification = parseClassificationFromR2Key(record.r2Key);

  return {
    id: String(record.id),
    organizationId: String(record.organizationId || DEFAULT_ORGANIZATION_ID),
    programDomain: String(record.programDomain || FINANCIAL_HUB_PROGRAM_DOMAIN),
    folder,
    originalFilename: typeof record.originalFilename === "string" ? record.originalFilename : "",
    safeFilename: typeof record.safeFilename === "string" ? record.safeFilename : "",
    mimeType: typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream",
    fileSize: typeof record.fileSize === "number" ? record.fileSize : 0,
    r2Key: typeof record.r2Key === "string" ? record.r2Key : "",
    storageProvider: typeof record.storageProvider === "string" ? record.storageProvider : "r2",
    classification,
    uploadedByUserId: typeof record.uploadedByUserId === "string" ? record.uploadedByUserId : null,
    deletedByUserId: typeof record.deletedByUserId === "string" ? record.deletedByUserId : null,
    status: typeof record.status === "string" ? record.status : "uploaded",
    createdAt,
    updatedAt,
    deletedAt,
    hasOriginal: typeof record.status === "string" ? record.status !== "deleted" : true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFinanceStateSnapshot(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Invalid state payload");
  }

  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!FINANCE_STATE_ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (typeof raw !== "string") {
      continue;
    }
    normalized[key] = raw;
  }

  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > FINANCE_STATE_MAX_BYTES) {
    throw new Error("Finance state payload exceeds 1MB limit");
  }

  return normalized;
}

function readFinanceStateFromProgramSettings(settings: unknown): Record<string, string> {
  if (!isRecord(settings)) return {};
  const nested = isRecord(settings.state) ? settings.state : settings;
  const state: Record<string, string> = {};

  for (const key of FINANCE_STATE_ALLOWED_KEYS) {
    const raw = nested[key];
    if (typeof raw === "string") {
      state[key] = raw;
    }
  }

  return state;
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    return "Password must include at least one letter and one number";
  }
  return null;
}

function slugifyOrganization(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    if (["token", "accessToken", "authToken", "jwt", "session"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function decodeFinancialHubToken(token: string): FinancialHubTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as FinancialHubTokenPayload;
    if (payload.programDomain !== FINANCIAL_HUB_PROGRAM_DOMAIN) return null;
    if (!payload.organizationId || !payload.userId) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireFinancialHubAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const payload = decodeFinancialHubToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  (req as Request & { financialHubUser: FinancialHubTokenPayload }).financialHubUser = payload;
  next();
}

function getFinancialHubUser(req: Request): FinancialHubTokenPayload {
  return (req as Request & { financialHubUser: FinancialHubTokenPayload }).financialHubUser;
}

function writeAuthCookies(res: Response, token: string): void {
  const secureCookie = process.env.NODE_ENV === "production";
  const baseCookie = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: (secureCookie ? "none" : "lax") as "none" | "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  };

  res.cookie("accessToken", token, baseCookie);
  res.cookie("token", token, baseCookie);
  res.cookie("financialHubToken", token, baseCookie);
}

async function getSetupStatus() {
  const initialAdminCount = await prismaFinancial.financialHubUserProfile.count({
    where: {
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      isInitialAdmin: true,
    },
  });

  const organizationCount = await prisma.organizationProgramSubscription.count({
    where: {
      programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
      status: { in: ["active", "trialing"] },
    },
  });

  const initialAdminExists = initialAdminCount > 0;
  const organizationExists = organizationCount > 0;

  return {
    setupRequired: !(organizationExists && initialAdminExists),
    organizationExists,
    initialAdminExists,
  };
}

function mapIntakeRecord(record: Record<string, unknown>) {
  const classification = inferIntakeClassification(record);
  const isRestricted = classification === "restricted";
  return {
    id: String(record.id),
    organizationId: String(record.organizationId),
    programDomain: String(record.programDomain),
    sourceApp: String(record.sourceApp),
    sourceRecordId: String(record.sourceRecordId),
    sourceRecordType: String(record.sourceRecordType),
    sourceStatus: typeof record.sourceStatus === "string" ? record.sourceStatus : null,
    financeStatus: String(record.financeStatus),
    title: typeof record.title === "string" ? record.title : "",
    description: typeof record.description === "string" ? record.description : null,
    amount: typeof record.amount === "number" ? record.amount : 0,
    currency: typeof record.currency === "string" ? record.currency : "USD",
    transactionDate: record.transactionDate instanceof Date ? record.transactionDate.toISOString() : null,
    payPeriodId: typeof record.payPeriodId === "string" ? record.payPeriodId : null,
    employeeId: typeof record.employeeId === "string" ? record.employeeId : null,
    volunteerId: typeof record.volunteerId === "string" ? record.volunteerId : null,
    programId: typeof record.programId === "string" ? record.programId : null,
    grantId: typeof record.grantId === "string" ? record.grantId : null,
    eventId: typeof record.eventId === "string" ? record.eventId : null,
    expenseId: typeof record.expenseId === "string" ? record.expenseId : null,
    timesheetId: typeof record.timesheetId === "string" ? record.timesheetId : null,
    fundingSourceId: typeof record.fundingSourceId === "string" ? record.fundingSourceId : null,
    submittedByUserId: typeof record.submittedByUserId === "string" ? record.submittedByUserId : null,
    operationallyApprovedByUserId:
      typeof record.operationallyApprovedByUserId === "string" ? record.operationallyApprovedByUserId : null,
    financeReviewedByUserId:
      typeof record.financeReviewedByUserId === "string" ? record.financeReviewedByUserId : null,
    financeReviewedAt: record.financeReviewedAt instanceof Date ? record.financeReviewedAt.toISOString() : null,
    exportBatchId: typeof record.exportBatchId === "string" ? record.exportBatchId : null,
    postedAt: record.postedAt instanceof Date ? record.postedAt.toISOString() : null,
    metadata: isRestricted ? redactSensitiveJson(record.metadata ?? {}) : (record.metadata ?? {}),
    attachments: isRestricted ? redactSensitiveJson(record.attachments ?? []) : (record.attachments ?? []),
    validationIssues: isRestricted ? redactSensitiveJson(record.validationIssues ?? []) : (record.validationIssues ?? []),
    classification,
    createdByUserId: typeof record.createdByUserId === "string" ? record.createdByUserId : null,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : null,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : null,
  };
}

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    program: "Financial Hub",
    programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    capabilities: {
      setup: true,
      intake: true,
      reviewQueue: true,
      reports: true,
      exports: true,
      settings: true,
    },
  });
});

router.get("/setup/status", async (_req, res) => {
  const status = await getSetupStatus();
  res.json(status);
});

router.post("/setup/initial-user", async (req, res) => {
  const status = await getSetupStatus();
  if (!status.setupRequired) {
    res.status(409).json({ error: "Setup already completed" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const organizationName = normalizeString(body.organizationName);
  const adminName = normalizeString(body.adminName);
  const adminEmail = normalizeEmail(body.adminEmail);
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const phone = optionalString(body.phone);
  const title = optionalString(body.title);
  const defaultTimezone = optionalString(body.defaultTimezone) || "America/New_York";

  if (!organizationName || !adminName || !adminEmail || !password || !confirmPassword) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (password !== confirmPassword) {
    res.status(400).json({ error: "Passwords do not match" });
    return;
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const baseSlug = slugifyOrganization(organizationName) || "organization";
  const nowSuffix = Date.now().toString(36);
  const orgSlug = `${baseSlug}-${nowSuffix}`;

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existingUser) {
      res.status(409).json({ error: "Duplicate email" });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug: orgSlug,
          contactEmail: adminEmail,
          ownerEmail: adminEmail,
          supportEmail: adminEmail,
          phoneNumber: phone,
          status: "active",
          isActive: true,
        },
      });

      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          email: adminEmail,
          passwordHash: await hashPassword(password),
          role: "admin",
          platformRole: "user",
          displayName: adminName,
          firstName: adminName.split(" ")[0] || adminName,
          lastName: adminName.split(" ").slice(1).join(" "),
          identitySource: "local",
        },
      });

      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: "owner",
        },
      });

      await tx.organizationProgramSubscription.upsert({
        where: {
          organizationId_programId: {
            organizationId: organization.id,
            programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: {
          status: "active",
          subscriptionSource: "manual",
          startsAt: new Date(),
          notes: "Created by Financial Hub initial setup",
        },
        create: {
          organizationId: organization.id,
          programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          status: "active",
          subscriptionSource: "manual",
          startsAt: new Date(),
          notes: "Created by Financial Hub initial setup",
        },
      });

      await tx.userProgramAccess.upsert({
        where: {
          userId_organizationId_programId: {
            userId: user.id,
            organizationId: organization.id,
            programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: { enabled: true },
        create: {
          userId: user.id,
          organizationId: organization.id,
          programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          enabled: true,
        },
      });

      await (tx as unknown as PrismaWithFinancialHub).financialHubUserProfile.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          phone,
          title,
          defaultTimezone,
          capabilities: DEFAULT_CAPABILITIES,
          isInitialAdmin: true,
          createdByUserId: user.id,
        },
      });

      await tx.programStorageSettings.upsert({
        where: {
          organizationId_programDomain: {
            organizationId: organization.id,
            programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: {
          settings: {
            defaultTimezone,
            createdFromInitialSetup: true,
          },
        },
        create: {
          organizationId: organization.id,
          programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          settings: {
            defaultTimezone,
            createdFromInitialSetup: true,
          },
        },
      });

      return { organization, user };
    });

    const token = signToken({
      userId: created.user.id,
      email: created.user.email,
      role: created.user.role,
      platformRole: created.user.platformRole,
      organizationId: created.organization.id,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    });

    writeAuthCookies(res, token);
    res.setHeader("Authorization", `Bearer ${token}`);
    res.status(201).json({
      token,
      user: {
        id: created.user.id,
        email: created.user.email,
        role: created.user.role,
        platformRole: created.user.platformRole,
        displayName: created.user.displayName,
        organizationId: created.organization.id,
        organizationName: created.organization.name,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
        capabilities: DEFAULT_CAPABILITIES,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete setup";
    if (message.toLowerCase().includes("unique") || message.toLowerCase().includes("duplicate")) {
      res.status(409).json({ error: "Duplicate email" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

router.get("/me", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const [dbUser, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.userId } }),
    prismaFinancial.financialHubUserProfile.findFirst({
      where: {
        userId: user.userId,
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    }),
  ]);

  if (!dbUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    user: {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      displayName: dbUser.displayName,
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      capabilities: (profile?.capabilities as Record<string, boolean> | undefined) || DEFAULT_CAPABILITIES,
    },
  });
});

router.get("/finance/state", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);

  const row = await prisma.programStorageSettings.findUnique({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCE_STATE_PROGRAM_DOMAIN,
      },
    },
  });

  const state = readFinanceStateFromProgramSettings(row?.settings);
  res.json({
    state,
    updatedAt: row?.updatedAt?.toISOString() || null,
    organizationId: user.organizationId,
  });
});

router.put("/finance/state", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const body = isRecord(req.body) ? req.body : {};

  if (!isRecord(body.state)) {
    res.status(400).json({ error: "Invalid payload. Expected { state: Record<string, string> }" });
    return;
  }

  let state: Record<string, string>;
  try {
    state = normalizeFinanceStateSnapshot(body.state);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid finance state payload",
    });
    return;
  }

  const settingsPayload: Prisma.InputJsonValue = {
    state,
    updatedByUserId: user.userId,
    updatedByRole: user.role,
    updatedAt: new Date().toISOString(),
  };

  const saved = await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCE_STATE_PROGRAM_DOMAIN,
      },
    },
    update: {
      settings: settingsPayload,
    },
    create: {
      organizationId: user.organizationId,
      programDomain: FINANCE_STATE_PROGRAM_DOMAIN,
      settings: settingsPayload,
    },
  });

  auditFinanceHubEvent("finance.state.update", user, {
    keyCount: Object.keys(state).length,
  });

  res.json({
    state,
    updatedAt: saved.updatedAt.toISOString(),
    organizationId: user.organizationId,
  });
});

router.post("/documents/upload", requireFinancialHubAuth, financeHubUpload.single("file"), async (req, res) => {
  const user = getFinancialHubUser(req);
  const classification = normalizeClassification((req.body as Record<string, unknown> | undefined)?.classification, "confidential");
  if (!ensureAuthorized(req, res, user, "upload_documents", { classification, action: "documents.upload" })) {
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "A file is required" });
    return;
  }

  const requestedFolder = normalizeString((req.body as Record<string, unknown> | undefined)?.folder).toLowerCase();
  if (requestedFolder && !FINANCE_HUB_DOCUMENT_FOLDERS.has(requestedFolder)) {
    res.status(400).json({ error: "Invalid folder. Allowed values are 'general' or 'test'." });
    return;
  }

  const folder = parseFinanceFolder(requestedFolder, { defaultToGeneral: true }) || "general";
  if (!FINANCE_HUB_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
    res.status(415).json({ error: `Unsupported file MIME type '${file.mimetype}'` });
    return;
  }

  if (file.size > FINANCE_HUB_DOCUMENT_MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `File is larger than the configured ${FINANCE_HUB_DOCUMENT_MAX_UPLOAD_MB}MB limit`,
    });
    return;
  }

  const safeFilename = sanitizeFilename(file.originalname || "document");
  const ext = path.extname(safeFilename).toLowerCase();
  if (!ext || !FINANCE_HUB_ALLOWED_EXTENSIONS.has(ext)) {
    res.status(415).json({ error: `Unsupported file extension '${ext || "(none)"}'` });
    return;
  }

  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const r2Key = `finance-hub/documents/${folder}/${classification}/${stamp}-${safeFilename}`;

  try {
    const storage = await resolveStorageAdapter({
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    });
    const uploaded = await storage.adapter.upload(r2Key, file.buffer, file.mimetype);

    const created = await prismaFinancial.financeHubDocument.create({
      data: {
        organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
        folder,
        originalFilename: file.originalname || safeFilename,
        safeFilename,
        mimeType: file.mimetype,
        fileSize: file.size,
        r2Key: uploaded.key,
        storageProvider: storage.adapter.backendId.includes("r2") ? "r2" : storage.adapter.backendId,
        uploadedByUserId: user.userId || null,
        status: "uploaded",
      },
    });

    auditFinanceHubEvent("documents.upload", user, {
      documentId: String(created.id),
      folder,
      classification,
      fileSize: file.size,
      mimeType: file.mimetype,
    });

    res.status(201).json(mapFinanceHubDocument(created));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload document";
    res.status(500).json({ error: message });
  }
});

router.post("/finance/receipts/analyze", requireFinancialHubAuth, financeHubUpload.single("file"), async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "upload_documents", { classification: "confidential", action: "receipts.analyze" })) {
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "A file is required" });
    return;
  }

  const body = (req.body as Record<string, unknown> | undefined) || {};
  const requestedOrganizationId = normalizeString(body.organizationId);
  const transactionType = optionalString(body.transactionType);
  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;

  if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
    res.status(403).json({ error: "Organization scope mismatch" });
    return;
  }

  if (!RECEIPT_ANALYZE_MIME_TYPES.has(file.mimetype)) {
    res.status(415).json({ error: `Unsupported receipt MIME type '${file.mimetype}'` });
    return;
  }

  if (file.size > FINANCE_HUB_DOCUMENT_MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `File is larger than the configured ${FINANCE_HUB_DOCUMENT_MAX_UPLOAD_MB}MB limit`,
    });
    return;
  }

  const safeFilename = sanitizeFilename(file.originalname || "receipt");
  const ext = path.extname(safeFilename).toLowerCase();
  if (!ext || !RECEIPT_ANALYZE_ALLOWED_EXTENSIONS.has(ext)) {
    res.status(415).json({ error: `Unsupported file extension '${ext || "(none)"}'` });
    return;
  }

  const extracted = inferReceiptExtraction(safeFilename, transactionType);
  const hasExtraction = Object.keys(extracted).length > 0;
  const warnings = hasExtraction
    ? []
    : ["We could not confidently extract receipt details from this file."];

  res.json({
    success: true,
    extracted,
    warnings,
    rawTextPreview: `Filename hint: ${safeFilename.slice(0, 120)}`,
  });
});

router.get("/documents", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "view_documents", { action: "documents.list" })) {
    return;
  }

  const folderRaw = normalizeString(req.query.folder).toLowerCase();
  if (folderRaw && folderRaw !== "all" && !FINANCE_HUB_DOCUMENT_FOLDERS.has(folderRaw)) {
    res.status(400).json({ error: "Invalid folder filter. Allowed values are 'all', 'general', or 'test'." });
    return;
  }

  const folderFilter = parseFinanceFolder(folderRaw);
  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;

  const rows = await prismaFinancial.financeHubDocument.findMany({
    where: {
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      deletedAt: null,
      status: { not: "deleted" },
      ...(folderFilter ? { folder: folderFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const mapped = rows.map(mapFinanceHubDocument);
  const filtered = mapped.filter((doc) => {
    if (doc.classification !== "restricted") return true;
    return roleCanAccessRestricted(normalizeFinanceHubRole(user.role));
  });

  auditFinanceHubEvent("documents.list", user, {
    returned: filtered.length,
    requestedFolder: folderFilter || "all",
  });

  res.json({ items: filtered });
});

router.get("/documents/:id", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const documentId = normalizeString(req.params.id);
  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;

  const row = await prismaFinancial.financeHubDocument.findFirst({
    where: {
      id: documentId,
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      deletedAt: null,
      status: { not: "deleted" },
    },
  });

  if (!row) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const mapped = mapFinanceHubDocument(row);
  if (!ensureAuthorized(req, res, user, "view_documents", { classification: mapped.classification, action: "documents.get" })) {
    return;
  }

  auditFinanceHubEvent("documents.get", user, {
    documentId,
    classification: mapped.classification,
  });

  res.json({ item: mapped });
});

router.get("/documents/:id/url", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const documentId = normalizeString(req.params.id);
  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;
  const dispositionRaw = normalizeString(req.query.disposition).toLowerCase();
  const disposition = dispositionRaw === "attachment" ? "attachment" : "inline";

  const row = await prismaFinancial.financeHubDocument.findFirst({
    where: {
      id: documentId,
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      deletedAt: null,
      status: { not: "deleted" },
    },
  });

  if (!row) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const mapped = mapFinanceHubDocument(row);
  if (!ensureAuthorized(req, res, user, "view_documents", { classification: mapped.classification, action: "documents.url" })) {
    return;
  }

  try {
    const storage = await resolveStorageAdapter({
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    });
    const expiresIn = mapped.classification === "restricted"
      ? FINANCE_HUB_RESTRICTED_SIGNED_URL_TTL_SECONDS
      : FINANCE_HUB_SIGNED_URL_TTL_SECONDS;
    const url = await storage.adapter.getDownloadUrl(String(row.r2Key), {
      disposition,
      filename: String(row.originalFilename || row.safeFilename || "document"),
      expiresIn,
    });

    auditFinanceHubEvent("documents.url", user, {
      documentId,
      classification: mapped.classification,
      disposition,
      expiresIn,
    });

    res.json({
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      filename: String(row.originalFilename || row.safeFilename || "document"),
      mimeType: String(row.mimeType || "application/octet-stream"),
      classification: mapped.classification,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate signed URL";
    res.status(500).json({ error: message });
  }
});

router.delete("/documents/:id", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "delete_documents", { action: "documents.delete" })) {
    return;
  }

  const documentId = normalizeString(req.params.id);
  const organizationId = user.organizationId || DEFAULT_ORGANIZATION_ID;

  const row = await prismaFinancial.financeHubDocument.findFirst({
    where: {
      id: documentId,
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      deletedAt: null,
      status: { not: "deleted" },
    },
  });

  if (!row) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const mapped = mapFinanceHubDocument(row);
  if (!ensureAuthorized(req, res, user, "delete_documents", { classification: mapped.classification, action: "documents.delete" })) {
    return;
  }

  try {
    const storage = await resolveStorageAdapter({
      organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    });
    await storage.adapter.delete(String(row.r2Key));

    const deletedAt = new Date();
    await prismaFinancial.financeHubDocument.update({
      where: { id: documentId },
      data: {
        status: "deleted",
        deletedAt,
        deletedByUserId: user.userId || null,
      },
    });

    auditFinanceHubEvent("documents.delete", user, {
      documentId,
      classification: mapped.classification,
    });

    res.json({
      deleted: true,
      id: documentId,
      status: "deleted",
      deletedAt: deletedAt.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete document";
    res.status(500).json({ error: message });
  }
});

router.get("/intake", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "review_intake", { action: "intake.list" })) {
    return;
  }

  const financeStatus = optionalString(req.query.financeStatus);

  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      ...(financeStatus ? { financeStatus } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const mapped = rows.map(mapIntakeRecord);
  const filtered = mapped.filter((record) => {
    if (record.classification !== "restricted") return true;
    return roleCanAccessRestricted(normalizeFinanceHubRole(user.role));
  });

  auditFinanceHubEvent("intake.list", user, {
    returned: filtered.length,
    financeStatus: financeStatus || "all",
  });

  res.json({ items: filtered });
});

router.post("/intake", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "create_intake", { action: "intake.create" })) {
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const requestedClassification = normalizeClassification(body.classification, "internal");
  if (!ensureAuthorized(req, res, user, "create_intake", { classification: requestedClassification, action: "intake.create" })) {
    return;
  }

  const sourceApp = normalizeString(body.sourceApp);
  const sourceRecordId = normalizeString(body.sourceRecordId);
  const sourceRecordType = normalizeString(body.sourceRecordType);
  const financeStatus = normalizeString(body.financeStatus || "received") || "received";
  const title = normalizeString(body.title);
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
  const currency = normalizeString(body.currency || "USD") || "USD";

  if (!SOURCE_APP_VALUES.has(sourceApp)) {
    res.status(400).json({ error: "Invalid sourceApp" });
    return;
  }
  if (!SOURCE_RECORD_TYPE_VALUES.has(sourceRecordType)) {
    res.status(400).json({ error: "Invalid sourceRecordType" });
    return;
  }
  if (!FINANCE_STATUS_VALUES.has(financeStatus)) {
    res.status(400).json({ error: "Invalid financeStatus" });
    return;
  }
  if (!sourceRecordId || !title) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (!Number.isFinite(amount)) {
    res.status(400).json({ error: "Invalid amount" });
    return;
  }

  try {
    const metadata = isRecord(body.metadata) ? { ...body.metadata } : {};
    metadata.classification = requestedClassification;

    const created = await prismaFinancial.financeIntakeRecord.create({
      data: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
        sourceApp,
        sourceRecordId,
        sourceRecordType,
        sourceStatus: optionalString(body.sourceStatus),
        financeStatus,
        title,
        description: optionalString(body.description),
        amount,
        currency,
        transactionDate: optionalString(body.transactionDate) ? new Date(String(body.transactionDate)) : null,
        payPeriodId: optionalString(body.payPeriodId),
        employeeId: optionalString(body.employeeId),
        volunteerId: optionalString(body.volunteerId),
        programId: optionalString(body.programId),
        grantId: optionalString(body.grantId),
        eventId: optionalString(body.eventId),
        expenseId: optionalString(body.expenseId),
        timesheetId: optionalString(body.timesheetId),
        fundingSourceId: optionalString(body.fundingSourceId),
        submittedByUserId: optionalString(body.submittedByUserId) || user.userId,
        operationallyApprovedByUserId: optionalString(body.operationallyApprovedByUserId),
        metadata,
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        validationIssues: Array.isArray(body.validationIssues) ? body.validationIssues : [],
        createdByUserId: user.userId,
      },
    });

    auditFinanceHubEvent("intake.create", user, {
      intakeId: String(created.id),
      sourceApp,
      sourceRecordType,
      classification: requestedClassification,
    });

    res.status(201).json({ item: mapIntakeRecord(created) });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      res.status(409).json({ error: "Duplicate source record for this organization" });
      return;
    }
    res.status(500).json({ error: "Failed to create intake record" });
  }
});

router.patch("/intake/:id/status", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "approve_intake", { action: "intake.status.update" })) {
    return;
  }

  const recordId = normalizeString(req.params.id);
  const body = isRecord(req.body) ? req.body : {};
  const financeStatus = normalizeString(body.financeStatus);

  if (!recordId || !FINANCE_STATUS_VALUES.has(financeStatus)) {
    res.status(400).json({ error: "Invalid intake status update" });
    return;
  }

  const existing = await prismaFinancial.financeIntakeRecord.findFirst({
    where: {
      id: recordId,
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Record not found" });
    return;
  }

  const existingClassification = inferIntakeClassification(existing);
  if (!ensureAuthorized(req, res, user, "approve_intake", { classification: existingClassification, action: "intake.status.update" })) {
    return;
  }

  const reviewed = ["needs_correction", "finance_ready", "exported", "posted", "archived"].includes(financeStatus);
  const updated = await prismaFinancial.financeIntakeRecord.update({
    where: { id: recordId },
    data: {
      financeStatus,
      financeReviewedByUserId: reviewed ? user.userId : null,
      financeReviewedAt: reviewed ? new Date() : null,
      postedAt: financeStatus === "posted" ? new Date() : null,
      exportBatchId: optionalString(body.exportBatchId),
    },
  });

  res.json({ item: mapIntakeRecord(updated) });
  auditFinanceHubEvent("intake.status.update", user, {
    intakeId: recordId,
    financeStatus,
    classification: existingClassification,
  });
});

router.get("/review-queue", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "review_intake", { action: "review-queue.list" })) {
    return;
  }

  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      financeStatus: { in: ["received", "validation_pending", "needs_correction"] },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const mapped = rows.map(mapIntakeRecord);
  const filtered = mapped.filter((record) => {
    if (record.classification !== "restricted") return true;
    return roleCanAccessRestricted(normalizeFinanceHubRole(user.role));
  });

  res.json({ items: filtered });
});

router.get("/reports", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "view_reports", { action: "reports.view" })) {
    return;
  }

  const [statusCounts, totals] = await Promise.all([
    prismaFinancial.financeIntakeRecord.groupBy({
      by: ["financeStatus"],
      where: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
      _count: { _all: true },
    }),
    prismaFinancial.financeIntakeRecord.aggregate({
      where: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  res.json({
    summary: {
      totalRecords: Number((totals._count as { _all?: number } | undefined)?._all || 0),
      totalAmount: Number((totals._sum as { amount?: number } | undefined)?.amount || 0),
    },
    statuses: statusCounts.map((entry) => ({
      financeStatus: String(entry.financeStatus),
      count: Number((entry._count as { _all?: number } | undefined)?._all || 0),
    })),
  });
});

router.get("/exports", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "view_exports", { action: "exports.view" })) {
    return;
  }

  const includeRestricted = normalizeString(req.query.includeRestricted).toLowerCase() === "true";
  const approvalTicket = normalizeString(req.query.approvalTicket);
  const justification = normalizeString(req.query.justification);

  if (includeRestricted) {
    if (!roleCanAccessRestricted(normalizeFinanceHubRole(user.role))) {
      res.status(403).json({ error: "Restricted export access is limited to approved roles" });
      return;
    }
    if (requiresMfaForRestricted() && !isMfaVerified(req, user)) {
      res.status(403).json({ error: "MFA is required for Restricted data exports" });
      return;
    }
    if (!approvalTicket || !justification || justification.length < 10) {
      res.status(400).json({
        error: "Restricted exports require approvalTicket and a business justification",
      });
      return;
    }
  }

  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      financeStatus: { in: ["finance_ready", "exported", "posted"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const mapped = rows.map(mapIntakeRecord);
  const filtered = mapped.filter((record) => includeRestricted || record.classification !== "restricted");

  auditFinanceHubEvent("exports.view", user, {
    includeRestricted,
    approvalTicket: approvalTicket || null,
    returned: filtered.length,
  });

  res.json({ items: filtered });
});

router.get("/settings", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "manage_settings", { action: "settings.get" })) {
    return;
  }

  const settings = await prisma.programStorageSettings.findUnique({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    },
  });

  res.json({
    settings: settings?.settings || {},
    organizationId: user.organizationId,
    programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
  });
});

router.patch("/settings", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  if (!ensureAuthorized(req, res, user, "manage_settings", { action: "settings.patch" })) {
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const normalizedSettings = body as Prisma.InputJsonValue;

  const saved = await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    },
    update: {
      settings: normalizedSettings,
    },
    create: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      settings: normalizedSettings,
    },
  });

  res.json({ settings: saved.settings });
});

// Mount tax identity routes
router.use("/", taxIdentityRouter);

export { router as financialHubRouter };
