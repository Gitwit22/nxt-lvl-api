import fs from "fs/promises";
import path from "path";
import {
  DOC_INTEL_API_BASE_URL,
  DOC_INTEL_API_TOKEN,
  DOC_INTEL_TIMEOUT_MS,
  ENABLE_DOC_INTEL_CLASSIFY,
  LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD,
  LLAMA_CLASSIFY_REVIEW_THRESHOLD,
} from "../../config/env.js";
import type { NormalizedParseResult, ParseInvocationContext } from "../parse/types.js";
import { logger } from "../../../logger.js";
import { globalDocIntelMetrics } from "../../utils/docIntelMetrics.js";

export type ChronicleDocumentType =
  | "irs_notice"
  | "bank_receipt"
  | "invoice"
  | "meeting_minutes"
  | "board_governance"
  | "grant_document"
  | "contract"
  | "newsletter"
  | "general_report"
  | "uncategorized";

export type ChronicleClassificationStatus = "complete" | "failed" | "skipped";
export type ChronicleClassificationDecision = "auto_accepted" | "needs_review" | "low_confidence";

export interface ChronicleClassificationResult {
  provider: "core-api";
  status: ChronicleClassificationStatus;
  documentType: ChronicleDocumentType;
  confidence: number | null;
  reasoning: string | null;
  jobId: string | null;
  decision: ChronicleClassificationDecision | null;
  classifiedAt: string;
  rawResult: unknown;
}

type ParseApiResponse = {
  provider?: string;
  status?: string;
  text?: string;
  markdown?: string;
  pages?: unknown[];
  tables?: unknown[];
  entities?: unknown[];
};

type ClassifyApiResponse = {
  provider?: string;
  status?: string;
  documentType?: string;
  confidence?: number | null;
  reasoning?: string | null;
  labels?: unknown;
};

const CHRONICLE_CATEGORIES: ChronicleDocumentType[] = [
  "irs_notice",
  "bank_receipt",
  "invoice",
  "meeting_minutes",
  "board_governance",
  "grant_document",
  "contract",
  "newsletter",
  "general_report",
  "uncategorized",
];

const CLASSIFY_SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/tiff",
  "image/webp",
  "text/plain",
]);

function isCoreDocIntelConfigured(): boolean {
  return Boolean(DOC_INTEL_API_BASE_URL && DOC_INTEL_API_TOKEN);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeDocumentType(value: unknown): ChronicleDocumentType {
  if (typeof value !== "string") return "uncategorized";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CHRONICLE_CATEGORIES.includes(normalized as ChronicleDocumentType)
    ? (normalized as ChronicleDocumentType)
    : "uncategorized";
}

function getDecisionFromConfidence(confidence: number | null): ChronicleClassificationDecision | null {
  if (confidence == null || Number.isNaN(confidence)) return null;
  if (confidence >= LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD) return "auto_accepted";
  if (confidence >= LLAMA_CLASSIFY_REVIEW_THRESHOLD) return "needs_review";
  return "low_confidence";
}

async function callDocIntelEndpoint<TResponse>(
  endpoint: string,
  filePath: string,
  mimeType: string | null,
  additionalFields?: Record<string, string>,
): Promise<{ response: TResponse; statusCode: number; durationMs: number }> {
  const start = Date.now();
  const fileBuffer = await fs.readFile(filePath);
  const filename = path.basename(filePath);
  const form = new FormData();
  const fileBytes = new Uint8Array(fileBuffer);
  form.append("file", new Blob([fileBytes], { type: mimeType ?? "application/octet-stream" }), filename);

  if (additionalFields) {
    for (const [key, value] of Object.entries(additionalFields)) {
      form.append(key, value);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOC_INTEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${normalizeBaseUrl(DOC_INTEL_API_BASE_URL)}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DOC_INTEL_API_TOKEN}`,
      },
      body: form,
      signal: controller.signal,
    });

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Core API ${endpoint} failed with ${response.status}: ${body.slice(0, 400)}`);
    }

    return {
      response: (await response.json()) as TResponse,
      statusCode: response.status,
      durationMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function canUseCoreDocIntel(): boolean {
  return isCoreDocIntelConfigured();
}

export async function parseDocumentWithCoreApi(
  filePath: string,
  context?: ParseInvocationContext,
): Promise<NormalizedParseResult> {
  const startedAt = Date.now();

  if (!isCoreDocIntelConfigured()) {
    const message = "Core document intelligence API is not configured";
    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "parse",
      provider: "failed",
      durationMs: Date.now() - startedAt,
      success: false,
      documentId: context?.documentId,
      jobId: context?.jobId,
      errorMessage: message,
    });
    throw new Error(message);
  }

  try {
    const { response: parsed, statusCode, durationMs } = await callDocIntelEndpoint<ParseApiResponse>(
      "/parse",
      filePath,
      context?.mimeType ?? null,
    );

    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "parse",
      provider: "core-api",
      durationMs,
      success: true,
      statusCode,
      documentId: context?.documentId,
      jobId: context?.jobId,
    });

    return {
      provider: "core-api",
      text: typeof parsed.text === "string" ? parsed.text : "",
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : "",
      pages: parsed.pages,
      tables: parsed.tables,
      entities: parsed.entities,
      rawResult: parsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;

    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "parse",
      provider: "failed",
      durationMs,
      success: false,
      documentId: context?.documentId,
      jobId: context?.jobId,
      errorMessage: message,
    });

    logger.warn("Core API parse failed", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      durationMs,
      error: message,
    });

    throw error;
  }
}

