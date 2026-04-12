import path from "path";
import { programs } from "./programs.js";

export const PLATFORM_DISPLAY_NAME = "Nxt Lvl Platform API";
export const PLATFORM_SYSTEM_NAME = "nxt-lvl-platform";

export const PORT = Number(process.env.PORT || 4000);
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

export const JWT_SECRET = process.env.JWT_SECRET || "changeme-dev-secret-replace-in-production";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

// Shared secret for verifying launch tokens issued by the platform hub
export const PLATFORM_LAUNCH_TOKEN_SECRET =
  process.env.PLATFORM_LAUNCH_TOKEN_SECRET || "dev-platform-launch-secret";

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
