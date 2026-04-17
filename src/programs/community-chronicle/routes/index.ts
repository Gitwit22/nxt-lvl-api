import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import express from "express";
import { BACKEND_URL, UPLOAD_DIR } from "../../../core/config/env.js";
import { prisma } from "../../../core/db/prisma.js";
import { toApiDocument } from "../../../documentMapper.js";
import { createDocumentPayload } from "../../../documentFactory.js";
import { enqueueProcessing } from "../../../processingQueue.js";
import { requireAuth, requireRole } from "../../../core/middleware/auth.middleware.js";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { getRequestTenantScope, type TenantScope } from "../../../tenant.js";
import { upload } from "../../../validators.js";
import { logger } from "../../../logger.js";
import { jobRouter } from "../../../jobRoutes.js";
import {
  isR2Configured,
  isR2Key,
  uploadToR2,
  deleteFromR2,
  getR2SignedDownloadUrl,
  getR2EnvMetadata,
  probeR2Connection,
} from "../../../core/storage/r2.js";

const router = express.Router();

// All document routes require a valid JWT.
router.use(requireAuth);

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

type StorageProvider = "local" | "network" | "r2_manual" | "r2_env";

type DestinationSettings = {
  provider: StorageProvider;
  enabled: boolean;
  saveProcessedDocs: boolean;
  useAsFinalArchive: boolean;
  localPath: string;
  localCreateSubfolders: boolean;
  networkPath: string;
  networkUsername: string;
  networkPassword: string;
  networkReconnectInstructions: string;
  r2BucketName: string;
  r2Endpoint: string;
  r2AccessKey: string;
  r2SecretKey: string;
  r2PublicUrl: string;
  r2Prefix: string;
  envManaged: boolean;
};

type StorageSettingsPayload = {
  finalArchive: DestinationSettings;
  processingStorage: DestinationSettings;
  postProcessingRules: Record<string, boolean>;
  pathStrategy: {
    byYear: boolean;
    bySource: boolean;
    byDocType: boolean;
    byTopic: boolean;
    customNamingPattern: string;
    basePathPrefix: string;
  };
};

const STORAGE_SETTINGS_PROGRAM_DOMAIN = "community-chronicle";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseProvider(value: unknown): StorageProvider {
  if (value === "local" || value === "network" || value === "r2_manual" || value === "r2_env") {
    return value;
  }
  if (value === "r2") {
    return "r2_manual";
  }
  return "local";
}

function getDefaultDestination(
  provider: StorageProvider,
  enabled: boolean,
  useAsFinalArchive: boolean,
  r2Env: ReturnType<typeof getR2EnvMetadata>,
): DestinationSettings {
  const envProvider = provider === "r2_env";
  return {
    provider,
    enabled,
    saveProcessedDocs: false,
    useAsFinalArchive,
    localPath: provider === "local" ? "" : "",
    localCreateSubfolders: true,
    networkPath: provider === "network" ? "" : "",
    networkUsername: "",
    networkPassword: "",
    networkReconnectInstructions: "",
    r2BucketName: envProvider ? r2Env.bucketName : "",
    r2Endpoint: envProvider ? r2Env.endpoint : "",
    r2AccessKey: "",
    r2SecretKey: "",
    r2PublicUrl: envProvider ? r2Env.publicUrl : "",
    r2Prefix: envProvider ? r2Env.defaultPrefix : "",
    envManaged: envProvider,
  };
}

function sanitizeDestination(
  raw: unknown,
  r2Env: ReturnType<typeof getR2EnvMetadata>,
  fallback: DestinationSettings,
): DestinationSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const provider = parseProvider(source.provider);

  const base: DestinationSettings = {
    provider,
    enabled: asBoolean(source.enabled, fallback.enabled),
    saveProcessedDocs: asBoolean(source.saveProcessedDocs, fallback.saveProcessedDocs),
    useAsFinalArchive: asBoolean(source.useAsFinalArchive, fallback.useAsFinalArchive),
    localPath: asString(source.localPath).trim(),
    localCreateSubfolders: asBoolean(source.localCreateSubfolders, true),
    networkPath: asString(source.networkPath).trim(),
    networkUsername: asString(source.networkUsername).trim(),
    networkPassword: asString(source.networkPassword),
    networkReconnectInstructions: asString(source.networkReconnectInstructions).trim(),
    r2BucketName: asString(source.r2BucketName).trim(),
    r2Endpoint: asString(source.r2Endpoint).trim(),
    r2AccessKey: asString(source.r2AccessKey).trim(),
    r2SecretKey: asString(source.r2SecretKey),
    r2PublicUrl: asString(source.r2PublicUrl).trim(),
    r2Prefix: asString(source.r2Prefix)
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
    envManaged: provider === "r2_env",
  };

  if (provider === "r2_env") {
    return {
      ...base,
      r2BucketName: r2Env.bucketName,
      r2Endpoint: r2Env.endpoint,
      r2AccessKey: "",
      r2SecretKey: "",
      r2PublicUrl: r2Env.publicUrl,
      r2Prefix: base.r2Prefix || r2Env.defaultPrefix,
      envManaged: true,
    };
  }

  if (provider !== "r2_manual") {
    return {
      ...base,
      r2BucketName: "",
      r2Endpoint: "",
      r2AccessKey: "",
      r2SecretKey: "",
      r2PublicUrl: "",
      r2Prefix: "",
      envManaged: false,
    };
  }

  return {
    ...base,
    envManaged: false,
  };
}