export async function classifyDocumentWithCoreApi(
  filePath: string,
  mimeType: string | null,
  context?: { documentId?: string; jobId?: string },
): Promise<ChronicleClassificationResult> {
  const classifiedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (!ENABLE_DOC_INTEL_CLASSIFY) {
    const durationMs = Date.now() - startedAt;
    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "classify",
      provider: "rule-based-fallback",
      durationMs,
      success: true,
      fallbackTriggered: true,
      fallbackReason: "classification-disabled",
      documentId: context?.documentId,
      jobId: context?.jobId,
    });

    return {
      provider: "core-api",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "Core API classification is disabled via ENABLE_DOC_INTEL_CLASSIFY=false",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  if (!isCoreDocIntelConfigured()) {
    const durationMs = Date.now() - startedAt;
    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "classify",
      provider: "rule-based-fallback",
      durationMs,
      success: true,
      fallbackTriggered: true,
      fallbackReason: "missing-core-api-config",
      documentId: context?.documentId,
      jobId: context?.jobId,
    });

    return {
      provider: "core-api",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "Core API URL/token is not configured",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  if (!mimeType || !CLASSIFY_SUPPORTED_MIME_TYPES.has(mimeType)) {
    const durationMs = Date.now() - startedAt;
    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "classify",
      provider: "rule-based-fallback",
      durationMs,
      success: true,
      fallbackTriggered: true,
      fallbackReason: "unsupported-mime-type",
      documentId: context?.documentId,
      jobId: context?.jobId,
    });

    return {
      provider: "core-api",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: `MIME type '${mimeType ?? "unknown"}' is not supported for Core API classification`,
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  try {
    const { response, statusCode, durationMs } = await callDocIntelEndpoint<ClassifyApiResponse>(
      "/classify",
      filePath,
      mimeType,
      {
        categories: JSON.stringify(CHRONICLE_CATEGORIES),
      },
    );

    const confidence = typeof response.confidence === "number" ? response.confidence : null;
    const documentType = normalizeDocumentType(response.documentType);
    const status = response.status === "complete" ? "complete" : "failed";

    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "classify",
      provider: "core-api",
      durationMs,
      success: status === "complete",
      statusCode,
      documentType,
      documentId: context?.documentId,
      jobId: context?.jobId,
    });

    return {
      provider: "core-api",
      status,
      documentType,
      confidence,
      reasoning: typeof response.reasoning === "string" ? response.reasoning : null,
      jobId: null,
      decision: status === "complete" ? getDecisionFromConfidence(confidence) : "low_confidence",
      classifiedAt,
      rawResult: response,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    globalDocIntelMetrics.record({
      timestamp: startedAt,
      operation: "classify",
      provider: "failed",
      durationMs,
      success: false,
      fallbackTriggered: true,
      fallbackReason: "core-api-classify-failed",
      documentId: context?.documentId,
      jobId: context?.jobId,
      errorMessage: message,
    });

    logger.warn("Core API classify failed", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      durationMs,
      error: message,
    });

    return {
      provider: "core-api",
      status: "failed",
      documentType: "uncategorized",
      confidence: null,
      reasoning: message,
      jobId: null,
      decision: "low_confidence",
      classifiedAt,
      rawResult: null,
    };
  }
}
