/**
 * Mission Hub API Routes
 *
 * All endpoints are scoped by organizationId + userId extracted from the JWT.
 * Phase 1: auth gate is open — requireMissionHubAuth verifies the token when
 * provided but the frontend currently bypasses the auth handoff, so the
 * consume endpoint is kept for future use.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import JSZip from "jszip";
import rateLimit from "express-rate-limit";
import { prisma } from "../../../core/db/prisma.js";
import { JWT_SECRET, PLATFORM_LAUNCH_TOKEN_SECRET, FRONTEND_BASE_URL } from "../../../core/config/env.js";
import { signToken, hashPassword, verifyPassword } from "../../../core/auth/auth.service.js";
import { requireProgramSubscription } from "../../../core/middleware/program-access.middleware.js";
import { upload } from "../../../validators.js";
import { resolveStorageAdapter, StorageConfigError } from "../../../core/storage/storageResolver.js";
import {
  issueMissionHubInvite,
  resendMissionHubInvite,
  MissionHubInviteServiceError,
} from "../../../core/services/missionHubInvite.service.js";
import { sendPasswordResetEmail } from "../../../core/services/email.service.js";
import { logger } from "../../../logger.js";

const router = express.Router();

const MISSION_HUB_PROGRAM_DOMAIN = "mission-hub";
const LOGIN_RATE_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});
const UPLOAD_RATE_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload attempts. Please try again later." },
});
const EXPORT_RATE_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many export requests. Please try again later." },
});
const INVITE_RATE_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many invite requests. Please try again later." },
});
const MISSION_HUB_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const MISSION_HUB_ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);
const MISSION_HUB_ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".csv",
  ".txt",
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
]);
const MISSION_HUB_ALLOWED_SENSITIVITY = new Set(["public", "internal", "confidential", "restricted"]);
const MISSION_HUB_DOCUMENT_EXPORT_TTL_HOURS = 24;

const EXPENSE_APPROVER_ROLES = new Set(["admin", "reviewer", "finance", "executive director", "deputy director"]);

type MissionHubAuditStore = typeof prisma & {
  missionHubAuditLog: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

const missionHubAuditStore = prisma as MissionHubAuditStore;

function canApproveExpenses(role: unknown): boolean {
  return EXPENSE_APPROVER_ROLES.has(normalizeRoleValue(role));
}

function sanitizeMissionHubFilename(filename: string): string {
  const base = path.basename(filename || "document");
  const noControls = base.replace(/[\u0000-\u001f\u007f]/g, "");
  const safe = noControls.replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return safe || "document";
}

function buildPartitionedKey(args: {
  prefix: string;
  programDomain: string;
  organizationId: string;
  userId: string;
  stamp: string;
  safeFileName: string;
}): string {
  const keyParts = [
    args.prefix.replace(/^\/+|\/+$/g, ""),
    args.programDomain,
    args.organizationId,
    args.userId,
  ].filter(Boolean);

  return `${keyParts.join("/")}/${args.stamp}-${args.safeFileName}`;
}

function parseRouteId(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function isMissionHubDocumentEntityType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return new Set([
    "program",
    "project",
    "grant",
    "sponsor",
    "fundraising",
    "event",
    "expense",
    "personnel",
    "employee",
  ]).has(normalized);
}

function isMissionHubDocumentLinkType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return new Set([
    "attachment",
    "receipt",
    "invoice",
    "agreement",
    "award_letter",
    "report",
    "reimbursement_backup",
    "proof",
    "logo",
    "tax_form",
    "payment_confirmation",
    "supporting_document",
  ]).has(normalized);
}

function normalizeEntityType(value: unknown): string | null {
  if (!isMissionHubDocumentEntityType(value)) return null;
  return value.trim().toLowerCase();
}

function normalizeLinkType(value: unknown): string | null {
  if (!isMissionHubDocumentLinkType(value)) return null;
  return value.trim().toLowerCase();
}

function getMissionHubDocumentClient() {
  return (prisma as unknown as {
    missionHubDocument: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }).missionHubDocument;
}

function getMissionHubDocumentLinkClient() {
  return (prisma as unknown as {
    missionHubDocumentLink: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }).missionHubDocumentLink;
}

function getMissionHubDocumentExportClient() {
  return (prisma as unknown as {
    missionHubDocumentExport: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }).missionHubDocumentExport;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function buildDocumentExportCsv(docs: Record<string, unknown>[]): string {
  const header = [
    "id",
    "title",
    "originalFilename",
    "mimeType",
    "sizeBytes",
    "storageKey",
    "storageProvider",
    "linkedEntityType",
    "linkedEntityId",
    "createdAt",
  ];

  const rows = docs.map((doc) => [
    String(doc.id ?? ""),
    String(doc.title ?? ""),
    String(doc.originalFilename ?? ""),
    String(doc.mimeType ?? ""),
    String(doc.sizeBytes ?? 0),
    String(doc.storageKey ?? ""),
    String(doc.storageProvider ?? ""),
    String(doc.linkedEntityType ?? ""),
    String(doc.linkedEntityId ?? ""),
    toIsoString(doc.createdAt),
  ]);

  return [header, ...rows].map((row) => row.map((cell) => csvEscape(cell)).join(",")).join("\n");
}

async function hasMissionHubEntityReadAccess(
  entityType: string,
  entityId: string,
  organizationId: string,
  role: string,
): Promise<boolean> {
  if ((entityType === "personnel" || entityType === "employee") && !isAdminRole(role)) {
    return false;
  }
  if (entityType === "expense" && !(canApproveExpenses(role) || canWriteDocuments(role) || isAdminRole(role))) {
    return false;
  }
  return resolveMissionHubEntityAccess(entityType, entityId, organizationId);
}

async function canReadMissionHubDocument(
  doc: Record<string, unknown>,
  organizationId: string,
  role: string,
): Promise<boolean> {
  const directEntityType = normalizeEntityType(doc.linkedEntityType);
  const directEntityId = typeof doc.linkedEntityId === "string" ? doc.linkedEntityId : null;

  if (directEntityType && directEntityId) {
    const directAllowed = await hasMissionHubEntityReadAccess(directEntityType, directEntityId, organizationId, role);
    if (!directAllowed) {
      return false;
    }
  }

  const linkClient = getMissionHubDocumentLinkClient();
  const links = await linkClient.findMany({
    where: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      documentId: String(doc.id ?? ""),
    },
    orderBy: { createdAt: "desc" },
  });

  if (!links.length) {
    return true;
  }

  for (const link of links) {
    const entityType = normalizeEntityType(link.entityType);
    const entityId = typeof link.entityId === "string" ? link.entityId : null;
    if (!entityType || !entityId) {
      continue;
    }
    const allowed = await hasMissionHubEntityReadAccess(entityType, entityId, organizationId, role);
    if (allowed) {
      return true;
    }
  }

  return false;
}

async function resolveMissionHubEntityAccess(
  entityType: string,
  entityId: string,
  organizationId: string,
): Promise<boolean> {
  const store = prisma as unknown as Record<string, { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> }>;
  const entityModel =
    entityType === "program" ? "missionHubProgram"
      : entityType === "project" ? "missionHubProject"
        : entityType === "grant" ? "missionHubGrant"
          : entityType === "sponsor" ? "missionHubSponsor"
            : entityType === "fundraising" ? "missionHubCampaign"
              : entityType === "event" ? "missionHubEvent"
                : entityType === "expense" ? "missionHubExpense"
                  : entityType === "personnel" || entityType === "employee" ? "missionHubPersonnel"
                    : "";

  if (!entityModel || !(entityModel in store)) return false;

  const client = store[entityModel];
  const record = await client.findFirst({ where: { id: entityId, organizationId, isActive: true } });
  return Boolean(record);
}

function toMissionHubDocumentLink(link: Record<string, unknown>) {
  return {
    id: String(link.id),
    organizationId: String(link.organizationId),
    programDomain: String(link.programDomain ?? MISSION_HUB_PROGRAM_DOMAIN),
    documentId: String(link.documentId),
    entityType: String(link.entityType),
    entityId: String(link.entityId),
    linkType: String(link.linkType ?? "attachment"),
    notes: typeof link.notes === "string" ? link.notes : null,
    sourceContext: typeof link.sourceContext === "string" ? link.sourceContext : null,
    createdByUserId: typeof link.createdByUserId === "string" ? link.createdByUserId : null,
    createdAt: link.createdAt instanceof Date ? link.createdAt.toISOString() : String(link.createdAt ?? ""),
    updatedAt: link.updatedAt instanceof Date ? link.updatedAt.toISOString() : String(link.updatedAt ?? ""),
  };
}

async function auditMissionHubEvent(
  req: Request,
  action: string,
  actor: MissionHubTokenPayload | undefined,
  meta?: {
    resourceType?: string;
    resourceId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const resolvedActor = actor || (req as Request & { missionHubUser?: MissionHubTokenPayload }).missionHubUser;
  if (!resolvedActor?.organizationId || !resolvedActor?.userId) return;

  try {
    await missionHubAuditStore.missionHubAuditLog.create({
      data: {
        organizationId: resolvedActor.organizationId,
        actorUserId: resolvedActor.userId,
        actorRole: resolvedActor.role,
        action,
        resourceType: meta?.resourceType || "",
        resourceId: meta?.resourceId ?? null,
        oldValue: meta?.oldValue as never,
        newValue: meta?.newValue as never,
        ipAddress: req.ip || null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        metadata: meta?.metadata || {},
      },
    } as Record<string, unknown>);
  } catch {
    // Audit logging must never block the primary request.
  }
}

type PrismaWithProgramSubscription = typeof prisma & {
  organizationProgramSubscription: {
    upsert: (args: Record<string, unknown>) => Promise<{ id: string; status: string }>;
  };
};

const prismaWithProgramSubscription = prisma as PrismaWithProgramSubscription;

async function ensureMissionHubSubscription(organizationId: string): Promise<void> {
  try {
    await prismaWithProgramSubscription.organizationProgramSubscription.upsert({
      where: {
        organizationId_programId: {
          organizationId,
          programId: MISSION_HUB_PROGRAM_DOMAIN,
        },
      } as Record<string, unknown>,
      update: {
        status: "active",
        subscriptionSource: "manual",
        startsAt: new Date(),
        notes: "Auto-provisioned on Mission Hub login",
      } as Record<string, unknown>,
      create: {
        organizationId,
        programId: MISSION_HUB_PROGRAM_DOMAIN,
        status: "active",
        subscriptionSource: "manual",
        startsAt: new Date(),
        notes: "Auto-provisioned on Mission Hub login",
      } as Record<string, unknown>,
    });
  } catch (error) {
    logger.error("[mission-hub] Failed to auto-provision subscription", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface MissionHubTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain: string;
}

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (key && ["token", "accessToken", "authToken", "missionHubToken"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function decodeMissionHubToken(token: string): MissionHubTokenPayload | undefined {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as MissionHubTokenPayload;
    if (payload.programDomain !== MISSION_HUB_PROGRAM_DOMAIN) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function readMissionHubSessionId(req: Request): string | undefined {
  const fromParsedCookies = req.cookies?.missionHubSessionId;
  if (typeof fromParsedCookies === "string" && fromParsedCookies.trim()) {
    return fromParsedCookies;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    if (rawKey?.trim() === "missionHubSessionId") {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

async function requireMissionHubAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readTokenFromRequest(req);
  if (token) {
    const payload = decodeMissionHubToken(token);
    if (payload) {
      (req as Request & { missionHubUser: MissionHubTokenPayload }).missionHubUser = payload;
      next();
      return;
    }
  }

  const sessionId = readMissionHubSessionId(req);
  if (!sessionId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const db = getInviteStore();
  const session = await (db as unknown as {
    missionHubSession: {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<unknown>;
    };
  }).missionHubSession.findUnique({
    where: { id: sessionId },
  } as Record<string, unknown>) as Record<string, unknown> | null;

  if (!session) {
    res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  const expiresAt = session.expiresAt instanceof Date
    ? session.expiresAt
    : new Date(String(session.expiresAt));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
    try {
      await (db as unknown as {
        missionHubSession: { delete: (args: Record<string, unknown>) => Promise<unknown> };
      }).missionHubSession.delete({
        where: { id: sessionId },
      } as Record<string, unknown>);
    } catch {
      // Session can already be deleted. Continue clearing cookie.
    }
    res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  const user = await (db as unknown as {
    user: { findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).user.findUnique({
    where: { id: session.userId as string },
  } as Record<string, unknown>) as Record<string, unknown> | null;

  if (!user) {
    res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
    res.status(401).json({ error: "User not found" });
    return;
  }

  (req as Request & { missionHubUser: MissionHubTokenPayload }).missionHubUser = {
    userId: String(user.id || ""),
    email: String(user.email || ""),
    role: String(user.role || "member"),
    organizationId: String(session.organizationId || ""),
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
  };
  next();
}

function getUser(req: Request): MissionHubTokenPayload {
  return (req as Request & { missionHubUser: MissionHubTokenPayload }).missionHubUser;
}

const MISSION_PROJECT_STATUSES = new Set(["active", "paused", "completed", "archived"]);

function normalizeProjectStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return MISSION_PROJECT_STATUSES.has(normalized) ? normalized : null;
}

function isValidOptionalDate(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const TIME_ENTRY_STATUSES = new Set([
  "draft",
  "submitted",
  "finance_review",
  "under_review",
  "changes_requested",
  "approved",
  "finance_ready",
  "finance_processed",
  "paid",
  "billed",
  "exported",
  "rejected",
  "processed",
  "archived",
]);

const TIMESHEET_APPROVER_ROLES = new Set(["finance", "admin", "executive director", "deputy director", "reviewer"]);
const TIMESHEET_PROCESSOR_ROLES = new Set(["finance", "admin", "executive director", "deputy director"]);
const TIMESHEET_EXPORTER_ROLES = new Set(["finance", "admin", "executive director", "deputy director"]);
const DOCUMENT_WRITE_ROLES = new Set(["staff", "uploader", "reviewer", "finance", "admin", "executive director", "deputy director"]);
const ADMIN_ROLES = new Set(["admin", "executive director", "deputy director"]);

// Personnel roles that require the requester to hold an admin role to assign.
// A non-admin cannot elevate another person (or themselves) to these roles.
const ELEVATED_PERSONNEL_ROLES = new Set([
  "executive director",
  "deputy director",
  "finance",
  "admin",
  "program manager",
]);

// Minimum milliseconds between consecutive resends for the same invite.
const INVITE_RESEND_COOLDOWN_MS = 60_000;
const LOCKED_ENTRY_STATUSES = new Set([
  "submitted",
  "finance_review",
  "under_review",
  "approved",
  "finance_ready",
  "finance_processed",
  "processed",
  "paid",
  "billed",
  "exported",
  "archived",
]);

function normalizeRoleValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function normalizeApprovalStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function normalizeTimeEntryStatus(value: unknown): string {
  if (typeof value !== "string") return "draft";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "processed_paid") return "finance_processed";
  if (normalized === "approved") return "finance_ready";
  if (normalized === "processed") return "finance_processed";
  if (normalized === "under_review") return "finance_review";
  return TIME_ENTRY_STATUSES.has(normalized) ? normalized : "draft";
}

function canApproveTimesheets(role: unknown): boolean {
  return TIMESHEET_APPROVER_ROLES.has(normalizeRoleValue(role));
}

function canProcessTimesheets(role: unknown): boolean {
  return TIMESHEET_PROCESSOR_ROLES.has(normalizeRoleValue(role));
}

function canExportTimesheets(role: unknown): boolean {
  return TIMESHEET_EXPORTER_ROLES.has(normalizeRoleValue(role));
}

function canWriteDocuments(role: unknown): boolean {
  return DOCUMENT_WRITE_ROLES.has(normalizeRoleValue(role));
}

function requireMissionHubDocumentWrite(req: Request, res: Response, next: NextFunction): void {
  const { role } = getUser(req);
  if (!canWriteDocuments(role)) {
    res.status(403).json({ error: "Missing capability: canWriteDocuments." });
    return;
  }
  next();
}

function isAdminRole(role: unknown): boolean {
  return ADMIN_ROLES.has(normalizeRoleValue(role));
}

function isValidPeriod(start: unknown, end: unknown): boolean {
  if (typeof start !== "string" || typeof end !== "string") return false;
  if (!start.trim() || !end.trim()) return false;
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return false;
  return start <= end;
}

function summarizeTimeEntries(entries: Array<Record<string, unknown>>) {
  let totalHours = 0;
  let payableHours = 0;
  let volunteerHours = 0;
  let billableHours = 0;
  let estimatedPayableAmount = 0;
  let estimatedBillableAmount = 0;
  let grantLaborValue = 0;
  let volunteerMatchValue = 0;

  for (const entry of entries) {
    const hours = typeof entry.hours === "number" ? entry.hours : 0;
    const hourlyRate = typeof entry.hourlyRate === "number" ? entry.hourlyRate : 0;
    const laborValue = typeof entry.laborValue === "number" ? entry.laborValue : hours * hourlyRate;
    const isPayable = Boolean(entry.payable);
    const isVolunteer = Boolean(entry.volunteer);
    const isBillable = Boolean(entry.billable);

    totalHours += hours;
    if (isPayable) payableHours += hours;
    if (isVolunteer) volunteerHours += hours;
    if (isBillable) billableHours += hours;
    if (isPayable) estimatedPayableAmount += laborValue;
    if (isBillable) estimatedBillableAmount += laborValue;
    if (entry.grantId || entry.linkedGrant) grantLaborValue += laborValue;
    if (isVolunteer) volunteerMatchValue += laborValue;
  }

  return {
    totalHours,
    payableHours,
    volunteerHours,
    billableHours,
    estimatedPayableAmount,
    estimatedBillableAmount,
    grantLaborValue,
    volunteerMatchValue,
  };
}

function isLockedForNormalEdit(status: unknown): boolean {
  return LOCKED_ENTRY_STATUSES.has(normalizeTimeEntryStatus(status));
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ─── Invite token helpers ─────────────────────────────────────────────────────

function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function inviteExpiresAt(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

type InviteStore = {
  missionHubInvite: {
    findUnique: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    findFirst: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findMany: (a: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  };
  missionHubPersonnel: {
    findFirst: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    update: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    create: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  user: {
    findUnique: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    findFirst: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  membership: {
    findFirst: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

function getInviteStore(): InviteStore {
  return prisma as unknown as InviteStore;
}

function mapPersonnelRoleToMembership(role: string): "owner" | "admin" | "manager" | "member" | "viewer" {
  switch (role) {
    case "Executive Director": return "owner";
    case "Deputy Director": return "admin";
    case "Finance":
    case "Admin": return "manager";
    case "Board Member":
    case "Staff": return "member";
    case "Volunteer": return "viewer";
    default: return "member";
  }
}

function mapPersonnelRoleToUserRole(role: string): "admin" | "reviewer" | "uploader" | "staff" | "volunteer" | "board_member" {
  switch (role) {
    case "Executive Director":
    case "Deputy Director": return "admin";
    case "Finance": return "reviewer";
    case "Board Member": return "board_member";
    case "Staff": return "staff";
    case "Volunteer": return "volunteer";
    default: return "uploader";
  }
}

// ─── Public auth routes (no auth required) ────────────────────────────────────

router.post("/auth/login", LOGIN_RATE_LIMIT, async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const db = getInviteStore();

  type UserRow = {
    id: string; email: string; passwordHash: string; role: string; organizationId: string;
    firstName: string; lastName: string; displayName: string; identitySource: string | null;
  };
  const user = await (db as unknown as { user: { findUnique: (a: Record<string, unknown>) => Promise<UserRow | null> } })
    .user.findUnique({ where: { email } }) as UserRow | null;

  if (!user) {
    // Constant-time delay to prevent timing attacks
    await hashPassword("__dummy__");
    void auditMissionHubEvent(req, "auth.login.failed", undefined, {
      resourceType: "auth",
      metadata: { email, reason: "unknown_email" },
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    void auditMissionHubEvent(req, "auth.login.failed", {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    }, {
      resourceType: "auth",
      resourceId: user.id,
      metadata: { email, reason: "bad_password" },
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Find their MissionHubPersonnel record (if any)
  const personnel = await db.missionHubPersonnel.findFirst({
    where: { organizationId: user.organizationId, email },
  }) as Record<string, unknown> | null;

  // Create a server-backed session (valid for 30 days)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await (db as unknown as {
    missionHubSession: { create: (a: Record<string, unknown>) => Promise<{ id: string }> }
  }).missionHubSession.create({
    data: {
      userId: user.id,
      organizationId: user.organizationId,
      expiresAt,
    },
  } as Record<string, unknown>) as { id: string };

  // Set HTTP-only cookie with session ID (not the full token)
  res.cookie("missionHubSessionId", session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
    path: "/",
  });

  await ensureMissionHubSubscription(user.organizationId);

  logger.info("[mission-hub] User logged in", { userId: user.id, organizationId: user.organizationId });
  void auditMissionHubEvent(req, "auth.login", {
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
  }, {
    resourceType: "auth",
    resourceId: user.id,
  });

  // Return user info without the token (session is managed via secure cookie)
  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.displayName,
      organizationId: user.organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      personnelId: personnel ? String(personnel.id) : undefined,
    },
  });
});

// Check if user has a valid session cookie and return their user info
router.get("/session", async (req, res) => {
  const sessionId = req.cookies?.missionHubSessionId || req.cookies?.["missionHubSessionId"];
  if (!sessionId) {
    res.status(401).json({ error: "No session" });
    return;
  }

  const db = getInviteStore();

  // Find and validate the session
  const session = await (db as unknown as {
    missionHubSession: { findUnique: (a: Record<string, unknown>) => Promise<Record<string, unknown> | null> }
  }).missionHubSession.findUnique({
    where: { id: sessionId },
  } as Record<string, unknown>) as Record<string, unknown> | null;

  const sessionExpiresAt = session
    ? (session.expiresAt instanceof Date ? session.expiresAt : new Date(String(session.expiresAt)))
    : null;

  if (!session || !sessionExpiresAt || Number.isNaN(sessionExpiresAt.getTime()) || sessionExpiresAt < new Date()) {
    // Session expired or invalid
    res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  const userId = session.userId as string;
  const organizationId = session.organizationId as string;

  // Fetch user data
  type UserRow = {
    id: string; email: string; role: string;
    firstName: string; lastName: string; displayName: string;
  };
  const user = await (db as unknown as { user: { findUnique: (a: Record<string, unknown>) => Promise<UserRow | null> } })
    .user.findUnique({ where: { id: userId } }) as UserRow | null;

  if (!user) {
    res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
    res.status(401).json({ error: "User not found" });
    return;
  }

  // Find their MissionHubPersonnel record (if any)
  const personnel = await db.missionHubPersonnel.findFirst({
    where: { organizationId, email: user.email },
  }) as Record<string, unknown> | null;

  logger.info("[mission-hub] Session validated", { userId, organizationId });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.displayName,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      personnelId: personnel ? String(personnel.id) : undefined,
    },
  });
});

// Logout: invalidate the session
router.post("/logout", async (req, res) => {
  const sessionId = req.cookies?.missionHubSessionId || req.cookies?.["missionHubSessionId"];
  
  if (sessionId) {
    const db = getInviteStore();
    try {
      await (db as unknown as {
        missionHubSession: { delete: (a: Record<string, unknown>) => Promise<unknown> }
      }).missionHubSession.delete({
        where: { id: sessionId },
      } as Record<string, unknown>);
    } catch {
      // Session already deleted or doesn't exist, that's fine
    }
  }

  // Clear the session cookie
  res.clearCookie("missionHubSessionId", { httpOnly: true, path: "/" });
  res.json({ success: true });
});

router.post("/auth/forgot-password", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  // Always respond with success to prevent user enumeration
  const db = getInviteStore();
  type UserRow = { id: string; firstName: string; lastName: string; email: string };
  const user = await (db as unknown as { user: { findUnique: (a: Record<string, unknown>) => Promise<UserRow | null> } })
    .user.findUnique({ where: { email } }) as UserRow | null;

  if (user) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await (db as unknown as {
      user: { update: (a: Record<string, unknown>) => Promise<unknown> }
    }).user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt },
    });

    const recipientName = [user.firstName, user.lastName].filter(Boolean).join(" ") || email;
    await sendPasswordResetEmail({ to: email, recipientName, rawToken });
  }

  // Always return 200 to avoid leaking whether the email exists
  res.json({ success: true, message: "If that email is registered, a reset link has been sent." });
});

router.post("/auth/reset-password", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!rawToken || !password) {
    res.status(400).json({ error: "token and password are required" });
    return;
  }
  if (password !== confirmPassword) {
    res.status(400).json({ error: "Passwords do not match" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const db = getInviteStore();

  type UserRow = { id: string; passwordResetTokenHash: string | null; passwordResetExpiresAt: Date | null };
  const user = await (db as unknown as {
    user: { findFirst: (a: Record<string, unknown>) => Promise<UserRow | null> }
  }).user.findFirst({ where: { passwordResetTokenHash: tokenHash } }) as UserRow | null;

  if (!user) {
    res.status(400).json({ error: "This reset link is invalid or has already been used." });
    return;
  }
  if (!user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt) < new Date()) {
    // Clear the expired token
    await (db as unknown as { user: { update: (a: Record<string, unknown>) => Promise<unknown> } })
      .user.update({ where: { id: user.id }, data: { passwordResetTokenHash: null, passwordResetExpiresAt: null } });
    res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    return;
  }

  const passwordHash = await hashPassword(password);
  await (db as unknown as { user: { update: (a: Record<string, unknown>) => Promise<unknown> } })
    .user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordSetAt: new Date(),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

  logger.info("[mission-hub] Password reset completed", { userId: user.id });
  res.json({ success: true });
});

// ─── Public invite routes (no auth required) ──────────────────────────────────

router.get("/invites/validate", INVITE_RATE_LIMIT, async (req, res) => {
  const raw = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!raw) { res.status(400).json({ error: "token is required" }); return; }

  const db = getInviteStore();
  const invite = await db.missionHubInvite.findUnique({ where: { tokenHash: hashToken(raw) } });

  if (!invite) { res.status(404).json({ error: "invalid" }); return; }
  if (invite.status === "revoked") { res.status(410).json({ error: "revoked" }); return; }
  if (invite.status === "accepted") { res.status(410).json({ error: "already_accepted" }); return; }
  if (new Date(invite.expiresAt as string) < new Date()) {
    await db.missionHubInvite.update({ where: { tokenHash: hashToken(raw) }, data: { status: "expired" } });
    res.status(410).json({ error: "expired" }); return;
  }

  const org = await prisma.organization.findUnique({ where: { id: invite.organizationId as string } });

  res.json({
    recipientName: invite.recipientName,
    recipientEmail: invite.recipientEmail,
    assignedRole: invite.assignedRole,
    assignedPosition: invite.assignedPosition,
    organizationName: org?.name ?? "Your Organization",
  });
});

router.post("/invites/accept", INVITE_RATE_LIMIT, async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const raw = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!raw || !password) { res.status(400).json({ error: "token and password are required" }); return; }
  if (password !== confirmPassword) { res.status(400).json({ error: "Passwords do not match" }); return; }
  if (password.length < 8) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }

  const db = getInviteStore();
  const tokenHash = hashToken(raw);
  const invite = await db.missionHubInvite.findUnique({ where: { tokenHash } });

  if (!invite) { res.status(404).json({ error: "invalid" }); return; }
  if (invite.status === "revoked") { res.status(410).json({ error: "revoked" }); return; }
  if (invite.status === "accepted") { res.status(410).json({ error: "already_accepted" }); return; }
  if (new Date(invite.expiresAt as string) < new Date()) {
    await db.missionHubInvite.update({ where: { tokenHash }, data: { status: "expired" } });
    res.status(410).json({ error: "expired" }); return;
  }

  const email = (invite.recipientEmail as string).toLowerCase();
  const organizationId = invite.organizationId as string;
  const passwordHash = await hashPassword(password);
  const membershipRole = mapPersonnelRoleToMembership(invite.assignedRole as string);
  const userRole = mapPersonnelRoleToUserRole(invite.assignedRole as string);

  let userId: string;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    userId = existing.id as string;
    const [firstName, ...rest] = (invite.recipientName as string).trim().split(" ");
    const lastName = rest.join(" ");
    await db.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        role: userRole,
        organizationId,
        firstName: firstName ?? "",
        lastName: lastName ?? "",
        displayName: invite.recipientName as string,
        mustChangePassword: false,
        isActive: true,
        passwordSetAt: new Date(),
      },
    });
  } else {
    const [firstName, ...rest] = (invite.recipientName as string).trim().split(" ");
    const lastName = rest.join(" ");
    const newUser = await db.user.create({
      data: {
        email,
        passwordHash,
        role: userRole,
        organizationId,
        firstName: firstName ?? "",
        lastName: lastName ?? "",
        displayName: invite.recipientName as string,
        mustChangePassword: false,
        isActive: true,
      },
    });
    userId = newUser.id as string;
  }

  const hasMembership = await db.membership.findFirst({ where: { userId, organizationId } });
  if (!hasMembership) {
    await db.membership.create({ data: { userId, organizationId, role: membershipRole } });
  }

  await db.missionHubPersonnel.update({
    where: { id: invite.personnelId as string },
    data: { inviteStatus: "accepted", status: "Active" },
  });

  await db.missionHubInvite.update({
    where: { tokenHash },
    data: { status: "accepted", acceptedAt: new Date() },
  });

  logger.info("[invite] Account activated", { email, organizationId });
  res.json({ success: true });
});

// ─── Platform Auth / Consume ──────────────────────────────────────────────────

router.post("/platform-auth/consume", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const launchToken =
    typeof body.launchToken === "string" ? body.launchToken :
    typeof body.token === "string" ? body.token : undefined;

  if (!launchToken) {
    res.status(400).json({ error: "launchToken is required" });
    return;
  }

  let claims: { userId: string; email: string; role: string; organizationId: string } | undefined;
  let launchTokenErrorCode: string | undefined;

  try {
    const payload = jwt.verify(launchToken, PLATFORM_LAUNCH_TOKEN_SECRET) as Record<string, unknown>;
    const userId = typeof payload.userId === "string" ? payload.userId : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : undefined;
    const role = typeof payload.role === "string" ? payload.role : "member";
    if (userId && email && organizationId) claims = { userId, email, role, organizationId };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      launchTokenErrorCode = "launch_token_expired";
    } else if (error instanceof jwt.JsonWebTokenError) {
      launchTokenErrorCode = "launch_token_signature_mismatch";
    } else {
      launchTokenErrorCode = "invalid_launch_token";
    }
  }

  if (!claims) {
    res.status(401).json({ error: "Invalid or expired launch token", code: launchTokenErrorCode || "invalid_launch_token" });
    return;
  }

  const missionHubToken = signToken({
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    organizationId: claims.organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
  });

  const db = getInviteStore();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await (db as unknown as {
    missionHubSession: { create: (args: Record<string, unknown>) => Promise<{ id: string }> };
  }).missionHubSession.create({
    data: {
      userId: claims.userId,
      organizationId: claims.organizationId,
      expiresAt,
    },
  } as Record<string, unknown>) as { id: string };

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("missionHubSessionId", session.id, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  // Keep legacy token cookie while clients transition to session-backed auth.
  res.cookie("missionHubToken", missionHubToken, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({
    token: missionHubToken,
    user: {
      id: claims.userId,
      email: claims.email,
      role: claims.role,
      organizationId: claims.organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });

  logger.info("[mission-hub] platform-auth/consume success", {
    userId: claims.userId,
    organizationId: claims.organizationId,
  });
});

// ─── Subscription gate ────────────────────────────────────────────────────────
// All routes below require a valid Mission Hub JWT and an active subscription.
router.use(requireMissionHubAuth, requireProgramSubscription("mission-hub"));

// ─── Programs ────────────────────────────────────────────────────────────────

router.get("/programs", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const programs = await store.missionHubProgram.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(programs);
});

router.get("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const program = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!program) { res.status(404).json({ error: "Program not found" }); return; }
  res.json(program);
});

router.post("/programs", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProgram: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const program = await store.missionHubProgram.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      category: typeof body.category === "string" ? body.category : "",
      manager: typeof body.manager === "string" ? body.manager : "",
      status: typeof body.status === "string" ? body.status : "Active",
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      budget: typeof body.budget === "string" ? body.budget : "",
      budgetAmount: typeof body.budgetAmount === "number" ? body.budgetAmount : 0,
      progress: typeof body.progress === "number" ? body.progress : 0,
      description: typeof body.description === "string" ? body.description : "",
      targetAudience: typeof body.targetAudience === "string" ? body.targetAudience : "",
      team: Array.isArray(body.team) ? body.team : [],
      timeEntries: Array.isArray(body.timeEntries) ? body.timeEntries : [],
      budgetItems: Array.isArray(body.budgetItems) ? body.budgetItems : [],
      supporters: Array.isArray(body.supporters) ? body.supporters : [],
      sponsors: Array.isArray(body.sponsors) ? body.sponsors : [],
      documents: Array.isArray(body.documents) ? body.documents : [],
      tasks: Array.isArray(body.tasks) ? body.tasks : [],
      outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
    },
  });
  res.status(201).json(program);
});

router.put("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProgram: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Program not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["name", "category", "manager", "status", "startDate", "budget", "description", "targetAudience"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.budgetAmount === "number") data.budgetAmount = body.budgetAmount;
  if (typeof body.progress === "number") data.progress = body.progress;
  const jsonFields = ["team", "timeEntries", "budgetItems", "supporters", "sponsors", "documents", "tasks", "outcomes"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubProgram.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Program not found" }); return; }
  await store.missionHubProgram.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Projects ────────────────────────────────────────────────────────────────

router.get("/projects", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { programId, status, search, query } = req.query;
  const store = prisma as unknown as {
    missionHubProject: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };

  if (typeof programId === "string" && programId.trim()) {
    where.programId = programId.trim();
  }

  if (typeof status === "string" && status.trim()) {
    const normalizedStatus = normalizeProjectStatus(status);
    if (!normalizedStatus) {
      res.status(400).json({ error: "status must be one of: active, paused, completed, archived" });
      return;
    }
    where.status = normalizedStatus;
  }

  const searchValue = typeof search === "string" && search.trim()
    ? search.trim()
    : typeof query === "string" && query.trim()
      ? query.trim()
      : "";
  if (searchValue) {
    where.OR = [
      { name: { contains: searchValue, mode: "insensitive" } },
      { description: { contains: searchValue, mode: "insensitive" } },
      { managerName: { contains: searchValue, mode: "insensitive" } },
    ];
  }

  const projects = await store.missionHubProject.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { name: "asc" }],
  });
  res.json(projects);
});

router.get("/projects/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProject: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const project = await store.missionHubProject.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
    },
  });
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(project);
});

router.post("/projects", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProject: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubProgram: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    missionHubCampaign: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const normalizedStatus = normalizeProjectStatus(body.status ?? "active");
  if (!normalizedStatus) {
    res.status(400).json({ error: "status must be one of: active, paused, completed, archived" });
    return;
  }

  const normalizedProgramId = typeof body.programId === "string" && body.programId.trim() ? body.programId.trim() : null;
  const normalizedCampaignId = typeof body.fundraisingCampaignId === "string" && body.fundraisingCampaignId.trim()
    ? body.fundraisingCampaignId.trim()
    : null;

  if (normalizedCampaignId) {
    const linkedCampaign = await store.missionHubCampaign.findFirst({
      where: {
        id: normalizedCampaignId,
        organizationId,
        userId,
        isActive: true,
      },
    });
    if (!linkedCampaign) {
      res.status(400).json({ error: "fundraisingCampaignId must reference an existing campaign" });
      return;
    }
  }

  if (normalizedProgramId) {
    const linkedProgram = await store.missionHubProgram.findFirst({
      where: {
        id: normalizedProgramId,
        organizationId,
        userId,
        isActive: true,
      },
    });
    if (!linkedProgram) {
      res.status(400).json({ error: "programId must reference an existing program" });
      return;
    }
  }

  if (!isValidOptionalDate(body.startDate) || !isValidOptionalDate(body.endDate)) {
    res.status(400).json({ error: "startDate and endDate must be valid dates when supplied" });
    return;
  }

  const project = await store.missionHubProject.create({
    data: {
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      programId: normalizedProgramId,
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description : "",
      status: normalizedStatus,
      managerId: typeof body.managerId === "string" ? body.managerId : null,
      managerName: typeof body.managerName === "string" ? body.managerName : null,
      grantId: typeof body.grantId === "string" ? body.grantId : null,
      grantName: typeof body.grantName === "string" ? body.grantName : null,
      sponsorId: typeof body.sponsorId === "string" ? body.sponsorId : null,
      sponsorName: typeof body.sponsorName === "string" ? body.sponsorName : null,
        fundraisingCampaignId: normalizedCampaignId,
      budget: typeof body.budget === "number" ? body.budget : 0,
      startDate: typeof body.startDate === "string" && body.startDate ? body.startDate : null,
      endDate: typeof body.endDate === "string" && body.endDate ? body.endDate : null,
    },
  });
  res.status(201).json(project);
});

router.put("/projects/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    missionHubProgram: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    missionHubCampaign: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  const existing = await store.missionHubProject.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if ("name" in body && (typeof body.name !== "string" || !body.name.trim())) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  if ("status" in body) {
    const normalizedStatus = normalizeProjectStatus(body.status);
    if (!normalizedStatus) {
      res.status(400).json({ error: "status must be one of: active, paused, completed, archived" });
      return;
    }
  }

  if (("startDate" in body && !isValidOptionalDate(body.startDate)) || ("endDate" in body && !isValidOptionalDate(body.endDate))) {
    res.status(400).json({ error: "startDate and endDate must be valid dates when supplied" });
    return;
  }

  if ("programId" in body) {
    const nextProgramId = typeof body.programId === "string" && body.programId.trim() ? body.programId.trim() : null;
    if (nextProgramId) {
      const linkedProgram = await store.missionHubProgram.findFirst({
        where: {
          id: nextProgramId,
          organizationId,
          userId,
          isActive: true,
        },
      });
      if (!linkedProgram) {
        res.status(400).json({ error: "programId must reference an existing program" });
        return;
      }
    }
  }

  if ("fundraisingCampaignId" in body) {
    const nextCampaignId = typeof body.fundraisingCampaignId === "string" && body.fundraisingCampaignId.trim()
      ? body.fundraisingCampaignId.trim()
      : null;
    if (nextCampaignId) {
      const linkedCampaign = await store.missionHubCampaign.findFirst({
        where: {
          id: nextCampaignId,
          organizationId,
          userId,
          isActive: true,
        },
      });
      if (!linkedCampaign) {
        res.status(400).json({ error: "fundraisingCampaignId must reference an existing campaign" });
        return;
      }
    }
  }

  const data: Record<string, unknown> = {};
  if ("programId" in body) data.programId = typeof body.programId === "string" && body.programId.trim() ? body.programId.trim() : null;
  if (typeof body.name === "string") data.name = body.name.trim();
  if ("description" in body) data.description = typeof body.description === "string" ? body.description : "";
  if ("status" in body) data.status = normalizeProjectStatus(body.status);
  if ("managerId" in body) data.managerId = typeof body.managerId === "string" ? body.managerId : null;
  if ("managerName" in body) data.managerName = typeof body.managerName === "string" ? body.managerName : null;
  if ("grantId" in body) data.grantId = typeof body.grantId === "string" ? body.grantId : null;
  if ("grantName" in body) data.grantName = typeof body.grantName === "string" ? body.grantName : null;
  if ("sponsorId" in body) data.sponsorId = typeof body.sponsorId === "string" ? body.sponsorId : null;
  if ("sponsorName" in body) data.sponsorName = typeof body.sponsorName === "string" ? body.sponsorName : null;
    if ("fundraisingCampaignId" in body) {
      data.fundraisingCampaignId = typeof body.fundraisingCampaignId === "string" && body.fundraisingCampaignId.trim()
        ? body.fundraisingCampaignId.trim()
        : null;
    }
  if ("budget" in body) data.budget = typeof body.budget === "number" ? body.budget : 0;
  if ("startDate" in body) data.startDate = typeof body.startDate === "string" && body.startDate ? body.startDate : null;
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" && body.endDate ? body.endDate : null;

  const updated = await store.missionHubProject.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/projects/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubProject.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  await store.missionHubProject.update({ where: { id: req.params.id }, data: { isActive: false, status: "archived" } });
  res.status(204).send();
});

// ─── Grants ───────────────────────────────────────────────────────────────────

router.get("/grants", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const grants = await store.missionHubGrant.findMany({
    where: { organizationId, isActive: true },
    orderBy: { grantName: "asc" },
  });
  res.json(grants);
});

router.get("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const grant = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!grant) { res.status(404).json({ error: "Grant not found" }); return; }
  res.json(grant);
});

router.post("/grants", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubGrant: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.grantName !== "string" || !body.grantName.trim()) {
    res.status(400).json({ error: "grantName is required" }); return;
  }
  const grant = await store.missionHubGrant.create({
    data: {
      organizationId, userId,
      grantName: (body.grantName as string).trim(),
      fundingSource: typeof body.fundingSource === "string" ? body.fundingSource : "",
      amountAwarded: typeof body.amountAwarded === "number" ? body.amountAwarded : 0,
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      status: typeof body.status === "string" ? body.status : "Active",
      grantManager: typeof body.grantManager === "string" ? body.grantManager : "",
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      reportingStatus: typeof body.reportingStatus === "string" ? body.reportingStatus : "",
      requirements: Array.isArray(body.requirements) ? body.requirements : [],
      budgetAllocation: Array.isArray(body.budgetAllocation) ? body.budgetAllocation : [],
      reportingDeadlines: Array.isArray(body.reportingDeadlines) ? body.reportingDeadlines : [],
    },
  });
  res.status(201).json(grant);
});

router.put("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubGrant: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Grant not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["grantName", "fundingSource", "status", "grantManager", "reportingStatus"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.amountAwarded === "number") data.amountAwarded = body.amountAwarded;
  if (typeof body.startDate === "string") data.startDate = body.startDate;
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  const jsonFields = ["linkedPrograms", "requirements", "budgetAllocation", "reportingDeadlines"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubGrant.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Grant not found" }); return; }
  await store.missionHubGrant.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Expenses ─────────────────────────────────────────────────────────────────

router.get("/expenses", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { category, approvalStatus } = req.query;
  const store = prisma as unknown as {
    missionHubExpense: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, isActive: true };
  if (typeof category === "string") where.category = category;
  if (typeof approvalStatus === "string") where.approvalStatus = approvalStatus;
  const expenses = await store.missionHubExpense.findMany({ where, orderBy: { date: "desc" } });
  res.json(expenses);
});

router.get("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubExpense: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const expense = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json(expense);
});

router.post("/expenses", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubExpense: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.expenseName !== "string" || !body.expenseName.trim()) {
    res.status(400).json({ error: "expenseName is required" }); return;
  }
  const nullStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const expense = await store.missionHubExpense.create({
    data: {
      organizationId, userId,
      expenseName: (body.expenseName as string).trim(),
      amount: typeof body.amount === "number" ? body.amount : 0,
      date: typeof body.date === "string" ? body.date : "",
      category: typeof body.category === "string" ? body.category : "",
      customCategory: nullStr(body.customCategory),
      type: typeof body.type === "string" ? body.type : "",
      expenseScope: nullStr(body.expenseScope),
      customExpenseScope: nullStr(body.customExpenseScope),
      linkedProgramId: nullStr(body.linkedProgramId),
      linkedProgram: nullStr(body.linkedProgram),
      linkedProjectId: nullStr(body.linkedProjectId),
      linkedProject: nullStr(body.linkedProject),
      linkedEventId: nullStr(body.linkedEventId),
      linkedEvent: nullStr(body.linkedEvent),
      linkedGrantId: nullStr(body.linkedGrantId),
      linkedGrant: nullStr(body.linkedGrant),
      linkedSponsorId: nullStr(body.linkedSponsorId),
      linkedSponsor: nullStr(body.linkedSponsor),
      linkedFundraisingCampaignId: nullStr(body.linkedFundraisingCampaignId),
      linkedFundraisingCampaign: nullStr(body.linkedFundraisingCampaign),
      linkedCampaign: nullStr(body.linkedCampaign) ?? nullStr(body.linkedFundraisingCampaign),
      fundingSourceType: nullStr(body.fundingSourceType),
      fundingSourceId: nullStr(body.fundingSourceId),
      customFundingSource: nullStr(body.customFundingSource),
      fundingSource: nullStr(body.fundingSource),
      billable: body.billable === true,
      reimbursable: body.reimbursable === true,
      notes: typeof body.notes === "string" ? body.notes : "",
      approvalStatus: typeof body.approvalStatus === "string" ? body.approvalStatus : "Pending",
      recurring: body.recurring === true,
      receiptFileId: nullStr(body.receiptFileId),
      receiptUrl: nullStr(body.receiptUrl),
      receiptName: nullStr(body.receiptName),
      receiptFileMeta: body.receiptFileMeta && typeof body.receiptFileMeta === "object" && !Array.isArray(body.receiptFileMeta)
        ? body.receiptFileMeta
        : undefined,
    },
  });
  void auditMissionHubEvent(req, "expense.create", getUser(req), {
    resourceType: "expense",
    resourceId: String(expense.id || ""),
    newValue: expense,
  });
  res.status(201).json(expense);
});

router.put("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }

  const nextApprovalStatus = typeof body.approvalStatus === "string" ? body.approvalStatus.trim() : "";
  const currentApprovalStatus = typeof (existing as Record<string, unknown>).approvalStatus === "string"
    ? String((existing as Record<string, unknown>).approvalStatus)
    : "";
  const isApprovalChange = Boolean(nextApprovalStatus) && nextApprovalStatus !== currentApprovalStatus;
  if (isApprovalChange) {
    if (!canApproveExpenses(getUser(req).role)) {
      res.status(403).json({ error: "You are not allowed to change approval status" });
      return;
    }
    if (normalizeApprovalStatus(nextApprovalStatus) === "approved" && String((existing as Record<string, unknown>).userId || "") === userId && normalizeRoleValue(getUser(req).role) !== "admin") {
      res.status(403).json({ error: "You cannot approve your own expense" });
      return;
    }
  }

  const data: Record<string, unknown> = {};
  const strFields = ["expenseName", "date", "category", "type", "notes", "approvalStatus",
    "expenseScope", "customExpenseScope", "customCategory"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.amount === "number") data.amount = body.amount;
  if (typeof body.recurring === "boolean") data.recurring = body.recurring;
  if (typeof body.billable === "boolean") data.billable = body.billable;
  if (typeof body.reimbursable === "boolean") data.reimbursable = body.reimbursable;
  const nullableStrFields = [
    "linkedProgramId", "linkedProgram", "linkedProjectId", "linkedProject",
    "linkedEventId", "linkedEvent", "linkedGrantId", "linkedGrant",
    "linkedSponsorId", "linkedSponsor", "linkedFundraisingCampaignId", "linkedFundraisingCampaign",
    "linkedCampaign", "fundingSourceType", "fundingSourceId", "customFundingSource", "fundingSource",
    "receiptFileId", "receiptUrl", "receiptName",
    "rejectReason", "reviewerNote",
  ] as const;
  for (const f of nullableStrFields) { if (f in body) data[f] = typeof body[f] === "string" ? body[f] : null; }
  if ("receiptFileMeta" in body) {
    data.receiptFileMeta = body.receiptFileMeta && typeof body.receiptFileMeta === "object" && !Array.isArray(body.receiptFileMeta)
      ? body.receiptFileMeta
      : null;
  }
  if ("reviewedAt" in body) {
    data.reviewedAt = typeof body.reviewedAt === "string" && body.reviewedAt ? new Date(body.reviewedAt) : null;
  }

  const updated = await store.missionHubExpense.update({ where: { id: req.params.id }, data });
  if (isApprovalChange) {
    void auditMissionHubEvent(req, "expense.approval.changed", getUser(req), {
      resourceType: "expense",
      resourceId: String(req.params.id),
      oldValue: { approvalStatus: currentApprovalStatus },
      newValue: { approvalStatus: nextApprovalStatus },
      metadata: { source: "expenses.put" },
    });
  }
  res.json(updated);
});

router.post("/expenses/:id/approve", requireMissionHubAuth, async (req, res) => {
  const user = getUser(req);
  if (!canApproveExpenses(user.role)) {
    res.status(403).json({ error: "You are not allowed to approve expenses" });
    return;
  }

  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId: user.organizationId, isActive: true } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }
  if (String((existing as Record<string, unknown>).userId || "") === user.userId && normalizeRoleValue(user.role) !== "admin") {
    res.status(403).json({ error: "You cannot approve your own expense" });
    return;
  }

  const updated = await store.missionHubExpense.update({
    where: { id: req.params.id },
    data: { approvalStatus: "Approved", reviewedAt: new Date() },
  });

  void auditMissionHubEvent(req, "expense.approve", user, {
    resourceType: "expense",
    resourceId: String(req.params.id),
    oldValue: { approvalStatus: (existing as Record<string, unknown>).approvalStatus },
    newValue: { approvalStatus: "Approved" },
  });

  res.json(updated);
});

router.post("/expenses/:id/reject", requireMissionHubAuth, async (req, res) => {
  const user = getUser(req);
  if (!canApproveExpenses(user.role)) {
    res.status(403).json({ error: "You are not allowed to reject expenses" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const reviewerNote = typeof body.reviewerNote === "string" ? body.reviewerNote.trim() : "";
  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId: user.organizationId, isActive: true } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }

  const updated = await store.missionHubExpense.update({
    where: { id: req.params.id },
    data: {
      approvalStatus: "Rejected",
      reviewedAt: new Date(),
      reviewerNote: reviewerNote || null,
      rejectReason: reviewerNote || null,
    },
  });

  void auditMissionHubEvent(req, "expense.reject", user, {
    resourceType: "expense",
    resourceId: String(req.params.id),
    oldValue: { approvalStatus: (existing as Record<string, unknown>).approvalStatus },
    newValue: { approvalStatus: "Rejected", reviewerNote: reviewerNote || null },
  });

  res.json(updated);
});

router.delete("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }
  await store.missionHubExpense.update({ where: { id: req.params.id }, data: { isActive: false } });
  void auditMissionHubEvent(req, "expense.delete", getUser(req), {
    resourceType: "expense",
    resourceId: String(req.params.id),
    oldValue: existing,
    newValue: { isActive: false },
  });
  res.status(204).send();
});

// ─── Sponsors ─────────────────────────────────────────────────────────────────

router.get("/sponsors", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { status } = req.query;
  const store = prisma as unknown as {
    missionHubSponsor: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, isActive: true };
  if (typeof status === "string") where.status = status;
  const sponsors = await store.missionHubSponsor.findMany({ where, orderBy: { organizationName: "asc" } });
  res.json(sponsors);
});

router.get("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSponsor: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const sponsor = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!sponsor) { res.status(404).json({ error: "Sponsor not found" }); return; }
  res.json(sponsor);
});

router.post("/sponsors", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSponsor: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.organizationName !== "string" || !body.organizationName.trim()) {
    res.status(400).json({ error: "organizationName is required" }); return;
  }
  const sponsor = await store.missionHubSponsor.create({
    data: {
      organizationId, userId,
      organizationName: (body.organizationName as string).trim(),
      sponsorType: typeof body.sponsorType === "string" ? body.sponsorType : "",
      contactName: typeof body.contactName === "string" ? body.contactName : "",
      email: typeof body.email === "string" ? body.email : "",
      phone: typeof body.phone === "string" ? body.phone : "",
      contributionAmount: typeof body.contributionAmount === "number" ? body.contributionAmount : 0,
      contributionType: typeof body.contributionType === "string" ? body.contributionType : "",
      paymentStatus: typeof body.paymentStatus === "string" ? body.paymentStatus : "",
      status: typeof body.status === "string" ? body.status : "Active",
      notes: typeof body.notes === "string" ? body.notes : "",
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      linkedCampaigns: Array.isArray(body.linkedCampaigns) ? body.linkedCampaigns : [],
      linkedItems: Array.isArray(body.linkedItems) ? body.linkedItems : [],
    },
  });
  res.status(201).json(sponsor);
});

router.put("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSponsor: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Sponsor not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["organizationName", "sponsorType", "contactName", "email", "phone", "contributionType", "paymentStatus", "status", "notes"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.contributionAmount === "number") data.contributionAmount = body.contributionAmount;
  const jsonFields = ["linkedPrograms", "linkedCampaigns", "linkedItems"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubSponsor.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSponsor: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Sponsor not found" }); return; }
  await store.missionHubSponsor.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

router.get("/campaigns", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { status } = req.query;
  const store = prisma as unknown as {
    missionHubCampaign: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, isActive: true };
  if (typeof status === "string") where.status = status;
  const campaigns = await store.missionHubCampaign.findMany({ where, orderBy: { name: "asc" } });
  res.json(campaigns);
});

router.get("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCampaign: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const campaign = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

router.post("/campaigns", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCampaign: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const campaign = await store.missionHubCampaign.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      category: typeof body.category === "string" ? body.category : "Event",
      status: typeof body.status === "string" ? body.status : "Planning",
      owner: typeof body.owner === "string" ? body.owner : "",
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      goalAmount: typeof body.goalAmount === "number" ? body.goalAmount : 0,
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      tiers: Array.isArray(body.tiers) ? body.tiers : [],
      items: Array.isArray(body.items) ? body.items : [],
      donations: Array.isArray(body.donations) ? body.donations : [],
      events: Array.isArray(body.events) ? body.events : [],
      expenses: Array.isArray(body.expenses) ? body.expenses : [],
      documents: Array.isArray(body.documents) ? body.documents : [],
    },
  });
  res.status(201).json(campaign);
});

router.put("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCampaign: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["name", "category", "status", "owner", "startDate"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.goalAmount === "number") data.goalAmount = body.goalAmount;
  const jsonFields = ["linkedPrograms", "tiers", "items", "donations", "events", "expenses", "documents"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubCampaign.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCampaign: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }
  await store.missionHubCampaign.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Personnel ────────────────────────────────────────────────────────────────

router.get("/personnel", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { status, type } = req.query;
  const store = prisma as unknown as {
    missionHubPersonnel: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, isActive: true };
  if (typeof status === "string") where.status = status;
  if (typeof type === "string") where.type = type;
  const personnel = await store.missionHubPersonnel.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  res.json(personnel);
});

router.get("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubPersonnel: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const person = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, isActive: true } });
  if (!person) { res.status(404).json({ error: "Personnel record not found" }); return; }
  res.json(person);
});

router.post("/personnel", requireMissionHubAuth, INVITE_RATE_LIMIT, async (req, res) => {
  const { userId, organizationId, role: requesterRole } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  if (typeof body.firstName !== "string" || !body.firstName.trim()) {
    res.status(400).json({ error: "firstName is required" }); return;
  }
  if (typeof body.lastName !== "string" || !body.lastName.trim()) {
    res.status(400).json({ error: "lastName is required" }); return;
  }

  const db = getInviteStore();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role : "Admin";

  // Guard: only admins/executives may assign elevated roles to new personnel.
  const normalizedRequestedRole = normalizeRoleValue(role);
  if (ELEVATED_PERSONNEL_ROLES.has(normalizedRequestedRole)) {
    const normalizedRequesterRole = normalizeRoleValue(requesterRole);
    if (!ADMIN_ROLES.has(normalizedRequesterRole)) {
      res.status(403).json({ error: "You do not have permission to assign this role." });
      return;
    }
  }
  const title = typeof body.title === "string" ? body.title : "";
  const firstName = (body.firstName as string).trim();
  const lastName = (body.lastName as string).trim();
  const recipientName = `${firstName} ${lastName}`.trim();

  const person = await db.missionHubPersonnel.create({
    data: {
      organizationId, userId,
      firstName,
      lastName,
      email,
      phone: typeof body.phone === "string" ? body.phone : "",
      title,
      department: typeof body.department === "string" ? body.department : "",
      type: typeof body.type === "string" ? body.type : "Staff",
      role,
      status: "Inactive",
      inviteStatus: "invite_created",
      accessLevel: typeof body.accessLevel === "string" ? body.accessLevel : "Basic",
      assignedPrograms: Array.isArray(body.assignedPrograms) ? body.assignedPrograms : [],
      assignedGrants: Array.isArray(body.assignedGrants) ? body.assignedGrants : [],
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  });

  // Create invite record
  const inviteResult = await issueMissionHubInvite({
    organizationId,
    personnelId: person.id as string,
    recipientEmail: email,
    recipientName,
    assignedRole: role,
    assignedPosition: title,
    createdByAdminId: userId,
  });

  res.status(201).json({
    ...person,
    inviteStatus: inviteResult.inviteStatus,
    invite: {
      id: inviteResult.inviteId,
      emailSent: inviteResult.emailSent,
      emailStatus: inviteResult.emailStatus,
      inviteLink: inviteResult.inviteLink,
    },
  });
});

router.put("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId, role: requesterRole } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubPersonnel: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Personnel record not found" }); return; }

  // Guard: only admins/executives may assign or change to elevated roles.
  if (typeof body.role === "string") {
    const normalizedRequestedRole = normalizeRoleValue(body.role);
    if (ELEVATED_PERSONNEL_ROLES.has(normalizedRequestedRole)) {
      const normalizedRequesterRole = normalizeRoleValue(requesterRole);
      if (!ADMIN_ROLES.has(normalizedRequesterRole)) {
        res.status(403).json({ error: "You do not have permission to assign this role." });
        return;
      }
    }
  }

  const data: Record<string, unknown> = {};
  const strFields = ["firstName", "lastName", "email", "phone", "title", "department", "type", "role", "status", "accessLevel", "notes"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  const jsonFields = ["assignedPrograms", "assignedGrants"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubPersonnel.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubPersonnel: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Personnel record not found" }); return; }
  await store.missionHubPersonnel.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Access Controls ─────────────────────────────────────────────────────────

router.get("/access-controls", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubPersonnel: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const rows = await store.missionHubPersonnel.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const accessControls = rows.map((person) => ({
    id: String(person.id || ""),
    personnelId: String(person.id || ""),
    role: String(person.role || "Admin"),
    permissions: [],
    effectiveDate: person.createdAt instanceof Date
      ? person.createdAt.toISOString().slice(0, 10)
      : String(person.createdAt || "").slice(0, 10),
    expiryDate: null,
    notes: String(person.notes || ""),
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  }));

  res.json(accessControls);
});

router.put("/access-controls/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubPersonnel: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubPersonnel.findFirst({
    where: { id: req.params.id, organizationId, isActive: true },
  });

  if (!existing) {
    res.status(404).json({ error: "Access control record not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.role === "string") data.role = body.role;
  if (typeof body.accessLevel === "string") data.accessLevel = body.accessLevel;
  if (typeof body.notes === "string") data.notes = body.notes;

  if (Object.keys(data).length > 0) {
    await store.missionHubPersonnel.update({ where: { id: req.params.id }, data });
  }

  const refreshed = await store.missionHubPersonnel.findFirst({
    where: { id: req.params.id, organizationId, isActive: true },
  });

  if (!refreshed) {
    res.status(404).json({ error: "Access control record not found" });
    return;
  }

  res.json({
    id: String(refreshed.id || ""),
    personnelId: String(refreshed.id || ""),
    role: String(refreshed.role || "Admin"),
    permissions: [],
    effectiveDate: refreshed.createdAt instanceof Date
      ? refreshed.createdAt.toISOString().slice(0, 10)
      : String(refreshed.createdAt || "").slice(0, 10),
    expiryDate: null,
    notes: String(refreshed.notes || ""),
    createdAt: refreshed.createdAt,
    updatedAt: refreshed.updatedAt,
  });
});

// ─── Invites (admin) ──────────────────────────────────────────────────────────

router.get("/invites", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const db = getInviteStore();
  const invites = await db.missionHubInvite.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" } as Record<string, unknown>,
  });
  res.json(invites);
});

router.post("/invites/:id/resend", requireMissionHubAuth, INVITE_RATE_LIMIT, async (req, res) => {
  const { organizationId } = getUser(req);
  try {
    const inviteId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await resendMissionHubInvite(organizationId, inviteId, INVITE_RESEND_COOLDOWN_MS);
    res.json(result);
  } catch (error) {
    if (error instanceof MissionHubInviteServiceError) {
      if (typeof error.retryAfterSeconds === "number") {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(typeof error.retryAfterSeconds === "number" ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
      return;
    }
    logger.error("[invite] resend failed unexpectedly", { error });
    res.status(500).json({ error: "Failed to resend invite" });
  }
});

router.delete("/invites/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const db = getInviteStore();

  const invite = await db.missionHubInvite.findFirst({
    where: { id: req.params.id, organizationId },
  });
  if (!invite) { res.status(404).json({ error: "Invite not found" }); return; }

  await db.missionHubInvite.update({
    where: { id: req.params.id },
    data: { status: "revoked", revokedAt: new Date() },
  });
  await db.missionHubPersonnel.update({
    where: { id: invite.personnelId as string },
    data: { inviteStatus: "revoked" },
  });

  res.status(204).send();
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

router.get("/tasks", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { status } = req.query;
  const store = prisma as unknown as {
    missionHubTask: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };
  if (typeof status === "string") where.status = status;

  const tasks = await store.missionHubTask.findMany({ where, orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }] });
  res.json(tasks);
});

router.post("/tasks", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubTask: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const taskNullStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const completedAt = body.status === "Done" ? new Date() : null;
  const task = await store.missionHubTask.create({
    data: {
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      title: body.title.trim(),
      description: typeof body.description === "string" ? body.description : "",
      assignedTo: typeof body.assignedTo === "string" ? body.assignedTo : "",
      assignedPersonId: taskNullStr(body.assignedPersonId),
      owner: typeof body.owner === "string" ? body.owner : "",
      dueDate: typeof body.dueDate === "string" ? body.dueDate : "",
      completedAt,
      priority: typeof body.priority === "string" ? body.priority : "Medium",
      status: typeof body.status === "string" ? body.status : "To Do",
      linkedProgramId: taskNullStr(body.linkedProgramId),
      linkedProgram: taskNullStr(body.linkedProgram),
      linkedProjectId: taskNullStr(body.linkedProjectId),
      linkedProject: taskNullStr(body.linkedProject),
      linkedEventId: taskNullStr(body.linkedEventId),
      linkedEvent: taskNullStr(body.linkedEvent),
      linkedGrantId: taskNullStr(body.linkedGrantId),
      linkedGrant: taskNullStr(body.linkedGrant),
      linkedSponsorId: taskNullStr(body.linkedSponsorId),
      linkedSponsor: taskNullStr(body.linkedSponsor),
      linkedFundraisingCampaignId: taskNullStr(body.linkedFundraisingCampaignId),
      linkedFundraisingCampaign: taskNullStr(body.linkedFundraisingCampaign),
    },
  });

  res.status(201).json(task);
});

router.put("/tasks/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubTask: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubTask.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  const strFields = ["title", "description", "assignedTo", "owner", "dueDate", "priority", "status"] as const;
  for (const f of strFields) {
    if (typeof body[f] === "string") data[f] = body[f];
  }
  // Set completedAt when status transitions to Done, clear it otherwise.
  if (typeof body.status === "string") {
    data.completedAt = body.status === "Done" ? new Date() : null;
  }
  const taskNullableFields = [
    "linkedProgramId", "linkedProgram", "linkedProjectId", "linkedProject",
    "linkedEventId", "linkedEvent", "linkedGrantId", "linkedGrant",
    "linkedSponsorId", "linkedSponsor", "linkedFundraisingCampaignId", "linkedFundraisingCampaign",
    "assignedPersonId",
  ] as const;
  for (const f of taskNullableFields) {
    if (f in body) data[f] = typeof body[f] === "string" ? body[f] : null;
  }

  const updated = await store.missionHubTask.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/tasks/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubTask: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubTask.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  await store.missionHubTask.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Time Entries ────────────────────────────────────────────────────────────

router.get("/time-entries", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const role = normalizeRoleValue(getUser(req).role);
  const { status, dateFrom, dateTo, timesheetSubmissionId } = req.query;
  const store = prisma as unknown as {
    missionHubTimeEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };
  if (!canApproveTimesheets(role)) {
    where.userId = userId;
  }
  if (typeof status === "string") where.status = normalizeTimeEntryStatus(status);
  if (typeof timesheetSubmissionId === "string") {
    where.timesheetSubmissionId = timesheetSubmissionId;
  }
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.date = {};
    if (typeof dateFrom === "string") (where.date as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.date as Record<string, unknown>).lte = dateTo;
  }

  const entries = await store.missionHubTimeEntry.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] });
  res.json(entries);
});

router.post("/time-entries", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubTimeEntry: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.person !== "string" || !body.person.trim()) {
    res.status(400).json({ error: "person is required" });
    return;
  }
  if (typeof body.date !== "string" || !body.date.trim()) {
    res.status(400).json({ error: "date is required" });
    return;
  }

  const entryStatus = normalizeTimeEntryStatus(body.status);
  const now = new Date();
  const entry = await store.missionHubTimeEntry.create({
    data: {
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      personId: toOptionalString(body.personId),
      person: body.person.trim(),
      initials: typeof body.initials === "string" ? body.initials : "",
      date: body.date,
      startTime: typeof body.startTime === "string" ? body.startTime : "",
      endTime: typeof body.endTime === "string" ? body.endTime : "",
      hours: typeof body.hours === "number" ? body.hours : 0,
      programId: toOptionalString(body.programId),
      projectId: toOptionalString(body.projectId),
      projectName: toOptionalString(body.projectName),
      grantId: toOptionalString(body.grantId),
      sponsorId: toOptionalString(body.sponsorId),
      fundraisingCampaignId: toOptionalString(body.fundraisingCampaignId),
      fundingSourceType: toOptionalString(body.fundingSourceType),
      fundingSourceId: toOptionalString(body.fundingSourceId),
      linkedGrant: toOptionalString(body.linkedGrant),
      linkedSponsor: toOptionalString(body.linkedSponsor),
      notes: typeof body.notes === "string" ? body.notes : "",
      status: entryStatus,
      eventId: toOptionalString(body.eventId),
      eventName: toOptionalString(body.eventName),
      timesheetSubmissionId: toOptionalString(body.timesheetSubmissionId),
      billable: Boolean(body.billable),
      payable: Boolean(body.payable),
      volunteer: Boolean(body.volunteer),
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : null,
      laborValue: typeof body.laborValue === "number" ? body.laborValue : null,
      submittedAt: entryStatus === "submitted" ? now : null,
      approvedAt: entryStatus === "approved" || entryStatus === "finance_ready" ? now : null,
      processedAt: entryStatus === "processed" || entryStatus === "finance_processed" ? now : null,
    },
  });

  res.status(201).json(entry);
});

router.put("/time-entries/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubTimeEntry.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  if (isLockedForNormalEdit(existing.status)) {
    res.status(409).json({ error: "Submitted/approved/processed time entries are locked from normal editing." });
    return;
  }

  const data: Record<string, unknown> = {};
  const strFields = ["person", "initials", "date", "startTime", "endTime", "notes"] as const;
  for (const f of strFields) {
    if (typeof body[f] === "string") data[f] = body[f];
  }
  if (typeof body.hours === "number") data.hours = body.hours;
  if ("status" in body) data.status = normalizeTimeEntryStatus(body.status);

  const nullableStrFields = [
    "personId",
    "programId",
    "projectId",
    "projectName",
    "grantId",
    "sponsorId",
    "fundraisingCampaignId",
    "fundingSourceType",
    "fundingSourceId",
    "linkedGrant",
    "linkedSponsor",
    "eventId",
    "eventName",
    "timesheetSubmissionId",
  ] as const;
  for (const f of nullableStrFields) {
    if (f in body) data[f] = typeof body[f] === "string" ? body[f] : null;
  }
  if ("billable" in body) data.billable = Boolean(body.billable);
  if ("payable" in body) data.payable = Boolean(body.payable);
  if ("volunteer" in body) data.volunteer = Boolean(body.volunteer);
  if ("hourlyRate" in body) data.hourlyRate = typeof body.hourlyRate === "number" ? body.hourlyRate : null;
  if ("laborValue" in body) data.laborValue = typeof body.laborValue === "number" ? body.laborValue : null;

  const updated = await store.missionHubTimeEntry.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/time-entries/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.missionHubTimeEntry.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  if (isLockedForNormalEdit(existing.status)) {
    res.status(409).json({ error: "Submitted/approved/processed time entries are locked from deletion." });
    return;
  }

  await store.missionHubTimeEntry.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Timesheet Submissions ───────────────────────────────────────────────────

router.get("/timesheet-submissions", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId, role } = getUser(req);
  const { status, personId, dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    missionHubTimesheetSubmission: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };
  if (!canApproveTimesheets(role)) {
    where.submittedByUserId = userId;
  }
  if (typeof status === "string") where.status = normalizeTimeEntryStatus(status);
  if (typeof personId === "string") where.submittedByPersonId = personId;
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.periodStart = {};
    if (typeof dateFrom === "string") (where.periodStart as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.periodStart as Record<string, unknown>).lte = dateTo;
  }

  const items = await store.missionHubTimesheetSubmission.findMany({ where, orderBy: [{ createdAt: "desc" }] });
  res.json(items);
});

router.get("/timesheet-submissions/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId, role } = getUser(req);
  const store = prisma as unknown as {
    missionHubTimesheetSubmission: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    missionHubTimeEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
    missionHubTimesheetApprovalLog: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = {
    id: req.params.id,
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };
  if (!canApproveTimesheets(role)) {
    where.submittedByUserId = userId;
  }

  const submission = await store.missionHubTimesheetSubmission.findFirst({ where });
  if (!submission) {
    res.status(404).json({ error: "Timesheet submission not found" });
    return;
  }

  const [entries, approvalHistory] = await Promise.all([
    store.missionHubTimeEntry.findMany({
      where: {
        organizationId,
        programDomain: MISSION_HUB_PROGRAM_DOMAIN,
        isActive: true,
        timesheetSubmissionId: req.params.id,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    store.missionHubTimesheetApprovalLog.findMany({
      where: {
        organizationId,
        programDomain: MISSION_HUB_PROGRAM_DOMAIN,
        timesheetSubmissionId: req.params.id,
      },
      orderBy: [{ createdAt: "desc" }],
    }),
  ]);

  res.json({ ...submission, entries, approvalHistory });
});

router.post("/timesheet-submissions", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId, role } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubTimeEntry: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
      updateMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    missionHubTimesheetSubmission: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubTimesheetApprovalLog: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  const entryIds = Array.isArray(body.entryIds) ? body.entryIds.filter((id): id is string => typeof id === "string") : [];
  if (entryIds.length === 0) {
    res.status(400).json({ error: "A submission must include at least one draft/change-requested time entry." });
    return;
  }

  if (!isValidPeriod(body.periodStart, body.periodEnd)) {
    res.status(400).json({ error: "periodStart and periodEnd must be valid and periodStart must be <= periodEnd." });
    return;
  }

  const whereEntries: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
    id: { in: entryIds },
    status: { in: ["draft", "changes_requested"] },
  };
  if (!canApproveTimesheets(role)) {
    whereEntries.userId = userId;
  }

  const entries = await store.missionHubTimeEntry.findMany({ where: whereEntries });
  if (entries.length === 0 || entries.length !== entryIds.length) {
    res.status(400).json({ error: "All selected entries must be accessible and in draft/changes requested state." });
    return;
  }

  const summary = summarizeTimeEntries(entries);
  if (summary.totalHours <= 0) {
    res.status(400).json({ error: "Total hours must be greater than 0." });
    return;
  }

  const submission = await store.missionHubTimesheetSubmission.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      submittedByPersonId: typeof body.submittedByPersonId === "string" ? body.submittedByPersonId : null,
      submittedByUserId: userId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      status: "submitted",
      ...summary,
      submittedAt: new Date(),
    },
  });

  await store.missionHubTimeEntry.updateMany({
    where: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
      id: { in: entryIds },
    },
    data: {
      status: "submitted",
      timesheetSubmissionId: submission.id,
      submittedAt: new Date(),
    },
  });

  await store.missionHubTimesheetApprovalLog.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      timesheetSubmissionId: submission.id,
      action: "submitted",
      actorUserId: userId,
      actorPersonId: typeof body.submittedByPersonId === "string" ? body.submittedByPersonId : null,
      actorRole: typeof role === "string" ? role : null,
      note: typeof body.financeNotes === "string" ? body.financeNotes : null,
    },
  });

  res.status(201).json(submission);
});

router.post("/timesheet-submissions/:id/submit", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubTimesheetSubmission: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    missionHubTimeEntry: { updateMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubTimesheetApprovalLog: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  const submission = await store.missionHubTimesheetSubmission.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      submittedByUserId: userId,
      isActive: true,
    },
  });
  if (!submission) {
    res.status(404).json({ error: "Timesheet submission not found" });
    return;
  }

  const updated = await store.missionHubTimesheetSubmission.update({
    where: { id: req.params.id },
    data: { status: "submitted", submittedAt: new Date() },
  });

  await store.missionHubTimeEntry.updateMany({
    where: { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, timesheetSubmissionId: req.params.id, isActive: true },
    data: { status: "submitted", submittedAt: new Date() },
  });

  await store.missionHubTimesheetApprovalLog.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      timesheetSubmissionId: req.params.id,
      action: "submitted",
      actorUserId: userId,
      actorRole: getUser(req).role,
    },
  });

  res.json(updated);
});

async function handleSubmissionAction(
  req: Request,
  res: Response,
  action: "approved" | "rejected" | "changes_requested" | "finance_processed" | "paid" | "billed" | "exported" | "reopened",
) {
  const { userId, organizationId, role } = getUser(req);
  const isApprovalAction = action === "approved" || action === "rejected" || action === "changes_requested" || action === "reopened";
  const isProcessingAction = action === "finance_processed" || action === "paid" || action === "billed";
  const isExportAction = action === "exported";

  if (isApprovalAction && !canApproveTimesheets(role)) {
    res.status(403).json({ error: "Missing capability: canApproveTimesheets." });
    return;
  }
  if (isProcessingAction && !canProcessTimesheets(role)) {
    res.status(403).json({ error: "Missing capability: canProcessTimesheets." });
    return;
  }
  if (isExportAction && !canExportTimesheets(role)) {
    res.status(403).json({ error: "Missing capability: canExportTimesheets." });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const note = typeof body.reason === "string" ? body.reason.trim() : typeof body.note === "string" ? body.note.trim() : "";
  if ((action === "rejected" || action === "changes_requested") && !note) {
    res.status(400).json({ error: "A reason is required for reject/request-changes actions." });
    return;
  }

  const store = prisma as unknown as {
    missionHubTimesheetSubmission: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    missionHubTimeEntry: { updateMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubTimesheetApprovalLog: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  const submission = await store.missionHubTimesheetSubmission.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
    },
  });
  if (!submission) {
    res.status(404).json({ error: "Timesheet submission not found" });
    return;
  }

  if (!isAdminRole(role) && submission.submittedByUserId === userId) {
    res.status(403).json({ error: "You cannot approve your own submission without admin permissions." });
    return;
  }

  const currentStatus = normalizeTimeEntryStatus(submission.status);
  const nextStatus =
    action === "approved" ? "finance_ready"
      : action === "finance_processed" ? "finance_processed"
        : action;

  if (nextStatus === "finance_processed" && currentStatus !== "finance_ready") {
    res.status(409).json({ error: "Only Finance Ready submissions can be marked finance processed." });
    return;
  }
  if ((nextStatus === "paid" || nextStatus === "billed") && currentStatus !== "finance_processed") {
    res.status(409).json({ error: "Only finance processed submissions can be marked paid or billed." });
    return;
  }
  if (nextStatus === "exported" && !["finance_ready", "finance_processed", "paid", "billed"].includes(currentStatus)) {
    res.status(409).json({ error: "Only finance-ready/processed/paid/billed submissions can be exported." });
    return;
  }

  const now = new Date();
  const updateData: Record<string, unknown> = {
    status: nextStatus,
    reviewedByUserId: userId,
    reviewedAt: now,
  };
  if (action === "rejected") updateData.rejectionReason = note;
  if (action === "changes_requested") updateData.changeRequestReason = note;
  if (action === "approved") {
    updateData.financeNotes = note || null;
    updateData.approvedAt = now;
  }
  if (action === "finance_processed") {
    updateData.processedAt = now;
    updateData.financeNotes = note || null;
  }
  if (action === "paid" || action === "billed" || action === "exported") {
    updateData.financeNotes = note || null;
  }

  const updatedSubmission = await store.missionHubTimesheetSubmission.update({ where: { id: req.params.id }, data: updateData });

  const entryStatus =
    action === "reopened" ? "finance_review"
      : action === "approved" ? "finance_ready"
        : nextStatus;
  const entryData: Record<string, unknown> = { status: entryStatus };
  if (action === "approved") entryData.approvedAt = now;
  if (action === "finance_processed") entryData.processedAt = now;
  if (action === "changes_requested") {
    entryData.timesheetSubmissionId = null;
  }

  await store.missionHubTimeEntry.updateMany({
    where: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      isActive: true,
      timesheetSubmissionId: req.params.id,
    },
    data: entryData,
  });

  await store.missionHubTimesheetApprovalLog.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      timesheetSubmissionId: req.params.id,
      action,
      actorUserId: userId,
      actorRole: role,
      note: note || null,
    },
  });

  res.json(updatedSubmission);
}

router.post("/timesheet-submissions/:id/approve", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "approved");
});

router.post("/timesheet-submissions/:id/reject", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "rejected");
});

router.post("/timesheet-submissions/:id/request-changes", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "changes_requested");
});

router.post("/timesheet-submissions/:id/mark-processed", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "finance_processed");
});

router.post("/timesheet-submissions/:id/mark-reviewed", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "finance_processed");
});

router.post("/timesheet-submissions/:id/mark-paid", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "paid");
});

router.post("/timesheet-submissions/:id/mark-billed", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "billed");
});

router.post("/timesheet-submissions/:id/mark-exported", requireMissionHubAuth, EXPORT_RATE_LIMIT, async (req, res) => {
  await handleSubmissionAction(req, res, "exported");
});

router.post("/timesheet-submissions/:id/reopen", requireMissionHubAuth, async (req, res) => {
  await handleSubmissionAction(req, res, "reopened");
});

// ─── Contacts ────────────────────────────────────────────────────────────────

type SqlStore = {
  $executeRawUnsafe: (query: string, ...params: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = Record<string, unknown>>(query: string, ...params: unknown[]) => Promise<T[]>;
};

let contactsTablesReadyPromise: Promise<void> | null = null;

async function ensureContactsTables(store: SqlStore): Promise<void> {
  if (!contactsTablesReadyPromise) {
    contactsTablesReadyPromise = (async () => {
      await store.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MissionHubContact" (
          "id" TEXT NOT NULL,
          "organizationId" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "firstName" TEXT NOT NULL DEFAULT '',
          "lastName" TEXT NOT NULL DEFAULT '',
          "fullName" TEXT NOT NULL DEFAULT '',
          "email" TEXT,
          "phone" TEXT,
          "organization" TEXT,
          "title" TEXT,
          "address" TEXT,
          "city" TEXT,
          "state" TEXT,
          "zip" TEXT,
          "type" TEXT,
          "tags" JSONB NOT NULL DEFAULT '[]',
          "source" TEXT,
          "notes" TEXT,
          "linkedEntities" JSONB NOT NULL DEFAULT '[]',
          "archivedAt" TIMESTAMP(3),
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "MissionHubContact_pkey" PRIMARY KEY ("id")
        );
      `);

      await store.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "MissionHubContact_orgUser_idx"
        ON "MissionHubContact" ("organizationId", "userId", "isActive");
      `);

      await store.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "MissionHubContact_orgUser_email_idx"
        ON "MissionHubContact" ("organizationId", "userId", "email");
      `);

      await store.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MissionHubContactList" (
          "id" TEXT NOT NULL,
          "organizationId" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "description" TEXT,
          "type" TEXT,
          "contactIds" JSONB NOT NULL DEFAULT '[]',
          "tags" JSONB NOT NULL DEFAULT '[]',
          "archivedAt" TIMESTAMP(3),
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "MissionHubContactList_pkey" PRIMARY KEY ("id")
        );
      `);

      await store.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "MissionHubContactList_orgUser_idx"
        ON "MissionHubContactList" ("organizationId", "userId", "isActive");
      `);
    })();
  }

  await contactsTablesReadyPromise;
}

function normalizeContactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeContactTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter(Boolean);
}

router.get("/contacts", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const includeArchived = String(req.query.includeArchived || "false").toLowerCase() === "true";
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const whereArchived = includeArchived ? "" : `AND "archivedAt" IS NULL`;
  const rows = await store.$queryRawUnsafe(
    `
      SELECT *
      FROM "MissionHubContact"
      WHERE "organizationId" = $1
        AND "userId" = $2
        AND "isActive" = true
        ${whereArchived}
      ORDER BY "createdAt" DESC
    `,
    organizationId,
    userId,
  );

  res.json(rows);
});

router.post("/contacts", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const firstName = normalizeContactText(body.firstName) || "";
  const lastName = normalizeContactText(body.lastName) || "";
  const incomingFullName = normalizeContactText(body.fullName) || "";
  const fullName = incomingFullName || [firstName, lastName].filter(Boolean).join(" ").trim();
  const email = normalizeContactText(body.email)?.toLowerCase() || null;
  const phone = normalizeContactText(body.phone);
  const organization = normalizeContactText(body.organization);

  if (!fullName && !email && !phone && !organization) {
    res.status(400).json({ error: "At least one of name, email, phone, or organization is required" });
    return;
  }

  const id = crypto.randomUUID();
  const tags = normalizeContactTags(body.tags);
  const linkedEntities = Array.isArray(body.linkedEntities) ? body.linkedEntities : [];

  const createdRows = await store.$queryRawUnsafe(
    `
      INSERT INTO "MissionHubContact" (
        "id", "organizationId", "userId", "firstName", "lastName", "fullName", "email", "phone", "organization",
        "title", "address", "city", "state", "zip", "type", "tags", "source", "notes", "linkedEntities", "archivedAt", "updatedAt"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20::timestamp, NOW()
      )
      RETURNING *
    `,
    id,
    organizationId,
    userId,
    firstName,
    lastName,
    fullName,
    email,
    phone,
    organization,
    normalizeContactText(body.title),
    normalizeContactText(body.address),
    normalizeContactText(body.city),
    normalizeContactText(body.state),
    normalizeContactText(body.zip),
    normalizeContactText(body.type),
    JSON.stringify(tags),
    normalizeContactText(body.source),
    normalizeContactText(body.notes),
    JSON.stringify(linkedEntities),
    body.archivedAt ? String(body.archivedAt) : null,
  );

  res.status(201).json(createdRows[0] || null);
});

router.put("/contacts/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const existingRows = await store.$queryRawUnsafe(
    `
      SELECT *
      FROM "MissionHubContact"
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3 AND "isActive" = true
      LIMIT 1
    `,
    req.params.id,
    organizationId,
    userId,
  );

  if (!existingRows[0]) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const existing = existingRows[0] as Record<string, unknown>;
  const firstName = "firstName" in body ? (normalizeContactText(body.firstName) || "") : String(existing.firstName || "");
  const lastName = "lastName" in body ? (normalizeContactText(body.lastName) || "") : String(existing.lastName || "");
  const nextFullNameRaw = "fullName" in body ? normalizeContactText(body.fullName) : normalizeContactText(existing.fullName);
  const fullName = nextFullNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim();

  const updatedRows = await store.$queryRawUnsafe(
    `
      UPDATE "MissionHubContact"
      SET
        "firstName" = $4,
        "lastName" = $5,
        "fullName" = $6,
        "email" = $7,
        "phone" = $8,
        "organization" = $9,
        "title" = $10,
        "address" = $11,
        "city" = $12,
        "state" = $13,
        "zip" = $14,
        "type" = $15,
        "tags" = $16::jsonb,
        "source" = $17,
        "notes" = $18,
        "linkedEntities" = $19::jsonb,
        "archivedAt" = $20::timestamp,
        "updatedAt" = NOW()
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3
      RETURNING *
    `,
    req.params.id,
    organizationId,
    userId,
    firstName,
    lastName,
    fullName,
    ("email" in body ? normalizeContactText(body.email) : normalizeContactText(existing.email))?.toLowerCase() || null,
    "phone" in body ? normalizeContactText(body.phone) : normalizeContactText(existing.phone),
    "organization" in body ? normalizeContactText(body.organization) : normalizeContactText(existing.organization),
    "title" in body ? normalizeContactText(body.title) : normalizeContactText(existing.title),
    "address" in body ? normalizeContactText(body.address) : normalizeContactText(existing.address),
    "city" in body ? normalizeContactText(body.city) : normalizeContactText(existing.city),
    "state" in body ? normalizeContactText(body.state) : normalizeContactText(existing.state),
    "zip" in body ? normalizeContactText(body.zip) : normalizeContactText(existing.zip),
    "type" in body ? normalizeContactText(body.type) : normalizeContactText(existing.type),
    JSON.stringify("tags" in body ? normalizeContactTags(body.tags) : (Array.isArray(existing.tags) ? existing.tags : [])),
    "source" in body ? normalizeContactText(body.source) : normalizeContactText(existing.source),
    "notes" in body ? normalizeContactText(body.notes) : normalizeContactText(existing.notes),
    JSON.stringify("linkedEntities" in body && Array.isArray(body.linkedEntities) ? body.linkedEntities : (Array.isArray(existing.linkedEntities) ? existing.linkedEntities : [])),
    "archivedAt" in body ? (body.archivedAt ? String(body.archivedAt) : null) : (existing.archivedAt ? String(existing.archivedAt) : null),
  );

  res.json(updatedRows[0] || null);
});

router.delete("/contacts/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  await store.$executeRawUnsafe(
    `
      UPDATE "MissionHubContact"
      SET "isActive" = false, "archivedAt" = COALESCE("archivedAt", NOW()), "updatedAt" = NOW()
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3
    `,
    req.params.id,
    organizationId,
    userId,
  );

  await store.$executeRawUnsafe(
    `
      UPDATE "MissionHubContactList"
      SET "contactIds" = (
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
        FROM jsonb_array_elements_text("contactIds") AS item
        WHERE item <> $1
      ),
      "updatedAt" = NOW()
      WHERE "organizationId" = $2 AND "userId" = $3 AND "isActive" = true
    `,
    req.params.id,
    organizationId,
    userId,
  );

  res.status(204).send();
});

router.get("/contact-lists", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const includeArchived = String(req.query.includeArchived || "false").toLowerCase() === "true";
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const whereArchived = includeArchived ? "" : `AND "archivedAt" IS NULL`;
  const rows = await store.$queryRawUnsafe(
    `
      SELECT *
      FROM "MissionHubContactList"
      WHERE "organizationId" = $1
        AND "userId" = $2
        AND "isActive" = true
        ${whereArchived}
      ORDER BY "createdAt" DESC
    `,
    organizationId,
    userId,
  );

  res.json(rows);
});

router.post("/contact-lists", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const name = normalizeContactText(body.name);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const id = crypto.randomUUID();
  const contactIds = normalizeContactTags(body.contactIds);
  const tags = normalizeContactTags(body.tags);

  const createdRows = await store.$queryRawUnsafe(
    `
      INSERT INTO "MissionHubContactList" (
        "id", "organizationId", "userId", "name", "description", "type", "contactIds", "tags", "archivedAt", "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamp, NOW())
      RETURNING *
    `,
    id,
    organizationId,
    userId,
    name,
    normalizeContactText(body.description),
    normalizeContactText(body.type),
    JSON.stringify(contactIds),
    JSON.stringify(tags),
    body.archivedAt ? String(body.archivedAt) : null,
  );

  res.status(201).json(createdRows[0] || null);
});

router.put("/contact-lists/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  const existingRows = await store.$queryRawUnsafe(
    `
      SELECT *
      FROM "MissionHubContactList"
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3 AND "isActive" = true
      LIMIT 1
    `,
    req.params.id,
    organizationId,
    userId,
  );

  if (!existingRows[0]) {
    res.status(404).json({ error: "Contact list not found" });
    return;
  }

  const existing = existingRows[0] as Record<string, unknown>;
  const updatedRows = await store.$queryRawUnsafe(
    `
      UPDATE "MissionHubContactList"
      SET
        "name" = $4,
        "description" = $5,
        "type" = $6,
        "contactIds" = $7::jsonb,
        "tags" = $8::jsonb,
        "archivedAt" = $9::timestamp,
        "updatedAt" = NOW()
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3
      RETURNING *
    `,
    req.params.id,
    organizationId,
    userId,
    normalizeContactText(body.name) || String(existing.name || ""),
    "description" in body ? normalizeContactText(body.description) : normalizeContactText(existing.description),
    "type" in body ? normalizeContactText(body.type) : normalizeContactText(existing.type),
    JSON.stringify("contactIds" in body ? normalizeContactTags(body.contactIds) : (Array.isArray(existing.contactIds) ? existing.contactIds : [])),
    JSON.stringify("tags" in body ? normalizeContactTags(body.tags) : (Array.isArray(existing.tags) ? existing.tags : [])),
    "archivedAt" in body ? (body.archivedAt ? String(body.archivedAt) : null) : (existing.archivedAt ? String(existing.archivedAt) : null),
  );

  res.json(updatedRows[0] || null);
});

router.delete("/contact-lists/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const store = prisma as unknown as SqlStore;
  await ensureContactsTables(store);

  await store.$executeRawUnsafe(
    `
      UPDATE "MissionHubContactList"
      SET "isActive" = false, "archivedAt" = COALESCE("archivedAt", NOW()), "updatedAt" = NOW()
      WHERE "id" = $1 AND "organizationId" = $2 AND "userId" = $3
    `,
    req.params.id,
    organizationId,
    userId,
  );

  res.status(204).send();
});

// ─── Calendar Entries ─────────────────────────────────────────────────────────

router.get("/calendar", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const { dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    missionHubCalendarEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, isActive: true };
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.date = {};
    if (typeof dateFrom === "string") (where.date as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.date as Record<string, unknown>).lte = dateTo;
  }
  const entries = await store.missionHubCalendarEntry.findMany({ where, orderBy: { date: "asc" } });
  res.json(entries);
});

router.post("/calendar", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCalendarEntry: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" }); return;
  }
  if (typeof body.date !== "string" || !body.date.trim()) {
    res.status(400).json({ error: "date is required" }); return;
  }
  const entry = await store.missionHubCalendarEntry.create({
    data: {
      organizationId, userId,
      title: (body.title as string).trim(),
      date: body.date as string,
      type: typeof body.type === "string" ? body.type : "",
      description: typeof body.description === "string" ? body.description : "",
      linkedEntity: typeof body.linkedEntity === "string" ? body.linkedEntity : null,
      linkedEntityId: typeof body.linkedEntityId === "string" ? body.linkedEntityId : null,
      linkedEventId: typeof body.linkedEventId === "string" ? body.linkedEventId : null,
    },
  });
  res.status(201).json(entry);
});

router.put("/calendar/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCalendarEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCalendarEntry.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Calendar entry not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["title", "date", "type", "description"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("linkedEntity" in body) data.linkedEntity = typeof body.linkedEntity === "string" ? body.linkedEntity : null;
  if ("linkedEntityId" in body) data.linkedEntityId = typeof body.linkedEntityId === "string" ? body.linkedEntityId : null;
  if ("linkedEventId" in body) data.linkedEventId = typeof body.linkedEventId === "string" ? body.linkedEventId : null;

  const updated = await store.missionHubCalendarEntry.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/calendar/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCalendarEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCalendarEntry.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Calendar entry not found" }); return; }
  await store.missionHubCalendarEntry.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Events ──────────────────────────────────────────────────────────────────

const VALID_EVENT_STATUSES = new Set(["planned", "scheduled", "active", "completed", "cancelled", "archived"]);
const VALID_FUNDING_SOURCE_TYPES = new Set(["grant", "sponsor", "fundraiser", "program", "general", "mixed"]);

function normalizeEventStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return VALID_EVENT_STATUSES.has(v) ? v : null;
}

function isValidDateTime(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

type EventStore = {
  missionHubEvent: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  missionHubCalendarEntry: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  missionHubProject: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  missionHubProgram: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  missionHubGrant: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  missionHubSponsor: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  missionHubCampaign: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
};

async function syncEventToCalendar(
  store: EventStore,
  organizationId: string,
  userId: string,
  event: Record<string, unknown>,
): Promise<string | null> {
  const startDate = typeof event.startDateTime === "string" ? event.startDateTime.split("T")[0] : "";
  const startTime = typeof event.startDateTime === "string" && event.startDateTime.includes("T")
    ? event.startDateTime.split("T")[1]?.slice(0, 5)
    : undefined;
  const endTime = typeof event.endDateTime === "string" && event.endDateTime.includes("T")
    ? event.endDateTime.split("T")[1]?.slice(0, 5)
    : undefined;

  const description = [
    typeof event.description === "string" ? event.description : "",
    typeof event.location === "string" && event.location ? `Location: ${event.location}` : "",
    event.isVirtual && typeof event.meetingUrl === "string" ? `Meeting URL: ${event.meetingUrl}` : "",
  ].filter(Boolean).join("\n");

  try {
    const entry = await store.missionHubCalendarEntry.create({
      data: {
        organizationId,
        userId,
        title: String(event.name || ""),
        date: startDate,
        type: "Event",
        description,
        linkedEntity: "Event",
        linkedEntityId: String(event.id || ""),
        linkedEventId: String(event.id || ""),
      },
    });
    return String(entry.id || "");
  } catch {
    return null;
  }
}

router.get("/events", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as EventStore;
  const { programId, projectId, grantId, sponsorId, fundraisingCampaignId, status, eventType, fundingSourceType, billable, dateFrom, dateTo, search, query } = req.query;

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
  };

  if (typeof programId === "string" && programId.trim()) where.programId = programId.trim();
  if (typeof projectId === "string" && projectId.trim()) where.projectId = projectId.trim();
  if (typeof grantId === "string" && grantId.trim()) where.grantId = grantId.trim();
  if (typeof sponsorId === "string" && sponsorId.trim()) where.sponsorId = sponsorId.trim();
  if (typeof fundraisingCampaignId === "string" && fundraisingCampaignId.trim()) where.fundraisingCampaignId = fundraisingCampaignId.trim();

  if (typeof status === "string" && status.trim()) {
    const ns = normalizeEventStatus(status);
    if (!ns) { res.status(400).json({ error: "status must be one of: planned, scheduled, active, completed, cancelled, archived" }); return; }
    where.status = ns;
  }
  if (typeof eventType === "string" && eventType.trim()) where.eventType = eventType.trim();
  if (typeof fundingSourceType === "string" && fundingSourceType.trim()) {
    if (!VALID_FUNDING_SOURCE_TYPES.has(fundingSourceType.trim().toLowerCase())) {
      res.status(400).json({ error: "fundingSourceType must be one of: grant, sponsor, fundraiser, program, general, mixed" }); return;
    }
    where.fundingSourceType = fundingSourceType.trim().toLowerCase();
  }
  if (billable === "true") where.billable = true;
  if (billable === "false") where.billable = false;

  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.startDateTime = {};
    if (typeof dateFrom === "string") (where.startDateTime as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.startDateTime as Record<string, unknown>).lte = dateTo;
  }

  const searchValue = typeof search === "string" && search.trim()
    ? search.trim()
    : typeof query === "string" && query.trim() ? query.trim() : "";
  if (searchValue) {
    where.OR = [
      { name: { contains: searchValue, mode: "insensitive" } },
      { description: { contains: searchValue, mode: "insensitive" } },
      { location: { contains: searchValue, mode: "insensitive" } },
      { eventType: { contains: searchValue, mode: "insensitive" } },
    ];
  }

  const events = await store.missionHubEvent.findMany({
    where,
    orderBy: [{ startDateTime: "asc" }, { name: "asc" }],
  });
  res.json(events);
});

router.get("/events/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as EventStore;
  const event = await store.missionHubEvent.findFirst({
    where: { id: req.params.id, organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, isActive: true },
  });
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.json(event);
});

router.post("/events", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as EventStore;

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }

  // Default start to now, end to 1 hour later when not provided
  const now = new Date();
  const defaultStart = now.toISOString();
  const defaultEnd = new Date(now.getTime() + 3600_000).toISOString();
  const rawStart = isValidDateTime(body.startDateTime) ? (body.startDateTime as string) : defaultStart;
  const rawEnd = isValidDateTime(body.endDateTime) ? (body.endDateTime as string) : defaultEnd;
  // Ensure end is after start
  const resolvedEnd = new Date(rawEnd) <= new Date(rawStart)
    ? new Date(new Date(rawStart).getTime() + 3600_000).toISOString()
    : rawEnd;

  const normalizedStatus = normalizeEventStatus(body.status ?? "planned");
  if (!normalizedStatus) {
    res.status(400).json({ error: "status must be one of: planned, scheduled, active, completed, cancelled, archived" }); return;
  }

  if (typeof body.fundingSourceType === "string" && body.fundingSourceType.trim()) {
    if (!VALID_FUNDING_SOURCE_TYPES.has(body.fundingSourceType.trim().toLowerCase())) {
      res.status(400).json({ error: "fundingSourceType must be one of: grant, sponsor, fundraiser, program, general, mixed" }); return;
    }
  }

  // Optional FK existence checks
  const normProgramId = typeof body.programId === "string" && body.programId.trim() ? body.programId.trim() : null;
  if (normProgramId) {
    const p = await store.missionHubProgram.findFirst({ where: { id: normProgramId, organizationId, userId, isActive: true } });
    if (!p) { res.status(400).json({ error: "programId must reference an existing program" }); return; }
  }
  const normProjectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
  if (normProjectId) {
    const p = await store.missionHubProject.findFirst({ where: { id: normProjectId, organizationId, userId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, isActive: true } });
    if (!p) { res.status(400).json({ error: "projectId must reference an existing project" }); return; }
  }
  const normGrantId = typeof body.grantId === "string" && body.grantId.trim() ? body.grantId.trim() : null;
  if (normGrantId) {
    const g = await store.missionHubGrant.findFirst({ where: { id: normGrantId, organizationId, userId, isActive: true } });
    if (!g) { res.status(400).json({ error: "grantId must reference an existing grant" }); return; }
  }
  const normSponsorId = typeof body.sponsorId === "string" && body.sponsorId.trim() ? body.sponsorId.trim() : null;
  if (normSponsorId) {
    const s = await store.missionHubSponsor.findFirst({ where: { id: normSponsorId, organizationId, userId, isActive: true } });
    if (!s) { res.status(400).json({ error: "sponsorId must reference an existing sponsor" }); return; }
  }
  const normCampaignId = typeof body.fundraisingCampaignId === "string" && body.fundraisingCampaignId.trim()
    ? body.fundraisingCampaignId.trim()
    : null;
  if (normCampaignId) {
    const c = await store.missionHubCampaign.findFirst({ where: { id: normCampaignId, organizationId, userId, isActive: true } });
    if (!c) { res.status(400).json({ error: "fundraisingCampaignId must reference an existing campaign" }); return; }
  }

  const normalizedFundingType = typeof body.fundingSourceType === "string" && body.fundingSourceType.trim()
    ? body.fundingSourceType.trim().toLowerCase()
    : null;
  if (normalizedFundingType === "grant" && body.fundingSourceId && body.fundingSourceId !== normGrantId) {
    res.status(400).json({ error: "fundingSourceId should align with grantId when fundingSourceType is grant" }); return;
  }
  if (normalizedFundingType === "sponsor" && body.fundingSourceId && body.fundingSourceId !== normSponsorId) {
    res.status(400).json({ error: "fundingSourceId should align with sponsorId when fundingSourceType is sponsor" }); return;
  }
  if (normalizedFundingType === "fundraiser" && body.fundingSourceId && body.fundingSourceId !== normCampaignId) {
    res.status(400).json({ error: "fundingSourceId should align with fundraisingCampaignId when fundingSourceType is fundraiser" }); return;
  }

  const event = await store.missionHubEvent.create({
    data: {
      organizationId,
      userId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      programId: normProgramId,
      projectId: normProjectId,
      grantId: normGrantId,
      sponsorId: normSponsorId,
      fundraisingCampaignId: normCampaignId,
      name: (body.name as string).trim(),
      description: typeof body.description === "string" ? body.description : "",
      eventType: typeof body.eventType === "string" && body.eventType.trim() ? body.eventType.trim() : null,
      status: normalizedStatus,
      startDateTime: rawStart,
      endDateTime: resolvedEnd,
      location: typeof body.location === "string" && body.location.trim() ? body.location.trim() : null,
      isVirtual: body.isVirtual === true,
      meetingUrl: typeof body.meetingUrl === "string" && body.meetingUrl.trim() ? body.meetingUrl.trim() : null,
      assignedStaffIds: Array.isArray(body.assignedStaffIds) ? body.assignedStaffIds : [],
      assignedVolunteerIds: Array.isArray(body.assignedVolunteerIds) ? body.assignedVolunteerIds : [],
      budget: typeof body.budget === "number" ? body.budget : 0,
      expectedRevenue: typeof body.expectedRevenue === "number" ? body.expectedRevenue : 0,
      actualRevenue: typeof body.actualRevenue === "number" ? body.actualRevenue : 0,
      billable: body.billable === true,
      billingCode: typeof body.billingCode === "string" && body.billingCode.trim() ? body.billingCode.trim() : null,
        fundingSourceType: normalizedFundingType,
      fundingSourceId: typeof body.fundingSourceId === "string" && body.fundingSourceId.trim() ? body.fundingSourceId.trim() : null,
    },
  });

  // Auto-create linked calendar entry
  const calendarId = await syncEventToCalendar(store, organizationId, userId, event);
  if (calendarId) {
    try {
      await store.missionHubEvent.update({ where: { id: String(event.id) }, data: { calendarEventId: calendarId } });
      event.calendarEventId = calendarId;
    } catch { /* non-fatal */ }
  }

  res.status(201).json(event);
});