function sanitizeStorageSettings(
  payload: unknown,
  r2Env: ReturnType<typeof getR2EnvMetadata>,
): StorageSettingsPayload {
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const defaults: StorageSettingsPayload = {
    finalArchive: getDefaultDestination("local", true, true, r2Env),
    processingStorage: getDefaultDestination("network", false, false, r2Env),
    postProcessingRules: {
      keepOriginalOnly: false,
      keepProcessedText: true,
      keepGeneratedReport: true,
      saveMetadataOnly: false,
      moveToArchive: true,
      copySecondaryBackup: false,
    },
    pathStrategy: {
      byYear: true,
      bySource: false,
      byDocType: true,
      byTopic: true,
      customNamingPattern: "{{year}}/{{docType}}/{{topic}}/{{filename}}",
      basePathPrefix: "/",
    },
  };

  const postProcessingInput =
    source.postProcessingRules && typeof source.postProcessingRules === "object"
      ? (source.postProcessingRules as Record<string, unknown>)
      : {};

  const pathStrategyInput =
    source.pathStrategy && typeof source.pathStrategy === "object"
      ? (source.pathStrategy as Record<string, unknown>)
      : {};

  return {
    finalArchive: sanitizeDestination(source.finalArchive, r2Env, defaults.finalArchive),
    processingStorage: sanitizeDestination(
      source.processingStorage,
      r2Env,
      defaults.processingStorage,
    ),
    postProcessingRules: {
      keepOriginalOnly: asBoolean(postProcessingInput.keepOriginalOnly, defaults.postProcessingRules.keepOriginalOnly),
      keepProcessedText: asBoolean(postProcessingInput.keepProcessedText, defaults.postProcessingRules.keepProcessedText),
      keepGeneratedReport: asBoolean(
        postProcessingInput.keepGeneratedReport,
        defaults.postProcessingRules.keepGeneratedReport,
      ),
      saveMetadataOnly: asBoolean(postProcessingInput.saveMetadataOnly, defaults.postProcessingRules.saveMetadataOnly),
      moveToArchive: asBoolean(postProcessingInput.moveToArchive, defaults.postProcessingRules.moveToArchive),
      copySecondaryBackup: asBoolean(
        postProcessingInput.copySecondaryBackup,
        defaults.postProcessingRules.copySecondaryBackup,
      ),
    },
    pathStrategy: {
      byYear: asBoolean(pathStrategyInput.byYear, defaults.pathStrategy.byYear),
      bySource: asBoolean(pathStrategyInput.bySource, defaults.pathStrategy.bySource),
      byDocType: asBoolean(pathStrategyInput.byDocType, defaults.pathStrategy.byDocType),
      byTopic: asBoolean(pathStrategyInput.byTopic, defaults.pathStrategy.byTopic),
      customNamingPattern:
        asString(pathStrategyInput.customNamingPattern).trim() ||
        defaults.pathStrategy.customNamingPattern,
      basePathPrefix: asString(pathStrategyInput.basePathPrefix).trim() || defaults.pathStrategy.basePathPrefix,
    },
  };
}

function redactDestinationSecrets(destination: DestinationSettings): DestinationSettings {
  return {
    ...destination,
    networkPassword: "",
    r2AccessKey: "",
    r2SecretKey: "",
  };
}

function toSafeSettingsPayload(settings: StorageSettingsPayload): StorageSettingsPayload {
  return {
    ...settings,
    finalArchive: redactDestinationSecrets(settings.finalArchive),
    processingStorage: redactDestinationSecrets(settings.processingStorage),
  };
}

