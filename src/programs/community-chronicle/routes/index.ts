import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import express from "express";
import { prisma } from "../../../core/db/prisma.js";
import { toApiDocument } from "../../../documentMapper.js";
import { createDocumentPayload } from "../../../documentFactory.js";
import { enqueueProcessing, runExtraction } from "../../../processingQueue.js";
import { requireAuth, requireRole } from "../../../core/middleware/auth.middleware.js";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { getRequestTenantScope, type TenantScope } from "../../../tenant.js";
import { upload } from "../../../validators.js";
import { logger } from "../../../logger.js";
import { jobRouter } from "../../../jobRoutes.js";
import {
  getR2EnvMetadata,
  probeR2Connection,
} from "../../../core/storage/r2.js";
import {
  classifyDocumentType,
  extractLightweightMetadata,
  SYSTEM_DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
} from "../../../core/services/documentIntelligence/lightweightMetadata.js";
import { downloadFromR2, isR2Configured, isR2Key } from "../../../core/storage/r2.js";
import {
  resolveStorageAdapter,
  StorageConfigError,
} from "../../../core/storage/storageResolver.js";

const router = express.Router();

// All document routes require a valid JWT.
router.use(requireAuth);

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

const MISSION_OPS_PROGRAM_DOMAIN = "mission-hub";

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
        programDomain: scope.programDomain,
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
        programDomain: scope.programDomain,
      },
    },
    create: {
      organizationId: scope.organizationId,
      programDomain: scope.programDomain,
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

type PredictionConfidenceBand = "high" | "medium" | "low";

type PredictionCandidate = {
  type: string;
  label: string;
  confidence: number;
  reasons: string[];
};

type DocumentTypePrediction = {
  predictedType: string;
  confidence: number;
  confidenceBand: PredictionConfidenceBand;
  sourceName: string | null;
  pageCount: number;
  firstPageSnippet: string;
  candidates: PredictionCandidate[];
  layoutHints: string[];
};

const PREDICTION_RULES: Array<{
  type: string;
  filenameTokens: string[];
  headerPhrases: string[];
  sourceHints: string[];
}> = [
  {
    type: "invoice",
    filenameTokens: ["invoice", "inv_", "bill"],
    headerPhrases: ["invoice", "invoice number", "amount due", "bill to"],
    sourceHints: ["adp", "quickbooks"],
  },
  {
    type: "receipt",
    filenameTokens: ["receipt", "ack", "donation_receipt"],
    headerPhrases: ["receipt", "payment received", "thank you for your donation"],
    sourceHints: ["paypal", "frontstream", "square"],
  },
  {
    type: "voucher",
    filenameTokens: ["voucher"],
    headerPhrases: ["voucher", "payment voucher", "voucher number"],
    sourceHints: ["petty cash"],
  },
  {
    type: "reimbursement_request",
    filenameTokens: ["reimbursement", "expense_report", "expense_claim"],
    headerPhrases: ["reimbursement", "expense report", "request for reimbursement"],
    sourceHints: ["employee expense"],
  },
  {
    type: "payroll_record",
    filenameTokens: ["payroll", "paystub", "pay_stub", "payslip"],
    headerPhrases: ["pay stub", "earnings statement", "gross pay", "net pay"],
    sourceHints: ["adp", "gusto", "paychex"],
  },
  {
    type: "email_correspondence",
    filenameTokens: ["email", "message", "correspondence"],
    headerPhrases: ["from:", "to:", "subject:", "forwarded message"],
    sourceHints: ["gmail", "outlook", "yahoo"],
  },
  {
    type: "approval_message",
    filenameTokens: ["approval", "approved"],
    headerPhrases: ["approved", "approval", "your request has been approved"],
    sourceHints: ["board", "executive"],
  },
  {
    type: "grant_award_letter",
    filenameTokens: ["award_letter", "grant_award", "noa"],
    headerPhrases: ["grant award", "notice of award", "award amount", "grant number"],
    sourceHints: ["federal", "foundation", "cfda"],
  },
  {
    type: "deposit_confirmation",
    filenameTokens: ["deposit_confirmation", "deposit_receipt", "wire_confirm"],
    headerPhrases: ["deposit confirmation", "funds deposited", "account credited"],
    sourceHints: ["bank", "ach", "wire transfer"],
  },
  {
    type: "check_image",
    filenameTokens: ["check_image", "check_scan", "cheque"],
    headerPhrases: ["pay to the order of", "routing number", "account number"],
    sourceHints: ["bank"],
  },
];

function confidenceBand(confidence: number): PredictionConfidenceBand {
  if (confidence >= 0.78) return "high";
  if (confidence >= 0.52) return "medium";
  return "low";
}

function appendProcessingHistory(existing: unknown, entry: Record<string, unknown>) {
  const rows = Array.isArray(existing) ? [...existing] : [];
  rows.push(entry);
  return rows;
}

function collectRepeatedPhrases(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function buildTypePrediction(args: {
  filename?: string | null;
  mimeType?: string | null;
  text: string;
  pageCount: number;
  sourceName: string | null;
  preferredType?: string;
}): DocumentTypePrediction {
  const fn = (args.filename ?? "").toLowerCase();
  const corpus = `${fn}\n${args.text}`.toLowerCase();
  const firstPageSnippet = args.text.slice(0, 2500);
  const header = firstPageSnippet.slice(0, 800).toLowerCase();

  const layoutHints: string[] = [];
  if (args.pageCount <= 1) layoutHints.push("single_page");
  if (args.pageCount >= 5) layoutHints.push("multi_page");
  if (/\$\s*\d|amount due|balance due|subtotal|total/gi.test(corpus)) layoutHints.push("currency_dense");
  if (/from:\s|to:\s|subject:\s|cc:\s|bcc:\s/gi.test(corpus)) layoutHints.push("email_header_layout");
  if (/routing number|account number|pay to the order of|authorized signature/gi.test(corpus)) layoutHints.push("banking_layout");
  if ((args.mimeType ?? "").startsWith("image/")) layoutHints.push("image_file");

  const candidates: PredictionCandidate[] = [];
  for (const rule of PREDICTION_RULES) {
    let score = 0;
    const reasons: string[] = [];

    const filenameMatches = rule.filenameTokens.filter((token) => fn.includes(token));
    if (filenameMatches.length > 0) {
      score += Math.min(0.6, filenameMatches.length * 0.22);
      reasons.push(`filename clues: ${filenameMatches.join(", ")}`);
    }

    const headerMatches = rule.headerPhrases.filter((phrase) => header.includes(phrase));
    if (headerMatches.length > 0) {
      score += Math.min(0.55, headerMatches.length * 0.16);
      reasons.push(`header phrases: ${headerMatches.slice(0, 3).join(", ")}`);
    }

    if (args.sourceName) {
      const sourceLower = args.sourceName.toLowerCase();
      const sourceHits = rule.sourceHints.filter((hint) => sourceLower.includes(hint));
      if (sourceHits.length > 0) {
        score += Math.min(0.25, sourceHits.length * 0.12);
        reasons.push(`source/company clue: ${sourceHits.join(", ")}`);
      }
    }

    if (rule.type === "email_correspondence" && layoutHints.includes("email_header_layout")) {
      score += 0.14;
      reasons.push("layout hint: email headers");
    }
    if ((rule.type === "check_image" || rule.type === "deposit_confirmation") && layoutHints.includes("banking_layout")) {
      score += 0.12;
      reasons.push("layout hint: banking fields");
    }
    if ((rule.type === "invoice" || rule.type === "receipt" || rule.type === "voucher") && layoutHints.includes("currency_dense")) {
      score += 0.1;
      reasons.push("layout hint: currency-heavy content");
    }
    if ((rule.type === "check_image" || rule.type === "business_card") && layoutHints.includes("image_file")) {
      score += 0.08;
      reasons.push("file hint: image upload");
    }

    if (score > 0) {
      const bounded = Math.max(0, Math.min(0.95, score));
      candidates.push({
        type: rule.type,
        label: DOCUMENT_TYPE_LABELS[rule.type as keyof typeof DOCUMENT_TYPE_LABELS] ?? rule.type,
        confidence: Number(bounded.toFixed(3)),
        reasons,
      });
    }
  }

  const fallback = classifyDocumentType(args.text, args.filename ?? null);
  candidates.sort((a, b) => b.confidence - a.confidence);

  let top = candidates[0];
  if (!top || fallback.confidence > top.confidence) {
    top = {
      type: fallback.documentType,
      label: DOCUMENT_TYPE_LABELS[fallback.documentType as keyof typeof DOCUMENT_TYPE_LABELS] ?? fallback.documentType,
      confidence: Number(fallback.confidence.toFixed(3)),
      reasons: [
        fallback.classificationMatchedBy === "rule"
          ? "rule-based classifier matched strongly"
          : "keyword/fingerprint fallback classifier",
      ],
    };
  }

  if (args.preferredType) {
    const preferred = candidates.find((c) => c.type === args.preferredType);
    if (preferred) {
      preferred.confidence = Math.min(0.97, preferred.confidence + 0.1);
      preferred.reasons = [...preferred.reasons, "manual preferred type boost"];
      candidates.sort((a, b) => b.confidence - a.confidence);
      top = candidates[0];
    }
  }

  const resolvedType = top?.type ?? "other_unclassified";
  const resolvedConfidence = top?.confidence ?? 0;

  return {
    predictedType: resolvedType,
    confidence: resolvedConfidence,
    confidenceBand: confidenceBand(resolvedConfidence),
    sourceName: args.sourceName,
    pageCount: args.pageCount,
    firstPageSnippet,
    candidates: candidates.slice(0, 5),
    layoutHints,
  };
}

async function saveManualOverrideTrainingEvidence(args: {
  tenantScope: TenantScope;
  documentId: string;
  chosenType: string;
  filename?: string | null;
  sourceName: string | null;
  snippet: string;
  layoutHints: string[];
  repeatedPhrases: string[];
}): Promise<boolean> {
  const p = prisma as unknown as Record<string, unknown>;
  const docTypeClient = p.chronicleDocumentType as {
    findFirst?: Function;
    upsert?: Function;
  } | undefined;
  const fingerprintClient = p.chronicleTypeFingerprint as {
    upsert?: Function;
  } | undefined;

  if (!docTypeClient?.upsert || !docTypeClient.findFirst || !fingerprintClient?.upsert) {
    return false;
  }

  const key = args.chosenType.toLowerCase().trim().replace(/\s+/g, "_");
  const label = DOCUMENT_TYPE_LABELS[key as keyof typeof DOCUMENT_TYPE_LABELS] ?? args.chosenType;

  const typeRecord = await docTypeClient.upsert({
    where: {
      organizationId_programDomain_key: {
        organizationId: args.tenantScope.organizationId,
        programDomain: args.tenantScope.programDomain,
        key,
      },
    },
    create: {
      id: crypto.randomUUID(),
      organizationId: args.tenantScope.organizationId,
      programDomain: args.tenantScope.programDomain,
      key,
      label,
      description: "Auto-learned from manual rerun override",
      isSystemType: SYSTEM_DOCUMENT_TYPES.includes(key as never),
      isUserCreated: !SYSTEM_DOCUMENT_TYPES.includes(key as never),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: {
      active: true,
      updatedAt: new Date(),
    },
  });

  const existing = await docTypeClient.findFirst({
    where: {
      id: typeRecord.id,
      organizationId: args.tenantScope.organizationId,
      programDomain: args.tenantScope.programDomain,
    },
    include: { fingerprint: true },
  });

  const existingFp = (existing?.fingerprint ?? {}) as Record<string, unknown>;
  const existingPhrases = Array.isArray(existingFp.phrases) ? (existingFp.phrases as string[]) : [];
  const existingCompanies = Array.isArray(existingFp.companies) ? (existingFp.companies as string[]) : [];
  const existingFilenamePatterns = Array.isArray(existingFp.filenamePatterns) ? (existingFp.filenamePatterns as string[]) : [];
  const existingDatePatterns = Array.isArray(existingFp.datePatterns) ? (existingFp.datePatterns as string[]) : [];
  const existingSampleIds = Array.isArray(existingFp.sampleDocumentIds) ? (existingFp.sampleDocumentIds as string[]) : [];

  const mergedPhrases = [...new Set([...existingPhrases, ...args.repeatedPhrases])].slice(0, 30);
  const mergedCompanies = [...new Set([...existingCompanies, ...(args.sourceName ? [args.sourceName] : [])])].slice(0, 12);
  const mergedFilenamePatterns = [...new Set([
    ...existingFilenamePatterns,
    ...(args.filename ? [args.filename.toLowerCase().replace(/\d+/g, "{n}")] : []),
  ])].slice(0, 20);
  const mergedDatePatterns = [...new Set([...existingDatePatterns, ...args.layoutHints])].slice(0, 20);
  const mergedSampleIds = [...new Set([...existingSampleIds, args.documentId])].slice(0, 40);

  await fingerprintClient.upsert({
    where: { documentTypeId: typeRecord.id },
    create: {
      id: crypto.randomUUID(),
      documentTypeId: typeRecord.id,
      phrases: mergedPhrases,
      companies: mergedCompanies,
      filenamePatterns: mergedFilenamePatterns,
      datePatterns: mergedDatePatterns,
      sampleDocumentIds: mergedSampleIds,
      updatedAt: new Date(),
    },
    update: {
      phrases: mergedPhrases,
      companies: mergedCompanies,
      filenamePatterns: mergedFilenamePatterns,
      datePatterns: mergedDatePatterns,
      sampleDocumentIds: mergedSampleIds,
      updatedAt: new Date(),
    },
  });

  return true;
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

  // Resolve backend for this tenant and use the adapter to get a download URL.
  const storage = await resolveStorageAdapter(tenantScope);
  if (storage.adapter.ownsKey(doc.filePath)) {
    const downloadUrl = await storage.adapter.getDownloadUrl(doc.filePath, {
      filename: doc.originalFileName ?? undefined,
      disposition,
    });
    res.redirect(302, downloadUrl);
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

  const storage = await resolveStorageAdapter(tenantScope);
  if (!storage.adapter.ownsKey(doc.filePath) || storage.adapter.backendId === "local") {
    res.status(409).json({ error: "resolve endpoint is only available for R2-backed files" });
    return;
  }

  const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
  const signedUrl = await storage.adapter.getDownloadUrl(doc.filePath, {
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

  let storage;
  try {
    storage = await resolveStorageAdapter(tenantScope);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }

  const uploaderName = await resolveRequestUploaderName(user);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = buildPartitionedKey({
    prefix: storage.prefix,
    programDomain: tenantScope.programDomain,
    organizationId: tenantScope.organizationId,
    userId: user?.userId ?? "unknown",
    stamp,
    safeFileName: safe,
  });

  const { key: storedKey, fileUrl } = await storage.adapter.upload(
    key,
    req.file.buffer,
    req.file.mimetype,
  );

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
    fileMeta: {
      originalFileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      fileUrl,
      filePath: storedKey,
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
    storageBackend: storage.adapter.backendId,
    storageSource: storage.source,
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

  let storage;
  try {
    storage = await resolveStorageAdapter(tenantScope);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }

  const uploaderName = await resolveRequestUploaderName(user);
  const created = [];

  for (const file of files) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = buildPartitionedKey({
      prefix: storage.prefix,
      programDomain: tenantScope.programDomain,
      organizationId: tenantScope.organizationId,
      userId: user?.userId ?? "unknown",
      stamp,
      safeFileName: safe,
    });

    const { key: storedKey, fileUrl } = await storage.adapter.upload(
      key,
      file.buffer,
      file.mimetype,
    );

    const payload = createDocumentPayload({
      intakeSource,
      uploaderName,
      fileMeta: {
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        fileUrl,
        filePath: storedKey,
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
    logger.info("File uploaded (batch)", {
      docId: doc.id,
      file: file.originalname,
      userId: user?.userId,
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
      storageBackend: storage.adapter.backendId,
      storageSource: storage.source,
    });
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
      // Extraction payload fields — written by the frontend after schema-routed
      // doc-intel classification (persistRoutedExtractionResults in useDocuments.ts).
      extractedText: typeof body.extractedText === "string" ? body.extractedText : undefined,
      extraction: body.extraction && typeof body.extraction === "object" ? body.extraction : undefined,
      classificationResult:
        body.classificationResult && typeof body.classificationResult === "object"
          ? body.classificationResult
          : undefined,
      searchIndex:
        body.searchIndex && typeof body.searchIndex === "object" ? body.searchIndex : undefined,
    } as never,
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
      const storage = await resolveStorageAdapter(tenantScope);
      storageDeleted = await storage.adapter.delete(current.filePath);
      logger.info("Stored file deleted", {
        documentId: id,
        filePath: current.filePath,
        storageBackend: storage.adapter.backendId,
        storageSource: storage.source,
        organizationId: tenantScope.organizationId,
        programDomain: tenantScope.programDomain,
      });
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

router.post("/documents/:id/retry-with-type", requireAuth, requireRole("reviewer"), async (req, res) => {
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
      actionable: "Attach a source file first, then run extraction again.",
    });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const overrideRaw = typeof body.overrideDocumentType === "string" ? body.overrideDocumentType.trim() : "";
  const overrideDocumentType = overrideRaw.length > 0 ? overrideRaw : undefined;
  const saveAsTraining = body.saveAsTraining !== false;

  let extractionPath = current.filePath;
  let tempFilePath: string | null = null;

  try {
    if (isR2Configured() && isR2Key(extractionPath)) {
      const ext = path.extname(extractionPath) || "";
      tempFilePath = path.join(os.tmpdir(), `rerun-predict-${id}${ext}`);
      const buffer = await downloadFromR2(extractionPath);
      await fsp.writeFile(tempFilePath, buffer);
      extractionPath = tempFilePath;
    }

    const previewExtraction = await runExtraction(extractionPath, current.mimeType ?? null, {
      documentId: current.id,
    });

    const previewText = (previewExtraction.text ?? "").slice(0, 12000);
    const lightMeta = extractLightweightMetadata(previewText, current.originalFileName ?? null);
    const prediction = buildTypePrediction({
      filename: current.originalFileName,
      mimeType: current.mimeType,
      text: previewText,
      pageCount: previewExtraction.pageCount ?? 1,
      sourceName: lightMeta.sourceName,
      preferredType: overrideDocumentType,
    });

    const selectedType = overrideDocumentType
      ?? (prediction.confidenceBand === "low" ? "other_unclassified" : prediction.predictedType);

    if (!overrideDocumentType && prediction.confidenceBand === "medium") {
      res.status(409).json({
        error: `Type prediction is medium confidence (${Math.round(prediction.confidence * 100)}%). Please confirm a document type and rerun.`,
        actionable: "Select a type in the dropdown and click 'Run with Type' again.",
        code: "TYPE_CONFIRMATION_REQUIRED",
        prediction,
      });
      return;
    }

    const extractionMeta = (current.extraction && typeof current.extraction === "object")
      ? (current.extraction as Record<string, unknown>)
      : {};

    const rerunRequestedBy = getRequestUser(req)?.email ?? "unknown";
    const repeatedPhrases = collectRepeatedPhrases(prediction.firstPageSnippet);
    let trainingSaved = false;

    if (overrideDocumentType && saveAsTraining) {
      try {
        trainingSaved = await saveManualOverrideTrainingEvidence({
          tenantScope,
          documentId: id,
          chosenType: overrideDocumentType,
          filename: current.originalFileName,
          sourceName: prediction.sourceName,
          snippet: prediction.firstPageSnippet,
          layoutHints: prediction.layoutHints,
          repeatedPhrases,
        });
      } catch (error) {
        logger.warn("Manual override training evidence save failed", {
          documentId: id,
          chosenType: overrideDocumentType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await prisma.document.update({
      where: { id },
      data: {
        processingStatus: "queued",
        status: "queued",
        statusUpdatedAt: new Date(),
        needsReview: false,
        review: { required: false },
        extraction: {
          ...extractionMeta,
          status: "queued",
          rerunRequestedAt: new Date().toISOString(),
          rerunRequestedBy,
          rerunManualOverride: overrideDocumentType ?? null,
          forcedDocumentType: selectedType,
          typePrediction: prediction,
          trainingEvidence: overrideDocumentType
            ? {
                source: "manual_override_rerun",
                chosenType: overrideDocumentType,
                filenamePattern: current.originalFileName
                  ? current.originalFileName.toLowerCase().replace(/\d+/g, "{n}")
                  : null,
                sourceCompany: prediction.sourceName,
                repeatedPhrases,
                layoutHints: prediction.layoutHints,
                snippet: prediction.firstPageSnippet,
                recordedAt: new Date().toISOString(),
              }
            : undefined,
        },
        processingHistory: appendProcessingHistory(current.processingHistory, {
          timestamp: new Date().toISOString(),
          action: "manual_rerun_requested",
          status: "queued",
          details: `Rerun queued with type '${selectedType}' (${overrideDocumentType ? "manual override" : `${prediction.confidenceBand} confidence prediction`}).`,
          predictedType: prediction.predictedType,
          predictedConfidence: prediction.confidence,
          confidenceBand: prediction.confidenceBand,
          overrideDocumentType: overrideDocumentType ?? null,
          trainingSaved,
        }),
      },
    });

    await enqueueProcessing(id, tenantScope);

    const refreshed = await findScopedDocument(id, tenantScope);
    if (!refreshed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    res.json({
      document: toApiDocumentWithUploaderFallback(refreshed),
      prediction,
      selectedType,
      routeDecision: overrideDocumentType
        ? "manual_override"
        : prediction.confidenceBand === "high"
          ? "auto_high_confidence"
          : "low_confidence_fallback",
      trainingSaved,
    });
  } catch (error) {
    logger.error("Manual rerun with type failed", {
      documentId: id,
      overrideDocumentType,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: "Failed to queue extraction rerun.",
      actionable: "Verify storage connectivity and extraction service health, then retry.",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (tempFilePath) {
      await fsp.unlink(tempFilePath).catch(() => undefined);
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Document type registry endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /document-types
 * Returns the merged list of system types + any admin-created custom types
 * for this org.  Always includes the full set of system types even if no DB
 * rows exist yet (lazy seeding).
 */
router.get("/document-types", requireAuth, async (req, res) => {
  const scope = getRequestTenantScope(req);

  // Ensure system types exist for this org (idempotent upsert on first call)
  const now = new Date();
  await Promise.all(
    SYSTEM_DOCUMENT_TYPES.map((key) =>
      prisma.chronicleDocumentType.upsert({
        where: {
          organizationId_programDomain_key: {
            organizationId: scope.organizationId,
            programDomain: scope.programDomain,
            key,
          },
        },
        create: {
          id: crypto.randomUUID(),
          organizationId: scope.organizationId,
          programDomain: scope.programDomain,
          key,
          label: DOCUMENT_TYPE_LABELS[key as keyof typeof DOCUMENT_TYPE_LABELS] ?? key,
          description: "",
          isSystemType: true,
          isUserCreated: false,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        update: {},
      }),
    ),
  );

  const types = await prisma.chronicleDocumentType.findMany({
    where: { organizationId: scope.organizationId, programDomain: scope.programDomain, active: true },
    include: { fingerprint: true },
    orderBy: [{ isSystemType: "desc" }, { label: "asc" }],
  });

  res.json(types);
});

/**
 * POST /document-types
 * Admin creates a new custom document type (typically after reviewing
 * several other_unclassified documents).
 */
router.post("/document-types", requireAuth, requireRole("admin"), async (req, res) => {
  const scope = getRequestTenantScope(req);
  const body = req.body as Record<string, unknown>;

  const key = typeof body.key === "string" ? body.key.trim().toLowerCase().replace(/\s+/g, "_") : null;
  const label = typeof body.label === "string" ? body.label.trim() : null;

  if (!key || !label) {
    res.status(400).json({ error: "key and label are required" });
    return;
  }

  const existing = await prisma.chronicleDocumentType.findUnique({
    where: {
      organizationId_programDomain_key: {
        organizationId: scope.organizationId,
        programDomain: scope.programDomain,
        key,
      },
    },
  });
  if (existing) {
    res.status(409).json({ error: `Document type '${key}' already exists` });
    return;
  }

  const created = await prisma.chronicleDocumentType.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: scope.organizationId,
      programDomain: scope.programDomain,
      key,
      label,
      description: typeof body.description === "string" ? body.description : "",
      isSystemType: false,
      isUserCreated: true,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  logger.info("Custom document type created", {
    typeId: created.id,
    key: created.key,
    organizationId: scope.organizationId,
  });
  res.status(201).json(created);
});

/**
 * PATCH /document-types/:id
 * Update a custom type's label / description / active flag.
 * System types cannot be modified except to deactivate.
 */
router.patch("/document-types/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const scope = getRequestTenantScope(req);
  const docType = await prisma.chronicleDocumentType.findFirst({
    where: { id, organizationId: scope.organizationId, programDomain: scope.programDomain },
  });
  if (!docType) { res.status(404).json({ error: "Document type not found" }); return; }

  const body = req.body as Record<string, unknown>;
  const updated = await prisma.chronicleDocumentType.update({
    where: { id },
    data: {
      label: !docType.isSystemType && typeof body.label === "string" ? body.label.trim() : undefined,
      description: typeof body.description === "string" ? body.description.trim() : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      updatedAt: new Date(),
    },
  });
  res.json(updated);
});

/**
 * PUT /document-types/:id/fingerprint
 * Save or update the learned classification patterns for a document type.
 * Admins call this when they want future similar documents to auto-classify.
 */
router.put("/document-types/:id/fingerprint", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const scope = getRequestTenantScope(req);
  const docType = await prisma.chronicleDocumentType.findFirst({
    where: { id, organizationId: scope.organizationId, programDomain: scope.programDomain },
  });
  if (!docType) { res.status(404).json({ error: "Document type not found" }); return; }

  const body = req.body as Record<string, unknown>;
  const phrases = Array.isArray(body.phrases) ? (body.phrases as unknown[]).map(String) : [];
  const companies = Array.isArray(body.companies) ? (body.companies as unknown[]).map(String) : [];
  const filenamePatterns = Array.isArray(body.filenamePatterns) ? (body.filenamePatterns as unknown[]).map(String) : [];
  const datePatterns = Array.isArray(body.datePatterns) ? (body.datePatterns as unknown[]).map(String) : [];
  const sampleDocumentIds = Array.isArray(body.sampleDocumentIds) ? (body.sampleDocumentIds as unknown[]).map(String) : [];

  const fp = await prisma.chronicleTypeFingerprint.upsert({
    where: { documentTypeId: id },
    create: {
      id: crypto.randomUUID(),
      documentTypeId: id,
      phrases,
      companies,
      filenamePatterns,
      datePatterns,
      sampleDocumentIds,
      updatedAt: new Date(),
    },
    update: {
      phrases,
      companies,
      filenamePatterns,
      datePatterns,
      sampleDocumentIds,
      updatedAt: new Date(),
    },
  });

  logger.info("Type fingerprint updated", {
    documentTypeId: id,
    key: docType.key,
    phrases: phrases.length,
    companies: companies.length,
  });
  res.json(fp);
});

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced review endpoints — reclassify / type assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /review-queue/:id/reclassify
 * Admin assigns a document type to a previously other_unclassified document.
 * Optionally promotes the doc to a custom type (creates the type if not found).
 * Optionally saves the document's extracted phrases as a fingerprint hint.
 */
router.post("/review-queue/:id/reclassify", requireAuth, requireRole("reviewer"), async (req, res) => {
  const id = parseRouteId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid document id" }); return; }

  const tenantScope = getRequestTenantScope(req);
  const doc = await findScopedDocument(id, tenantScope);
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const body = req.body as Record<string, unknown>;
  const newDocumentType = typeof body.documentType === "string" ? body.documentType.trim() : null;
  const notes = typeof body.notes === "string" ? body.notes.trim() : undefined;
  const saveAsFingerprint = body.saveAsFingerprint === true;
  const createNewType = body.createNewType === true;
  const newTypeLabel = typeof body.newTypeLabel === "string" ? body.newTypeLabel.trim() : undefined;

  if (!newDocumentType) {
    res.status(400).json({ error: "documentType is required" });
    return;
  }

  // If admin wants to create a new custom type on-the-fly
  if (createNewType && newTypeLabel) {
    const typeKey = newDocumentType.toLowerCase().replace(/\s+/g, "_");
    await prisma.chronicleDocumentType.upsert({
      where: {
        organizationId_programDomain_key: {
          organizationId: tenantScope.organizationId,
          programDomain: tenantScope.programDomain,
          key: typeKey,
        },
      },
      create: {
        id: crypto.randomUUID(),
        organizationId: tenantScope.organizationId,
        programDomain: tenantScope.programDomain,
        key: typeKey,
        label: newTypeLabel,
        description: notes ?? "",
        isSystemType: false,
        isUserCreated: true,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: { active: true, updatedAt: new Date() },
    });
  }

  // If admin wants to save this doc's patterns as fingerprint hints
  if (saveAsFingerprint) {
    const typeKey = newDocumentType.toLowerCase().replace(/\s+/g, "_");
    const typeRecord = await prisma.chronicleDocumentType.findFirst({
      where: {
        organizationId: tenantScope.organizationId,
        programDomain: tenantScope.programDomain,
        key: typeKey,
      },
      include: { fingerprint: true },
    });

    if (typeRecord) {
      const existingIds: string[] = Array.isArray(typeRecord.fingerprint?.sampleDocumentIds)
        ? (typeRecord.fingerprint.sampleDocumentIds as string[])
        : [];
      const updatedIds = [...new Set([...existingIds, id])].slice(0, 25);
      await prisma.chronicleTypeFingerprint.upsert({
        where: { documentTypeId: typeRecord.id },
        create: {
          id: crypto.randomUUID(),
          documentTypeId: typeRecord.id,
          phrases: [],
          companies: [],
          filenamePatterns: [],
          datePatterns: [],
          sampleDocumentIds: updatedIds,
          updatedAt: new Date(),
        },
        update: { sampleDocumentIds: updatedIds, updatedAt: new Date() },
      });
    }
  }

  const user = getRequestUser(req);
  await prisma.document.update({
    where: { id },
    data: {
      documentType: newDocumentType,
      classificationStatus: "reviewed_mapped",
      classificationMatchedBy: "manual",
      reviewRequired: false,
      needsReview: false,
      reviewedById: user?.userId ?? null,
      review: {
        required: false,
        resolution: "corrected",
        notes,
        reviewedBy: user?.email ?? "unknown",
        reviewedAt: new Date().toISOString(),
        reclassifiedTo: newDocumentType,
      },
      status: "archived",
    } as never,
  });

  logger.info("Document reclassified", {
    documentId: id,
    newDocumentType,
    createNewType,
    saveAsFingerprint,
    organizationId: tenantScope.organizationId,
  });

  const refreshed = await findScopedDocument(id, tenantScope);
  if (!refreshed) { res.status(404).json({ error: "Document not found" }); return; }
  res.json(toApiDocumentWithUploaderFallback(refreshed));
});

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced search endpoint for lightweight metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /documents/search-meta
 * Lightweight search across the new metadata fields:
 * person, company, location, referenceNumber, sourceName, documentType, keyword
 */
router.get("/documents/search-meta", requireAuth, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const q = req.query;

  const person = typeof q.person === "string" ? q.person.toLowerCase() : undefined;
  const company = typeof q.company === "string" ? q.company.toLowerCase() : undefined;
  const location = typeof q.location === "string" ? q.location.toLowerCase() : undefined;
  const referenceNumber = typeof q.referenceNumber === "string" ? q.referenceNumber.toLowerCase() : undefined;
  const sourceName = typeof q.sourceName === "string" ? q.sourceName.toLowerCase() : undefined;
  const documentType = typeof q.documentType === "string" ? q.documentType : undefined;
  const keyword = typeof q.keyword === "string" ? q.keyword.toLowerCase() : undefined;
  const limit = Math.min(Number(q.limit ?? 50), 200);
  const offset = Number(q.offset ?? 0);

  const scope = getDocumentScope(tenantScope);

  const docs = await prisma.document.findMany({
    where: {
      ...scope,
      ...(documentType ? { documentType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit * 3, // over-fetch to compensate for in-memory filtering
    skip: offset,
    include: {
      uploadedBy: {
        select: { displayName: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  const filtered = docs.filter((doc) => {
    const people = Array.isArray(doc.metaPeople) ? (doc.metaPeople as string[]).map((s) => s.toLowerCase()) : [];
    const companies = Array.isArray(doc.metaCompanies) ? (doc.metaCompanies as string[]).map((s) => s.toLowerCase()) : [];
    const locations = Array.isArray(doc.metaLocations) ? (doc.metaLocations as string[]).map((s) => s.toLowerCase()) : [];
    const refs = Array.isArray(doc.metaReferenceNumbers) ? (doc.metaReferenceNumbers as string[]).map((s) => s.toLowerCase()) : [];
    const source = (doc.sourceName ?? "").toLowerCase();

    if (person && !people.some((p) => p.includes(person))) return false;
    if (company && !companies.some((c) => c.includes(company))) return false;
    if (location && !locations.some((l) => l.includes(location))) return false;
    if (referenceNumber && !refs.some((r) => r.includes(referenceNumber))) return false;
    if (sourceName && !source.includes(sourceName)) return false;
    if (keyword) {
      const haystack = [
        doc.title,
        doc.extractedText?.slice(0, 2000) ?? "",
        doc.sourceName ?? "",
        ...(doc.metaPeople as string[] ?? []),
        ...(doc.metaCompanies as string[] ?? []),
        ...(doc.metaOther as string[] ?? []),
      ].join(" ").toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });

  const results = filtered.slice(0, limit);

  res.json({
    documents: results.map(toApiDocumentWithUploaderFallback),
    total: filtered.length,
    limit,
    offset,
  });
});
/**
 * POST /documents/:id/attach-file
 *
 * Attach or replace the stored file on an existing document (e.g. a manual-entry
 * record that was created without a file, or re-uploading a corrected version).
 *
 * Behaviour:
 *  - Uploads the new file to the configured storage backend (R2 or local).
 *  - If the document already had a stored file (filePath non-null), attempts to
 *    delete the old file from storage before writing the new one. Failure to
 *    delete the old file is logged but does NOT abort the request.
 *  - Updates filePath, fileUrl, originalFileName, mimeType, fileSize in the DB.
 *  - Re-queues the document for OCR/extraction so the pipeline sees the new file.
 *  - Returns the updated document record.
 */
router.post(
  "/documents/:id/attach-file",
  requireAuth,
  requireRole("uploader"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "File is required" });
      return;
    }

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

    let storage;
    try {
      storage = await resolveStorageAdapter(tenantScope);
    } catch (err) {
      if (err instanceof StorageConfigError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Delete old file if present (best-effort; never aborts the request)
    if (current.filePath) {
      try {
        await storage.adapter.delete(current.filePath);
        logger.info("Old file deleted on attach-file replace", {
          documentId: id,
          oldFilePath: current.filePath,
          storageBackend: storage.adapter.backendId,
        });
      } catch (deleteErr) {
        logger.warn("Could not delete old file during attach-file replace (orphaned blob)", {
          documentId: id,
          oldFilePath: current.filePath,
          error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
      }
    }

    // Upload new file
    const user = getRequestUser(req);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = buildPartitionedKey({
      prefix: storage.prefix,
      programDomain: tenantScope.programDomain,
      organizationId: tenantScope.organizationId,
      userId: user?.userId ?? "unknown",
      stamp,
      safeFileName: safe,
    });

    const { key: storedKey, fileUrl } = await storage.adapter.upload(
      key,
      req.file.buffer,
      req.file.mimetype,
    );

    await prisma.document.update({
      where: { id },
      data: {
        filePath: storedKey,
        fileUrl,
        originalFileName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        processingStatus: "queued",
        ocrStatus: "pending",
        status: "queued",
        statusUpdatedAt: new Date(),
        needsReview: false,
        review: { required: false },
      } as never,
    });

    await enqueueProcessing(id, tenantScope);

    logger.info("File attached to document", {
      documentId: id,
      file: req.file.originalname,
      userId: user?.userId,
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
      storageBackend: storage.adapter.backendId,
      storageSource: storage.source,
    });

    const refreshed = await findScopedDocument(id, tenantScope);
    if (!refreshed) {
      res.status(404).json({ error: "Document not found after update" });
      return;
    }

    res.json(toApiDocumentWithUploaderFallback(refreshed));
  },
);

export { router as communityChronicleRouter };