router.put("/events/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as EventStore;

  const existing = await store.missionHubEvent.findFirst({
    where: { id: req.params.id, organizationId, userId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, isActive: true },
  });
  if (!existing) { res.status(404).json({ error: "Event not found" }); return; }

  if ("name" in body && (typeof body.name !== "string" || !body.name.trim())) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if ("startDateTime" in body && !isValidDateTime(body.startDateTime)) {
    res.status(400).json({ error: "startDateTime must be a valid ISO datetime" }); return;
  }
  if ("endDateTime" in body && !isValidDateTime(body.endDateTime)) {
    res.status(400).json({ error: "endDateTime must be a valid ISO datetime" }); return;
  }
  const resolvedStart = typeof body.startDateTime === "string" ? body.startDateTime : String(existing.startDateTime || "");
  const resolvedEnd = typeof body.endDateTime === "string" ? body.endDateTime : String(existing.endDateTime || "");
  if ("startDateTime" in body || "endDateTime" in body) {
    if (new Date(resolvedEnd) <= new Date(resolvedStart)) {
      res.status(400).json({ error: "endDateTime must be after startDateTime" }); return;
    }
  }

  if ("status" in body) {
    const ns = normalizeEventStatus(body.status);
    if (!ns) { res.status(400).json({ error: "status must be one of: planned, scheduled, active, completed, cancelled, archived" }); return; }
  }
  if ("fundingSourceType" in body && typeof body.fundingSourceType === "string" && body.fundingSourceType.trim()) {
    if (!VALID_FUNDING_SOURCE_TYPES.has(body.fundingSourceType.trim().toLowerCase())) {
      res.status(400).json({ error: "fundingSourceType must be one of: grant, sponsor, fundraiser, program, general, mixed" }); return;
    }
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if ("description" in body) data.description = typeof body.description === "string" ? body.description : "";
  if ("eventType" in body) data.eventType = typeof body.eventType === "string" && body.eventType.trim() ? body.eventType.trim() : null;
  if ("status" in body) data.status = normalizeEventStatus(body.status);
  if ("startDateTime" in body) data.startDateTime = body.startDateTime;
  if ("endDateTime" in body) data.endDateTime = body.endDateTime;
  if ("location" in body) data.location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : null;
  if ("isVirtual" in body) data.isVirtual = body.isVirtual === true;
  if ("meetingUrl" in body) data.meetingUrl = typeof body.meetingUrl === "string" && body.meetingUrl.trim() ? body.meetingUrl.trim() : null;
  if ("programId" in body) data.programId = typeof body.programId === "string" && body.programId.trim() ? body.programId.trim() : null;
  if ("projectId" in body) data.projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
  if ("grantId" in body) data.grantId = typeof body.grantId === "string" && body.grantId.trim() ? body.grantId.trim() : null;
  if ("sponsorId" in body) data.sponsorId = typeof body.sponsorId === "string" && body.sponsorId.trim() ? body.sponsorId.trim() : null;
  if ("fundraisingCampaignId" in body) data.fundraisingCampaignId = typeof body.fundraisingCampaignId === "string" && body.fundraisingCampaignId.trim() ? body.fundraisingCampaignId.trim() : null;
  if ("assignedStaffIds" in body) data.assignedStaffIds = Array.isArray(body.assignedStaffIds) ? body.assignedStaffIds : [];
  if ("assignedVolunteerIds" in body) data.assignedVolunteerIds = Array.isArray(body.assignedVolunteerIds) ? body.assignedVolunteerIds : [];
  if ("budget" in body) data.budget = typeof body.budget === "number" ? body.budget : 0;
  if ("expectedRevenue" in body) data.expectedRevenue = typeof body.expectedRevenue === "number" ? body.expectedRevenue : 0;
  if ("actualRevenue" in body) data.actualRevenue = typeof body.actualRevenue === "number" ? body.actualRevenue : 0;
  if ("billable" in body) data.billable = body.billable === true;
  if ("billingCode" in body) data.billingCode = typeof body.billingCode === "string" && body.billingCode.trim() ? body.billingCode.trim() : null;
  if ("fundingSourceType" in body) data.fundingSourceType = typeof body.fundingSourceType === "string" && body.fundingSourceType.trim() ? body.fundingSourceType.trim().toLowerCase() : null;
  if ("fundingSourceId" in body) data.fundingSourceId = typeof body.fundingSourceId === "string" && body.fundingSourceId.trim() ? body.fundingSourceId.trim() : null;

  const updated = await store.missionHubEvent.update({ where: { id: req.params.id }, data });

  // Sync linked calendar entry if it exists
  if (typeof existing.calendarEventId === "string" && existing.calendarEventId) {
    const calEntry = await store.missionHubCalendarEntry.findFirst({
      where: { id: existing.calendarEventId, organizationId, userId },
    });
    if (calEntry) {
      const mergedEvent = { ...existing, ...data };
      const startDate = typeof mergedEvent.startDateTime === "string" ? String(mergedEvent.startDateTime).split("T")[0] : String(existing.startDateTime || "").split("T")[0];
      const calData: Record<string, unknown> = {
        title: typeof data.name === "string" ? data.name : String(existing.name || ""),
        date: startDate,
      };
      if ("description" in data || "location" in data || "isVirtual" in data || "meetingUrl" in data) {
        calData.description = [
          String(data.description ?? existing.description ?? ""),
          typeof (data.location ?? existing.location) === "string" ? `Location: ${data.location ?? existing.location}` : "",
          (data.isVirtual ?? existing.isVirtual) && typeof (data.meetingUrl ?? existing.meetingUrl) === "string"
            ? `Meeting URL: ${data.meetingUrl ?? existing.meetingUrl}` : "",
        ].filter(Boolean).join("\n");
      }
      try {
        await store.missionHubCalendarEntry.update({ where: { id: existing.calendarEventId as string }, data: calData });
      } catch { /* non-fatal */ }
    }
  }

  res.json(updated);
});

