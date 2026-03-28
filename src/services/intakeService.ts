/**
 * Unified Intake Service
 *
 * Normalizes documents from all intake sources into ArchiveDocument records
 * and feeds them into the processing pipeline.
 *
 * Architecture: Source adapters → Intake normalizer → Processing pipeline
 *
 * Supported sources:
 * - file_upload: Single file upload
 * - multi_upload: Multiple file upload
 * - drag_drop: Drag-and-drop upload
 * - bulk_folder: Folder/bulk upload
 * - scanner_import: Scanned document import
 * - manual_entry: Manual record creation
 * - email_import: (scaffold) Future email intake
 * - cloud_import: (scaffold) Future cloud service intake
 */

import type {
  ArchiveDocument,
  DocumentIntakeInput,
  IntakeSource,
  ProcessingEvent,
  OcrStatus,
} from "@/types/document";
import { addDocument, addDocuments } from "./documentStore";
import { processDocument, processDocumentBatch } from "./processingPipeline";
import { extractFileMetadata } from "./filenameParser";

/** Generate a UUID v4 */
function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Detect if a file is likely a scanned/image document needing OCR */
function needsOcr(file: File): boolean {
  const imageTypes = ["image/png", "image/jpeg", "image/tiff", "image/bmp", "image/webp"];
  if (imageTypes.includes(file.type)) return true;
  // PDFs from scanners are common - mark for OCR review
  if (file.type === "application/pdf") return true;
  return false;
}

/** Extract a guessed title from a filename */
function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "") // remove extension
    .replace(/[-_]/g, " ") // replace separators with spaces
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title case
}

/** Determine the document type from the file MIME type */
function guessDocumentType(file: File): ArchiveDocument["type"] {
  if (file.type.startsWith("image/")) return "Image";
  if (file.type === "application/pdf") return "Report";
  if (
    file.type === "application/vnd.ms-excel" ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "Spreadsheet";
  if (file.type === "application/vnd.ms-powerpoint" || file.type.includes("presentation"))
    return "Presentation";
  return "Other";
}

/** Guess year from a date string or file info */
function guessYear(dateStr?: string): number {
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed.getFullYear();
  }
  return new Date().getFullYear();
}

/**
 * Create a normalized ArchiveDocument record from intake input.
 * This is the single entry point that all intake methods use.
 * Automatically extracts metadata from filename and folder path.
 */
export function createDocumentRecord(input: DocumentIntakeInput): ArchiveDocument {
  const now = new Date().toISOString();
  const id = generateId();

  const ocrStatus: OcrStatus = input.file && needsOcr(input.file) ? "pending" : "not_needed";

  const initialEvent: ProcessingEvent = {
    timestamp: now,
    action: "intake",
    status: "uploaded",
    details: `Document received via ${input.intakeSource}`,
  };

  // Extract metadata from filename and folder path
  const filename = input.file?.name;
  const folderPath = input.sourceReference;
  const parsedMeta = filename
    ? extractFileMetadata(filename, folderPath)
    : undefined;

  // Merge parsed metadata with provided input (input overrides parsed)
  const year = input.year || parsedMeta?.year || guessYear();
  const month = input.month || parsedMeta?.month;
  const financialCategory = input.financialCategory || parsedMeta?.financialCategory;
  const financialDocumentType = input.financialDocumentType || parsedMeta?.financialDocumentType;

  // Merge tags from input and parsed metadata
  const inputTags = input.tags || [];
  const parsedTags = parsedMeta?.tags || [];
  const mergedTags = [...new Set([...inputTags, ...parsedTags])];

  return {
    id,
    title: input.title || (input.file ? titleFromFileName(input.file.name) : "Untitled Document"),
    description: input.description || "",
    author: input.author || "Unknown",
    year,
    month,
    category: input.category || "Uncategorized",
    type: input.type || (input.file ? guessDocumentType(input.file) : "Other"),
    financialCategory,
    financialDocumentType,
    tags: mergedTags,
    keywords: input.keywords || [],
    originalFileName: input.file?.name,
    mimeType: input.file?.type,
    fileSize: input.file?.size,
    fileUrl: input.file ? URL.createObjectURL(input.file) : "#",
    fileRef: input.file,
    processingStatus: "uploaded",
    ocrStatus,
    extractedText: input.extractedText || "",
    extractedMetadata: {},
    intakeSource: input.intakeSource,
    sourceReference: input.sourceReference,
    department: input.department,
    createdAt: now,
    updatedAt: now,
    importedAt: now,
    processingHistory: [initialEvent],
    needsReview: ocrStatus === "pending",
    aiSummary: "",
  };
}