async function getStorageSettings(scope: TenantScope): Promise<StorageSettingsPayload> {
  const r2Env = getR2EnvMetadata();
  const record = await prisma.programStorageSettings.findUnique({
    where: {
      organizationId_programDomain: {
        organizationId: scope.organizationId,
        programDomain: STORAGE_SETTINGS_PROGRAM_DOMAIN,
      },
    },
    select: {
      settings: true,
    },
  });

  return sanitizeStorageSettings(record?.settings, r2Env);
}

async function saveStorageSettings(scope: TenantScope, payload: unknown): Promise<StorageSettingsPayload> {
  const r2Env = getR2EnvMetadata();
  const sanitized = sanitizeStorageSettings(payload, r2Env);

  const record = await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: scope.organizationId,
        programDomain: STORAGE_SETTINGS_PROGRAM_DOMAIN,
      },
    },
    create: {
      organizationId: scope.organizationId,
      programDomain: STORAGE_SETTINGS_PROGRAM_DOMAIN,
      settings: sanitized as unknown as never,
    },
    update: {
      settings: sanitized as unknown as never,
    },
    select: {
      settings: true,
    },
  });

  return sanitizeStorageSettings(record.settings, r2Env);
}

function parseR2AccountIdFromEndpoint(endpoint: string): string {
  const match = endpoint.trim().match(/^https:\/\/([^.]+)\.r2\.cloudflarestorage\.com\/?$/i);
  return match?.[1] || "";
}