router.delete("/events/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as EventStore;

  const existing = await store.missionHubEvent.findFirst({
    where: { id: req.params.id, organizationId, userId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, isActive: true },
  });
  if (!existing) { res.status(404).json({ error: "Event not found" }); return; }

  await store.missionHubEvent.update({ where: { id: req.params.id }, data: { isActive: false, status: "archived" } });

  // Archive linked calendar entry
  if (typeof existing.calendarEventId === "string" && existing.calendarEventId) {
    try {
      const calEntry = await store.missionHubCalendarEntry.findFirst({
        where: { id: existing.calendarEventId, organizationId, userId },
      });
      if (calEntry) {
        await store.missionHubCalendarEntry.update({ where: { id: existing.calendarEventId }, data: { isActive: false } });
      }
    } catch { /* non-fatal */ }
  }

  res.status(204).send();
});

// ─── Saved Reports ────────────────────────────────────────────────────────────

router.get("/reports", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSavedReport: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const reports = await store.missionHubSavedReport.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
  res.json(reports);
});

router.post("/reports", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSavedReport: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const report = await store.missionHubSavedReport.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      description: typeof body.description === "string" ? body.description : "",
      config: isRecord(body.config) ? body.config : {},
      isFavorite: body.isFavorite === true,
      lastRun: typeof body.lastRun === "string" ? body.lastRun : null,
    },
  });
  res.status(201).json(report);
});