// ===== Source Adapters =====

/**
 * Adapter: Single file upload
 */
export async function intakeSingleFile(
  file: File,
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument> {
  const doc = createDocumentRecord({
    intakeSource: "file_upload",
    file,
    ...metadata,
  });
  addDocument(doc);
  await processDocument(doc.id);
  return doc;
}

/**
 * Adapter: Multi-file upload
 */
export async function intakeMultipleFiles(
  files: File[],
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument[]> {
  const docs = files.map((file) =>
    createDocumentRecord({
      intakeSource: "multi_upload",
      file,
      ...metadata,
    })
  );
  addDocuments(docs);
  await processDocumentBatch(docs.map((d) => d.id));
  return docs;
}

/**
 * Adapter: Drag-and-drop upload (same as multi but tracks source)
 */
export async function intakeDragDrop(
  files: File[],
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument[]> {
  const docs = files.map((file) =>
    createDocumentRecord({
      intakeSource: "drag_drop",
      file,
      ...metadata,
    })
  );
  addDocuments(docs);
  await processDocumentBatch(docs.map((d) => d.id));
  return docs;
}

/**
 * Adapter: Bulk/folder upload
 * Preserves webkitRelativePath as source reference when available.
 */
export async function intakeBulkFolder(
  files: File[],
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument[]> {
  const docs = files.map((file) =>
    createDocumentRecord({
      intakeSource: "bulk_folder",
      file,
      sourceReference: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
      ...metadata,
    })
  );
  addDocuments(docs);
  await processDocumentBatch(docs.map((d) => d.id));
  return docs;
}

/**
 * Adapter: Scanner/image import
 * Marks all files for OCR processing.
 */
export async function intakeScannerImport(
  files: File[],
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument[]> {
  const docs = files.map((file) =>
    createDocumentRecord({
      intakeSource: "scanner_import",
      file,
      ...metadata,
    })
  );
  // Force OCR pending for all scanner imports
  docs.forEach((doc) => {
    doc.ocrStatus = "pending";
    doc.needsReview = true;
  });
  addDocuments(docs);
  await processDocumentBatch(docs.map((d) => d.id));
  return docs;
}

/**
 * Adapter: Manual document entry (no file attached initially)
 */
export function intakeManualEntry(
  input: Omit<DocumentIntakeInput, "intakeSource">
): ArchiveDocument {
  const doc = createDocumentRecord({
    ...input,
    intakeSource: "manual_entry",
  });
  // Manual entries skip file processing, go straight to needs_review
  doc.processingStatus = input.extractedText ? "processed" : "needs_review";
  addDocument(doc);
  return doc;
}

// ===== Scaffold: Future Intake Sources =====

/**
 * Scaffold: Email import adapter
 * To be implemented when email integration is added.
 *
 * Expected flow:
 * 1. Email service pushes attachments to an endpoint
 * 2. This adapter normalizes them into DocumentIntakeInput
 * 3. Documents enter the standard pipeline
 */
export async function intakeFromEmail(
  _emailId: string,
  _attachments: File[]
): Promise<ArchiveDocument[]> {
  // TODO: Implement email import when email service is connected
  throw new Error(
    "Email import is not yet implemented. This scaffold is ready for integration."
  );
}

/**
 * Scaffold: Cloud import adapter (Google Drive, Dropbox, OneDrive, SharePoint)
 * To be implemented when cloud service integrations are added.
 *
 * Expected flow:
 * 1. User selects files from cloud service picker
 * 2. Cloud service API downloads files
 * 3. This adapter normalizes them into DocumentIntakeInput
 * 4. Documents enter the standard pipeline
 */
export async function intakeFromCloud(
  _provider: "google_drive" | "dropbox" | "onedrive" | "sharepoint",
  _fileRefs: Array<{ cloudId: string; name: string; mimeType: string }>
): Promise<ArchiveDocument[]> {
  // TODO: Implement cloud import when OAuth + cloud API integration is connected
  throw new Error(
    "Cloud import is not yet implemented. This scaffold is ready for integration."
  );
}
