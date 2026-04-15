/**
 * Timeflow API Routes
 *
 * All endpoints are scoped by organizationId + userId extracted from the JWT.
 * The JWT must have programDomain === "timeflow" (issued by this consume endpoint
 * or by the suite platform-auth flow with programDomain: "timeflow").
 */
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../../core/db/prisma.js";
import { DEFAULT_ORGANIZATION_ID, JWT_EXPIRES_IN, JWT_SECRET } from "../../../core/config/env.js";
import { hashPassword, verifyPassword } from "../../../core/auth/auth.service.js";
import { createDocumentPayload } from "../../../documentFactory.js";
import { logger } from "../../../logger.js";

const router = express.Router();

const TIMEFLOW_PROGRAM_DOMAIN = "timeflow";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface TimeflowTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain: string;
}

type TimeflowAuthRole = "contractor" | "client_viewer";
type TimeflowEntityType = "client" | "project";

type TimeflowUserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  organizationId: string | null;
  displayName: string;
  mustChangePassword?: boolean | null;
};

const prismaUser = prisma as typeof prisma & {
  user: {
    findUnique: (args: { where: { email?: string; id?: string } }) => Promise<TimeflowUserRecord | null>;
    create: (args: {
      data: {
        organizationId: string;
        email: string;
        passwordHash: string;
        role: string;
        displayName: string;
        identitySource?: string;
      };
    }) => Promise<TimeflowUserRecord>;
  };
};

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDisplayName(value: unknown, fallbackEmail: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallbackEmail.split("@")[0] || "User";
}

function toTimeflowRole(value: string): TimeflowAuthRole {
  return value === "client_viewer" ? "client_viewer" : "contractor";
}

function signTimeflowToken(user: {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
}): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId || DEFAULT_ORGANIZATION_ID,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );
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
  res.cookie("timeflowToken", token, baseCookie);
}

function toAuthUserPayload(user: TimeflowUserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: toTimeflowRole(user.role),
    organizationId: user.organizationId || DEFAULT_ORGANIZATION_ID,
    programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

// ─── TimeFlow direct auth endpoints (DB-backed) ─────────────────────────────

router.post("/auth/login", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signTimeflowToken(user);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  logger.info("[timeflow] direct login success", {
    userId: user.id,
    role: user.role,
    organizationId: user.organizationId || DEFAULT_ORGANIZATION_ID,
  });

  res.json({ token, user: toAuthUserPayload(user) });
});

router.post("/auth/register", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = normalizeDisplayName(body.displayName, email);

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const existing = await prismaUser.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }

  const user = await prismaUser.user.create({
    data: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      email,
      passwordHash: await hashPassword(password),
      role: "contractor",
      displayName,
      identitySource: "local",
    },
  });

  const token = signTimeflowToken(user);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  logger.info("[timeflow] direct register success", {
    userId: user.id,
    role: user.role,
    organizationId: user.organizationId || DEFAULT_ORGANIZATION_ID,
  });

  res.status(201).json({ token, user: toAuthUserPayload(user) });
});

router.get("/auth/me", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  res.json({ user: toAuthUserPayload(user) });
});