router.put("/reports/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSavedReport: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSavedReport.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (typeof body.description === "string") data.description = body.description;
  if (isRecord(body.config)) data.config = body.config;
  if (typeof body.isFavorite === "boolean") data.isFavorite = body.isFavorite;
  if ("lastRun" in body) data.lastRun = typeof body.lastRun === "string" ? body.lastRun : null;

  const updated = await store.missionHubSavedReport.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/reports/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSavedReport: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSavedReport.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  await store.missionHubSavedReport.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, program: "mission-hub", status: "ready" });
});

// ─── Documents ────────────────────────────────────────────────────────────────

type DocStore = {
  missionHubDocument: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  missionHubDocumentLink: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  missionHubDocumentExport: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

router.get("/documents", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  const { linkedEntityType, linkedEntityId } = req.query;
  const store = prisma as unknown as DocStore;
  const where: Record<string, unknown> = { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, isActive: true, deletedAt: null };

  if (typeof linkedEntityType === "string" && typeof linkedEntityId === "string") {
    const normalizedEntityType = normalizeEntityType(linkedEntityType);
    if (!normalizedEntityType) {
      res.status(400).json({ error: "Invalid linkedEntityType" });
      return;
    }
    const allowed = await hasMissionHubEntityReadAccess(normalizedEntityType, linkedEntityId, organizationId, role);
    if (!allowed) {
      res.status(403).json({ error: "You do not have access to linked entity documents." });
      return;
    }
    where.linkedEntityType = normalizedEntityType;
  } else if (typeof linkedEntityType === "string") {
    const normalizedEntityType = normalizeEntityType(linkedEntityType);
    if (!normalizedEntityType) {
      res.status(400).json({ error: "Invalid linkedEntityType" });
      return;
    }
    where.linkedEntityType = normalizedEntityType;
  }

  if (typeof linkedEntityId === "string") where.linkedEntityId = linkedEntityId;

  const docs = await store.missionHubDocument.findMany({ where, orderBy: { createdAt: "desc" } });
  const readableDocs: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const allowed = await canReadMissionHubDocument(doc, organizationId, role);
    if (allowed) readableDocs.push(doc);
  }
  res.json(readableDocs);
});

