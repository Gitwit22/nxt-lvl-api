import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import { API_PREFIX, UPLOAD_DIR, CORS_ORIGIN, BACKEND_URL } from "./config.js";
import { prisma } from "./db.js";
import { toApiDocument } from "./documentMapper.js";
import { createDocumentPayload } from "./documentFactory.js";
import { enqueueProcessing } from "./processingQueue.js";
import { requireAuth, requireRole, getRequestUser } from "./auth.js";
import { getRequestTenantScope, type TenantScope } from "./tenant.js";
import { upload } from "./validators.js";
import { logger } from "./logger.js";
import { authRouter } from "./authRoutes.js";
import { jobRouter } from "./jobRoutes.js";

const app = express();

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));

/** Build a file URL that the frontend can use. In production, prefix with BACKEND_URL. */
function buildFileUrl(relativePath: string): string {
  if (BACKEND_URL && !BACKEND_URL.startsWith("http://localhost")) {
    return `${BACKEND_URL.replace(/\/$/, "")}${relativePath}`;
  }
  return relativePath;
}

// Routers
app.use(`${API_PREFIX}/auth`, authRouter);
app.use(`${API_PREFIX}/jobs`, jobRouter);

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

app.get(`${API_PREFIX}/health`, async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: "Database unreachable" });
  }
});

app.get(`${API_PREFIX}/documents`, requireAuth, async (req, res) => {
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

app.get(`${API_PREFIX}/documents/:id`, requireAuth, async (req, res) => {
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

app.get(`${API_PREFIX}/documents/:id/download`, requireAuth, async (req, res) => {
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

app.post(`${API_PREFIX}/documents/manual`, requireAuth, requireRole("uploader"), async (req, res) => {
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

app.post(`${API_PREFIX}/documents/upload`, requireAuth, requireRole("uploader"), upload.single("file"), async (req, res) => {
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
    file: req.file!.originalname,
    userId: user?.userId,
    organizationId: tenantScope.organizationId,
    programDomain: tenantScope.programDomain,
  });
  res.status(201).json(toApiDocument(created));
});

app.post(`${API_PREFIX}/documents/upload/batch`, requireAuth, requireRole("uploader"), upload.array("files", 50), async (req, res) => {
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

app.patch(`${API_PREFIX}/documents/:id`, requireAuth, requireRole("reviewer"), async (req, res) => {
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

app.delete(`${API_PREFIX}/documents/:id`, requireAuth, requireRole("admin"), async (req, res) => {
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

app.post(`${API_PREFIX}/documents/:id/retry`, requireAuth, requireRole("admin"), async (req, res) => {
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

app.get(`${API_PREFIX}/review-queue`, requireAuth, requireRole("reviewer"), async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const docs = await prisma.document.findMany({
    where: { needsReview: true, ...getDocumentScope(tenantScope) },
    orderBy: { updatedAt: "desc" },
  });
  res.json(docs.map(toApiDocument));
});

app.post(`${API_PREFIX}/review-queue/:id/resolve`, requireAuth, requireRole("reviewer"), async (req, res) => {
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

app.post(`${API_PREFIX}/review-queue/:id/mark`, requireAuth, requireRole("reviewer"), async (req, res) => {
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

// Multer-specific error handler (file size / type rejections)
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && typeof err === "object" && "code" in err) {
    const multerErr = err as { code: string; message: string; status?: number };
    if (multerErr.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File exceeds maximum allowed size" });
      return;
    }
    if (multerErr.status === 415 || multerErr.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(415).json({ error: multerErr.message || "Unsupported file type" });
      return;
    }
  }
  next(err);
});

// General error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown server error";
  logger.error("Unhandled route error", { error: message });
  res.status(500).json({ error: message });
});

export { app };
