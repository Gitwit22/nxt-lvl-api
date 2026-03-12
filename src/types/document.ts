/**
 * Enhanced document types for the Community Chronicle archive system.
 *
 * These types support the full document lifecycle:
 * intake → processing → categorization → storage → retrieval
 */

/** Processing status of a document in the pipeline */
export type ProcessingStatus =
  | "uploaded"
  | "imported"
  | "queued"
  | "processing"
  | "processed"
  | "failed"
  | "needs_review";

/** How the document was brought into the system */
export type IntakeSource =
  | "file_upload"
  | "multi_upload"
  | "drag_drop"
  | "bulk_folder"
  | "scanner_import"
  | "email_import"
  | "cloud_import"
  | "manual_entry"
  | "legacy_import";

/** Document categories for classification */
export const DOCUMENT_CATEGORIES = [
  "Meeting Minutes",
  "Financial Documents",
  "Applications/Forms",
  "Legal Documents",
  "Reports",
  "Correspondence",
  "Outreach Materials",
  "Policies/Procedures",
  "Historical Records",
  "Research",
  "Policy",
  "Community Report",
  "Youth Initiative",
  "Housing",
  "Education",
  "Uncategorized",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** Document type/format classification */
export const DOCUMENT_TYPES = [
  "Report",
  "Brief",
  "Study",
  "Newsletter",
  "Testimony",
  "Presentation",
  "Letter",
  "Memo",
  "Form",
  "Minutes",
  "Spreadsheet",
  "Image",
  "Other",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** OCR processing status */
export type OcrStatus = "not_needed" | "pending" | "in_progress" | "completed" | "failed";

/** A single entry in the processing audit trail */
export interface ProcessingEvent {
  timestamp: string;
  action: string;
  status: ProcessingStatus;
  details?: string;
}

/** Extracted metadata from document content */
export interface ExtractedMetadata {
  detectedTitle?: string;
  detectedDate?: string;
  detectedAuthor?: string;
  detectedOrganization?: string;
  pageCount?: number;
  wordCount?: number;
  language?: string;
}

/** AI/rule-based classification result */
export interface ClassificationResult {
  category: DocumentCategory;
  confidence: number;
  method: "rule_based" | "ai_assisted" | "manual";
  suggestedTags: string[];
}

/**
 * The master document record.
 * This is the core data structure for every document in the archive.
 */
export interface ArchiveDocument {
  /** Unique document ID (UUID) */
  id: string;
  /** Document title (user-provided or detected) */
  title: string;
  /** Full description */
  description: string;
  /** Author or creator */
  author: string;
  /** Year of the document (for timeline/filtering) */
  year: number;

  // --- Classification ---
  /** Primary category */
  category: DocumentCategory;
  /** Document type/format */
  type: DocumentType;
  /** User-assigned or auto-generated tags */
  tags: string[];
  /** Search keywords */
  keywords: string[];

  // --- File Information ---
  /** Original file name as uploaded */
  originalFileName?: string;
  /** MIME type of the original file */
  mimeType?: string;
  /** File size in bytes */
  fileSize?: number;
  /** Storage reference/path for the original file */
  fileUrl: string;
  /** Reference to the File object in browser memory (transient, not persisted) */
  fileRef?: File;

  // --- Processing ---
  /** Current processing status */
  processingStatus: ProcessingStatus;
  /** OCR status for scanned/image documents */
  ocrStatus: OcrStatus;
  /** Extracted text content (for search and query) */
  extractedText: string;
  /** Extracted metadata from document analysis */
  extractedMetadata: ExtractedMetadata;
  /** Classification result from categorization engine */
  classificationResult?: ClassificationResult;

  // --- Intake ---
  /** How this document entered the system */
  intakeSource: IntakeSource;
  /** Original source reference (email ID, cloud path, etc.) */
  sourceReference?: string;
  /** Department or program grouping */
  department?: string;

  // --- Audit ---
  /** ISO 8601 timestamp of when the record was created */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
  /** Upload/import date */
  importedAt: string;
  /** Processing history / audit trail */
  processingHistory: ProcessingEvent[];

  // --- Flags ---
  /** Whether manual review is needed */
  needsReview: boolean;
  /** AI-generated summary */
  aiSummary: string;
}

/**
 * Input for creating a new document through any intake method.
 * Only requires minimal fields; the pipeline fills in the rest.
 */
export interface DocumentIntakeInput {
  title?: string;
  description?: string;
  author?: string;
  year?: number;
  category?: DocumentCategory;
  type?: DocumentType;
  tags?: string[];
  keywords?: string[];
  department?: string;
  intakeSource: IntakeSource;
  sourceReference?: string;
  file?: File;
  extractedText?: string;
}

/** Filters for document search and retrieval */
export interface DocumentFilters {
  search?: string;
  year?: string;
  category?: string;
  type?: string;
  intakeSource?: string;
  processingStatus?: string;
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
}

/** Paginated result set */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