router.post("/documents/exports", requireMissionHubAuth, requireMissionHubDocumentWrite, EXPORT_RATE_LIMIT, async (req, res) => {
  const { organizationId, userId, role } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as DocStore;
  const where: Record<string, unknown> = {
    organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    isActive: true,
    deletedAt: null,
  };

  const linkedEntityType = normalizeEntityType(body.linkedEntityType);
  const linkedEntityId = typeof body.linkedEntityId === "string" ? body.linkedEntityId : null;
  if ((linkedEntityType && !linkedEntityId) || (!linkedEntityType && linkedEntityId)) {
    res.status(400).json({ error: "linkedEntityType and linkedEntityId must be provided together" });
    return;
  }
  if (linkedEntityType && linkedEntityId) {
    const allowed = await hasMissionHubEntityReadAccess(linkedEntityType, linkedEntityId, organizationId, role);
    if (!allowed) {
      res.status(403).json({ error: "You do not have access to export documents for this entity." });
      return;
    }
    where.linkedEntityType = linkedEntityType;
    where.linkedEntityId = linkedEntityId;
  }

  if (typeof body.sensitivityLevel === "string") {
    const sensitivityLevel = body.sensitivityLevel.toLowerCase();
    if (!MISSION_HUB_ALLOWED_SENSITIVITY.has(sensitivityLevel)) {
      res.status(400).json({ error: "Invalid sensitivityLevel" });
      return;
    }
    where.sensitivityLevel = sensitivityLevel;
  }

  const docs = await store.missionHubDocument.findMany({ where, orderBy: { createdAt: "desc" } });
  const readableDocs: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const allowed = await canReadMissionHubDocument(doc, organizationId, role);
    if (allowed) readableDocs.push(doc);
  }

  const totalBytes = readableDocs.reduce((sum, doc) => {
    const size = typeof doc.sizeBytes === "number" ? doc.sizeBytes : 0;
    return sum + size;
  }, 0);

  const exportClient = getMissionHubDocumentExportClient();
  const exportJob = await exportClient.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      requestedByUserId: userId,
      status: "processing",
      filters: {
        linkedEntityType,
        linkedEntityId,
        sensitivityLevel: typeof body.sensitivityLevel === "string" ? body.sensitivityLevel.toLowerCase() : null,
      },
      documentCount: readableDocs.length,
      totalBytes,
      manifest: {},
    },
  });

  try {
    const manifest = {
      exportId: String(exportJob.id),
      generatedAt: new Date().toISOString(),
      organizationId,
      requestedByUserId: userId,
      documentCount: readableDocs.length,
      totalBytes,
      filters: exportJob.filters,
      documents: readableDocs.map((doc) => ({
        id: String(doc.id ?? ""),
        title: String(doc.title ?? ""),
        originalFilename: String(doc.originalFilename ?? ""),
        mimeType: String(doc.mimeType ?? ""),
        sizeBytes: typeof doc.sizeBytes === "number" ? doc.sizeBytes : 0,
        storageKey: String(doc.storageKey ?? ""),
        storageProvider: String(doc.storageProvider ?? ""),
        linkedEntityType: typeof doc.linkedEntityType === "string" ? doc.linkedEntityType : null,
        linkedEntityId: typeof doc.linkedEntityId === "string" ? doc.linkedEntityId : null,
        createdAt: toIsoString(doc.createdAt),
      })),
    };

    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("manifest.csv", buildDocumentExportCsv(readableDocs));
    zip.file("README.txt", "This archive contains Mission Hub export metadata only. Use storageKey with your storage backend for raw file retrieval.\n");
    const archiveBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const storage = await resolveStorageAdapter({ organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN });
    const archiveName = `documents-export-${String(exportJob.id)}.zip`;
    const exportKey = buildPartitionedKey({
      prefix: storage.prefix,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      organizationId,
      userId,
      stamp: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      safeFileName: archiveName,
    });
    const uploaded = await storage.adapter.upload(exportKey, archiveBuffer, "application/zip");

    const expiresAt = new Date(Date.now() + MISSION_HUB_DOCUMENT_EXPORT_TTL_HOURS * 60 * 60 * 1000);
    const completed = await exportClient.update({
      where: { id: String(exportJob.id) },
      data: {
        status: "completed",
        manifest,
        storageKey: uploaded.key,
        storageProvider: storage.adapter.backendId,
        completedAt: new Date(),
        expiresAt,
        errorMessage: null,
      },
    });

    void auditMissionHubEvent(req, "document.export", getUser(req), {
      resourceType: "document_export",
      resourceId: String(exportJob.id),
      newValue: {
        documentCount: readableDocs.length,
        totalBytes,
      },
    });

    res.status(201).json(completed);
  } catch (error) {
    const failed = await exportClient.update({
      where: { id: String(exportJob.id) },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Failed to generate export archive",
      },
    });
    res.status(500).json(failed);
  }
});

