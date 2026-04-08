import crypto from "crypto";

interface CreateDocumentInput {
  title?: string;
  description?: string;
  author?: string;
  year?: number;
  month?: number;
  category?: string;
  type?: string;
  financialCategory?: string;
  financialDocumentType?: string;
  tags?: string[];
  keywords?: string[];
  intakeSource: string;
  sourceReference?: string;
  department?: string;
  extractedText?: string;
  fileMeta?: {
    originalFileName: string;
    mimeType?: string;
    fileSize: number;
    fileUrl: string;
    filePath: string;
  };
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferType(mimeType?: string): string {
  if (!mimeType) return "Other";
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "Report";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "Spreadsheet";
  if (mimeType.startsWith("text/")) return "Report";
  return "Other";
}

function inferOcrStatus(mimeType?: string): "pending" | "not_needed" {
  if (!mimeType) return "not_needed";
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
    return "pending";
  }
  return "not_needed";
}

export function createDocumentPayload(input: CreateDocumentInput) {
  const now = new Date();
  const ocrStatus = inferOcrStatus(input.fileMeta?.mimeType);
  const id = crypto.randomUUID();

  const title =
    input.title ||
    (input.fileMeta?.originalFileName ? titleFromFilename(input.fileMeta.originalFileName) : "Untitled Document");

  return {
    id,
    title,
    description: input.description || "",
    author: input.author || "Unknown",
    year: input.year || now.getFullYear(),
    month: input.month ?? null,
    category: input.category || "Uncategorized",
    type: input.type || inferType(input.fileMeta?.mimeType),
    financialCategory: input.financialCategory || null,
    financialDocumentType: input.financialDocumentType || null,
    tags: input.tags || [],
    keywords: input.keywords || [],
    originalFileName: input.fileMeta?.originalFileName || null,
    mimeType: input.fileMeta?.mimeType || null,
    fileSize: input.fileMeta?.fileSize || null,
    fileUrl: input.fileMeta?.fileUrl || "#",
    filePath: input.fileMeta?.filePath || null,
    processingStatus: input.fileMeta ? "queued" : (input.extractedText ? "processed" : "needs_review"),
    ocrStatus,
    extractedText: input.extractedText || "",
    extractedMetadata: {},
    intakeSource: input.intakeSource,
    sourceReference: input.sourceReference || null,
    department: input.department || null,
    createdAt: now,
    importedAt: now,
    processingHistory: [
      {
        timestamp: now.toISOString(),
        action: "intake",
        status: "uploaded",
        details: `Document received via ${input.intakeSource}`,
      },
    ],
    status: input.fileMeta ? "queued" : (input.extractedText ? "archived" : "review_required"),
    statusUpdatedAt: now,
    auditTrail: [
      {
        type: "status_transition",
        timestamp: now.toISOString(),
        actor: "system",
        details: input.fileMeta ? "Queued for processing" : "Manual entry recorded",
      },
    ],
    extraction: input.fileMeta
      ? { status: "not_started" }
      : {
          status: input.extractedText ? "complete" : "failed",
          method: input.extractedText ? "manual" : "fallback",
          confidence: input.extractedText ? 1 : 0.1,
          extractedAt: now.toISOString(),
        },
    review: input.fileMeta
      ? (ocrStatus === "pending"
          ? { required: true, reason: ["OCR pending"], priority: "high" }
          : { required: false })
      : input.extractedText
      ? { required: false }
      : { required: true, reason: ["Missing extracted text"], priority: "medium" },
    needsReview: input.fileMeta ? ocrStatus === "pending" : !input.extractedText,
    aiSummary: "",
  };
}