router.post("/auth/logout", (_req, res) => {
  const secureCookie = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: (secureCookie ? "none" : "lax") as "none" | "lax",
    path: "/",
  };

  res.clearCookie("accessToken", cookieOptions);
  res.clearCookie("token", cookieOptions);
  res.clearCookie("timeflowToken", cookieOptions);
  res.status(204).send();
});

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (key && ["token", "accessToken", "authToken", "timeflowToken"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function decodeTimeflowToken(token: string): TimeflowTokenPayload | undefined {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TimeflowTokenPayload;
    if (payload.programDomain !== TIMEFLOW_PROGRAM_DOMAIN) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function requireTimeflowAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const payload = decodeTimeflowToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  (req as Request & { timeflowUser: TimeflowTokenPayload }).timeflowUser = payload;
  next();
}

function getUser(req: Request): TimeflowTokenPayload {
  return (req as Request & { timeflowUser: TimeflowTokenPayload }).timeflowUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimeflowEntityType(value: unknown): value is TimeflowEntityType {
  return value === "client" || value === "project";
}

function buildEntitySourceReference(entityType: TimeflowEntityType, entityId: string): string {
  return `timeflow:${entityType}:${entityId}`;
}

function parseEntitySourceReference(sourceReference: string | null | undefined): {
  entityType: TimeflowEntityType;
  entityId: string;
} | null {
  if (!sourceReference?.startsWith("timeflow:")) return null;
  const [prefix, entityType, ...entityIdParts] = sourceReference.split(":");
  if (prefix !== "timeflow" || !isTimeflowEntityType(entityType) || entityIdParts.length === 0) return null;
  return { entityType, entityId: entityIdParts.join(":") };
}

function asAttachmentStatus(value: unknown): "active" | "archived" {
  return value === "archived" ? "archived" : "active";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function assertTimeflowEntityAccess(
  entityType: TimeflowEntityType,
  entityId: string,
  scope: { organizationId: string; userId: string },
): Promise<boolean> {
  const store = prisma as unknown as {
    timeflowClient: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProject: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  if (entityType === "client") {
    const client = await store.timeflowClient.findFirst({
      where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId, isActive: true },
    });
    return Boolean(client);
  }

  const project = await store.timeflowProject.findFirst({
    where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId, isActive: true },
  });
  return Boolean(project);
}

function toTimeflowDocumentRecord(doc: {
  id: string;
  title: string;
  originalFileName: string | null;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  status: string | null;
  mimeType: string | null;
  fileSize: number | null;
  filePath: string | null;
  sourceReference: string | null;
  extractedMetadata: unknown;
}) {
  const entity = parseEntitySourceReference(doc.sourceReference);
  const metadata = isRecord(doc.extractedMetadata) ? doc.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};

  return {
    id: doc.id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    title: doc.title,
    originalFilename: doc.originalFileName || "document",
    note: typeof timeflowMeta.note === "string" ? timeflowMeta.note : undefined,
    uploadedBy: asString(timeflowMeta.uploadedBy) || doc.author || "Unknown uploader",
    uploadedAt: asString(timeflowMeta.uploadedAt) || doc.createdAt.toISOString(),
    status: asAttachmentStatus(timeflowMeta.status || doc.status),
    mimeType: doc.mimeType || "application/octet-stream",
    sizeBytes: doc.fileSize || 0,
    storageKey: asString(timeflowMeta.storageKey) || doc.filePath || undefined,
    dataUrl: "",
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// All routes below require a valid Timeflow JWT.
router.use(requireTimeflowAuth);

// ─── Documents (centralized attachment metadata) ────────────────────────────

router.get("/documents", async (req, res) => {
  const { userId, organizationId, email } = getUser(req);
  const query = req.query;
  const entityType = typeof query.entityType === "string" ? query.entityType : undefined;
  const entityId = typeof query.entityId === "string" ? query.entityId : undefined;

  if (!isTimeflowEntityType(entityType)) {
    res.status(400).json({ error: "entityType must be 'client' or 'project'" });
    return;
  }

  if (entityId) {
    const allowed = await assertTimeflowEntityAccess(entityType, entityId, { organizationId, userId });
    if (!allowed) {
      res.status(404).json({ error: `${entityType} not found` });
      return;
    }
  }

  const store = prisma as unknown as {
    document: {
      findMany: (args: Record<string, unknown>) => Promise<Array<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    intakeSource: "timeflow_attachment",
    sourceReference: entityId
      ? buildEntitySourceReference(entityType, entityId)
      : { startsWith: `timeflow:${entityType}:` },
  };

  const docs = await store.document.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  res.json({
    documents: docs
      .map((doc) => toTimeflowDocumentRecord(doc))
      .filter((doc) => doc.entityType === entityType),
    scope: { organizationId, userId, programDomain: TIMEFLOW_PROGRAM_DOMAIN, email },
  });
});

router.post("/documents", async (req, res) => {
  const { userId, organizationId, email } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};

  const entityType = body.entityType;
  const entityId = asString(body.entityId).trim();
  const title = asString(body.title).trim();
  const originalFilename = asString(body.originalFilename).trim();
  const note = asString(body.note).trim();
  const mimeType = asString(body.mimeType).trim() || "application/octet-stream";
  const sizeBytes = asNumber(body.sizeBytes);
  const storageKey = asString(body.storageKey).trim();
  const uploadedBy = asString(body.uploadedBy).trim() || email;
  const uploadedAt = asString(body.uploadedAt).trim() || new Date().toISOString();

  if (!isTimeflowEntityType(entityType)) {
    res.status(400).json({ error: "entityType must be 'client' or 'project'" });
    return;
  }
  if (!entityId) {
    res.status(400).json({ error: "entityId is required" });
    return;
  }
  if (!storageKey) {
    res.status(400).json({ error: "storageKey is required" });
    return;
  }
  if (!originalFilename) {
    res.status(400).json({ error: "originalFilename is required" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entityType, entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entityType} not found` });
    return;
  }

  const payload = createDocumentPayload({
    title: title || undefined,
    description: note,
    author: uploadedBy,
    uploaderName: uploadedBy,
    category: "Timeflow",
    type: `${entityType}_attachment`,
    intakeSource: "timeflow_attachment",
    sourceReference: buildEntitySourceReference(entityType, entityId),
    fileMeta: {
      originalFileName: originalFilename,
      mimeType,
      fileSize: sizeBytes,
      fileUrl: storageKey,
      filePath: storageKey,
    },
  });

  const metadata = {
    ...(isRecord(payload.extractedMetadata) ? payload.extractedMetadata : {}),
    timeflow: {
      entityType,
      entityId,
      note: note || undefined,
      status: "active",
      storageKey,
      uploadedBy,
      uploadedByUserId: userId,
      uploadedAt,
    },
  };

  const store = prisma as unknown as {
    document: {
      create: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>;
    };
  };

  const created = await store.document.create({
    data: {
      ...payload,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      createdByUserId: userId,
      uploadedById: userId,
      extractedMetadata: metadata,
      status: "active",
      processingStatus: "stored",
      ocrStatus: "not_needed",
      needsReview: false,
      review: { required: false },
      extraction: { status: "complete", method: "upload", extractedAt: new Date().toISOString() },
      aiSummary: "",
    },
  });

  res.status(201).json({ document: toTimeflowDocumentRecord(created) });
});

router.patch("/documents/:id", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      } | null>;
      update: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>;
    };
  };

  const current = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(current.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  const metadata = isRecord(current.extractedMetadata) ? current.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};

  const nextTitle = "title" in body ? asString(body.title).trim() : current.title;
  const nextNote = "note" in body ? asString(body.note).trim() : asString(timeflowMeta.note);
  const nextStatus = "status" in body ? asAttachmentStatus(body.status) : asAttachmentStatus(timeflowMeta.status || current.status);

  const updated = await store.document.update({
    where: { id },
    data: {
      title: nextTitle || current.title,
      status: nextStatus,
      extractedMetadata: {
        ...metadata,
        timeflow: {
          ...timeflowMeta,
          entityType: entity.entityType,
          entityId: entity.entityId,
          note: nextNote || undefined,
          status: nextStatus,
          storageKey: asString(timeflowMeta.storageKey) || current.filePath || undefined,
          uploadedBy: asString(timeflowMeta.uploadedBy) || current.author,
          uploadedAt: asString(timeflowMeta.uploadedAt) || current.createdAt.toISOString(),
          uploadedByUserId: asString(timeflowMeta.uploadedByUserId) || userId,
        },
      },
    },
  });

  res.json({ document: toTimeflowDocumentRecord(updated) });
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get("/settings", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    timeflowSettings: {
      findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
      upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  const settings = await store.timeflowSettings.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });

  if (!settings) {
    const created = await store.timeflowSettings.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, businessName: "" },
      update: {},
    });
    res.json(created);
    return;
  }

  res.json(settings);
});

router.put("/settings", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowSettings: {
      upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  const data: Record<string, unknown> = {};
  if (typeof body.businessName === "string") data.businessName = body.businessName;
  if ("defaultClientId" in body) data.defaultClientId = typeof body.defaultClientId === "string" ? body.defaultClientId : null;
  if (typeof body.invoiceNotes === "string") data.invoiceNotes = body.invoiceNotes;
  if (typeof body.paymentInstructions === "string") data.paymentInstructions = body.paymentInstructions;
  if ("invoiceLogoDataUrl" in body) data.invoiceLogoDataUrl = typeof body.invoiceLogoDataUrl === "string" ? body.invoiceLogoDataUrl : null;
  if ("invoiceBannerDataUrl" in body) data.invoiceBannerDataUrl = typeof body.invoiceBannerDataUrl === "string" ? body.invoiceBannerDataUrl : null;
  if (typeof body.companyViewerAccess === "boolean") data.companyViewerAccess = body.companyViewerAccess;
  if (typeof body.emailTemplate === "string") data.emailTemplate = body.emailTemplate;

  const settings = await store.timeflowSettings.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId, ...data },
    update: data,
  });

  res.json(settings);
});

// ─── Clients ──────────────────────────────────────────────────────────────────

router.get("/clients", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    timeflowClient: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const clients = await store.timeflowClient.findMany({
    where: { organizationId, userId, isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(clients);
});

router.post("/clients", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const client = await store.timeflowClient.create({
    data: {
      organizationId,
      userId,
      name: (body.name as string).trim(),
      contactName: typeof body.contactName === "string" ? body.contactName : null,
      contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
      contacts: Array.isArray(body.contacts) ? body.contacts : [],
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : null,
      companyViewerEnabled: body.companyViewerEnabled === true,
    },
  });

  res.status(201).json(client);
});

router.put("/clients/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if ("contactName" in body) data.contactName = typeof body.contactName === "string" ? body.contactName : null;
  if ("contactEmail" in body) data.contactEmail = typeof body.contactEmail === "string" ? body.contactEmail : null;
  if ("contacts" in body) data.contacts = Array.isArray(body.contacts) ? body.contacts : [];
  if ("hourlyRate" in body) data.hourlyRate = typeof body.hourlyRate === "number" ? body.hourlyRate : null;
  if (typeof body.companyViewerEnabled === "boolean") data.companyViewerEnabled = body.companyViewerEnabled;

  const updated = await store.timeflowClient.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/clients/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  // Soft delete
  await store.timeflowClient.update({ where: { id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get("/projects", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId } = req.query;
  const store = prisma as unknown as {
    timeflowProject: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof clientId === "string") where.clientId = clientId;

  const projects = await store.timeflowProject.findMany({
    where,
    orderBy: { name: "asc" },
  });
  res.json(projects);
});

router.post("/projects", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProject: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const client = await store.timeflowClient.findFirst({ where: { id: body.clientId, organizationId, userId } });
  if (!client) {
    res.status(400).json({ error: "Client not found" });
    return;
  }

  const project = await store.timeflowProject.create({
    data: {
      organizationId,
      userId,
      clientId: body.clientId as string,
      name: (body.name as string).trim(),
      status: typeof body.status === "string" ? body.status : "active",
      description: typeof body.description === "string" ? body.description : "",
      billingType: typeof body.billingType === "string" ? body.billingType : "hourly_uncapped",
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : 0,
      maxPayoutCap: typeof body.maxPayoutCap === "number" ? body.maxPayoutCap : 0,
      capHandling: typeof body.capHandling === "string" ? body.capHandling : "allow_overage",
      startDate: typeof body.startDate === "string" ? body.startDate : new Date().toISOString().split("T")[0],
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  });

  res.status(201).json(project);
});

router.put("/projects/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (typeof body.status === "string") data.status = body.status;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.billingType === "string") data.billingType = body.billingType;
  if (typeof body.hourlyRate === "number") data.hourlyRate = body.hourlyRate;
  if (typeof body.maxPayoutCap === "number") data.maxPayoutCap = body.maxPayoutCap;
  if (typeof body.capHandling === "string") data.capHandling = body.capHandling;
  if (typeof body.startDate === "string") data.startDate = body.startDate;
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.notes === "string") data.notes = body.notes;

  const updated = await store.timeflowProject.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/projects/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await store.timeflowProject.update({ where: { id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Time Entries ─────────────────────────────────────────────────────────────

router.get("/time-entries", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, projectId, invoiced, status, dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    timeflowTimeEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof projectId === "string") where.projectId = projectId;
  if (invoiced === "true") where.invoiced = true;
  if (invoiced === "false") where.invoiced = false;
  if (typeof status === "string") where.status = status;
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.date = {};
    if (typeof dateFrom === "string") (where.date as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.date as Record<string, unknown>).lte = dateTo;
  }

  const entries = await store.timeflowTimeEntry.findMany({
    where,
    orderBy: [{ date: "desc" }, { startTime: "desc" }],
  });
  res.json(entries);
});

router.post("/time-entries", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const entry = await store.timeflowTimeEntry.create({
    data: {
      organizationId,
      userId,
      clientId: body.clientId as string,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      date: typeof body.date === "string" ? body.date : new Date().toISOString().split("T")[0],
      startTime: typeof body.startTime === "string" ? body.startTime : "00:00",
      endTime: typeof body.endTime === "string" ? body.endTime : null,
      durationHours: typeof body.durationHours === "number" ? body.durationHours : 0,
      billingRate: typeof body.billingRate === "number" ? body.billingRate : null,
      billable: body.billable !== false,
      invoiced: body.invoiced === true,
      invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      status: typeof body.status === "string" ? body.status : "completed",
    },
  });

  res.status(201).json(entry);
});

router.put("/time-entries/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowTimeEntry.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.clientId === "string") data.clientId = body.clientId;
  if ("projectId" in body) data.projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (typeof body.date === "string") data.date = body.date;
  if (typeof body.startTime === "string") data.startTime = body.startTime;
  if ("endTime" in body) data.endTime = typeof body.endTime === "string" ? body.endTime : null;
  if (typeof body.durationHours === "number") data.durationHours = body.durationHours;
  if ("billingRate" in body) data.billingRate = typeof body.billingRate === "number" ? body.billingRate : null;
  if (typeof body.billable === "boolean") data.billable = body.billable;
  if (typeof body.invoiced === "boolean") data.invoiced = body.invoiced;
  if ("invoiceId" in body) data.invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  if (typeof body.notes === "string") data.notes = body.notes;
  if (typeof body.status === "string") data.status = body.status;

  const updated = await store.timeflowTimeEntry.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/time-entries/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowTimeEntry.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  await store.timeflowTimeEntry.delete({ where: { id } });
  res.status(204).send();
});

// Bulk update (for marking entries as invoiced, etc.)
router.patch("/time-entries/bulk", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
    };
  };

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.invoiced === "boolean") data.invoiced = body.invoiced;
  if (typeof body.invoiceId === "string" || body.invoiceId === null) data.invoiceId = body.invoiceId;
  if (typeof body.status === "string") data.status = body.status;

  const result = await store.timeflowTimeEntry.updateMany({
    where: { id: { in: body.ids as string[] }, organizationId, userId },
    data,
  });

  res.json({ updated: result.count });
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

router.get("/invoices", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, status } = req.query;
  const store = prisma as unknown as {
    timeflowInvoice: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof status === "string") where.status = status;

  const invoices = await store.timeflowInvoice.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  res.json(invoices);
});

router.get("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowInvoice: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  const invoice = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(invoice);
});

router.post("/invoices", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowInvoice: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const invoice = await store.timeflowInvoice.create({
    data: {
      organizationId,
      userId,
      clientId: body.clientId as string,
      periodStart: typeof body.periodStart === "string" ? body.periodStart : "",
      periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : "",
      billingMode: typeof body.billingMode === "string" ? body.billingMode : "outstanding",
      rangeStart: typeof body.rangeStart === "string" ? body.rangeStart : null,
      rangeEnd: typeof body.rangeEnd === "string" ? body.rangeEnd : null,
      grouping: typeof body.grouping === "string" ? body.grouping : "none",
      dueDate: typeof body.dueDate === "string" ? body.dueDate : "",
      entryIds: Array.isArray(body.entryIds) ? body.entryIds : [],
      timeEntryIds: Array.isArray(body.timeEntryIds) ? body.timeEntryIds : [],
      lineItems: Array.isArray(body.lineItems) ? body.lineItems : [],
      projectIds: Array.isArray(body.projectIds) ? body.projectIds : [],
      totalHours: typeof body.totalHours === "number" ? body.totalHours : 0,
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : 0,
      subtotal: typeof body.subtotal === "number" ? body.subtotal : 0,
      taxRate: typeof body.taxRate === "number" ? body.taxRate : 0,
      taxAmount: typeof body.taxAmount === "number" ? body.taxAmount : 0,
      totalAmount: typeof body.totalAmount === "number" ? body.totalAmount : 0,
      hasMixedRates: body.hasMixedRates === true,
      status: typeof body.status === "string" ? body.status : "draft",
    },
  });

  res.status(201).json(invoice);
});

router.put("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowInvoice: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  const fields = [
    "periodStart", "periodEnd", "billingMode", "rangeStart", "rangeEnd",
    "grouping", "dueDate", "totalHours", "hourlyRate", "subtotal",
    "taxRate", "taxAmount", "totalAmount", "status",
  ] as const;

  for (const field of fields) {
    if (field in body) data[field] = body[field];
  }
  if ("entryIds" in body && Array.isArray(body.entryIds)) data.entryIds = body.entryIds;
  if ("timeEntryIds" in body && Array.isArray(body.timeEntryIds)) data.timeEntryIds = body.timeEntryIds;
  if ("lineItems" in body && Array.isArray(body.lineItems)) data.lineItems = body.lineItems;
  if ("projectIds" in body && Array.isArray(body.projectIds)) data.projectIds = body.projectIds;
  if (typeof body.hasMixedRates === "boolean") data.hasMixedRates = body.hasMixedRates;
  if (body.status === "issued") data.issuedAt = new Date();
  if (body.status === "paid") data.paidAt = new Date();

  const updated = await store.timeflowInvoice.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowInvoice: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await store.timeflowInvoice.delete({ where: { id } });
  res.status(204).send();
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, program: "timeflow", status: "ready" });
});

export { router as timeflowRouter };
