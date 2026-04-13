import fs from "fs";
import path from "path";
import express from "express";
import jwt from "jsonwebtoken";
import { BACKEND_URL, JWT_SECRET } from "../../../core/config/env.js";
import { prisma } from "../../../core/db/prisma.js";
import { toApiDocument } from "../../../documentMapper.js";
import { createDocumentPayload } from "../../../documentFactory.js";
import { enqueueProcessing } from "../../../processingQueue.js";
import { requireAuth, requireRole } from "../../../core/middleware/auth.middleware.js";
import { getRequestUser, signToken } from "../../../core/auth/auth.service.js";
import { requireProgramSubscription } from "../../../core/middleware/program-access.middleware.js";
import { getRequestTenantScope, type TenantScope } from "../../../tenant.js";
import { upload } from "../../../validators.js";
import { logger } from "../../../logger.js";
import { jobRouter } from "../../../jobRoutes.js";

const router = express.Router();

const CC_PROGRAM_DOMAIN = "community-chronicle";

// ─── Platform Auth / Consume ──────────────────────────────────────────────────
/**
 * POST /api/community-chronicle/platform-auth/consume
 * Accepts a Suite launch token (issued by POST /api/auth/program-token) and
 * returns a Chronicle-scoped JWT the frontend stores as its session token.
 */
router.post("/platform-auth/consume", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const launchToken =
    typeof body.launchToken === "string" ? body.launchToken :
    typeof body.token === "string" ? body.token : undefined;

  if (!launchToken) {
    res.status(400).json({ error: "launchToken is required" });
    return;
  }

  let claims: { userId: string; email: string; role: string; organizationId: string } | undefined;
  try {
    const payload = jwt.verify(launchToken, JWT_SECRET) as Record<string, unknown>;
    const userId = typeof payload.userId === "string" ? payload.userId : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : undefined;
    const role = typeof payload.role === "string" ? payload.role : "member";
    if (userId && email && organizationId) {
      claims = { userId, email, role, organizationId };
    }
  } catch {
    // invalid token
  }

  if (!claims) {
    res.status(401).json({ error: "Invalid or expired launch token", code: "invalid_launch_token" });
    return;
  }

  // Verify org has an active community-chronicle subscription
  const prismaExt = prisma as typeof prisma & {
    organizationProgramSubscription: {
      findFirst: (args: Record<string, unknown>) => Promise<{ status: string } | null>;
    };
  };
  const sub = await prismaExt.organizationProgramSubscription.findFirst({
    where: { organizationId: claims.organizationId, programId: { contains: "community-chronicle" } },
  } as Record<string, unknown>).catch(() => null);

  if (!sub || !["active", "trialing"].includes(sub.status)) {
    res.status(403).json({ error: "No active Community Chronicle subscription", code: "no_subscription" });
    return;
  }

  const chronicleToken = signToken({
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    organizationId: claims.organizationId,
    programDomain: CC_PROGRAM_DOMAIN,
  });

  logger.info("[community-chronicle] platform-auth/consume success", {
    userId: claims.userId,
    organizationId: claims.organizationId,
  });

  res.json({
    token: chronicleToken,
    user: {
      id: claims.userId,
      email: claims.email,
      role: claims.role,
      organizationId: claims.organizationId,
      programDomain: CC_PROGRAM_DOMAIN,
    },
    appInitState: "ready",
  });
});

// ─── Subscription gate ────────────────────────────────────────────────────────
// All routes below require a valid JWT and an active community-chronicle subscription.
router.use(requireAuth, requireProgramSubscription("community-chronicle"));

function buildFileUrl(relativePath: string): string {
  if (BACKEND_URL && !BACKEND_URL.startsWith("http://localhost")) {
    return `${BACKEND_URL.replace(/\/$/, "")}${relativePath}`;
  }
  return relativePath;
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // no-op
    }
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRouteId(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function getDocumentScope(scope: TenantScope) {
  return {
    organizationId: scope.organizationId,
    programDomain: scope.programDomain,
  };
}

async function findScopedDocument(id: string, scope: TenantScope) {
  return prisma.document.findFirst({
    where: {
      id,
      ...getDocumentScope(scope),
    },
  });
}

function parseFilters(query: Record<string, unknown>) {
  return {
    search: typeof query.search === "string" ? query.search.toLowerCase() : undefined,
    year: parseNumber(query.year),
    category: typeof query.category === "string" ? query.category : undefined,
    processingStatus:
      typeof query.processingStatus === "string" ? query.processingStatus : undefined,
    intakeSource: typeof query.intakeSource === "string" ? query.intakeSource : undefined,
  };
}

router.use("/jobs", jobRouter);

router.get("/documents", requireAuth, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const filters = parseFilters(req.query as Record<string, unknown>);
  const docs = await prisma.document.findMany({
    where: {
      ...getDocumentScope(tenantScope),
      year: filters.year,
      category: filters.category,
      processingStatus: filters.processingStatus,
      intakeSource: filters.intakeSource,
    },
    orderBy: { createdAt: "desc" },
  });

  const filtered = docs.filter((doc: (typeof docs)[number]) => {
    if (filters.search) {
      const haystack = [doc.title, doc.description, doc.extractedText, doc.author]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.search)) return false;
    }
    if (filters.year && doc.year !== filters.year) return false;
    if (filters.category && doc.category !== filters.category) return false;
    if (filters.processingStatus && doc.processingStatus !== filters.processingStatus) return false;
    if (filters.intakeSource && doc.intakeSource !== filters.intakeSource) return false;
    return true;
  });

  res.json(filtered.map(toApiDocument));
});