async function findScopedDocument(id: string, scope: TenantScope) {
  return prisma.document.findFirst({
    where: {
      id,
      ...getDocumentScope(scope),
    },
    include: {
      uploadedBy: {
        select: {
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });
}

function formatUploaderName(
  user?: { displayName: string; firstName: string; lastName: string; email: string } | null,
): string | null {
  if (!user) return null;

  const display = user.displayName?.trim();
  if (display) return display;

  const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  if (full) return full;

  const email = user.email?.trim();
  return email || null;
}

async function resolveRequestUploaderName(user: ReturnType<typeof getRequestUser>): Promise<string | undefined> {
  if (!user) return undefined;

  const profile = await prisma.user.findUnique({
    where: { id: user.userId },
    select: {
      displayName: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });

  return formatUploaderName(profile ?? { displayName: "", firstName: "", lastName: "", email: user.email }) ?? undefined;
}

function toApiDocumentWithUploaderFallback(doc: {
  uploadedBy?: { displayName: string; firstName: string; lastName: string; email: string } | null;
  [key: string]: unknown;
}) {
  const mapped = toApiDocument(doc as never);
  if (mapped.author && mapped.author !== "Unknown") {
    return mapped;
  }

  const uploaderName = formatUploaderName(doc.uploadedBy);
  if (uploaderName) {
    return {
      ...mapped,
      author: uploaderName,
    };
  }

  return mapped;
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

router.get("/storage/capabilities", requireRole("admin"), async (_req, res) => {
  const r2Env = getR2EnvMetadata();
  res.json({
    r2Env: {
      provider: "r2_env",
      available: r2Env.available,
      configuredForActiveBackend: r2Env.configuredForActiveBackend,
      bucketName: r2Env.bucketName,
      accountId: r2Env.accountId,
      endpoint: r2Env.endpoint,
      publicUrl: r2Env.publicUrl,
      defaultPrefix: r2Env.defaultPrefix,
      status: r2Env.available ? "configured" : "not_configured",
      message: r2Env.available
        ? "Cloudflare R2 environment configuration is available."
        : "Cloudflare R2 environment configuration is incomplete.",
    },
  });
});

router.get("/storage/settings", requireRole("admin"), async (req, res) => {
  const scope = getRequestTenantScope(req);
  const settings = await getStorageSettings(scope);
  res.json({
    settings: toSafeSettingsPayload(settings),
    capabilities: {
      r2Env: getR2EnvMetadata(),
    },
  });
});

router.put("/storage/settings", requireRole("admin"), async (req, res) => {
  const scope = getRequestTenantScope(req);
  const settings = await saveStorageSettings(scope, req.body);
  res.json({
    settings: toSafeSettingsPayload(settings),
    capabilities: {
      r2Env: getR2EnvMetadata(),
    },
  });
});

router.post("/storage/test-connection", requireRole("admin"), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const r2Env = getR2EnvMetadata();
  const fallback = getDefaultDestination("local", true, true, r2Env);
  const destination = sanitizeDestination(body.destination, r2Env, fallback);

  if (destination.provider === "r2_env") {
    if (!r2Env.available) {
      res.status(400).json({
        success: false,
        message: "Cloudflare R2 environment configuration is not available.",
      });
      return;
    }

    const probe = await probeR2Connection({
      prefix: destination.r2Prefix,
    });
    res.status(probe.success ? 200 : 400).json(probe);
    return;
  }

  if (destination.provider === "r2_manual") {
    const accountId = parseR2AccountIdFromEndpoint(destination.r2Endpoint);
    if (!destination.r2BucketName || !destination.r2AccessKey || !destination.r2SecretKey || !accountId) {
      res.status(400).json({
        success: false,
        message: "Manual R2 test requires bucket, endpoint, access key, and secret key.",
      });
      return;
    }

    const probe = await probeR2Connection({
      prefix: destination.r2Prefix,
      config: {
        accountId,
        accessKeyId: destination.r2AccessKey,
        secretAccessKey: destination.r2SecretKey,
        bucketName: destination.r2BucketName,
        publicUrl: destination.r2PublicUrl,
      },
    });
    res.status(probe.success ? 200 : 400).json(probe);
    return;
  }

  res.status(400).json({
    success: false,
    message: "Connection tests from backend are currently supported for R2 destinations only.",
  });
});

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
    include: {
      uploadedBy: {
        select: {
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
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

  res.json(filtered.map(toApiDocumentWithUploaderFallback));
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
  res.json(toApiDocumentWithUploaderFallback(doc));
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

  const disposition = req.query.disposition === "inline" ? "inline" : "attachment";

  // R2 storage: redirect to a short-lived signed URL
  if (isR2Configured() && isR2Key(doc.filePath)) {
    const signedUrl = await getR2SignedDownloadUrl(
      doc.filePath,
      {
        filename: doc.originalFileName ?? undefined,
        disposition,
      },
    );
    res.redirect(302, signedUrl);
    return;
  }

  // Local disk fallback
  if (!fs.existsSync(doc.filePath)) {
    res.status(404).json({ error: "Stored file is missing" });
    return;
  }

  if (disposition === "inline") {
    const filename = doc.originalFileName ?? path.basename(doc.filePath);
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
    res.sendFile(path.resolve(doc.filePath));
    return;
  }

  res.download(doc.filePath, doc.originalFileName ?? path.basename(doc.filePath));
});

router.get("/documents/:id/resolve", requireAuth, async (req, res) => {
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

  if (!(isR2Configured() && isR2Key(doc.filePath))) {
    res.status(409).json({ error: "resolve endpoint is only available for R2-backed files" });
    return;
  }

  const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
  const signedUrl = await getR2SignedDownloadUrl(doc.filePath, {
    filename: doc.originalFileName ?? undefined,
    disposition,
  });

  res.json({
    url: signedUrl,
    filename: doc.originalFileName ?? null,
    disposition,
  });
});

router.post("/documents/manual", requireAuth, requireRole("uploader"), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const user = getRequestUser(req);
  const tenantScope = getRequestTenantScope(req);
  const uploaderName = await resolveRequestUploaderName(user);

  const payload = createDocumentPayload({
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    author: typeof body.author === "string" ? body.author : undefined,
    uploaderName,
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
  res.status(201).json(toApiDocumentWithUploaderFallback(created));
});

router.post("/documents/upload", requireAuth, requireRole("uploader"), upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "File is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const user = getRequestUser(req);
  const tenantScope = getRequestTenantScope(req);
  const uploaderName = await resolveRequestUploaderName(user);
  const payload = createDocumentPayload({
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    author: typeof body.author === "string" ? body.author : undefined,
    uploaderName,
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
    fileMeta: await (async () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const safe = req.file!.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

      if (isR2Configured()) {
        const orgId = tenantScope.organizationId;
        const userId = user?.userId ?? "unknown";
        const key = `${orgId}/${userId}/${stamp}-${safe}`;
        const { key: r2Key, fileUrl } = await uploadToR2(key, req.file!.buffer, req.file!.mimetype);
        return {
          originalFileName: req.file!.originalname,
          mimeType: req.file!.mimetype,
          fileSize: req.file!.size,
          fileUrl,
          filePath: r2Key,
        };
      }

      // Local disk fallback (dev only — ephemeral on Render free tier)
      const filename = `${stamp}-${safe}`;
      const localPath = path.join(UPLOAD_DIR, filename);
      await fsPromises.mkdir(UPLOAD_DIR, { recursive: true });
      await fsPromises.writeFile(localPath, req.file!.buffer);
      return {
        originalFileName: req.file!.originalname,
        mimeType: req.file!.mimetype,
        fileSize: req.file!.size,
        fileUrl: buildFileUrl(`/uploads/${filename}`),
        filePath: localPath,
      };
    })(),
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
  res.status(201).json(toApiDocumentWithUploaderFallback(created));
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
  const uploaderName = await resolveRequestUploaderName(user);

  const created = [];
  for (const file of files) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    let filePath: string;
    let fileUrl: string;

    if (isR2Configured()) {
      const orgId = tenantScope.organizationId;
      const userId = user?.userId ?? "unknown";
      const key = `${orgId}/${userId}/${stamp}-${safe}`;
      const result = await uploadToR2(key, file.buffer, file.mimetype);
      filePath = result.key;
      fileUrl = result.fileUrl;
    } else {
      const filename = `${stamp}-${safe}`;
      const localPath = path.join(UPLOAD_DIR, filename);
      await fsPromises.mkdir(UPLOAD_DIR, { recursive: true });
      await fsPromises.writeFile(localPath, file.buffer);
      filePath = localPath;
      fileUrl = buildFileUrl(`/uploads/${filename}`);
    }

    const payload = createDocumentPayload({
      intakeSource,
      uploaderName,
      fileMeta: {
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        fileUrl,
        filePath,
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

  res.status(201).json(created.map(toApiDocumentWithUploaderFallback));
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
  await prisma.document.update({
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

  const refreshed = await findScopedDocument(id, tenantScope);
  if (!refreshed) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(toApiDocumentWithUploaderFallback(refreshed));
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

  let storageDeleted: boolean | undefined;
  if (current.filePath) {
    try {
      const looksLikeUrl = current.filePath.startsWith("http://") || current.filePath.startsWith("https://");

      if (isR2Configured() && (isR2Key(current.filePath) || looksLikeUrl)) {
        storageDeleted = await deleteFromR2(current.filePath);
      } else if (fs.existsSync(current.filePath)) {
        fs.unlinkSync(current.filePath);
        storageDeleted = true;
      } else {
        storageDeleted = false;
      }
    } catch (error) {
      storageDeleted = false;
      logger.error("Failed to delete stored file", {
        documentId: id,
        filePath: current.filePath,
        organizationId: tenantScope.organizationId,
        programDomain: tenantScope.programDomain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  res.status(200).json({ deleted: true, storageDeleted });
});

router.post("/documents/:id/retry", requireAuth, requireRole("reviewer"), async (req, res) => {
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

  if (!current.filePath) {
    res.status(400).json({
      error: "Document has no source file path and cannot be reprocessed.",
    });
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
  res.json(toApiDocumentWithUploaderFallback(refreshed));
});

// POST /documents/reprocess
// Re-queues documents for OCR/extraction. Admin only.
// Body: { ids?: string[] }  — specific docs to reprocess.
// If ids is omitted, reprocesses every document in the tenant scope that
// has a file attached and is not already queued or actively processing.
router.post("/documents/reprocess", requireAuth, requireRole("admin"), async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const body = req.body as Record<string, unknown>;
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : null;

  const scope = getDocumentScope(tenantScope);

  // Find the target documents — must have a filePath (can't OCR manual entries with no file)
  const docs = await prisma.document.findMany({
    where: {
      ...scope,
      ...(ids ? { id: { in: ids } } : {}),
      filePath: { not: null },
      // Skip anything already in flight
      processingStatus: { notIn: ["queued", "processing"] },
    },
    select: { id: true },
  });

  if (docs.length === 0) {
    res.json({ queued: 0, message: "No eligible documents found." });
    return;
  }

  const now = new Date();
  await prisma.document.updateMany({
    where: { id: { in: docs.map((d) => d.id) } },
    data: {
      processingStatus: "queued",
      status: "queued",
      statusUpdatedAt: now,
      needsReview: false,
    },
  });

  for (const doc of docs) {
    await enqueueProcessing(doc.id, tenantScope);
  }

  logger.info("Bulk reprocess queued", {
    count: docs.length,
    organizationId: tenantScope.organizationId,
    programDomain: tenantScope.programDomain,
    requestedIds: ids ?? "all",
  });

  res.json({ queued: docs.length, documentIds: docs.map((d) => d.id) });
});

router.get("/review-queue", requireAuth, requireRole("reviewer"), async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const docs = await prisma.document.findMany({
    where: { needsReview: true, ...getDocumentScope(tenantScope) },
    orderBy: { updatedAt: "desc" },
    include: {
      uploadedBy: {
        select: {
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });
  res.json(docs.map(toApiDocumentWithUploaderFallback));
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

  await prisma.document.update({
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

  const refreshed = await findScopedDocument(id, tenantScope);
  if (!refreshed) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(toApiDocumentWithUploaderFallback(refreshed));
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

  await prisma.document.update({
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

  const refreshed = await findScopedDocument(id, tenantScope);
  if (!refreshed) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(toApiDocumentWithUploaderFallback(refreshed));
});

export { router as communityChronicleRouter };
