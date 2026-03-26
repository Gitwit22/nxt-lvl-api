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

/** Formal document lifecycle status for workflow tracking */
export type DocumentLifecycleStatus =
  | "intake_received"
  | "queued"
  | "extracting"
  | "extracted"
  | "categorized"
  | "review_required"
  | "archived"
  | "failed";

/** Result from a text extraction adapter */
export interface ExtractedContent {
  text: string;
  pages?: number;
  confidence?: number;
  language?: string;
  warnings?: string[];
}

/** Interface for pluggable text extraction adapters */
export interface TextExtractorAdapter {
  canHandle(file: File): boolean;
  extract(file: File): Promise<ExtractedContent>;
}

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

/** Top-level financial categories */
export const FINANCIAL_CATEGORIES = [
  "Funding",
  "Spending",
] as const;

export type FinancialCategory = (typeof FINANCIAL_CATEGORIES)[number];

/** Financial document types */
export const FINANCIAL_DOCUMENT_TYPES = [
  "Grant",
  "Donation",
  "Invoice",
  "Receipt",
  "Budget",
  "Expense Report",
  "Bank Statement",
  "Payroll",
  "Tax Document",
  "Reimbursement",
  "Purchase Order",
  "Financial Summary",
  "Audit",
  "Other",
] as const;

export type FinancialDocumentType = (typeof FINANCIAL_DOCUMENT_TYPES)[number];

/** Month names for display */
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Abbreviated month names for compact display */
export const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Result from filename/path parsing */
export interface FilenameParsedMetadata {
  year?: number;
  month?: number;
  monthName?: string;
  financialCategory?: FinancialCategory;
  financialDocumentType?: FinancialDocumentType;
  tags: string[];
  confidence: number;
  source: "folder_path" | "filename" | "content" | "manual";
}

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
  financialCategory?: FinancialCategory;
  financialDocumentType?: FinancialDocumentType;
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
  /** Month of the document (1-12, for filtering) */
  month?: number;

  // --- Classification ---
  /** Primary category */
  category: DocumentCategory;
  /** Document type/format */
  type: DocumentType;
  /** Financial category (Funding or Spending) */
  financialCategory?: FinancialCategory;
  /** Financial document type (Grant, Invoice, etc.) */
  financialDocumentType?: FinancialDocumentType;
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

  // --- Lifecycle ---
  /** Formal lifecycle status for workflow tracking */
  status?: DocumentLifecycleStatus;
  /** Timestamp of last lifecycle status change */
  statusUpdatedAt?: string;
  /** Audit trail of lifecycle transitions */
  auditTrail?: AuditTrailEvent[];

  // --- Extraction ---
  /** Extraction metadata */
  extraction?: ExtractionMetadata;

  // --- Duplicate Detection ---
  /** Duplicate check metadata */
  duplicateCheck?: DuplicateCheckMetadata;

  // --- Review Queue ---
  /** Human review metadata */
  review?: ReviewMetadata;

  // --- Search Index ---
  /** Pre-computed search index fields */
  searchIndex?: SearchIndexFields;

  // --- Flags ---
  /** Whether manual review is needed */
  needsReview: boolean;
  /** AI-generated summary */
  aiSummary: string;
}

/** A single audit trail event */
export interface AuditTrailEvent {
  type: string;
  timestamp: string;
  actor: string;
  details: string;
}

/** Extraction metadata tracking */
export interface ExtractionMetadata {
  status: "not_started" | "processing" | "complete" | "failed";
  method?: "text" | "pdf" | "ocr" | "manual" | "fallback";
  confidence?: number;
  extractedAt?: string;
  warningMessages?: string[];
  errorMessage?: string;
  pageCount?: number;
}

/** Duplicate detection metadata */
export interface DuplicateCheckMetadata {
  hash?: string;
  filenameFingerprint?: string;
  possibleDuplicateIds?: string[];
  duplicateStatus?: "unique" | "possible_duplicate" | "confirmed_duplicate";
  checkedAt?: string;
}

/** Human review metadata */
export interface ReviewMetadata {
  required: boolean;
  reason?: string[];
  priority?: "low" | "medium" | "high";
  assignedTo?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  resolution?: "approved" | "corrected" | "reprocessed" | "duplicate" | "rejected";
  notes?: string;
}

/** Pre-computed search index fields */
export interface SearchIndexFields {
  titleText: string;
  bodyText: string;
  tags: string[];
  category: string;
  sourceType: string;
  status: string;
  dateTokens: string[];
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
  month?: number;
  category?: DocumentCategory;
  type?: DocumentType;
  financialCategory?: FinancialCategory;
  financialDocumentType?: FinancialDocumentType;
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
  month?: string;
  category?: string;
  type?: string;
  financialCategory?: string;
  financialDocumentType?: string;
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
