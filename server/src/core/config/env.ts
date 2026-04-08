import path from "path";
import { programs } from "./programs.js";

export const PLATFORM_DISPLAY_NAME = "Nxt Lvl Platform";
export const PLATFORM_SYSTEM_NAME = "nxt-lvl-platform";

export const PORT = Number(process.env.PORT || 4000);
export const NODE_ENV = process.env.NODE_ENV || "development";
export const API_PREFIX = "/api";
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), "uploads");
export const DEFAULT_ORGANIZATION_ID = process.env.DEFAULT_ORGANIZATION_ID || "default-org";
export const CURRENT_PROGRAM_DOMAIN =
  process.env.CURRENT_PROGRAM_DOMAIN || "community-chronicle";

export const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://community-chronicle.onrender.com",
  "https://nltops.com",
];

const PROGRAM_ALLOWED_ORIGINS = Object.values(programs).flatMap((program) => program.allowedOrigins);

export const CORS_ORIGIN =
  process.env.CORS_ORIGIN || [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...PROGRAM_ALLOWED_ORIGINS])].join(",");

export function getCorsOrigins(): true | string[] {
  if (CORS_ORIGIN === "*") {
    return true;
  }
  return CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const JWT_SECRET = process.env.JWT_SECRET || "changeme-dev-secret-replace-in-production";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

export const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES || 50 * 1024 * 1024);

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

export const MAX_ATTEMPTS = Number(process.env.MAX_QUEUE_ATTEMPTS || 3);
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000);
export const RETRY_BACKOFF_BASE_MS = Number(process.env.RETRY_BACKOFF_BASE_MS || 5_000);

export const SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD = Number(
  process.env.SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD || 20,
);
export const OCR_CONFIDENCE_REVIEW_THRESHOLD = Number(
  process.env.OCR_CONFIDENCE_REVIEW_THRESHOLD || 0.7,
);
