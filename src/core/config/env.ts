import path from "path";
import { programs } from "./programs.js";

export const PLATFORM_DISPLAY_NAME = "Nxt Lvl Platform API";
export const PLATFORM_SYSTEM_NAME = "nxt-lvl-platform";

export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || "0.0.0.0";
export const NODE_ENV = process.env.NODE_ENV || "development";
export const API_PREFIX = "/api";
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), "uploads");
export const DEFAULT_ORGANIZATION_ID = process.env.DEFAULT_ORGANIZATION_ID || "default-org";
export const CURRENT_PROGRAM_DOMAIN =
  process.env.CURRENT_PROGRAM_DOMAIN || "community-chronicle";

export const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
export const PLATFORM_API_BASE_URL = process.env.PLATFORM_API_BASE_URL || "";
export const PLATFORM_VALIDATE_LAUNCH_URL = process.env.PLATFORM_VALIDATE_LAUNCH_URL || "";
export const PLATFORM_AUTH_TIMEOUT_MS = Number(process.env.PLATFORM_AUTH_TIMEOUT_MS || 8_000);
export const LLAMA_CLOUD_API_KEY = process.env.LLAMA_CLOUD_API_KEY || "";

// Core Document Intelligence API (deployed separately from nxt-lvl-api)
export const DOC_INTEL_API_BASE_URL = process.env.DOC_INTEL_API_BASE_URL || "";
export const DOC_INTEL_API_TOKEN = process.env.DOC_INTEL_API_TOKEN || "";
export const DOC_INTEL_TIMEOUT_MS = Number(process.env.DOC_INTEL_TIMEOUT_MS || 60_000);
export const HEALTH_SYSTEM_TIMEOUT_MS = Number(process.env.HEALTH_SYSTEM_TIMEOUT_MS || 2500);
export const HEALTH_SYSTEM_TOKEN = process.env.HEALTH_SYSTEM_TOKEN || "";
export const ENABLE_DOC_INTEL_CLASSIFY = process.env.ENABLE_DOC_INTEL_CLASSIFY !== "false";

// Llama Cloud — document classification
export const ENABLE_LLAMA_CLASSIFY = process.env.ENABLE_LLAMA_CLASSIFY !== "false";
export const LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD = Number(
  process.env.LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD || 0.85,
);
export const LLAMA_CLASSIFY_REVIEW_THRESHOLD = Number(
  process.env.LLAMA_CLASSIFY_REVIEW_THRESHOLD || 0.6,
);
export const LLAMA_CLASSIFY_POLL_INTERVAL_MS = Number(
  process.env.LLAMA_CLASSIFY_POLL_INTERVAL_MS || 1500,
);
export const LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS = Number(
  process.env.LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS || 40,
);

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8080",
  "https://community-chronicle.ntlops.com",
  "https://community-chronicle.nltops.com",
  "https://ntlops.com",
  "https://nltops.com",
];

const PROGRAM_ALLOWED_ORIGINS = Object.values(programs).flatMap((program) => program.allowedOrigins);

export const CORS_ORIGIN =
  process.env.CORS_ORIGIN || [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...PROGRAM_ALLOWED_ORIGINS])].join(",");

/**
 * Allowed origin domains for dynamic subdomain matching.
 * Any *.nltops.com, *.ntlops.com, or *.pages.dev subdomain is accepted
 * so new program frontends don't require a config change.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https:\/\/([a-z0-9-]+\.)?nltops\.com$/,
  /^https:\/\/([a-z0-9-]+\.)?ntlops\.com$/,
  /^https:\/\/[a-z0-9-]+\.pages\.dev$/,
  /^https:\/\/[a-z0-9-]+\.onrender\.com$/,
];

/**
 * Returns a cors `origin` callback that allows:
 * - Any origin explicitly listed in CORS_ORIGIN (or the code defaults)
 * - Any subdomain of nltops.com, ntlops.com, pages.dev, or onrender.com
 * - "*" allows all origins
 */
export function getCorsOrigins(): true | ((origin: string | undefined, cb: (err: Error | null, origin?: boolean | string) => void) => void) {
  if (CORS_ORIGIN === "*") {
    return true;
  }

  const explicitList = new Set(
    CORS_ORIGIN.split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

  return (origin, cb) => {
    // Same-origin / server-to-server requests have no Origin header — allow them
    if (!origin) {
      cb(null, true);
      return;
    }
    if (explicitList.has(origin)) {
      cb(null, true);
      return;
    }
    if (ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))) {
      cb(null, true);
      return;
    }
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  };
}

export const PLATFORM_SETUP_TOKEN = process.env.PLATFORM_SETUP_TOKEN || "";

// Email — Resend
export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
// Base URL of the Mission Hub frontend — used to build invite links
export const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174";

export const JWT_SECRET = process.env.JWT_SECRET || "changeme-dev-secret-replace-in-production";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

// Shared secret for verifying launch tokens issued by the platform hub
export const PLATFORM_LAUNCH_TOKEN_SECRET =
  process.env.PLATFORM_LAUNCH_TOKEN_SECRET || "dev-platform-launch-secret";

export const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES || 50 * 1024 * 1024);

// ---------------------------------------------------------------------------
// Storage backend
// Set STORAGE_BACKEND=r2  to use Cloudflare R2 (production).
// Set STORAGE_BACKEND=local to write files to the local UPLOAD_DIR (dev only).
// Defaults to "local" so local dev works without any extra config.
// ---------------------------------------------------------------------------
export type StorageBackend = "local" | "r2";

const rawBackend = (process.env.STORAGE_BACKEND || "local").toLowerCase();
export const STORAGE_BACKEND: StorageBackend =
  rawBackend === "r2" ? "r2" : "local";

// Cloudflare R2 credentials — required when STORAGE_BACKEND=r2.
export const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
export const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
export const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "";
export const MISSION_OPS_R2_BUCKET_NAME = process.env.MISSION_OPS_R2_BUCKET_NAME || "";
export const MISSION_OPS_R2_BUCKET_MAP = process.env.MISSION_OPS_R2_BUCKET_MAP || "";
// Optional: public bucket domain (e.g. https://pub-xxx.r2.dev or a custom domain).
// When set, fileUrl stored in DB will be a permanent public link.
// When unset, downloads are served via signed URL through the API.
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";
export const R2_DEFAULT_PREFIX = process.env.R2_DEFAULT_PREFIX || "";

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

// Large-PDF batch grouping (Phase 1/2)
// v1 runs in shadow mode only: persist page features + boundary decisions,
// propose virtual segments, but do not create child documents yet.
export const PDF_BATCH_GROUPING_ENABLED = process.env.PDF_BATCH_GROUPING_ENABLED !== "false";
export const PDF_BATCH_GROUPING_SHADOW_ONLY = process.env.PDF_BATCH_GROUPING_SHADOW_ONLY !== "false";
export const PDF_BATCH_MIN_PAGES = Number(process.env.PDF_BATCH_MIN_PAGES || 12);
export const PDF_BATCH_MAX_PAGES = Number(process.env.PDF_BATCH_MAX_PAGES || 300);
