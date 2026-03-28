/**
 * Processing Pipeline Service
 *
 * Handles the document processing lifecycle:
 * 1. Queue document for processing
 * 2. Extract text content from the file
 * 3. Extract metadata (title, dates, names, page count)
 * 4. Run categorization
 * 5. Update search-ready fields
 * 6. Mark as processed or failed
 *
 * Manages formal lifecycle state transitions:
 * intake_received → queued → extracting → extracted → categorized → archived
 * Fallback paths: low confidence → review_required, error → failed
 */

import type { ArchiveDocument, ProcessingEvent, ExtractedMetadata, AuditTrailEvent, DocumentLifecycleStatus } from "@/types/document";
import { MONTH_NAMES } from "@/types/document";
import { getDocumentById, updateDocument } from "./documentStore";
import { categorizeDocument } from "./categorizationService";
import { extractContentFromFile } from "./textExtractor";
import { extractFileMetadata } from "./filenameParser";

/** Add a processing event to a document's audit trail */
function addProcessingEvent(
  doc: ArchiveDocument,
  action: string,
  status: ArchiveDocument["processingStatus"],
  details?: string
): ProcessingEvent {
  const event: ProcessingEvent = {
    timestamp: new Date().toISOString(),
    action,
    status,
    details,
  };
  doc.processingHistory.push(event);
  return event;
}

/** Append an audit trail event to a document */
export function appendAuditEvent(
  doc: ArchiveDocument,
  event: { type: string; actor?: string; details?: string }
): ArchiveDocument {
  const auditEvent: AuditTrailEvent = {
    type: event.type,
    timestamp: new Date().toISOString(),
    actor: event.actor ?? "system",
    details: event.details ?? "",
  };
  return {
    ...doc,
    auditTrail: [...(doc.auditTrail ?? []), auditEvent],
  };
}

/** Update lifecycle status with audit trail */
function transitionLifecycleStatus(
  doc: ArchiveDocument,
  newStatus: DocumentLifecycleStatus,
  details?: string
): Partial<ArchiveDocument> {
  const updatedDoc = appendAuditEvent(doc, {
    type: `status_transition`,
    details: details ?? `Status changed to ${newStatus}`,
  });
  return {
    status: newStatus,
    statusUpdatedAt: new Date().toISOString(),
    auditTrail: updatedDoc.auditTrail,
  };
}

/** Extract metadata from text content using heuristics */
function extractMetadataFromText(text: string, doc: ArchiveDocument): ExtractedMetadata {
  const metadata: ExtractedMetadata = {};

  // Word count
  metadata.wordCount = text.split(/\s+/).filter(Boolean).length;

  // Try to detect a date in the text (common formats)
  const datePatterns = [
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i,
  ];
  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.detectedDate = match[0];
      break;
    }
  }

  // Use existing data for detected fields
  metadata.detectedTitle = doc.title;
  metadata.detectedAuthor = doc.author;

  // Try to detect organization names (simple heuristic)
  const orgPatterns = [
    /(?:Michigan Roundtable|Department of|Office of|University of|Institute of)\s+[\w\s]+/i,
  ];
  for (const pattern of orgPatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.detectedOrganization = match[0].trim();
      break;
    }
  }

  return metadata;
}

/**
 * Process a single document through the full pipeline.
 * Updates the document in the store at each stage.
 */
