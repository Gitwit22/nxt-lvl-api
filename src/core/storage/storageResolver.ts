/**
 * resolveStorageAdapter
 *
 * Single source of truth for backend selection.
 *
 * Resolution order (per request):
 *   1. Per-tenant settings from DB  (finalArchive destination, must be enabled)
 *   2. Global env R2 config          (STORAGE_BACKEND=r2 with all required vars)
 *   3. Local disk fallback           (dev/offline)
 *
 * Rules:
 * - If tenant config exists and is marked active/enabled BUT is missing required
 *   credentials, the call FAILS with a StorageConfigError instead of silently
 *   falling back to env/local.
 * - If no tenant config exists, the env/local path is used and the fallback is
 *   logged explicitly.
 * - Every resolution is logged so operators can trace which backend was chosen.
 */

import type { TenantScope } from "../../tenant.js";
import { logger } from "../../logger.js";
import type { StorageAdapter } from "./adapter.js";
import { R2StorageAdapter } from "./r2Adapter.js";
import { LocalStorageAdapter } from "./localAdapter.js";
import { prisma } from "../db/prisma.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------
export class StorageConfigError extends Error {
  constructor(
    message: string,
    public readonly context: { organizationId: string; programDomain: string },
  ) {
    super(message);
    this.name = "StorageConfigError";
  }
}

// ---------------------------------------------------------------------------
// Types (mirrors DestinationSettings from routes)
// ---------------------------------------------------------------------------
type StorageProvider = "local" | "network" | "r2_manual" | "r2_env";

interface DestinationSettings {
  provider: StorageProvider;
  enabled: boolean;
  r2BucketName: string;
  r2Endpoint: string;
  r2AccessKey: string;
  r2SecretKey: string;
  r2PublicUrl: string;
  r2Prefix: string;
}

interface ResolvedStorageTarget {
  adapter: StorageAdapter;
  /** The prefix to use when building partitioned keys. */
  prefix: string;
  /** How the backend was resolved (for logging). */
  source: "tenant_r2_manual" | "tenant_r2_env" | "env_r2" | "local_fallback";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseR2AccountIdFromEndpoint(endpoint: string): string {
  const match = endpoint.trim().match(/^https:\/\/([^.]+)\.r2\.cloudflarestorage\.com\/?$/i);
  return match?.[1] ?? "";
}

function isEnvR2Available(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

// ---------------------------------------------------------------------------
// Mission-ops per-org bucket mapping (mirrors old getDefaultBucketForProgram)
// ---------------------------------------------------------------------------
const MISSION_OPS_PROGRAM_DOMAIN = "mission-hub";
const MISSION_OPS_DEFAULT_BUCKET = "nonprofithub";

function normalizeBucketName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseMissionOpsBucketMap(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const orgId = String(key).trim();
      const bucket = normalizeBucketName(String(value));
      if (orgId && bucket) output[orgId] = bucket;
    }
    return output;
  } catch {
    return {};
  }
}

function getMissionOpsBucketMap(): Record<string, string> {
  return parseMissionOpsBucketMap(process.env.MISSION_OPS_R2_BUCKET_MAP || "");
}

