import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import {
  NODE_ENV,
  PLATFORM_SYSTEM_NAME,
  UPLOAD_DIR,
} from "../config/env.js";
import {
  DOC_INTEL_API_BASE_URL,
  DOC_INTEL_API_TOKEN,
  HEALTH_SYSTEM_TIMEOUT_MS,
  STORAGE_BACKEND,
  ENABLE_DOC_INTEL_CLASSIFY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../../logger.js";
import { canUseCoreDocIntel } from "../services/documentIntelligence/coreApiClient.js";
import { isR2Configured, probeR2Connection } from "../storage/r2.js";
import { getProcessingWorkerState } from "../../processingQueue.js";

export type HealthStatus = "healthy" | "degraded" | "down";

export interface HealthCheckResult {
  ok: boolean;
  status: HealthStatus;
  latencyMs?: number;
  error?: string;
  enabled?: boolean;
  details?: Record<string, unknown>;
  missing?: string[];
}

export interface SystemHealthResponse {
  ok: boolean;
  status: HealthStatus;
  timestamp: string;
  service: string;
  environment: string;
  version?: string;
  build?: string;
  checks: {
    api: HealthCheckResult;
    database: HealthCheckResult;
    storage: HealthCheckResult;
    worker: HealthCheckResult;
    core: HealthCheckResult;
    coreAuth: HealthCheckResult;
    providers: HealthCheckResult;
    config: HealthCheckResult;
  };
}

const DEFAULT_TIMEOUT_MS = HEALTH_SYSTEM_TIMEOUT_MS > 0 ? HEALTH_SYSTEM_TIMEOUT_MS : 2500;

function nowMs(): number {
  return Date.now();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function withTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Timeout after ${timeoutMs}ms: ${timeoutLabel}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function runCheck(
  name: string,
  task: () => Promise<Omit<HealthCheckResult, "latencyMs">>,
): Promise<HealthCheckResult> {
  const startedAt = nowMs();
  try {
    const result = await withTimeout(task, DEFAULT_TIMEOUT_MS, name);
    return {
      ...result,
      latencyMs: nowMs() - startedAt,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    const latencyMs = nowMs() - startedAt;

    logger.warn("System health sub-check failed", {
      check: name,
      latencyMs,
      error: message,
    });

    return {
      ok: false,
      status: "down",
      latencyMs,
      error: message,
    };
  }
}

async function checkRuntime(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  return {
    ok: true,
    status: "healthy",
    details: {
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      memoryRssBytes: process.memoryUsage().rss,
    },
  };
}

async function checkDatabase(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  await prisma.$queryRaw`SELECT 1`;
  return {
    ok: true,
    status: "healthy",
  };
}

async function checkStorage(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  if (STORAGE_BACKEND === "local") {
    await fs.access(UPLOAD_DIR, fsConstants.R_OK | fsConstants.W_OK);
    const stats = await fs.stat(UPLOAD_DIR);
    if (!stats.isDirectory()) {
      return {
        ok: false,
        status: "down",
        error: "UPLOAD_DIR is not a directory",
      };
    }

    return {
      ok: true,
      status: "healthy",
      details: {
        backend: "local",
      },
    };
  }

  if (!isR2Configured()) {
    return {
      ok: false,
      status: "down",
      error: "Storage backend is r2 but configuration is incomplete",
      details: {
        backend: "r2",
      },
    };
  }

  const probe = await probeR2Connection({ prefix: "health" });
  if (!probe.success) {
    return {
      ok: false,
      status: "down",
      error: probe.error || probe.message,
      details: {
        backend: "r2",
        step: probe.step,
      },
    };
  }

  return {
    ok: true,
    status: "healthy",
    details: {
      backend: "r2",
      step: probe.step,
    },
  };
}

async function checkWorker(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  await prisma.$queryRawUnsafe('SELECT 1 FROM "ProcessingJob" LIMIT 1');

  const state = getProcessingWorkerState();
  if (!state.started) {
    return {
      ok: false,
      status: "down",
      error: "Processing worker is not started",
      details: {
        started: state.started,
        busy: state.busy,
      },
    };
  }

  return {
    ok: true,
    status: "healthy",
    details: {
      started: state.started,
      busy: state.busy,
      lastTickAt: state.lastTickAt,
    },
  };
}

function coreIntegrationEnabled(): boolean {
  return canUseCoreDocIntel();
}

function getCoreBaseUrl(): string {
  return DOC_INTEL_API_BASE_URL.replace(/\/+$/, "");
}

async function fetchJsonWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: options.headers,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }

    return {
      status: response.status,
      data: parsed,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function checkCoreConnectivity(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  if (!coreIntegrationEnabled()) {
    return {
      ok: true,
      status: "healthy",
      enabled: false,
      details: {
        reason: "Core integration is not configured",
      },
    };
  }

  const baseUrl = getCoreBaseUrl();
  const { status } = await fetchJsonWithTimeout(`${baseUrl}/health`, {});

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      status: "healthy",
      enabled: true,
      details: {
        endpoint: "/health",
      },
    };
  }

  return {
    ok: false,
    status: "down",
    enabled: true,
    error: `Core health check returned status ${status}`,
  };
}

async function checkCoreAuth(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  if (!coreIntegrationEnabled()) {
    return {
      ok: true,
      status: "healthy",
      enabled: false,
      details: {
        reason: "Core integration is not configured",
      },
    };
  }

  const baseUrl = getCoreBaseUrl();
  const { status } = await fetchJsonWithTimeout(`${baseUrl}/capabilities`, {
    headers: {
      Authorization: `Bearer ${DOC_INTEL_API_TOKEN}`,
    },
  });

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      status: "healthy",
      enabled: true,
      details: {
        endpoint: "/capabilities",
      },
    };
  }

  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: "down",
      enabled: true,
      error: "Core authentication failed",
    };
  }

  return {
    ok: false,
    status: "down",
    enabled: true,
    error: `Core auth check returned status ${status}`,
  };
}