router.get("/documents/exports", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const exportClient = getMissionHubDocumentExportClient();
  const exports = await exportClient.findMany({
    where: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(exports);
});

router.get("/documents/exports/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const exportClient = getMissionHubDocumentExportClient();
  const exportJob = await exportClient.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!exportJob) {
    res.status(404).json({ error: "Export job not found" });
    return;
  }
  res.json(exportJob);
});

router.get("/documents/exports/:id/download", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const exportClient = getMissionHubDocumentExportClient();
  const exportJob = await exportClient.findFirst({
    where: {
      id: req.params.id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!exportJob || typeof exportJob.storageKey !== "string" || exportJob.status !== "completed") {
    res.status(404).json({ error: "Export archive not found" });
    return;
  }
  const expiresAt = exportJob.expiresAt instanceof Date ? exportJob.expiresAt : null;
  if (expiresAt && expiresAt < new Date()) {
    res.status(410).json({ error: "Export archive has expired" });
    return;
  }

  try {
    const storage = await resolveStorageAdapter({ organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN });
    const downloadUrl = await storage.adapter.getDownloadUrl(String(exportJob.storageKey), {
      filename: `mission-hub-documents-export-${String(exportJob.id)}.zip`,
      disposition: "attachment",
      expiresIn: 900,
    });
    res.redirect(302, downloadUrl);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get("/documents/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  const store = prisma as unknown as DocStore;
  const doc = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  const allowed = await canReadMissionHubDocument(doc, organizationId, role);
  if (!allowed) {
    res.status(403).json({ error: "You do not have access to this document." });
    return;
  }
  void auditMissionHubEvent(req, "document.view", getUser(req), {
    resourceType: "document",
    resourceId: String(req.params.id),
    metadata: { linkedEntityType: typeof doc.linkedEntityType === "string" ? doc.linkedEntityType : null },
  });
  res.json(doc);
});

router.post("/documents", requireMissionHubAuth, UPLOAD_RATE_LIMIT, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as DocStore;
  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" }); return;
  }
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  if (mimeType && !MISSION_HUB_ALLOWED_DOCUMENT_MIME_TYPES.has(mimeType)) {
    res.status(415).json({ error: "Unsupported file type" });
    return;
  }
  const originalFilename = typeof body.originalFilename === "string" ? body.originalFilename : "";
  const safeOriginalFilename = sanitizeMissionHubFilename(originalFilename);
  const fileExtension = path.extname(safeOriginalFilename).toLowerCase();
  if (fileExtension && !MISSION_HUB_ALLOWED_DOCUMENT_EXTENSIONS.has(fileExtension)) {
    res.status(415).json({ error: "Unsupported file extension" });
    return;
  }
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
  if (sizeBytes > MISSION_HUB_DOCUMENT_MAX_BYTES) {
    res.status(413).json({ error: "File exceeds maximum allowed size" });
    return;
  }
  const sensitivityLevel = typeof body.sensitivityLevel === "string" ? body.sensitivityLevel.toLowerCase() : "confidential";
  if (!MISSION_HUB_ALLOWED_SENSITIVITY.has(sensitivityLevel)) {
    res.status(400).json({ error: "Invalid sensitivityLevel" });
    return;
  }
  const doc = await store.missionHubDocument.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      createdByUserId: userId,
      uploaderUserId: userId,
      title: (body.title as string).trim(),
      documentType: typeof body.documentType === "string" ? body.documentType : "",
      originalFilename: safeOriginalFilename,
      mimeType,
      sizeBytes,
      storageKey: typeof body.storageKey === "string" ? body.storageKey : "",
      storageBucket: typeof body.storageBucket === "string" ? body.storageBucket : "",
      storageProvider: typeof body.storageProvider === "string" ? body.storageProvider : "r2",
      sensitivityLevel,
      retentionCategory: typeof body.retentionCategory === "string" ? body.retentionCategory : "",
      linkedEntityType: typeof body.linkedEntityType === "string" ? body.linkedEntityType : null,
      linkedEntityId: typeof body.linkedEntityId === "string" ? body.linkedEntityId : null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      metadata: isRecord(body.metadata) ? body.metadata : {},
    },
  });
  void auditMissionHubEvent(req, "document.upload", getUser(req), {
    resourceType: "document",
    resourceId: String(doc.id || ""),
    newValue: { mimeType, sizeBytes, sensitivityLevel, retentionCategory: typeof body.retentionCategory === "string" ? body.retentionCategory : "" },
  });
  res.status(201).json(doc);
});