router.get("/documents/:id", requireAuth, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const doc = await findScopedDocument(id, tenantScope);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json(toApiDocument(doc));
});

router.get("/documents/:id/download", requireAuth, async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const doc = await findScopedDocument(id, tenantScope);
  if (!doc?.filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (!fs.existsSync(doc.filePath)) {
    res.status(404).json({ error: "Stored file is missing" });
    return;
  }

  res.download(doc.filePath, doc.originalFileName ?? path.basename(doc.filePath));
});

router.post("/documents/manual", requireAuth, requireRole("uploader"), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const user = getRequestUser(req);
  const tenantScope = getRequestTenantScope(req);

  const payload = createDocumentPayload({
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    author: typeof body.author === "string" ? body.author : undefined,
    year: parseNumber(body.year),
    month: parseNumber(body.month),
    category: typeof body.category === "string" ? body.category : undefined,
    type: typeof body.type === "string" ? body.type : undefined,
    financialCategory: typeof body.financialCategory === "string" ? body.financialCategory : undefined,
    financialDocumentType:
      typeof body.financialDocumentType === "string" ? body.financialDocumentType : undefined,
    tags: parseStringArray(body.tags),
    keywords: parseStringArray(body.keywords),
    intakeSource: "manual_entry",
    sourceReference: typeof body.sourceReference === "string" ? body.sourceReference : undefined,
    department: typeof body.department === "string" ? body.department : undefined,
    extractedText: typeof body.extractedText === "string" ? body.extractedText : undefined,
  });

  const created = await prisma.document.create({
    data: {
      ...payload,
      ...getDocumentScope(tenantScope),
      createdByUserId: user?.userId ?? null,
      uploadedById: user?.userId ?? null,
    } as never,
  });
  logger.info("Manual document created", {
    docId: created.id,
    userId: user?.userId,
    organizationId: tenantScope.organizationId,
    programDomain: tenantScope.programDomain,
  });
  res.status(201).json(toApiDocument(created));
});

router.post("/documents/upload", requireAuth, requireRole("uploader"), upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "File is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const user = getRequestUser(req);
  const tenantScope = getRequestTenantScope(req);
  const payload = createDocumentPayload({
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    author: typeof body.author === "string" ? body.author : undefined,
    year: parseNumber(body.year),
    month: parseNumber(body.month),
    category: typeof body.category === "string" ? body.category : undefined,
    type: typeof body.type === "string" ? body.type : undefined,
    financialCategory: typeof body.financialCategory === "string" ? body.financialCategory : undefined,
    financialDocumentType:
      typeof body.financialDocumentType === "string" ? body.financialDocumentType : undefined,
    tags: parseStringArray(body.tags),
    keywords: parseStringArray(body.keywords),
    intakeSource: typeof body.intakeSource === "string" ? body.intakeSource : "file_upload",
    sourceReference: typeof body.sourceReference === "string" ? body.sourceReference : undefined,
    department: typeof body.department === "string" ? body.department : undefined,
    fileMeta: {
      originalFileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      fileUrl: buildFileUrl(`/uploads/${path.basename(req.file.path)}`),
      filePath: req.file.path,
    },
  });

  const created = await prisma.document.create({
    data: {
      ...payload,
      ...getDocumentScope(tenantScope),
      createdByUserId: user?.userId ?? null,
      uploadedById: user?.userId ?? null,
    } as never,
  });
  await enqueueProcessing(created.id, tenantScope);
  logger.info("File uploaded", {
    docId: created.id,
    file: req.file.originalname,
    userId: user?.userId,
    organizationId: tenantScope.organizationId,
    programDomain: tenantScope.programDomain,
  });
  res.status(201).json(toApiDocument(created));
});

