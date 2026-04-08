import path from "path";
export const PORT = Number(process.env.PORT || 4000);
export const NODE_ENV = process.env.NODE_ENV || "development";
export const API_PREFIX = "/api";
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), "uploads");
export const DEFAULT_ORGANIZATION_ID = process.env.DEFAULT_ORGANIZATION_ID || "default-org";
export const CURRENT_PROGRAM_DOMAIN = process.env.CURRENT_PROGRAM_DOMAIN || "community-chronicle";
export const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// Auth
export const JWT_SECRET = process.env.JWT_SECRET || "changeme-dev-secret-replace-in-production";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
// File validation
export const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES || 50 * 1024 * 1024); // 50 MB
export const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/tiff",
    "image/webp",
    "text/plain",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
]);
// Processing queue
export const MAX_ATTEMPTS = Number(process.env.MAX_QUEUE_ATTEMPTS || 3);
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000); // 2 min
export const RETRY_BACKOFF_BASE_MS = Number(process.env.RETRY_BACKOFF_BASE_MS || 5_000);
// Low word-count threshold for scanned PDF detection (words per page)
export const SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD = Number(process.env.SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD || 20);
export const OCR_CONFIDENCE_REVIEW_THRESHOLD = Number(process.env.OCR_CONFIDENCE_REVIEW_THRESHOLD || 0.7);