function getDefaultBucketForScope(scope: TenantScope): string {
  if (scope.programDomain === MISSION_OPS_PROGRAM_DOMAIN) {
    return (
      getMissionOpsBucketMap()[scope.organizationId] ||
      normalizeBucketName(process.env.MISSION_OPS_R2_BUCKET_NAME || "") ||
      normalizeBucketName(scope.organizationId) ||
      MISSION_OPS_DEFAULT_BUCKET
    );
  }
  return process.env.R2_BUCKET_NAME || "";
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------
export async function resolveStorageAdapter(scope: TenantScope): Promise<ResolvedStorageTarget> {
  const ctxLog = {
    organizationId: scope.organizationId,
    programDomain: scope.programDomain,
  };

  // ── Step 1: load per-tenant settings ──────────────────────────────────────
  const row = await prisma.programStorageSettings.findUnique({
    where: {
      organizationId_programDomain: {
        organizationId: scope.organizationId,
        programDomain: scope.programDomain,
      },
    },
    select: { settings: true },
  });

  const tenantFinalArchive = extractFinalArchive(row?.settings);

  if (tenantFinalArchive?.enabled) {
    const provider = tenantFinalArchive.provider;

    // ── 1a. Tenant r2_manual ────────────────────────────────────────────────
    if (provider === "r2_manual") {
      const {
        r2BucketName,
        r2Endpoint,
        r2AccessKey,
        r2SecretKey,
        r2PublicUrl,
        r2Prefix,
      } = tenantFinalArchive;

      const accountId = parseR2AccountIdFromEndpoint(r2Endpoint);
      const missing: string[] = [];
      if (!r2BucketName) missing.push("r2BucketName");
      if (!r2Endpoint) missing.push("r2Endpoint");
      if (!r2AccessKey) missing.push("r2AccessKey");
      if (!r2SecretKey) missing.push("r2SecretKey");
      if (!accountId) missing.push("valid r2Endpoint (must be *.r2.cloudflarestorage.com)");

      if (missing.length > 0) {
        logger.error("Tenant storage config is enabled but incomplete — rejecting request", {
          ...ctxLog,
          provider,
          missing,
        });
        throw new StorageConfigError(
          `Storage is configured as active but missing required fields: ${missing.join(", ")}. ` +
            "Fix or disable the tenant storage settings before uploading.",
          { organizationId: scope.organizationId, programDomain: scope.programDomain },
        );
      }

      logger.info("Storage resolved: tenant r2_manual", {
        ...ctxLog,
        bucketName: r2BucketName,
        prefix: r2Prefix,
      });

      return {
        adapter: new R2StorageAdapter(
          {
            accountId,
            accessKeyId: r2AccessKey,
            secretAccessKey: r2SecretKey,
            bucketName: r2BucketName,
            publicUrl: r2PublicUrl || undefined,
          },
          "r2_manual",
        ),
        prefix: r2Prefix,
        source: "tenant_r2_manual",
      };
    }

    // ── 1b. Tenant r2_env (tenant explicitly chose env-managed R2) ──────────
    if (provider === "r2_env") {
      if (!isEnvR2Available()) {
        logger.error(
          "Tenant storage is set to r2_env but env R2 credentials are incomplete — rejecting",
          ctxLog,
        );
        throw new StorageConfigError(
          "Tenant storage is configured to use environment-managed R2 but R2 credentials are not set in the environment. " +
            "Configure R2 env vars or change the tenant storage settings.",
          { organizationId: scope.organizationId, programDomain: scope.programDomain },
        );
      }

      const bucketName = getDefaultBucketForScope(scope);
      const prefix = tenantFinalArchive.r2Prefix || process.env.R2_DEFAULT_PREFIX || "";
      logger.info("Storage resolved: tenant r2_env", {
        ...ctxLog,
        bucketName,
        prefix,
      });

      return {
        adapter: new R2StorageAdapter(
          {
            accountId: process.env.R2_ACCOUNT_ID || "",
            accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
            bucketName,
            publicUrl: process.env.R2_PUBLIC_URL || undefined,
          },
          "r2_env",
        ),
        prefix,
        source: "tenant_r2_env",
      };
    }

    // ── 1c. Tenant chose local/network — treat as "no R2" for now ──────────
    // Fall through to system defaults below.
  }

  // ── Step 2: system default env R2 ─────────────────────────────────────────
  if (process.env.STORAGE_BACKEND === "r2" && isEnvR2Available()) {
    const bucketName = getDefaultBucketForScope(scope);
    logger.info("Storage resolved: env R2 fallback (no active tenant config)", {
      ...ctxLog,
      bucketName,
      tenantConfigPresent: !!tenantFinalArchive,
    });
    return {
      adapter: new R2StorageAdapter(
        {
          accountId: process.env.R2_ACCOUNT_ID || "",
          accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
          bucketName,
          publicUrl: process.env.R2_PUBLIC_URL || undefined,
        },
        "r2_env",
      ),
      prefix: process.env.R2_DEFAULT_PREFIX || "",
      source: "env_r2",
    };
  }

  // ── Step 3: local disk fallback ───────────────────────────────────────────
  logger.warn("Storage resolved: local disk fallback — files will be lost on restart", {
    ...ctxLog,
    tenantConfigPresent: !!tenantFinalArchive,
    envBackend: process.env.STORAGE_BACKEND,
  });
  return {
    adapter: new LocalStorageAdapter(),
    prefix: "",
    source: "local_fallback",
  };
}

// ---------------------------------------------------------------------------
// Helper — safely pull finalArchive out of the raw JSON settings blob
// ---------------------------------------------------------------------------
function extractFinalArchive(
  raw: unknown,
): (DestinationSettings & { enabled: boolean; provider: StorageProvider }) | null {
  if (!raw || typeof raw !== "object") return null;
  const asObj = raw as Record<string, unknown>;
  const fa = asObj.finalArchive;
  if (!fa || typeof fa !== "object") return null;
  const dest = fa as Record<string, unknown>;

  const provider = parseProvider(dest.provider);
  const enabled =
    typeof dest.enabled === "boolean" ? dest.enabled : false;

  return {
    provider,
    enabled,
    r2BucketName: asString(dest.r2BucketName),
    r2Endpoint: asString(dest.r2Endpoint),
    r2AccessKey: asString(dest.r2AccessKey),
    r2SecretKey: asString(dest.r2SecretKey),
    r2PublicUrl: asString(dest.r2PublicUrl),
    r2Prefix: asString(dest.r2Prefix)
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
  };
}

function parseProvider(value: unknown): StorageProvider {
  if (value === "local" || value === "network" || value === "r2_manual" || value === "r2_env") {
    return value;
  }
  if (value === "r2") return "r2_manual";
  return "local";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