router.post("/documents/upload/batch", requireAuth, requireRole("uploader"), upload.array("files", 50), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) {
    res.status(400).json({ error: "At least one file is required" });
    return;
  }

  const intakeSource = typeof req.body.intakeSource === "string" ? req.body.intakeSource : "multi_upload";
  const user = getRequestUser(req);
  const tenantScope = getRequestTenantScope(req);

  const created = [];
  for (const file of files) {
    const payload = createDocumentPayload({
      intakeSource,
      fileMeta: {
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        fileUrl: buildFileUrl(`/uploads/${path.basename(file.path)}`),
        filePath: file.path,
      },
    });

    const doc = await prisma.document.create({
      data: {
        ...payload,
        ...getDocumentScope(tenantScope),
        createdByUserId: user?.userId ?? null,
        uploadedById: user?.userId ?? null,
      } as never,
    });
    await enqueueProcessing(doc.id, tenantScope);
    created.push(doc);
  }

  res.status(201).json(created.map(toApiDocument));
});

router.patch("/documents/:id", requireAuth, requireRole("reviewer"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const current = await findScopedDocument(id, tenantScope);
  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const updated = await prisma.document.update({
    where: { id },
    data: {
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      author: typeof body.author === "string" ? body.author : undefined,
      year: parseNumber(body.year),
      month: parseNumber(body.month),
      category: typeof body.category === "string" ? body.category : undefined,
      type: typeof body.type === "string" ? body.type : undefined,
      financialCategory: typeof body.financialCategory === "string" ? body.financialCategory : undefined,
      financialDocumentType:
        typeof body.financialDocumentType === "string" ? body.financialDocumentType : undefined,
      tags: body.tags ? parseStringArray(body.tags) : undefined,
      keywords: body.keywords ? parseStringArray(body.keywords) : undefined,
      processingStatus:
        typeof body.processingStatus === "string" ? body.processingStatus : undefined,
      review: body.review && typeof body.review === "object" ? body.review : undefined,
      needsReview: typeof body.needsReview === "boolean" ? body.needsReview : undefined,
      aiSummary: typeof body.aiSummary === "string" ? body.aiSummary : undefined,
    },
  });

  res.json(toApiDocument(updated));
});

router.delete("/documents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const current = await findScopedDocument(id, tenantScope);
  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  await prisma.processingJob.deleteMany({
    where: {
      documentId: id,
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
    },
  });
  await prisma.document.delete({ where: { id } });

  if (current.filePath && fs.existsSync(current.filePath)) {
    fs.unlinkSync(current.filePath);
  }

  res.status(204).send();
});

router.post("/documents/:id/retry", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const current = await findScopedDocument(id, tenantScope);
  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  await prisma.document.update({
    where: { id },
    data: {
      processingStatus: "queued",
      status: "queued",
      statusUpdatedAt: new Date(),
      needsReview: false,
      review: { required: false },
    },
  });

  await enqueueProcessing(id, tenantScope);
  const refreshed = await findScopedDocument(id, tenantScope);
  if (!refreshed) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json(toApiDocument(refreshed));
});

router.get("/review-queue", requireAuth, requireRole("reviewer"), async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const docs = await prisma.document.findMany({
    where: { needsReview: true, ...getDocumentScope(tenantScope) },
    orderBy: { updatedAt: "desc" },
  });
  res.json(docs.map(toApiDocument));
});

router.post("/review-queue/:id/resolve", requireAuth, requireRole("reviewer"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const doc = await findScopedDocument(id, tenantScope);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const resolution = typeof body.resolution === "string" ? body.resolution : "approved";
  const notes = typeof body.notes === "string" ? body.notes : undefined;

  const updated = await prisma.document.update({
    where: { id },
    data: {
      needsReview: false,
      reviewedById: getRequestUser(req)?.userId ?? null,
      review: {
        required: false,
        resolution,
        notes,
        reviewedBy: getRequestUser(req)?.email ?? "unknown",
        reviewedAt: new Date().toISOString(),
      },
      status: resolution === "rejected" ? "failed" : "archived",
    } as never,
  });

  res.json(toApiDocument(updated));
});

router.post("/review-queue/:id/mark", requireAuth, requireRole("reviewer"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const tenantScope = getRequestTenantScope(req);
  const doc = await findScopedDocument(id, tenantScope);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const reasons = parseStringArray(body.reasons);
  const priority = typeof body.priority === "string" ? body.priority : "medium";

  const updated = await prisma.document.update({
    where: { id },
    data: {
      needsReview: true,
      review: {
        required: true,
        reason: reasons.length > 0 ? reasons : ["Manual review requested"],
        priority,
      },
      status: "review_required",
      statusUpdatedAt: new Date(),
    },
  });

  res.json(toApiDocument(updated));
});

export { router as communityChronicleRouter };