router.put("/documents/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as DocStore;
  const existing = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
  const data: Record<string, unknown> = {};
  const strFields = ["title", "linkedEntityType", "linkedEntityId", "storageKey", "storageBucket", "storageProvider"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.documentType === "string") data.documentType = body.documentType;
  if (typeof body.sensitivityLevel === "string") data.sensitivityLevel = body.sensitivityLevel;
  if (typeof body.retentionCategory === "string") data.retentionCategory = body.retentionCategory;
  if ("tags" in body && Array.isArray(body.tags)) data.tags = body.tags;
  if ("metadata" in body && isRecord(body.metadata)) data.metadata = body.metadata;
  const updated = await store.missionHubDocument.update({ where: { id: req.params.id }, data });
  void auditMissionHubEvent(req, "document.update", getUser(req), {
    resourceType: "document",
    resourceId: String(req.params.id),
    oldValue: existing,
    newValue: updated,
  });
  res.json(updated);
});

router.delete("/documents/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as DocStore;
  const existing = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
  await store.missionHubDocument.update({ where: { id: req.params.id }, data: { isActive: false, deletedAt: new Date(), deletedByUserId: getUser(req).userId } });
  void auditMissionHubEvent(req, "document.delete", getUser(req), {
    resourceType: "document",
    resourceId: String(req.params.id),
    oldValue: existing,
    newValue: { isActive: false, deletedAt: new Date().toISOString() },
  });
  res.status(204).send();
});

