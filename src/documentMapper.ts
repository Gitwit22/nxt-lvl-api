import type { Document } from "@prisma/client";
import { API_PREFIX } from "./config.js";

type JsonObject = Record<string, unknown>;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return [];
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asObjectArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === "object") as JsonObject[];
  }
  return [];
}

export function toApiDocument(doc: Document) {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    author: doc.author,
    year: doc.year,
    month: doc.month ?? undefined,
    category: doc.category,
    type: doc.type,
    financialCategory: doc.financialCategory ?? undefined,
    financialDocumentType: doc.financialDocumentType ?? undefined,
    tags: asStringArray(doc.tags),
    keywords: asStringArray(doc.keywords),
    originalFileName: doc.originalFileName ?? undefined,
    mimeType: doc.mimeType ?? undefined,
    fileSize: doc.fileSize ?? undefined,
    fileUrl: `${API_PREFIX}/documents/${doc.id}/download`,
    processingStatus: doc.processingStatus,
    ocrStatus: doc.ocrStatus,
    extractedText: doc.extractedText,
    extractedMetadata: asObject(doc.extractedMetadata),
    classificationResult: doc.classificationResult ?? undefined,
    intakeSource: doc.intakeSource,
    sourceReference: doc.sourceReference ?? undefined,
    department: doc.department ?? undefined,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    importedAt: doc.importedAt.toISOString(),
    processingHistory: asObjectArray(doc.processingHistory),
    status: doc.status ?? undefined,
    statusUpdatedAt: doc.statusUpdatedAt?.toISOString(),
    auditTrail: doc.auditTrail ?? undefined,
    extraction: doc.extraction ?? undefined,
    duplicateCheck: doc.duplicateCheck ?? undefined,
    review: doc.review ?? undefined,
    searchIndex: doc.searchIndex ?? undefined,
    needsReview: doc.needsReview,
    aiSummary: doc.aiSummary,
    // ── Lightweight metadata (Phase 2 search-first model) ──────────────
    documentType: (doc as unknown as Record<string, unknown>).documentType as string | undefined ?? undefined,
    sourceName: (doc as unknown as Record<string, unknown>).sourceName as string | undefined ?? undefined,
    documentDate: (doc as unknown as Record<string, unknown>).documentDate as string | undefined ?? undefined,
    metaPeople: asStringArray((doc as unknown as Record<string, unknown>).metaPeople),
    metaCompanies: asStringArray((doc as unknown as Record<string, unknown>).metaCompanies),
    metaLocations: asStringArray((doc as unknown as Record<string, unknown>).metaLocations),
    metaReferenceNumbers: asStringArray((doc as unknown as Record<string, unknown>).metaReferenceNumbers),
    metaOther: asStringArray((doc as unknown as Record<string, unknown>).metaOther),
    classificationStatus: (doc as unknown as Record<string, unknown>).classificationStatus as string | undefined ?? undefined,
    classificationMatchedBy: (doc as unknown as Record<string, unknown>).classificationMatchedBy as string | undefined ?? undefined,
    classificationConfidence: (doc as unknown as Record<string, unknown>).classificationConfidence as number | undefined ?? undefined,
    reviewRequired: Boolean((doc as unknown as Record<string, unknown>).reviewRequired),
  };
}
