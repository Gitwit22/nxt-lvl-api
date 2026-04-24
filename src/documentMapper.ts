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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toApiDocument(doc: Document) {
  const rawDoc = doc as unknown as Record<string, unknown>;
  const extraction = asObject(doc.extraction);
  const typePrediction = asObject(extraction.typePrediction);
  const candidateObjects = asObjectArray(typePrediction.candidates);
  const alternates = candidateObjects.map((item) => ({
    type: typeof item.type === "string" ? item.type : "",
    label: typeof item.label === "string" ? item.label : "",
    confidence: asNumber(item.confidence) ?? 0,
    reasons: asStringArray(item.reasons),
  }));

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
    splitReviewRequired: Boolean(rawDoc.splitReviewRequired),
    segmentationStatus: rawDoc.segmentationStatus as string | undefined ?? undefined,
    parentDocumentId: rawDoc.parentDocumentId as string | undefined ?? undefined,
    rootDocumentId: rawDoc.rootDocumentId as string | undefined ?? undefined,
    isVirtualSegment: Boolean(rawDoc.isVirtualSegment),
    segmentIndex: asNumber(rawDoc.segmentIndex),
    segmentPageStart: asNumber(rawDoc.segmentPageStart),
    segmentPageEnd: asNumber(rawDoc.segmentPageEnd),
    segmentConfidence: asNumber(rawDoc.segmentConfidence),
    aiSummary: doc.aiSummary,
    intake: {
      predictedType:
        (typeof typePrediction.predictedType === "string" ? typePrediction.predictedType : undefined)
        ?? doc.type,
      confidence:
        asNumber(typePrediction.confidence)
        ?? asNumber(rawDoc.classificationConfidence)
        ?? null,
      alternates,
      tags: asStringArray(doc.tags),
      routeDecision:
        (typeof extraction.routeDecision === "string" ? extraction.routeDecision : undefined)
        ?? null,
    },
    // ── Lightweight metadata (Phase 2 search-first model) ──────────────
    sourceName: rawDoc.sourceName as string | undefined ?? undefined,
    documentDate: rawDoc.documentDate as string | undefined ?? undefined,
    metaPeople: asStringArray(rawDoc.metaPeople),
    metaCompanies: asStringArray(rawDoc.metaCompanies),
    metaLocations: asStringArray(rawDoc.metaLocations),
    metaReferenceNumbers: asStringArray(rawDoc.metaReferenceNumbers),
    metaOther: asStringArray(rawDoc.metaOther),
    classificationStatus: rawDoc.classificationStatus as string | undefined ?? undefined,
    classificationMatchedBy: rawDoc.classificationMatchedBy as string | undefined ?? undefined,
    classificationConfidence: asNumber(rawDoc.classificationConfidence),
  };
}
