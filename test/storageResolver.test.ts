/**
 * Tests for the tenant-aware storage resolver.
 *
 * Covers:
 * 1. Tenant config present and active (r2_manual) → adapter with tenant credentials
 * 2. Tenant config present and active (r2_env)    → adapter with env credentials
 * 3. Tenant config missing → env R2 fallback (when STORAGE_BACKEND=r2)
 * 4. Tenant config missing, no env R2 → local disk fallback
 * 5. Tenant config active but incomplete (r2_manual) → throws StorageConfigError
 * 6. Tenant config active (r2_env) but env creds missing → throws StorageConfigError
 * 7. Delete uses the same resolved backend as upload (adapter identity)
 * 8. Disabled tenant config falls through to env R2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantScope } from "../src/tenant.js";

// ---------------------------------------------------------------------------
// Helpers: each test reimports the resolver after setting env vars so cached
// module-level constants pick up the new values.
// ---------------------------------------------------------------------------
const scope: TenantScope = {
  organizationId: "org-test",
  programDomain: "community-chronicle",
};

/** Set env vars for R2 and reimport the resolver + adapters under fresh modules. */
async function importResolverWithEnv(envOverrides: Record<string, string | undefined>) {
  vi.resetModules();

  // Apply env overrides
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Re-mock after resetModules
  vi.doMock("../src/core/db/prisma.js", () => ({
    prisma: {
      programStorageSettings: {
        findUnique: vi.fn(),
      },
    },
  }));
  vi.doMock("../src/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

  const [{ resolveStorageAdapter, StorageConfigError }, { R2StorageAdapter }, { LocalStorageAdapter }, { prisma }] =
    await Promise.all([
      import("../src/core/storage/storageResolver.js"),
      import("../src/core/storage/r2Adapter.js"),
      import("../src/core/storage/localAdapter.js"),
      import("../src/core/db/prisma.js"),
    ]);

  return { resolveStorageAdapter, StorageConfigError, R2StorageAdapter, LocalStorageAdapter, prisma };
}

const R2_ENV = {
  STORAGE_BACKEND: "r2",
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET_NAME: "test-bucket",
};

const LOCAL_ENV = {
  STORAGE_BACKEND: "local",
  R2_ACCOUNT_ID: undefined,
  R2_ACCESS_KEY_ID: undefined,
  R2_SECRET_ACCESS_KEY: undefined,
  R2_BUCKET_NAME: undefined,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("resolveStorageAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Tenant r2_manual (all fields present) ─────────────────────────────
  it("returns R2StorageAdapter with tenant credentials when r2_manual config is enabled and complete", async () => {
    const { resolveStorageAdapter, R2StorageAdapter, prisma } = await importResolverWithEnv(LOCAL_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_manual",
          enabled: true,
          r2BucketName: "tenant-bucket",
          r2Endpoint: "https://abc123.r2.cloudflarestorage.com",
          r2AccessKey: "ak",
          r2SecretKey: "sk",
          r2PublicUrl: "",
          r2Prefix: "myprefix",
        },
      },
    });

    const result = await resolveStorageAdapter(scope);
    expect(result.source).toBe("tenant_r2_manual");
    expect(result.adapter).toBeInstanceOf(R2StorageAdapter);
    expect(result.adapter.backendId).toBe("r2_manual");
    expect(result.prefix).toBe("myprefix");
  });

  // ── 2. Tenant r2_env ──────────────────────────────────────────────────────
  it("returns R2StorageAdapter with env credentials when tenant is set to r2_env and env creds present", async () => {
    const { resolveStorageAdapter, R2StorageAdapter, prisma } = await importResolverWithEnv(R2_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_env",
          enabled: true,
          r2BucketName: "",
          r2Endpoint: "",
          r2AccessKey: "",
          r2SecretKey: "",
          r2PublicUrl: "",
          r2Prefix: "tenant-prefix",
        },
      },
    });

    const result = await resolveStorageAdapter(scope);
    expect(result.source).toBe("tenant_r2_env");
    expect(result.adapter).toBeInstanceOf(R2StorageAdapter);
    expect(result.adapter.backendId).toBe("r2_env");
    expect(result.prefix).toBe("tenant-prefix");
  });

  // ── 3. No tenant config, env R2 available ─────────────────────────────────
  it("falls back to env R2 when no tenant config exists and STORAGE_BACKEND=r2", async () => {
    const { resolveStorageAdapter, R2StorageAdapter, prisma } = await importResolverWithEnv(R2_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveStorageAdapter(scope);
    expect(result.source).toBe("env_r2");
    expect(result.adapter).toBeInstanceOf(R2StorageAdapter);
    expect(result.adapter.backendId).toBe("r2_env");
  });

  // ── 4. No tenant config, no env R2 → local fallback ──────────────────────
  it("falls back to local disk when no tenant config and STORAGE_BACKEND=local", async () => {
    const { resolveStorageAdapter, LocalStorageAdapter, prisma } = await importResolverWithEnv(LOCAL_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveStorageAdapter(scope);
    expect(result.source).toBe("local_fallback");
    expect(result.adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(result.adapter.backendId).toBe("local");
  });

  // ── 5. Tenant r2_manual active but incomplete → StorageConfigError ────────
  it("throws StorageConfigError when r2_manual is enabled but missing required fields", async () => {
    const { resolveStorageAdapter, StorageConfigError, prisma } = await importResolverWithEnv(LOCAL_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_manual",
          enabled: true,
          r2BucketName: "some-bucket",
          r2Endpoint: "",
          r2AccessKey: "",
          r2SecretKey: "",
          r2PublicUrl: "",
          r2Prefix: "",
        },
      },
    });

    await expect(resolveStorageAdapter(scope)).rejects.toThrowError(StorageConfigError);
    await expect(resolveStorageAdapter(scope)).rejects.toThrow(/missing required fields/i);
  });

  // ── 6. Tenant r2_env but env creds missing → StorageConfigError ───────────
  it("throws StorageConfigError when tenant is r2_env but env R2 credentials are incomplete", async () => {
    const { resolveStorageAdapter, StorageConfigError, prisma } = await importResolverWithEnv(LOCAL_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_env",
          enabled: true,
          r2BucketName: "",
          r2Endpoint: "",
          r2AccessKey: "",
          r2SecretKey: "",
          r2PublicUrl: "",
          r2Prefix: "",
        },
      },
    });

    await expect(resolveStorageAdapter(scope)).rejects.toThrowError(StorageConfigError);
    await expect(resolveStorageAdapter(scope)).rejects.toThrow(/environment-managed R2/i);
  });

  // ── 7. Delete uses same backend as upload ─────────────────────────────────
  it("returns the same adapter type on successive calls (upload and delete use same backend)", async () => {
    const { resolveStorageAdapter, R2StorageAdapter, prisma } = await importResolverWithEnv(R2_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_manual",
          enabled: true,
          r2BucketName: "tenant-bucket",
          r2Endpoint: "https://xyz.r2.cloudflarestorage.com",
          r2AccessKey: "ak",
          r2SecretKey: "sk",
          r2PublicUrl: "",
          r2Prefix: "",
        },
      },
    });

    const [upload, del] = await Promise.all([
      resolveStorageAdapter(scope),
      resolveStorageAdapter(scope),
    ]);

    expect(upload.source).toBe(del.source);
    expect(upload.adapter.backendId).toBe(del.adapter.backendId);
    expect(upload.adapter).toBeInstanceOf(R2StorageAdapter);
    expect(del.adapter).toBeInstanceOf(R2StorageAdapter);
  });

  // ── 8. Disabled tenant config falls through to env R2 ────────────────────
  it("falls through to env R2 when tenant config exists but is disabled", async () => {
    const { resolveStorageAdapter, R2StorageAdapter, prisma } = await importResolverWithEnv(R2_ENV);
    (prisma.programStorageSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: {
        finalArchive: {
          provider: "r2_manual",
          enabled: false, // disabled
          r2BucketName: "tenant-bucket",
          r2Endpoint: "https://xyz.r2.cloudflarestorage.com",
          r2AccessKey: "ak",
          r2SecretKey: "sk",
          r2PublicUrl: "",
          r2Prefix: "",
        },
      },
    });

    const result = await resolveStorageAdapter(scope);
    expect(result.source).toBe("env_r2");
    expect(result.adapter).toBeInstanceOf(R2StorageAdapter);
  });
});
