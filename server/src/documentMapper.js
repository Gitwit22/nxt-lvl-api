import { API_PREFIX } from "./config.js";
function asStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item));
    }
    return [];
}
function asObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function asObjectArray(value) {
    if (Array.isArray(value)) {
        return value.filter((item) => item && typeof item === "object");
    }
    return [];
}
export function toApiDocument(doc) {
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
    };
}