async function checkProviders(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  if (!coreIntegrationEnabled()) {
    return {
      ok: true,
      status: "healthy",
      enabled: false,
      details: {
        llama: "not_enabled",
        docIntel: "not_enabled",
      },
    };
  }

  const baseUrl = getCoreBaseUrl();

  const providersResponse = await fetchJsonWithTimeout(`${baseUrl}/capabilities`, {
    headers: {
      Authorization: `Bearer ${DOC_INTEL_API_TOKEN}`,
    },
  });

  if (providersResponse.status < 200 || providersResponse.status >= 300) {
    return {
      ok: false,
      status: "degraded",
      enabled: true,
      error: `Provider capability check returned status ${providersResponse.status}`,
    };
  }

  const data = providersResponse.data as {
    providers?: Array<{ provider?: string; capabilities?: string[] }>;
  };
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const providerNames = new Set(
    providers
      .map((provider) => provider.provider)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const llamaOk = providerNames.has("llama-cloud");

  return {
    ok: llamaOk,
    status: llamaOk ? "healthy" : "degraded",
    enabled: true,
    details: {
      llama: llamaOk ? "ok" : "missing",
      docIntel: "ok",
      providers: [...providerNames],
    },
    ...(llamaOk ? {} : { error: "Llama provider is not advertised by Core capabilities" }),
  };
}

async function checkConfig(): Promise<Omit<HealthCheckResult, "latencyMs">> {
  const missingCritical: string[] = [];
  const missingOptional: string[] = [];

  if (!process.env.DATABASE_URL) {
    missingCritical.push("DATABASE_URL");
  }

  if (STORAGE_BACKEND === "r2") {
    if (!R2_ACCOUNT_ID) missingCritical.push("R2_ACCOUNT_ID");
    if (!R2_ACCESS_KEY_ID) missingCritical.push("R2_ACCESS_KEY_ID");
    if (!R2_SECRET_ACCESS_KEY) missingCritical.push("R2_SECRET_ACCESS_KEY");
    if (!R2_BUCKET_NAME) missingCritical.push("R2_BUCKET_NAME");
  }

  if (ENABLE_DOC_INTEL_CLASSIFY || DOC_INTEL_API_BASE_URL || DOC_INTEL_API_TOKEN) {
    if (!DOC_INTEL_API_BASE_URL) missingOptional.push("DOC_INTEL_API_BASE_URL");
    if (!DOC_INTEL_API_TOKEN) missingOptional.push("DOC_INTEL_API_TOKEN");
  }

  const isHealthy = missingCritical.length === 0 && missingOptional.length === 0;
  const isDown = missingCritical.length > 0;

  return {
    ok: isHealthy,
    status: isDown ? "down" : (isHealthy ? "healthy" : "degraded"),
    missing: [...missingCritical, ...missingOptional],
    details: {
      missingCritical,
      missingOptional,
      storageBackend: STORAGE_BACKEND,
      docIntelClassifyEnabled: ENABLE_DOC_INTEL_CLASSIFY,
    },
    ...(isHealthy ? {} : { error: "Required configuration is missing for one or more active features" }),
  };
}

function computeOverallStatus(checks: SystemHealthResponse["checks"]): {
  ok: boolean;
  status: HealthStatus;
} {
  const criticalChecks: Array<keyof SystemHealthResponse["checks"]> = [
    "api",
    "database",
    "storage",
    "worker",
  ];

  const optionalChecks: Array<keyof SystemHealthResponse["checks"]> = [
    "core",
    "coreAuth",
    "providers",
    "config",
  ];

  const hasCriticalDown = criticalChecks.some((key) => checks[key].status === "down");
  if (hasCriticalDown) {
    return { ok: false, status: "down" };
  }

  const hasOptionalIssue = optionalChecks.some((key) => checks[key].status !== "healthy");
  if (hasOptionalIssue) {
    return { ok: false, status: "degraded" };
  }

  return { ok: true, status: "healthy" };
}

export async function runSystemHealthChecks(): Promise<SystemHealthResponse> {
  const checks: SystemHealthResponse["checks"] = {
    api: await runCheck("api", checkRuntime),
    database: await runCheck("database", checkDatabase),
    storage: await runCheck("storage", checkStorage),
    worker: await runCheck("worker", checkWorker),
    core: await runCheck("core", checkCoreConnectivity),
    coreAuth: await runCheck("coreAuth", checkCoreAuth),
    providers: await runCheck("providers", checkProviders),
    config: await runCheck("config", checkConfig),
  };

  const overall = computeOverallStatus(checks);

  return {
    ok: overall.ok,
    status: overall.status,
    timestamp: new Date().toISOString(),
    service: PLATFORM_SYSTEM_NAME,
    environment: NODE_ENV,
    version: process.env.APP_VERSION || process.env.npm_package_version || undefined,
    build: process.env.BUILD_SHA || undefined,
    checks,
  };
}
