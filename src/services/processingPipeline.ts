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
 * Designed for async/queue-based processing.
 * Currently runs synchronously in-browser; can be swapped for a
 * background worker or server-side queue in production.
 */

import type { ArchiveDocument, ProcessingEvent, ExtractedMetadata } from "@/types/document";
import { getDocumentById, updateDocument } from "./documentStore";
import { categorizeDocument } from "./categorizationService";
import { extractTextFromFile } from "./textExtractor";

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
    });

    // Stage 2: Processing
    addProcessingEvent(doc, "processing_start", "processing", "Processing started");
    updateDocument(doc.id, {
      processingStatus: "processing",
      processingHistory: doc.processingHistory,
    });

    // Stage 3: Text extraction
    let extractedText = doc.extractedText;
    if (doc.fileRef && !extractedText) {
      try {
        extractedText = await extractTextFromFile(doc.fileRef);
        addProcessingEvent(doc, "text_extraction", "processing", "Text extracted from file");
      } catch (err) {
        addProcessingEvent(
          doc,
          "text_extraction_failed",
          "processing",
          `Text extraction failed: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        // Continue processing even if text extraction fails
      }
    }

    // If no text was extracted, use title + description as fallback
    if (!extractedText) {
      extractedText = `${doc.title}\n\n${doc.description}`;
    }

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

    // Merge auto-generated tags with existing tags
    const mergedTags = [
      ...new Set([...doc.tags, ...classificationResult.suggestedTags]),
    ];

    // Stage 6: Update document with all results
    const needsReview = doc.ocrStatus === "pending" || classificationResult.confidence < 0.5;

    addProcessingEvent(doc, "processing_complete", "processed", "Processing completed");

    updateDocument(doc.id, {
      extractedText,
      extractedMetadata,
      classificationResult,
      category: doc.category === "Uncategorized" ? classificationResult.category : doc.category,
      tags: mergedTags,
      processingStatus: "processed",
      processingHistory: doc.processingHistory,
      needsReview,
      aiSummary:
        doc.aiSummary ||
        generateSummary(extractedText, extractedMetadata),
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
  });

  return processDocument(documentId);
}