export async function processDocument(documentId: string): Promise<boolean> {
  const doc = getDocumentById(documentId);
  if (!doc) {
    console.warn(`Document ${documentId} not found for processing`);
    return false;
  }

  try {
    // Stage 1: Queue
    addProcessingEvent(doc, "queue", "queued", "Document queued for processing");
    updateDocument(doc.id, {
      processingStatus: "queued",
      processingHistory: doc.processingHistory,
      ...transitionLifecycleStatus(doc, "queued", "Document queued for processing"),
    });

    // Stage 2: Extracting
    addProcessingEvent(doc, "processing_start", "processing", "Processing started");
    updateDocument(doc.id, {
      processingStatus: "processing",
      processingHistory: doc.processingHistory,
      extraction: { status: "processing" },
      ...transitionLifecycleStatus(doc, "extracting", "Text extraction started"),
    });

    // Stage 3: Text extraction using adapter-based extractor
    let extractedText = doc.extractedText;
    let extractionMethod: "text" | "pdf" | "ocr" | "manual" | "fallback" = "fallback";
    let extractionConfidence = 0;
    let extractionWarnings: string[] = [];
    let extractionPageCount: number | undefined;

    if (doc.fileRef && !extractedText) {
      try {
        const extractionResult = await extractContentFromFile(doc.fileRef);
        extractedText = extractionResult.text;
        extractionConfidence = extractionResult.confidence ?? 0;
        extractionWarnings = extractionResult.warnings ?? [];
        extractionPageCount = extractionResult.pages;

        // Determine method from file type
        if (doc.fileRef.type.startsWith("image/")) {
          extractionMethod = "ocr";
        } else if (doc.fileRef.type === "application/pdf") {
          extractionMethod = "pdf";
        } else if (doc.fileRef.type.startsWith("text/")) {
          extractionMethod = "text";
        }

        addProcessingEvent(doc, "text_extraction", "processing", "Text extracted from file");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        addProcessingEvent(
          doc,
          "text_extraction_failed",
          "processing",
          `Text extraction failed: ${errorMessage}`
        );
        extractionWarnings.push(`Extraction failed: ${errorMessage}`);
        updateDocument(doc.id, {
          extraction: {
            status: "failed",
            method: extractionMethod,
            confidence: 0,
            extractedAt: new Date().toISOString(),
            warningMessages: extractionWarnings,
            errorMessage,
          },
        });
        // Continue processing even if text extraction fails
      }
    } else if (doc.extractedText) {
      extractionMethod = "manual";
      extractionConfidence = 1.0;
    }

    // If no text was extracted, use title + description as fallback
    if (!extractedText) {
      extractedText = `${doc.title}\n\n${doc.description}`;
      extractionMethod = "fallback";
      extractionConfidence = 0.1;
    }

    // Update extraction metadata
    updateDocument(doc.id, {
      extraction: {
        status: "complete",
        method: extractionMethod,
        confidence: extractionConfidence,
        extractedAt: new Date().toISOString(),
        warningMessages: extractionWarnings.length > 0 ? extractionWarnings : undefined,
        pageCount: extractionPageCount,
      },
      ...transitionLifecycleStatus(doc, "extracted", "Text extraction complete"),
    });

    // Stage 4: Metadata extraction
    const extractedMetadata = extractMetadataFromText(extractedText, doc);
    addProcessingEvent(doc, "metadata_extraction", "processing", "Metadata extracted");

    // Stage 5: Categorization
    const classificationResult = categorizeDocument(doc, extractedText);
    addProcessingEvent(
      doc,
      "categorization",
      "processing",
      `Categorized as "${classificationResult.category}" (${classificationResult.method}, confidence: ${classificationResult.confidence})`
    );

    // Stage 5b: Financial metadata via filename/content parsing
    // Use content-based parsing as fallback if filename didn't detect financial info
    let financialCategory = doc.financialCategory ?? classificationResult.financialCategory;
    let financialDocumentType = doc.financialDocumentType ?? classificationResult.financialDocumentType;
    let month = doc.month;

    if (!financialCategory || !financialDocumentType || !month) {
      const contentParsed = extractFileMetadata(
        doc.originalFileName || doc.title,
        doc.sourceReference,
        extractedText
      );
      financialCategory = financialCategory ?? contentParsed.financialCategory;
      financialDocumentType = financialDocumentType ?? contentParsed.financialDocumentType;
      month = month ?? contentParsed.month;

      // Also fill in year if not set
      if (!doc.year && contentParsed.year) {
        doc.year = contentParsed.year;
      }
    }

    // Merge auto-generated tags with existing tags
    const financialTags: string[] = [];
    if (financialCategory) financialTags.push(financialCategory.toLowerCase());
    if (financialDocumentType) financialTags.push(financialDocumentType.toLowerCase());
    if (month && month >= 1 && month <= 12) {
      financialTags.push(MONTH_NAMES[month - 1].toLowerCase());
    }

    const mergedTags = [
      ...new Set([...doc.tags, ...classificationResult.suggestedTags, ...financialTags]),
    ];

    // Stage 6: Determine review needs
    const needsReview = doc.ocrStatus === "pending" || classificationResult.confidence < 0.5;
    const lowConfidenceExtraction = (extractionConfidence) < 0.7;
    const weakCategorization = classificationResult.confidence < 0.5;

    let reviewData: ArchiveDocument["review"] = undefined;
    let lifecycleStatus: DocumentLifecycleStatus = "archived";

    if (needsReview || lowConfidenceExtraction || weakCategorization) {
      const reasons: string[] = [];
      if (lowConfidenceExtraction) reasons.push("Low extraction confidence");
      if (weakCategorization) reasons.push("Weak categorization confidence");
      if (doc.ocrStatus === "pending") reasons.push("OCR pending");

      reviewData = {
        required: true,
        reason: reasons,
        priority: lowConfidenceExtraction ? "high" : "medium",
      };
      lifecycleStatus = "review_required";
    }

    addProcessingEvent(doc, "processing_complete", "processed", "Processing completed");

    // Build search index
    const searchIndex = {
      titleText: doc.title.toLowerCase(),
      bodyText: extractedText.toLowerCase().slice(0, 5000),
      tags: mergedTags.map((t) => t.toLowerCase()),
      category: (doc.category === "Uncategorized" ? classificationResult.category : doc.category).toLowerCase(),
      sourceType: doc.intakeSource,
      status: lifecycleStatus,
      dateTokens: [String(doc.year), doc.createdAt.slice(0, 10)],
    };

    updateDocument(doc.id, {
      extractedText,
      extractedMetadata,
      classificationResult,
      category: doc.category === "Uncategorized" ? classificationResult.category : doc.category,
      financialCategory,
      financialDocumentType,
      month,
      tags: mergedTags,
      processingStatus: "processed",
      processingHistory: doc.processingHistory,
      needsReview,
      review: reviewData,
      searchIndex,
      aiSummary:
        doc.aiSummary ||
        generateSummary(extractedText, extractedMetadata),
      ...transitionLifecycleStatus(doc, lifecycleStatus, `Processing complete, status: ${lifecycleStatus}`),
    });

    return true;
  } catch (error) {
    addProcessingEvent(
      doc,
      "processing_failed",
      "failed",
      `Processing failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    updateDocument(doc.id, {
      processingStatus: "failed",
      processingHistory: doc.processingHistory,
      needsReview: true,
      extraction: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        extractedAt: new Date().toISOString(),
      },
      review: {
        required: true,
        reason: ["Processing failed"],
        priority: "high",
      },
      ...transitionLifecycleStatus(doc, "failed", `Processing failed: ${error instanceof Error ? error.message : "Unknown error"}`),
    });
    return false;
  }
}

/**
 * Process a batch of documents.
 * In production, this would use a proper job queue.
 */
export async function processDocumentBatch(documentIds: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  for (const id of documentIds) {
    const success = await processDocument(id);
    results.set(id, success);
  }
  return results;
}

/**
 * Generate a basic summary from extracted text.
 * This is a simple heuristic; in production, use an LLM API.
 */
function generateSummary(text: string, metadata: ExtractedMetadata): string {
  // Take the first ~200 characters of meaningful text as a basic summary
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 20);
  const preview = sentences.slice(0, 2).join(". ").trim();

  if (!preview) {
    return metadata.wordCount
      ? `Document contains approximately ${metadata.wordCount} words.`
      : "No summary available.";
  }

  return preview.length > 300 ? preview.slice(0, 297) + "..." : preview + ".";
}

/**
 * Retry processing for a failed document.
 */
export async function retryProcessing(documentId: string): Promise<boolean> {
  const doc = getDocumentById(documentId);
  if (!doc) return false;

  addProcessingEvent(doc, "retry", "queued", "Retrying processing");
  updateDocument(doc.id, {
    processingStatus: "queued",
    processingHistory: doc.processingHistory,
    ...transitionLifecycleStatus(doc, "queued", "Retrying processing"),
  });

  return processDocument(documentId);
}