router.get("/documents/:id/preview", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  const store = prisma as unknown as DocStore;
  const doc = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  const allowed = await canReadMissionHubDocument(doc, organizationId, role);
  if (!allowed) {
    res.status(403).json({ error: "You do not have access to this document." });
    return;
  }

  res.json({
    id: String(doc.id),
    title: String(doc.title ?? "Untitled"),
    filename: String(doc.originalFilename ?? "") || null,
    documentType: String(doc.documentType ?? "") || "general",
    uploadedAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt ?? ""),
    originalAvailable: Boolean(doc.storageKey),
    truncated: false,
    previewText: typeof doc.metadata === "object" && doc.metadata && !Array.isArray(doc.metadata)
      ? JSON.stringify(doc.metadata, null, 2).slice(0, 12000)
      : "",
    previewMarkdown: null,
    snippet: String(doc.title ?? "Untitled"),
    markdownAvailable: false,
  });
});

router.get("/documents/:id/download", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  const store = prisma as unknown as DocStore;
  const doc = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!doc?.storageKey) { res.status(404).json({ error: "File not found" }); return; }
  const allowed = await canReadMissionHubDocument(doc, organizationId, role);
  if (!allowed) {
    res.status(403).json({ error: "You do not have access to this document." });
    return;
  }

  try {
    const storage = await resolveStorageAdapter({ organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN });
    const downloadUrl = await storage.adapter.getDownloadUrl(String(doc.storageKey), {
      filename: typeof doc.originalFilename === "string" ? doc.originalFilename : undefined,
      disposition: req.query.disposition === "inline" ? "inline" : "attachment",
    });
    res.redirect(302, downloadUrl);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get("/documents/:id/links", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  const store = prisma as unknown as DocStore;
  const doc = await store.missionHubDocument.findFirst({ where: { id: req.params.id, organizationId, isActive: true, deletedAt: null } });
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  const allowed = await canReadMissionHubDocument(doc, organizationId, role);
  if (!allowed) {
    res.status(403).json({ error: "You do not have access to this document." });
    return;
  }

  const links = await store.missionHubDocumentLink.findMany({
    where: { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, documentId: req.params.id },
    orderBy: { createdAt: "desc" },
  });

  res.json(links.map((link) => toMissionHubDocumentLink(link)));
});

router.post("/documents/:id/links", requireMissionHubAuth, requireMissionHubDocumentWrite, async (req, res) => {
  const { organizationId, userId } = getUser(req);
  const id = parseRouteId(req.params.id);
  const body = isRecord(req.body) ? req.body : {};
  const entityType = normalizeEntityType(body.entityType);
  const entityId = parseRouteId(typeof body.entityId === "string" ? body.entityId : undefined);
  const linkType = normalizeLinkType(body.linkType) ?? "attachment";
  if (!id || !entityType || !entityId) {
    res.status(400).json({ error: "entityType and entityId are required" });
    return;
  }

  const docClient = getMissionHubDocumentClient();
  const linkClient = getMissionHubDocumentLinkClient();
  const doc = await docClient.findFirst({ where: { id, organizationId, isActive: true, deletedAt: null } });
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const allowed = await resolveMissionHubEntityAccess(entityType, entityId, organizationId);
  if (!allowed) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  try {
    const link = await linkClient.create({
      data: {
        organizationId,
        programDomain: MISSION_HUB_PROGRAM_DOMAIN,
        documentId: id,
        entityType,
        entityId,
        linkType,
        notes: typeof body.notes === "string" ? body.notes : null,
        sourceContext: typeof body.sourceContext === "string" ? body.sourceContext : null,
        createdByUserId: userId,
      },
    });
    res.status(201).json({ link: toMissionHubDocumentLink(link), document: doc });
  } catch (error) {
    const maybeCode = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (maybeCode === "P2002") {
      res.status(409).json({ error: "This document is already linked to that entity with the same linkType." });
      return;
    }
    throw error;
  }
});

router.delete("/documents/:id/links/:linkId", requireMissionHubAuth, requireMissionHubDocumentWrite, async (req, res) => {
  const { organizationId } = getUser(req);
  const id = parseRouteId(req.params.id);
  const linkId = parseRouteId(req.params.linkId);
  if (!id || !linkId) {
    res.status(400).json({ error: "Invalid document id or link id" });
    return;
  }

  const store = prisma as unknown as DocStore;
  const link = await store.missionHubDocumentLink.findFirst({
    where: {
      id: linkId,
      documentId: id,
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!link) {
    res.status(404).json({ error: "Document link not found" });
    return;
  }

  await store.missionHubDocumentLink.delete({ where: { id: linkId } });
  res.status(204).send();
});

router.get("/entities/:entityType/:entityId/documents", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const entityType = normalizeEntityType(req.params.entityType);
  const entityId = parseRouteId(req.params.entityId);
  if (!entityType || !entityId) {
    res.status(400).json({ error: "Invalid entityType or entityId" });
    return;
  }

  const allowed = await resolveMissionHubEntityAccess(entityType, entityId, organizationId);
  if (!allowed) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  const store = prisma as unknown as DocStore;
  const links = await store.missionHubDocumentLink.findMany({
    where: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      entityType,
      entityId,
    },
    include: {
      document: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(
    links.map((link) => ({
      link: toMissionHubDocumentLink(link),
      document: link.document,
    })),
  );
});

router.post("/documents/upload", requireMissionHubAuth, requireMissionHubDocumentWrite, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "File is required" });
    return;
  }

  const { organizationId, userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const entityType = normalizeEntityType(body.entityType);
  const entityId = parseRouteId(typeof body.entityId === "string" ? body.entityId : undefined);
  const linkType = normalizeLinkType(body.linkType) ?? "attachment";
  const store = prisma as unknown as DocStore;

  if ((entityType && !entityId) || (entityId && !entityType)) {
    res.status(400).json({ error: "entityType and entityId must be provided together" });
    return;
  }
  if (entityType && entityId) {
    const allowed = await resolveMissionHubEntityAccess(entityType, entityId, organizationId);
    if (!allowed) {
      res.status(404).json({ error: "Entity not found" });
      return;
    }
  }

  let storage;
  try {
    storage = await resolveStorageAdapter({ organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN });
  } catch (err) {
    if (err instanceof StorageConfigError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }

  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const key = buildPartitionedKey({
    prefix: storage.prefix,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    organizationId,
    userId,
    stamp,
    safeFileName: sanitizeMissionHubFilename(req.file.originalname),
  });

  const uploadResult = await storage.adapter.upload(key, req.file.buffer, req.file.mimetype);
  const linkedEntityType = entityType ?? (typeof body.linkedEntityType === "string" ? body.linkedEntityType : null);
  const linkedEntityId = entityId ?? (typeof body.linkedEntityId === "string" ? body.linkedEntityId : null);

  try {
    const created = await store.missionHubDocument.create({
      data: {
        organizationId,
        programDomain: MISSION_HUB_PROGRAM_DOMAIN,
        createdByUserId: userId,
        uploaderUserId: userId,
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : req.file.originalname,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: uploadResult.key,
        storageBucket: typeof body.storageBucket === "string" ? body.storageBucket : "",
        storageProvider: typeof body.storageProvider === "string" ? body.storageProvider : "r2",
        documentType: typeof body.type === "string" ? body.type : (typeof body.documentType === "string" ? body.documentType : ""),
        sensitivityLevel: typeof body.sensitivityLevel === "string" ? body.sensitivityLevel : "confidential",
        retentionCategory: typeof body.retentionCategory === "string" ? body.retentionCategory : "",
        linkedEntityType,
        linkedEntityId,
        tags: Array.isArray(body.tags) ? body.tags : [],
        metadata: isRecord(body.metadata) ? body.metadata : {},
      },
    });

    let createdLink: Record<string, unknown> | null = null;
    if (entityType && entityId) {
      createdLink = await store.missionHubDocumentLink.create({
        data: {
          organizationId,
          programDomain: MISSION_HUB_PROGRAM_DOMAIN,
          documentId: String(created.id),
          entityType,
          entityId,
          linkType,
          notes: typeof body.notes === "string" ? body.notes : null,
          sourceContext: typeof body.sourceContext === "string" ? body.sourceContext : null,
          createdByUserId: userId,
        },
      });
    }

    res.status(201).json({
      document: created,
      link: createdLink ? toMissionHubDocumentLink(createdLink) : null,
    });
  } catch (error) {
    try {
      await storage.adapter.delete(uploadResult.key);
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
});

// ─── Storage Endpoints ────────────────────────────────────────────────────────

type EndpointStore = {
  missionHubStorageEndpoint: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    updateMany: (args: Record<string, unknown>) => Promise<unknown>;
  };
};

router.get("/storage-endpoints", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as EndpointStore;
  const endpoints = await store.missionHubStorageEndpoint.findMany({
    where: { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN },
    orderBy: { createdAt: "asc" },
  });
  res.json(endpoints);
});

router.post("/storage-endpoints", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as EndpointStore;
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const endpoint = await store.missionHubStorageEndpoint.create({
    data: {
      organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
      name: (body.name as string).trim(),
      provider: typeof body.provider === "string" ? body.provider : "r2",
      bucketOrBinding: typeof body.bucketOrBinding === "string" ? body.bucketOrBinding : "",
      basePrefix: typeof body.basePrefix === "string" ? body.basePrefix : "",
      enabled: body.enabled !== false,
      isDefault: body.isDefault === true,
      config: isRecord(body.config) ? body.config : {},
    },
  });
  // If this is set as default, clear the default flag on others.
  if (endpoint.isDefault) {
    await store.missionHubStorageEndpoint.updateMany({
      where: { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, id: { not: endpoint.id } },
      data: { isDefault: false },
    });
  }
  res.status(201).json(endpoint);
});

router.put("/storage-endpoints/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as EndpointStore;
  const existing = await store.missionHubStorageEndpoint.findFirst({ where: { id: req.params.id, organizationId } });
  if (!existing) { res.status(404).json({ error: "Storage endpoint not found" }); return; }
  const data: Record<string, unknown> = {};
  const strFields = ["name", "provider", "bucketOrBinding", "basePrefix"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.isDefault === "boolean") data.isDefault = body.isDefault;
  if ("config" in body && isRecord(body.config)) data.config = body.config;
  const updated = await store.missionHubStorageEndpoint.update({ where: { id: req.params.id }, data });
  if (updated.isDefault) {
    await store.missionHubStorageEndpoint.updateMany({
      where: { organizationId, programDomain: MISSION_HUB_PROGRAM_DOMAIN, id: { not: req.params.id } },
      data: { isDefault: false },
    });
  }
  res.json(updated);
});

router.delete("/storage-endpoints/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as EndpointStore;
  const existing = await store.missionHubStorageEndpoint.findFirst({ where: { id: req.params.id, organizationId } });
  if (!existing) { res.status(404).json({ error: "Storage endpoint not found" }); return; }
  await store.missionHubStorageEndpoint.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ─── Organization Settings ────────────────────────────────────────────────────

type OrgSettingsStore = {
  missionHubOrganizationSettings: {
    findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

router.get("/organization-settings", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as OrgSettingsStore;
  const settings = await store.missionHubOrganizationSettings.findUnique({ where: { organizationId } });
  if (!settings) {
    // Return defaults for org with no settings yet — do not 404.
    res.json({
      organizationId,
      orgDisplayName: "",
      fiscalYearStart: "01-01",
      defaultTimezone: "America/New_York",
      selectedStorageEndpointId: null,
      expenseCategories: [],
    });
    return;
  }
  res.json(settings);
});

router.put("/organization-settings", requireMissionHubAuth, async (req, res) => {
  const { organizationId, role } = getUser(req);
  if (!ADMIN_ROLES.has(normalizeRoleValue(role))) {
    res.status(403).json({ error: "Only admins can update organization settings." });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as OrgSettingsStore;
  const data: Record<string, unknown> = {};
  if (typeof body.orgDisplayName === "string") data.orgDisplayName = body.orgDisplayName.trim();
  if (typeof body.fiscalYearStart === "string") data.fiscalYearStart = body.fiscalYearStart.trim();
  if (typeof body.defaultTimezone === "string") data.defaultTimezone = body.defaultTimezone.trim();
  if (body.selectedStorageEndpointId === null) {
    data.selectedStorageEndpointId = null;
  } else if (typeof body.selectedStorageEndpointId === "string") {
    const selectedStorageEndpointId = body.selectedStorageEndpointId.trim();
    if (!selectedStorageEndpointId) {
      data.selectedStorageEndpointId = null;
    } else {
      const endpointStore = prisma as unknown as EndpointStore;
      const endpoint = await endpointStore.missionHubStorageEndpoint.findFirst({
        where: {
          id: selectedStorageEndpointId,
          organizationId,
          programDomain: MISSION_HUB_PROGRAM_DOMAIN,
          enabled: true,
        },
      });
      if (!endpoint) {
        res.status(400).json({ error: "selectedStorageEndpointId is invalid for this organization." });
        return;
      }
      data.selectedStorageEndpointId = selectedStorageEndpointId;
    }
  }
  if (Array.isArray(body.expenseCategories)) data.expenseCategories = body.expenseCategories.filter((c: unknown) => typeof c === "string");
  const settings = await store.missionHubOrganizationSettings.upsert({
    where: { organizationId },
    update: data,
    create: { organizationId, ...data },
  });
  res.json(settings);
});

// ─── Scheduled Reports ────────────────────────────────────────────────────────

type ScheduledReportStore = {
  missionHubScheduledReport: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

router.get("/scheduled-reports", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as ScheduledReportStore;
  const reports = await store.missionHubScheduledReport.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
  res.json(reports);
});

router.post("/scheduled-reports", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as ScheduledReportStore;
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const report = await store.missionHubScheduledReport.create({
    data: {
      organizationId,
      createdByUserId: userId,
      name: (body.name as string).trim(),
      reportType: typeof body.reportType === "string" ? body.reportType : "",
      schedule: typeof body.schedule === "string" ? body.schedule : "weekly",
      recipients: Array.isArray(body.recipients) ? body.recipients : [],
      filters: isRecord(body.filters) ? body.filters : {},
      isActive: body.isActive !== false,
    },
  });
  res.status(201).json(report);
});

router.put("/scheduled-reports/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as ScheduledReportStore;
  const existing = await store.missionHubScheduledReport.findFirst({ where: { id: req.params.id, organizationId } });
  if (!existing) { res.status(404).json({ error: "Scheduled report not found" }); return; }
  const data: Record<string, unknown> = {};
  const strFields = ["name", "reportType", "schedule"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("recipients" in body && Array.isArray(body.recipients)) data.recipients = body.recipients;
  if ("filters" in body && isRecord(body.filters)) data.filters = body.filters;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  const updated = await store.missionHubScheduledReport.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/scheduled-reports/:id", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);
  const store = prisma as unknown as ScheduledReportStore;
  const existing = await store.missionHubScheduledReport.findFirst({ where: { id: req.params.id, organizationId } });
  if (!existing) { res.status(404).json({ error: "Scheduled report not found" }); return; }
  await store.missionHubScheduledReport.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ─── Financial Summary ────────────────────────────────────────────────────────

router.get("/financial-summary", requireMissionHubAuth, async (req, res) => {
  const { organizationId } = getUser(req);

  type FinancialStore = {
    missionHubExpense: { aggregate: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubGrant: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
    missionHubSponsor: { aggregate: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
    missionHubCampaign: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const store = prisma as unknown as FinancialStore;

  const [expenseAgg, grants, sponsorAgg, campaigns] = await Promise.all([
    store.missionHubExpense.aggregate({
      where: { organizationId, isActive: true, approvalStatus: { in: ["Approved", "Pending"] } },
      _sum: { amount: true },
    }),
    store.missionHubGrant.findMany({ where: { organizationId, isActive: true }, select: { amountAwarded: true, status: true } }),
    store.missionHubSponsor.aggregate({
      where: { organizationId, isActive: true },
      _sum: { contributionAmount: true },
    }),
    store.missionHubCampaign.findMany({ where: { organizationId, isActive: true }, select: { goalAmount: true, status: true } }),
  ]);

  const totalExpenses = Number((expenseAgg._sum as Record<string, unknown>)?.amount ?? 0);
  const totalGrantFunding = grants.reduce((sum, g) => sum + Number(g.amountAwarded ?? 0), 0);
  const totalSponsorContributions = Number((sponsorAgg._sum as Record<string, unknown>)?.contributionAmount ?? 0);
  const totalCampaignGoals = campaigns.reduce((sum, c) => sum + Number(c.goalAmount ?? 0), 0);
  const totalRevenue = totalGrantFunding + totalSponsorContributions;
  const netPosition = totalRevenue - totalExpenses;

  res.json({
    totalExpenses,
    totalGrantFunding,
    totalSponsorContributions,
    totalCampaignGoals,
    totalRevenue,
    netPosition,
    activeGrantCount: grants.filter((g) => g.status === "Active").length,
    activeCampaignCount: campaigns.filter((c) => c.status === "Active").length,
  });
});

export { router as missionHubRouter };
